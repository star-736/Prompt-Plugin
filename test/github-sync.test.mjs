import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyDatabase, saveAsset, createCategory, applyDatabaseChange, loadDatabase, APP_STORAGE_KEY } from '../store.js';
import { libraryRecords, validateSyncDocument, mergeLibrary, applyLibrary, configureSync, removeSyncConfiguration, syncSettings, runLibrarySync, scheduleLibrarySync, relevantLibraryChange, SYNC_CONFIG_KEY, SYNC_STATUS_KEY, SYNC_FORMAT, SYNC_PATH } from '../github-sync.js';

function storageFor(database = createEmptyDatabase()) {
  const data = { [APP_STORAGE_KEY]: structuredClone(database) };
  return { data, async get(key) { return structuredClone(typeof key === 'string' ? { [key]: data[key] } : Object.fromEntries(key.map((k) => [k, data[k]]))); }, async set(values) { Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; }, async setAccessLevel(options) { assert.equal(options.accessLevel, 'TRUSTED_CONTEXTS'); } };
}
const asset = (id = 'a', content = 'hello', type = 'generic') => saveAsset(createEmptyDatabase(), { type, privacy: 'normal', title: 'title', content }, { id, now: 10 }).database.assets[0];
const record = (id = 'a', content = 'hello', type = 'generic') => { const { useCount, lastUsedAt, skillDelivery, ...value } = asset(id, content, type); return { value }; };
const doc = (records = {}) => ({ format: SYNC_FORMAT, version: 1, records });
const payload = (records) => Buffer.from(JSON.stringify(doc(records))).toString('base64');
const skill = '---\nname: demo\ndescription: example\n---\n# hi';
const source = { repository: 'owner/repo', directory: 'skills/demo', commit: 'a'.repeat(40), defaultBranch: 'main', url: 'https://github.com/owner/repo' };
const packageRecord = () => ({ id: 'p', files: [{ path: 'SKILL.md', size: Buffer.byteLength(skill), encoding: 'base64', content: Buffer.from(skill).toString('base64'), contentType: 'text/plain', sourcePath: 'secret', sha: 'localsha', handle: 'secret' }], source });
function api(records = {}, { missing = false, publicRepo = false, conflicts = 0, large = false, onPut, onRepo } = {}) {
  let writes = 0; let reads = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, 'Bearer github_pat_sync');
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/owner/repo')) { await onRepo?.(++reads); return { ok: true, json: async () => ({ private: !publicRepo, owner: { type: 'User' } }) }; }
    if (options.method === 'PUT') {
      writes += 1; await onPut?.(writes);
      if (writes <= conflicts) return { ok: false, status: 409 };
      records = JSON.parse(Buffer.from(JSON.parse(options.body).content, 'base64').toString()).records;
      return { ok: true, json: async () => ({ content: { sha: 'new' } }) };
    }
    if (url.endsWith(`/contents/${SYNC_PATH}`)) return missing && writes === 0 ? { ok: false, status: 404 } : { ok: true, json: async () => ({ sha: 'sha', size: 10, ...(large ? {} : { content: payload(records) }) }) };
    if (url.endsWith('/git/blobs/sha')) return { ok: true, json: async () => ({ content: payload(records) }) };
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls, get records() { return records; }, get writes() { return writes; } };
}
async function configured(database = createEmptyDatabase()) { const storage = storageFor(database); await configureSync({ repository: 'owner/repo', token: 'github_pat_sync', enabled: true }, storage); return storage; }

test('whitelist excludes private content, categories, drafts, credentials and device state; only associated Skill bytes travel', async () => {
  const database = createEmptyDatabase();
  database.assets = [asset(), { ...asset('private', 'PRIVATE', 'aigc'), privacy: 'private' }, { ...asset('skill', skill, 'skill'), skillPackage: { packageId: 'p', source }, skillDelivery: { codex: 'secret' }, apiKey: 'secret' }, asset('cmd', 'ls', 'command'), asset('image', 'sunset', 'aigc')];
  database.categories = [{ id: 'c', scope: 'generic', name: 'normal', createdAt: 99, handle: 'secret' }, { id: 'private-category', scope: 'aigc-private', name: 'PRIVATE' }];
  database.drafts = { secret: 'PRIVATE' }; database.settings.token = 'secret'; database.lock.passwordDigest = 'secret';
  const reads = [];
  const records = await libraryRecords(database, async (id) => { reads.push(id); return packageRecord(); });
  assert.deepEqual(reads, ['p']);
  assert.equal(Object.keys(records).length, 5);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|secret|Delivery|createdAt.*99/);
  validateSyncDocument(doc(records));
  await assert.rejects(libraryRecords(database, async () => null), /缺失/);
});

