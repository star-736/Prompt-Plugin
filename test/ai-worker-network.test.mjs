import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_STORAGE_KEY, applyDatabaseChange, createEmptyDatabase, createCategory,
  saveAsset, saveDraft, setPrivacyPassword, updateAiSettings
} from '../src/core/store.js';
import { processAiQueue, saveProvider, clearAiSession, unlockAi, AI_ALARM } from '../src/background/ai-worker.js';
import { AI_REQUEST_TIMEOUT_MS } from '../src/features/ai/ai-organizer.js';
import { createChromeStub, seedDatabase } from './helpers.mjs';
import { createProviderServer, completion, FIXTURE_PROVIDER_URL, FIXTURE_KEY } from './fixtures/provider-server.mjs';

async function setup(t, handler) {
  const server = await createProviderServer(handler);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = server.fetch;
  t.after(async () => { globalThis.fetch = nativeFetch; await server.close(); });
  const stub = createChromeStub();
  let database = await setPrivacyPassword(createEmptyDatabase(), 'synthetic-password');
  database = updateAiSettings(database, { enabled: true });
  database = saveAsset(database, { type: 'generic', content: 'Synthetic original content.' }, { id: 'synthetic-prompt' }).database;
  seedDatabase(stub.local, database);
  await saveProvider({ id: 'fixture-provider', kind: 'custom', baseUrl: FIXTURE_PROVIDER_URL, model: 'synthetic-model', apiKey: FIXTURE_KEY }, 'synthetic-password');
  stub.alarms.length = 0;
  return { server, stub, database: () => stub.local[APP_STORAGE_KEY] };
}

for (const action of ['edit', 'disable', 'clear-session', 'switch-provider', 'replace-session']) {
  test(`network AI run rejects its stale result after ${action} and processes the retained queue`, { timeout: 10000 }, async (t) => {
    const { server, stub, database } = await setup(t);
    const running = processAiQueue();
    const request = await server.nextRequest();
    if (action === 'edit') {
      await applyDatabaseChange((latest) => saveAsset(latest, { ...latest.assets[0], content: 'Synthetic newer content.' }));
    } else if (action === 'disable') {
      await applyDatabaseChange((latest) => updateAiSettings(latest, { enabled: false }));
    } else if (action === 'clear-session') {
      await clearAiSession();
    } else if (action === 'switch-provider') {
      // Switch to a different id, rather than just editing the current provider.
      await saveProvider({ id: 'replacement-provider', kind: 'custom', baseUrl: FIXTURE_PROVIDER_URL, model: 'replacement-model', apiKey: FIXTURE_KEY }, 'synthetic-password');
      await applyDatabaseChange((latest) => updateAiSettings(latest, { activeProviderId: 'replacement-provider' }));
    } else {
      // Ensure the replacement session has a distinct generation timestamp.
      await stub.chrome.storage.session.set({ 'futurecontext.ai-session': { ...stub.session['futurecontext.ai-session'], unlockedAt: stub.session['futurecontext.ai-session'].unlockedAt + 1 } });
    }
    await applyDatabaseChange((latest) => updateAiSettings(latest, { status: { state: 'idle', message: 'Synthetic current state' } }));
    const freshQueue = structuredClone(database().ai.queue);
    stub.alarms.length = 0; // A replacement alarm fires while the first run is pending.
    const overlapping = processAiQueue();
    assert.equal(running, overlapping);
    request.respond(200, completion({ title: 'Stale synthetic title', categoryName: null }));
    await Promise.all([running, overlapping]);
    assert.equal(server.requests.length, 1);
    assert.equal(database().assets[0].title, '');
    assert.deepEqual(database().ai.queue, freshQueue);
    // Editing the asset leaves the provider context valid, so the run may
    // report idle; configuration/session changes must preserve newer status.
    assert.equal(database().ai.status.message, action === 'edit' ? '' : 'Synthetic current state');
    assert.equal(stub.alarms.some((alarm) => alarm.name === AI_ALARM), !['disable', 'clear-session'].includes(action));
    if (action === 'disable') await applyDatabaseChange((latest) => updateAiSettings(latest, { enabled: true }));
    if (action === 'clear-session') await unlockAi('synthetic-password');
    const resumed = processAiQueue();
    const next = await server.nextRequest();
    assert.match(next.body.messages[1].content, action === 'edit' ? /Synthetic newer content/ : /Synthetic original content/);
    if (action === 'switch-provider') assert.equal(next.body.model, 'replacement-model');
    next.respond(200, completion({ title: 'Fresh synthetic title', categoryName: null }));
    await resumed;
    assert.equal(database().assets[0].title, 'Fresh synthetic title');
    assert.equal(database().ai.queue.length, 0);
    assert.equal(database().ai.status.state, 'idle');
  });
}

for (const status of [401, 403, 429, 400, 422]) {
  test(`network HTTP ${status} pauses the current AI configuration without a retry alarm`, async (t) => {
    const { server, stub, database } = await setup(t, (entry) => entry.respond(status, { error: 'Synthetic fixture failure' }));
    await processAiQueue();
    assert.equal(database().ai.status.state, 'paused');
    assert.equal(database().ai.queue.length, 1);
    assert.equal(database().assets[0].title, '');
    assert.equal(stub.alarms.length, 0);
    assert.equal(server.requests.length, [400, 422].includes(status) ? 2 : 1);
  });
}

