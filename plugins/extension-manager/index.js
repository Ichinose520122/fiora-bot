/**
 * 扩展管理器（extension-manager）—— 确定性型插件 v1.0.0
 * ═══════════════════════════════════════════════════════════════════════════
 * 一句话：**给控制台的「技能」/「插件」页每张卡片装一颗 🗑 删除按钮。**
 *
 * 为什么必须是插件、而且必须"自带界面"：
 *   · 技能（LLM 型）只把工具塞进模型的 tools 列表，控制台界面根本看不到它 → 做不到；
 *   · 插件的 providers / hooks 是"别人来调我"的入口，而扩展系统**没有前端钩子**
 *     （官方 theme-installer 的文件头原文："插件碰不到页面 DOM → 只能靠写文件 + 让窗口重载"）；
 *   · 所以本插件走的是和官方 theme-installer **完全同一套**路子：
 *       ① 把 host/extension-manager-host.js 复制到 ui/extension-manager-host.js
 *       ② 在 ui/index.html 的 </head> 前插一个**带标记**的块把它挂上
 *       ③ 关掉插件时按标记精确摘除（不靠猜、不动别人的行）
 *     页面里那段脚本负责"画按钮"，点下去再回调本插件的动作路由。
 *
 * 动作路由（页面 → 主进程）：
 *     POST /api/skills/extension-manager/action/remove     body: { id, kind }
 *   宿主只放行 configSchema 里声明为 type:"action" 的键，所以 `remove` 必须写在清单里
 *   （副作用：设置弹窗里会多出一个填不了东西的输入框，官方 theme-installer 同款，属宿主行为）。
 *
 * 删除语义（安全第一，与之前改本体那版完全一致）：
 *   · **绝不硬删**：整个目录 rename 到 <数据目录>/removed-extensions/<时间戳>-<id>/；
 *   · 只允许动 skills/ 与 plugins/ 的**一级子目录**：id 白名单 + 路径越界检查 +
 *     realpath 复查（软链接指到别处也拒绝）；
 *   · **不碰配置**：插件没有写配置的 API，也不该绕过宿主。删完目录后由页面调宿主自己的
 *     /api/skills/reload + /api/skills/cleanup 清掉残留配置 —— 配置写入只经过宿主。
 *
 * 数据目录怎么算：优先 `import('../../src/config.js')` 拿宿主的 DATA_DIR
 *   （这样 QQ_AGENT_DATA_DIR / 多实例 profile 都对），拿不到再退回 <安装根>/data。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(PLUGIN_DIR, '..', '..');        // <安装根>/resources/app
const SKILLS_DIR = path.resolve(APP_ROOT, 'skills');
const PLUGINS_DIR = path.resolve(APP_ROOT, 'plugins');
const UI_DIR = path.resolve(APP_ROOT, 'ui');
const UI_INDEX = path.join(UI_DIR, 'index.html');

const HOST_SRC = path.join(PLUGIN_DIR, 'host', 'extension-manager-host.js');
const HOST_NAME = 'extension-manager-host.js';
const HOST_DEST = path.join(UI_DIR, HOST_NAME);
const HOST_URL = `/${HOST_NAME}`;

/* 标记块：装/卸都靠它，绝不靠"猜哪几行是插件加的" */
const MARK_BEGIN = '<!-- extension-manager:begin（由「扩展管理器」插件安装；关掉插件会精确删掉这一段） -->';
const MARK_END = '<!-- extension-manager:end -->';

/* 数据目录：与宿主同源，避免多实例 / 自定义数据目录时备份跑错地方 */
let DATA_DIR = '';
try {
  ({ DATA_DIR } = await import('../../src/config.js'));
} catch { /* 拿不到就走下面的兜底 */ }
if (!DATA_DIR) DATA_DIR = path.resolve(APP_ROOT, '..', '..', 'data');