test('remote schema fails closed for secrets, private records, unsafe paths, inconsistent files and invalid metadata', async () => {
  const db = createEmptyDatabase(); db.assets = [{ ...asset('skill', skill, 'skill'), skillPackage: { packageId: 'p', source } }];
  const valid = await libraryRecords(db, async () => packageRecord());
  validateSyncDocument(doc(valid));
  const cases = [
    (d) => { d.token = 'secret'; }, (d) => { d.version = 2; }, (d) => { d.records = []; },
    (d) => { d.records['asset:skill'].value.privacy = 'private'; },
    (d) => { d.records['asset:skill'].value.id = 'other'; },
    (d) => { d.records['asset:skill'].value.apiKey = 'secret'; },
    (d) => { d.records['asset:skill'].value.updatedAt = NaN; },
    (d) => { d.records['asset:skill'].value.categoryId = '../escape'; },
    (d) => { d.records['asset:skill'].value.content = 'not a skill'; },
    (d) => { d.records['asset:skill'].value.package.source = {}; },
    (d) => { d.records['asset:skill'].value.package.source.token = 'secret'; },
    (d) => { d.records['asset:skill'].value.package.files[0].path = '../secret'; },
    (d) => { d.records['asset:skill'].value.package.files[0].size = 1; },
    (d) => { d.records['asset:skill'].value.package.files[0].content = '%%%'; },
    (d) => { d.records['asset:skill'].value.package.files[0].encoding = 'utf8'; },
    (d) => { d.records['asset:skill'].value.package.files[0].path = 'other.md'; },
    (d) => { d.records['asset:skill'].value.package.files.push(d.records['asset:skill'].value.package.files[0]); },
    (d) => { d.records['asset:skill'].withdrawn = true; },
    (d) => { d.records['asset:skill'].value.skillDescription = {}; },
    (d) => { d.records['asset:skill'].value.titleSource = {}; },
    (d) => { d.records['asset:skill'].value.pinned = 'true'; },
    (d) => { d.records['category:c'] = { value: { id: 'c', scope: 'aigc-private', name: 'private' } }; }
  ];
  for (const change of cases) { const value = structuredClone(doc(valid)); change(value); assert.throws(() => validateSyncDocument(value)); }
  assert.throws(() => validateSyncDocument(null));
  assert.throws(() => validateSyncDocument(doc({ 'asset:a': { deleted: true, value: asset() } })));
  assert.throws(() => validateSyncDocument(doc({ 'category:c': { deleted: true, withdrawn: true } })));
});

test('three-way merge handles initial union, edits, renames, deletes and deterministic conflict preservation', () => {
  const original = { 'asset:a': record() }; const local = { 'asset:a': record('a', 'local') }; const remote = { 'asset:a': record('a', 'remote') };
  assert.deepEqual(mergeLibrary(local, original, original).records, local);
  assert.deepEqual(mergeLibrary(original, remote, original).records, remote);
  assert.deepEqual(mergeLibrary({}, original, original).records, { 'asset:a': { deleted: true } });
  assert.deepEqual(mergeLibrary(original, { 'asset:a': { deleted: true } }, original).records, { 'asset:a': { deleted: true } });
  const conflict = mergeLibrary(local, remote, original);
  assert.equal(conflict.conflicts, 1); assert.equal(Object.keys(conflict.records).length, 2);
  assert.deepEqual(conflict, mergeLibrary(local, remote, original));
  assert.deepEqual(mergeLibrary({ 'asset:a': record() }, { 'asset:b': record('b') }).records, { 'asset:a': record(), 'asset:b': record('b') });
  const categories = { 'category:c': { value: { id: 'c', scope: 'generic', name: 'old' } } };
  const l = { 'category:c': { value: { id: 'c', scope: 'generic', name: 'local' } } };
  const r = { 'category:c': { value: { id: 'c', scope: 'generic', name: 'remote' } }, 'asset:r': { value: { ...asset('r'), categoryId: 'c' } } };
  const renamed = mergeLibrary(l, r, categories);
  const copy = Object.values(renamed.records).find((v) => v.value?.name?.includes('同步冲突'));
  assert.equal(renamed.records['asset:r'].value.categoryId, copy.value.id);
});

