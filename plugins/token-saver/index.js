// Token 节流 —— 确定性型插件（放 plugins/，显示在控制台「插件」页签）
//
// ── 这个插件做什么 ────────────────────────────────────────────────────────
// 在不改变机器人对话逻辑的前提下，从每一次发给模型的请求里做减法：
//
//   ① 历史消息滑窗裁剪（hook: before-llm-messages）
//   ② 工具描述瘦身（capability: llm.request-params）
//   ③ 工具结果超长截断（hook: after-tool）
//
// 全程只有"删/缩写"，不新增任何内容、不改任何语义。任何一步出错都直接���行，
// 省 token 永远不能以"机器人发不出话"为代价。
//
// ── 依据（源码核对，非猜测）──────────────────────────────────────────────
//   · orchestrator.js:876  runHook('before-llm-messages', { ...ctx, messages })
//       注释原文：「hook 拿到的是同一个数组引用，允许原地修改，返回值忽略。」
//       且它在 session.inputMessages = structuredClone(messages) 之前执行，
//       所以这里对 messages 的原地修改会真实进入发给模型的请求。
//   · orchestrator.js:905  const openAiTools = toOpenAiTools(toolDefs)
//       tools.js:1217  toOpenAiTools = 把 description / parameters 原样搬进请求。
//       → 工具描述每一轮都要重发，是持续的固定开销。
//   · orchestrator.js:1174  tool 消息 content 取自 result.content，未做长度限制。
//   · manager.js  MULTI_PROVIDER_CAPABILITIES 内含 'llm.request-params'，
//       经 getRequestTransforms() 串行调用，后者能看到前者的输出。
//   · manager.js:414 runHook 对每个 hook 有 5000ms 超时，超时只记日志不影响对话。
//
// ── 安全底线（三条，硬保证）──────────────────────────────────────────────
//   1. 只减不加：不构造任何新的对话内容（摘要是对被删内容的截取，非生成）。
//   2. 异常全吞：每个 hook 内部各自 try/catch，出错就当没这个插件。
//   3. 不碰关键结构：system 消息永不删；tool_calls / tool 结果配对被保护，
//      绝不留下"有 tool_calls 却没有对应 tool 结果"的非法序列（会被端点 400）。

import { getSkillConfig } from '../../src/skills/config.js';

let log = () => {};
let warn = () => {};

const DEFAULTS = {
  enabled: true,
  historyMode: 'window',
  keepRecentMessages: 14,
  maxDigestChars: 600,
  trimToolDescriptions: true,
  maxToolResultChars: 4000,
  verbose: false
};

/** 读配置：任何异常都退回默认值（插件绝不因为配置读不出来而影响对话）。 */
function cfg() {
  try {
    return { ...DEFAULTS, ...(getSkillConfig('token-saver', DEFAULTS) || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};

// ── 统计（供日志观察省了多少）─────────────────────────────────────────────
const stats = { trimmedMessages: 0, trimmedChars: 0, trimmedToolDesc: 0, trimmedToolResult: 0 };

function noteSaved(saved, kind) {
  if (saved > 0) {
    stats.trimmedChars += saved;
    if (kind === 'msg') stats.trimmedMessages += 1;
    else if (kind === 'desc') stats.trimmedToolDesc += 1;
    else if (kind === 'result') stats.trimmedToolResult += 1;
  }
}

/**
 * 取一条消息的可读文本（用于压缩成摘要）。只读取，不修改。
 * content 可能是 string，也可能是 parts 数组（多模态），这里只拼 text 部分。
 */
function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text).join('\n');
  }
  return '';
}

/**
 * 判断一条消息是否"可安全删除"。
 *
 * ⚠️ 这是整个插件最关键的守卫。OpenAI 兼容端点对消息序列有硬性要求：
 *    assistant 消息里一旦有 tool_calls，其后**必须**紧跟对应的 tool 消息。
 *    删掉一半会导致整个请求被 400 拒绝 —— 那就不是省 token 而是把机器人弄哑了。
 *
 * 策略：保守到"宁可少省"——
 *   · system 角色永不删（人设 + 安全规则）
 *   · 最后一条消息永不删（通常是当前触发消息，就是要回应的那条）
 *   · 带 tool_calls 的 assistant 消息不删
 *   · tool 角色的消息不删（避免破坏配对）
 * 这样最大程度保住序列合法性，代价是省得少一点 —— 这个取舍是刻意的。
 */
function isDeletable(msg, index, total) {
  if (!msg || typeof msg !== 'object') return false;
  if (index >= total - 1) return false;              // 末条保护
  const role = msg.role;
  if (role === 'system') return false;               // 系统提示词保护
  if (role === 'tool') return false;                 // 工具结果保护（配对安全）
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return false;
  if (role === 'user' || role === 'assistant') return true;
  return false;
}

