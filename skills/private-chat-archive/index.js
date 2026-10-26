// private-chat-archive —— 私聊记忆库（技能 / skills/，LLM 型 + 两个确定性钩子）
//
// ── 为什么定成「技能」而不是「插件」（照 src/skills/manifest.js 的 DIR_KIND 语义）──
//   判据只有一条：**谁决定"什么时候执行"**。
//     plugins/ 确定性型 —— 核心按能力名调用，条件满足必然执行，模型想忽略也忽略不掉；
//     skills/  LLM 型    —— 注册工具进模型的 function 列表，用不用由模型自己判断。
//
//   本功能的价值点在于"**机器人主动**去翻旧账"：什么时候该翻、翻什么关键词、
//   翻到的内容要不要用 —— 没有一条规则能写死（"你记得我上个月说的那个吗"这种话
//   没有固定句式）。所以它必须是一个工具，必须做在 skills/。
//
//   ⚠️ 那为什么这个技能里还有 hooks？—— 因为归档这一半是**确定性**的：
//      消息和心绪都得存下来，不能指望模型每次都记得调工具去存。所以拆成两半，
//      放在同一个目录里：
//        · hooks['before-context']  —— 收消息（进缓存，按时间间隔落盘）
//        · hooks['after-response']  —— 收心绪（模型刚用 mind_note 记完，此刻才是新的）
//        · api.registerTool(...)    —— 主动调阅 + 写心绪，模型自己决定何时用
//      两半放同一个目录只影响"语义归类"，不影响加载 —— 两种清单走同一条
//      normalizeManifest，功能完全等价（见 src/plugin-loader.js 顶部注释）。
//      反过来说：**只导出 hooks 不注册工具**会踩 loader 的 lintKindPlacement 警告
//      （"模型看不到它，功能不会被触发"），所以这两半必须一起提供，缺一不可。
//
// ── 为什么还要自己归档一遍（内置 store 不是已经存了吗）──
//   内置 store（src/store.js）确实把消息存在 data/messages/<chatKey>.json 里，
//   但它是一个**会被裁剪的活存档**：config.store.maxMessagesPerChat > 0 时
//   #trim 会把最老的整批切掉（用户一改设置，旧记录就永久没了）。
//   归档是**纯追加、永不改写、按月分文件**的第二份事实来源：
//     · 不受任何"保留条数"设置影响；
//     · 按月分文件，单文件不会无限长大（打开、备份、grep 都轻松）；
//     · 每条只写一行（JSONL），追加写入，崩溃最多丢最后一行，不会毁掉整个文件。
//
// ── 心绪机制：本技能**自带**（2.0 起不再依赖 inner-life 插件）──────────────
//   1.x 的做法是"只读 inner-life 的数据文件"。2.0 按用户要求改成**自己实现**，
//   把这套机制复刻进来（见"心绪状态"一节）。原因：
//     · 不再依赖另一个模块的内部文件格式（它一改版我们就瞎）；
//     · 心绪和归档天生是一件事 —— 心绪快照必须和当时的聊天记录在**同一条时间线**上，
//       分成两个模块两份存储，检索时要跨目录对齐，脆且慢。
//   原 inner-life 插件已默认关闭（我们改了它的 enabledByDefault），两边不会打架。
//
//   ⚠️ 时序陷阱（1.x 踩过，别改回去）：
//     心绪是模型在**回复收尾时**调 mind_note 写下的。而 before-context 跑在
//     **回复开始之前** —— 在钩子里读心绪，读到的是"上一轮的旧心绪"，
//     本轮刚变的那次会漏掉，而且每轮都会错一拍。所以心绪归档必须挂在
//     after-response（回复结束、mind_note 已经落盘之后）上。
//
// ── 攒批：按**时间**落盘（设置项 archiveIntervalHours，默认 4 小时）──────────
//   按用户要求：消息先收进缓存，**每 4 小时**（或空闲 archiveIdleFlushSec）写一次磁盘，
//   不是来一条写一条、也不是攒够 N 条写一次。
//   ⚠️ 代价必须说清楚（这是用户明确选择的权衡）：进程被**强杀或断电**时，
//      内存缓存里最多 4 小时的消息会丢。为此做的保险：
//        ① pending.json —— 每次入队都把"还没落盘的消息"写到磁盘，
//           所以**正常重启**（关窗口、重启机器人、热重载）一条都不丢；
//        ② 空闲补写 —— 超过 archiveIdleFlushSec 没新消息就落盘，
//           否则"聊完就没人说话"会一直卡在缓存里等下一个 4 小时；
//        ③ deactivate（停用/热重载/关闭）兜底补写。
//      只有 ① 拦不住强杀。想更保险就把 archiveIdleFlushSec 调小。
//
// ── 落盘位置（照 whale-memes 的做法，锚点绝不取 process.cwd()）──
//   <DATA_DIR>/private-chat-archive/
//     ├── mood/<会话>.json     当前心绪（情绪 + 挂心事；TTL + 容量双保险）
//     └── <会话目录>/
//         ├── 2026-02.jsonl      完整消息归档（一条一行，JSONL）
//         ├── mood.jsonl         心绪快照（只在变化时追加，纯追加）
//         └── .index/
//             ├── seen.json      已入库的消息指纹（去重，防止重复归档）
//             ├── compact.jsonl  紧凑检索索引（可选，关掉 archiveSearchIndex 就不写）
//             ├── pending.json   缓存里的消息（还没到落盘时间，防正常重启丢数据）
//             └── stats.json     归档统计（消息条数/心绪条数/日期跨度/每月条数/最活跃的人）
//
// ── 踩过的坑（别改回去）──
//   1) 钩子必须**不阻塞**：归档是"以后可能用得上"的事，await 它会让每次回复都慢。
//      所以钩子里 fire-and-forget（不 await），并且用队列串行化，
//      避免同一会话并发追加导致索引错乱。
//   2) ⚠️ seen（已落盘索引）的语义只能是"**已经写进归档文件**"，
//      **绝不能**当成"本轮已收取"的标记。1.x 在入队时就 markSeen，结果缓存里的消息
//      重启后要落盘时，被自己刚打的标记判成"已归档"而全部丢弃 ——
//      表现为"重启后那批消息凭空消失"。缓存内去重请用 bufferedFingerprints。
//   3) JSONL 追加只能用 fs.appendFileSync：writeFileSync 会把整个文件覆盖掉。
//   4) 单条文本必须截断：有人粘贴一整篇小说再来一条超长消息，归档和模型上下文
//      会一起被撑爆。截断发生在**入库时**（maxTextPerHit），检索侧再加一道。
//   5) 检索结果必须限量：maxHitsHardLimit 是硬闸 —— 模型把 limit 填成 100000
//      也不能真的吐 10 万条（那会让这一轮回复又贵又慢，甚至超上下文）。
//   6) 不用 Math.min(...arr) 这种展开写法：补历史时一次几千条会把调用栈打爆。
//   7) 写状态文件前必须确保父目录存在：缓存路径（pending.json）与心绪统计路径
//      都可能在任何落盘之前就被调用，.index/ 不存在会直接 ENOENT 静默失败。
//   8) 心绪必须做 TTL prune：过期的情绪/心事连心绪机制自己都不认了，
//      归档里却当成"当时的心绪"留着，等于制造假数据。
//   9) 返回给模型的文本里不要塞大段 JSON：按行渲染成
//      "[2026-03-05 21:14] 阿哲: 显卡又蓝屏了" 最省 token 也最不容易误读。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SKILL_ID = 'private-chat-archive';
const TOOL_SEARCH = 'search_archive';
const TOOL_BY_DATE = 'query_by_date';
const TOOL_OVERVIEW = 'archive_overview';
const TOOL_MOOD = 'mood_search';
const TOOL_MIND_NOTE = 'mind_note';
const TOOL_MIND_SETTLE = 'mind_settle';

/** 与 skill.json 的 settings 保持一致（这里留一份是为了加载顺序与容错）。 */
const DEFAULTS = {
  enabled: true,
  scope: 'private',
  archiveIntervalHours: 4,
  archiveIdleFlushSec: 900,
  archiveSearchIndex: true,
  maxHits: 15,
  maxHitsHardLimit: 50,
  contextWindow: 2,
  maxTextPerHit: 160,
  overviewSample: 3,
  backfillOnStart: true,
  backfillLimit: 4000,
  indexRefreshMs: 4000,
  moodEnabled: true,
  moodInject: true,
  moodArchive: true,
  moodArchiveWhen: 'change',
  moodShowTopics: true,
  moodMaxDays: 30,
  moodTtlHours: 24,
  topicTtlHours: 12,
  maxTopics: 3
};

/** 每次钩子最多收多少条（钩子的载荷是"本批新消息"，正常就几条）。 */
const MAX_APPEND_PER_TICK = 200;
/** 检索时最多保留多少行（防止归档特别大时一次占满内存）。 */
const MAX_SCAN_LINES = 600000;
/** 单条消息文本兜底上限（maxTextPerHit 填 0 时用它兜底，防止真的不截断）。 */
const ABSOLUTE_TEXT_CAP = 4000;
/** 缓存落盘/读取的上限（超过就强制先落盘，防止一个会话卡住几万条）。 */
const PENDING_HARD_CAP = 50000;
/** 定时巡检间隔。 */
const SWEEP_MS = 30000;
/** 心绪文本长度上限（与注入/归档渲染保持一致）。 */
const MOOD_TEXT_MAX = 40;
const TOPIC_TEXT_MAX = 60;

// ─────────────────────────────────────────────── 数据目录

let DATA_DIR = '';
try {
  ({ DATA_DIR } = await import('../../src/config.js'));
} catch {
  DATA_DIR = '';
}

/** 本技能的归档根目录。 */
function dataRoot() {
  const fromEnv = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (fromEnv) return path.join(fromEnv, SKILL_ID);
  if (DATA_DIR) return path.join(DATA_DIR, SKILL_ID);
  // 最后兜底：<install>/data/private-chat-archive（与 pixiv-image 同一约定）
  return path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', SKILL_ID));
}

/** 心绪状态目录（自己实现的心绪存在这里，不再碰 inner-life 的地盘）。 */
function moodStateDir() {
  return path.join(dataRoot(), 'mood');
}

// ─────────────────────────────────────────────── 运行时状态

let api = null;
let log = (...a) => console.log('[skill]', ...a);
let warn = (...a) => console.warn('[skill]', ...a);
let cfgCache = { at: 0, value: null };
let sweepTimer = null;

function cfg() {
  const now = Date.now();
  if (cfgCache.value && now - cfgCache.at < 3000) return cfgCache.value;
  let merged = { ...DEFAULTS };
  try {
    const c = api?.config?.();
    if (c && typeof c === 'object') merged = { ...merged, ...c };
  } catch { /* 配置读不到就用默认值，绝不能因此整个技能失效 */ }
  cfgCache = { at: now, value: merged };
  return merged;
}

