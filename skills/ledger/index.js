// 小本本（ledger）—— 机器人的私人账本：谁欠它饭、谁骂过它
//
// ── 为什么是技能（skills/，LLM 型），不是插件（plugins/）────────────────────
//   按 doc/extend_development/skill-development.md §0 的三问：
//   ① 触发时机能写成 if 吗？——不能。「这句话是在认账，还是随口一提」「这是在骂我，
//      还是在聊菜市场那头猪」必须读懂人话；拿正则抓「猪」会把「荷兰猪真可爱」也记成骂人。
//   ② 漏记一次代价？——少记一笔玩笑账，下次还来得及补，不丢数据、不坏事。
//   ③ 参数从哪来？——who、这件事的原委，都要从人话里抠出来。
//   三问一致指向 LLM 型 → 放 skills/，用 registerTool 把决定权交给模型。
//
// ── 数据 ──────────────────────────────────────────────────────────────
//   DATA_DIR/ledger/ledger.json，原子写（先写 .tmp 再 rename）。
//   绝不用 process.cwd() 当锚点（照 skills/whale-memes/index.js 的约定）。
//   形状：{ version, nextId, entries: [ { id, key, who, kind, detail, amount, unit,
//           evidence, chatKey, chatName, at, status, settledAt, note } ] }

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const SKILL_ID = 'ledger';
const DIR = path.join(DATA_DIR, SKILL_ID);
const DB_FILE = path.join(DIR, 'ledger.json');

const KINDS = ['欠饭', '欠钱', '欠东西', '欠人情', '骂我', '说我坏话', '欺负我', '其他'];
/** 模型可能填同义词/英文，统一归一到 KINDS 里的一项。 */
const KIND_ALIAS = {
  欠饭: '欠饭', 欠一顿饭: '欠饭', 请吃饭: '欠饭', 饭: '欠饭', owe_meal: '欠饭', meal: '欠饭',
  欠钱: '欠钱', 欠债: '欠钱', 借钱: '欠钱', owe_money: '欠钱', money: '欠钱',
  欠东西: '欠东西', 欠物品: '欠东西', owe_thing: '欠东西',
  欠人情: '欠人情', 人情: '欠人情', favor: '欠人情',
  骂我: '骂我', 骂: '骂我', 侮辱: '骂我', 侮辱我: '骂我', insult: '骂我',
  说我坏话: '说我坏话', 坏话: '说我坏话', 吐槽我: '说我坏话', 背刺: '说我坏话', badmouth: '说我坏话',
  欺负我: '欺负我', 欺负: '欺负我', bully: '欺负我',
  其他: '其他', other: '其他'
};
const DEFAULTS = { autoRecord: true, injectDigest: true, keepDays: 0 };
const MAX_ENTRIES = 2000;
const DIGEST_MAX_PEOPLE = 5;
const DIGEST_MAX_CHARS = 360;

let cfgFn = null;
let log = () => {};
let warn = () => {};

