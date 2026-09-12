import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  APP_STORAGE_KEY,
  createEmptyDatabase,
  saveAsset,
  setPrivacyPassword,
  updateAiSettings
} from '../store.js';
import { createChromeStub, createMemoryIndexedDB, seedDatabase } from './helpers.mjs';
import { saveGitHubToken } from '../github-auth.js';

const skill = `---\nname: Email reviewer\ndescription: Review email drafts\n---\n\n# Instructions\nReview the email.`;
const encodedSkill = Buffer.from(skill).toString('base64');

function enableSites(database, sites) {
  const next = structuredClone(database);
  next.settings.inPlace.sites = sites;
  return next;
}

function githubSender(url = 'https://chatgpt.com/') {
  return { tab: { id: 1, url }, url };
}

function skillFetch(commit = 'abc123ffffffffffffffffffffffffffffffff') {
  return async (url) => {
    if (url.endsWith('/repos/acme/demo')) return { ok: true, status: 200, json: async () => ({ default_branch: 'main' }) };
    if (url.includes('/commits/')) return { ok: true, status: 200, json: async () => ({ sha: commit }) };
    if (url.includes('/git/trees/')) return { ok: true, status: 200, json: async () => ({ truncated: false, tree: [{ type: 'blob', path: 'skills/demo/SKILL.md', sha: 'skill', size: 40 }] }) };
    if (url.endsWith('/git/blobs/skill')) return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: encodedSkill }) };
    throw new Error(`Unexpected ${url}`);
  };
}

const stub = createChromeStub({
  grantedOrigins: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*', 'https://chat.openai.com/*', 'https://github.com/*', 'https://api.github.com/*'],
  tabs: [{ id: 1, url: 'https://chatgpt.com/c/1', active: true, windowId: 1 }],
  indexedDB: createMemoryIndexedDB(),
  executeScript: async ({ func, args = [] }) => {
    if (typeof func === 'function') {
      try { return [{ result: func(...args) }]; } catch { return [{ result: null }]; }
    }
    return [{ result: null }];
  }
});

seedDatabase(stub.local, enableSites(createEmptyDatabase(), ['https://chatgpt.com']));

const { NOTICE_KEY, handleRuntimeMessage, githubPageContext } = await import('../background.js');

test('collect and update send the configured token to every GitHub API request', async () => {
  seedDatabase(stub.local, createEmptyDatabase());
  await saveGitHubToken('ghp_test');
  const previousFetch = globalThis.fetch;
  const calls = [];
  let mock = skillFetch('a'.repeat(40));
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return mock(url); };
  try {
    const collected = await handleRuntimeMessage({ type: 'collect-github-skill', tabId: 1, url: 'https://github.com/acme/demo/blob/main/skills/demo/SKILL.md' });
    assert.equal(collected.hasToken, true);
    const firstCount = calls.length;
    assert.ok(firstCount >= 3);
    mock = skillFetch('b'.repeat(40));
    const updated = await handleRuntimeMessage({ type: 'update-github-skill', assetId: collected.asset.id });
    assert.equal(updated.changed, true);
    assert.ok(calls.length > firstCount);
    for (const { url, options } of calls) {
      assert.equal(new URL(url).origin, 'https://api.github.com');
      assert.equal(options.headers.Authorization, 'Bearer ghp_test');
      assert.equal(options.redirect, 'error');
    }
  } finally {
    globalThis.fetch = previousFetch;
    await saveGitHubToken('');
  }
});

test('unknown message type is rejected', async () => {
  await assert.rejects(() => handleRuntimeMessage({ type: 'nope' }), /未知/);
});

