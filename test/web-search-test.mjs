import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { parseBingResults, webSearch } from '../src/web-search.js';

const destination = 'https://docs.docker.com/get-started/';
const tracking = `https://www.bing.com/ck/a?!&amp;u=a1${Buffer.from(destination).toString('base64url')}&amp;ntb=1`;
const resultHtml = `<li class="b_algo"><h2><a href="${tracking}">Docker documentation</a></h2><p>Official documentation</p></li>`;

function mockSearch(t, responder, searchUrl = 'https://cn.bing.com/search') {
  const original = globalThis.fetch;
  const config = structuredClone(DEFAULT_CONFIG);
  config.webSearch.searchUrl = searchUrl;
  setRuntimeConfig(config);
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    return responder(new URL(url));
  };
  t.after(() => { globalThis.fetch = original; setRuntimeConfig(null); });
  return calls;
}

test('a Bing China homepage redirect retries the global search endpoint with the original query', async (t) => {
  const query = 'Docker 官方文档';
  const calls = mockSearch(t, (url) => ({ ok: true, status: 200,
    url: url.hostname === 'cn.bing.com' ? 'https://www.bing.com/' : url.href,
    text: async () => url.hostname === 'cn.bing.com' ? '<html><title>Bing</title></html>' : resultHtml,
  }));
  const result = await webSearch(query);
  assert.equal(result.results[0].url, destination);
  assert.deepEqual(calls.map((url) => url.hostname), ['cn.bing.com', 'www.bing.com']);
  assert(calls.every((url) => url.pathname === '/search' && url.searchParams.get('q') === query));
});

test('search results use the heading link and decode the real article URL', () => {
  const html = `<li class="b_algo"><a href="https://unrelated.example/">Publisher logo</a><h2><a href="${tracking}">Docker &amp; containers</a></h2><p>Official docs</p></li>`;
  assert.deepEqual(parseBingResults(html), [{ title: 'Docker & containers', url: destination, snippet: 'Official docs' }]);
});

test('Bing result classes and attributes can vary without losing results', () => {
  const html = `<li data-id="1" class='b_algo extra'><h2><a HREF='https://example.com/a?x=1&amp;y=2'>A &#183; B</a></h2><p>Snippet</p></li>`;
  assert.deepEqual(parseBingResults(html), [{ title: 'A · B', url: 'https://example.com/a?x=1&y=2', snippet: 'Snippet' }]);
});

test('custom Bing-compatible endpoints do not send failed queries to another provider', async (t) => {
  const calls = mockSearch(t, () => ({ ok: true, status: 200,
    url: 'https://search.example/', text: async () => '<html>No results</html>',
  }), 'https://search.example/search');
  await assert.rejects(webSearch('test query'), /没有解析到结果/);
  assert.equal(calls.length, 1);
});

test('successful global search does not make an extra request', async (t) => {
  const calls = mockSearch(t, (url) => ({ ok: true, status: 200,
    url: url.href, text: async () => resultHtml,
  }), 'https://www.bing.com/search');
  const result = await webSearch('Docker docs');
  assert.equal(result.results.length, 1);
  assert.equal(calls.length, 1);
});

test('tracking parameters cannot turn a result into a non-web URL', () => {
  const url = 'https://www.bing.com/ck/a?u=a1' + Buffer.from('javascript:alert(1)').toString('base64url');
  const results = parseBingResults(`<li class="b_algo"><h2><a href="${url}">Invalid destination</a></h2></li>`);
  assert(!results.some((result) => result.url.startsWith('javascript:')));
});
