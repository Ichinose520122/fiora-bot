/**
 * 人设生长 —— 把「长出来的自己」渲染成一段动态系统提示词。
 *
 * 三条硬约束：
 *   1. promptSections 被框架**同步**调用，且每轮都调 → 这里只读内存缓存，
 *      不做 LLM、不做网络、不读磁盘。
 *   2. 动态段一律追加在系统提示**末尾**（框架按 priority 排序），绝不插中间，
 *      否则系统提示的缓存前缀会归零。
 *   3. 只写「因此更倾向于怎么做」，不重复聊天记忆 —— 记忆由框架自己注入。
 *
 * 为什么不把所有条目都塞进去：人设越堆越长会把 token 和注意力都吃掉。
 * 所以按成熟度筛选、按类型合并成一行，并且只在强度够的时候才展示低成熟度条目。
 */
import { KIND_LABEL, peekChat } from './store.js'

export const DEFAULT_INTENSITY = 6

export function clampIntensity(v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return DEFAULT_INTENSITY
  return Math.max(0, Math.min(10, n))
}

/** 强度 → 展示口径。 */
function recipe(intensity) {
  if (intensity <= 0) return null
  return {
    // 默认 6：刚长出来的（成熟度 1）就该被用起来，否则第一次演化看不到效果。
    // 只有力度很低时才省略「还只是苗头」的条目。
    minMaturity: intensity >= 4 ? 1 : 2,
    maxItems: intensity >= 7 ? 12 : intensity >= 4 ? 10 : 5,
    tone: intensity >= 7 ? 'hard' : intensity <= 3 ? 'soft' : 'normal',
  }
}

const ORDER = ['catchphrase', 'habit', 'interest', 'dislike', 'joke', 'selfImage', 'opinion']

/**
 * @param {{chatKey?:string}} context
 * @returns {Array<{id:string,title:string,content:string,priority:number,meta:object}>}
 */
export function renderSection(context = {}, cfg = {}) {
  const intensity = clampIntensity(cfg.intensity)
  const rec = recipe(intensity)
  if (!rec) return []

  const chatKey = String(context?.chatKey ?? '').trim()
  if (!chatKey) return []

  const s = peekChat(chatKey)
  if (!s) return []

  const picked = (s.elements || [])
    .filter((e) => e.maturity >= rec.minMaturity)
    .sort((a, b) => (b.maturity - a.maturity) || (b.lastRound - a.lastRound))
    .slice(0, rec.maxItems)

  if (!picked.length && !s.identity) return []

  const lines = []
  lines.push('【你自己长出来的样子】这不是别人写给你的设定，是你在这些聊天里一点点变成的，'
    + '和上面那个人设是同一个你。按它说话，就像一个人自然会有的习惯，不用刻意强调。')

  if (s.identity) lines.push(`你给自己的定位：${s.identity}`)
  if (s.selfName) lines.push(`你对自己的称呼：${s.selfName}（自称时可以用，不用解释这个称呼的来历）`)

  const byKind = new Map()
  for (const e of picked) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, [])
    byKind.get(e.kind).push(e.text)
  }
  for (const kind of ORDER) {
    const list = byKind.get(kind)
    if (!list?.length) continue
    lines.push(`- ${KIND_LABEL[kind] || kind}：${list.join('、')}`)
  }

  if (rec.tone === 'hard') {
    lines.push('上面这些请**明显**体现在语气和用词里，让它成为你在这个会话里的主要说话方式；'
      + '但不要为了像自己而编造事实或假装知道没发生过的事。')
  } else if (rec.tone === 'soft') {
    lines.push('上面这些只是说话倾向的参考，不是必须照做的设定；该讲事实就讲事实，别为了像而扭曲回答。')
  } else {
    lines.push('上面这些自然地融进说话方式就好，不要表演，也不要主动跟人解释你有「人设」。')
  }

  lines.push('【底线】事实、工具返回结果、安全规则永远优先；和原人设的身份、价值观冲突时，以原人设为准；'
    + '没人问起时，不要主动讲这些是怎么长出来的。')

  return [{
    id: 'persona-grow-dynamic',
    title: '长出来的自己',
    content: lines.join('\n'),
    // 排在核心规则和多数技能段之后：只做补充，不盖过人设
    priority: 37,
    meta: {
      intensity,
      items: picked.length,
      maturity: rec.minMaturity,
      identity: Boolean(s.identity),
      selfName: s.selfName || '',
      rounds: s.totalRounds,
      evolutions: s.evolutions,
    },
  }]
}

export const internals = { recipe, ORDER }