test('content scripts cannot call extension-page messages', async () => {
  const tabSender = githubSender('https://chatgpt.com/c/1');
  await assert.rejects(() => handleRuntimeMessage({ type: 'unlock-ai', password: '123456' }, tabSender), /扩展页/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'save-provider', provider: {}, password: '123456' }, tabSender), /扩展页/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'delete-provider', id: 'p1' }, tabSender), /扩展页/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'queue-existing' }, tabSender), /扩展页/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'process-ai-now' }, tabSender), /扩展页/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'collect-github-skill' }, tabSender), /扩展页/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'update-github-skill', assetId: 'x' }, tabSender), /扩展页/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'sync-sites' }, tabSender), /扩展页/);
});

test('schedule-ai, notice, and session messages work', async () => {
  assert.deepEqual(await handleRuntimeMessage({ type: 'schedule-ai' }), { ok: true });
  stub.session[NOTICE_KEY] = { message: '已保存', at: 1 };
  assert.deepEqual(await handleRuntimeMessage({ type: 'read-notice' }), { message: '已保存' });
  assert.deepEqual(await handleRuntimeMessage({ type: 'read-notice' }), { message: null });
  assert.deepEqual(await handleRuntimeMessage({ type: 'clear-ai-session' }), { ok: true });
});

test('palette settings, query, and insert respect site coverage and skill prefix', async () => {
  let database = enableSites(createEmptyDatabase(), ['https://chatgpt.com']);
  database = saveAsset(database, { type: 'generic', title: '周报标题', content: '总结本周工作' }, { id: 'g1', now: 1 }).database;
  database = saveAsset(database, { type: 'skill', content: skill }, { id: 's1', now: 2 }).database;
  database = saveAsset(database, { type: 'aigc', title: '场景', content: '电影感雨夜' }, { id: 'a1', now: 3 }).database;
  database = saveAsset(database, { type: 'command', content: 'npm install -g @openai/codex' }, { id: 'c1', now: 4 }).database;
  database = enableSites(database, ['https://chatgpt.com', 'https://grok.com']);
  seedDatabase(stub.local, database);
  const sender = githubSender('https://chatgpt.com/c/1');
  const settings = await handleRuntimeMessage({ type: 'palette-settings' }, sender);
  assert.equal(settings.enabled, true);
  const items = await handleRuntimeMessage({ type: 'palette-query', query: '周报标题' }, sender);
  assert.equal(items[0].id, 'g1');
  const genericInserted = await handleRuntimeMessage({ type: 'palette-insert', id: 'g1' }, sender);
  assert.equal(genericInserted.content, '总结本周工作');
  assert.notEqual(genericInserted.content, '周报标题总结本周工作');
  assert.notEqual(genericInserted.content, '周报标题\n总结本周工作');
  const inserted = await handleRuntimeMessage({ type: 'palette-insert', id: 's1' }, sender);
  assert.match(inserted.content, /基于以下 skill/);
  assert.equal(inserted.content.startsWith('基于以下 skill 辅助我解决问题\n---'), true);
  assert.equal(inserted.content.includes('Email reviewer\n---'), false);
  await assert.rejects(() => handleRuntimeMessage({ type: 'palette-insert', id: 'a1' }, sender), /不能取用该类型/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'palette-insert', id: 'c1' }, sender), /不能取用该类型/);
  const imagine = githubSender('https://grok.com/imagine');
  await assert.rejects(() => handleRuntimeMessage({ type: 'palette-insert', id: 'g1' }, imagine), /不能取用该类型/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'palette-insert', id: 's1' }, imagine), /不能取用该类型/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'palette-insert', id: 'c1' }, imagine), /不能取用该类型/);
  const aigcInserted = await handleRuntimeMessage({ type: 'palette-insert', id: 'a1' }, imagine);
  assert.equal(aigcInserted.content, '电影感雨夜');
  await assert.rejects(() => handleRuntimeMessage({ type: 'palette-insert', id: 'missing' }, sender), /找不到/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'palette-insert', id: 'g1' }, githubSender('https://www.douyin.com/')), /未启用/);
  assert.deepEqual(await handleRuntimeMessage({ type: 'palette-query', query: '' }, githubSender('https://www.douyin.com/')), []);
  assert.equal((await handleRuntimeMessage({ type: 'palette-query', query: '' }, sender)).some((item) => item.id === 'c1'), false);
});

