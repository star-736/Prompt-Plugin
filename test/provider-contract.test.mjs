import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCompletion, buildAssetOrganizationPrompt } from '../src/features/ai/ai-organizer.js';
import { createProviderServer, completion, FIXTURE_PROVIDER_URL, FIXTURE_KEY } from './fixtures/provider-server.mjs';

const provider = { baseUrl: FIXTURE_PROVIDER_URL, model: 'synthetic-model' };

async function endpoint(t, handler) {
  const server = await createProviderServer(handler);
  t.after(() => server.close());
  return server;
}

test('native fetch sends the expected authenticated JSON contract for synthetic Prompt and Skill', async (t) => {
  const server = await endpoint(t, (entry) => entry.respond(200, completion({ title: '合成标题', categoryName: null })));
  for (const asset of [
    { type: 'generic', title: '', content: 'Synthetic: summarize a fictional meeting.' },
    { type: 'skill', title: 'synthetic-skill', content: '---\nname: synthetic-skill\ndescription: synthetic fixture\n---\nReview fictional text.' }
  ]) {
    const result = await chatCompletion(provider, FIXTURE_KEY, buildAssetOrganizationPrompt(asset, []), server.fetch);
    assert.deepEqual(result, { title: '合成标题', categoryName: null });
    const entry = server.requests.at(-1);
    assert.equal(entry.method, 'POST');
    assert.equal(entry.path, '/v1/chat/completions');
    assert.ok(entry.authorized, 'fixture authorization must match');
    assert.equal(entry.contentType, 'application/json');
    assert.equal(entry.body.model, provider.model);
    assert.deepEqual(entry.body.response_format, { type: 'json_object' });
    assert.match(entry.body.messages[1].content, /synthetic|Synthetic/);
  }
});

for (const status of [401, 403, 429]) {
  test(`native fetch rejects HTTP ${status} without retrying or leaking response details`, async (t) => {
    const server = await endpoint(t, (entry) => entry.respond(status, { error: { message: 'synthetic-sensitive-response-marker' } }));
    await assert.rejects(chatCompletion(provider, FIXTURE_KEY, 'Synthetic fixture', server.fetch), (error) => {
      assert.equal(error.message, `Provider 请求失败（${status}）。`);
      return true;
    });
    assert.equal(server.requests.length, 1);
  });
}

for (const status of [400, 422]) {
  test(`native fetch retries HTTP ${status} once without JSON mode and consumes the real response body`, async (t) => {
    const signals = [];
    const server = await endpoint(t, (entry, count) => entry.respond(count === 1 ? status : 200, count === 1 ? { error: 'unsupported response_format' } : completion({ ok: true })));
    const fetchImpl = (url, options) => { signals.push(options.signal); return server.fetch(url, options); };
    assert.deepEqual(await chatCompletion(provider, FIXTURE_KEY, 'Synthetic fixture', fetchImpl), { ok: true });
    assert.equal(server.requests.length, 2);
    const [first, fallback] = server.requests;
    const { response_format, ...expected } = first.body;
    assert.deepEqual(response_format, { type: 'json_object' });
    assert.deepEqual(fallback.body, expected);
    assert.ok(first.authorized && fallback.authorized);
    assert.equal(signals[0], signals[1]);
  });

  test(`native fetch stops after a failed HTTP ${status} compatibility retry`, async (t) => {
    const server = await endpoint(t, (entry) => entry.respond(status, { error: 'unsupported request' }));
    await assert.rejects(chatCompletion(provider, FIXTURE_KEY, 'Synthetic fixture', server.fetch), new RegExp(String(status)));
    assert.equal(server.requests.length, 2);
  });
}

for (const phase of ['initial request', 'compatibility retry', 'response body', 'retry response body']) {
  test(`native fetch timeout closes the incomplete ${phase}`, { timeout: 5000 }, async (t) => {
    const server = await endpoint(t, (entry, count) => {
      if (phase.includes('retry') && count === 1) { entry.respond(422, { error: 'unsupported response_format' }); return; }
      if (phase.includes('body')) {
        entry.response.writeHead(200, { 'Content-Type': 'application/json' });
        entry.response.write('{"choices":['); // Headers arrive; response.json() must still be cancellable.
      }
    });
    await assert.rejects(chatCompletion(provider, FIXTURE_KEY, 'Synthetic fixture', server.fetch, { timeoutMs: 250 }), /超时/);
    assert.equal(server.requests.length, phase.includes('retry') ? 2 : 1);
    await server.requests.at(-1).closed;
    assert.equal(server.requests.at(-1).response.writableFinished, false, 'timeout must close an unfinished network response');
  });
}

test('native response parsing rejects malformed JSON and empty completions', async (t) => {
  const server = await endpoint(t, (entry, count) => {
    if (count === 1) { entry.response.writeHead(200, { 'Content-Type': 'application/json' }); entry.response.end('{broken'); }
    else entry.respond(200, { choices: [] });
  });
  await assert.rejects(chatCompletion(provider, FIXTURE_KEY, 'Synthetic fixture', server.fetch), SyntaxError);
  await assert.rejects(chatCompletion(provider, FIXTURE_KEY, 'Synthetic fixture', server.fetch), /未返回/);
  assert.equal(server.requests.length, 2);
});
