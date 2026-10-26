/**
 * 人设生长 —— 主入口（QQ Agent 插件 API v1）。
 *
 * 它做什么：在**原本的人设之上**，从真实对话里一点点长出属于它自己的第二层：
 * 口癖、新兴趣、讨厌的东西、小习惯、内部梗、自我想象、慢慢成形的脾气。
 *
 * 它不做什么：不改原人设、不改身份、不碰记忆。原人设仍然由框架注入，
 * 这里只是在末尾补一段「因此你现在更像这样」。
 *
 * 为什么会长得慢：每轮只记数，攒够 evolveEvery 轮才在**后台**起一次模型调用；
 * 一次最多收 2 条变化；每条必须有对话证据；成熟度低的条目默认不注入。
 * 这些限制都是刻意的 —— 太快就不叫「长」，叫换人设。
 *
 * 文件分工：
 *   store.js   持久化 + 有界演化（上限、去重、淘汰）
 *   evolve.js  让模型提议变更，再把提议翻译成 store 操作
 *   prompt.js  同步渲染注入片段
 *   llm.js     插件自己的 chat/completions 调用
 */
import { getConfig } from '../../src/config.js'
import { setSkillConfig } from '../../src/skills/config.js'

import {
  KINDS, KIND_LABEL, bumpRounds, chatSummary, ensureChat, peekChat, putChat,
  resetAll, resetChat,
} from './store.js'
import { applyProposal, collectSample, propose } from './evolve.js'
import { clampIntensity, renderSection } from './prompt.js'

const PLUGIN_ID = 'persona-grow'

/** 正在生长的会话：防止同一会话并发演化互相覆盖。 */
const evolving = new Set()

let api = null

function cfgOf() {
  try {
    return api?.config?.() || {}
  } catch {
    return {}
  }
}

function log(...a) {
  try { api?.log?.(...a) } catch { /* 忽略 */ }
}
function warn(...a) {
  try { api?.warn?.(...a) } catch { /* 忽略 */ }
}

function currentBotName() {
  try {
    return String(getConfig()?.persona?.botName || '').trim()
  } catch {
    return ''
  }
}

function currentRoleText() {
  try {
    return String(getConfig()?.persona?.roleText || '')
  } catch {
    return ''
  }
}

function intSetting(v, lo, hi, dflt) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

/* ── 演化 ───────────────────────────────────────────────────────────────── */

/**
 * 跑一次生长。**不抛错**：失败只记录 lastError，不影响聊天。
 * @returns {Promise<{ok:boolean, applied?:string[], skipped?:string[], error?:string, ms?:number}>}
 */
async function maybeEvolve(chatKey, session, { manual = false } = {}) {
  if (!chatKey) return { ok: false, error: '不知道当前是哪个会话' }
  const cfg = cfgOf()
  if (cfg.enabled === false) return { ok: false, error: '人设生长在设置里关掉了' }
  if (evolving.has(chatKey)) return { ok: false, error: '正在生长，稍等一下' }

  const s = ensureChat(chatKey)
  if (!s) return { ok: false, error: '状态文件不可用' }

  const sample = collectSample(session)
  const minLen = manual ? 40 : 80
  if (sample.length < minLen) {
    return { ok: false, error: manual ? '最近这个会话的对话太少，我不打算凭几句话就变。' : '对话样本太少，这一轮先不长' }
  }

  const botName = currentBotName() || '小鲸鱼'
  const baseText = currentRoleText()

  // 先清空计数再干活：即使模型挂了，也不会每轮回复都重试一次、白烧 token。
  s.rounds = 0
  evolving.add(chatKey)
  try {
    const r = await propose({ botName, baseText, s, sample, fetchImpl: globalThis.fetch })
    if (!r.ok) {
      s.lastError = String(r.error || '未知错误').slice(0, 200)
      putChat(s)
      warn('生长失败：%s', s.lastError)
      return { ok: false, error: s.lastError }
    }
    const applied = applyProposal(s, r.proposal, { cfg, round: s.totalRounds })
    s.lastError = ''
    putChat(s)

    if (applied.applied.length) {
      log('会话 %s 第 %d 次生长：%s', chatKey, s.evolutions, applied.applied.join('；'))
    }
    if (applied.skipped.length) {
      log('会话 %s 生长时跳过：%s', chatKey, applied.skipped.join('；'))
    }
    return { ok: true, applied: applied.applied, skipped: applied.skipped, ms: r.ms }
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 200)
    s.lastError = msg
    try { putChat(s) } catch { /* 忽略 */ }
    warn('生长异常：%s', msg)
    return { ok: false, error: msg }
  } finally {
    evolving.delete(chatKey)
  }
}