const BACKUP_DIR = path.join(DATA_DIR, 'removed-extensions');
/* 第一次改 index.html 之前留一份原版（只写一次、永不覆盖），方便人工回退 */
const INDEX_BACKUP = path.join(DATA_DIR, 'ui-extension-manager-backup', 'original-index.html');

let log = () => {};

/* ── index.html 的挂载 / 摘除 ─────────────────────────────────────────── */

/** 把标记块（含其中所有行）从 html 里摘掉。返回 { html, removed }。 */
function stripBlock(html) {
  const lines = String(html).split(/\r?\n/);
  const out = [];
  let inBlock = false;
  let removed = false;
  for (const line of lines) {
    const t = line.trim();
    if (!inBlock && t.startsWith('<!-- extension-manager:begin')) { inBlock = true; removed = true; continue; }
    if (inBlock) {
      if (t.startsWith('<!-- extension-manager:end')) inBlock = false;
      continue;
    }
    out.push(line);
  }
  return { html: out.join('\n'), removed };
}

function installUi() {
  if (!fs.existsSync(UI_INDEX)) throw new Error(`找不到控制台页面：${UI_INDEX}`);
  if (!fs.existsSync(HOST_SRC)) throw new Error(`插件自带的注入脚本缺失：${HOST_SRC}`);

  /* ① 注入脚本复制到 ui/（页面按 /extension-manager-host.js 加载） */
  fs.writeFileSync(HOST_DEST, fs.readFileSync(HOST_SRC, 'utf8'), 'utf8');

  /* ② index.html：先摘干净旧块（幂等，重复 activate 不会插两遍），再挂新块 */
  const original = fs.readFileSync(UI_INDEX, 'utf8');
  const stripped = stripBlock(original);
  if (!stripped.html.includes('</head>')) {
    throw new Error('ui/index.html 里找不到 </head>，不敢动它（怕把控制台页面弄坏）');
  }
  if (!fs.existsSync(INDEX_BACKUP)) {
    try {
      fs.mkdirSync(path.dirname(INDEX_BACKUP), { recursive: true });
      fs.writeFileSync(INDEX_BACKUP, stripped.html, 'utf8');
    } catch { /* 备份失败不影响本次安装 */ }
  }
  const block = `${MARK_BEGIN}\n<script defer src="${HOST_URL}"></script>\n${MARK_END}`;
  const next = stripped.html.replace('</head>', `${block}\n</head>`);
  if (next !== original) fs.writeFileSync(UI_INDEX, next, 'utf8');
}

function uninstallUi() {
  let changed = false;
  try {
    if (fs.existsSync(UI_INDEX)) {
      const r = stripBlock(fs.readFileSync(UI_INDEX, 'utf8'));
      if (r.removed) { fs.writeFileSync(UI_INDEX, r.html, 'utf8'); changed = true; }
    }
  } catch (e) { log(`摘除 index.html 标记失败：${e?.message ?? e}`); }
  try { if (fs.existsSync(HOST_DEST)) { fs.unlinkSync(HOST_DEST); changed = true; } } catch (e) { log(`删除注入脚本失败：${e?.message ?? e}`); }
  return changed;
}

/* ── 生命周期 ─────────────────────────────────────────────────────────── */

export function setup(api) {
  log = api?.log || (() => {});
  log('技能/插件删除按钮 已加载：卡片上的 🗑 由本插件的动作 remove 提供');
}

/**
 * 自检必须是**同步**的（返回 Promise 会被宿主的同步判定链当成"可用"）。
 * 只做"文件在不在"的判断，不发网络请求。
 */
export function available() {
  try {
    if (!fs.existsSync(UI_INDEX)) return { ok: false, reason: '找不到 ui/index.html，没法把删除按钮装进控制台' };
    if (!fs.existsSync(HOST_SRC)) return { ok: false, reason: '插件包不完整：host/extension-manager-host.js 缺失' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `自检失败：${e?.message ?? e}` };
  }
}

