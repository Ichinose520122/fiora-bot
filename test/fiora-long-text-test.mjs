import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { FioraClient } from '../src/fiora-client.js';
import { SendQueue } from '../src/sender.js';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { splitForQQ, splitForFiora } from '../src/md-to-plain.js';

const groupId = 'c'.repeat(24);
const botId = 'b'.repeat(24);
const peerId = 'a'.repeat(24);

async function gateway(t, { websocket = false, omitFirstAck = false, rejectHttpAt = 0 } = {}) {
  const frames = [];
  const requests = [];
  let firstFrameResolve;
  const firstFrame = new Promise((resolve) => { firstFrameResolve = resolve; });
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    requests.push(data);
    const invalid = (data.type === 'text' && (data.content.length > 2048 || !data.content.trim())) || requests.length === rejectHttpAt;
    res.writeHead(invalid ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(invalid ? { error: 'rejected chunk' } : { id: `http-${requests.length}` }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'ready', user: { id: botId }, scope: {} }));
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.action !== 'send') return;
      frames.push(data);
      firstFrameResolve(data);
      if (omitFirstAck && frames.length === 1) return;
      ws.send(JSON.stringify(data.type === 'text' && (data.content.length > 2048 || !data.content.trim())
        ? { type: 'error', requestId: data.requestId, error: 'over limit' }
        : { type: 'sent', requestId: data.requestId, id: `ws-${frames.length}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new FioraClient({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'test', log() {} });
  client.selfId = botId;
  t.after(async () => {
    await client.close();
    for (const ws of wss.clients) ws.terminate();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    wss.close();
  });
  if (websocket) assert.equal(await client.connect(), true);
  return { client, frames, requests, firstFrame };
}

function assertChunks(chunks, original, max = 2048) {
  assert.equal(chunks.join(''), original);
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0 && chunk.length <= max, `chunk length ${chunk.length} exceeds ${max}`);
    assert.equal(chunk.isWellFormed(), true);
  }
}

test('UTF-16 splitting respects newline and surrogate boundaries without losing content', () => {
  for (const text of [
    'a'.repeat(2048), 'a'.repeat(2049), 'a'.repeat(3000), 'a'.repeat(5000),
    `${'a'.repeat(2048)}\nb`, `${'a'.repeat(2047)}\nb`,
    `${'a'.repeat(2047)}😀${'b'.repeat(2049)}`, '😀'.repeat(2500),
  ]) assertChunks(splitForQQ(text, 2048), text);
  assert.deepEqual(splitForQQ(`${'a'.repeat(2048)}\nb`, 2048).map((s) => s.length), [2048, 2]);
  assert.deepEqual(splitForQQ(`${'a'.repeat(2047)}\nb`, 2048).map((s) => s.length), [2048, 1]);
  for (const text of [`${'a'.repeat(2048)}\n`, `${'a'.repeat(2046)}😀\n`]) {
    const chunks = splitForFiora(text);
    assertChunks(chunks, text);
    assert.ok(chunks.every((chunk) => chunk.trim()));
  }
  assert.throws(() => splitForFiora(`a${' '.repeat(6000)}b`), /纯空白/);
});

for (const websocket of [false, true]) {
  test(`direct Fiora text entry points split in order over ${websocket ? 'WebSocket' : 'HTTP'}`, async (t) => {
    const { client, requests, frames } = await gateway(t, { websocket });
    assert.equal(client.maxTextLength, 2048);
    const received = websocket ? frames : requests;
    const inputs = [
      [() => client.sendText('group', groupId, 'a'.repeat(3000)), 'a'.repeat(3000), groupId],
      [() => client.sendGroupMsg(groupId, 'b'.repeat(5000)), 'b'.repeat(5000), groupId],
      [() => client.sendPrivateMsg(peerId, 'c'.repeat(2049)), 'c'.repeat(2049), peerId + botId],
      [() => client.sendSegments('group', groupId, [{ type: 'text', data: { text: 'd'.repeat(3000) } }]), 'd'.repeat(3000), groupId],
      [() => client.sendRaw(groupId, `${'x'.repeat(2047)}😀${'y'.repeat(2500)}`), `${'x'.repeat(2047)}😀${'y'.repeat(2500)}`, groupId],
      [() => client.sendGroupMsg(groupId, 'e'.repeat(2048)), 'e'.repeat(2048), groupId],
      [() => client.sendRaw(groupId, `${'a'.repeat(2048)}\n`), `${'a'.repeat(2048)}\n`, groupId],
    ];
    for (const [send, text, conversationId] of inputs) {
      const start = received.length;
      const result = await send();
      const chunks = received.slice(start);
      assertChunks(chunks.map((f) => f.content), text);
      assert.ok(chunks.every((f) => f.conversationId === conversationId && f.type === 'text'));
      assert.equal(new Set(chunks.map((f) => f.requestId)).size, chunks.length);
      assert.equal(result.message_id, `${websocket ? 'ws' : 'http'}-${received.length}`);
      if (chunks.length > 1) {
        assert.deepEqual(result.sent.map((s) => s.content), chunks.map((f) => f.content));
        assert.equal(result.sent.at(-1).message_id, result.message_id);
      }
    }
    const start = received.length;
    await client.sendSegments('group', groupId, [
      { type: 'text', data: { text: 'f'.repeat(3000) } },
      { type: 'image', data: { file: '/ImageMessage/existing.png' } },
      { type: 'text', data: { text: 'g'.repeat(2049) } },
    ]);
    const mixed = received.slice(start);
    assert.deepEqual(mixed.map((f) => f.type), ['text', 'text', 'image', 'text', 'text']);
    assertChunks(mixed.slice(0, 2).map((f) => f.content), 'f'.repeat(3000));
    assertChunks(mixed.slice(3).map((f) => f.content), 'g'.repeat(2049));
  });
}

test('a split WS send reuses its chunk requestId for HTTP fallback', async (t) => {
  const { client, requests, frames, firstFrame } = await gateway(t, { websocket: true, omitFirstAck: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sending = client.sendText('group', groupId, 'z'.repeat(3000));
  await firstFrame;
  t.mock.timers.tick(15000);
  const result = await sending;
  assert.equal(requests.length, 1);
  assert.equal(frames.length, 2);
  assert.equal(requests[0].requestId, frames[0].requestId);
  assert.equal(requests[0].content, frames[0].content);
  assert.notEqual(frames[1].requestId, frames[0].requestId);
  assert.deepEqual(result.sent.map((s) => s.message_id), ['http-1', 'ws-2']);
  assertChunks(frames.map((f) => f.content), 'z'.repeat(3000));
  t.mock.timers.reset();
});

test('unusable whitespace-only chunks fail before direct or queued text is sent', async (t) => {
  const { client, requests } = await gateway(t);
  const text = `a${' '.repeat(6000)}b`;
  await assert.rejects(client.sendRaw(groupId, text), /纯空白/);
  const cfg = structuredClone(DEFAULT_CONFIG);
  setRuntimeConfig(cfg);
  const queue = new SendQueue({ onebot: client, store: { appendSelf() { assert.fail('nothing should be archived'); } } });
  await assert.rejects(queue.sendTextBatch(`group:${groupId}`, ['valid first message', text]), /纯空白/);
  assert.equal(requests.length, 0);
});

test('a failed direct chunk stops later chunks and exposes successful receipts', async (t) => {
  const { client, requests } = await gateway(t, { rejectHttpAt: 2 });
  await assert.rejects(client.sendRaw(groupId, 'x'.repeat(6000)), (error) => {
    assert.equal(error.message, 'rejected chunk');
    assert.deepEqual(error.sent, [{ content: 'x'.repeat(2048), message_id: 'http-1' }]);
    return true;
  });
  assert.equal(requests.length, 2);
});

test('queue caps old Fiora configs, retains smaller preferences, logs each actual chunk and dedupes original messages', async (t) => {
  const { client, requests } = await gateway(t);
  for (const hardSplitAt of [4000, 0, 1000]) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.send, { hardSplitAt, minGapMs: 200, maxGapMs: 200, byLengthMs: 0.001, maxPerMinute: 1000, maxPerHour: 1000 });
    setRuntimeConfig(cfg);
    const archived = [];
    const events = [];
    const queue = new SendQueue({ onebot: client, store: { appendSelf: (key, entry) => archived.push({ key, ...entry }) }, onSent: (event) => events.push(event) });
    // Deliberately identical chunks: content-based chunk dedupe would silently drop these.
    for (const text of ['a'.repeat(3000), 'b'.repeat(6000)]) {
      const start = requests.length;
      const archiveStart = archived.length;
      const result = await queue.sendTextBatch(`group:${groupId}`, text);
      const chunks = requests.slice(start);
      assertChunks(chunks.map((f) => f.content), text, hardSplitAt === 1000 ? 1000 : 2048);
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.sent.map((s) => s.text), chunks.map((f) => f.content));
      assert.deepEqual(archived.slice(archiveStart).map((s) => s.text), chunks.map((f) => f.content));
      assert.deepEqual(archived.slice(archiveStart).map((s) => s.mid), result.sent.map((s) => s.messageId));
      const deduped = await queue.sendTextBatch(`group:${groupId}`, text);
      assert.ok(deduped.sent.every((s) => s.deduped));
      assert.equal(requests.length, start + chunks.length);
      assert.equal(archived.length, archiveStart + chunks.length);
    }
    assert.equal(events.length, archived.length);
  }
});

test('OneBot retains its 4000 preference and explicit no-split config', async () => {
  for (const hardSplitAt of [4000, 0]) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.send, { hardSplitAt, minGapMs: 200, maxGapMs: 200, byLengthMs: 0.001 });
    setRuntimeConfig(cfg);
    const texts = [];
    const queue = new SendQueue({
      onebot: { sendText: async (kind, id, text) => { texts.push(text); return { message_id: texts.length }; } },
      store: { appendSelf() {} },
    });
    await queue.sendTextBatch('group:123', 'a'.repeat(5000));
    assertChunks(texts, 'a'.repeat(5000), hardSplitAt || 5000);
    assert.deepEqual(texts.map((s) => s.length), hardSplitAt ? [4000, 1000] : [5000]);
  }
});