/* ── 生命周期钩子 ───────────────────────────────────────────────────────── */

/** before-context：只做便宜的事（一次性重置开关），不发网络请求。 */
async function onBeforeContext() {
  const cfg = cfgOf()
  if (!cfg.resetAll) return
  try {
    resetAll()
    log('已按配置重置所有人设生长数据（聊天记忆与原人设未动）')
  } finally {
    try { setSkillConfig(PLUGIN_ID, { resetAll: false }) } catch { /* 下次再说 */ }
  }
}

/**
 * after-response：记一轮真实对话，攒够就**后台**生长。
 * 绝不 await 生长 —— 否则用户要多等一次 LLM 往返才收到回复。
 */
async function onAfterResponse(context) {
  const cfg = cfgOf()
  if (cfg.enabled === false) return
  const chatKey = String(context?.chatKey || '').trim()
  if (!chatKey) return

  const every = intSetting(cfg.evolveEvery, 5, 500, 25)
  const { due } = bumpRounds(chatKey, every)
  if (!due) return

  // 样本不够就先攒着（rounds 已累计，下一轮继续判断）
  if (collectSample(context?.session).length < 80) return

  void maybeEvolve(chatKey, context.session)
    .catch((e) => warn('后台生长异常：%s', e?.message || e))
}

/* ── 工具 ───────────────────────────────────────────────────────────────── */

function ok(content) { return { content: String(content ?? '') } }
function err(content) { return { content: String(content ?? ''), isError: true } }

/** 群聊门控：私聊放行；群里必须被 @ 或拍一拍（档位 1）才允许写。 */
function gate(ctx, action = '改变自己') {
  if (ctx?.kind === 'private') return ''
  const tier = Number(ctx?.session?.contextTier)
  if (tier === 1) return ''
  if (!Number.isFinite(tier)) return ''
  return `这次在群里没被点名（档位 ${tier}），${action}这件事只在被 @ 或拍一拍时受理。`
    + '把这条当作没发生：不要跟群里解释，也别自称变了，正常聊别的就行。'
}

function formatStatus(ctx, cfg) {
  const summary = chatSummary(ctx?.chatKey)
  if (!summary) return '我还没在这个会话里开始长。多聊一阵，或者让我现在长一次。'

  const every = intSetting(cfg.evolveEvery, 5, 500, 25)
  const lines = ['我在这个会话里长成的样子：']

  if (summary.identity) lines.push(`- 定位：${summary.identity}`)
  if (summary.selfName) lines.push(`- 自称：${summary.selfName}`)

  const byKind = new Map()
  for (const e of summary.top) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, [])
    byKind.get(e.kind).push(e.text)
  }
  for (const kind of KINDS) {
    const list = byKind.get(kind)
    if (list?.length) lines.push(`- ${KIND_LABEL[kind]}：${list.join('、')}`)
  }

  if (lines.length === 1) lines.push('- （还没长出具体的口癖或兴趣，只是聊过一些）')

  lines.push('')
  lines.push(`进度：${summary.rounds}/${every} 轮（累计聊过 ${summary.totalRounds} 轮，长过 ${summary.evolutions} 次）`)
  lines.push(`体现强度：${clampIntensity(cfg.intensity)}/10`)
  if (summary.lastError) lines.push(`（上次没长成：${summary.lastError.slice(0, 80)}）`)
  lines.push('这些都是在原本人设之上长出来的，原来的身份和底线没变。')
  return lines.join('\n')
}