test('private transitions withdraw all remote ordinary/conflict counterparts; offline edit kept only as local private copy', () => {
  const original = { 'asset:a': record('a', 'old', 'aigc') };
  const moved = mergeLibrary({}, original, original, ['a']);
  assert.deepEqual(moved.records['asset:a'], { deleted: true, withdrawn: true });
  assert.deepEqual(mergeLibrary({}, {}, {}, ['never-public']).records, {});
  const edited = { 'asset:a': record('a', 'offline edit', 'aigc'), 'asset:a.conflict-old': record('a.conflict-old', 'old conflict', 'aigc') };
  const pulled = mergeLibrary(edited, moved.records, original);
  assert.equal(pulled.records['asset:a'].withdrawn, true);
  assert.equal(pulled.records['asset:a.conflict-old'].withdrawn, true);
  const db = createEmptyDatabase(); db.assets = [edited['asset:a'].value];
  const applied = applyLibrary(db, pulled.records, pulled.privateConflicts);
  assert.equal(applied.assets.filter((v) => v.privacy === 'normal').length, 0);
  assert.equal(applied.assets.some((v) => v.privacy === 'private' && v.content === 'offline edit'), true);
  const privateDb = createEmptyDatabase(); privateDb.assets = [{ ...asset('a', 'private', 'aigc'), privacy: 'private' }];
  const protectedDb = applyLibrary(privateDb, { ...original, 'asset:a.conflict-old': record('a.conflict-old', 'remote', 'aigc') });
  assert.deepEqual(protectedDb.assets, privateDb.assets);
});

test('configuration is dedicated, trusted-only, non-echoing and removable', async () => {
  const storage = storageFor();
  await assert.rejects(configureSync({ repository: 'bad', token: 'x' }, storage), /owner\/repo/);
  await assert.rejects(configureSync({ repository: 'a/b', token: 'bad token' }, storage), /Token/);
  await configureSync({ repository: 'https://github.com/owner/repo/', token: 'github_pat_sync', enabled: true, automatic: false }, storage);
  assert.equal((await syncSettings(storage)).configured, true);
  assert.doesNotMatch(JSON.stringify(await syncSettings(storage)), /github_pat/);
  await configureSync({ repository: 'owner/repo', token: '', enabled: false }, storage);
  assert.equal(storage.data[SYNC_CONFIG_KEY].token, 'github_pat_sync');
  await removeSyncConfiguration(storage);
  assert.equal((await syncSettings(storage)).configured, false);
  assert.equal((await runLibrarySync({ storage })).enabled, false);
});

