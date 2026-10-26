/**
 * 扩展管理器 · 控制台注入脚本（由 plugins/extension-manager 安装到 ui/）
 * ═══════════════════════════════════════════════════════════════════════════
 * 干的活：在「技能」/「插件」页的**每张卡片后面**加一颗 🗑 删除按钮。
 *
 * 两种页面结构都要管（都是实测过的）：
 *   ① 应用原生卡片：  #skills-page / #plugins-page → .mcard > .mcard-acts
 *      （原版外观、极光琉璃、深海蓝金都走这条）
 *   ② 女仆主题详情面板： .maid-mod-panel[data-skill-id] > .maid-mod-acts
 *      —— 女仆主题用 CSS 把原生卡片 display:none 藏了，改用自己的"左列表+右详情"，
 *         所以按钮必须也挂进它那个面板，否则用户根本看不到（这就是之前踩过的坑）。
 *
 * ⚠️ 本脚本由 <script defer> 挂在 </head>，执行时机**早于** /app/00-core.js，
 *    所以顶层绝不能调用 uiConfirm / loadModulePage 这些宿主全局函数 ——
 *    一律等点击时再按需取用（那时候页面早就加载完了）。
 *
 * ⚠️ 页面会被宿主反复整块重绘（innerHTML 换掉、主题再装饰一轮），
 *    所以用 MutationObserver 观察两个容器，重绘后自动补挂；按钮带 data-qa-xdel
 *    标记，补挂是幂等的（不会越挂越多）。
 *
 * 点击后的完整链路（全部走宿主自己的公开接口，插件不越权改配置）：
 *    POST /api/skills/extension-manager/action/remove { id, kind }   ← 插件把目录移进备份
 *    POST /api/skills/reload                                        ← 让注册表立刻对齐
 *    GET  /api/skills（轮询到该 id 消失）
 *    POST /api/skills/cleanup { ids:[id] }                          ← 清掉它的开关/设置
 *    刷新当前页列表
 * ═══════════════════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';
  if (window.__qaExtensionManagerHost) return;   // 防重复加载
  window.__qaExtensionManagerHost = true;

  var PLUGIN_ID = 'extension-manager';
  var ACTION_URL = '/api/skills/' + PLUGIN_ID + '/action/remove';
  var PAGES = [
    { box: 'skills-page', kind: 'skill', tab: 'skills', label: '技能' },
    { box: 'plugins-page', kind: 'plugin', tab: 'plugins', label: '插件' }
  ];

  /* ── 小工具 ───────────────────────────────────────────────────────── */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensureStyle() {
    if (document.getElementById('qa-extmgr-style')) return;
    var st = document.createElement('style');
    st.id = 'qa-extmgr-style';
    /* 变量都带兜底值：任何主题下都不会变成看不见的按钮 */
    st.textContent =
      '.qa-xdel{box-sizing:border-box;width:36px;height:36px;padding:0;flex:0 0 auto;'
      + 'border-radius:6px;border:1px solid var(--bd2,rgba(255,255,255,.18));'
      + 'background:var(--bg2,rgba(255,255,255,.06));color:var(--tx2,rgba(255,255,255,.66));'
      + 'display:grid;place-items:center;font-size:16px;line-height:1;cursor:pointer}'
      + '.qa-xdel:hover{background:var(--err,#c0392b);color:#fff;border-color:var(--err,#c0392b)}'
      + '.qa-xdel:disabled{opacity:.45;cursor:default}'
      /* 女仆主题的详情面板里，上传钮是 28px 高，删除钮跟它对齐 */
      + '.maid-mod-acts .qa-xdel{height:28px}';
    (document.head || document.documentElement).appendChild(st);
  }

  function confirmDialog(msg) {
    if (typeof window.uiConfirm === 'function') return window.uiConfirm(msg);
    return Promise.resolve(window.confirm(msg));      // 宿主对话框没就绪时的兜底
  }

  function notify(msg) {
    if (typeof window.uiAlert === 'function') { window.uiAlert(msg); return; }
    window.alert(msg);
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        /* ⚠️ 动作路由在插件返回 ok:false 时回 HTTP 502，真原因在 body 里 ——
           所以先看 body.ok，再看状态码，不能只看状态码 */
        if (data && data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
        if (!res.ok) throw new Error(data && data.error ? data.error : ('HTTP ' + res.status));
        return data;
      });
    });
  }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function listIds() {
    return fetch('/api/skills?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { return ((d && d.skills) || []).map(function (s) { return s.id; }); })
      .catch(function () { return []; });
  }

  /** 等注册表里这个 id 消失（watcher 可能丢事件，所以先主动 reload） */
  function waitGone(id, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 6000);
    var step = function () {
      return listIds().then(function (ids) {
        if (ids.indexOf(id) < 0) return true;
        if (Date.now() > deadline) return false;
        return sleep(300).then(step);
      });
    };
    return step();
  }

  function refreshPage(kind) {
    if (typeof window.loadModulePage === 'function') {
      try { window.loadModulePage(kind, { rescan: true }); return; } catch (e) { /* 落到下面点按钮 */ }
    }
    var meta = kind === 'plugin' ? 'plugins' : 'skills';
    var btn = document.getElementById(meta + '-refresh-btn');
    if (btn) btn.click();
  }

  /* ── 删除流程 ─────────────────────────────────────────────────────── */

  function removeFlow(id, kind, btn) {
    var label = kind === 'plugin' ? '插件' : '技能';
    /* 自己删自己：按钮就是它提供的，删完按钮全没 —— 单独给一句更重的提醒，
       免得用户在不知情的情况下把整套界面拆掉（2026-10-06 实际踩过）。 */
    var isSelf = (id === PLUGIN_ID);
    var msg = isSelf
      ? '⚠️ 这是给卡片提供 🗑 按钮的插件「本身」。\n\n'
        + '删掉之后：所有 🗑 会立刻消失（它会把装进控制台的界面一并摘干净）；\n'
        + '要恢复得把文件夹从 data/removed-extensions/ 搬回 plugins/ 里。\n\n'
        + '确定要删掉它自己吗？'
      : '确定删除' + label + '「' + id + '」？\n\n'
        + '· 文件夹会移到 data/removed-extensions/ 备份，可恢复（不是永久抹掉）\n'
        + '· 同时清掉它的开关与设置\n\n'
        + '删除后这一页会自动刷新。';
    return confirmDialog(msg).then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      var oldTitle = btn.title;
      btn.title = '正在删除…';
      return postJson(ACTION_URL, { id: id, kind: kind })
        .then(function () { return postJson('/api/skills/reload', {}); })
        .then(function () { return waitGone(id, 6000); })
        .then(function () {
          /* 残留配置：目录已经不在注册表里了，宿主自己的清理接口正好干这个 */
          return postJson('/api/skills/cleanup', { ids: [id] }).catch(function () { /* 清不掉不影响主体 */ });
        })
        .then(function () { refreshPage(kind); })
        .catch(function (err) {
          btn.disabled = false;
          btn.title = oldTitle;
          notify('删除失败：' + ((err && err.message) || err));
        });
    });
  }

  function makeButton(id, kind) {
    var label = kind === 'plugin' ? '插件' : '技能';
    var b = el('button', 'qa-xdel', '🗑');
    b.type = 'button';
    b.setAttribute('data-qa-xdel', '1');
    b.setAttribute('aria-label', '删除' + label + ' ' + id);
    b.title = '删除这个' + label + '（移到备份目录，可恢复）';
    b.addEventListener('click', function (e) {
      /* 卡片整体是"点击切换启停"，不加这个会把删除点成开关 */
      e.preventDefault();
      e.stopPropagation();
      if (b.disabled) return;
      removeFlow(id, kind, b);
    });
    return b;
  }

  /* ── 挂按钮（幂等） ───────────────────────────────────────────────── */

  function injectNative(boxId, kind) {
    var box = document.getElementById(boxId);
    if (!box) return;
    var cards = box.querySelectorAll('.mcard');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var id = card.getAttribute('data-skill-id');
      if (!id) continue;
      var acts = card.querySelector('.mcard-acts');
      if (!acts || acts.querySelector('[data-qa-xdel="1"]')) continue;
      acts.appendChild(makeButton(id, kind));
    }
  }

  function injectMaidPanels(boxId, kind) {
    var box = document.getElementById(boxId);
    if (!box) return;
    var panels = box.querySelectorAll('.maid-mod-panel[data-skill-id]');
    for (var i = 0; i < panels.length; i++) {
      var panel = panels[i];
      var id = panel.getAttribute('data-skill-id');
      if (!id) continue;
      var acts = panel.querySelector('.maid-mod-acts');
      if (!acts || acts.querySelector('[data-qa-xdel="1"]')) continue;
      acts.appendChild(makeButton(id, kind));
    }
  }

  function injectAll() {
    ensureStyle();
    for (var i = 0; i < PAGES.length; i++) {
      injectNative(PAGES[i].box, PAGES[i].kind);
      injectMaidPanels(PAGES[i].box, PAGES[i].kind);
    }
  }

  /* ── 触发：DOM 就绪 + 容器变化（宿主与主题都会整块重绘） ───────────── */

  var timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; observe(); injectAll(); }, 120);
  }

  function observe() {
    for (var i = 0; i < PAGES.length; i++) {
      var box = document.getElementById(PAGES[i].box);
      if (!box || box.getAttribute('data-qa-xdel-obs') === '1') continue;
      box.setAttribute('data-qa-xdel-obs', '1');
      try {
        new MutationObserver(schedule).observe(box, { childList: true, subtree: true });
      } catch (e) { /* 老浏览器没有 MutationObserver 也不致命，下面还有兜底轮询 */ }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();

  /* 兜底：主题装饰、页面切换都可能晚于首屏，多补几轮 + 低频巡检 */
  setTimeout(schedule, 600);
  setTimeout(schedule, 1800);
  setInterval(schedule, 4000);
})();
