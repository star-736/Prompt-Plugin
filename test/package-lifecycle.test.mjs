import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_STORAGE_KEY, applyDatabaseChange, createEmptyDatabase, loadDatabase, saveGithubSkillAsset } from '../src/core/store.js';
import { commitGithubSkillPackage, importBackupRecords, removeAssetAndPackage } from '../src/features/skills/package-operations.js';
import { cleanupPackageCandidates, recoverUnreferencedPackages } from '../src/features/skills/package-lifecycle.js';
import { deletePackage, getPackage, listPackageIds, putPackage } from '../src/platform/package-store.js';
import { createMemoryIndexedDB, loadFreshEntry } from './helpers.mjs';

const skillContent = '---\nname: recovery\ndescription: test recovery\n---\n# Instructions';
const pkg = (id, commit = id) => ({ id, skillContent, files: [{ path: 'SKILL.md', size: 12, content: 'test' }], source: { repository: 'test/repo', directory: 'skills/recovery', commit, defaultBranch: 'main' } });
function fixture(database = createEmptyDatabase()) {
  const data = { [APP_STORAGE_KEY]: structuredClone(database) };
  const storage = {
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(values) { Object.assign(data, structuredClone(values)); }
  };
  const indexedDb = createMemoryIndexedDB();
  const adapters = {
    putPackage: (record) => putPackage(record, indexedDb),
    deletePackage: (id) => deletePackage(id, indexedDb)
  };
  const recovery = { storage, listPackages: () => listPackageIds(indexedDb), removePackage: adapters.deletePackage };
  return { data, storage, indexedDb, adapters, recovery };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test('a fresh recovery instance discovers an interrupted preparation without a process-local log', async () => {
  const { storage, indexedDb, recovery } = fixture();
  await assert.rejects(applyDatabaseChange(async () => {
    await putPackage(pkg('abandoned'), indexedDb);
    throw new Error('context interrupted before reference save');
  }, storage), /interrupted/);
  const restarted = await loadFreshEntry('../src/features/skills/package-lifecycle.js');
  assert.deepEqual(await restarted.recoverUnreferencedPackages(recovery), { deleted: 1, failed: 0, readOnly: false });
  assert.equal(await getPackage('abandoned', indexedDb), null);
  assert.deepEqual(await recoverUnreferencedPackages(recovery), { deleted: 0, failed: 0, readOnly: false });
});

test('recovery waits for an in-progress package commit and preserves its confirmed reference', async () => {
  const { storage, indexedDb, adapters, recovery } = fixture();
  const started = deferred(); const finish = deferred(); const set = storage.set;
  storage.set = async (values) => { started.resolve(); await finish.promise; await set(values); };
  const commit = commitGithubSkillPackage(createEmptyDatabase(), pkg('incoming'), { storage, ...adapters });
  await started.promise;
  let scanned = false;
  const sweep = recoverUnreferencedPackages({ ...recovery, listPackages: async () => { scanned = true; return recovery.listPackages(); } });
  await Promise.resolve();
  assert.equal(scanned, false);
  assert.ok(await getPackage('incoming', indexedDb));
  finish.resolve();
  await commit;
  assert.equal((await sweep).deleted, 0);
  assert.equal((await loadDatabase(storage)).assets[0].skillPackage.packageId, 'incoming');
  assert.ok(await getPackage('incoming', indexedDb));
});

test('post-delete cleanup rechecks a reference added by a queued writer', async () => {
  const database = saveGithubSkillAsset(createEmptyDatabase(), pkg('shared'), { id: 'first' }).database;
  const { storage, indexedDb, adapters, recovery } = fixture(database);
  await adapters.putPackage(pkg('shared'));
  const set = storage.set; let concurrent;
  storage.set = async (values) => {
    await set(values);
    if (!concurrent) concurrent = applyDatabaseChange((latest) => saveGithubSkillAsset(latest, pkg('shared'), { id: 'second' }).database, storage);
  };
  const acknowledged = await removeAssetAndPackage(database, 'first', { storage, deletePackage: adapters.deletePackage });
  await concurrent;
  assert.deepEqual(acknowledged.assets, []);
  assert.equal((await loadDatabase(storage)).assets[0].id, 'second');
  assert.ok(await getPackage('shared', indexedDb));
  assert.equal((await recoverUnreferencedPackages(recovery)).deleted, 0);
});

test('failed cleanup remains discoverable and a later sweep reclaims only unreferenced packages', async () => {
  const database = saveGithubSkillAsset(createEmptyDatabase(), pkg('old'), { id: 'skill' }).database;
  const { storage, indexedDb, adapters, recovery } = fixture(database);
  await adapters.putPackage(pkg('old'));
  const saved = await commitGithubSkillPackage(database, pkg('new'), {
    storage, ...adapters, updateAssetId: 'skill', deletePackage: async () => { throw new Error('cleanup unavailable'); }
  });
  assert.equal(saved.asset.skillPackage.packageId, 'new');
  assert.deepEqual(await listPackageIds(indexedDb), ['old', 'new']);
  assert.deepEqual(await recoverUnreferencedPackages({ ...recovery, removePackage: async () => { throw new Error('still unavailable'); } }), { deleted: 0, failed: 1, readOnly: false });
  assert.equal((await recoverUnreferencedPackages(recovery)).deleted, 1);
  assert.ok(await getPackage('new', indexedDb));
  const deleted = await removeAssetAndPackage(saved.database, 'skill', { storage, deletePackage: async () => { throw new Error('unavailable'); } });
  assert.deepEqual(deleted.assets, []);
  assert.equal((await recoverUnreferencedPackages(recovery)).deleted, 1);
});

test('shared references and future-version databases protect all files', async () => {
  const database = saveGithubSkillAsset(createEmptyDatabase(), pkg('shared'), { id: 'one' }).database;
  database.assets.push({ ...database.assets[0], id: 'two' });
  const { storage, data, indexedDb, adapters, recovery } = fixture(database);
  await adapters.putPackage(pkg('shared'));
  await removeAssetAndPackage(database, 'one', { storage, deletePackage: adapters.deletePackage });
  assert.ok(await getPackage('shared', indexedDb));
  await adapters.putPackage(pkg('orphan'));
  data[APP_STORAGE_KEY].version = 999;
  assert.deepEqual(await recoverUnreferencedPackages({ ...recovery, listPackages: () => assert.fail('read-only library scanned packages') }), { deleted: 0, failed: 0, readOnly: true });
  assert.deepEqual(await listPackageIds(indexedDb), ['shared', 'orphan']);
});

test('an ambiguous failed reference write preserves any package actually referenced on disk', async () => {
  const { storage, indexedDb, adapters, recovery } = fixture();
  const set = storage.set;
  storage.set = async (values) => { await set(values); throw new Error('acknowledgement lost'); };
  await assert.rejects(commitGithubSkillPackage(createEmptyDatabase(), pkg('confirmed'), { storage, ...adapters }), /acknowledgement/);
  assert.ok(await getPackage('confirmed', indexedDb));
  assert.equal((await recoverUnreferencedPackages(recovery)).deleted, 0);
});

test('partial backup writes and failed rollback are recovered after restart', async () => {
  const database = saveGithubSkillAsset(createEmptyDatabase(), pkg('source'), { id: 'source-asset' }).database;
  const backup = { format: 'futurecontext.backup', version: 2, categories: [], assets: database.assets, packages: [pkg('source')] };
  const { storage, indexedDb, adapters, recovery } = fixture();
  await assert.rejects(importBackupRecords(createEmptyDatabase(), backup, {
    storage, putPackage: async (record) => { await adapters.putPackage(record); throw new Error('package acknowledgement lost'); },
    deletePackage: async () => { throw new Error('rollback unavailable'); }
  }), /acknowledgement/);
  assert.equal((await loadDatabase(storage)).assets.length, 0);
  assert.equal((await listPackageIds(indexedDb)).length, 1);
  assert.equal((await recoverUnreferencedPackages(recovery)).deleted, 1);
});

test('backup import refuses a generated package ID already referenced by another asset', async () => {
  const existing = saveGithubSkillAsset(createEmptyDatabase(), pkg('protected'), { id: 'existing' }).database;
  const source = saveGithubSkillAsset(createEmptyDatabase(), pkg('source', 'other-commit'), { id: 'source' }).database;
  source.assets[0].skillPackage.source.repository = 'other/repo';
  const backup = { format: 'futurecontext.backup', version: 2, categories: [], assets: source.assets, packages: [pkg('source', 'other-commit')] };
  const { storage, indexedDb, adapters } = fixture(existing);
  await adapters.putPackage(pkg('protected'));
  await assert.rejects(importBackupRecords(existing, backup, { storage, ...adapters, idFactory: () => 'protected' }), /ID 已被资料库引用/);
  assert.equal((await getPackage('protected', indexedDb)).source.commit, 'protected');
  assert.equal((await loadDatabase(storage)).assets.length, 1);
});

test('failed reads or unavailable locks fail closed without deleting files', async () => {
  const { storage, indexedDb, adapters, recovery } = fixture();
  await adapters.putPackage(pkg('retain'));
  await assert.rejects(recoverUnreferencedPackages({ ...recovery, listPackages: async () => { throw new Error('inventory unreadable'); } }), /inventory/);
  storage.get = async () => { throw new Error('database unreadable'); };
  await assert.rejects(recoverUnreferencedPackages(recovery), /database/);
  await cleanupPackageCandidates(['retain'], recovery);
  await cleanupPackageCandidates([], recovery);
  assert.ok(await getPackage('retain', indexedDb));
});
