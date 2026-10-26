/**
 * 人设生长 —— 演化（LLM 提议 + 有界应用）。
 *
 * 分工刻意拆开：
 *   evolve.js 只负责「让模型提建议」和「把建议翻译成 store 的操作」；
 *   能长多少、长成什么样，最终由 store.js 的上限与去重夹住。
 *   模型可以乱说，代码不跟着乱。
 *
 * 一次最多 2 条改动的理由：变化太快就不像「慢慢长」，而像换人设。
 * 事实证据（evidence）是硬门槛 —— 没有对话依据的提议直接丢弃。
 */
import { chat, extractJson } from './llm.js'
import {
  KINDS, KIND_LABEL, addElement, fadeElement, normText, pruneElements,
  setIdentity, setSelfName, strengthenElement, pushLog,
} from './store.js'

/** 从会话里取最近的对话样本；role 用「群友/我/系统」，跟核心提示词的称呼一致。 */
export function collectSample(session, limit = 18) {
  try {
    const msgs = session?.messages
    if (!Array.isArray(msgs) || !msgs.length) return ''
    return msgs.slice(-limit)
      .map((m) => {
        const role = m?.role === 'user' ? '群友' : m?.role === 'assistant' ? '我' : '系统'
        const text = String(m?.content ?? '').replace(/\s+/g, ' ').trim()
        return text ? `${role}：${text.slice(0, 160)}` : ''
      })
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

function kindLabels() {
  return KINDS.map((k) => `${k}（${KIND_LABEL[k]}）`).join('、')
}

function systemPrompt(botName) {
  return `你是 QQ 群聊机器人「${botName}」的「自我生长记录员」。

它原本的人设是固定的（就在系统提示里），你不改它。你的任务只有一件：翻最近的聊天，替它记下**它自己慢慢长出来的那一层**——口癖、新长出来的兴趣、不喜欢的东西、小习惯、这个圈子的内部梗、它对自己的想象、以及慢慢成形的脾气。

规则：
1. 只记真实发生过的东西。每条 change 的 evidence 必须是最近对话里的具体依据（一句原话或一个事件，20 字内转述）。找不到证据就一条都别提。
2. changes 最多 2 条。宁可不改，也不要凑数。identity、selfName 各最多出现一次，而且不是每次都要写。
3. 要具体、能带进聊天：「爱用『确实』开头」而不是「很友善」；「最近迷上机械键盘」而不是「对科技感兴趣」；「讨厌被叫小助手」而不是「有边界感」。
4. 只能长表层：语气、兴趣、梗、习惯、自我想象。**不许**改身份（名字/性别/物种/年龄/关系设定），**不许**长出歧视、低俗、政治站队、恋爱纠缠，**不许**记录真实姓名、账号、地址等隐私。
5. 已有条目这轮又被强化 → op=strengthen，不要用 add 重复；确实过时、不再像它了 → op=fade。
6. selfImage 最多一条，只在这轮真的形成了新的自我认识时才动。
7. 不要评价具体群友。

可用的 kind：${kindLabels()}

只输出 JSON，不要解释、不要 markdown：
{"identity":"30字内，它现在给自己的定位（可省略）","selfName":"1-6字，它想怎么称呼自己（可省略）","changes":[{"op":"add|strengthen|fade","kind":"catchphrase|interest|dislike|habit|joke|selfImage|opinion","text":"24字内，尽量第一人称，可省略主语","evidence":"对话里的依据","why":"为什么这算它长出来的"}]}`
}

function userPayload({ botName, baseText, s, sample }) {
  return JSON.stringify({
    机器人: botName,
    原始人设摘录: String(baseText || '').slice(0, 900),
    这一层现在的样子: {
      identity: s.identity || '',
      selfName: s.selfName || '',
      elements: (s.elements || []).map((e) => ({ kind: e.kind, text: e.text, maturity: e.maturity })),
    },
    已经长过几次: s.evolutions,
    最近对话: sample || '（最近没有可用的对话样本）',
  }, null, 1)
}

/**
 * 跑一次「提议」。
 * @returns {Promise<{ok:boolean, proposal?:object, error?:string, ms?:number, raw?:string}>}
 */
export async function propose({ botName, baseText, s, sample, fetchImpl }) {
  const r = await chat([
    { role: 'system', content: systemPrompt(botName) },
    { role: 'user', content: userPayload({ botName, baseText, s, sample }) },
  ], {
    temperature: 0.6,
    maxTokens: 900,
    fetchImpl,
    timeoutMs: 25000,
  })
  if (!r.ok) return { ok: false, error: r.error, ms: r.ms }
  const json = extractJson(r.text)
  if (!json) return { ok: false, error: `模型输出不是 JSON：${r.text.slice(0, 160)}`, ms: r.ms, raw: r.text }
  return { ok: true, proposal: json, ms: r.ms, raw: r.text }
}

/**
 * 把提议应用到会话状态上（调用方负责 putChat 落盘）。
 * 模型说得再多，这里最多只收 2 条 change，且每条都必须有 evidence。
 */
export function applyProposal(s, proposal, { cfg = {}, round = 0 } = {}) {
  const out = { applied: [], skipped: [], identity: false, selfName: false }

  if (typeof proposal?.identity === 'string' && proposal.identity.trim()) {
    if (setIdentity(s, proposal.identity, { why: '模型根据最近对话给出的自我定位' })) {
      out.identity = true
      out.applied.push(`定位：${s.identity}`)
    }
  }

  if (cfg.allowSelfRename !== false && typeof proposal?.selfName === 'string' && proposal.selfName.trim()) {
    if (setSelfName(s, proposal.selfName, { why: '模型根据最近对话提议的自称' })) {
      out.selfName = true
      out.applied.push(`自称：${s.selfName}`)
    }
  }

  const changes = Array.isArray(proposal?.changes) ? proposal.changes.slice(0, 2) : []
  for (const c of changes) {
    const op = String(c?.op || 'add').toLowerCase()
    const kind = String(c?.kind || '')
    const text = normText(c?.text)
    const evidence = String(c?.evidence ?? '').trim()
    const why = String(c?.why ?? '').trim()

    if (!KINDS.includes(kind)) { out.skipped.push(`未知类型 ${kind}`); continue }
    if (text.length < 2) { out.skipped.push('内容太短'); continue }
    if (!evidence) { out.skipped.push(`「${text}」缺证据`); continue }

    if (op === 'add') {
      const r = addElement(s, { kind, text, evidence, why, round })
      if (r.action === 'add') out.applied.push(`新增${KIND_LABEL[kind]}：${text}`)
      else if (r.action === 'strengthen') out.applied.push(`强化${KIND_LABEL[kind]}：${text}`)
      else out.skipped.push(`「${text}」${r.reason || '未采用'}`)
    } else if (op === 'strengthen') {
      const hit = strengthenElement(s, kind, text, { evidence, why, round })
      if (hit) out.applied.push(`强化${KIND_LABEL[kind]}：${hit.text}`)
      else out.skipped.push(`「${text}」还没有，无法强化`)
    } else if (op === 'fade') {
      if (fadeElement(s, kind, text, { why })) out.applied.push(`淡化${KIND_LABEL[kind]}：${text}`)
      else out.skipped.push(`「${text}」没找到，无法淡化`)
    } else {
      out.skipped.push(`未知操作 ${op}`)
    }
  }

  if (out.applied.length) {
    pruneElements(s, cfg.maxItems)
    s.evolutions += 1
    s.lastEvolvedAt = new Date().toISOString()
    pushLog(s, {
      kind: '*',
      action: 'evolve',
      text: `第 ${s.evolutions} 次生长：${out.applied.length} 处变化`,
      why: out.skipped.length ? `跳过：${out.skipped.join('；')}` : '',
    })
  }
  return out
}

export const internals = { systemPrompt, userPayload }
