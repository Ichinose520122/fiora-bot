import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { FioraClient, getFioraRuntimeHeaders } from '../src/fiora-client.js';

const groupId = 'c'.repeat(24);
const botId = 'b'.repeat(24);

test('runtime metadata distinguishes Docker from native bot processes', () => {
  assert.deepEqual(getFioraRuntimeHeaders('linux', { FIORA_BOT_RUNTIME: 'docker' }), {
    'X-Fiora-Bot-Platform': 'linux', 'X-Fiora-Bot-Runtime': 'docker',
  });
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.deepEqual(getFioraRuntimeHeaders(platform, {}), {
      'X-Fiora-Bot-Platform': platform, 'X-Fiora-Bot-Runtime': 'native',
    });
  }
});

test('FioraClient connects via WebSocket, initializes identity, receives and sends messages and images', async () => {
  const receivedWsFrames = [];

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url: '/ImageMessage/http_uploaded.png' }));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.pathname, '/api/bot/v1/ws');
    assert.equal(url.searchParams.get('token'), 'test_token');
    assert.equal(req.headers['x-fiora-bot-platform'], process.platform);
    assert.equal(req.headers['x-fiora-bot-runtime'], process.env.FIORA_BOT_RUNTIME === 'docker' ? 'docker' : 'native');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  let serverWs = null;
  wss.on('connection', (ws) => {
    serverWs = ws;
    ws.send(JSON.stringify({
      type: 'ready',
      user: { id: botId, name: '大肥鱼' },
      scope: { allowedGroupIds: [groupId], allowPrivate: true }
    }));

    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      receivedWsFrames.push(data);
      if (data.action === 'upload_image') {
        ws.send(JSON.stringify({
          type: 'uploaded',
          url: '/ImageMessage/test_ws_uploaded.png',
          requestId: data.requestId
        }));
      } else if (data.action === 'send') {
        ws.send(JSON.stringify({
          type: 'sent',
          id: 'msg_created_999',
          conversationId: data.conversationId,
          requestId: data.requestId
        }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const events = [];
  const client = new FioraClient({
    url: `http://127.0.0.1:${port}`,
    apiKey: 'test_token',
    onEvent: (ev) => events.push(ev),
    log: () => {}
  });

  const ok = await client.connect();
  assert.equal(ok, true);
  assert.equal(client.connected, true);

  // Allow ready frame to process
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(client.selfId, botId);
  assert.equal(client.selfNickname, '大肥鱼');
  assert.deepEqual(client.allowedGroupIds, [groupId]);

  // 1. Simulate incoming text message with @大肥鱼 and emotion #(滑稽)
  serverWs.send(JSON.stringify({
    type: 'message.created',
    message: {
      id: 'm_100',
      conversationId: groupId,
      user: { id: 'user_456', name: '群友小王' },
      type: 'text',
      content: '@大肥鱼 早上好呀 #(滑稽)',
      createdAt: new Date().toISOString()
    }
  }));

  // 2. Simulate incoming image message from Fiora
  serverWs.send(JSON.stringify({
    type: 'message.created',
    message: {
      id: 'm_101',
      conversationId: groupId,
      user: { id: 'user_456', name: '群友小王' },
      type: 'image',
      content: '/ImageMessage/user_upload_123.png',
      createdAt: new Date().toISOString()
    }
  }));

  // 3. Simulate incoming file message from Fiora
  serverWs.send(JSON.stringify({
    type: 'message.created',
    message: {
      id: 'm_102',
      conversationId: groupId,
      user: { id: 'user_789', name: '群友小李' },
      type: 'file',
      content: JSON.stringify({ name: 'homework.zip', size: 10240 }),
      createdAt: new Date().toISOString()
    }
  }));

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(events.length, 3);

  // Check event 0 (text with at)
  const ev0 = events[0];
  assert.equal(ev0.post_type, 'message');
  assert.equal(ev0.raw_message, '@大肥鱼 早上好呀 #(滑稽)');
  assert.equal(ev0.message[0].type, 'at');
  assert.equal(ev0.message[0].data.qq, botId);
  assert.equal(ev0.message[1].type, 'text');
  assert.equal(ev0.message[1].data.text, '@大肥鱼 早上好呀 #(滑稽)');

  // Check event 1 (image)
  const ev1 = events[1];
  assert.equal(ev1.post_type, 'message');
  assert.equal(ev1.raw_message, `[CQ:image,file=http://127.0.0.1:${port}/ImageMessage/user_upload_123.png,url=http://127.0.0.1:${port}/ImageMessage/user_upload_123.png]`);
  assert.equal(ev1.message[0].type, 'image');
  assert.equal(ev1.message[0].data.file, `http://127.0.0.1:${port}/ImageMessage/user_upload_123.png`);
  assert.equal(ev1.message[0].data.url, `http://127.0.0.1:${port}/ImageMessage/user_upload_123.png`);

  // Check event 2 (file)
  const ev2 = events[2];
  assert.equal(ev2.message[0].type, 'file');
  assert.equal(ev2.message[0].data.name, 'homework.zip');

  // Test sending text reply
  const sendRes = await client.sendGroupMsg(groupId, '早上好！今天也是元气满满的一天！');
  assert.equal(sendRes.message_id, 'msg_created_999');

  // Test sending image via sendImage
  const fakePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const sendImgRes = await client.sendImage('group', groupId, fakePng);
  assert.equal(sendImgRes.message_id, 'msg_created_999');

  // Test sending segments containing image
  const sendSegsRes = await client.sendSegments('group', groupId, [
    { type: 'text', data: { text: '看这张图：' } },
    { type: 'image', data: { file: fakePng } }
  ]);
  assert.equal(sendSegsRes.message_id, 'msg_created_999');

  // Test get_image call
  const imgCall = await client.call('get_image', { file: '/ImageMessage/test.png' });
  assert.equal(imgCall.url, `http://127.0.0.1:${port}/ImageMessage/test.png`);

  // Verify frames received by server
  const uploadFrames = receivedWsFrames.filter((f) => f.action === 'upload_image');
  assert.equal(uploadFrames.length, 2); // 1 from sendImage, 1 from sendSegments
  assert.ok(uploadFrames[0].file);

  const sendFrames = receivedWsFrames.filter((f) => f.action === 'send');
  assert.equal(sendFrames.length, 4); // 1 text, 1 image, 1 segment text, 1 segment image
  assert.equal(sendFrames[1].type, 'image');
  assert.equal(sendFrames[1].content, '/ImageMessage/test_ws_uploaded.png');

  await client.close();
  if (serverWs) serverWs.terminate();
  wss.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});
