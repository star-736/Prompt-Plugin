import assert from 'node:assert/strict';
import test from 'node:test';
import { createChromeStub } from './helpers.mjs';
import { SYNC_SETTINGS_DRAFT_KEY, readSyncSettingsDraft, writeSyncSettingsDraft, discardSyncSettingsDraft, submitSyncSettings } from '../src/background/sync-settings-draft.js';

test('draft stays in trusted session storage and failed submission keeps input', async () => {
  const stub = createChromeStub();
  const storage = stub.chrome.storage.session;
  assert.equal(await readSyncSettingsDraft(storage), null);
  await writeSyncSettingsDraft({ repository: 'owner/repo', token: 'partial token', enabled: true, automatic: false, secret: 'ignored' }, storage);
  assert.deepEqual(stub.session[SYNC_SETTINGS_DRAFT_KEY], { repository: 'owner/repo', token: 'partial token', enabled: true, automatic: false });
  assert.deepEqual(stub.local, {});
  await assert.rejects(submitSyncSettings(async () => { throw new Error('invalid'); }, storage), /invalid/);
  assert.equal((await readSyncSettingsDraft(storage)).token, 'partial token');
  await discardSyncSettingsDraft(storage);
  assert.equal(await readSyncSettingsDraft(storage), null);
});

test('submission waits for rapid queued input and clears it even after the popup closes', async () => {
  const stub = createChromeStub();
  const storage = stub.chrome.storage.session;
  const set = storage.set;
  let release;
  storage.set = async (values) => { await new Promise((resolve) => { release = resolve; }); await set(values); };
  const first = writeSyncSettingsDraft({ repository: 'first' }, storage);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const second = writeSyncSettingsDraft({ repository: 'last', token: 'draft' }, storage);
  let submitted = false;
  const save = submitSyncSettings(async () => { submitted = true; assert.equal(stub.session[SYNC_SETTINGS_DRAFT_KEY].repository, 'last'); return { configured: true }; }, storage);
  assert.equal(submitted, false);
  storage.set = set; release();
  await Promise.all([first, second, save]);
  assert.equal(submitted, true);
  assert.equal(await readSyncSettingsDraft(storage), null);
});

test('failed access restriction writes no token, queue recovers, cleanup failure preserves successful save', async () => {
  const stub = createChromeStub();
  const storage = stub.chrome.storage.session;
  const restrict = storage.setAccessLevel;
  storage.setAccessLevel = async () => { throw new Error('denied'); };
  await assert.rejects(writeSyncSettingsDraft({ token: 'draft' }, storage), /denied/);
  assert.equal(stub.session[SYNC_SETTINGS_DRAFT_KEY], undefined);
  storage.setAccessLevel = restrict;
  await writeSyncSettingsDraft({}, storage);
  const remove = storage.remove;
  storage.remove = async () => { throw new Error('cleanup'); };
  const result = await submitSyncSettings(async () => ({ configured: true }), storage);
  assert.equal(result.configured, true);
  assert.match(result.draftWarning, /设置已保存/);
  storage.remove = remove;
  await discardSyncSettingsDraft(storage);
});
