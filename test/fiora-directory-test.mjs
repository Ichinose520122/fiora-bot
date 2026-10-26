import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { FioraClient } from '../src/fiora-client.js';

test('Fiora directory supplies real group/private names and all member pages with string IDs', async (t) => {
  const self = 'a'.repeat(24), group = 'c'.repeat(24), peer = 'b'.repeat(24);
  let conversationRequests = 0;
  const memberRequests = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-key');
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/conversations')) {
      conversationRequests++;
      res.end(JSON.stringify({ conversations: [
        { id: group, type: 'group', name: '真正的群名' },
        { id: self + peer, type: 'private', name: '真正的好友名' },
      ] }));
    } else {
      assert.equal(url.searchParams.get('conversationId'), group);
      const after = url.searchParams.get('after'); memberRequests.push(after);
      res.end(JSON.stringify({ members: [{ id: after ? self : peer, name: after ? '成员二' : '成员一' }],
        next: after ? null : 'opaque/page+2' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new FioraClient({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key' });
  client.selfId = self;
  const [groups, friends, name] = await Promise.all([
    client.call('get_group_list'), client.call('get_friend_list'), client.getChatName('private', peer),
  ]);
  assert.deepEqual(groups, [{ group_id: group, group_name: '真正的群名' }]);
  assert.deepEqual(friends, [{ user_id: peer, nickname: '真正的好友名' }]);
  assert.equal(name, '真正的好友名');
  assert.equal((await client.getGroupInfo(group)).group_name, '真正的群名');
  assert.equal(conversationRequests, 1);
  assert.deepEqual((await client.getGroupMemberList(group)).map((m) => m.user_id), [peer, self]);
  assert.deepEqual(memberRequests, [null, 'opaque/page+2']);
});

test('permission failures are reported instead of displaying an empty member list', async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(403); res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new FioraClient({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key' });
  await assert.rejects(client.getGroupMemberList('c'.repeat(24)), /HTTP 403/);
});
