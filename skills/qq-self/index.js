import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const appRoot = globalThis.__qqAgentRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { DATA_DIR, getConfig, updateConfig } = await import(pathToFileURL(path.join(appRoot, 'src/config.js')).href);
const { validateImageUrl } = await import(pathToFileURL(path.join(appRoot, 'src/safe-fetch.js')).href);
const { localStickerPath } = await import(pathToFileURL(path.join(appRoot, 'src/sticker-manager.js')).href);
const mediaTools = await import(pathToFileURL(path.join(appRoot, 'plugins/image-ref-hint/media-recovery.mjs')).href).catch(() => null);
const shared = globalThis.__qqAgentSelfExpressionV1 ||= { tails: new Map() };
const RIGHTS = { public: 1, friends: 4, self: 64 };
const day = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const reply = (v, isError = false) => ({ content: JSON.stringify(v), ...(isError ? { isError: true } : {}) });
const integer = (v, fallback, max) => Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.floor(Number(v)))) : fallback;
const text = (v, name, max, empty = false) => {
  if (typeof v !== 'string' || (!empty && !v.trim())) throw new Error(`${name}不能为空`);
  if ([...v].length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)) throw new Error(`${name}过长或包含控制字符`);
  return v.trim();
};

// Dependencies are injectable for isolated tests. Production uses only the bot's native client.
export function createService({ settings, globalConfig, syncNickname, stateFile, checkActive = () => true,
  validateUrl, stickerPath = () => null, recoverMedia = null, now = Date.now, queue = shared.tails }) {
  const cfg = () => {
    const c = settings() || {};
    return { autonomous: c.autonomous !== false, allowPublish: c.allowPublish !== false,
      allowProfile: c.allowProfile !== false, allowAvatar: c.allowAvatar !== false,
      defaultVisibility: RIGHTS[c.defaultVisibility] ? c.defaultVisibility : 'friends',
      postCooldownMinutes: integer(c.postCooldownMinutes, 30, 1440), postDailyLimit: integer(c.postDailyLimit, 6, 100),
      profileCooldownMinutes: integer(c.profileCooldownMinutes, 60, 1440), maxChars: integer(c.maxChars, 600, 5000) || 600,
      dryRun: c.dryRun === true };
  };
  function load() {
    if (!fs.existsSync(stateFile)) return { version: 1, accounts: {} };
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s.version !== 1 || !s.accounts || typeof s.accounts !== 'object') throw new Error('操作记录损坏，暂停写操作');
    return s;
  }
  function save(s) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temp = `${stateFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(temp, stateFile);
  }
  function identity(ctx) {
    const id = String(ctx?.onebot?.selfId || '');
    if (!/^\d+$/.test(id) || ctx.onebot.connected === false) throw new Error('机器人尚未连接到 QQ');
    if (ctx.selfId && String(ctx.selfId) !== id) throw new Error('会话账号与登录账号不一致');
    return id;
  }
  function enabled(ctx) {
    const core = globalConfig() || {};
    if (!checkActive(ctx) || core.tools?.enabled === false || core.tools?.categories?.media === false) {
      throw new Error('空间与个人资料功能已关闭');
    }
  }
  async function call(ctx, action, params, timeout = 15000) {
    const data = await ctx.onebot.call(action, params, timeout);
    // Some bridges expose a second business status inside OneBot data.
    if (data && typeof data === 'object' && ((data.result != null && Number(data.result) !== 0)
      || (data.retcode != null && Number(data.retcode) !== 0))) throw new Error('协议端返回业务错误');
    return data;
  }
  const uncertain = (e) => /timeout|超时|abort|请求失败|network|fetch failed|ECONN|HTTP 5/i.test(String(e?.message || e));
  const humanError = (e) => uncertain(e) ? '请求超时或连接中断，结果未确认' :
    /retcode|HTTP|协议端/i.test(String(e?.message || e)) ? 'QQ 接口拒绝了操作' : String(e?.message || e).slice(0, 160);
  async function exclusive(ctx, fn) {
    try {
      const id = identity(ctx);
      const before = queue.get(id) || Promise.resolve();
      const current = before.catch(() => {}).then(() => { enabled(ctx); return fn(id); });
      queue.set(id, current);
      try { return await current; } finally { if (queue.get(id) === current) queue.delete(id); }
    } catch (e) { return reply({ ok: false, error: humanError(e) }, true); }
  }
  function account(s, id) {
    return s.accounts[id] ||= { events: [] };
  }
  function events(a) {
    a.events = (a.events || []).filter((e) => e.at > now() - 7 * 86400000).slice(-200);
    return a.events;
  }
  function quota(a, kind, c) {
    const recent = events(a).filter((e) => e.kind === kind && e.status !== 'failed');
    const last = recent.at(-1);
    const cooldown = kind === 'post' ? c.postCooldownMinutes : c.profileCooldownMinutes;
    if (last && now() - last.at < cooldown * 60000) throw new Error(`操作太密，约${Math.ceil((cooldown * 60000 - now() + last.at) / 60000)}分钟后可再用`);
    if (kind === 'post' && c.postDailyLimit && recent.filter((e) => day(e.at) === day(now())).length >= c.postDailyLimit) {
      throw new Error(`今天已达到${c.postDailyLimit}条动态的设置上限`);
    }
  }
  async function publicUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('图片地址不合法');
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('仅允许公开 http(s) 图片链接');
    // This helper checks DNS/private addresses through the core's existing image policy.
    return validateUrl(u.toString());
  }
  async function imageRefs(ctx, args, avatar = false) {
    const out = [];
    if (args.imageUrls != null && (!Array.isArray(args.imageUrls) || args.imageUrls.length > 9)) throw new Error('图片链接最多9张');
    for (const u of args.imageUrls || []) out.push(await publicUrl(u));
    if (args.imageUrl != null) out.push(await publicUrl(args.imageUrl));
    const ids = args.stickerId ? [args.stickerId] : (args.stickerIds || []);
    if (!Array.isArray(ids) || ids.length > 9) throw new Error('表情最多9张');
    for (const id of ids) {
      if (typeof id !== 'string') throw new Error('表情id格式不对');
      const st = await ctx.stickers?.find(id);
      if (!st?.url) throw new Error(`没有找到表情${id}`);
      const p = stickerPath(st.url);
      out.push(p ? pathToFileURL(p).href : await publicUrl(st.url));
    }
    if (args.messageId != null) {
      if (!/^-?\d+$/.test(String(args.messageId))) throw new Error('消息id必须来自当前聊天记录');
      const entry = ctx.store?.findByMid(ctx.chatKey, String(args.messageId));
      const imgs = (entry?.media || []).filter((m) => m.kind === 'image');
      if (!imgs.length) throw new Error('当前会话的该消息没有图片');
      if (recoverMedia) {
        // Preserve original GIF/image bytes for Qzone instead of publishing extracted vision frames.
        const recovered = await recoverMedia(imgs, ctx.onebot);
        if (recovered.length !== imgs.length) throw new Error('聊天图片获取失败，请换一张已收藏表情或可用图片');
        const dir = path.join(path.dirname(stateFile), 'media');
        fs.mkdirSync(dir, { recursive: true });
        for (const r of recovered) {
          if (!Buffer.isBuffer(r.buffer) || !r.buffer.length || r.buffer.length > 6 * 1024 * 1024) throw new Error('图片内容或大小不符合要求');
          const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[r.mime];
          if (!ext) throw new Error('不支持的图片格式');
          const file = path.join(dir, createHash('sha256').update(r.buffer).digest('hex') + '.' + ext);
          fs.writeFileSync(file, r.buffer); out.push(pathToFileURL(file).href);
        }
        for (const name of fs.readdirSync(dir)) {
          if (!/^[a-f0-9]{64}\.(jpg|png|gif|webp)$/.test(name)) continue;
          const file = path.join(dir, name);
          if (fs.statSync(file).mtimeMs < now() - 7 * 86400000) fs.unlinkSync(file);
        }
      } else {
        for (const m of imgs) {
          let u = m.url;
          if (!u && m.file) u = (await call(ctx, 'get_image', { file: String(m.file) }))?.url;
          if (!u) throw new Error('聊天图片地址不可用');
          out.push(await publicUrl(u));
        }
      }
    }
    const refs = [...new Set(out)];
    if (refs.length > 9 || (avatar && refs.length !== 1)) throw new Error(avatar ? '头像需要明确指定一张图片' : '合计最多9张图片');
    return refs;
  }
  async function profile(ctx, id) {
    const p = await call(ctx, 'get_stranger_info', { user_id: Number(id), no_cache: true });
    return { nickname: p?.nickname || '', signature: p?.long_nick ?? p?.longNick ?? '', sex: p?.sex ?? 'unknown' };
  }
  async function posts(ctx) {
    const p = await call(ctx, 'get_qzone_msg_list', { pos: 0, num: 10 });
    return { total: p?.total ?? 0, posts: (p?.msglist || []).slice(0, 10).map((m) => ({
      tid: String(m.tid || ''), content: String(m.content || '').slice(0, 1500), time: m.time, images: m.images || []
    })) };
  }
  async function reconcile(ctx, a) {
    const unresolved = events(a).filter((e) => e.kind === 'post' && ['pending', 'unknown'].includes(e.status));
    if (!unresolved.length) return;
    const recent = await posts(ctx);
    for (const e of unresolved) {
      const match = recent.posts.find((p) => p.content === e.content && p.tid && Number(p.time) * 1000 >= e.at - 120000);
      if (match) { e.status = 'ok'; e.tid = match.tid; e.verified = true; }
    }
  }
  async function write(ctx, id, kind, payload, action, params, c, details = {}) {
    const s = load(), a = account(s, id);
    if (kind === 'post') {
      try { await reconcile(ctx, a); } catch { /* Keep unknown entries protected. */ }
    }
    const hash = digest(payload);
    const prior = events(a).filter((e) => e.kind === kind && e.status !== 'failed');
    // A profile may be deliberately restored to an earlier nickname/avatar.
    const duplicate = kind === 'post' ? prior.findLast((e) => e.hash === hash)
      : (prior.at(-1)?.hash === hash ? prior.at(-1) : null);
    if (duplicate) {
      save(s);
      return reply({ ok: duplicate.status === 'ok', duplicate: true, status: duplicate.status,
        tid: duplicate.tid || null, message: duplicate.status === 'ok' ? '已执行过相同操作，本次不重复' : '上次结果未知，先核查 QQ 状态，不自动重发' }, duplicate.status !== 'ok');
    }
    if (c.dryRun) return reply({ ok: true, dryRun: true, action, params, message: '仅预览，未发布或修改' });
    quota(a, kind, c);
    const e = { kind, at: now(), hash, status: 'pending', ...details };
    a.events.push(e);
    // Persist intent before a non-idempotent call, including across restarts/hot reloads.
    save(s);
    let result;
    try {
      result = await call(ctx, action, params, action === 'send_qzone_msg' || action === 'set_qq_avatar' ? 90000 : 30000);
    } catch (err) {
      e.status = uncertain(err) ? 'unknown' : 'failed'; save(s);
      return reply({ ok: false, status: e.status, error: humanError(err), retryAutomatically: false }, true);
    }
    e.status = 'ok';
    e.tid = result?.tid ? String(result.tid) : undefined;
    e.verified = Boolean(e.tid);
    save(s);
    return { s, a, e, result };
  }
  return {
    get_self_state(ctx) {
      return exclusive(ctx, async (id) => {
        const s = load(), a = account(s, id);
        const result = { ok: true, selfId: id, settings: cfg() };
        try { result.profile = await profile(ctx, id); } catch (e) { result.profileError = humanError(e); }
        try { await reconcile(ctx, a); result.space = await posts(ctx); } catch (e) { result.spaceError = humanError(e); }
        result.recentActions = events(a).map(({ kind, at, status, tid }) => ({ kind, at, status, tid })).slice(-8);
        result.postsToday = events(a).filter((e) => e.kind === 'post' && e.status !== 'failed' && day(e.at) === day(now())).length;
        save(s); return reply(result);
      });
    },
    publish_dynamic(ctx, args = {}) {
      return exclusive(ctx, async (id) => {
        const c = cfg(); if (!c.allowPublish) throw new Error('发布动态已关闭');
        const content = text(args.content, '动态正文', c.maxChars);
        const visibility = args.visibility ?? c.defaultVisibility;
        if (!RIGHTS[visibility]) throw new Error('可见范围只能是friends/public/self');
        const images = await imageRefs(ctx, args);
        const params = { content, ugc_right: RIGHTS[visibility], ...(images.length ? { images } : {}) };
        const r = await write(ctx, id, 'post', params, 'send_qzone_msg', params, c, { content });
        if (r.content) return r;
        return reply({ ok: true, status: 'ok', tid: r.e.tid || null, visibility,
          message: 'QQ接口确认发布成功。自主发布不用向群里复述。' });
      });
    },
    update_profile(ctx, args = {}) {
      return exclusive(ctx, async (id) => {
        const c = cfg(); if (!c.allowProfile) throw new Error('修改资料已关闭');
        const p = {};
        if (args.nickname != null) p.nickname = text(args.nickname, '昵称', 16);
        if (args.signature != null) p.personal_note = text(args.signature, '签名', 80, true);
        if (args.sex != null) { if (![0, 1, 2].includes(args.sex)) throw new Error('性别只能是0/1/2'); p.sex = args.sex; }
        if (!Object.keys(p).length) throw new Error('请提供要修改的资料');
        const r = await write(ctx, id, 'profile', p, 'set_qq_profile', p, c);
        if (r.content) return r;
        // Update mention matching immediately; keep role text and the stable botName intact.
        let nicknameSyncError = false;
        if (p.nickname) {
          ctx.onebot.selfInfo = { ...ctx.onebot.selfInfo, user_id: Number(id), nickname: p.nickname };
          try { syncNickname(p.nickname); } catch { nicknameSyncError = true; }
        }
        let readback = null;
        try { readback = await profile(ctx, id); } catch { /* Acknowledged, readback unavailable. */ }
        const sexCode = { unknown: 0, male: 1, female: 2 };
        const verified = Boolean(readback) && (p.nickname == null || readback.nickname === p.nickname)
          && (p.personal_note == null || readback.signature === p.personal_note)
          && (p.sex == null || (sexCode[readback.sex] ?? Number(readback.sex)) === p.sex);
        r.e.verified = verified; save(r.s);
        return reply({ ok: true, acknowledged: true, verified, readback, nicknameSyncError,
          message: verified ? '资料已修改并回读确认' : 'QQ已接受资料修改，回读尚未确认，可能有缓存延迟' });
      });
    },
    set_avatar(ctx, args = {}) {
      return exclusive(ctx, async (id) => {
        const c = cfg(); if (!c.allowAvatar) throw new Error('修改头像已关闭');
        const refs = await imageRefs(ctx, args, true);
        const p = { file: refs[0] };
        const r = await write(ctx, id, 'profile', p, 'set_qq_avatar', p, c);
        if (r.content) return r;
        return reply({ ok: true, acknowledged: true, verified: false, message: 'QQ接口已接受新头像，请以QQ客户端展示为准' });
      });
    }
  };
}

export function setup(api) {
  const service = createService({ settings: api.config, globalConfig: getConfig,
    syncNickname: (nickname) => updateConfig({ persona: { selfNickname: nickname } }),
    stateFile: path.join(DATA_DIR, 'qq-self', 'state.json'), checkActive: (ctx) => api.isSkillActive('qq-self', ctx),
    validateUrl: mediaTools?.validateMediaUrl || validateImageUrl, stickerPath: localStickerPath,
    recoverMedia: mediaTools ? (imgs, onebot) => mediaTools.recoverImages(appRoot, imgs, onebot) : null });
  const imageProps = {
    messageId: { type: 'string', description: '当前聊天里明确允许公开的图片消息id，勿猜造' },
    stickerIds: { type: 'array', items: { type: 'string' }, description: '自己的表情id，从list_stickers取得，最多9个' },
    imageUrls: { type: 'array', items: { type: 'string' }, description: '已核对内容和公开授权的图片链接，最多9个' }
  };
  const defs = [
    ['get_self_state', '查看自己的空间与资料', '查看自己当前昵称、签名、最近动态和操作记录；发表前检查重复，结果未知时先查状态。', {}],
    ['publish_dynamic', '自主发布QQ动态', '小鲸鱼可按当前人设自行发文字/带图说说，无需逐次征求许可，也可响应明确要求。默认好友可见。不自动搬运私人群聊。', {
      content: { type: 'string', description: '自己的动态正文，通常1~3句' },
      visibility: { type: 'string', enum: ['friends', 'public', 'self'], description: '可见范围，默认friends' }, ...imageProps
    }],
    ['update_profile', '修改自己的QQ资料', '按当前人设打理自己的QQ昵称、签名和性别，不需要逐次询问管理员。只操作自己，不改变角色卡。', {
      nickname: { type: 'string', description: '新的显示昵称，最多16字符' },
      signature: { type: 'string', description: '个性签名，最多80字符；空串可清空' },
      sex: { type: 'integer', enum: [0, 1, 2], description: '0未知，1男，2女' }
    }],
    ['set_avatar', '修改自己的QQ头像', '使用已看过的自己的表情或明确允许公开的图片换头像，三种来源选一个。只修改机器人自己。', {
      messageId: imageProps.messageId,
      stickerId: { type: 'string', description: '自己的表情id，来自list_stickers' },
      imageUrl: { type: 'string', description: '一张已核对的公开图片链接' }
    }]
  ];
  for (const [id, name, description, properties] of defs) api.registerTool({
    id, name, description, category: 'media', icon: '🐳', parameters: {
      type: 'object', properties, additionalProperties: false, ...(id === 'publish_dynamic' ? { required: ['content'] } : {})
    }, execute: service[id]
  });
}

export function promptSections() {
  const c = getConfig()?.skills?.['qq-self']?.settings || {};
  return [{ id: 'qq-self-live-policy', title: '空间当前设置', priority: 76,
    content: `当前自主使用${c.autonomous === false ? '关闭：只响应明确要求' : '已授权：有想分享的内容可自主发布，资料和头像也可自行打理'}。默认可见范围${c.defaultVisibility || 'friends'}。开关和频率限制以qq-self__get_self_state返回的实时设置为准。` }];
}
