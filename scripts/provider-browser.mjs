// Explicit, free integration acceptance in a temporary Chrome for Testing
// profile. Supply a local Playwright module and browser executable; neither is
// a production dependency. All Provider traffic is restricted to loopback.
// Run with FUTURECONTEXT_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
// and FUTURECONTEXT_CHROME_EXECUTABLE=/absolute/path/to/chrome:
// node scripts/provider-browser.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProviderServer, completion, FIXTURE_PROVIDER_URL, FIXTURE_KEY } from '../test/fixtures/provider-server.mjs';

const modulePath = process.env.FUTURECONTEXT_PLAYWRIGHT_MODULE;
const executablePath = process.env.FUTURECONTEXT_CHROME_EXECUTABLE;
if (!modulePath || !executablePath) throw new Error('Set FUTURECONTEXT_PLAYWRIGHT_MODULE and FUTURECONTEXT_CHROME_EXECUTABLE to local absolute paths.');
const { chromium } = await import(pathToFileURL(modulePath).href);
const project = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'futurecontext-provider-'));
const server = await createProviderServer();
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true,
    args: [`--disable-extensions-except=${project}`, `--load-extension=${project}`]
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extension = `chrome-extension://${new URL(worker.url()).hostname}`;
  await worker.evaluate(({ providerUrl, origin }) => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (url !== `${providerUrl}/chat/completions`) throw new Error('Browser fixture blocked a non-test endpoint.');
      return nativeFetch(`${origin}/v1/chat/completions`, options);
    };
  }, { providerUrl: FIXTURE_PROVIDER_URL, origin: server.origin });
  const page = await context.newPage();
  await page.goto(`${extension}/src/ui/popup/popup.html?mode=tab`);
  await page.locator('.tabs').waitFor();
  const send = (message) => page.evaluate((value) => chrome.runtime.sendMessage(value), message);
  const read = () => page.evaluate(async () => (await chrome.storage.local.get('futurecontext.v1'))['futurecontext.v1']);
  const alarm = () => page.evaluate(() => chrome.alarms.get('futurecontext.ai-queue'));
  const patch = (value) => page.evaluate(async (input) => {
    const store = await import(chrome.runtime.getURL('src/core/store.js'));
    await store.applyDatabaseChange((latest) => store.updateAiSettings(latest, input));
  }, value);
  const seed = async (extraAssets = false) => {
    await page.evaluate(async ({ providerUrl, key, extra }) => {
      const store = await import(chrome.runtime.getURL('src/core/store.js'));
      let database = await store.setPrivacyPassword(store.createEmptyDatabase(), 'synthetic-password');
      database = store.updateAiSettings(database, { enabled: true });
      database = store.saveAsset(database, { type: 'generic', content: 'Synthetic original content.' }, { id: 'synthetic-prompt' }).database;
      if (extra) {
        for (const input of [
          { type: 'skill', content: '---\nname: synthetic-skill\ndescription: synthetic fixture\n---\nSynthetic instructions.' },
          { type: 'aigc', content: 'excluded-aigc-marker' },
          { type: 'aigc', privacy: 'private', content: 'excluded-private-marker' },
          { type: 'command', content: 'excluded-command-marker' }
        ]) database = store.saveAsset(database, input).database;
        database = store.saveDraft(database, { type: 'generic' }, { content: 'excluded-draft-marker' });
      }
      await store.applyDatabaseChange(() => database);
      const saved = await chrome.runtime.sendMessage({ type: 'save-provider', password: 'synthetic-password', provider: { id: 'fixture-provider', kind: 'custom', baseUrl: providerUrl, model: 'synthetic-model', apiKey: key } });
      if (!saved.ok) throw new Error('Synthetic Provider setup failed.');
      await chrome.alarms.clear('futurecontext.ai-queue');
    }, { providerUrl: FIXTURE_PROVIDER_URL, key: FIXTURE_KEY, extra: extraAssets });
  };

  await seed(true);
  const privacyRun = send({ type: 'process-ai-now' });
  for (let index = 0; index < 2; index += 1) {
    const request = await server.nextRequest();
    assert.ok(request.authorized);
    assert.doesNotMatch(JSON.stringify(request.body), /excluded-(?:aigc|private|command|draft)-marker/);
    request.respond(200, completion({ title: null, categoryName: null }));
  }
  assert.ok((await privacyRun).ok);
  assert.equal((await read()).ai.queue.length, 0);
  console.log('PASS Chrome worker sends only saved normal Prompt/Skill synthetic content');

  for (const action of ['edit', 'disable', 'clear-session', 'switch-provider']) {
    await seed();
    const start = server.requests.length;
    const running = send({ type: 'process-ai-now' });
    const first = await server.nextRequest();
    if (action === 'edit') await page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/core/store.js'));
      await store.applyDatabaseChange((latest) => store.saveAsset(latest, { ...latest.assets[0], content: 'Synthetic newer content.' }));
    });
    if (action === 'disable') await patch({ enabled: false });
    if (action === 'clear-session') assert.ok((await send({ type: 'clear-ai-session' })).ok);
    if (action === 'switch-provider') {
      assert.ok((await send({ type: 'save-provider', password: 'synthetic-password', provider: { id: 'replacement-provider', kind: 'custom', baseUrl: FIXTURE_PROVIDER_URL, model: 'replacement-model', apiKey: FIXTURE_KEY } })).ok);
      await patch({ activeProviderId: 'replacement-provider' });
    }
    await patch({ status: { state: 'idle', message: 'Synthetic current state' } });
    const queue = (await read()).ai.queue;
    await page.evaluate(() => chrome.alarms.clear('futurecontext.ai-queue'));
    // An alarm and manual trigger share the same pending background run.
    const overlapping = send({ type: 'process-ai-now' });
    await worker.evaluate(() => Promise.resolve());
    first.respond(200, completion({ title: 'Stale synthetic title', categoryName: null }));
    assert.ok((await running).ok);
    assert.ok((await overlapping).ok);
    assert.equal(server.requests.length - start, 1);
    const database = await read();
    assert.equal(database.assets[0].title, '');
    assert.deepEqual(database.ai.queue, queue);
    assert.equal(database.ai.status.message, action === 'edit' ? '' : 'Synthetic current state');
    assert.equal(Boolean(await alarm()), !['disable', 'clear-session'].includes(action));
    if (action === 'disable') await patch({ enabled: true });
    if (action === 'clear-session') assert.ok((await send({ type: 'unlock-ai', password: 'synthetic-password' })).ok);
    const resumed = send({ type: 'process-ai-now' });
    const next = await server.nextRequest();
    assert.match(next.body.messages[1].content, action === 'edit' ? /Synthetic newer content/ : /Synthetic original content/);
    if (action === 'switch-provider') assert.equal(next.body.model, 'replacement-model');
    next.respond(200, completion({ title: 'Fresh synthetic title', categoryName: null }));
    assert.ok((await resumed).ok);
    assert.equal((await read()).assets[0].title, 'Fresh synthetic title');
    assert.equal((await read()).ai.queue.length, 0);
    console.log(`PASS Chrome worker rejects stale ${action} response and resumes retained queue`);
  }

  for (const status of [401, 403, 429, 400, 422]) {
    await seed();
    const start = server.requests.length;
    const running = send({ type: 'process-ai-now' });
    for (let index = 0; index < ([400, 422].includes(status) ? 2 : 1); index += 1) {
      const request = await server.nextRequest();
      if (index === 1) assert.equal('response_format' in request.body, false);
      request.respond(status, { error: 'Synthetic failure' });
    }
    assert.ok((await running).ok);
    const database = await read();
    assert.equal(database.ai.status.state, 'paused');
    assert.equal(database.ai.queue.length, 1);
    assert.equal(Boolean(await alarm()), false);
    assert.equal(server.requests.length - start, [400, 422].includes(status) ? 2 : 1);
    console.log(`PASS Chrome worker pauses after HTTP ${status} without automatic retry`);
  }

  for (const phase of ['initial request', 'compatibility retry', 'response body', 'retry response body']) {
    // Extension pages can dynamically import modules; MV3 workers cannot.
    // Exercise the packaged transport with Chrome's native fetch here; the
    // full worker's production deadline is checked separately below.
    const request = page.evaluate(async ({ baseUrl, key, origin }) => {
      const { chatCompletion } = await import(chrome.runtime.getURL('src/features/ai/ai-organizer.js'));
      const loopbackFetch = (url, options) => {
        if (url !== `${baseUrl}/chat/completions`) throw new Error('Browser fixture blocked a non-test endpoint.');
        return fetch(`${origin}/v1/chat/completions`, options);
      };
      try { await chatCompletion({ baseUrl, model: 'synthetic-model' }, key, 'Synthetic timeout fixture', loopbackFetch, { timeoutMs: 500 }); return false; }
      catch (error) { return error.message === 'Provider 请求超时，请检查网络后重试。'; }
    }, { baseUrl: FIXTURE_PROVIDER_URL, key: FIXTURE_KEY, origin: server.origin });
    let pending = await server.nextRequest();
    if (phase.includes('retry')) { pending.respond(422, { error: 'unsupported response_format' }); pending = await server.nextRequest(); }
    if (phase.includes('body')) { pending.response.writeHead(200, { 'Content-Type': 'application/json' }); pending.response.write('{"choices":['); }
    assert.ok(await request);
    await pending.closed;
    assert.equal(pending.response.writableFinished, false);
    console.log(`PASS Chrome native fetch cancels incomplete ${phase}`);
  }
  await seed();
  const timedWorker = send({ type: 'process-ai-now' });
  const first = await server.nextRequest();
  first.respond(422, { error: 'unsupported response_format' });
  const body = await server.nextRequest();
  body.response.writeHead(200, { 'Content-Type': 'application/json' });
  body.response.write('{"choices":[');
  console.log('Checking the real 30-second Chrome worker deadline during retry response body reading...');
  assert.ok((await timedWorker).ok);
  await body.closed;
  assert.equal(body.response.writableFinished, false);
  const timedDatabase = await read();
  assert.equal(timedDatabase.ai.status.state, 'paused');
  assert.equal(timedDatabase.ai.queue.length, 1);
  assert.equal(Boolean(await alarm()), false);
  console.log('PASS Chrome worker production deadline cancels retry body, pauses and retains queue');
  console.log(`Chrome ${context.browser()?.version() ?? 'unknown'}; ${process.platform}/${process.arch}; loopback only; temporary profile cleaned after run.`);
} finally {
  try { await context?.close(); }
  finally {
    try { await server.close(); }
    finally { await rm(profile, { recursive: true, force: true }); }
  }
}