function cfg() {
  try {
    const c = cfgFn ? cfgFn() : null;
    return { ...DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

// ─────────────────────────────────────────────── 小工具
function clean(s, max = 120) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 名字归一：去掉括号里的 QQ 号、空格，转小写，用于"同一个人"的判断。 */
function normKey(s) {
  return String(s ?? '')
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/[\s:：,，、]+/g, '')
    .toLowerCase();
}

function normKind(v) {
  const raw = clean(v, 20);
  if (KINDS.includes(raw)) return raw;
  return KIND_ALIAS[raw] || KIND_ALIAS[raw.toLowerCase()] || '其他';
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function parseIds(s) {
  return String(s ?? '')
    .split(/[\s,，、;；/|]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .map((x) => (/^\d+$/.test(x) ? `l${x}` : x));
}

function fmtLocal(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '--';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    warn(`写盘失败（${path.basename(file)}）：${e?.message ?? e}`);
    return false;
  }
}

// ─────────────────────────────────────────────── 账本读写
function emptyDb() {
  return { version: 1, nextId: 1, entries: [] };
}

function load() {
  const raw = readJson(DB_FILE, null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return emptyDb();
  const entries = raw.entries
    .filter((e) => e && typeof e === 'object' && e.id && e.who)
    .map((e) => ({
      id: String(e.id),
      key: String(e.key || normKey(e.who)),
      who: String(e.who),
      kind: KINDS.includes(e.kind) ? e.kind : '其他',
      detail: String(e.detail || ''),
      amount: num(e.amount, 1) > 0 ? num(e.amount, 1) : 1,
      unit: String(e.unit || ''),
      evidence: String(e.evidence || ''),
      chatKey: String(e.chatKey || ''),
      chatName: String(e.chatName || ''),
      at: String(e.at || ''),
      status: e.status === 'settled' ? 'settled' : 'open',
      settledAt: e.settledAt ? String(e.settledAt) : null,
      note: String(e.note || '')
    }));
  let maxId = 0;
  for (const e of entries) {
    const m = e.id.match(/^l(\d+)$/i);
    if (m) maxId = Math.max(maxId, Number(m[1]));
  }
  return { version: 1, nextId: Math.max(num(raw.nextId, 1), maxId + 1, entries.length + 1), entries };
}

/** 落盘前统一做清理：按 keepDays 丢弃过期的已结清记录，并压到上限。 */
function save(db) {
  const keepDays = Math.max(0, num(cfg().keepDays, 0));
  let entries = db.entries;
  if (keepDays > 0) {
    const cutoff = Date.now() - keepDays * 86400000;
    entries = entries.filter((e) => {
      if (e.status !== 'settled') return true;
      const t = Date.parse(e.settledAt || e.at);
      return !Number.isFinite(t) || t >= cutoff;
    });
  }
  if (entries.length > MAX_ENTRIES) {
    const open = entries.filter((e) => e.status === 'open');
    const settled = entries
      .filter((e) => e.status !== 'open')
      .sort((a, b) => Date.parse(b.settledAt || b.at) - Date.parse(a.settledAt || a.at));
    entries = [...open, ...settled.slice(0, Math.max(0, MAX_ENTRIES - open.length))];
  }
  db.entries = entries;
  return writeJson(DB_FILE, db);
}

function matchesWho(entry, whoQuery) {
  const q = normKey(whoQuery);
  if (!q) return false;
  const k = entry.key;
  return k === q || k.includes(q) || q.includes(k);
}

function amtText(e) {
  const amount = num(e.amount, 1);
  const unit = e.unit || (e.kind.startsWith('欠') ? '份' : '次');
  return amount > 1 ? `×${amount}${unit}` : `×1${unit}`;
}

function describe(e) {
  const parts = [`${e.who}`, `${e.kind}${amtText(e)}`];
  if (e.detail) parts.push(e.detail);
  return parts.join('｜');
}

function line(e) {
  const tail = e.status === 'settled' ? `（已销账 ${fmtLocal(e.settledAt || e.at)}）` : fmtLocal(e.at);
  return `${e.id} ${describe(e)}${e.chatName ? `｜${e.chatName}` : ''}｜${tail}`;
}

function openCountOf(db, key) {
  return db.entries.filter((e) => e.status === 'open' && e.key === key).length;
}

function err(content) {
  return { content, isError: true };
}

// ─────────────────────────────────────────────── 工具
function toolAddRecord() {
  return {
    id: 'add_record',
    name: '记一笔账',
    description:
      '在小本本上记一笔人情账：谁欠了机器人（欠饭/欠钱/欠东西/欠人情），或者谁骂了它、说了它坏话。'
      + '当群里有人对机器人认账、承诺、服软（「欠你一顿饭」「下次我请」「我错了」「对不起」），'
      + '或者有人针对机器人贬损（「大肥鱼是猪」「菜」「傻」）时使用。'
      + '不要在别人互相开玩笑、骂的不是机器人、或者这句话刚记过时调用。'
      + '记之前不用先查，工具会自己挡重复；但如果同一个人的同一类事刚发生过、你不确定是不是新的一笔，'
      + '先用 query_records 看一眼。who 填对方的群昵称或 QQ 号。',
    category: 'memory',
    icon: '📕',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: '这笔账记在谁头上：对方的群昵称、备注名或 QQ 号，例如「阿强」。' },
        kind: {
          type: 'string',
          enum: KINDS,
          description: '账的类型：欠饭=欠一顿饭；欠钱/欠东西/欠人情=对应的亏欠；骂我=当面骂或贬损机器人；说我坏话=背后说；欺负我=被整了；其他=归不了类。'
        },
        detail: { type: 'string', description: '一句话写清这一笔的原委，例如「说明天请我吃饭」「说我蓝色大肥鱼是猪」。' },
        amount: { type: 'number', description: '数量，默认 1。例如欠 3 顿饭就填 3。' },
        unit: { type: 'string', description: '数量单位，例如「顿」「块」「次」。不填按类型自动取。' },
        evidence: { type: 'string', description: '可选：对方的原话，原样抄一句，方便以后翻旧账。' }
      },
      required: ['who', 'kind', 'detail']
    },
    async execute(ctx, args) {
      try {
        const who = clean(args?.who, 60);
        if (!who) return err('缺少 who：这笔账要记在谁头上？填对方的群昵称或 QQ 号。');
        const kind = normKind(args?.kind);
        const detail = clean(args?.detail, 200) || kind;
        const amount = num(args?.amount, 1) > 0 ? num(args.amount, 1) : 1;
        const unit = clean(args?.unit, 8);
        const evidence = clean(args?.evidence, 200);
        const db = load();
        const key = normKey(who);

        const dup = db.entries.find(
          (e) => e.status === 'open' && e.key === key && e.kind === kind && normKey(e.detail) === normKey(detail)
        );
        if (dup) {
          return { content: `这笔已经在（${line(dup)}），没有重复记。要记的是新的一次，就把 detail 写清是哪一次。` };
        }

        const entry = {
          id: `L${db.nextId}`,
          key,
          who,
          kind,
          detail,
          amount,
          unit,
          evidence,
          chatKey: clean(ctx?.chatKey, 40),
          chatName: clean(ctx?.chatName, 40),
          at: new Date().toISOString(),
          status: 'open',
          settledAt: null,
          note: ''
        };
        db.nextId += 1;
        db.entries.push(entry);
        if (!save(db)) return err('记账失败：账本文件写不进去（看控制台日志）。');
        log(`记了一笔：${describe(entry)}`);
        const total = openCountOf(db, key);
        return {
          content: `记上了：${line(entry)}。${who} 现在一共 ${total} 笔没结清。`
            + `简短回一句就行（比如「记上了」），不要把账本内容大段复述。`
        };
      } catch (e) {
        return err(`记账失败：${e?.message ?? e}`);
      }
    }
  };
}

function toolQueryRecords() {
  return {
    id: 'query_records',
    name: '查小本本',
    description:
      '查机器人小本本上的账：谁欠它什么、谁骂过它。当群友问「谁欠你饭」「谁骂过你」「账本上都有谁」「还欠着几笔」，'
      + '或者机器人自己想翻旧账/炫耀账本时使用。想看按人汇总的排行就把 rank 设为 true。'
      + '只想看某个人的就用 who 过滤。查到的编号（L1、L2…）可以拿去销账或删除。',
    category: 'memory',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: '只看某个人的账，填昵称或 QQ 号（会做模糊匹配）。不填=看全部。' },
        kind: { type: 'string', enum: KINDS, description: '只看某一类账，例如只看「欠饭」。不填=全部类型。' },
        status: { type: 'string', enum: ['open', 'settled', 'all'], description: 'open=还没结清的（默认）；settled=已经销账的；all=全部。' },
        rank: { type: 'boolean', description: 'true = 不列明细，按人汇总排序（谁最多谁在前），适合回答「谁欠我最多」。' },
        limit: { type: 'number', description: '明细最多返回几条，默认 20，最大 50。' }
      }
    },
    async execute(_ctx, args) {
      try {
        const db = load();
        const status = ['open', 'settled', 'all'].includes(String(args?.status)) ? String(args.status) : 'open';
        const limit = clamp(args?.limit, 1, 50, 20);
        let list = db.entries.filter((e) => (status === 'all' ? true : e.status === status));
        if (args?.who) list = list.filter((e) => matchesWho(e, args.who));
        if (args?.kind) {
          const kind = normKind(args.kind);
          list = list.filter((e) => e.kind === kind);
        }
        if (!list.length) {
          return { content: `小本本上没有符合条件的账（筛选：${status === 'open' ? '未结清' : status === 'settled' ? '已销账' : '全部'}${args?.who ? `，人=${clean(args.who, 30)}` : ''}${args?.kind ? `，类型=${normKind(args.kind)}` : ''}）。` };
        }

        if (args?.rank) {
          const byKey = new Map();
          for (const e of list) {
            if (!byKey.has(e.key)) byKey.set(e.key, { who: e.who, kinds: new Map(), total: 0 });
            const g = byKey.get(e.key);
            g.total += 1;
            g.kinds.set(e.kind, (g.kinds.get(e.kind) || 0) + 1);
          }
          const rows = [...byKey.values()].sort((a, b) => b.total - a.total);
          const text = rows
            .slice(0, 20)
            .map((g) => `${g.who} ${g.total} 笔（${[...g.kinds.entries()].map(([k, n]) => `${k}×${n}`).join('、')}）`)
            .join('；');
          return { content: `按人汇总（${status === 'open' ? '未结清' : status === 'settled' ? '已销账' : '全部'}，共 ${list.length} 笔）：${text}` };
        }

        const lines = list
          .slice()
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
          .slice(0, limit)
          .map((e) => line(e));
        const more = list.length > lines.length ? `\n（还有 ${list.length - lines.length} 笔没列出来，可以调 limit 或加 who 过滤）` : '';
        return { content: `小本本（${status === 'open' ? '未结清' : status === 'settled' ? '已销账' : '全部'}，共 ${list.length} 笔，按时间从新到旧）：\n${lines.join('\n')}${more}` };
      } catch (e) {
        return err(`查账失败：${e?.message ?? e}`);
      }
    }
  };
}