test('sync-sites registers and unregisters the palette content script', async () => {
  seedDatabase(stub.local, enableSites(createEmptyDatabase(), ['https://chatgpt.com']));
  const enabled = await handleRuntimeMessage({ type: 'sync-sites' });
  assert.equal(enabled.sites > 0, true);
  seedDatabase(stub.local, enableSites(createEmptyDatabase(), []));
  const disabled = await handleRuntimeMessage({ type: 'sync-sites' });
  assert.equal(disabled.sites, 0);
});

test('provider save, unlock, test, queue, and delete', async () => {
  let database = await setPrivacyPassword(createEmptyDatabase(), '123456', webcrypto);
  database = saveAsset(database, { type: 'generic', content: '写周报' }, { id: 'g1' }).database;
  database = updateAiSettings(database, { enabled: true });
  seedDatabase(stub.local, database);
  const provider = await handleRuntimeMessage({
    type: 'save-provider',
    password: '123456',
    provider: { kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: 'sk-test' }
  });
  const status = await handleRuntimeMessage({ type: 'ai-session-status' });
  assert.equal(status.providerId, provider.id, `session=${JSON.stringify(stub.session)} status=${JSON.stringify(status)} providers=${JSON.stringify(stub.local['futurecontext.v1']?.ai?.providers?.map((item) => item.id))}`);
  assert.equal(status.unlocked, true);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true,"title":null,"categoryName":null}' } }] }) });
  assert.deepEqual(await handleRuntimeMessage({ type: 'test-provider', id: provider.id }), { ok: true });
  const queued = await handleRuntimeMessage({ type: 'queue-existing' });
  assert.equal(queued.count >= 1, true);
  await handleRuntimeMessage({ type: 'process-ai-now' });
  await handleRuntimeMessage({ type: 'delete-provider', id: provider.id });
  const after = await handleRuntimeMessage({ type: 'ai-session-status' });
  assert.equal(after.unlocked, false);
});

test('unlock-ai rejects a wrong password and missing provider', async () => {
  seedDatabase(stub.local, await setPrivacyPassword(createEmptyDatabase(), '123456', webcrypto));
  await assert.rejects(() => handleRuntimeMessage({ type: 'unlock-ai', password: 'wrong-password' }), /不正确/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'unlock-ai', password: '123456' }), /Provider/);
});

test('collect and update GitHub skills, including unchanged updates', async () => {
  seedDatabase(stub.local, createEmptyDatabase());
  stub.tabs[0].url = 'https://github.com/acme/demo/blob/main/skills/demo/SKILL.md';
  globalThis.fetch = skillFetch();
  const collected = await handleRuntimeMessage({
    type: 'collect-github-skill',
    tabId: 1,
    url: stub.tabs[0].url
  });
  assert.equal(collected.duplicate, false);
  assert.equal(collected.hasToken, false);
  assert.equal(collected.asset.title, 'Email reviewer');
  const again = await handleRuntimeMessage({ type: 'collect-github-skill', tabId: 1, url: stub.tabs[0].url });
  assert.equal(again.duplicate, true);
  const unchanged = await handleRuntimeMessage({ type: 'update-github-skill', assetId: collected.asset.id });
  assert.equal(unchanged.changed, false);
  globalThis.fetch = skillFetch('def456ffffffffffffffffffffffffffffffff');
  const updated = await handleRuntimeMessage({ type: 'update-github-skill', assetId: collected.asset.id });
  assert.equal(updated.changed, true);
});

