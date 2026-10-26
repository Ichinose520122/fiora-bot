import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiora-console-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { createRoutes } = await import('../src/routes.js');
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig } = await import('../src/config.js');
const group = 'abcdef0123456789abcdef01';
const user = '123456789abcdef012345678';
const peer = 'fedcba9876543210fedcba98';
const key = `group:${group}`;
const store = new ChatStore();
const memory = new MemoryStore();
setRuntimeConfig({ ...structuredClone(DEFAULT_CONFIG), fiora: { enabled: true },
  allow: { groups: [group], private: [peer] } });
store.appendIncoming(key, { mid: 'm1', senderId: user, senderName: '群友甲', text: 'Fiora 历史消息' });
store.appendIncoming(`private:${peer}`, { mid: 'm2', senderId: peer, senderName: '好友乙', text: 'Fiora 私聊消息' });
store.appendIncoming('group:123456', { mid: 3, senderId: '987654', senderName: 'QQ 群友', text: '旧 QQ 存档' });
memory.editMemberImpression(key, { userId: user, name: '群友甲', impressions: ['喜欢聊天'] });
memory.editMemberImpression('group:123456', { userId: '987654', name: 'QQ 群友', impressions: ['原有记忆'] });
const consolidated = [];
const onebot = { platform: 'fiora', allowedGroupIds: [group],
  getChatName: async (kind) => kind === 'group' ? '测试放映室' : '好友乙',
  call: async (action, params) => {
    assert.equal(action, 'get_group_member_list');
    assert.equal(params.group_id, group);
    return [{ user_id: user, nickname: '群友甲', card: '群友甲' }];
  } };
const session = { id: 'session-1', chatKey: key, startedAt: Date.now(), endedAt: Date.now(), status: 'done',
  rounds: 1, usage: {}, triggerSummary: '测试', messages: [], sent: [] };
const orchestrator = { consolidating: new Set(), getChatName: async () => '测试放映室',
  consolidateMemoryForChat: async (chatKey, options) => { consolidated.push({ chatKey, ...options }); return {}; } };
const routes = createRoutes({ store, memory, onebot, orchestrator,
  sessions: { listSummaries: () => [session], get: () => session },
  emit: () => {}, readBody: async (req) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }, sanitizeConfig: (cfg) => cfg });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (_res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = typeof route.pattern === 'string' ? route.pattern === url.pathname : route.pattern.exec(url.pathname);
    if (!match) continue;
    try { await route.handler({ req, res, json, url, match }); }
    catch (error) { json(res, 500, { error: error.message }); }
    return;
  }
  json(res, 404, { error: 'not found' });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function request(url, method = 'GET', body) {
  const response = await fetch(`${origin}${url}`, { method,
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  assert(path.resolve(dataDir).startsWith(path.join(os.tmpdir(), 'fiora-console-test-')));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('restart discovers Fiora group/private archives and memories alongside QQ numeric IDs', () => {
  assert.deepEqual(new Set(new ChatStore().listChats()), new Set([key, `private:${peer}`, 'group:123456']));
  assert.deepEqual(new Set(new MemoryStore().listChats()), new Set([key, 'group:123456']));
  assert.equal(new MemoryStore().members(key)[0].userId, user);
});

test('real console routes read archives, edit/delete memory and preserve string member IDs', async () => {
  const chats = await request('/api/chats');
  assert.equal(chats.body.chats.find((c) => c.key === key).chatName, '测试放映室');
  assert.equal(chats.body.chats.find((c) => c.key === `private:${peer}`).chatName, '好友乙');
  const archive = await request(`/api/chats/group_${group}/messages`);
  assert.equal(archive.status, 200);
  assert.equal(archive.body.messages[0].text, 'Fiora 历史消息');
  const edit = await request(`/api/memory-files/group_${group}/members/${user}`, 'PUT',
    { name: '群友甲', impressions: ['更新后的记忆'] });
  assert.equal(edit.status, 200);
  assert.equal((await request(`/api/memory-files/group_${group}`)).body.members[0].impressions[0].content, '更新后的记忆');
  assert.equal((await request(`/api/groups/${group}/members`)).body.members[0].userId, user);
  const result = await request('/api/memory-files/consolidate', 'POST', { chatKey: key, userIds: [user] });
  assert.equal(result.status, 202);
  assert.deepEqual(consolidated[0].userIds, [user]);
  assert.equal((await request('/api/chats/group_123456/messages')).status, 200);
  const otherUser = 'eeeeeeeeeeeeeeeeeeeeeeee';
  assert.equal((await request(`/api/memory-files/group_${group}/members/${otherUser}`, 'PUT',
    { name: '成员二', impressions: ['临时测试记忆'] })).status, 200);
  assert.equal((await request(`/api/memory-files/group_${group}/members/${otherUser}`, 'DELETE')).status, 200);
  assert(!memory.members(key).some((member) => member.userId === otherUser));
  assert.equal((await request('/api/memory-files/group_123456/members/987654', 'PUT',
    { name: 'QQ 群友', impressions: ['QQ 记忆仍可编辑'] })).status, 200);
  assert.throws(() => memory.editMemberImpression(key, { userId: '../escape', impressions: [] }), /用户 ID/);
  assert.equal((await request(`/api/memory-files/group_${group}/members/../x`, 'PUT', {})).status, 404);
});

test('memory list includes archived Fiora chats before their first memory has been written', async () => {
  const result = await request('/api/memory-files');
  assert(result.body.files.some((f) => f.chatKey === `private:${peer}` && f.impressionCount === 0));
});

test('actual console scripts render Fiora sessions, archives and memory edit forms', async () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: origin, runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.ResizeObserver = class { observe() {} disconnect() {} };
    w.fetch = (url, options) => fetch(new URL(url, origin), options);
    Object.assign(w, await import('../src/tier-slider.js'));
    w.matchPriceTable = () => null;
    for (const name of ['00-core', '01-boot', '02-sse-sessions', '04-archive-usage', '05-memory-settings', '06-settings-render', '07-settings-events', '08-modals']) {
      vm.runInContext(fs.readFileSync(new URL(`../ui/app/${name}.js`, import.meta.url), 'utf8'), dom.getInternalVMContext(), { filename: name });
    }
    await w.loadChats();
    await w.selectChat(key);
    assert.match(w.document.querySelector('#chat-items').textContent, /测试放映室/);
    assert.match(w.document.querySelector('#chat-detail').textContent, /Fiora 历史消息/);
    await w.loadSessions();
    assert.match(w.document.querySelector('#session-items').textContent, /测试放映室/);
    await w.loadMemoryView();
    await w.loadMemoryDetail(key);
    assert.match(w.document.querySelector('#memory-detail').textContent, /更新后的记忆/);
    w.document.querySelector('.mem-edit-imp').click();
    assert.equal(w.document.querySelector('#mi-qq').value, user);
    w.document.querySelector('#mi-imps').value = '通过控制台保存的记忆';
    w.document.querySelector('#mi-save').click();
    for (let n = 0; n < 100 && memory.members(key)[0].impressions[0].content !== '通过控制台保存的记忆'; n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(memory.members(key)[0].impressions[0].content, '通过控制台保存的记忆');
  } finally { dom.window.close(); }
});
