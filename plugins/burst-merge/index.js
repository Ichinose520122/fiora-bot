// 连发合并（确定性型 / plugins/）：把"同一个人连发的多条消息"合并成同一次运行。
//
// 为什么是插件而不是技能：这件事**每次都要发生**、判据是能写死的规则（同一个人 /
// 窗口内 / 有封顶），不需要模型理解人话，也不用给模型新工具 —— 正好是"核心按能力
// 取用、插件提供能力"的形态。核心侧只有 orchestrator.extendWake 问一句策略。
//
// 核心给的入参：
//   { chatKey, entry, meta }
//   · entry —— 刚到的这条消息（senderId / text / ts …）
//   · meta  —— 当前窗口：{ senderId（先开话的人）, startedAt, windowMs, elapsedMs }
// 返回值：{ extendMs } = 把倒计时重排为这么多毫秒；返回 null 表示不干预（按时响应）。
//
// 本模块**不保存任何状态**（只看核心给的 meta），所以热重载、重复 setup 都无害。
let api = null;

export function setup(injected) {
  api = injected;
}

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const capMs = Number(raw.capMs);
  return {
    enabled: raw.enabled !== false,
    // ⚠️ 必须区分"解析不出来"和"显式 0"：0 是合法值（表示关闭合并），
    // 沿用 `capMs > 0 ? capMs : 8000` 那种兜底会把用户的"关闭"读成"等 8 秒"。
    capMs: Number.isFinite(capMs) ? Math.max(0, capMs) : 8000
  };
}

/**
 * 判定：这次要不要续期、续多久。
 * @returns {{extendMs:number}|null}
 */
export function decide({ entry, meta } = {}, s = settings()) {
  if (!s.enabled || s.capMs <= 0) return null;
  if (!meta) return null;
  const senderId = String(entry?.senderId ?? '');
  // 只认"同一个人"：群里别人插话不算"他没说完"，否则窗口会被别人的闲话顶着无限延长
  if (!senderId || senderId !== String(meta.senderId ?? '')) return null;
  const elapsedMs = Math.max(0, Number(meta.elapsedMs) || 0);
  const remain = s.capMs - elapsedMs;
  if (remain <= 0) return null;                 // 已到封顶：按时走，不再延
  const windowMs = Math.max(0, Number(meta.windowMs) || 2000);
  return { extendMs: Math.min(windowMs, remain) };
}

export const providers = {
  'wake.burst-policy': decide
};
