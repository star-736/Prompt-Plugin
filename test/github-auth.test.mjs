import assert from 'node:assert/strict';
import test from 'node:test';
import {
  githubToken,
  saveGitHubToken,
  restrictLocalStorage,
  githubFetch,
  redactGitHubHeaders,
  formatGitHubFetchLogLine,
  appendGitHubFetchLog,
  GITHUB_FETCH_LOG_KEY,
  GITHUB_FETCH_LOG_LIMIT
} from '../github-auth.js';
import { createBackup, createEmptyDatabase } from '../store.js';

function storage() {
  const data = {};
  const events = [];
  return { data, events, async get(key) { return { [key]: data[key] }; }, async setAccessLevel(value) { events.push(value); }, async set(value) { events.push('save'); Object.assign(data, value); }, async remove(key) { delete data[key]; } };
}
test('token saves only after restricting access, is replaceable and removable, and stays out of backups', async () => {
  const s = storage();
  assert.equal(await githubToken(s), '');
  await saveGitHubToken(' ghp_example ', s);
  assert.deepEqual(s.events, [{ accessLevel: 'TRUSTED_CONTEXTS' }, 'save']);
  assert.equal(await githubToken(s), 'ghp_example');
  assert.equal(JSON.stringify(createBackup(createEmptyDatabase())).includes('ghp_example'), false);
  await saveGitHubToken('github_pat_new', s);
  assert.equal(await githubToken(s), 'github_pat_new');
  await assert.rejects(saveGitHubToken('Bearer secret', s), /格式/);
  assert.equal(await githubToken(s), 'github_pat_new');
  await saveGitHubToken('', s);
  assert.equal(await githubToken(s), '');
});
test('restrictLocalStorage can run before any token is saved', async () => {
  const s = storage();
  await restrictLocalStorage(s);
  assert.deepEqual(s.events, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  assert.deepEqual(s.data, {});
});

test('failed access restriction never persists a token', async () => {
  const s = storage();
  s.setAccessLevel = async () => { throw new Error('denied'); };
  await assert.rejects(saveGitHubToken('ghp_secret', s), /denied/);
  assert.deepEqual(s.data, {});
});
test('authenticated fetch preserves Accept, rejects other origins and redirects; absent token is anonymous', async () => {
  const s = storage();
  const calls = [];
  const fetch = async (...args) => { calls.push(args); return { ok: true }; };
  await saveGitHubToken('ghp_example', s);
  const authenticated = await githubFetch(fetch, s);
  assert.equal(authenticated.hasToken, true);
  await authenticated('https://api.github.com/repos/acme/demo', { headers: { Accept: 'application/vnd.github+json' } });
  assert.deepEqual(calls[0][1], { redirect: 'error', headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ghp_example' } });
  assert.throws(() => authenticated('https://example.com/'), /拒绝/);
  assert.equal(calls.length, 1);
  await saveGitHubToken('', s);
  const anonymous = await githubFetch(fetch, s);
  assert.equal(anonymous.hasToken, false);
  await anonymous('https://api.github.com/repos/acme/demo');
  assert.equal(calls[1][1].headers.Authorization, undefined);
});

test('log helper redacts the token and caps the fetch ring', () => {
  const redacted = redactGitHubHeaders({ Authorization: 'Bearer ghp_secret', Accept: 'application/vnd.github+json' });
  assert.equal(redacted.Authorization, '[redacted]');
  assert.equal(redacted.Accept, 'application/vnd.github+json');
  assert.doesNotMatch(JSON.stringify(redactGitHubHeaders({ authorization: 'Bearer ghp_secret' })), /ghp_secret|Bearer /);
  const line = formatGitHubFetchLogLine({
    authenticated: true,
    status: 200,
    limit: '5000',
    remaining: '4999',
    path: '/repos/acme/demo'
  });
  assert.equal(line, '[futurecontext github] authenticated=true status=200 limit=5000 remaining=4999 path=/repos/acme/demo');
  const filled = Array.from({ length: GITHUB_FETCH_LOG_LIMIT }, (_, index) => ({ at: index }));
  const ring = appendGitHubFetchLog(filled, { at: 99, authenticated: false, status: 403, limit: '60', remaining: '0', path: '/rate_limit' });
  assert.equal(ring.length, GITHUB_FETCH_LOG_LIMIT);
  assert.equal(ring[0].at, 1);
  assert.equal(ring.at(-1).at, 99);
});

test('githubFetch logs one line and a storage ring without the token', async () => {
  const s = storage();
  const lines = [];
  const original = console.info;
  console.info = (...args) => { lines.push(args.join(' ')); };
  const fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => ({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' }[name] ?? null) }
  });
  try {
    await saveGitHubToken('ghp_secret', s);
    const request = await githubFetch(fetch, s);
    await request('https://api.github.com/repos/acme/demo/git/trees/abc');
    assert.equal(lines[0], '[futurecontext github] authenticated=true status=200 limit=5000 remaining=4999 path=/repos/acme/demo/git/trees/abc');
    assert.doesNotMatch(lines.join('\n'), /ghp_secret|Bearer|Authorization/i);
    const ring = s.data[GITHUB_FETCH_LOG_KEY];
    assert.equal(ring.length, 1);
    assert.equal(ring[0].authenticated, true);
    assert.equal(ring[0].status, 200);
    assert.equal(ring[0].limit, '5000');
    assert.equal(ring[0].remaining, '4999');
    assert.equal(ring[0].path, '/repos/acme/demo/git/trees/abc');
    assert.equal(typeof ring[0].at, 'number');
    assert.doesNotMatch(JSON.stringify(ring), /ghp_secret|Bearer|Authorization/i);
    for (let index = 0; index < GITHUB_FETCH_LOG_LIMIT + 5; index += 1) {
      await request('https://api.github.com/rate_limit');
    }
    assert.equal(s.data[GITHUB_FETCH_LOG_KEY].length, GITHUB_FETCH_LOG_LIMIT);
  } finally {
    console.info = original;
  }
});