for (const change of ['provider', 'session']) {
  test(`a real HTTP failure from an old ${change} cannot pause the replacement configuration or lose its alarm`, async (t) => {
    const { server, stub, database } = await setup(t);
    const running = processAiQueue();
    const first = await server.nextRequest();
    if (change === 'provider') {
      await saveProvider({ id: 'fixture-provider', kind: 'custom', baseUrl: FIXTURE_PROVIDER_URL, model: 'replacement-model', apiKey: FIXTURE_KEY }, 'synthetic-password');
    } else {
      await stub.chrome.storage.session.set({ 'futurecontext.ai-session': { ...stub.session['futurecontext.ai-session'], unlockedAt: stub.session['futurecontext.ai-session'].unlockedAt + 1 } });
    }
    await applyDatabaseChange((latest) => updateAiSettings(latest, { status: { state: 'idle', message: 'Synthetic replacement state' } }));
    stub.alarms.length = 0;
    const overlapping = processAiQueue();
    first.respond(401, { error: 'Synthetic old configuration failure' });
    await Promise.all([running, overlapping]);
    assert.equal(server.requests.length, 1);
    assert.equal(database().ai.status.state, 'idle');
    assert.equal(database().ai.status.message, 'Synthetic replacement state');
    assert.equal(database().ai.queue.length, 1);
    assert.ok(stub.alarms.some((item) => item.name === AI_ALARM));
    const resumed = processAiQueue();
    const next = await server.nextRequest();
    next.respond(200, completion({ title: 'Fresh synthetic title', categoryName: null }));
    await resumed;
    assert.equal(database().assets[0].title, 'Fresh synthetic title');
    assert.equal(database().ai.queue.length, 0);
  });
}

for (const phase of ['initial request', 'retry response body']) {
  test(`network ${phase} timeout pauses AI and retains its queue without an automatic retry`, { timeout: 5000 }, async (t) => {
    const { server, stub, database } = await setup(t);
    let readingBody;
    const bodyStarted = new Promise((resolve) => { readingBody = resolve; });
    if (phase.includes('retry')) {
      globalThis.fetch = async (url, options) => {
        const response = await server.fetch(url, options);
        const consume = response.json.bind(response);
        response.json = () => { readingBody(); return consume(); };
        return response;
      };
    }
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const running = processAiQueue();
    const first = await server.nextRequest();
    let pending = first;
    if (phase.includes('retry')) {
      // Advancing almost to the original deadline before a compatibility
      // retry proves that retry/body reading do not get a fresh 30 seconds.
      t.mock.timers.tick(AI_REQUEST_TIMEOUT_MS - 1000);
      first.respond(422, { error: 'unsupported response_format' });
      pending = await server.nextRequest();
      pending.response.writeHead(200, { 'Content-Type': 'application/json' });
      pending.response.write('{"choices":[');
      await bodyStarted;
      t.mock.timers.tick(1000);
    } else t.mock.timers.tick(AI_REQUEST_TIMEOUT_MS);
    await running;
    await pending.closed;
    assert.equal(pending.response.writableFinished, false);
    assert.equal(database().ai.status.state, 'paused');
    assert.equal(database().ai.queue.length, 1);
    assert.equal(database().assets[0].title, '');
    assert.equal(stub.alarms.length, 0);
    assert.equal(server.requests.length, phase.includes('retry') ? 2 : 1);
  });
}

test('network AI organization, grouping and structure requests exclude AIGC, commands, private assets and drafts', async (t) => {
  const { server, database } = await setup(t, (entry) => {
    const prompt = entry.body.messages[1].content;
    if (prompt.includes('输出格式：{"groups"')) entry.respond(200, completion({ groups: [] }));
    else if (prompt.includes('分类结构顾问')) entry.respond(200, completion({ proposal: null }));
    else entry.respond(200, completion({ title: null, categoryName: null }));
  });
  await applyDatabaseChange((latest) => {
    let next = createCategory(latest, 'generic', 'Synthetic category').database;
    next = createCategory(next, 'skill', 'Synthetic skill category').database;
    for (const input of [
      { type: 'skill', content: '---\nname: synthetic-skill\ndescription: synthetic fixture\n---\nSynthetic instructions.' },
      { type: 'aigc', content: 'excluded-aigc-marker' },
      { type: 'aigc', privacy: 'private', content: 'excluded-private-marker' },
      { type: 'command', content: 'excluded-command-marker' }
    ]) next = saveAsset(next, input).database;
    next = saveDraft(next, { type: 'generic' }, { content: 'excluded-draft-marker' });
    // Exercise the worker's eligibility guard even with an obsolete bad queue entry.
    next.ai.queue.push(...next.assets.filter((asset) => ['aigc', 'command'].includes(asset.type)).map((asset) => ({ id: `excluded-${asset.id}`, assetId: asset.id, assetType: asset.type })));
    return updateAiSettings(next, { thresholds: { uncategorized: 1, restructureChanges: 1, restructureDays: 1 } });
  });
  await processAiQueue();
  assert.equal(server.requests.length, 6, 'two saved assets, two grouping requests and two structure requests');
  for (const request of server.requests) assert.doesNotMatch(JSON.stringify(request.body), /excluded-(?:aigc|private|command|draft)-marker/);
  assert.equal(database().ai.queue.length, 0);
  assert.equal(database().drafts['generic:normal:new'].content, 'excluded-draft-marker');
});