test('read-only database blocks collect and update', async () => {
  const newer = { ...createEmptyDatabase(), version: 3 };
  stub.local[APP_STORAGE_KEY] = newer;
  await assert.rejects(() => handleRuntimeMessage({ type: 'collect-github-skill', url: 'https://github.com/acme/demo/blob/main/skills/demo/SKILL.md', tabId: 1 }), /只读/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'update-github-skill', assetId: 'x' }), /只读/);
});

test('queue-existing requires background AI and test-provider requires a session', async () => {
  seedDatabase(stub.local, createEmptyDatabase());
  await assert.rejects(() => handleRuntimeMessage({ type: 'queue-existing' }), /开启后台 AI/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'test-provider', id: 'missing' }), /找不到 Provider/);
});

test('chrome listeners schedule AI, menus, and the palette shortcut', async () => {
  seedDatabase(stub.local, enableSites(createEmptyDatabase(), ['https://chatgpt.com']));
  stub.listeners.alarm[0]({ name: 'futurecontext.ai-queue' });
  stub.listeners.alarm[0]({ name: 'other' });
  stub.listeners.installed[0]();
  stub.listeners.startup[0]();
  assert.ok(stub.accessLevels.filter((item) => item.accessLevel === 'TRUSTED_CONTEXTS').length >= 2);
  stub.listeners.contextClicked[0]({ menuItemId: 'futurecontext-capture-selection', selectionText: 'captured text' }, { id: 1, url: 'https://chatgpt.com/' });
  stub.listeners.contextClicked[0]({ menuItemId: 'futurecontext-capture-selection', selectionText: '   ' }, { id: 1, url: 'https://chatgpt.com/' });
  stub.listeners.contextClicked[0]({ menuItemId: 'other' }, { id: 1 });
  stub.listeners.command[0]('open-palette');
  stub.listeners.command[0]('other');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(stub.listeners.message.length >= 1);
});

test('githubPageContext parses refs/heads paths and permalink commit', () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  globalThis.document = {
    querySelector(selector) {
      if (selector === 'a[data-hotkey="y"]') return { getAttribute: () => '/acme/demo/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/demo/SKILL.md' };
      return { getAttribute: () => '' };
    }
  };
  globalThis.location = { href: 'https://github.com/acme/demo/blob/refs/heads/main/skills/demo/SKILL.md', pathname: '/acme/demo/blob/refs/heads/main/skills/demo/SKILL.md' };
  try {
    const ctx = githubPageContext();
    assert.equal(ctx.repository, 'acme/demo');
    assert.equal(ctx.ref, 'main');
    assert.equal(ctx.path, 'skills/demo/SKILL.md');
    assert.equal(ctx.commit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  } finally {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }
});

test('collect and update reject invalid pages and non-github skills', async () => {
  seedDatabase(stub.local, createEmptyDatabase());
  await assert.rejects(() => handleRuntimeMessage({ type: 'collect-github-skill', url: 'https://chatgpt.com/', tabId: 1 }), /公开 GitHub|SKILL\.md/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'collect-github-skill', url: 'https://github.com/acme/demo/blob/main/skills/demo/SKILL.md', tabId: 99 }), /仓库信息|读取/);
  await assert.rejects(() => handleRuntimeMessage({ type: 'update-github-skill', assetId: 'missing' }), /可更新/);
  const collectedUrl = 'https://github.com/acme/demo/blob/main/skills/demo/SKILL.md';
  stub.tabs[0].url = collectedUrl;
  globalThis.fetch = skillFetch();
  await handleRuntimeMessage({ type: 'collect-github-skill', url: collectedUrl });
});

