/**
 * 人设生长 —— 持久化 + 有界演化。
 *
 * 设计要点：
 *   · **每会话独立**：chatKey 维度存，互不串味。
 *   · **有界**：每种元素有上限，总条数有上限，成熟度 1~5；淘汰最旧/最不常用的，
 *     所以这个文件不会无限长大，人设也不会越堆越臃肿。
 *   · **原子写**：临时文件 + rename，并留一份 .bak；写一半断电不会把成长弄丢。
 *   · promptSections 每轮都读 → 这里只读内存缓存，不碰磁盘（load 一次，写时更新）。
 *
 * 落点：<DATA_DIR>/persona-grow/state.json（DATA_DIR 由 src/config.js 决定，支持
 * QQ_AGENT_DATA_DIR 重定向）。放在 data/ 而不是 resources/app/ 下，是为了应用
 * 自动更新覆盖代码时，长出来的东西还在。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../../src/config.js'

const DIR = path.join(DATA_DIR, 'persona-grow')
const FILE = path.join(DIR, 'state.json')
const TMP = `${FILE}.tmp`
const BAK = `${FILE}.bak`

const VERSION = 1
const MAX_MATURITY = 5

/** 允许长的元素种类。故意不含：身份、年龄、性别、关系、政治立场。 */
export const KINDS = ['catchphrase', 'interest', 'dislike', 'habit', 'joke', 'selfImage', 'opinion']

export const KIND_LABEL = {
  catchphrase: '口癖',
  interest: '喜欢/在意',
  dislike: '不喜欢',
  habit: '小习惯',
  joke: '内部梗',
  selfImage: '自画像',
  opinion: '脾气和看法',
}

/** 每种元素的条数上限。 */
const MAX_PER_KIND = {
  catchphrase: 4,
  interest: 6,
  dislike: 3,
  habit: 5,
  joke: 5,
  selfImage: 3,
  opinion: 4,
}

let st = null

function empty() {
  return { version: VERSION, chats: {} }
}

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true })
}

export function load() {
  if (st) return st
  try {
    const raw = fs.readFileSync(FILE, 'utf8')
    const parsed = JSON.parse(raw)
    st = normalizeState(parsed)
  } catch {
    st = empty()
  }
  return st
}

export function reload() {
  st = null
  return load()
}

/** 原子写入 + .bak。失败只返回 false，不抛（写盘失败不该打断聊天）。 */
export function save() {
  const data = st || empty()
  try {
    ensureDir()
    pruneChats(data)
    fs.writeFileSync(TMP, JSON.stringify(data, null, 1), 'utf8')
    try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BAK) } catch { /* 备份失败不致命 */ }
    fs.renameSync(TMP, FILE)
    return true
  } catch {
    return false
  }
}

function normalizeState(v) {
  const out = empty()
  if (!v || typeof v !== 'object' || !v.chats || typeof v.chats !== 'object') return out
  for (const [chatKey, chat] of Object.entries(v.chats)) {
    if (!chat || typeof chat !== 'object') continue
    out.chats[chatKey] = normalizeChat(chatKey, chat)
  }
  return out
}

function normalizeChat(chatKey, chat) {
  const s = emptyChat(chatKey)
  s.totalRounds = Math.max(0, Number(chat.totalRounds) || 0)
  s.rounds = Math.max(0, Number(chat.rounds) || 0)
  s.evolutions = Math.max(0, Number(chat.evolutions) || 0)
  s.identity = typeof chat.identity === 'string' ? chat.identity.slice(0, 60) : ''
  s.selfName = typeof chat.selfName === 'string' ? chat.selfName.slice(0, 8) : ''
  s.selfNameEvo = Math.max(0, Number(chat.selfNameEvo) || 0)
  s.createdAt = chat.createdAt || new Date().toISOString()
  s.updatedAt = chat.updatedAt || s.createdAt
  s.lastEvolvedAt = chat.lastEvolvedAt || ''
  s.lastError = chat.lastError || ''
  s.elements = Array.isArray(chat.elements)
    ? chat.elements.map(normalizeElement).filter(Boolean).slice(0, 60)
    : []
  s.log = Array.isArray(chat.log) ? chat.log.slice(-30) : []
  return s
}

function emptyChat(chatKey) {
  const now = new Date().toISOString()
  return {
    chatKey: String(chatKey),
    createdAt: now,
    updatedAt: now,
    totalRounds: 0,
    rounds: 0,
    evolutions: 0,
    identity: '',
    selfName: '',
    selfNameEvo: 0,
    lastEvolvedAt: '',
    lastError: '',
    elements: [],
    log: [],
  }
}