test('initial connection merges both libraries and commits with remote SHA without rewriting history', async () => {
  const db = createEmptyDatabase(); db.assets = [asset('local')];
  const storage = await configured(db); const server = api({ 'asset:remote': record('remote') });
  const result = await runLibrarySync({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.status.state, 'success');
  assert.deepEqual((await loadDatabase(storage)).assets.map((a) => a.id).sort(), ['local', 'remote']);
  const put = server.calls.find((v) => v.options.method === 'PUT');
  assert.equal(JSON.parse(put.options.body).sha, 'sha');
  assert.equal(server.calls.filter((v) => v.url.endsWith('/owner/repo')).length, 2);
  assert.equal((await loadDatabase(storage)).syncLedger.repository, 'owner/repo');
});

test('public/org repositories fail before upload; malformed remote and offline failures preserve local saves', async () => {
  const storage = await configured(); const server = api({}, { publicRepo: true });
  await assert.rejects(runLibrarySync({ storage, fetchImpl: server.fetchImpl }), /私有仓库/);
  assert.equal(server.writes, 0);
  assert.equal(storage.data[SYNC_STATUS_KEY].state, 'error');
  await assert.rejects(runLibrarySync({ storage, fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
  await applyDatabaseChange((db) => saveAsset(db, { type: 'command', content: 'ls' }, { id: 'saved' }), storage);
  assert.equal((await loadDatabase(storage)).assets[0].id, 'saved');
  const malformed = api({ 'asset:bad': { value: { ...asset('bad'), privacy: 'private' } } });
  await assert.rejects(runLibrarySync({ storage, fetchImpl: malformed.fetchImpl }), /格式无效/);
  assert.equal(malformed.writes, 0);
});

test('missing remote starts safely, SHA conflict retries refetch, large Contents fallback reads blob', async () => {
  const db = createEmptyDatabase(); db.assets = [asset()];
  const storage = await configured(db); const server = api({}, { missing: true, conflicts: 1, large: true });
  await runLibrarySync({ storage, fetchImpl: server.fetchImpl });
  assert.equal(server.writes, 2);
  assert.equal(server.records['asset:a'].value.content, 'hello');
  const large = api(server.records, { large: true });
  await runLibrarySync({ storage, fetchImpl: large.fetchImpl });
  assert.equal(large.calls.some((v) => v.url.includes('/git/blobs/')), true);
  assert.equal(large.writes, 0);
  const failed = api({}, { conflicts: 10 });
  await assert.rejects(runLibrarySync({ storage, fetchImpl: failed.fetchImpl }), /409/);
  assert.equal(failed.writes, 3);
});

test('configuration change cancels stale network responses, status and pull without token/config races', async () => {
  const storage = await configured();
  let release; const gate = new Promise((resolve) => { release = resolve; }); let started; const ready = new Promise((resolve) => { started = resolve; });
  const server = api({ 'asset:r': record('r') }, { onRepo: async () => { started(); await gate; } });
  const running = runLibrarySync({ storage, fetchImpl: server.fetchImpl });
  assert.equal(runLibrarySync({ storage, fetchImpl: server.fetchImpl }), running);
  await ready;
  await configureSync({ repository: 'owner/repo', token: 'github_pat_new', enabled: false }, storage);
  release();
  await assert.rejects(running, /取消/);
  assert.equal((await loadDatabase(storage)).assets.length, 0);
  assert.equal(storage.data[SYNC_STATUS_KEY].state, 'idle');
  assert.equal(server.writes, 0);
});

test('local edit while pulling is retried before upload; local edit during upload preserved on final apply', async () => {
  const db = createEmptyDatabase(); db.assets = [asset()];
  const storage = await configured(db); let edited = false;
  const server = api({}, { onRepo: async (count) => { if (count === 1 && !edited) { edited = true; await applyDatabaseChange((latest) => saveAsset(latest, { ...latest.assets[0], content: 'new' }), storage); } } });
  await runLibrarySync({ storage, fetchImpl: server.fetchImpl });
  assert.equal(server.records['asset:a'].value.content, 'new');
  const privateStorage = await configured(db);
  const privateServer = api({ 'asset:a': record('a', 'remote') }, { onRepo: async (count) => { if (count === 1) await applyDatabaseChange((latest) => saveAsset(latest, { ...latest.assets[0], type: 'aigc', privacy: 'private', content: 'PRIVATE' }), privateStorage); } });
  await runLibrarySync({ storage: privateStorage, fetchImpl: privateServer.fetchImpl });
  assert.equal(privateServer.records['asset:a'].withdrawn, true);
  assert.doesNotMatch(JSON.stringify(privateServer.records), /PRIVATE/);
  assert.equal((await loadDatabase(privateStorage)).assets[0].privacy, 'private');
});

test('Skill package pull writes immutable local packages and preserves delivery/usage metadata', async () => {
  const db = createEmptyDatabase(); db.assets = [{ ...asset('skill', skill, 'skill'), skillPackage: { packageId: 'p', source }, useCount: 9, skillDelivery: { targets: {} } }];
  const records = await libraryRecords(db, async () => packageRecord());
  const storage = await configured(db); const server = api(records); const written = [];
  await runLibrarySync({ storage, fetchImpl: server.fetchImpl, readPackage: async () => packageRecord(), writePackage: async (v) => written.push(v) });
  assert.equal(written.length, 1);
  const stored = (await loadDatabase(storage)).assets[0];
  assert.equal(stored.useCount, 9); assert.ok(stored.skillPackage.packageId.startsWith('sync-'));
  assert.equal(stored.skillPackage.source.defaultBranch, 'main');
  assert.equal(written[0].files[0].path, 'SKILL.md');
});

test('auto scheduling respects opt-out, periodic checks and durable debounce; relevant changes exclude drafts/usage/device data', async () => {
  const storage = await configured(); const calls = []; const alarms = { async create(...args) { calls.push(['create', ...args]); }, async clear(...args) { calls.push(['clear', ...args]); } };
  await scheduleLibrarySync({ storage, alarms }); await scheduleLibrarySync({ storage, alarms, changed: true });
  assert.deepEqual(calls[0][2], { periodInMinutes: 5 }); assert.deepEqual(calls[1][2], { delayInMinutes: 0.5 });
  await configureSync({ repository: 'owner/repo', enabled: true, automatic: false }, storage);
  await scheduleLibrarySync({ storage, alarms }); assert.equal(calls.filter((v) => v[0] === 'clear').length, 2);
  const before = createEmptyDatabase(); before.assets = [asset()]; const after = structuredClone(before);
  after.drafts.a = 'secret'; after.assets[0].useCount = 8; after.assets[0].skillDelivery = { secret: true }; after.settings.key = 'secret';
  assert.equal(relevantLibraryChange(before, after), false);
  after.assets[0].content = 'changed'; assert.equal(relevantLibraryChange(before, after), true);
  after.assets[0].privacy = 'private'; assert.equal(relevantLibraryChange(before, after), true);
  before.assets[0].privacy = 'private'; after.assets[0].content = 'private edit'; assert.equal(relevantLibraryChange(before, after), false);
  after.assets.push({ ...asset('private-new', 'PRIVATE', 'aigc'), privacy: 'private' }); assert.equal(relevantLibraryChange(before, after), false);
  const next = applyLibrary(before, { 'category:c': { value: { id: 'c', name: 'x', scope: 'generic' } } }); assert.equal(next.categories.length, 1);
});

test('storage object key ordering does not create conflicts or prevent ordinary remote edits', async () => {
  const original = { 'asset:a': record() };
  const reordered = Object.fromEntries(Object.entries(original).map(([key, r]) => [key, { value: Object.fromEntries(Object.entries(r.value).sort(([a], [b]) => a.localeCompare(b))) }]));
  const edited = { 'asset:a': record('a', 'edited') };
  assert.equal(mergeLibrary(original, edited, reordered).conflicts, 0);
  assert.deepEqual(mergeLibrary(original, edited, reordered).records, edited);
  assert.equal(mergeLibrary(edited, original, reordered).conflicts, 0);
  assert.deepEqual(mergeLibrary(edited, original, reordered).records, edited);
  const conflict1 = mergeLibrary(edited, { 'asset:a': record('a', 'other') }, original);
  const conflict2 = mergeLibrary(edited, { 'asset:a': { value: Object.fromEntries(Object.entries(record('a', 'other').value).reverse()) } }, reordered);
  assert.deepEqual(conflict1, conflict2);
});

test('private to normal deliberate release assigns a new ID so old withdrawal stays immutable', async () => {
  const { moveAigcAsset } = await import('../store.js');
  let database = createEmptyDatabase(); database.assets = [asset('a', 'image', 'aigc')];
  database = moveAigcAsset(database, 'a', 'private', 11);
  assert.equal(database.assets[0].id, 'a');
  const normal = moveAigcAsset(database, 'a', 'normal', 12);
  assert.notEqual(normal.assets[0].id, 'a');
  assert.equal(normal.assets[0].privacy, 'normal');
  const edited = saveAsset(database, { ...database.assets[0], privacy: 'normal' }, { now: 13 });
  assert.notEqual(edited.asset.id, 'a');
  assert.equal(edited.asset.content, 'image');
});

test('delete/edit conflict retains tombstone and a clearly labelled preserved edited copy', () => {
  const base = { 'asset:a': record() };
  const merged = mergeLibrary({ 'asset:a': record('a', 'edited') }, { 'asset:a': { deleted: true } }, base);
  assert.equal(merged.records['asset:a'].deleted, true);
  const copy = Object.values(merged.records).find((value) => value.value);
  assert.equal(copy.value.content, 'edited');
  assert.match(copy.value.title, /同步冲突/);
});

test('upload lock serializes privacy move and later pull cannot overwrite the acknowledged private save', async () => {
  const db = createEmptyDatabase(); db.assets = [asset('a', 'ordinary', 'aigc')];
  const storage = await configured(db);
  let release; const gate = new Promise((resolve) => { release = resolve; }); let started; const ready = new Promise((resolve) => { started = resolve; });
  const server = api({}, { onPut: async () => { started(); await gate; } });
  const syncing = runLibrarySync({ storage, fetchImpl: server.fetchImpl });
  await ready;
  let moved = false;
  const moving = applyDatabaseChange((latest) => saveAsset(latest, { ...latest.assets[0], privacy: 'private', content: 'PRIVATE newest' }), storage).then(() => { moved = true; });
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(moved, false);
  release(); await Promise.all([syncing, moving]);
  assert.equal((await loadDatabase(storage)).assets[0].privacy, 'private');
  assert.equal((await loadDatabase(storage)).assets[0].content, 'PRIVATE newest');
  await runLibrarySync({ storage, fetchImpl: server.fetchImpl });
  assert.equal(server.records['asset:a'].withdrawn, true);
  assert.doesNotMatch(JSON.stringify(server.records), /PRIVATE/);
});

test('no-op checks do not rewrite database revisions or immutable Skill packages', async () => {
  const db = createEmptyDatabase(); db.assets = [{ ...asset('skill', skill, 'skill'), skillPackage: { packageId: 'p', source } }];
  const records = await libraryRecords(db, async () => packageRecord());
  const storage = await configured(db); const server = api(records); let writes = 0;
  const options = { storage, fetchImpl: server.fetchImpl, readPackage: async () => packageRecord(), writePackage: async () => { writes += 1; } };
  await runLibrarySync(options); const revision = (await loadDatabase(storage)).revision;
  await runLibrarySync(options);
  assert.equal((await loadDatabase(storage)).revision, revision);
  assert.equal(writes, 1); assert.equal(server.writes, 0);
});

test('snapshot limits, read-only database and organization repositories fail closed', async () => {
  const readOnly = createEmptyDatabase(); readOnly.version = 999;
  const storage = await configured(readOnly); const server = api();
  await assert.rejects(runLibrarySync({ storage, fetchImpl: server.fetchImpl }), /只读/); assert.equal(server.writes, 0);
  const org = await configured();
  await assert.rejects(runLibrarySync({ storage: org, fetchImpl: async () => ({ ok: true, json: async () => ({ private: true, owner: { type: 'Organization' } }) }) }), /个人/);
  const oversized = await configured();
  await assert.rejects(runLibrarySync({ storage: oversized, fetchImpl: async (url) => ({ ok: true, json: async () => url.endsWith('/owner/repo') ? { private: true, owner: { type: 'User' } } : { sha: 'sha', size: 16 * 1024 * 1024 } }) }), /15 MiB/);
  const huge = createEmptyDatabase(); huge.assets = [asset('one', 'x'.repeat(8_000_000)), asset('two', 'y'.repeat(8_000_000))];
  const local = await configured(huge); const remote = api();
  await assert.rejects(runLibrarySync({ storage: local, fetchImpl: remote.fetchImpl }), /15 MiB/); assert.equal(remote.writes, 0);
});

test('privacy withdrawal survives deleting private asset or releasing it with new ID before the next sync', async () => {
  const { moveAigcAsset, removeAsset, createBackup } = await import('../store.js');
  for (const releaseToNormal of [false, true]) {
    const db = createEmptyDatabase(); db.assets = [asset('a', 'ordinary', 'aigc')];
    const storage = await configured(db); const server = api();
    await runLibrarySync({ storage, fetchImpl: server.fetchImpl });
    const baseline = structuredClone(server.records);
    await applyDatabaseChange((latest) => moveAigcAsset(latest, 'a', 'private', 20), storage);
    await applyDatabaseChange((latest) => releaseToNormal ? moveAigcAsset(latest, 'a', 'normal', 21) : removeAsset(latest, 'a'), storage);
    assert.deepEqual((await loadDatabase(storage)).syncWithdrawals, ['a']);
    assert.equal(createBackup(await loadDatabase(storage)).syncWithdrawals, undefined);
    await runLibrarySync({ storage, fetchImpl: server.fetchImpl });
    assert.equal(server.records['asset:a'].withdrawn, true);
    if (releaseToNormal) assert.equal(Object.values(server.records).filter((r) => r.value?.type === 'aigc').length, 1);
    const offline = createEmptyDatabase(); offline.assets = [asset('a', 'offline edit', 'aigc')]; offline.syncLedger = { repository: 'owner/repo', records: baseline };
    const other = await configured(offline);
    await runLibrarySync({ storage: other, fetchImpl: server.fetchImpl });
    assert.equal(server.records['asset:a'].withdrawn, true);
    assert.doesNotMatch(JSON.stringify(server.records), /offline edit/);
    assert.equal((await loadDatabase(other)).assets.some((a) => a.privacy === 'normal' && a.content === 'offline edit'), false);
    assert.equal((await loadDatabase(other)).assets.some((a) => a.privacy === 'private' && a.content === 'offline edit'), true);
  }
  const db = createEmptyDatabase(); db.assets = [asset('a', 'ordinary', 'aigc')];
  const saved = saveAsset(db, { ...db.assets[0], privacy: 'private' });
  assert.deepEqual(saved.database.syncWithdrawals, ['a']);
});