function toolSettleRecords() {
  return {
    id: 'settle_records',
    name: '销账',
    description:
      '把账销掉：对方真的还了、请了饭、道歉了，或者机器人决定不记这笔了。'
      + '当群里出现「请你吃饭了」「我道歉」「这顿我请」「算了我还你」这类兑现/服软的话，'
      + '或者机器人自己表示「这笔记我销了」时使用。'
      + '先在 query_records 里看准是哪个人的哪几笔，再用 who（必要）和 kind（可选）指定；'
      + '要精确销某几笔就把编号填进 ids。销账只改状态、不删记录，翻旧账时还看得到。',
    category: 'memory',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: '销谁的账：昵称或 QQ 号（会做模糊匹配）。填了 ids 时可以不填。' },
        kind: { type: 'string', enum: KINDS, description: '只销这一类账，例如只销「欠饭」。不填=这个人的全部未结清。' },
        ids: { type: 'string', description: '要精确销掉的编号，多个用逗号分隔，例如「L3,L5」。填了就以编号为准，忽略 who/kind。' },
        note: { type: 'string', description: '可选：销账原因，例如「已请吃饭」「当面道歉了」。' }
      }
    },
    async execute(_ctx, args) {
      try {
        const db = load();
        const ids = parseIds(args?.ids);
        let targets;
        if (ids.length) {
          targets = db.entries.filter((e) => e.status === 'open' && ids.includes(e.id.toLowerCase()));
          const missing = ids.filter((id) => !db.entries.some((e) => e.id.toLowerCase() === id));
          if (!targets.length) {
            return err(`没找到可销的账（${missing.length ? `编号不存在：${missing.join(',')}` : '这些编号都已经销过了'}）。先用 query_records 确认编号。`);
          }
        } else {
          const who = clean(args?.who, 60);
          if (!who) return err('缺少 who：销谁的账？填昵称或 QQ 号，或者直接把编号填进 ids。');
          targets = db.entries.filter((e) => e.status === 'open' && matchesWho(e, who));
          if (args?.kind) {
            const kind = normKind(args.kind);
            targets = targets.filter((e) => e.kind === kind);
          }
          if (!targets.length) return err(`小本本上没有 ${who} 的未结清账目，没什么可销的。`);
        }
        const note = clean(args?.note, 120);
        const now = new Date().toISOString();
        for (const e of targets) {
          e.status = 'settled';
          e.settledAt = now;
          if (note) e.note = note;
        }
        if (!save(db)) return err('销账失败：账本文件写不进去（看控制台日志）。');
        log(`销账 ${targets.length} 笔`);
        return {
          content: `销账 ${targets.length} 笔：\n${targets.map((e) => line(e)).join('\n')}\n`
            + `（记录保留在本子上，翻旧账还看得到。回一句「这笔记消了」之类的就行，别把明细全念一遍。）`
        };
      } catch (e) {
        return err(`销账失败：${e?.message ?? e}`);
      }
    }
  };
}