/**
 * 压缩历史：保留最近 keep 条，更早的**可删**消息压成一行摘要。
 *
 * 摘要用两种形式之一，都是对被删内容本身的截取（不生成新语义）：
 *   window     每条取前若干字，拼成"角色: 内容"的列表
 *   aggressive 只保留条数与总字数，更省
 *
 * 注意：摘要以 user 角色插入，且**不带任何工具结构** —— 插入一条纯文本
 * user 消息不会破坏后面的 tool_calls 配对关系。
 */
function trimHistory(messages, conf) {
  const mode = String(conf.historyMode || 'window');
  if (mode === 'off') return;
  const keep = clampInt(conf.keepRecentMessages, 4, 60, DEFAULTS.keepRecentMessages);
  if (messages.length <= keep + 2) return;           // 本来就不长，别折腾

  const cutIndex = messages.length - keep;
  const head = messages.slice(0, cutIndex);

  // 找出可删的与必须留下的
  const deletable = [];
  const mustKeep = [];
  head.forEach((m, i) => {
    if (isDeletable(m, i, messages.length)) deletable.push(i);
    else mustKeep.push(m);
  });
  if (!deletable.length) return;

  const beforeChars = head.reduce((n, m) => n + textOf(m).length, 0);

  // 组装摘要
  const budget = clampInt(conf.maxDigestChars, 100, 4000, DEFAULTS.maxDigestChars);
  let digest = '';
  if (mode === 'aggressive') {
    digest = `【较早对话已压缩】省略了 ${deletable.length} 条更早的消息。`;
  } else {
    const perLine = Math.max(20, Math.floor(budget / Math.max(1, deletable.length)));
    const lines = [];
    for (const i of deletable) {
      const m = head[i];
      const t = textOf(m).replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const who = m.role === 'assistant' ? '机器人' : '群友';
      const clipped = t.length > perLine ? `${t.slice(0, perLine)}…` : t;
      lines.push(`${who}: ${clipped}`);
    }
    digest = lines.length
      ? `【较早对话摘要】${lines.join(' / ')}`
      : `【较早对话已压缩】省略了 ${deletable.length} 条更早的消息。`;
  }
  if (digest.length > budget) digest = `${digest.slice(0, budget)}…`;

  // 重建：必须留下的旧消息 + 摘要 + 最近 keep 条
  const rebuilt = [...mustKeep];
  rebuilt.push({ role: 'user', content: digest });
  rebuilt.push(...messages.slice(cutIndex));

  const afterChars = rebuilt.reduce((n, m) => n + textOf(m).length, 0);
  const saved = beforeChars - afterChars;
  // ⚠️ 这里**不能**简单地 `if (saved <= 0) return`。
  // 摘要本身要占字符：预算小（maxDigestChars 小）或单条很短时，"压缩"反而更费，
  // 那就白白丢掉上下文却一点没省 —— 实测就踩到过这个坑（40 条历史 saved=0）。
  // 正确做法：省不下来就**退回到只删不留摘要**，至少仍能减少条数。
  if (saved > 0) {
    messages.length = 0;
    messages.push(...rebuilt);
    noteSaved(saved, 'msg');
    if (conf.verbose) {
      log(`历史裁剪：${head.length} 条 → 1 行摘要，省约 ${saved} 字符（保留最近 ${keep} 条）`);
    }
    return;
  }

  // 退化路径：不插摘要，直接只保留 mustKeep + 最近 keep 条
  const fallback = [...mustKeep, ...messages.slice(cutIndex)];
  const fbBefore = messages.reduce((n, m) => n + textOf(m).length, 0);
  const fbAfter = fallback.reduce((n, m) => n + textOf(m).length, 0);
  if (fbAfter < fbBefore) {
    messages.length = 0;
    messages.push(...fallback);
    noteSaved(fbBefore - fbAfter, 'msg');
    if (conf.verbose) {
      log(`历史裁剪（无摘要）：省略 ${deletable.length} 条更早消息，省约 ${fbBefore - fbAfter} 字符`);
    }
  }
  // 仍省不下来 → 什么都不做，保持原样
}

/**
 * 工具描述瘦身。
 *
 * 依据 tools.js:1217 —— description 与 parameters 会被原样搬进每一轮请求。
 * 这里做的是**保守**清理：只删描述文本里的空行与多余空白、去掉重复的
 * "调用/使用本工具"套话，不改写、不缩短语义，因此不会让模型理解错用途。
 *
 * ⚠️ 刻意**不删除**任何工具、也**不删** description。/parameters 一律保留原样。
 * 砍工具列表收益更大，但会让模型偶尔"想不起来"某个功能 —— 那超出"轻微变化"
 * 的底线，所以默认不做。想更激进请手动改本文件，不要指望配置项。
 */
