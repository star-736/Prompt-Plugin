import assert from 'node:assert/strict';
import test from 'node:test';
import { githubToken, saveGitHubToken, githubFetch } from '../github-auth.js';
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
  await authenticated('https://api.github.com/repos/acme/demo', { headers: { Accept: 'application/vnd.github+json' } });
  assert.deepEqual(calls[0][1], { redirect: 'error', headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ghp_example' } });
  assert.throws(() => authenticated('https://example.com/'), /拒绝/);
  assert.equal(calls.length, 1);
  await saveGitHubToken('', s);
  await (await githubFetch(fetch, s))('https://api.github.com/repos/acme/demo');
  assert.equal(calls[1][1].headers.Authorization, undefined);
});
