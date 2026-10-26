/**
 * 插件自己的 LLM 调用封装（照 B站/性格养成两处的成熟写法）。
 *
 * 为什么不用 api.xxx：插件 API 白名单里**没有** LLM 能力（只有 registerTool /
 * config / capability / fetch / log）。所以插件要自己拿配置、自己发请求。
 *
 * 稳健性要求：
 *   · 任何失败都返回结构化结果，绝不抛出去打断聊天主流程
 *   · 有超时（默认 25s），后台生长不能把一轮对话拖死
 *   · 不用 response_format（部分网关不认），靠提示词 + 容错解析
 */
import { getConfig } from '../../src/config.js'
// 必须用官方 resolveApiKey()，不能直接读 cfg.api.apiKey：那个字段是手动模式的遗留字段，
// 用户在 UI 里选了目录提供商之后，真正的 key 在 dshProviderKeys[providerId] 里。
import { resolveApiKey } from '../../src/llm.js'

const DEFAULT_TIMEOUT = 25000

/** 取聊天用的 API 配置（和主对话同一套，保证模型/额度/计费一致）。 */
export function apiConf() {
  try {
    const c = getConfig()
    const api = c?.api || {}
    return {
      apiKey: String(resolveApiKey(c) || '').trim(),
      baseUrl: String(api.baseUrl ?? '').trim().replace(/\/+$/, ''),
      model: String(api.model ?? '').trim(),
    }
  } catch {
    return { apiKey: '', baseUrl: '', model: '' }
  }
}

export function available() {
  const c = apiConf()
  return Boolean(c.apiKey && c.baseUrl && c.model)
}

/**
 * 构造"关闭思考"的请求参数。
 * 本机实测 deepseek-flash 在 thinking 模式下会把 max_tokens 全花在
 * reasoning_content 上，正文为空（finish_reason=length），所以必须关。
 * 参数按各家方言给，和核心 src/thinking.js 的规则保持一致。
 */
function thinkingOffParams(baseUrl, model) {
  const host = (() => {
    try { return new URL(baseUrl).host.toLowerCase() } catch { return String(baseUrl || '').toLowerCase() }
  })()
  const m = String(model || '')

  if (/qwen|qwq/i.test(m) || /dashscope|aliyuncs/.test(host)) return { enable_thinking: false }
  if (/(anthropic|claude)\./.test(host) || /claude/i.test(m)) return { thinking: { type: 'disabled' } }
  if (/^(o[1-9](-|$)|gpt-5)/i.test(m)) return { reasoning_effort: 'minimal' }
  if (/deepseek/.test(host) || /bigmodel\.cn$/.test(host)
      || /deepseek|glm/i.test(m)) return { thinking: { type: 'disabled' } }
  return {}
}

function stripThinking(body) {
  const b = { ...body }
  delete b.thinking
  delete b.enable_thinking
  delete b.thinking_budget
  delete b.reasoning_effort
  return b
}

async function chatOnce(messages, { temperature, maxTokens, timeoutMs, fetchImpl, thinking = 'off' }) {
  const t0 = Date.now()
  const c = apiConf()
  if (!c.apiKey || !c.baseUrl || !c.model) {
    return { ok: false, text: '', error: '未配置可用的模型（api.baseUrl / apiKey / model）', retryable: false, ms: 0 }
  }

  const body = { model: c.model, messages, temperature, max_tokens: maxTokens, stream: false }
  if (thinking === 'off') Object.assign(body, thinkingOffParams(c.baseUrl, c.model))

  const send = async (payload) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await fetchImpl(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify(payload),
        signal: ac.signal,
      })
      return { status: r.status, bodyText: await r.text() }
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    let res = await send(body)
    // 网关/模型不认 thinking 参数（400/422）→ 摘掉重发一次
    if ((res.status === 400 || res.status === 422)
        && /thinking|reasoning_effort|enable_thinking/i.test(res.bodyText)) {
      res = await send(stripThinking(body))
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false, text: '',
        error: `HTTP ${res.status} ${res.bodyText.slice(0, 300)}`,
        retryable: res.status >= 500 || res.status === 429, ms: Date.now() - t0,
      }
    }
    let data = null
    try { data = JSON.parse(res.bodyText) } catch { /* 下方报错 */ }
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) {
      const msg = data?.choices?.[0]?.message
      const keys = msg ? Object.keys(msg).join(',') : '无 message'
      const fr = data?.choices?.[0]?.finish_reason ?? '?'
      const usage = data?.usage ? JSON.stringify(data.usage) : '无 usage'
      return {
        ok: false, text: '',
        error: `响应里没有正文（finish_reason=${fr}；message 字段=${keys}；usage=${usage}；`
          + `原始前 200 字=${res.bodyText.slice(0, 200)}）`,
        retryable: true, ms: Date.now() - t0,
      }
    }
    return { ok: true, text: text.trim(), error: '', retryable: false, ms: Date.now() - t0 }
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    return {
      ok: false, text: '',
      error: aborted ? `超时（${timeoutMs}ms）` : String(e?.message || e).slice(0, 200),
      retryable: true, ms: Date.now() - t0,
    }
  }
}

/** 带重试的 chat/completions。这些调用都在后台，多试一次不打扰用户。 */
export async function chat(messages, {
  temperature = 0.5,
  maxTokens = 1200,
  timeoutMs = DEFAULT_TIMEOUT,
  fetchImpl = globalThis.fetch,
  retries = 2,
  thinking = 'off',
} = {}) {
  const t0 = Date.now()
  let last = null
  const total = Math.max(1, retries + 1)
  for (let i = 0; i < total; i++) {
    const r = await chatOnce(messages, { temperature, maxTokens, timeoutMs, fetchImpl, thinking })
    if (r.ok) return { ...r, ms: Date.now() - t0, attempts: i + 1 }
    last = r
    if (!r.retryable) break
    if (i < total - 1) await new Promise((res) => setTimeout(res, 600 * (i + 1)))
  }
  return { ok: false, text: '', error: last?.error || '未知错误', ms: Date.now() - t0, attempts: total }
}

/** 从模型输出里抠出 JSON（容错：```json 包裹、前后带解释文字）。 */
export function extractJson(text) {
  const s = String(text ?? '')
  const tryParse = (t) => {
    try {
      const v = JSON.parse(t)
      return v && typeof v === 'object' ? v : null
    } catch { return null }
  }
  let o = tryParse(s.trim())
  if (o) return o
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { o = tryParse(fence[1].trim()); if (o) return o }
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) { o = tryParse(s.slice(i, j + 1)); if (o) return o }
  return null
}

export const internals = { DEFAULT_TIMEOUT, thinkingOffParams, stripThinking }