function trimToolDescriptions(body) {
  const tools = body?.tools;
  if (!Array.isArray(tools) || !tools.length) return;
  for (const t of tools) {
    const fn = t?.function;
    if (!fn || typeof fn.description !== 'string') continue;
    const before = fn.description;
    let after = before
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')            // 行内多余空白
      .replace(/\n{2,}/g, '\n')           // 连续空行
      .replace(/^\s*[-*]\s*$/gm, '')      // 空的列表项
      .trim();
    // 只在这些清理真的减少了长度时才写回；绝不改动实际语义
    if (after && after.length < before.length) {
      fn.description = after;
      noteSaved(before.length - after.length, 'desc');
    }
  }
}

/**
 * 工具结果截断（hook: after-tool）。
 *
 * orchestrator.js:1173 把 result.content 直接塞进 tool 消息发给模型，
 * 长结果（搜索/网页正文）会在后续每一轮里被反复重发，是输入 token 的大头。
 *
 * 只截断**文本**结果；parts 数组（图片/视频）一律不动 —— 那类不走文本、
 * 且截断会破坏结构。截断处写明省略了多少字符，让模型知道信息不完整。
 */
function trimToolResult(result, conf) {
  if (!result || typeof result !== 'object') return;
  if (Array.isArray(result.content)) return;         // 多模态 parts：不碰
  if (typeof result.content !== 'string') return;
  const limit = clampInt(conf.maxToolResultChars, 500, 40000, DEFAULTS.maxToolResultChars);
  if (result.content.length <= limit) return;
  const omitted = result.content.length - limit;
  result.content = `${result.content.slice(0, limit)}\n…（结果过长，已省略 ${omitted} 字符）`;
  noteSaved(omitted, 'result');
  if (conf.verbose) log(`工具结果截断：省略 ${omitted} 字符（上限 ${limit}）`);
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(api) {
  log = api.log || (() => {});
  warn = api.warn || (() => {});

  const c0 = cfg();
  // ⚠️ 必须自己拼成**单个字符串**，不能写成 log('...%s...', v)。
  // 加载器给插件的 log 是 `(...args) => console.log(前缀, format(...args))`：
  // format 只把**第一个参数**当格式串，前缀已占掉第一位，后面的 %s/%d 永远不会被替换，
  // 日志会原样打印字面 "%s"（实测踩到过）。这里统一用模板串拼好再传。
  api.log(`Token 节流已加载（v1.0.0）：历史=${c0.historyMode}，保留最近 ${c0.keepRecentMessages} 条，`
    + `工具描述瘦身=${c0.trimToolDescriptions ? '开' : '关'}，工具结果上限=${c0.maxToolResultChars} 字符`);
}

/**
 * 请求参数转换器（llm.request-params）。
 * 在请求发出前对 body 做减法。必须返回 body（原样返回，宁可不动也不能弄丢）。
 */
export const providers = {
  'llm.request-params': (body) => {
    try {
      const conf = cfg();
      if (!conf.enabled || !conf.trimToolDescriptions) return body;
      trimToolDescriptions(body);
    } catch (error) {
      // 静默放行 —— 省 token 失败绝不能影响正常对话
      try { warn(`工具描述瘦身失败，本次跳过：${error?.message ?? error}`); } catch { /* ignore */ }
    }
    return body;
  }
};

export const hooks = {
  /** 待发消息裁剪。messages 是同一个数组引用，原地修改即生效。 */
  'before-llm-messages': ({ messages }) => {
    try {
      const conf = cfg();
      if (!conf.enabled) return;
      if (!Array.isArray(messages) || !messages.length) return;
      trimHistory(messages, conf);
    } catch (error) {
      try { warn(`历史裁剪失败，本次跳过：${error?.message ?? error}`); } catch { /* ignore */ }
    }
  },

  /** 工具结果截断。 */
  'after-tool': ({ result }) => {
    try {
      const conf = cfg();
      if (!conf.enabled) return;
      trimToolResult(result, conf);
    } catch (error) {
      try { warn(`工具结果截断失败，本次跳过：${error?.message ?? error}`); } catch { /* ignore */ }
    }
  }
};

/** 卸载时把统计打出来，方便判断到底省了多少。 */
export function dispose() {
  try {
    if (stats.trimmedChars > 0) {
      log(`累计节省约 ${stats.trimmedChars} 字符`
        + `（历史 ${stats.trimmedMessages} 条 / 工具描述 ${stats.trimmedToolDesc} 处 / 工具结果 ${stats.trimmedToolResult} 处）`);
    }
  } catch { /* ignore */ }
}
