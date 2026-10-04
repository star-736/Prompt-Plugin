import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_STORAGE_KEY, createEmptyDatabase, saveAsset } from '../src/core/store.js';
import { SYNC_FORMAT, SYNC_PATH } from '../src/features/github/github-sync.js';
import {
  assertDisposableFixture, cleanupLiveFile, createLiveDevice, createLiveTransport,
  LIVE_FIXTURE_FORMAT, LIVE_FIXTURE_PATH, parseLiveArguments, runGitHubLive, safeLiveError, validateLiveConfig
} from '../scripts/github-live.mjs';

const config = () => ({
  publicRepository: 'test/public', privateRepository: 'test/private', skillPath: 'skills/test/SKILL.md',
  collectionToken: 'github_pat_synthetic_collection', syncToken: 'github_pat_synthetic_sync', allowFixtureWrites: true
});
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const encoded = (body) => Buffer.from(JSON.stringify(body)).toString('base64');

test('live checks require an explicit opt-in and an absolute external config path', () => {
  assert.throws(() => parseLiveArguments(['--config', '/tmp/config.json']), /默认关闭/);
  assert.throws(() => parseLiveArguments(['--enable', '--config', 'config.json']), /绝对/);
  assert.throws(() => parseLiveArguments(['--enable', '--unknown']), /参数/);
  assert.deepEqual(parseLiveArguments(['--enable', '--config', '/tmp/config.json', '--public-only']), { configPath: '/tmp/config.json', publicOnly: true });
  assert.equal(parseLiveArguments(['--config', '/tmp/config.json'], { FUTURECONTEXT_GITHUB_LIVE: '1' }).publicOnly, false);
});

test('live configuration refuses shared tokens, unsafe paths and implicit write permission', () => {
  assert.equal(validateLiveConfig(config()).privateRepository, 'test/private');
  for (const value of [
    { ...config(), publicRepository: 'invalid' }, { ...config(), skillPath: '../SKILL.md' },
    { ...config(), collectionToken: '' }, { ...config(), syncToken: config().collectionToken },
    { ...config(), privateRepository: config().publicRepository }, { ...config(), allowFixtureWrites: false },
    { ...config(), readOnlyToken: config().syncToken }
  ]) assert.throws(() => validateLiveConfig(value));
  assert.equal(validateLiveConfig({ publicRepository: 'test/public', skillPath: 'skills/test/SKILL.md', collectionToken: config().collectionToken }, { publicOnly: true }).publicOnly, true);
});

test('transport restricts all requests and mutations to explicit test targets and caps budgets', async () => {
  const calls = [];
  const transport = createLiveTransport(config(), { requestLimit: 2, writeLimit: 1, fetchImpl: async (url, options) => { calls.push({ url, options }); return response({}); } });
  for (const url of ['https://example.com/repos/test/private', 'https://api.github.com/repos/test/other', 'https://secret@api.github.com/repos/test/private']) await assert.rejects(transport.request(url), /超出/);
  await assert.rejects(transport.request('https://api.github.com/repos/test/public/contents/test', { method: 'PUT' }), /仅允许/);
  await assert.rejects(transport.request('https://api.github.com/repos/test/private', { method: 'PATCH' }), /方法/);
  assert.equal(calls.length, 0);
  const url = `https://api.github.com/repos/test/private/contents/${SYNC_PATH}`;
  await transport.request(url, { method: 'PUT', headers: { Authorization: 'Bearer synthetic' } });
  await assert.rejects(transport.request(url, { method: 'PUT' }), /写入预算/);
  await transport.request('https://api.github.com/repos/test/public');
  await assert.rejects(transport.request('https://api.github.com/repos/test/public'), /请求预算/);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(JSON.stringify(transport.events).includes('synthetic'), false);
  const readOnly = createLiveTransport({ ...config(), publicOnly: true }, { fetchImpl: async () => assert.fail('public-only wrote') });
  await assert.rejects(readOnly.request(url, { method: 'DELETE' }), /仅允许/);
});

test('disposable fixture checks reject public/org repositories, missing markers and existing libraries', async () => {
  for (const info of [{ private: false, owner: { type: 'User' } }, { private: true, owner: { type: 'Organization' } }]) {
    const calls = [];
    await assert.rejects(assertDisposableFixture(async (url) => { calls.push(url); return response(info); }, 'test/private'), /个人私有/);
    assert.equal(calls.length, 1);
  }
  const routes = (marker, exists = false) => async (url) => {
    if (url.endsWith('/test/private')) return response({ private: true, owner: { type: 'User' } });
    if (url.endsWith(LIVE_FIXTURE_PATH)) return response({ content: encoded(marker) });
    if (url.endsWith(SYNC_PATH)) return exists ? response({ sha: 'abc', size: 1, content: encoded({ format: SYNC_FORMAT, version: 1, records: {} }) }) : response({}, 404);
    throw new Error('Unexpected route');
  };
  await assert.rejects(assertDisposableFixture(routes({}), 'test/private'), /标记/);
  await assert.rejects(assertDisposableFixture(routes({ format: LIVE_FIXTURE_FORMAT, version: 1 }, true), 'test/private'), /已存在/);
  await assertDisposableFixture(routes({ format: LIVE_FIXTURE_FORMAT, version: 1 }), 'test/private');
});