function toolRemoveRecord() {
  return {
    id: 'remove_record',
    name: '删掉一笔账',
    description:
      '把记错的账从小本本上彻底删掉（区别于销账：销账是「这笔了了」，删除是「根本没这回事」）。'
      + '当机器人记错了人、记错了事，或者群友说「别记这个」「记错了」「我没说过」时使用。'
      + '必须先用 query_records 查到编号，再把编号填进 ids；一次可以删多笔。',
    category: 'memory',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'string', description: '要删掉的编号，多个用逗号分隔，例如「L3,L5」。' },
        reason: { type: 'string', description: '可选：为什么删，例如「记错人了」「对方没说过」。' }
      },
      required: ['ids']
    },
    async execute(_ctx, args) {
      try {
        const ids = parseIds(args?.ids);
        if (!ids.length) return err('缺少 ids：要删哪几笔？先 query_records 查到编号（L1、L2…）再填进来。');
        const db = load();
        const hit = db.entries.filter((e) => ids.includes(e.id.toLowerCase()));
        if (!hit.length) return err(`编号没找到：${ids.join(',')}。先用 query_records 确认一下。`);
        const kept = db.entries.filter((e) => !ids.includes(e.id.toLowerCase()));
        const removed = hit.map((e) => line(e));
        db.entries = kept;
        if (!save(db)) return err('删除失败：账本文件写不进去（看控制台日志）。');
        log(`删掉 ${hit.length} 笔：${ids.join(',')}${args?.reason ? `（${clean(args.reason, 60)}）` : ''}`);
        return { content: `删掉了 ${hit.length} 笔：\n${removed.join('\n')}\n剩下的账目共 ${kept.length} 笔。` };
      } catch (e) {
        return err(`删除失败：${e?.message ?? e}`);
      }
    }
  };
}