test('unlock-ai and process-ai-now run grouping when thresholds are low', async () => {
  let database = await setPrivacyPassword(createEmptyDatabase(), '123456', webcrypto);
  database = updateAiSettings(database, { enabled: true, thresholds: { uncategorized: 1, restructureChanges: 1, restructureDays: 0 } });
  database = saveAsset(database, { type: 'generic', content: '写周报' }, { id: 'g1' }).database;
  database = saveAsset(database, { type: 'generic', content: '写邮件' }, { id: 'g2' }).database;
  seedDatabase(stub.local, database);
  const provider = await handleRuntimeMessage({
    type: 'save-provider',
    password: '123456',
    provider: { kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: 'sk-test' }
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: '周报', categoryName: null, groups: [{ name: '工作', assetIds: ['g1', 'g2'] }], proposal: { summary: '合并', groups: [{ from: ['工作'], to: '沟通' }] } }) } }] })
  });
  await handleRuntimeMessage({ type: 'clear-ai-session' });
  const unlocked = await handleRuntimeMessage({ type: 'unlock-ai', password: '123456' });
  assert.equal(unlocked.providerId, provider.id);
  await handleRuntimeMessage({ type: 'queue-existing' });
  await handleRuntimeMessage({ type: 'process-ai-now' });
  const paused = structuredClone(stub.local['futurecontext.v1']);
  assert.deepEqual(paused.ai.queue, []);
  assert.equal(paused.ai.status.state, 'idle');
  const grouped = paused.assets.filter((asset) => ['g1', 'g2'].includes(asset.id));
  assert.equal(grouped.length, 2);
  assert.ok(grouped[0].categoryId);
  assert.equal(grouped[0].categoryId, grouped[1].categoryId);
  assert.ok(paused.ai.proposals.some((proposal) => proposal.summary === '合并'));
  paused.ai.queue = [{ id: 'q1', assetId: 'g1', assetType: 'generic', queuedAt: 1 }];
  paused.ai.enabled = true;
  seedDatabase(stub.local, paused);
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await handleRuntimeMessage({ type: 'process-ai-now' });
  const failedDatabase = stub.local['futurecontext.v1'];
  assert.equal(failedDatabase.ai.status.state, 'paused');
  assert.deepEqual(failedDatabase.ai.queue, paused.ai.queue);
  assert.deepEqual(failedDatabase.assets, paused.assets);
});

test('runtime onMessage wrapper, permission retry, and palette broadcast fallback', async () => {
  seedDatabase(stub.local, enableSites(createEmptyDatabase(), ['https://chatgpt.com']));
  const originalContains = stub.chrome.permissions.contains.bind(stub.chrome.permissions);
  stub.tabs[0].url = 'https://chatgpt.com/c/1';
  const broadcasts = [];
  const originalSend = stub.chrome.tabs.sendMessage;
  stub.chrome.tabs.sendMessage = async (tabId, message) => { broadcasts.push({ tabId, message }); return { ok: true }; };
  let containsCalls = 0;
  stub.chrome.permissions.contains = async (query) => {
    containsCalls += 1;
    if (containsCalls === 1) throw new Error('transient');
    return originalContains(query);
  };
  const originalExecute = stub.chrome.scripting.executeScript;
  stub.chrome.scripting.executeScript = async () => { throw new Error('no receiver'); };
  await handleRuntimeMessage({ type: 'sync-sites' });
  assert.ok(containsCalls >= 2, 'permission lookup must retry after the transient failure');
  assert.ok(broadcasts.some(({ tabId, message }) => tabId === 1 && message.type === 'fc-settings' && message.enabled === true));
  stub.chrome.tabs.sendMessage = originalSend;
  stub.chrome.scripting.executeScript = originalExecute;
  stub.chrome.permissions.contains = originalContains;
  const wrapped = stub.listeners.message[0];
  const ok = await new Promise((resolve) => wrapped({ type: 'read-notice' }, {}, resolve));
  assert.equal(ok.ok, true);
  const failed = await new Promise((resolve) => wrapped({ type: 'nope' }, {}, resolve));
  assert.equal(failed.ok, false);
  stub.tabs[0].url = 'https://www.douyin.com/';
  stub.listeners.command[0]('open-palette');
  await new Promise((resolve) => setTimeout(resolve, 80));
  stub.tabs[0].url = 'https://chatgpt.com/c/1';
});