/** 被启用：把界面挂上（控制台刷新一次即可看到按钮）。 */
export async function activate() {
  try {
    installUi();
    log(`界面已挂上：${HOST_URL}（控制台按 F5 后生效）`);
  } catch (e) {
    log(`挂界面失败：${e?.message ?? e}（插件功能不可用，但不会影响宿主）`);
  }
}

/** 被关闭：把界面精确摘掉（控制台刷新一次后按钮消失）。 */
export async function deactivate() {
  if (uninstallUi()) log('界面已摘除（控制台刷新一次后按钮消失）');
}

/** 卸载 / 热重载：没有定时器或监听器要清，界面由 deactivate 负责摘除。 */
export function dispose() { /* 故意留空 */ }

/* ── 动作：删除一个技能/插件（页面上的 🗑 调它）───────────────────────── */

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * 把 id 解析成真实目录。只认 skills/ 与 plugins/ 的**一级子目录**；
 * 任何越界、非目录、软链接指向别处的都返回 null（fail-closed）。
 */
function resolveTarget(id, kind) {
  const roots = kind === 'skill' ? [SKILLS_DIR]
    : kind === 'plugin' ? [PLUGINS_DIR]
      : [SKILLS_DIR, PLUGINS_DIR];
  for (const root of roots) {
    const target = path.resolve(root, id);
    if (path.dirname(target) !== root) continue;          // 越界（含 ../ 之类）
    let st = null;
    try { st = fs.statSync(target); } catch { continue; }
    if (!st.isDirectory()) continue;
    try {
      if (path.dirname(fs.realpathSync(target)) !== fs.realpathSync(root)) continue;  // 软链接绕过
    } catch { continue; }
    return { root, target, kindOut: root === SKILLS_DIR ? 'skill' : 'plugin' };
  }
  return null;
}

/**
 * 宿主约定的动作签名：runAction(key, args) → 任意可 JSON 化的结果。
 * 返回 { ok:false, error } 时宿主会回 HTTP 502，真原因在响应体里（页面读 body，不看状态码）。
 */
export async function runAction(key, args = {}) {
  if (key !== 'remove') return { ok: false, error: `不认识的动作：${key}（本插件只提供 remove）` };

  const id = String(args?.id ?? '').trim();
  const kind = String(args?.kind ?? '').trim();
  if (!ID_RE.test(id)) return { ok: false, error: `非法 id：${id || '(空)'}` };
  if (kind && kind !== 'skill' && kind !== 'plugin') return { ok: false, error: `非法 kind：${kind}` };

  const found = resolveTarget(id, kind);
  if (!found) {
    return { ok: false, error: `没找到这个技能/插件目录（只允许 skills/ 与 plugins/ 下的一级子目录）：${kind ? `${kind}/` : ''}${id}` };
  }

  /* 备份式移动：同盘是原子 rename；跨盘/被占用退回"复制 + 删除" */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let dest = path.join(BACKUP_DIR, `${stamp}-${id}`);
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (let n = 2; fs.existsSync(dest); n += 1) dest = path.join(BACKUP_DIR, `${stamp}-${id}-${n}`);
    try {
      fs.renameSync(found.target, dest);
    } catch (e) {
      if (!['EXDEV', 'EPERM', 'EBUSY', 'ENOTEMPTY'].includes(e?.code)) throw e;
      fs.cpSync(found.target, dest, { recursive: true });
      try {
        fs.rmSync(found.target, { recursive: true, force: true });
      } catch (e2) {
        return { ok: false, error: `已复制到备份，但原目录删不掉（多半被占用，关掉 QQ Agent 再试）：${e2?.message ?? e2}` };
      }
    }
  } catch (e) {
    return { ok: false, error: `移动目录失败（原目录未动）：${e?.message ?? e}` };
  }

  const removedDir = path.relative(APP_ROOT, found.target).replace(/\\/g, '/');
  const backupDir = path.relative(DATA_DIR, dest).replace(/\\/g, '/');
  log(`已卸载 ${found.kindOut}：${removedDir} → ${backupDir}`);
  return { ok: true, id, kind: found.kindOut, removedDir, backupDir };
}