// ─────────────────────────────────────────────── 生命周期
export function setup(api) {
  cfgFn = api?.config;
  log = api?.log ?? (() => {});
  warn = api?.warn ?? (() => {});

  api.registerTool(toolAddRecord());
  api.registerTool(toolQueryRecords());
  api.registerTool(toolSettleRecords());
  api.registerTool(toolRemoveRecord());

  const db = load();
  const open = db.entries.filter((e) => e.status === 'open').length;
  log(`小本本已就绪：共 ${db.entries.length} 笔账（未结清 ${open} 笔）`);
}

/** 可用性判定必须同步：本技能没有外部依赖，直接放行。 */
export function available() {
  return true;
}

/** 每轮注入：未结清的账压成一行，让机器人不查也知道本子上有谁。 */
export function promptSections() {
  const out = [];
  try {
    const c = cfg();
    if (c.autoRecord === false) {
      out.push({
        id: 'ledger-manual-only',
        title: '小本本（只记点名要记的）',
        priority: 39,
        content: '当前设置是「不自动记账」：只有群友或主人明确让你记一笔时才用 `ledger__add_record`，自己听到认账/骂人的话不要主动记。'
      });
    }
    if (c.injectDigest === false) return out;

    const db = load();
    const open = db.entries.filter((e) => e.status === 'open');
    if (!open.length) return out;

    const byKey = new Map();
    for (const e of open) {
      if (!byKey.has(e.key)) byKey.set(e.key, { who: e.who, kinds: new Map(), last: e.at, total: 0 });
      const g = byKey.get(e.key);
      g.total += 1;
      g.kinds.set(e.kind, (g.kinds.get(e.kind) || 0) + 1);
      if (Date.parse(e.at) > Date.parse(g.last)) g.last = e.at;
    }
    const rows = [...byKey.values()].sort((a, b) => b.total - a.total || Date.parse(b.last) - Date.parse(a.last));
    const shown = rows.slice(0, DIGEST_MAX_PEOPLE);
    let text = `你小本本上有 ${open.length} 笔没结清，涉及 ${rows.length} 个人：`
      + shown.map((g) => `${g.who} ${[...g.kinds.entries()].map(([k, n]) => `${k}×${n}`).join('、')}`).join('；')
      + (rows.length > shown.length ? `；还有 ${rows.length - shown.length} 个人` : '')
      + '。被问到就用 `ledger__query_records` 查明细；对方还了、道歉了用 `ledger__settle_records` 销账。别主动把账本念一遍。';
    if (text.length > DIGEST_MAX_CHARS) text = `${text.slice(0, DIGEST_MAX_CHARS - 1)}…`;
    out.push({ id: 'ledger-digest', title: '小本本（未结清的账）', priority: 36, content: text });
  } catch (e) {
    warn(`账面摘要生成失败：${e?.message ?? e}`);
  }
  return out;
}