function normalizeElement(e) {
  if (!e || typeof e !== 'object') return null
  const kind = String(e.kind || '')
  if (!KINDS.includes(kind)) return null
  const text = normText(e.text)
  if (!text) return null
  return {
    kind,
    text,
    maturity: clampInt(e.maturity, 1, MAX_MATURITY, 1),
    evidence: String(e.evidence ?? '').slice(0, 60),
    why: String(e.why ?? '').slice(0, 80),
    hits: Math.max(1, Number(e.hits) || 1),
    createdAt: e.createdAt || new Date().toISOString(),
    lastRound: Math.max(0, Number(e.lastRound) || 0),
  }
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

export function normText(v) {
  return String(v ?? '')
    .replace(/^[\s\-•*·]+/, '')
    .replace(/^["'“”‘’「」『』【】]+|["'“”‘’「」『』【】]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

function normKey(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?~～"'“”‘’（）()【】\[\]…—\-·:：;；]/g, '')
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

function nowIso() {
  return new Date().toISOString()
}

/* ── 会话读写 ───────────────────────────────────────────────────────────── */

/** 只读：没有就返回 null，不创建、不落盘（promptSections 每轮调用，必须便宜）。 */
export function peekChat(chatKey) {
  const key = String(chatKey ?? '').trim()
  if (!key) return null
  return load().chats[key] || null
}

/** 可写：没有就建一个并落盘。 */
export function ensureChat(chatKey) {
  const key = String(chatKey ?? '').trim()
  if (!key) return null
  const data = load()
  if (!data.chats[key]) {
    data.chats[key] = emptyChat(key)
    save()
  }
  return data.chats[key]
}

export function touch(s) {
  if (!s) return
  s.updatedAt = nowIso()
}

export function putChat(s) {
  if (!s?.chatKey) return false
  touch(s)
  load().chats[s.chatKey] = s
  return save()
}

/** 记一轮真实对话；攒够 every 就标记 due。 */
export function bumpRounds(chatKey, every) {
  const s = ensureChat(chatKey)
  if (!s) return { due: false, state: null }
  s.totalRounds += 1
  s.rounds += 1
  const due = s.rounds >= Math.max(5, Math.min(500, Number(every) || 25))
  touch(s)
  save()
  return { due, state: s }
}

export function resetChat(chatKey) {
  const key = String(chatKey ?? '').trim()
  if (!key) return false
  const data = load()
  delete data.chats[key]
  return save()
}

export function resetAll() {
  st = empty()
  return save()
}

/** 按最近活动裁剪会话数，避免常年累积几万个群。 */
function pruneChats(data, max = 300) {
  const keys = Object.keys(data.chats)
  if (keys.length <= max) return
  keys
    .sort((a, b) => String(data.chats[a]?.updatedAt || '').localeCompare(String(data.chats[b]?.updatedAt || '')))
    .slice(0, keys.length - max)
    .forEach((k) => { delete data.chats[k] })
}

/* ── 元素演进 ───────────────────────────────────────────────────────────── */

/** 找最匹配的已有条目：先去标点比全等，再容忍包含关系（「爱用确实开头」vs「爱用『确实』开头」）。 */
export function findElement(s, kind, text) {
  const k = normKey(text)
  if (!k || !Array.isArray(s?.elements)) return null
  const sameKind = s.elements.filter((e) => e.kind === kind)
  const exact = sameKind.find((e) => normKey(e.text) === k)
  if (exact) return exact
  let best = null
  let bestDiff = Infinity
  for (const e of sameKind) {
    const ek = normKey(e.text)
    if (!ek) continue
    if (ek.includes(k) || k.includes(ek)) {
      const diff = Math.abs(ek.length - k.length)
      if (diff < bestDiff) { best = e; bestDiff = diff }
    }
  }
  return best
}

export function pushLog(s, entry, max = 30) {
  if (!s || !Array.isArray(s.log)) return
  s.log.push({ at: nowIso(), round: s.totalRounds, ...entry })
  if (s.log.length > max) s.log.splice(0, s.log.length - max)
}

/**
 * 强化一条已有元素（maturity +1，最多 5）。
 * 找不到就返回 null，由调用方决定是否新增。
 */
export function strengthenElement(s, kind, text, { evidence = '', why = '', round = 0 } = {}) {
  const found = findElement(s, kind, text)
  if (!found) return null
  found.maturity = Math.min(MAX_MATURITY, found.maturity + 1)
  found.hits += 1
  found.lastRound = round || s.totalRounds
  if (evidence) found.evidence = String(evidence).slice(0, 60)
  if (why) found.why = String(why).slice(0, 80)
  pushLog(s, { kind, action: 'strengthen', text: found.text, why })
  return found
}

/**
 * 新增一条元素。同类超上限时淘汰「成熟度最低 + 最久没被强化」的一条。
 * 已有同名条目（不论同类）→ 转为强化，不重复添加。
 */
export function addElement(s, { kind, text, evidence = '', why = '', round = 0 }) {
  if (!KINDS.includes(kind)) return { action: 'skip', reason: 'bad-kind' }
  const clean = normText(text)
  if (clean.length < 2) return { action: 'skip', reason: 'too-short' }

  const existing = findElement(s, kind, clean)
  if (existing) {
    strengthenElement(s, kind, clean, { evidence, why, round })
    return { action: 'strengthen', element: existing }
  }

  const sameKind = s.elements.filter((e) => e.kind === kind)
  if (sameKind.length >= (MAX_PER_KIND[kind] || 4)) {
    const victim = [...sameKind].sort((a, b) => (a.maturity - b.maturity) || (a.lastRound - b.lastRound))[0]
    s.elements = s.elements.filter((e) => e !== victim)
    pushLog(s, { kind: victim.kind, action: 'evict', text: victim.text, why: `同类超过 ${MAX_PER_KIND[kind]} 条` })
  }

  const el = {
    kind,
    text: clean,
    maturity: 1,
    evidence: String(evidence).slice(0, 60),
    why: String(why).slice(0, 80),
    hits: 1,
    createdAt: nowIso(),
    lastRound: round || s.totalRounds,
  }
  s.elements.push(el)
  pushLog(s, { kind, action: 'add', text: clean, why })
  return { action: 'add', element: el }
}

/** 淡化一条（maturity -1，归零就删）。 */
export function fadeElement(s, kind, text, { why = '' } = {}) {
  const found = findElement(s, kind, text)
  if (!found) return false
  found.maturity -= 1
  if (found.maturity <= 0) {
    s.elements = s.elements.filter((e) => e !== found)
    pushLog(s, { kind, action: 'remove', text: found.text, why })
  } else {
    pushLog(s, { kind, action: 'fade', text: found.text, why })
  }
  return true
}

export function setIdentity(s, text, { why = '' } = {}) {
  const clean = normText(text)
  if (clean.length < 4 || clean.length > 60) return false
  if (clean === s.identity) return false
  s.identity = clean
  pushLog(s, { kind: 'identity', action: 'set', text: clean, why })
  return true
}

/**
 * 给它一个自己的称呼。加了两道闸：必须先长过几轮、且两次改名至少隔 8 次演化，
 * 避免每次演化都「重新起名」。
 */
export function setSelfName(s, name, { why = '' } = {}) {
  const clean = normText(name).replace(/[\s，。！？、,.!?~～"'“”‘’（）()【】\[\]]/g, '')
  if (clean.length < 1 || clean.length > 6) return false
  if (clean === s.selfName) return false
  if (!s.selfName && s.evolutions < 2) return false
  if (s.selfName && s.evolutions - s.selfNameEvo < 8) return false
  s.selfName = clean
  s.selfNameEvo = s.evolutions
  pushLog(s, { kind: 'selfName', action: 'set', text: clean, why })
  return true
}

/** 总条数上限：超了按「成熟度低 + 久未强化」淘汰。 */
export function pruneElements(s, maxItems) {
  const max = clampInt(maxItems, 4, 40, 18)
  if (!s || !Array.isArray(s.elements) || s.elements.length <= max) return 0
  const sorted = [...s.elements].sort((a, b) => (b.maturity - a.maturity) || (b.lastRound - a.lastRound))
  const keep = new Set(sorted.slice(0, max))
  const removed = s.elements.length - keep.size
  s.elements = s.elements.filter((e) => keep.has(e))
  pushLog(s, { kind: '*', action: 'prune', text: `淘汰 ${removed} 条`, why: `超过上限 ${max}` })
  return removed
}

/* ── 读取给界面/提示词用 ────────────────────────────────────────────────── */

export function chatSummary(chatKey) {
  const s = peekChat(chatKey)
  if (!s) return null
  return {
    chatKey: s.chatKey,
    identity: s.identity,
    selfName: s.selfName,
    totalRounds: s.totalRounds,
    rounds: s.rounds,
    evolutions: s.evolutions,
    elements: s.elements.length,
    lastEvolvedAt: s.lastEvolvedAt,
    lastError: s.lastError,
    top: [...s.elements].sort((a, b) => (b.maturity - a.maturity) || (b.lastRound - a.lastRound)),
    log: s.log,
  }
}

export const internals = {
  DIR, FILE, KINDS, KIND_LABEL, MAX_PER_KIND, MAX_MATURITY,
  empty, emptyChat, normalizeElement, normText, normKey, pruneChats,
}