test('cleanup only deletes a file proven to belong to the current run, using its latest SHA', async () => {
  for (const id of ['foreign', 'live-owned-prompt']) {
    const asset = saveAsset(createEmptyDatabase(), { type: 'generic', content: 'Synthetic' }, { id, now: 1 }).asset;
    const { useCount, lastUsedAt, ...value } = asset;
    const document = { format: SYNC_FORMAT, version: 1, records: { [`asset:${id}`]: { value } } };
    const writes = [];
    const request = async (url, options = {}) => {
      if (options.method === 'DELETE') { writes.push(JSON.parse(options.body)); return response({}); }
      if (url.endsWith('/test/private')) return response({ private: true, owner: { type: 'User' } });
      if (url.endsWith(LIVE_FIXTURE_PATH)) return response({ content: encoded({ format: LIVE_FIXTURE_FORMAT, version: 1 }) });
      return response({ sha: 'latestsha', size: 20, content: encoded(document) });
    };
    if (id === 'foreign') { await assert.rejects(cleanupLiveFile(request, 'test/private', 'live-owned-'), /归属/); assert.equal(writes.length, 0); }
    else { await cleanupLiveFile(request, 'test/private', 'live-owned-'); assert.equal(writes[0].sha, 'latestsha'); }
  }
});

test('devices remain isolated and errors never echo real configuration credentials', async () => {
  const a = createLiveDevice(); const b = createLiveDevice();
  await a.storage.set({ [APP_STORAGE_KEY]: { ...createEmptyDatabase(), revision: 3 } });
  await a.adapters.writePackage({ id: 'test', files: [] });
  assert.equal((await b.storage.get(APP_STORAGE_KEY))[APP_STORAGE_KEY].revision, 0);
  assert.equal(await b.adapters.readPackage('test'), null);
  await a.adapters.removePackage('test');
  assert.equal(await a.adapters.readPackage('test'), null);
  const message = safeLiveError(new Error(`${config().collectionToken} ${config().syncToken} ghp_accidental_log`), config());
  assert.doesNotMatch(message, /github_pat_|ghp_|synthetic/);
});

test('the full runner exercises realistic Contents/blob shapes, SHA races, cancellation and safe cleanup offline', async () => {
  const cfg = { ...config(), readOnlyToken: 'github_pat_synthetic_readonly' };
  const old = 'a'.repeat(40); const current = 'b'.repeat(40);
  const skill = '---\nname: synthetic-fixture\ndescription: synthetic fixture\n---\n# Instructions';
  const files = [{ path: cfg.skillPath, sha: 'skill', content: skill }, { path: 'skills/test/references/中文.md', sha: 'reference', content: '中文' }];
  let remote = null; let sha = 0; let cleaned = false;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url); const path = parsed.pathname;
    const auth = options.headers.Authorization ?? '';
    if (auth.includes('intentionally_invalid')) return response({ message: 'Bad credentials' }, 401);
    if (path === '/repos/test/public') return response({ private: false, owner: { type: 'User' }, default_branch: 'main' });
    if (path === '/repos/test/private') return response({ private: true, owner: { type: 'User' } });
    if (path === '/repos/test/public/commits' && parsed.search) return response([{ sha: current }, { sha: old }]);
    if (path === '/repos/test/public/commits/main') return response({ sha: current });
    if (path.includes('/git/trees/')) return response({ truncated: false, tree: files.map((file) => ({ type: 'blob', path: file.path, sha: file.sha, size: Buffer.byteLength(file.content) })) });
    if (path.includes('/git/blobs/')) {
      if (path.includes('/test/private/')) return response({ content: encoded(remote), encoding: 'base64' });
      const file = files.find((value) => path.endsWith(value.sha));
      return response({ content: Buffer.from(file.content).toString('base64'), encoding: 'base64' });
    }
    if (path.endsWith(LIVE_FIXTURE_PATH)) return response({ content: encoded({ format: LIVE_FIXTURE_FORMAT, version: 1 }) });
    if (path.endsWith(SYNC_PATH)) {
      if (options.method === 'DELETE') { assert.equal(JSON.parse(options.body).sha, String(sha)); remote = null; cleaned = true; return response({}); }
      if (options.method === 'PUT') {
        if (auth.includes('synthetic_readonly')) return response({ message: 'Resource not accessible by personal access token' }, 403);
        const body = JSON.parse(options.body);
        if (remote && body.sha !== String(sha)) return response({ message: 'sha does not match' }, 409);
        remote = JSON.parse(Buffer.from(body.content, 'base64').toString()); sha += 1;
        return response({ content: { sha: String(sha) } }, 201);
      }
      if (!remote) return response({ message: 'Not Found' }, 404);
      const size = Buffer.byteLength(JSON.stringify(remote));
      return response({ sha: String(sha), size, content: size > 1024 * 1024 ? '' : encoded(remote), encoding: size > 1024 * 1024 ? 'none' : 'base64' });
    }
    throw new Error('Unexpected offline contract route');
  };
  const result = await runGitHubLive(cfg, { fetchImpl, report: () => {} });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.passes.length, 12);
  assert.ok(result.events.some((event) => event.status === 409));
  assert.ok(result.events.some((event) => event.status === 403));
  assert.equal(cleaned, true);
  assert.equal(remote, null);
});
