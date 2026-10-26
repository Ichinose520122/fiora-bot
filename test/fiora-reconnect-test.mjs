import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { FioraClient } from '../src/fiora-client.js';

async function fixture(t, automaticReady = true) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const events = [];
  const client = new FioraClient({ url: '', apiKey: 'test', log() {}, onEvent: (event) => events.push(event) });
  const ready = (ws) => ws.send(JSON.stringify({ type: 'ready', user: { id: 'b'.repeat(24), name: 'Bot' }, scope: { allowedGroupIds: [] } }));
  if (automaticReady) wss.on('connection', ready);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  client.siteUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await client.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
    wss.close();
  });
  return { wss, client, events, ready };
}

test('connection becomes ready only after the server confirms identity', async (t) => {
  const { wss, client, ready } = await fixture(t, false);
  client.lastConnectError = 'previous connection closed';
  const connection = once(wss, 'connection');
  const connected = client.connect();
  const [ws] = await connection;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.connected, false);
  ready(ws);
  assert.equal(await connected, true);
  assert.equal(client.selfId, 'b'.repeat(24));
  assert.equal(client.lastConnectError, '');
});

test('late events from an old socket do not disconnect or overwrite a new connection', async (t) => {
  const { client, events } = await fixture(t);
  await client.connect();
  const oldSocket = client.socket;
  const ready = new Promise((resolve) => {
    const unsubscribe = client.onStatus((status) => { if (status.connected) { unsubscribe(); resolve(); } });
  });
  await client.reconnect();
  await ready;
  const currentSocket = client.socket;
  oldSocket.emit('close', 1006, Buffer.from('late close'));
  oldSocket.emit('message', Buffer.from(JSON.stringify({ type: 'ready', user: { id: 'stale' }, scope: {} })));
  assert.equal(client.connected, true);
  assert.equal(client.socket, currentSocket);
  assert.equal(client.selfId, 'b'.repeat(24));
  assert.equal(events.length, 0);
});