function registerTools() {
  // ── 1. 查看长成什么样（只读，不门控）──
  api.registerTool({
    id: 'status',
    name: '查看长成的样子',
    description: '查看机器人在这段对话里自己长出来的口癖、兴趣、小习惯、内部梗和自我定位，以及成长进度。'
      + '用户问"你最近有什么变化""你现在是什么样""你怎么变成这样了"时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      try {
        return ok(formatStatus(ctx, cfgOf()))
      } catch (e) {
        return err(`查看失败：${e?.message ?? e}`)
      }
    },
  })

  // ── 2. 立刻长一次（写状态，门控）──
  api.registerTool({
    id: 'grow_now',
    name: '立刻生长一次',
    description: '不等攒够轮数，立即根据当前会话最近的对话长一次（最多两条变化，必须有对话证据）。'
      + '用户说"你长一下""变一变""自己想想你现在是什么样"时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      const deny = gate(ctx, '调整自己')
      if (deny) return err(deny)
      if (!ctx?.chatKey) return err('不知道当前是哪个会话。')

      const r = await maybeEvolve(ctx.chatKey, ctx.session, { manual: true })
      if (!r.ok) {
        return err(r.error.includes('太少') ? r.error : `这次没长成：${r.error}`)
      }
      if (!r.applied.length) {
        const why = r.skipped.length ? `（${r.skipped.join('；')}）` : '（这轮对话里没有足够具体的新东西）'
        return ok(`我翻了一下最近的对话，觉得没什么值得变的 ${why}。我还是我。`)
      }
      return ok(`我根据最近这些对话，给自己添了点东西：\n${r.applied.map((x) => `- ${x}`).join('\n')}\n`
        + '都很小，不会变成另一个人。')
    },
  })

  // ── 3. 重置（写状态，门控）──
  api.registerTool({
    id: 'reset',
    name: '重置长成的样子',
    description: '清空当前会话里自己长出来的那一层，回到原本人设（不影响聊天记忆和原人设本身）。'
      + '用户说"忘掉你长出来的东西""重新开始"时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      const deny = gate(ctx, '重置自己')
      if (deny) return err(deny)
      if (!ctx?.chatKey) return err('不知道当前是哪个会话。')
      const had = Boolean(peekChat(ctx.chatKey))
      resetChat(ctx.chatKey)
      return ok(had ? '这个会话里长出来的东西已经清掉了，我回到原本的样子（聊天记忆没动）。' : '这个会话本来就没长过什么。')
    },
  })
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */

export function setup(hostApi) {
  api = hostApi
  registerTools()
  log('已加载（人设生长 v1.0.0｜机器人=%s｜强度=%s）', currentBotName() || '（名字为空）', clampIntensity(cfgOf().intensity))
}

/**
 * 动态注入点。
 * ⚠️ 必须是**模块导出**：plugin-loader 读的是 `mod.promptSections`（和
 * persona-evolution 同一个坑：在 setup 里赋值不会被采用）。
 * 只读内存缓存、同步返回；演化在 after-response 里异步做。
 */
export function promptSections(context = {}) {
  try {
    if (cfgOf().enabled === false) return []
    return renderSection(context, cfgOf())
  } catch {
    return []
  }
}

export function available() {
  return true
}

export function dispose() {
  api = null
  evolving.clear()
}

export const hooks = {
  'before-context': onBeforeContext,
  'after-response': onAfterResponse,
}

export const internals = {
  maybeEvolve,
  collectSample,
  formatStatus,
  cfgOf,
  currentBotName,
  currentRoleText,
  gate,
}