function num(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function isOn() {
  return cfg().enabled !== false;
}

function scopeOf() {
  return cfg().scope === 'all' ? 'all' : 'private';
}

// ─────────────────────────────────────────────── 通用小工具

function clean(s, max = 0) {
  let out = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (max > 0 && out.length > max) out = out.slice(0, max);
  return out;
}

/** 文本截断上限：配置 0 = 不截断，但仍有绝对兜底（防超长粘贴撑爆一切）。 */
function textCap() {
  const v = num(cfg().maxTextPerHit, DEFAULTS.maxTextPerHit, 0, ABSOLUTE_TEXT_CAP);
  return v > 0 ? v : ABSOLUTE_TEXT_CAP;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地时区的 YYYY-MM-DD。归档按**用户本地时间**分月，跟 console 上看到的一致。 */
function dayKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function monthKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function timeLabel(ts) {
  const d = new Date(ts);
  return `${dayKeyOf(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 'YYYY-MM-DD' → 当天 00:00:00.000 的本地时间戳；非法返回 null。 */
function startOfDay(text) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(clean(text, 20));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

function endOfDay(text) {
  const s = startOfDay(text);
  return s === null ? null : s + 86400000 - 1;
}

/** 会话键 → 磁盘目录名。只在**本技能自己的目录下**拼名字，不接受路径分隔符。 */
function safeDirOf(chatKey) {
  const key = String(chatKey ?? '').trim();
  const m = /^(group|private):([a-zA-Z0-9]{1,128})$/.exec(key);
  if (!m) return '';
  return `${m[1]}_${m[2]}`;
}

function chatKindOf(chatKey) {
  const key = String(chatKey ?? '');
  if (key.startsWith('private:')) return 'private';
  if (key.startsWith('group:')) return 'group';
  return '';
}

function chatDirOf(chatKey) {
  const safe = safeDirOf(chatKey);
  return safe ? path.join(dataRoot(), safe) : '';
}

function indexPath(chatKey, name) {
  const dir = chatDirOf(chatKey);
  return dir ? path.join(dir, '.index', name) : '';
}

/** 单条消息的"指纹"：优先 QQ 消息 id，其次时间+人+内容。 */
function fingerprintOf(rec) {
  if (rec.mid !== null && rec.mid !== undefined && String(rec.mid) !== '') {
    return `m:${rec.ts}:${rec.mid}`;
  }
  const h = crypto.createHash('sha1')
    .update(`${rec.ts}|${rec.senderId}|${rec.text}`)
    .digest('hex')
    .slice(0, 16);
  return `h:${h}`;
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const parsed = JSON.parse(text);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 写 JSON 状态文件（原子写）。
 *
 * ⚠️ 必须**自己确保父目录存在**：攒批路径（pending.json）和心绪路径（stats.json）
 *    都可能在"第一次落盘之前"就调用它 —— 那时 .index/ 还没被任何写操作创建出来，
 *    于是 tmp 文件 open 直接 ENOENT。表现在用户那边是
 *    "聊了几句，重启后什么都没了"，而且只在首次会话发生，极难复现。
 */
function writeJsonAtomic(file, data) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    warn(`写状态失败 ${path.basename(file)}：${error?.message ?? error}`);
    return false;
  }
}

function appendLine(file, line) {
  fs.appendFileSync(file, `${line}\n`, 'utf8');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (error) {
    warn(`创建目录失败 ${dir}：${error?.message ?? error}`);
    return false;
  }
}

/** 带超时的动态 import（目前没用到，保留给将来接入外部模块时用，避免再踩
 *  "某个模块加载卡住把调用方一起拖死"的坑）。 */
function importWithTimeout(spec, ms = 1500) {
  return Promise.race([
    import(spec),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      if (typeof t.unref === 'function') t.unref();
    })
  ]).catch(() => null);
}
void importWithTimeout;

// ─────────────────────────────────────────────── 去重索引（seen.json）

const seenSets = new Map();      // chatKey -> Set
const seenDirty = new Set();     // 待落盘的 chatKey

function seenOf(chatKey) {
  if (seenSets.has(chatKey)) return seenSets.get(chatKey);
  const file = indexPath(chatKey, 'seen.json');
  const raw = file ? readJson(file, {}) : {};
  const set = new Set(Array.isArray(raw?.keys) ? raw.keys : []);
  seenSets.set(chatKey, set);
  return set;
}

function markSeen(chatKey, fingerprint) {
  const set = seenOf(chatKey);
  if (set.has(fingerprint)) return false;
  set.add(fingerprint);
  seenDirty.add(chatKey);
  return true;
}

/**
 * 落盘去重索引。
 *
 * ⚠️ 截断策略按**可信度**分两类，不能简单切尾巴：
 *    · 'm:' 前缀 = 有 QQ 消息 id，是**精确**指纹，永远保留；
 *    · 'h:' 前缀 = 没有 mid 时的兜底哈希，只在 m: 都没超预算时才保留。
 *   如果无脑 slice 尾巴，老指纹会被挤掉 → 下次补齐历史时老消息会被重复归档。
 */
function flushSeen(chatKey) {
  if (!seenDirty.has(chatKey)) return;
  const file = indexPath(chatKey, 'seen.json');
  if (!file) return;
  try {
    const set = seenOf(chatKey);
    const all = [...set];
    const MAX_KEYS = 200000;
    let kept = all;
    if (all.length > MAX_KEYS) {
      const exact = all.filter((k) => k.startsWith('m:'));
      const hashed = all.filter((k) => !k.startsWith('m:'));
      const room = Math.max(0, MAX_KEYS - exact.length);
      kept = [...exact, ...(room > 0 ? hashed.slice(hashed.length - room) : [])];
      warn(`去重索引超过 ${MAX_KEYS} 条，已按"有消息 id 的优先"裁剪（当前会话 ${chatKey}）`);
    }
    writeJsonAtomic(file, { updatedAt: Date.now(), keys: kept });
    if (kept.length !== all.length) seenSets.set(chatKey, new Set(kept));
    seenDirty.delete(chatKey);
  } catch (error) {
    warn(`写去重索引失败：${error?.message ?? error}`);
  }
}

// ─────────────────────────────────────────────── 归档写入

/** 把 store / 工具拿到的消息条目规范化成归档记录（null = 该条不该入库）。 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let ts = Number(entry.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  // 秒级时间戳（OneBot 有的实现给秒）→ 毫秒，否则会归档到 1970 年
  if (ts < 1e12) ts = ts * 1000;
  const text = clean(entry.text, textCap());
  const media = Array.isArray(entry.media) ? entry.media : [];
  // 纯图片/表情消息 text 可能为空：只要带媒体就仍然值得归档
  if (!text && !media.length) return null;
  return {
    ts,
    mid: entry.mid ?? null,
    senderId: clean(entry.self ? 'self' : entry.senderId, 32),
    senderName: clean(entry.self ? '我' : entry.senderName, 60),
    self: Boolean(entry.self),
    text,
    reply: entry.reply ? clean(entry.reply.text, 120) : '',
    media: media
      .map((m) => clean(m?.kind || m?.type || 'media', 16))
      .filter(Boolean)
      .slice(0, 6)
  };
}

/** 归档记录 → 落盘的那一行（字段名刻意短，几万行的文件体积差很多）。 */
function buildRecord(rec) {
  return {
    t: rec.ts,
    d: dayKeyOf(rec.ts),
    mid: rec.mid,
    sid: rec.senderId,
    sn: rec.senderName,
    self: rec.self ? 1 : 0,
    text: rec.text,
    reply: rec.reply || '',
    media: rec.media
  };
}

/** 归档记录 → 紧凑索引行（检索只读这一份，快且小）。 */
function buildCompact(rec) {
  return {
    t: rec.ts,
    sid: rec.senderId,
    sn: rec.senderName,
    self: rec.self ? 1 : 0,
    text: rec.text
  };
}

/**
 * 真正落盘：把一批**已经规范化**的记录写进归档文件。
 * 调用方必须持有该会话的串行队列（见 flushPendingLocked / appendImmediate）。
 *
 * 职责边界（重要，别混）：
 *   · 去重（要不要写）由调用方决定；
 *   · 本函数只负责写，并在**写成功之后**把指纹登记进 seen（"已落盘"）。
 *
 * ⚠️ seen 的语义必须是"**已经写进归档文件**"，不能当成"本轮已收取"的标记。
 *    曾经在入队时就 markSeen，结果：缓存里的消息（还没写盘）重启后要落盘时，
 *    被自己刚打的标记判成"已归档"而全部丢弃 —— 表现为"重启后那批消息凭空消失"。
 *
 * @param {Array<{rec: object, fp: string, month: string}>} list
 */
function writeRecords(chatKey, list, { source = 'hook' } = {}) {
  const result = { written: 0, skipped: 0 };
  const dir = chatDirOf(chatKey);
  if (!dir || !list.length) return result;
  if (!ensureDir(path.join(dir, '.index'))) return result;

  const wantCompact = cfg().archiveSearchIndex !== false;

  // 同月合并成一次 appendFileSync：几十条消息只开一次文件
  const byMonth = new Map();
  for (const item of list) {
    const arr = byMonth.get(item.month) || [];
    arr.push(item);
    byMonth.set(item.month, arr);
  }

  const writtenRecs = [];
  for (const [month, items] of byMonth) {
    try {
      const lines = items.map((it) => JSON.stringify(buildRecord(it.rec)));
      appendLine(path.join(dir, `${month}.jsonl`), lines.join('\n'));
      if (wantCompact) {
        const compact = items.map((it) => JSON.stringify(buildCompact(it.rec)));
        appendLine(path.join(dir, '.index', 'compact.jsonl'), compact.join('\n'));
      }
      // 写成功之后才登记：写失败就不登记，这批下次还会被重试
      for (const it of items) markSeen(chatKey, it.fp);
      result.written += items.length;
      writtenRecs.push(...items.map((it) => it.rec));
    } catch (error) {
      warn(`归档写入失败（${month}）：${error?.message ?? error}`);
    }
  }

  if (result.written) {
    flushSeen(chatKey);
    // 统计在**同一次串行队列**里更新，避免并发写 stats.json 互相覆盖
    bumpStats(chatKey, { timestamps: writtenRecs.map((r) => r.ts), recs: writtenRecs });
    invalidateCaches(chatKey);
  }
  return result;
}

/**
 * 规范化 + 去重。
 *
 * ⚠️ 这里的去重只针对**本次调用**（同一批里的重复项）和**已经落盘的**（seen），
 *    绝不在这一步 markSeen —— 那会让"还没落盘、只是进了缓存"的消息被错判成已归档。
 *    缓存内的跨批去重由 pending 缓冲区自己负责。
 */
function prepareEntries(chatKey, entries, { dedupe = true } = {}) {
  const list = [];
  let skipped = 0;
  const batchSeen = new Set();
  for (const raw of entries) {
    const rec = normalizeEntry(raw);
    if (!rec) { skipped += 1; continue; }
    const fp = fingerprintOf(rec);
    if (dedupe && (batchSeen.has(fp) || seenOf(chatKey).has(fp))) { skipped += 1; continue; }
    batchSeen.add(fp);
    list.push({ rec, fp, month: monthKeyOf(rec.ts) });
  }
  return { list, skipped };
}

/** 缓存缓冲区的指纹集合（判断"这条是不是已经在缓存里等着了"）。 */
function bufferedFingerprints(chatKey) {
  const state = pending.get(chatKey);
  const set = new Set();
  for (const it of state?.items || []) set.add(it.fp);
  return set;
}

/**
 * 立即落盘（不走攒批）。用于**补齐历史**：那是一次性的批量导入，
 * 没有必要为了省几次写而把所有历史压在内存里等下次满 25 条。
 */
function appendImmediate(chatKey, entries, meta = {}) {
  const result = { written: 0, skipped: 0 };
  if (!isOn()) return result;
  if (!chatDirOf(chatKey)) return result;
  const { list, skipped } = prepareEntries(chatKey, entries);
  result.skipped += skipped;
  if (!list.length) {
    flushSeen(chatKey);
    return result;
  }
  const r = writeRecords(chatKey, list, meta);
  result.written += r.written;
  return result;
}

// ─────────────────────────────────────────────── 缓存（pending.json）：按时间落盘

/** chatKey -> { items: [{e, fp}], at: number }（e = 已规范化的记录） */
const pending = new Map();
/** chatKey -> 是否已经读过 pending.json，避免重复读盘 */
const pendingLoaded = new Set();

/** 归档间隔（毫秒）。0/非法 → 用默认 4 小时。 */
function archiveIntervalMs() {
  return num(cfg().archiveIntervalHours, DEFAULTS.archiveIntervalHours, 1, 168) * 3600000;
}

/** 空闲补写阈值（毫秒）。 */
function idleFlushMs() {
  return num(cfg().archiveIdleFlushSec, DEFAULTS.archiveIdleFlushSec, 15, 86400) * 1000;
}

/** 上次"到点归档"的时间（内存态；重启后按 pending.json 的 updatedAt 兜底）。 */
let lastIntervalFlushAt = Date.now();

function pendingFile(chatKey) {
  return indexPath(chatKey, 'pending.json');
}

/**
 * 把"还没凑满一批的消息"写进磁盘。
 *
 * 为什么值得多写这一份：攒批的代价就是"没满一批就退出 → 丢消息"。
 * 有了 pending.json，正常重启（关窗口、重启机器人、热重载）一条都不丢；
 * 只有进程被强杀/断电才会丢最后一批。在**每次入队时**写一次，成本是一条很小的
 * JSON 覆盖写（几十条消息才几 KB），换来的是"攒批不再等于赌命"。
 */
function savePending(chatKey) {
  const file = pendingFile(chatKey);
  if (!file) return;
  const state = pending.get(chatKey);
  const items = state?.items || [];
  if (!items.length) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    return;
  }
  writeJsonAtomic(file, {
    updatedAt: Date.now(),
    items: items.map((it) => ({ fp: it.fp, e: it.e }))
  });
}

/**
 * 读回上次没落盘的攒批缓存。
 *
 * ⚠️ 只**接回缓存**，不在这里落盘。第一版写成"接回来立刻 flush"，
 *    结果重启后的第一批被切成两段：缓存里 4 条先落一次盘，
 *    紧接着来的第 5 条孤零零留在新缓存里等下一条 —— 攒批计数被重置了。
 *    正确做法是把它们当成"还没攒够的那部分"，交给正常的攒批逻辑累加。
 */
function loadPending(chatKey) {
  if (pendingLoaded.has(chatKey)) return;
  pendingLoaded.add(chatKey);
  const file = pendingFile(chatKey);
  if (!file) return;
  const raw = readJson(file, null);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  if (!items.length) return;
  const out = [];
  for (const it of items) {
    const rec = normalizeEntry(it?.e);
    if (!rec) continue;
    out.push({ e: rec, fp: String(it?.fp || fingerprintOf(rec)) });
  }
  if (out.length) {
    pending.set(chatKey, { items: out, at: Number(raw?.updatedAt) || Date.now() });
    log(`发现上次没落盘的缓冲消息：${chatKey} ${out.length} 条，已接回队列（等下一个落盘点写出）`);
  }
}

/** 取（必要时创建）某会话的缓存。 */
function pendingOf(chatKey) {
  loadPending(chatKey);
  let state = pending.get(chatKey);
  if (!state) {
    state = { items: [], at: Date.now() };
    pending.set(chatKey, state);
  }
  return state;
}

/**
 * 启动时把磁盘上**所有**会话的缓存接回来（不只是"下次有消息的那个会话"）。
 *
 * ⚠️ 为什么必须有这一步：热重载只会在旧实例上跑 setup（新实例），
 *    加载器**不会**调旧实例的 deactivate。于是"改一个字节就丢缓存" ——
 *    旧实例内存里没落盘的消息，只有 pending.json 里那份还在。
 *    如果只靠"下次这个会话来消息时再 loadPending"，那些消息会一直躺在磁盘上
 *    等下一次对话（甚至永远等不到）。所以启动时就把它们全部接回队列，
 *    交给"到点归档"的定时器正常写出去。
 */
function restoreAllPending() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(dataRoot(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  let restored = 0;
  for (const name of dirs) {
    const m = /^(group|private)_([a-zA-Z0-9]{1,128})$/.exec(name);
    if (!m) continue;
    const chatKey = `${m[1]}:${m[2]}`;
    const before = pending.get(chatKey)?.items.length || 0;
    loadPending(chatKey);
    restored += (pending.get(chatKey)?.items.length || 0) - before;
  }
  if (restored) log(`启动时接回未落盘的消息：共 ${restored} 条（等下一个落盘点写出）`);
}

/** 把缓存里的消息落盘（调用方必须持锁）。 */
function flushPendingLocked(chatKey, reason = 'batch') {
  const state = pending.get(chatKey);
  if (!state || !state.items.length) return { written: 0, skipped: 0 };
  const items = state.items;
  state.items = [];
  state.at = Date.now();
  savePending(chatKey);

  // 只按 seen（= 已经写进归档文件）筛一遍：缓存里的项正常情况下都不在 seen 里，
  // 出现重复只可能来自"手工改过归档"这类外部原因，筛掉是安全的。
  const list = [];
  let skipped = 0;
  for (const it of items) {
    if (seenOf(chatKey).has(it.fp)) { skipped += 1; continue; }
    list.push({ rec: it.e, fp: it.fp, month: monthKeyOf(it.e.ts) });
  }
  const r = writeRecords(chatKey, list, { source: reason });
  return { written: r.written, skipped: skipped + r.skipped };
}

/**
 * 收消息入口：**只进缓存**，等"到点"（archiveIntervalHours）或"空闲"（archiveIdleFlushSec）
 * 或停用时才写磁盘。
 *
 * ⚠️ 这里刻意不判断"够多少条了"：2.0 的落盘节奏由**时间**决定（用户要求每 4 小时一次），
 *    与条数无关。缓存满了（PENDING_HARD_CAP）才强制落盘，防内存被打爆。
 */
function queueAppend(chatKey, entries, meta = {}) {
  const prev = queues.get(chatKey) || Promise.resolve();
  const next = prev
    .then(() => {
      if (!isOn() || !chatDirOf(chatKey)) return;
      // ⚠️ .index 目录必须先建：这条路径不会碰 writeRecords，第一次会话时
      //    这个目录可能还不存在，pending.json 会写失败（缓存等于没生效）。
      if (!ensureDir(path.join(chatDirOf(chatKey), '.index'))) return;
      const state = pendingOf(chatKey);
      const buffered = bufferedFingerprints(chatKey);
      const { list, skipped } = prepareEntries(chatKey, entries);
      if (skipped) flushSeen(chatKey);
      let dupInBuffer = 0;
      for (const item of list) {
        // 缓存内去重：同一条消息在这次没落盘之前又来了（重连重放）不该进两份
        if (buffered.has(item.fp)) { dupInBuffer += 1; continue; }
        buffered.add(item.fp);
        state.items.push({ e: item.rec, fp: item.fp });
      }

      let out = { written: 0, skipped: skipped + dupInBuffer };
      // 只有缓存溢出才强制提前落盘
      if (state.items.length >= PENDING_HARD_CAP) {
        const r = flushPendingLocked(chatKey, 'overflow');
        out = { written: r.written, skipped: out.skipped + r.skipped };
      } else {
        state.at = Date.now();
        savePending(chatKey);
      }
      if (out.written) {
        log(`归档落盘（缓存溢出）：${chatKey} +${out.written} 条`);
      }
    })
    .catch((error) => {
      warn(`归档队列出错：${error?.message ?? error}`);
    })
    .finally(() => {
      if (queues.get(chatKey) === next) queues.delete(chatKey);
    });
  queues.set(chatKey, next);
  return next;
}

/**
 * 定时巡检，做两件事：
 *   ① 到点归档 —— 距上次落盘超过 archiveIntervalHours（默认 4 小时）就把**所有会话**
 *      缓存里的消息写盘；
 *   ② 空闲补写 —— 某个会话超过 archiveIdleFlushSec 没新消息也写盘。
 *      没有 ② 的话，"聊完就没人说话"会让消息一直卡在缓存里等下一个 4 小时，
 *      而用户会以为"归档坏了"。
 */
function sweepPending() {
  if (!isOn()) return;
  const now = Date.now();
  const idle = idleFlushMs();
  const due = now - lastIntervalFlushAt >= archiveIntervalMs();

  for (const chatKey of [...pending.keys()]) {
    const state = pending.get(chatKey);
    if (!state || !state.items.length) continue;
    const reason = due ? 'interval' : (now - state.at >= idle ? 'idle' : null);
    if (!reason) continue;
    const prev = queues.get(chatKey) || Promise.resolve();
    const next = prev
      .then(() => {
        const r = flushPendingLocked(chatKey, reason);
        if (r.written) {
          log(reason === 'interval' ? `到点归档：${chatKey} +${r.written} 条` : `空闲补写：${chatKey} +${r.written} 条`);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (queues.get(chatKey) === next) queues.delete(chatKey);
      });
    queues.set(chatKey, next);
  }
  if (due) lastIntervalFlushAt = now;
}

// ─────────────────────────────────────────────── 归档写入队列（按会话串行）

const queues = new Map();   // chatKey -> Promise

// ─────────────────────────────────────────────── 归档统计（stats.json）

const statsCache = new Map();   // chatKey -> {size, mtimeMs, data}

const EMPTY_STATS = () => ({ total: 0, moods: 0, first: 0, last: 0, byMonth: {}, bySender: {} });

function statsOf(chatKey) {
  const file = indexPath(chatKey, 'stats.json');
  if (!file) return EMPTY_STATS();
  try {
    const st = fs.statSync(file);
    const cached = statsCache.get(chatKey);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.data;
    const raw = readJson(file, null);
    const data = (raw && typeof raw === 'object')
      ? {
        total: Number(raw.total) || 0,
        moods: Number(raw.moods) || 0,
        first: Number(raw.first) || 0,
        last: Number(raw.last) || 0,
        byMonth: (raw.byMonth && typeof raw.byMonth === 'object') ? raw.byMonth : {},
        bySender: (raw.bySender && typeof raw.bySender === 'object') ? raw.bySender : {}
      }
      : EMPTY_STATS();
    statsCache.set(chatKey, { size: st.size, mtimeMs: st.mtimeMs, data });
    return data;
  } catch {
    return EMPTY_STATS();
  }
}

/**
 * 增量更新统计（消息条数 / 心绪条数 / 日期跨度 / 每月条数 / 最活跃的人）。
 *
 * ⚠️ 不做全量重扫：归档可能几十万条，每写一条就重扫会把主流程拖死。
 * ⚠️ 不用 Math.min(...arr) 这种展开写法：补历史时一次几千条会把调用栈打爆。
 * bySender 只留前 40 个（概览只需要知道"谁最活跃"，长尾没意义）。
 *
 * @param {object} opts
 *   timestamps  本批消息的时间戳（用于条数/跨度/每月）
 *   recs        本批消息记录（用于"谁最活跃"；不传就只有条数，不更新人）
 *   moods       新增的心绪记录条数
 */
function bumpStats(chatKey, { moods = 0, timestamps = [], recs = [] } = {}) {
  const file = indexPath(chatKey, 'stats.json');
  if (!file || (!timestamps.length && !moods)) return;
  try {
    const s = statsOf(chatKey);
    const byMonth = { ...s.byMonth };
    const bySender = { ...s.bySender };
    let first = s.first || 0;
    let last = s.last || 0;

    for (const ts of timestamps) {
      if (!first || ts < first) first = ts;
      if (ts > last) last = ts;
      const m = monthKeyOf(ts);
      byMonth[m] = (byMonth[m] || 0) + 1;
    }

    for (const r of recs) {
      const key = r.self ? '我' : (clean(r.senderName, 30) || clean(r.senderId, 20) || '未知');
      const prev = bySender[key] || { n: 0, last: 0, sid: r.senderId };
      bySender[key] = {
        n: (prev.n || 0) + 1,
        last: Math.max(prev.last || 0, r.ts),
        sid: prev.sid || r.senderId
      };
    }
    const top = Object.entries(bySender)
      .sort((a, b) => (b[1].n || 0) - (a[1].n || 0))
      .slice(0, 40);

    statsCache.delete(chatKey);
    writeJsonAtomic(file, {
      total: s.total + timestamps.length,
      moods: s.moods + moods,
      first,
      last,
      byMonth,
      bySender: Object.fromEntries(top)
    });
  } catch (error) {
    warn(`更新归档统计失败：${error?.message ?? error}`);
  }
}

// ─────────────────────────────────────────────── 检索：读索引

const compactCache = new Map();   // file -> {offset, rows, at}

/**
 * 读紧凑索引。**增量读**：文件只会被追加，所以记住上次读到的字节偏移，
 * 下次只读新增的那一段，然后拼到已有数组后面。
 *
 * 为什么必须这么做：一条消息一行，几万条就是几 MB；每次检索都从头 JSON.parse
 * 一遍，在很长的会话里会把回复拖慢到肉眼可见。
 */
function readCompact(file) {
  const cached = compactCache.get(file);
  // indexRefreshMs 内直接复用：避免同一轮对话里连续检索反复 stat + 读尾部。
  // 想让"刚发的消息"立刻可检索，把这个值调小（甚至 0）即可。
  const ttl = num(cfg().indexRefreshMs, DEFAULTS.indexRefreshMs, 0, 60000);
  if (cached && ttl > 0 && Date.now() - cached.at < ttl) return cached.rows;

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return cached ? cached.rows : [];
  }
  const size = st.size;
  if (cached && size === cached.offset) {
    cached.at = Date.now();
    return cached.rows;
  }

  let offset = 0;
  let rows = [];
  let fd = null;
  try {
    const full = !cached || size < cached.offset;
    if (!full) {
      offset = cached.offset;
      rows = cached.rows;
    }
    fd = fs.openSync(file, 'r');
    const length = size - offset;
    if (length > 0) {
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, offset);
      const chunk = buf.toString('utf8', 0, read);
      const lines = chunk.split('\n');
      // 最后一段可能是不完整的行（文件正在被写入）——留到下次再解析
      const complete = chunk.endsWith('\n') ? lines : lines.slice(0, -1);
      for (const line of complete) {
        if (!line) continue;
        try {
          const o = JSON.parse(line);
          if (o && Number.isFinite(Number(o.t))) {
            rows.push({
              t: Number(o.t),
              sid: String(o.sid ?? ''),
              sn: String(o.sn ?? ''),
              self: o.self === 1 || o.self === true,
              text: String(o.text ?? '')
            });
          }
        } catch { /* 半截行忽略 */ }
      }
      offset = chunk.endsWith('\n')
        ? size
        : size - Buffer.byteLength(lines[lines.length - 1] || '', 'utf8');
    } else {
      offset = size;
    }
    if (rows.length > MAX_SCAN_LINES * 4) rows = rows.slice(rows.length - MAX_SCAN_LINES * 4);
    compactCache.set(file, { offset, rows, at: Date.now() });
    return rows;
  } catch {
    return cached ? cached.rows : [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 归档月份文件列表（升序）。 */
function monthFiles(chatKey) {
  const dir = chatDirOf(chatKey);
  if (!dir) return [];
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => ({ month: f.slice(0, 7), file: path.join(dir, f) }));
  } catch {
    return [];
  }
}

/** 完整归档文件缓存（按 size+mtime 失效）——只在没开紧凑索引时用到。 */
const archiveFileCache = new Map();   // file -> {size, mtimeMs, rows}

function readArchiveFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const cached = archiveFileCache.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.rows;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o && Number.isFinite(Number(o.t))) {
          rows.push({
            t: Number(o.t),
            sid: String(o.sid ?? ''),
            sn: String(o.sn ?? ''),
            self: o.self === 1 || o.self === true,
            text: String(o.text ?? ''),
            media: Array.isArray(o.media) ? o.media : [],
            reply: String(o.reply ?? '')
          });
        }
      } catch { /* ignore */ }
    }
    archiveFileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, rows });
    return rows;
  } catch {
    return [];
  }
}

/**
 * 取归档的"行"（统一形状），按时间升序。
 * archiveSearchIndex 开着读紧凑索引（小、快）；关掉读完整归档月份文件。
 * 永远只读**当前会话**的目录 —— 不提供跨会话翻别人聊天记录的路径。
 *
 * @param {boolean} includePending 是否把"还在攒批缓存、尚未落盘"的消息也算进来。
 *   检索工具会传 true：否则用户刚说完一句、马上问"你记得我刚才说的吗"，
 *   归档里还没有它（要等凑满一批或空闲补写），模型会答"没找到" —— 那是假否定。
 */
function loadRows(chatKey, { from = null, to = null, includePending = false } = {}) {
  const months = monthFiles(chatKey);
  const out = [];

  const useCompact = cfg().archiveSearchIndex !== false;

  if (months.length) {
    if (useCompact) {
      // 紧凑索引是**整会话一份**（不是按月一份），所以只读一次、读全部，
      // 再用时间范围过滤 —— 逐个"月 × 全索引"扫是 O(月数 × 条数)，会白烧 CPU。
      const rows = readCompact(path.join(chatDirOf(chatKey), '.index', 'compact.jsonl'));
      const firstMonth = months[0].month;
      const lastMonth = months[months.length - 1].month;
      for (const r of rows) {
        const m = monthKeyOf(r.t);
        if (m < firstMonth || m > lastMonth) continue;   // 索引里残留了已删除月份的数据
        if (from !== null && r.t < from) continue;
        if (to !== null && r.t > to) continue;
        out.push(r);
      }
    } else {
      for (const { month, file } of months) {
        if (from !== null && month < monthKeyOf(from)) continue;
        if (to !== null && month > monthKeyOf(to)) continue;
        for (const r of readArchiveFile(file)) {
          if (from !== null && r.t < from) continue;
          if (to !== null && r.t > to) continue;
          out.push(r);
        }
      }
    }
  }

  // 未落盘的缓存消息一并纳入（数据形状与归档行一致，检索/渲染不用分叉）
  if (includePending) {
    loadPending(chatKey);
    for (const it of pending.get(chatKey)?.items || []) {
      const r = it.e;
      if (!r) continue;
      if (from !== null && r.ts < from) continue;
      if (to !== null && r.ts > to) continue;
      out.push({
        t: r.ts,
        sid: r.senderId,
        sn: r.senderName,
        self: r.self,
        text: r.text,
        media: r.media || [],
        reply: r.reply || '',
        pending: true
      });
    }
  }

  if (!out.length) return [];
  out.sort((a, b) => a.t - b.t);
  // 同一条消息可能因 mid 为空而重复（指纹不同）——这里按 时间+人+文本 再兜一次
  const seen = new Set();
  const deduped = [];
  for (const r of out) {
    const key = `${r.t}|${r.sid}|${r.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped;
}

function invalidateCaches(chatKey) {
  const dir = chatDirOf(chatKey);
  if (!dir) return;
  // 归档刚被追加：把两个派生缓存都清掉，保证下一次检索看到最新内容
  compactCache.delete(path.join(dir, '.index', 'compact.jsonl'));
  try {
    for (const { file } of monthFiles(chatKey)) archiveFileCache.delete(file);
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────── 心绪：状态存储（自带实现）
//
// 这一节把 inner-life 那套机制复刻进来（情绪基调 + 还没想完挂在心里的事），
// 但存储归本技能自己管：<DATA_DIR>/private-chat-archive/mood/<会话>.json
//
// 与 inner-life 的机制差异（刻意的）：
//   · 恢复状态时**不回写**过期内容（inner-life 的 prune 会顺手写回）。
//     读取方（注入 / 归档）不该产生副作用，否则"看过一眼"就改了数据。
//   · 归档时间戳 recordedAt 由本技能维护，这样 after-response 能判断
//     "本轮的快照是不是已经存过了"，不必每轮都读一遍 mood.jsonl。

/** 空状态。`cold` = 从没记过心绪（用来区分"没记过"和"记过又被清空"）。 */
function emptyMoodState() {
  return { mood: '', moodAt: 0, topics: [], updatedAt: 0, archivedAt: 0, archivedKey: '', cold: true };
}

/** 心绪机制整体开着吗（关了就连 mind_note 工具都不该出现）。 */
function moodOn() {
  return cfg().moodEnabled !== false;
}

/** 心绪**归档**开着吗（机制开着但不归档也是允许的）。 */
function moodArchiveOn() {
  return moodOn() && cfg().moodArchive !== false && cfg().moodArchiveWhen !== 'off';
}

/** 心绪快照文件（每个会话一份，纯追加 JSONL）。 */
function moodFile(chatKey) {
  const dir = chatDirOf(chatKey);
  return dir ? path.join(dir, 'mood.jsonl') : '';
}

function topicTtlMs() {
  return num(cfg().topicTtlHours, DEFAULTS.topicTtlHours, 1, 720) * 3600000;
}

function moodTtlMs() {
  return num(cfg().moodTtlHours, DEFAULTS.moodTtlHours, 1, 720) * 3600000;
}

function maxTopics() {
  return num(cfg().maxTopics, DEFAULTS.maxTopics, 1, 20);
}

/** 心绪状态文件路径。 */
function moodStateFile(chatKey) {
  const safe = String(chatKey || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_default';
  return path.join(moodStateDir(), `${safe}.json`);
}

/** 读原始状态（不 prune、不写盘，坏文件一律当空）。 */
function readMoodStateRaw(chatKey) {
  const raw = readJson(moodStateFile(chatKey), null);
  if (!raw || typeof raw !== 'object') return emptyMoodState();
  return {
    mood: typeof raw.mood === 'string' ? raw.mood : '',
    moodAt: Number(raw.moodAt) || 0,
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    updatedAt: Number(raw.updatedAt) || 0,
    archivedAt: Number(raw.archivedAt) || 0,
    archivedKey: String(raw.archivedKey || ''),
    cold: false
  };
}

/**
 * 归一化：去空白、去标点/符号，只留文字数字（大小写折叠）。
 * 与 inner-life 的 normalizeTopic 同规则 —— 近重复合并靠它。
 */
function normalizeTopic(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/**
 * 两条心事是不是"同一件"：
 *   · 归一化后完全相等 → 是；
 *   · 一方包含另一方，且短的那条 ≥6 字、占长句的 ≥50% → 是。
 * 6 字下限与 50% 比例是保守闸门：不把"吃饭了"和"吃饭了没"误并成一件。
 */
function isSameTopic(a, b) {
  const x = normalizeTopic(a);
  const y = normalizeTopic(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 6) return false;
  return long.includes(short) && short.length / long.length >= 0.5;
}

/**
 * 把近似重复的心事并成一条：文本留"信息更多"的说法，时间按最早排队、
 * 触碰时间按最新续期。纯函数，不改入参。
 */
function mergeTopics(topics) {
  const out = [];
  for (const t of Array.isArray(topics) ? topics : []) {
    const text = clean(t?.text, TOPIC_TEXT_MAX);
    if (!text) continue;
    const at = Number(t?.at) || 0;
    const touchedAt = Number(t?.touchedAt) || at;
    const hit = out.find((o) => isSameTopic(o.text, text));
    if (!hit) {
      out.push({ id: t?.id, text, at, touchedAt });
      continue;
    }
    if (normalizeTopic(text).length > normalizeTopic(hit.text).length) hit.text = text;
    hit.at = hit.at ? Math.min(hit.at, at || hit.at) : at;
    hit.touchedAt = Math.max(hit.touchedAt, touchedAt);
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/**
 * 整理状态：情绪超时清空、心事超时删除、近重复合并、裁剪到容量上限。
 * ⚠️ 只清理**返回值**，不落盘 —— 读取方（注入、归档）不该有副作用。
 * ⚠️ 过期口径用"最近一次触碰"（touchedAt）而不是创建时间：
 *    她还在惦记的事不该在她还想着的时候淡忘。
 */
function pruneMoodState(state, now = Date.now()) {
  const moodTtl = moodTtlMs();
  const topicTtl = topicTtlMs();
  const moodFresh = (now - (Number(state?.moodAt) || 0)) <= moodTtl;
  const mood = moodFresh ? clean(state?.mood, MOOD_TEXT_MAX) : '';
  const topics = mergeTopics(state?.topics)
    .filter((t) => (now - (Number(t?.touchedAt) || Number(t?.at) || 0)) <= topicTtl)
    .slice(-maxTopics());
  return {
    mood,
    moodAt: mood ? (Number(state?.moodAt) || now) : 0,
    topics,
    updatedAt: Number(state?.updatedAt) || 0,
    archivedAt: Number(state?.archivedAt) || 0,
    archivedKey: String(state?.archivedKey || ''),
    cold: state?.cold === true
  };
}

/** 读 + 整理（最常用的入口）。 */
function loadMoodState(chatKey) {
  return pruneMoodState(readMoodStateRaw(chatKey));
}

/** 原子写状态。 */
function saveMoodState(chatKey, state) {
  if (!ensureDir(moodStateDir())) return false;
  return writeJsonAtomic(moodStateFile(chatKey), {
    mood: state.mood,
    moodAt: state.moodAt,
    topics: state.topics,
    updatedAt: state.updatedAt,
    archivedAt: state.archivedAt,
    archivedKey: state.archivedKey
  });
}

/** 快照的内容键：情绪 + 心事集合。值不变就不重复归档。 */
function moodKeyOf(state) {
  const mood = clean(state?.mood, MOOD_TEXT_MAX);
  const topics = (state?.topics || [])
    .map((t) => normalizeTopic(t?.text))
    .filter(Boolean)
    .sort()
    .join('|');
  return `${mood}||${topics}`;
}

/** 状态是否为空（没情绪也没心事）。 */
function moodIsEmpty(state) {
  return !clean(state?.mood, MOOD_TEXT_MAX) && !(state?.topics || []).length;
}

/** 写心绪的工具实现：情绪/心事有变化才记，同一件事换个说法只续期。 */
function applyMindNote(chatKey, args = {}) {
  const now = Date.now();
  const before = pruneMoodState(readMoodStateRaw(chatKey), now);
  const state = {
    mood: before.mood,
    moodAt: before.moodAt,
    topics: before.topics.map((t) => ({ ...t })),
    updatedAt: before.updatedAt,
    archivedAt: before.archivedAt,
    archivedKey: before.archivedKey,
    cold: before.cold
  };

  let moodChanged = false;
  if (typeof args?.mood === 'string' && args.mood.trim()) {
    const next = clean(args.mood, MOOD_TEXT_MAX);
    if (next && next !== state.mood) {
      state.mood = next;
      state.moodAt = now;
      moodChanged = true;
    } else if (next) {
      // 情绪没变：只续期，避免"每隔几小时就淡忘一次"的假波动
      state.moodAt = now;
    }
  }

  let added = 0;
  let touched = 0;
  if (Array.isArray(args?.topics)) {
    for (const raw of args.topics) {
      const text = clean(raw, TOPIC_TEXT_MAX);
      if (!text) continue;
      const hit = state.topics.find((t) => isSameTopic(t?.text, text));
      if (hit) {
        if (normalizeTopic(text).length > normalizeTopic(hit.text).length) hit.text = text;
        hit.touchedAt = now;
        touched += 1;
        continue;
      }
      state.topics.push({ id: `${now}-${Math.random().toString(36).slice(2, 7)}`, text, at: now, touchedAt: now });
      added += 1;
    }
  }

  state.topics = mergeTopics(state.topics).slice(-maxTopics());
  state.updatedAt = now;
  saveMoodState(chatKey, state);

  const saved = pruneMoodState(state, now);
  const list = saved.topics.length ? `；挂着的事：${saved.topics.map((t) => t.text).join('；')}` : '';
  const tail = added === 0 && touched > 0 ? '（同一件事，只更新了时间，没多记）' : '';
  // 把"上次归档时间"一并告诉模型：下次它在别处问起时，才知道自己可能"忘了中间那段"
  const arch = saved.archivedAt
    ? `上次归档：${timeLabel(saved.archivedAt)}（那之前的都存进长期归档了）`
    : '还没有归档过心绪';
  return { moodChanged, added, touched, state: saved, text: `已记下心绪${saved.mood ? `：${saved.mood}` : ''}${list}${tail}。${arch}` };
}

/** 放下心事 / 更新情绪。 */
function applyMindSettle(chatKey, args = {}) {
  const now = Date.now();
  const before = pruneMoodState(readMoodStateRaw(chatKey), now);
  const state = {
    mood: before.mood,
    moodAt: before.moodAt,
    topics: before.topics.map((t) => ({ ...t })),
    updatedAt: before.updatedAt,
    archivedAt: before.archivedAt,
    archivedKey: before.archivedKey,
    cold: before.cold
  };

  const kw = clean(args?.keyword, TOPIC_TEXT_MAX);
  let removed = 0;
  if (kw) {
    // 归一化匹配：传关键词的一部分也能命中（标点、前缀不再挡路），
    // 比如传「煮粥」能命中「说好明天煮粥时喂猫」。
    const nk = normalizeTopic(kw) || kw;
    state.topics = state.topics.filter((t) => {
      const nt = normalizeTopic(t?.text);
      if (nt && (nt.includes(nk) || nk.includes(nt))) { removed += 1; return false; }
      return true;
    });
  } else {
    removed = state.topics.length;
    state.topics = [];
  }
  if (typeof args?.mood === 'string' && args.mood.trim()) {
    state.mood = clean(args.mood, MOOD_TEXT_MAX);
    state.moodAt = now;
  }
  state.updatedAt = now;
  state.topics = mergeTopics(state.topics).slice(-maxTopics());
  saveMoodState(chatKey, state);
  return { removed, state: pruneMoodState(state, now) };
}

/**
 * 心绪注入片段（复刻 inner-life 的 promptSections 机制）。
 *
 * ⚠️ 没有心绪时返回 null / 空数组 —— 不注入就不花 token。
 * ⚠️ 内容每轮都可能变（心绪会变），所以它天然会破坏前缀缓存；
 *    这是这套机制的固有代价，能做的只是**保持简短**。
 */
export function promptSections(context = {}) {
  const archiveSections = archivePromptSections(context);
  const out = archiveSections ? [archiveSections] : [];
  try {
    if (!isOn() || !moodOn() || cfg().moodInject === false) return out;
    const chatKey = context?.chatKey;
    if (!chatKindOf(chatKey)) return out;
    const state = loadMoodState(chatKey);
    if (moodIsEmpty(state)) return out;
    const lines = [];
    if (state.mood) lines.push(`· 情绪：${state.mood}`);
    if (state.topics.length) {
      lines.push('· 还没想完、挂在心里的事：');
      for (const t of state.topics) lines.push(`  - ${t.text}`);
    }
    out.push({
      id: 'private-chat-archive-heart',
      title: '你此刻的心绪',
      priority: 50,
      content: '【你此刻的心绪（上一轮结束时你自己记下的）】\n'
        + lines.join('\n')
        + '\n（先感受此刻真实的自己：现在还是这样，就接着它；已经变了，就用 private-chat-archive__mind_note 更新；'
        + '想通了，就用 private-chat-archive__mind_settle 放下。别让上一轮的情绪绑住现在的你。）'
    });
  } catch { /* 注入失败不能影响主流程 */ }
  return out;
}

function readMoodRecords(chatKey) {
  const file = moodFile(chatKey);
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o && Number.isFinite(Number(o.t))) {
          out.push({
            t: Number(o.t),
            // kind 是后来加的（v1.1）。老记录没有这个字段，按 changed/seen 推断，
            // 否则历史心绪会在检索结果里显示成"变化"以外的空白分类。
            kind: String(o.kind ?? (o.seen === 1 ? 'seen' : (o.changed === 0 ? 'seen' : 'change'))),
            mood: String(o.mood ?? ''),
            moodAt: Number(o.moodAt) || 0,
            topics: Array.isArray(o.topics) ? o.topics.map(String) : [],
            changed: o.changed !== 0,
            seen: o.seen === 1,
            by: String(o.by ?? ''),
            mfrom: Number(o.mfrom) || 0,
            mto: Number(o.mto) || 0,
            mcount: Number(o.mcount) || 0
          });
        }
      } catch { /* ignore */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** 追加一条心绪记录（纯追加，与消息归档同构）。 */
function writeMoodRecord(chatKey, rec) {
  const file = moodFile(chatKey);
  if (!file) return false;
  const dir = chatDirOf(chatKey);
  if (!ensureDir(dir)) return false;
  try {
    appendLine(file, JSON.stringify({
      t: rec.t,
      kind: rec.kind || 'change',
      mood: rec.mood,
      moodAt: rec.moodAt,
      topics: rec.topics,
      changed: rec.changed ? 1 : 0,
      seen: rec.seen ? 1 : 0,
      by: rec.by,
      mfrom: rec.mfrom,
      mto: rec.mto,
      mcount: rec.mcount
    }));
    bumpStats(chatKey, { moods: 1 });
    return true;
  } catch (error) {
    warn(`心绪归档写入失败：${error?.message ?? error}`);
    return false;
  }
}

/** 上一轮的归档起点（用于把心绪挂到"这批消息"上）。 */
const runStart = new Map();   // chatKey -> 归档条数

function archiveCountOf(chatKey) {
  return statsOf(chatKey).total;
}

/**
 * after-response 钩子：把**本轮结束时**的心绪快照归档。
 *
 * 时机是这里而不是 before-context：见文件头"时序陷阱"。
 * 模式（设置项 moodArchiveWhen）：
 *   change（默认）—— 心绪值变了才写一条完整快照；没变只留一个极小的 seen 标记，
 *                    这样能回答"这段时间它想过几次这件事"，又不必存重复内容。
 *   always        —— 每轮都写一条完整快照。
 *   off           —— 不归档心绪。
 *
 * ⚠️ 判断"变没变"用的是**状态文件里记的 archivedKey**（上次归档内容的指纹），
 *    而不是"再读一遍 mood.jsonl 的最后一条"。后者每次回复都要读磁盘 + 解析，
 *    在长会话里是纯浪费；前者是 O(1)。
 */
function onAfterResponse(ctx = {}) {
  try {
    if (!isOn() || !moodArchiveOn()) return;
    const chatKey = ctx?.chatKey;
    const kind = chatKindOf(chatKey);
    if (!kind) return;
    if (scopeOf() === 'private' && kind !== 'private') return;

    const prev = queues.get(chatKey) || Promise.resolve();
    const next = prev
      .then(() => {
        if (!ensureDir(chatDirOf(chatKey))) return;
        const state = loadMoodState(chatKey);
        const empty = moodIsEmpty(state);

        // 什么都没记过、也没内容 → 这个会话根本没在用这套机制，别刷记录
        if (empty && !state.archivedAt && state.cold) return;

        const key = moodKeyOf(state);
        const changed = empty
          ? Boolean(state.archivedAt) && Boolean(state.archivedKey.replace(/\|/g, ''))  // 从有到无 = 清空
          : key !== state.archivedKey;

        const mkRec = (kindName, changedFlag) => ({
          t: Date.now(),
          kind: kindName,
          mood: state.mood,
          moodAt: state.moodAt,
          topics: state.topics.map((t) => clean(t.text, TOPIC_TEXT_MAX)).filter(Boolean),
          changed: changedFlag,
          seen: false,
          by: clean(ctx?.session?.id, 40),
          mfrom: runStart.get(chatKey) || 0,
          mto: archiveCountOf(chatKey),
          mcount: Math.max(0, archiveCountOf(chatKey) - (runStart.get(chatKey) || 0))
        });

        // ① 有实质内容且变了 → 存完整快照
        if (!empty && changed) {
          writeMoodRecord(chatKey, mkRec('change', true));
          state.archivedAt = Date.now();
          state.archivedKey = key;
          state.cold = false;
          saveMoodState(chatKey, state);
          log(`心绪已归档：${chatKey} mood=${state.mood || '（无）'} topics=${state.topics.length}`);
          return;
        }
        // ② 本来有心绪、现在被 TTL 清空了（或想通了）→ 记一次"清空"，
        //    让时间线上的"那件事后来怎么样了"能对上
        if (empty && changed) {
          writeMoodRecord(chatKey, mkRec('settle', true));
          state.archivedAt = Date.now();
          state.archivedKey = '';
          saveMoodState(chatKey, state);
          log(`心绪已清空（过期或想通了）：${chatKey}`);
          return;
        }
        // ③ 内容没变：change 模式只留一个极小的 seen 标记（用于统计次数）
        if (cfg().moodArchiveWhen !== 'always') {
          if (!empty) {
            writeMoodRecord(chatKey, {
              t: Date.now(), kind: 'seen', mood: '', moodAt: 0, topics: [],
              changed: false, seen: true, by: clean(ctx?.session?.id, 40)
            });
          }
          return;
        }
        // ④ always 模式：每轮都存一条完整快照
        writeMoodRecord(chatKey, mkRec('snapshot', changed));
        state.archivedAt = Date.now();
        state.archivedKey = key;
        saveMoodState(chatKey, state);
      })
      .catch((error) => {
        warn(`心绪归档出错：${error?.message ?? error}`);
      })
      .finally(() => {
        if (queues.get(chatKey) === next) queues.delete(chatKey);
      });
    queues.set(chatKey, next);
  } catch (error) {
    warn(`心绪钩子出错：${error?.message ?? error}`);
  }
}

// ─────────────────────────────────────────────── 检索：渲染

function labelOf(row) {
  if (row.self) return '我';
  const name = clean(row.sn, 40) || '未知';
  return row.sid && row.sid !== 'self' ? `${name}(${row.sid})` : name;
}

function renderRow(row) {
  const media = Array.isArray(row.media) && row.media.length ? ` [${row.media.join('/')}]` : '';
  const reply = row.reply ? ` ↩「${clean(row.reply, 40)}」` : '';
  // 缓存里还没落盘的消息：明确标出来，免得模型以为"归档里只存了这些"
  const pend = row.pending ? '（刚收到，还在攒批）' : '';
  return `[${timeLabel(row.t)}] ${labelOf(row)}: ${clean(row.text, textCap())}${media}${reply}${pend}`;
}

/** 命中 + 前后上下文 → 渲染成带"命中标记"的多行块。 */
function renderWindow(rows, hitIndex, window) {
  const lo = Math.max(0, hitIndex - window);
  const hi = Math.min(rows.length - 1, hitIndex + window);
  const lines = [];
  for (let i = lo; i <= hi; i += 1) {
    lines.push(`${i === hitIndex ? '▶ ' : '  '}${renderRow(rows[i])}`);
  }
  return lines.join('\n');
}

/** 心绪快照 → 一行渲染。 */
function renderMoodLine(rec, { withTopics = true } = {}) {
  if (rec.seen || rec.kind === 'seen') {
    return `${timeLabel(rec.t)} 心绪没有变化（还是上面那条）`;
  }
  if (rec.kind === 'settle') {
    return `${timeLabel(rec.t)} 心绪清空了（之前挂着的事想通了，或者放太久淡忘了）`;
  }
  const mood = rec.mood ? `心绪：${rec.mood}` : '心绪：只有挂心事、没记情绪';
  const head = `${timeLabel(rec.t)} ${mood}`;
  const topics = withTopics && rec.topics.length ? `｜挂心事：${rec.topics.join('；')}` : '';
  const span = rec.mcount ? `（那轮存了 ${rec.mcount} 条消息）` : '';
  return head + topics + span;
}

/** 把心绪记录按天分组（新的在前）。 */
function moodByDay(records) {
  const map = new Map();
  for (const r of records) {
    const d = dayKeyOf(r.t);
    const arr = map.get(d) || [];
    arr.push(r);
    map.set(d, arr);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

// ─────────────────────────────────────────────── 工具：search_archive

function doSearch(ctx, args = {}) {
  const chatKey = ctx?.chatKey;
  const guard = scopeGuard(chatKey);
  if (guard) return guard;

  const all = loadRows(chatKey, { includePending: true });
  if (!all.length) return noDataText(chatKey);

  const from = args.from ? startOfDay(args.from) : null;
  const to = args.to ? endOfDay(args.to) : null;
  if (args.from && from === null) return errText(`from 日期格式不对：${args.from}（要 YYYY-MM-DD）`);
  if (args.to && to === null) return errText(`to 日期格式不对：${args.to}（要 YYYY-MM-DD）`);

  const sender = clean(args.sender, 40);
  const keyword = clean(args.keyword, 60);
  const want = num(args.limit, num(cfg().maxHits, DEFAULTS.maxHits, 1, 200), 1,
    num(cfg().maxHitsHardLimit, DEFAULTS.maxHitsHardLimit, 1, 200));
  const window = num(cfg().contextWindow, DEFAULTS.contextWindow, 0, 5);

  const scoped = all.filter((r) => {
    if (from !== null && r.t < from) return false;
    if (to !== null && r.t > to) return false;
    if (sender) {
      const hay = `${r.sn} ${r.sid}`.toLowerCase();
      if (!hay.includes(sender.toLowerCase())) return false;
    }
    return true;
  });

  if (!scoped.length) {
    return okText([
      `在指定范围里没有归档消息${sender ? `（我按「${sender}」筛了人）` : ''}。`,
      `该会话归档总条数：${all.length} 条（${dayKeyOf(all[0].t)} ~ ${dayKeyOf(all[all.length - 1].t)}）。`,
      '可以把人或者时间范围放宽一点再试。'
    ].join('\n'));
  }

  // 先按整串找；找不到再拆词（空格分隔）按"全部词都出现"找。
  let matcher = null;
  let matchNote = '';
  if (keyword) {
    const lower = keyword.toLowerCase();
    const exact = scoped.filter((r) => r.text.toLowerCase().includes(lower));
    if (exact.length) {
      matcher = (r) => r.text.toLowerCase().includes(lower);
    } else {
      const tokens = lower.split(/\s+/).filter(Boolean);
      if (tokens.length > 1) {
        matcher = (r) => {
          const t = r.text.toLowerCase();
          return tokens.every((k) => t.includes(k));
        };
        matchNote = `（没找到整句「${keyword}」，改为要求每个词都出现）`;
      } else {
        matcher = (r) => r.text.toLowerCase().includes(lower);
      }
    }
  }

  const hits = [];
  let totalHit = 0;
  for (let i = 0; i < scoped.length; i += 1) {
    // 先算总数（模型需要知道"还有多少没显示"才知道要不要换关键词），再取前 want 条
    if (matcher && !matcher(scoped[i])) continue;
    totalHit += 1;
    if (hits.length < want) hits.push(i);
  }

  if (!hits.length) {
    return okText([
      keyword ? `归档里没有找到「${keyword}」。` : '按这个筛选条件没有捞到任何归档消息。',
      `已检索范围：${dayKeyOf(scoped[0].t)} ~ ${dayKeyOf(scoped[scoped.length - 1].t)}，共 ${scoped.length} 条。`,
      '可以换个更短的关键词、去掉 sender/时间限制，或者先用 archive_overview 看看到底存了哪段时间。'
    ].join('\n'));
  }

  // 输出预算：上下文窗口会让条数翻好几倍，超过预算就少给几块，
  // 否则一次检索可能往模型上下文里灌进几万字（又贵又容易被截断）。
  const blocks = [];
  let budget = 20000;
  for (const idx of hits) {
    const block = renderWindow(scoped, idx, window);
    if (blocks.length && block.length > budget) break;
    budget -= block.length;
    blocks.push(block);
  }

  const head = [
    keyword
      ? `关键词「${keyword}」命中 ${totalHit} 条，下面给出最近 ${blocks.length} 条`
        + `${window > 0 ? `（每条带前后各 ${window} 条上下文，▶ 是命中那条）` : ''}${matchNote}：`
      : `按条件筛出 ${totalHit} 条${sender ? `（人=「${sender}」）` : ''}，下面给出最近 ${blocks.length} 条`
        + `${window > 0 ? `（每条带前后各 ${window} 条上下文，▶ 是命中那条）` : ''}：`
  ];
  if (totalHit > blocks.length) {
    head.push(`⚠️ 结果被截断：还有 ${totalHit - blocks.length} 条没显示。`
      + '要更多就换更具体的关键词、缩小 from/to，或者把 limit 调大（上限 '
      + `${num(cfg().maxHitsHardLimit, DEFAULTS.maxHitsHardLimit, 1, 200)}）。`);
  }
  return okText([...head, '', ...blocks].join('\n\n'));
}

// ─────────────────────────────────────────────── 工具：query_by_date

function doByDate(ctx, args = {}) {
  const chatKey = ctx?.chatKey;
  const guard = scopeGuard(chatKey);
  if (guard) return guard;

  const all = loadRows(chatKey, { includePending: true });
  if (!all.length) return noDataText(chatKey);

  let from = args.from ? startOfDay(args.from) : null;
  let to = args.to ? endOfDay(args.to) : null;
  if (args.from && from === null) return errText(`from 日期格式不对：${args.from}（要 YYYY-MM-DD）`);
  if (args.to && to === null) return errText(`to 日期格式不对：${args.to}（要 YYYY-MM-DD）`);
  if (from === null && to === null) {
    // 没给范围：默认最近 7 天（"上周聊了什么"是最常见的问法）
    to = Date.now();
    from = to - 7 * 86400000;
  } else if (from === null) {
    from = to - 7 * 86400000;
  } else if (to === null) {
    to = Math.min(Date.now(), from + 7 * 86400000);
  }

  const sender = clean(args.sender, 40);
  const scoped = all.filter((r) => {
    if (r.t < from || r.t > to) return false;
    if (sender) {
      const hay = `${r.sn} ${r.sid}`.toLowerCase();
      if (!hay.includes(sender.toLowerCase())) return false;
    }
    return true;
  });

  const withMood = moodOn() && args.withMood !== false;
  const moods = withMood ? readMoodRecords(chatKey).filter((r) => r.t >= from && r.t <= to && !r.seen) : [];

  if (!scoped.length && !moods.length) {
    return okText([
      `这段时间（${dayKeyOf(from)} ~ ${dayKeyOf(to)}）没有归档消息${sender ? `（按「${sender}」筛人后）` : ''}。`,
      `该会话归档总条数 ${all.length} 条，跨度 ${dayKeyOf(all[0].t)} ~ ${dayKeyOf(all[all.length - 1].t)}。`
    ].join('\n'));
  }

  const sample = num(cfg().overviewSample, DEFAULTS.overviewSample, 1, 10);
  const byDay = new Map();
  for (const r of scoped) {
    const d = dayKeyOf(r.t);
    const arr = byDay.get(d) || [];
    arr.push(r);
    byDay.set(d, arr);
  }
  const moodByDayMap = new Map();
  for (const m of moods) {
    const d = dayKeyOf(m.t);
    const arr = moodByDayMap.get(d) || [];
    arr.push(m);
    moodByDayMap.set(d, arr);
  }

  const dayKeys = [...new Set([...byDay.keys(), ...moodByDayMap.keys()])].sort().reverse();
  const lines = [
    `${dayKeyOf(from)} ~ ${dayKeyOf(to)} 期间共 ${scoped.length} 条消息，分布在 ${byDay.size} 天`
      + `${sender ? `（只看「${sender}」）` : ''}`
      + `${moods.length ? `；另有 ${moods.length} 条心绪记录` : ''}。每天最多列 ${sample} 条代表原文：`
  ];
  let shown = 0;
  for (const day of dayKeys) {
    const rows = byDay.get(day) || [];
    const dayMoods = moodByDayMap.get(day) || [];
    lines.push('');
    lines.push(`▸ ${day}（${rows.length} 条消息${dayMoods.length ? `，心绪 ${dayMoods.length} 次` : ''}）`);
    // 采样：**从当天最新往回取**，避免永远只看到"当天最早那几条"
    if (rows.length) {
      const picks = [];
      const step = Math.max(1, Math.floor(rows.length / sample));
      for (let i = rows.length - 1; i >= 0 && picks.length < sample; i -= step) picks.push(rows[i]);
      picks.reverse();
      for (const r of picks) lines.push(`  ${renderRow(r)}`);
      shown += picks.length;
    }
    if (dayMoods.length) {
      lines.push(`  心绪（当天第 1 次 → 最后 1 次）：`);
      lines.push(`    ${renderMoodLine(dayMoods[0])}`);
      if (dayMoods.length > 1) lines.push(`    ${renderMoodLine(dayMoods[dayMoods.length - 1])}`);
    }
  }
  lines.push('');
  lines.push(`（上面只是抽样，共展示 ${shown} 条消息。想看某天的完整内容，用 search_archive 把 from/to 都填成那天，或加上关键词。）`);
  return okText(lines.join('\n'));
}

// ─────────────────────────────────────────────── 工具：archive_overview

function doOverview(ctx) {
  const chatKey = ctx?.chatKey;
  const guard = scopeGuard(chatKey);
  if (guard) return guard;

  const months = monthFiles(chatKey);
  if (!months.length) return noDataText(chatKey);

  const stats = statsOf(chatKey);
  const all = loadRows(chatKey, { includePending: true });
  if (!all.length) return noDataText(chatKey);
  const buffered = (pending.get(chatKey)?.items || []).length;

  const byMonth = {};
  for (const r of all) {
    const m = monthKeyOf(r.t);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  const bySender = {};
  for (const r of all) {
    const k = r.self ? '我' : (clean(r.sn, 30) || clean(r.sid, 20) || '未知');
    bySender[k] = (bySender[k] || 0) + 1;
  }
  const topSender = Object.entries(bySender).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const monthLines = Object.entries(byMonth)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 12)
    .map(([m, n]) => `  ${m}：${n} 条`);

  const everyH = num(cfg().archiveIntervalHours, DEFAULTS.archiveIntervalHours, 1, 168);
  const idleSec = num(cfg().archiveIdleFlushSec, DEFAULTS.archiveIdleFlushSec, 15, 86400);
  const lines = [
    `【归档概览 · 本会话】`,
    `范围设置：${scopeOf() === 'all' ? '私聊 + 群聊' : '仅私聊'}`,
    `落盘节奏：每 ${everyH} 小时写一次磁盘；超过 ${idleSec} 秒没新消息也会先写一次`,
    `消息总条数：${all.length} 条（已落盘 ${stats.total || 0} 条）`
      + `${buffered ? `，另有 ${buffered} 条在缓存里等下一个落盘点（未落盘）` : ''}`,
    `时间跨度：${dayKeyOf(all[0].t)} ~ ${dayKeyOf(all[all.length - 1].t)}`,
    `最近一条：${renderRow(all[all.length - 1])}`
  ];

  // 心绪（本技能自带的心绪机制）
  if (moodOn()) {
    const current = loadMoodState(chatKey);
    if (!moodIsEmpty(current)) {
      lines.push('');
      lines.push(`当前心绪：${current.mood || '（只有挂心事、没记情绪）'}`
        + `${current.topics.length ? `｜挂心事：${current.topics.map((t) => t.text).join('；')}` : ''}`);
    }
    const moods = readMoodRecords(chatKey);
    const real = moods.filter((m) => !m.seen);
    if (real.length) {
      const newest = real[real.length - 1];
      lines.push('');
      lines.push(`心绪归档：共 ${real.length} 次变化（另有 ${moods.length - real.length} 次"未变"标记）`);
      lines.push(`  最近一次：${renderMoodLine(newest)}`);
    } else {
      lines.push('');
      lines.push('心绪归档：已开启，但还没有记录（机器人调用过 mind_note 之后才会出现）。');
    }
  } else {
    lines.push('');
    lines.push('心绪归档：已关闭（可在技能设置里打开「归档心绪」）。');
  }

  lines.push('');
  lines.push(`每月条数（最近的在前）：`);
  lines.push(...monthLines);
  lines.push('');
  lines.push(`发言最多的人：`);
  lines.push(...topSender.map(([name, n]) => `  ${name}：${n} 条`));
  lines.push('');
  lines.push('要查具体内容：search_archive（关键词/人/时间）、query_by_date（按天，可带心绪）、mood_search（只看当时的心绪）。');
  return okText(lines.join('\n'));
}

// ─────────────────────────────────────────────── 工具：mood_search

function doMoodSearch(ctx, args = {}) {
  const chatKey = ctx?.chatKey;
  const guard = scopeGuard(chatKey);
  if (guard) return guard;

  if (!moodOn()) {
    return errText('心绪归档当前是关闭的（技能设置里的「归档心绪」）。聊天记录仍然可以正常检索。');
  }

  const records = readMoodRecords(chatKey);
  const real = records.filter((r) => !r.seen);
  if (!real.length) {
    return okText([
      '还没有归档到任何心绪。',
      '会出现心绪的前提：机器人真的调用过 mind_note（记下此刻的心绪）。'
        + '如果它一直不记，检查设置的「启用心绪机制」有没有被关掉。'
    ].join('\n'));
  }

  const maxDays = num(cfg().moodMaxDays, DEFAULTS.moodMaxDays, 1, 365);
  let from = args.from ? startOfDay(args.from) : null;
  let to = args.to ? endOfDay(args.to) : null;
  if (args.from && from === null) return errText(`from 日期格式不对：${args.from}（要 YYYY-MM-DD）`);
  if (args.to && to === null) return errText(`to 日期格式不对：${args.to}（要 YYYY-MM-DD）`);
  if (from === null && to === null) {
    to = Date.now();
    from = to - maxDays * 86400000;
  } else if (from === null) {
    from = to - maxDays * 86400000;
  } else if (to === null) {
    to = Math.min(Date.now(), from + maxDays * 86400000);
  }

  const keyword = clean(args.keyword, 40);
  const withTopics = args.withTopics !== false && cfg().moodShowTopics !== false;

  let scoped = real.filter((r) => r.t >= from && r.t <= to);
  if (keyword) {
    const kw = keyword.toLowerCase();
    scoped = scoped.filter((r) => {
      const hay = `${r.mood} ${(r.topics || []).join(' ')}`.toLowerCase();
      return hay.includes(kw);
    });
  }

  if (!scoped.length) {
    const span = `${dayKeyOf(real[0].t)} ~ ${dayKeyOf(real[real.length - 1].t)}`;
    return okText([
      keyword ? `心绪记录里没有包含「${keyword}」的。` : `这段时间（${dayKeyOf(from)} ~ ${dayKeyOf(to)}）没有心绪记录。`,
      `心绪归档共 ${real.length} 次变化，跨度 ${span}。`,
      '可以把时间范围放宽，或者去掉关键词。'
    ].join('\n'));
  }

  // 变化次数可能很多：按天分组，每天只给"最早一次 + 最后几次"，
  // 让模型看得到"那天心情怎么变化的"，又不会一次灌进几百行。
  const days = moodByDay(scoped);
  const each = num(args.perDay, 3, 1, 10);
  const lines = [
    `${dayKeyOf(from)} ~ ${dayKeyOf(to)} 共 ${scoped.length} 次心绪变化，分布在 ${days.length} 天`
      + `${keyword ? `（关键词「${keyword}」）` : ''}。有变动的日子在下面列出：`
  ];
  for (const [day, recs] of days.slice(0, 20)) {
    lines.push('');
    lines.push(`▸ ${day}（${recs.length} 次变化）`);
    const picks = recs.length <= each
      ? recs
      : [recs[0], ...recs.slice(-(each - 1))];
    const shownKeys = new Set();
    for (const r of picks) {
      const line = renderMoodLine(r, { withTopics });
      if (shownKeys.has(line)) continue;
      shownKeys.add(line);
      lines.push(`  ${line}`);
    }
  }
  if (days.length > 20) lines.push(`\n（只列了最近 20 天，还有 ${days.length - 20} 天未显示。）`);
  lines.push('');
  lines.push('（这些是**当时真实存下**的心绪；心绪机制本身只保留最近的情绪 24 小时、心事 12 小时，'
    + '过期后连它自己也查不到了，只有这份归档能回溯。）');
  return okText(lines.join('\n'));
}

// ─────────────────────────────────────────────── 工具返回封装

function okText(text) {
  return { content: cleanMultiline(text), isError: false };
}

function errText(text) {
  return { content: cleanMultiline(text), isError: true };
}

/** 只压掉行尾空格与 3 个以上连续空行；正文里的换行要留着（渲染结果靠它）。 */
function cleanMultiline(text) {
  return String(text ?? '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 60000);
}

/** 归档范围闸：scope=private 时群聊里这些工具直接告知不可用（别让模型瞎试）。 */
function scopeGuard(chatKey) {
  const kind = chatKindOf(chatKey);
  if (!kind) return errText('当前会话类型未知，无法访问归档。');
  if (scopeOf() === 'private' && kind === 'group') {
    return errText('本归档只记录私聊（设置里「归档范围」= 仅私聊），群聊里没有可查的内容。'
      + '如果确实需要，可以让管理员把归档范围改成「私聊 + 群聊」。');
  }
  return null;
}

function noDataText(chatKey) {
  const buffered = (pending.get(chatKey)?.items || []).length;
  const everyH = num(cfg().archiveIntervalHours, DEFAULTS.archiveIntervalHours, 1, 168);
  const idleSec = num(cfg().archiveIdleFlushSec, DEFAULTS.archiveIdleFlushSec, 15, 86400);
  const extra = buffered
    ? `当前还有 ${buffered} 条消息在缓存里等下一个落盘点（每 ${everyH} 小时一次），`
      + `但它们**已经能被检索到**，只是还没写进归档文件。`
    : `另外：消息是每 ${everyH} 小时落盘一次，刚聊的内容会先待在缓存里 —— `
      + `超过 ${idleSec} 秒没新消息就会先写一次（期间也能被检索到）。`;
  return okText([
    '这个会话的归档里还没有任何消息。',
    '可能的原因：① 刚装上这个技能，还没收到新消息；② 私聊归档只记录私聊，群聊不记。',
    extra,
    '已有历史会在第一次收到消息时自动补齐。'
  ].filter(Boolean).join('\n'));
}

// ─────────────────────────────────────────────── 钩子：收消息（缓存）+ 补历史

/** 已经补过历史的会话（进程内一次性标记）。 */
const backfilled = new Set();

/**
 * before-context 钩子：把本批新消息收进攒批缓存（或补齐历史）。
 *
 * ⚠️ 绝不 await：钩子在回复主链路上，归档慢一点不该让回复慢一点。
 *    队列内部串行，失败只打日志（归档坏了不能影响聊天）。
 */
function onBeforeContext(ctx = {}) {
  try {
    if (!isOn()) return;
    const chatKey = ctx?.chatKey;
    const store = ctx?.store;
    const kind = chatKindOf(chatKey);
    if (!kind || !store) return;
    if (scopeOf() === 'private' && kind !== 'private') return;

    // 记下本轮开始时的归档位置：after-response 用它算"本轮存了多少条"
    if (!runStart.has(chatKey)) runStart.set(chatKey, archiveCountOf(chatKey));

    const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
    if (entries.length) queueAppend(chatKey, entries.slice(-MAX_APPEND_PER_TICK), { source: 'batch' });

    // 补齐历史：只为"已经聊过但归档里还没有"的部分做一次。
    if (backfilled.has(chatKey)) return;
    backfilled.add(chatKey);
    if (cfg().backfillOnStart === false) return;
    const limit = num(cfg().backfillLimit, DEFAULTS.backfillLimit, 1, 200000);
    let history = [];
    try {
      history = store.recent(chatKey, { limit }) || [];
    } catch (error) {
      warn(`补历史失败（读不到存档）：${error?.message ?? error}`);
      return;
    }
    // ⚠️ 历史用**立即落盘**，不走攒批：那是几千条的一次性导入，
    //    压进缓存既占内存又可能等不到下一批（用户看不到任何东西就以为坏了）。
    if (history.length) {
      const prev = queues.get(chatKey) || Promise.resolve();
      const next = prev
        .then(() => {
          const r = appendImmediate(chatKey, history, { source: 'backfill' });
          log(`补齐历史完成：${chatKey} 写入 ${r.written} 条，跳过重复 ${r.skipped} 条`);
        })
        .catch((error) => warn(`补历史出错：${error?.message ?? error}`))
        .finally(() => {
          if (queues.get(chatKey) === next) queues.delete(chatKey);
        });
      queues.set(chatKey, next);
    }
  } catch (error) {
    warn(`归档钩子出错：${error?.message ?? error}`);
  }
}

// ─────────────────────────────────────────────── 提示词片段

/**
 * 归档状态片段：把"归档覆盖了哪段时间、落盘节奏、心绪在哪"告诉模型。
 * 供 promptSections 调用（那边还要拼心绪注入段）。
 *
 * ⚠️ 必须极短且稳定：提示词参与前缀缓存，内容每次都变会把缓存打废。
 *    所以只报"月份跨度 + 落盘间隔"，不报精确条数（精确条数每收一条消息都会变）。
 */
function archivePromptSections(context = {}) {
  try {
    if (!isOn()) return null;
    const chatKey = context?.chatKey;
    const kind = chatKindOf(chatKey);
    if (!kind) return null;
    if (scopeOf() === 'private' && kind !== 'private') return null;
    const months = monthFiles(chatKey);
    const pendingCount = (pending.get(chatKey)?.items || []).length;
    if (!months.length && !pendingCount) return null;
    const span = months.length ? `覆盖 ${months[0].month} ~ ${months[months.length - 1].month}` : '刚开始记录';
    const everyH = num(cfg().archiveIntervalHours, DEFAULTS.archiveIntervalHours, 1, 168);
    return {
      id: 'private-chat-archive-status',
      title: '私聊记忆库',
      priority: 41,
      content: `本会话有独立的长期归档（${span}）。消息是每 ${everyH} 小时落盘一次，`
        + '刚聊的内容也在归档里（只是还没写进文件），不必因此说"我不知道"。'
        + '需要回忆更早的聊天或当时的心绪，用 private-chat-archive__search_archive / query_by_date / mood_search / archive_overview 去查，不要凭印象编。'
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────── 生命周期

export function setup(a) {
  api = a;
  log = (...args) => a.log(...args);
  warn = (...args) => a.warn(...args);

  // ⚠️ 工具必须在 setup 执行期间注册（loader 只收集这一次 registerTool 的返回值）。
  //    写到别的函数里（比如 activate）等于静默失效：模型看不到这个工具。
  a.registerTool({
    id: TOOL_SEARCH,
    name: '翻聊天归档',
    description: '在你自己的长期聊天归档里检索这个会话的历史消息（比提示词里那几十条【已读信息】长得多，'
      + '包含很久以前、甚至几个月前的对话）。当有人问「你记得我之前说过的…」「我们什么时候聊过…」'
      + '「我以前是不是跟你提过…」时用它，不要凭印象回答。可按关键词、按人、按时间段检索；'
      + '返回命中消息 + 前后各几条上下文（▶ 标出命中那条）。没找到就是真的没归档到，不要编。',
    category: 'query',
    icon: '🗂️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '要搜的关键词（人名、地名、事件、当时的原话都行）。多个词用空格分隔，会要求每个词都出现。留空 = 只按人和时间筛。'
        },
        sender: { type: 'string', description: '只看谁说的：填对方的昵称或 QQ 号。留空 = 不限人。' },
        from: { type: 'string', description: '起始日期，格式 YYYY-MM-DD（含当天）。留空 = 不限。' },
        to: { type: 'string', description: '结束日期，格式 YYYY-MM-DD（含当天）。留空 = 不限。' },
        limit: { type: 'integer', description: '最多返回几条命中（默认按设置，硬上限由设置在管）。需要更全的结果时再调大。' }
      }
    },
    async execute(ctx, args) {
      try {
        return doSearch(ctx, args);
      } catch (error) {
        warn(`${TOOL_SEARCH} 出错：${error?.message ?? error}`);
        return errText(`检索归档失败：${error?.message ?? error}`);
      }
    }
  });

  a.registerTool({
    id: TOOL_BY_DATE,
    name: '按天回顾聊天',
    description: '按时间段回顾这个会话的聊天内容：给出每天的消息总数、几条代表性原文，以及当天心绪的变化'
      + '（如果有记心绪的话）。当有人问「上周我们聊了什么」「最近几天有什么事」「3 月 5 号那天说了啥」'
      + '「我那天心情怎么样」这类按时间要内容的问题时用它。需要看某天的完整内容，再配合 search_archive。',
    category: 'query',
    icon: '📅',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '起始日期 YYYY-MM-DD（含当天）。留空且 to 也留空时默认最近 7 天。' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（含当天）。' },
        sender: { type: 'string', description: '只看谁说的（昵称或 QQ 号）。留空 = 不限。' },
        withMood: { type: 'boolean', description: '是否附带当天的心绪变化，默认 true。只想要消息时填 false。' }
      }
    },
    async execute(ctx, args) {
      try {
        return doByDate(ctx, args);
      } catch (error) {
        warn(`${TOOL_BY_DATE} 出错：${error?.message ?? error}`);
        return errText(`按天回顾失败：${error?.message ?? error}`);
      }
    }
  });

  a.registerTool({
    id: TOOL_OVERVIEW,
    name: '查看归档概览',
    description: '查看这个会话的归档概览：一共归档了多少条消息、覆盖哪段时间、每个月的条数、发言最多的人，'
      + '以及心绪归档了多少次、最近一次是什么。回答「你都记得什么」「你存了多少聊天记录」，'
      + '或者不确定该查哪段时间时先用它摸底盘。',
    category: 'query',
    icon: '📊',
    defaultEnabled: true,
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        return doOverview(ctx);
      } catch (error) {
        warn(`${TOOL_OVERVIEW} 出错：${error?.message ?? error}`);
        return errText(`读取归档概览失败：${error?.message ?? error}`);
      }
    }
  });

  a.registerTool({
    id: TOOL_MOOD,
    name: '回忆当时的心绪',
    description: '翻阅你**自己过去的心绪记录**（情绪 + 当时还挂在心里没想完的事）。'
      + '心绪机制本身只保留最近一小段时间（情绪 24 小时、心事 12 小时），过期后连它自己也查不到了 —— '
      + '只有这份归档能回溯。当有人问「你那天什么心情」「你之前为什么事惦记」「你最近在纠结什么」'
      + '「上个月你不是一直在等一件事吗」时用它。可按时间范围和关键词筛。'
      + '注意：这是你当时内心的真实记录，回答时自然地带出来，别用"系统记录显示"这种口气。',
    category: 'memory',
    icon: '🫧',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '起始日期 YYYY-MM-DD。留空且 to 也留空时默认最近若干天（按设置）。' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD。' },
        keyword: { type: 'string', description: '只要包含这个词的心绪（比如某件事、某个人的名字）。留空 = 不限。' },
        withTopics: { type: 'boolean', description: '是否连"挂心事"一起显示，默认 true。只要情绪基调时填 false。' },
        perDay: { type: 'integer', description: '有变动的日子，每天最多列几次变化（默认 3）。' }
      }
    },
    async execute(ctx, args) {
      try {
        return doMoodSearch(ctx, args);
      } catch (error) {
        warn(`${TOOL_MOOD} 出错：${error?.message ?? error}`);
        return errText(`查询心绪失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 心绪机制的两个写工具（复刻自 inner-life，工具名保持一致以便平滑替换）──
  if (moodOn()) {
    a.registerTool({
      id: TOOL_MIND_NOTE,
      name: '记下此刻的心绪',
      description:
        '记下你此刻的心绪——这是你跨轮延续的"自己"。mood 是现在的情绪（一句短话，写你真实的情绪）；'
        + 'topics 是还挂在心里、没想完的话题（每条一句话，最多按设置条数）。'
        + '**挂心事只挂真没想完的**：在等的一件事、要说的话、没解开的情绪。'
        + '随口起的玩笑、玩过的梗、打趣过的待办（"等他回来吹""明天跟他算账"）**不算心事，别往上挂**——'
        + '挂了它每一轮都会回来找你，一个梗被你反复提，反而变假。'
        + '**只在真的变了、或有新的事挂上来时才记**：心绪还是刚才那样、也没有新心事，就不记——'
        + '同一件事换个说法也算同一件（记了也只会刷新时间），翻来覆去记同一件事会变成回音。'
        + '每次运行结束、finish 之前过一遍：有变化就记，没变化就直接结束。'
        + '想通/结束了的话题，用 mind_settle 清掉，别永远背着。',
      category: 'memory',
      icon: '💭',
      defaultEnabled: true,
      parameters: {
        type: 'object',
        properties: {
          mood: { type: 'string', description: '现在的情绪，一句短话（≤20 字），写真实的。没变化可以不传。' },
          topics: {
            type: 'array',
            description: '新增的、还挂在心里没想完的话题（每条 ≤30 字）。已经记过的不必重复传。',
            items: { type: 'string' }
          }
        }
      },
      async execute(ctx, args) {
        try {
          if (!ctx?.chatKey) return errText('没有会话上下文，没记。');
          const guard = scopeGuard(ctx.chatKey);
          if (guard) return guard;
          const r = applyMindNote(ctx.chatKey, args);
          return okText(r.text);
        } catch (error) {
          warn(`${TOOL_MIND_NOTE} 出错：${error?.message ?? error}`);
          return errText(`记录心绪失败：${error?.message ?? error}`);
        }
      }
    });

    a.registerTool({
      id: TOOL_MIND_SETTLE,
      name: '想通了，放下心事',
      description:
        '放下想通了/结束了的心绪话题：传 keyword 匹配话题里包含这个词的；不传就全部放下。'
        + '比如想通了某件一直挂着的事，就 mind_settle 传 keyword=那件事的关键词。也可以顺手更新 mood。',
      category: 'memory',
      icon: '🍃',
      defaultEnabled: true,
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '要放下的话题关键词；不传 = 放下全部挂着的事' },
          mood: { type: 'string', description: '想通后现在的情绪（可选）' }
        }
      },
      async execute(ctx, args) {
        try {
          if (!ctx?.chatKey) return errText('没有会话上下文。');
          const guard = scopeGuard(ctx.chatKey);
          if (guard) return guard;
          const r = applyMindSettle(ctx.chatKey, args);
          const left = r.state.topics.length ? `；还挂着：${r.state.topics.map((t) => t.text).join('；')}` : '；现在没有挂着的事了';
          return okText(r.removed ? `已放下 ${r.removed} 件心事${left}` : `没找到包含「${clean(args?.keyword, TOPIC_TEXT_MAX)}」的心事${left}`);
        } catch (error) {
          warn(`${TOOL_MIND_SETTLE} 出错：${error?.message ?? error}`);
          return errText(`放下心事失败：${error?.message ?? error}`);
        }
      }
    });
  }

  let dir = '';
  try {
    dir = dataRoot();
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    warn(`归档根目录不可用：${error?.message ?? error}`);
  }

  // 心绪目录（自带实现，不再依赖 inner-life）
  try {
    ensureDir(moodStateDir());
  } catch (error) {
    warn(`心绪目录不可用：${error?.message ?? error}`);
  }

  // 把上次（含热重载前）没落盘的消息接回队列，别让它们干等下一次对话
  try {
    restoreAllPending();
  } catch (error) {
    warn(`接回未落盘消息失败：${error?.message ?? error}`);
  }

  // 定时巡检：到点归档 + 空闲补写。unref 掉，不拖住进程退出。
  if (!sweepTimer) {
    sweepTimer = setInterval(() => { try { sweepPending(); } catch { /* ignore */ } }, SWEEP_MS);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  const everyH = num(cfg().archiveIntervalHours, DEFAULTS.archiveIntervalHours, 1, 168);
  const idleSec = num(cfg().archiveIdleFlushSec, DEFAULTS.archiveIdleFlushSec, 15, 86400);
  a.log(`私聊记忆库已加载｜归档目录 ${dir}｜范围 ${scopeOf() === 'all' ? '私聊+群聊' : '仅私聊'}`
    + `｜落盘节奏 每 ${everyH} 小时（空闲 ${idleSec} 秒也补写）`
    + `｜心绪 ${moodOn() ? `开（归档：${moodArchiveOn() ? (cfg().moodArchiveWhen === 'always' ? '每轮' : '变化时') : '关'}）` : '关'}`
    + `｜工具 ${TOOL_SEARCH} / ${TOOL_BY_DATE} / ${TOOL_OVERVIEW} / ${TOOL_MOOD}`
    + `${moodOn() ? ` / ${TOOL_MIND_NOTE} / ${TOOL_MIND_SETTLE}` : ''}`);
}

/**
 * 生命周期：热重载/禁用/关闭时收尾。
 *
 * ⚠️ 这里必须把攒批缓存落盘 —— 否则"关掉技能"或"热重载"会把没满一批的消息丢掉。
 * ⚠️ 必须走 flushPendingLocked，**不能**自己写一遍"seen 筛查"：
 *    缓存里的项在入队时就已经 markSeen 过了，用 seen 再筛一次会把它们全部判成
 *    "已归档"而丢弃 —— 那是静默丢数据（第一版就踩了这个坑）。
 */
export function deactivate() {
  try {
    for (const chatKey of [...pending.keys()]) {
      const state = pending.get(chatKey);
      if (!state || !state.items.length) continue;
      // 直接同步落盘（deactivate 不能等 Promise）
      const r = flushPendingLocked(chatKey, 'deactivate');
      if (r.written) log(`停用前补写：${chatKey} +${r.written} 条`);
    }
    for (const chatKey of [...seenDirty]) flushSeen(chatKey);
  } catch (error) {
    warn(`停用收尾出错：${error?.message ?? error}`);
  }
  if (sweepTimer) {
    try { clearInterval(sweepTimer); } catch { /* ignore */ }
    sweepTimer = null;
  }
  queues.clear();
  backfilled.clear();
  runStart.clear();
  compactCache.clear();
}

/** 确定性钩子：before-context 收消息，after-response 收心绪。 */
export const hooks = {
  'before-context': (ctx) => onBeforeContext(ctx),
  'after-response': (ctx) => onAfterResponse(ctx)
};

/** 对外能力：报一份状态（归档节奏 + 心绪机制开关）。 */
export const providers = {
  'archive.private-chat': () => {
    let chats = 0;
    try {
      chats = fs.readdirSync(dataRoot(), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch { /* 目录还不存在 */ }
    let buffered = 0;
    for (const state of pending.values()) buffered += state.items.length;
    return {
      enabled: isOn(),
      scope: scopeOf(),
      chats,
      bufferedMessages: buffered,
      intervalHours: num(cfg().archiveIntervalHours, DEFAULTS.archiveIntervalHours, 1, 168),
      idleFlushSec: num(cfg().archiveIdleFlushSec, DEFAULTS.archiveIdleFlushSec, 15, 86400),
      moodEnabled: moodOn(),
      moodArchive: moodArchiveOn(),
      dataRoot: dataRoot()
    };
  }
};
