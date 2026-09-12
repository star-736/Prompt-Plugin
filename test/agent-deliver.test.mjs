import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_TARGET_IDS,
  agentPathHint,
  createDeliveryMarker,
  decodePackageBytes,
  deliveryActionPlan,
  deliveryFiles,
  deliveryStateLabel,
  deliveryStatus,
  diskDeliveryWrite,
  folderMatchesAsset,
  inspectDeliveryDirectory,
  parseDeliveryMarker,
  resolveDeliveryStatus,
  safeSegments,
  sameDeliveryRecord,
  skillFolderCandidates,
  skillSlug,
  skillYamlName
} from '../agent-deliver.js';
import { canReadHandle, ensureReadWrite, indexSkillDirectories, listChildDirectories, recallDelivery, scanSkillPresence, writeDelivery } from '../agent-fs.js';
import { deleteBinding, getBinding, listBindings, putBinding } from '../agent-folders.js';
import { runDeliverAction } from '../deliver.js';
import { applyDiskDeliveries, clearSkillDeliveryTarget, createBackup, createEmptyDatabase, mergeBackup, saveAsset, setSkillDeliveryTarget } from '../store.js';
import { click, createChromeStub, createMemoryDirectory, createMemoryIndexedDB, deliverHtml, installDom, loadFreshEntry, seedDatabase, waitFor, writeMemoryFile } from './helpers.mjs';

const skill = `---\nname: Email reviewer\ndescription: Review email drafts\n---\n\n# Instructions\nReview the email.`;

test('skillSlug sanitizes names and reserved Windows folders', () => {
  assert.equal(skillSlug('Email reviewer'), 'Email-reviewer');
  assert.equal(skillSlug('con', 'abc-123'), 'skill-abc123');
  assert.equal(skillSlug('a/b:c'), 'a-b-c');
});

test('delivery files prefer package bytes and reject unsafe paths', () => {
  const asset = { content: skill };
  const files = deliveryFiles(asset, {
    files: [{ path: 'SKILL.md', content: Buffer.from('package skill').toString('base64') }, { path: 'refs/note.md', content: Buffer.from('note').toString('base64') }]
  });
  assert.equal(new TextDecoder().decode(files.find((file) => file.path === 'SKILL.md').bytes), 'package skill');
  assert.equal(files.some((file) => file.path === 'refs/note.md'), true);
  assert.equal(new TextDecoder().decode(deliveryFiles({ content: skill })[0].bytes), skill);
  assert.throws(() => safeSegments('../secret'), /不安全/);
  assert.equal(decodePackageBytes({ content: Buffer.from('hi').toString('base64') })[0], 104);
});

test('delivery markers only match the same FutureContext asset', () => {
  const marker = createDeliveryMarker({ id: 's1', updatedAt: 9 }, 'claude', 'Email-reviewer', 10);
  assert.equal(parseDeliveryMarker(JSON.stringify(marker)).assetId, 's1');
  assert.equal(inspectDeliveryDirectory({ exists: false }).kind, 'missing');
  assert.equal(inspectDeliveryDirectory({ exists: true, markerText: '', assetId: 's1' }).kind, 'foreign');
  assert.equal(inspectDeliveryDirectory({ exists: true, markerText: JSON.stringify(marker), assetId: 's1' }).kind, 'ours');
  assert.equal(inspectDeliveryDirectory({ exists: true, markerText: JSON.stringify(marker), assetId: 's2' }).kind, 'ours-other');
});

test('writeDelivery is recallable and refuses foreign folders', async () => {
  const root = createMemoryDirectory();
  const asset = { id: 's1', content: skill, updatedAt: 5 };
  const files = deliveryFiles(asset);
  const marker = createDeliveryMarker(asset, 'claude', 'Email-reviewer', 10);
  await writeDelivery(root, { slug: 'Email-reviewer', files, marker, assetId: 's1' });
  const recalled = await recallDelivery(root, { slug: 'Email-reviewer', assetId: 's1' });
  assert.equal(recalled.recalled, true);
  assert.equal((await recallDelivery(root, { slug: 'Email-reviewer', assetId: 's1' })).reason, 'missing');
  await root.getDirectoryHandle('manual-skill', { create: true });
  await assert.rejects(() => writeDelivery(root, { slug: 'manual-skill', files, marker, assetId: 's1' }), /不是 FutureContext 投递/);
  await assert.rejects(() => recallDelivery(root, { slug: 'manual-skill', assetId: 's1' }), /不是这条 Skill/);
  const other = createDeliveryMarker({ id: 's2', updatedAt: 1 }, 'claude', 'Email-reviewer', 10);
  const nested = deliveryFiles(asset, {
    files: [
      { path: 'SKILL.md', content: Buffer.from(skill).toString('base64') },
      { path: 'refs/note.md', content: Buffer.from('note').toString('base64') }
    ]
  });
  await writeDelivery(root, { slug: 'Email-reviewer', files: nested, marker: other, assetId: 's2' });
  await assert.rejects(() => writeDelivery(root, { slug: 'Email-reviewer', files, marker, assetId: 's1' }), /另一条/);
});

test('skillDelivery metadata is additive, stale-aware, and stripped on import', () => {
  let database = saveAsset(createEmptyDatabase(), { type: 'skill', content: skill }, { id: 's1', now: 5 }).database;
  database = setSkillDeliveryTarget(database, 's1', 'claude', { slug: 'Email-reviewer', deliveredAt: 6, contentUpdatedAt: 5 });
  assert.equal(deliveryStatus(database.assets[0], 'claude').state, 'delivered');
  database.assets[0] = { ...database.assets[0], updatedAt: 9 };
  assert.equal(deliveryStatus(database.assets[0], 'claude').state, 'stale');
  database = clearSkillDeliveryTarget(database, 's1', 'claude');
  assert.equal(database.assets[0].skillDelivery, undefined);
  let imported = saveAsset(createEmptyDatabase(), { type: 'skill', content: skill }, { id: 's1', now: 5 }).database;
  imported = setSkillDeliveryTarget(imported, 's1', 'cursor', { slug: 'Email-reviewer' });
  const merged = mergeBackup(createEmptyDatabase(), createBackup(imported));
  assert.equal(merged.database.assets[0].skillDelivery, undefined);
  assert.equal(agentPathHint('claude', 'Win32').includes('USERPROFILE'), true);
  assert.equal(agentPathHint('hermes', 'Win32').includes('LOCALAPPDATA'), true);
  assert.equal(agentPathHint('hermes', 'Linux'), '~/.hermes/skills');
  assert.equal(AGENT_TARGET_IDS.includes('claude'), true);
  assert.equal(AGENT_TARGET_IDS.includes('hermes'), true);
  assert.equal(AGENT_TARGET_IDS.includes('openclaw'), false);
});

test('agent folder bindings persist separately from the library', async () => {
  const indexedDb = createMemoryIndexedDB();
  const handle = { name: 'skills' };
  await putBinding({ id: 'claude', handle, displayName: 'skills', boundAt: 1 }, indexedDb);
  assert.equal((await getBinding('claude', indexedDb)).displayName, 'skills');
  assert.equal((await listBindings(indexedDb))[0].id, 'claude');
  await deleteBinding('claude', indexedDb);
  assert.equal(await getBinding('claude', indexedDb), null);
  assert.equal(await getBinding('not-a-target', indexedDb), null);
  await deleteBinding('not-a-target', indexedDb);
  await assert.rejects(() => putBinding({ id: 'nope', handle }, indexedDb), /不完整/);
});

test('ensureReadWrite prompts for permission and refuses denied folders', async () => {
  await assert.rejects(() => ensureReadWrite(null), /还没有选择/);
  const bare = {};
  assert.equal(await ensureReadWrite(bare), bare);
  const prompted = {
    async queryPermission() { return 'prompt'; },
    async requestPermission() { return 'granted'; }
  };
  assert.equal(await ensureReadWrite(prompted), prompted);
  await assert.rejects(() => ensureReadWrite({
    async queryPermission() { return 'prompt'; },
    async requestPermission() { return 'denied'; }
  }), /没有该目录的写入权限/);
  await assert.rejects(() => ensureReadWrite({
    async queryPermission() { return 'denied'; }
  }), /没有该目录的写入权限/);
  let promptedWithoutAsk = 0;
  await assert.rejects(() => ensureReadWrite({
    async queryPermission() { return 'prompt'; },
    async requestPermission() { promptedWithoutAsk += 1; return 'granted'; }
  }, { prompt: false }), /没有该目录的写入权限/);
  assert.equal(promptedWithoutAsk, 0);
});

test('runDeliverAction delivers and recalls without deleting the library copy', async () => {
  const indexedDb = createMemoryIndexedDB();
  const stub = createChromeStub({ indexedDB: indexedDb });
  seedDatabase(stub.local, saveAsset(createEmptyDatabase(), { type: 'skill', content: skill }, { id: 's1', now: 5 }).database);
  const root = createMemoryDirectory();
  await putBinding({ id: 'claude', handle: root, displayName: 'skills' }, indexedDb);
  const delivered = await runDeliverAction({ action: 'deliver', assetId: 's1', target: 'claude' });
  assert.match(delivered.message, /已投递/);
  assert.equal(stub.local['futurecontext.v1'].assets[0].content, skill);
  assert.equal(stub.local['futurecontext.v1'].assets[0].skillDelivery.targets.claude.slug, 'Email-reviewer');
  const recalled = await runDeliverAction({ action: 'recall', assetId: 's1', target: 'claude' });
  assert.match(recalled.message, /撤回|没有这份副本/);
  assert.equal(stub.local['futurecontext.v1'].assets[0].content, skill);
  assert.equal(stub.local['futurecontext.v1'].assets[0].skillDelivery, undefined);
  const recalledAgain = await runDeliverAction({ action: 'recall', assetId: 's1', target: 'claude' });
  assert.match(recalledAgain.message, /已没有这份副本/);
});

test('runDeliverAction binds, unbinds, and rejects invalid requests', async () => {
  const indexedDb = createMemoryIndexedDB();
  const stub = createChromeStub({ indexedDB: indexedDb });
  seedDatabase(stub.local, saveAsset(createEmptyDatabase(), { type: 'skill', content: skill }, { id: 's1', now: 5 }).database);
  const root = createMemoryDirectory();
  globalThis.showDirectoryPicker = async () => root;
  const bound = await runDeliverAction({ action: 'bind', target: 'cursor', pickFolder: true });
  assert.match(bound.message, /已记住/);
  assert.equal((await getBinding('cursor', indexedDb)).displayName, 'skills');
  const unbound = await runDeliverAction({ action: 'unbind', target: 'cursor' });
  assert.match(unbound.message, /已解除/);
  assert.equal(await getBinding('cursor', indexedDb), null);
  let picked = 0;
  globalThis.showDirectoryPicker = async () => { picked += 1; return root; };
  await assert.rejects(() => runDeliverAction({ action: 'bind', target: 'codex' }), /还没有选择/);
  await assert.rejects(() => runDeliverAction({ action: 'deliver', target: 'claude', assetId: 's1' }), /还没有选择/);
  assert.equal(picked, 0);
  delete globalThis.showDirectoryPicker;
  await assert.rejects(() => runDeliverAction({ action: 'sync', target: 'claude' }), /不支持的投递操作/);
  await assert.rejects(() => runDeliverAction({ action: 'deliver', target: 'unknown', assetId: 's1' }), /不支持的 Agent/);
  await assert.rejects(() => runDeliverAction({ action: 'deliver', target: 'claude', assetId: 'missing' }), /找不到要投递的 Skill/);
  await assert.rejects(() => runDeliverAction({ action: 'deliver', target: 'claude', assetId: 's1' }), /不支持选择本地目录|还没有选择/);
});

test('bootDeliver auto-runs, can pick a folder, and closes', async () => {
  const indexedDb = createMemoryIndexedDB();
  const stub = createChromeStub({ indexedDB: indexedDb });
  seedDatabase(stub.local, saveAsset(createEmptyDatabase(), { type: 'skill', content: skill }, { id: 's1', now: 5 }).database);
  const root = createMemoryDirectory();
  const { window, document } = installDom(deliverHtml(), {
    url: 'https://futurecontext.test/deliver.html?action=deliver&target=claude&assetId=s1'
  });
  let picked = 0;
  globalThis.showDirectoryPicker = async () => { picked += 1; return root; };
  globalThis.close = () => { window.closedFlag = true; };
  await loadFreshEntry('../deliver.js');
  await waitFor(() => /选择 skills 目录/.test(document.querySelector('#app')?.textContent || ''));
  assert.equal(picked, 0);
  click('[data-action="pick-folder"]');
  await waitFor(() => /已投递到/.test(document.querySelector('#app')?.textContent || ''));
  assert.equal(picked, 1);
  click('[data-action="close"]');
  assert.equal(window.closedFlag, true);
  delete globalThis.showDirectoryPicker;
  delete globalThis.close;
});

test('bootDeliver deliver with a granted folder auto-runs without picking', async () => {
  const indexedDb = createMemoryIndexedDB();
  const stub = createChromeStub({ indexedDB: indexedDb });
  seedDatabase(stub.local, saveAsset(createEmptyDatabase(), { type: 'skill', content: skill }, { id: 's1', now: 5 }).database);
  const root = createMemoryDirectory();
  await putBinding({ id: 'claude', handle: root, displayName: 'skills' }, indexedDb);
  installDom(deliverHtml(), { url: 'https://futurecontext.test/deliver.html?action=deliver&target=claude&assetId=s1' });
  let picked = 0;
  globalThis.showDirectoryPicker = async () => { picked += 1; return root; };
  await loadFreshEntry('../deliver.js');
  await waitFor(() => /已投递到/.test(globalThis.document?.querySelector('#app')?.textContent || ''));
  assert.equal(picked, 0);
  delete globalThis.showDirectoryPicker;
});

test('bootDeliver deliver does not re-prompt a bound folder that lost write access', async () => {
  const indexedDb = createMemoryIndexedDB();
  const stub = createChromeStub({ indexedDB: indexedDb });
  seedDatabase(stub.local, saveAsset(createEmptyDatabase(), { type: 'skill', content: skill }, { id: 's1', now: 5 }).database);
  const root = createMemoryDirectory();
  let permissionPrompts = 0;
  root.queryPermission = async () => 'prompt';
  root.requestPermission = async () => { permissionPrompts += 1; return 'granted'; };
  await putBinding({ id: 'claude', handle: root, displayName: 'skills' }, indexedDb);
  installDom(deliverHtml(), { url: 'https://futurecontext.test/deliver.html?action=deliver&target=claude&assetId=s1' });
  let picked = 0;
  globalThis.showDirectoryPicker = async () => { picked += 1; return createMemoryDirectory(); };
  await loadFreshEntry('../deliver.js');
  await waitFor(() => /重新选择目录/.test(globalThis.document?.querySelector('#app')?.textContent || ''));
  assert.equal(picked, 0);
  assert.equal(permissionPrompts, 0);
  click('[data-action="pick-folder"]');
  await waitFor(() => /已投递到/.test(globalThis.document?.querySelector('#app')?.textContent || ''));
  assert.equal(picked, 1);
  assert.equal(permissionPrompts, 0);
  delete globalThis.showDirectoryPicker;
});

test('bootDeliver reports missing parameters', async () => {
  installDom(deliverHtml(), { url: 'https://futurecontext.test/deliver.html?action=deliver' });
  await loadFreshEntry('../deliver.js');
  await waitFor(() => /缺少投递参数/.test(document.querySelector('#app')?.textContent || ''));
});

test('bootDeliver bind waits for an explicit folder pick', async () => {
  const indexedDb = createMemoryIndexedDB();
  createChromeStub({ indexedDB: indexedDb });
  const root = createMemoryDirectory();
  installDom(deliverHtml(), { url: 'https://futurecontext.test/deliver.html?action=bind&target=agents' });
  let picked = 0;
  globalThis.showDirectoryPicker = async () => { picked += 1; return root; };
  await loadFreshEntry('../deliver.js');
  await waitFor(() => /选择本身不会写入/.test(document.querySelector('#app')?.textContent || ''));
  assert.equal(document.querySelector('[data-action="run"]'), null);
  assert.equal(picked, 0);
  click('[data-action="pick-folder"]');
  await waitFor(() => /已记住/.test(document.querySelector('#app')?.textContent || ''));
  assert.equal(picked, 1);
  delete globalThis.showDirectoryPicker;
});

test('skill matching uses title slug, YAML name, and recorded slug', () => {
  assert.equal(skillYamlName(skill), 'Email reviewer');
  assert.equal(skillYamlName('---\nname: "quoted"\ndescription: x\n---\n'), 'quoted');
  assert.equal(skillYamlName('# no yaml'), '');
  const asset = { id: 's1', title: 'Email reviewer', content: skill };
  const candidates = skillFolderCandidates(asset, { slug: 'email-reviewer' });
  assert.equal(candidates.some((name) => name.toLocaleLowerCase() === 'email-reviewer'), true);
  assert.equal(folderMatchesAsset('Email-reviewer', '', candidates), true);
  assert.equal(folderMatchesAsset('custom-dir', 'Email reviewer', candidates), true);
  assert.equal(folderMatchesAsset('other', 'unrelated', candidates), false);
});

test('resolveDeliveryStatus distinguishes disk, metadata, and unbound folders', () => {
  const asset = { id: 's1', updatedAt: 5, skillDelivery: { targets: { claude: { slug: 'Email-reviewer', deliveredAt: 4, contentUpdatedAt: 5 } } } };
  assert.equal(resolveDeliveryStatus({ id: 's1' }, 'claude', { bound: false }).state, 'unbound');
  assert.equal(resolveDeliveryStatus({ ...asset, skillDelivery: undefined }, 'claude', { bound: false }).state, 'unbound');
  assert.equal(resolveDeliveryStatus(asset, 'claude', { bound: false }).state, 'delivered');
  assert.equal(resolveDeliveryStatus(asset, 'claude', { bound: false }).unconfirmed, true);
  assert.equal(resolveDeliveryStatus({ ...asset, updatedAt: 9 }, 'claude', { bound: false }).state, 'stale');
  assert.equal(resolveDeliveryStatus({ id: 's1' }, 'claude', { bound: true }).state, 'idle');
  assert.equal(resolveDeliveryStatus({ id: 's1' }, 'claude', { bound: true }).unconfirmed, true);
  assert.equal(resolveDeliveryStatus(asset, 'claude', { bound: true }).unconfirmed, true);
  assert.equal(resolveDeliveryStatus(asset, 'claude', { bound: true, disk: { kind: 'missing' } }).state, 'idle');
  assert.equal(resolveDeliveryStatus(asset, 'claude', { bound: true, disk: { kind: 'foreign', slug: 'Email-reviewer' } }).state, 'present');
  assert.equal(resolveDeliveryStatus(asset, 'claude', { bound: true, disk: { kind: 'ours-other', slug: 'Email-reviewer' } }).state, 'present');
  const ours = resolveDeliveryStatus({ id: 's1', updatedAt: 5 }, 'claude', {
    bound: true,
    disk: { kind: 'ours', slug: 'email-reviewer', marker: { contentUpdatedAt: 5, deliveredAt: 4, slug: 'email-reviewer' } }
  });
  assert.equal(ours.state, 'delivered');
  assert.equal(ours.record.slug, 'email-reviewer');
  assert.equal(resolveDeliveryStatus({ id: 's1', updatedAt: 9 }, 'claude', {
    bound: true,
    disk: { kind: 'ours', slug: 'Email-reviewer', marker: { contentUpdatedAt: 5, deliveredAt: 4 } }
  }).state, 'stale');
  assert.equal(deliveryStateLabel({ state: 'unbound' }), '未选择目录，无法确认磁盘是否已有');
  assert.match(deliveryStateLabel({ state: 'present' }), /目录里已有/);
  assert.equal(deliveryStateLabel({ state: 'idle' }), '未投递');
  assert.equal(deliveryStateLabel({ state: 'idle', unconfirmed: true }), '无法确认磁盘是否已有');
  assert.equal(deliveryStateLabel({ state: 'delivered' }), '已投递');
  assert.match(deliveryStateLabel({ state: 'delivered', unconfirmed: true }), /未选择目录/);
  assert.match(deliveryStateLabel({ state: 'delivered', unconfirmed: true }, { bound: true }), /需要重新选择目录/);
  assert.equal(deliveryStateLabel({ state: 'idle', unconfirmed: true }, { bound: true }), '需要重新选择目录');
  assert.deepEqual(deliveryActionPlan({ state: 'present' }), {});
  assert.equal(deliveryActionPlan({ state: 'unbound' }).bind, true);
  assert.equal(deliveryActionPlan({ state: 'idle' }).deliver, 'deliver');
  assert.equal(deliveryActionPlan({ state: 'stale' }).deliver, 'update');
  assert.equal(deliveryActionPlan({ state: 'delivered' }).recall, true);
  assert.equal(deliveryActionPlan({ state: 'idle', unconfirmed: true }).bind, true);
  assert.equal(diskDeliveryWrite({ state: 'delivered', record: { slug: 'x' } }).action, 'set');
  assert.equal(diskDeliveryWrite({ state: 'present' }).action, 'clear');
  assert.equal(diskDeliveryWrite({ state: 'unbound' }).action, 'none');
  assert.equal(sameDeliveryRecord({ slug: 'a', deliveredAt: 1, contentUpdatedAt: 2 }, { slug: 'a', deliveredAt: 1, contentUpdatedAt: 2 }), true);
  assert.equal(sameDeliveryRecord({ slug: 'a', deliveredAt: 1, contentUpdatedAt: 2 }, { slug: 'b', deliveredAt: 1, contentUpdatedAt: 2 }), false);
});

test('scanSkillPresence matches marked, foreign, case, and YAML-only folders', async () => {
  const root = createMemoryDirectory();
  const asset = { id: 's1', title: 'Email reviewer', content: skill, updatedAt: 5 };
  assert.equal((await scanSkillPresence(root, { asset, assetId: 's1' })).kind, 'missing');
  const foreign = await root.getDirectoryHandle('email-reviewer', { create: true });
  await writeMemoryFile(foreign, 'SKILL.md', skill);
  assert.equal((await scanSkillPresence(root, { asset, assetId: 's1' })).kind, 'foreign');
  assert.equal((await scanSkillPresence(root, { asset, assetId: 's1' })).slug, 'email-reviewer');
  const marked = createMemoryDirectory();
  const ours = await marked.getDirectoryHandle('Email-reviewer', { create: true });
  await writeMemoryFile(ours, 'SKILL.md', skill);
  await writeMemoryFile(ours, '.futurecontext-delivery.json', JSON.stringify(createDeliveryMarker(asset, 'cursor', 'Email-reviewer', 8)));
  const found = await scanSkillPresence(marked, { asset, assetId: 's1' });
  assert.equal(found.kind, 'ours');
  assert.equal(found.marker.assetId, 's1');
  const renamed = createMemoryDirectory();
  const custom = await renamed.getDirectoryHandle('custom-dir', { create: true });
  await writeMemoryFile(custom, 'SKILL.md', skill);
  assert.equal((await scanSkillPresence(renamed, { asset, assetId: 's1' })).kind, 'foreign');
  const hidden = createMemoryDirectory();
  await hidden.getDirectoryHandle('.system', { create: true });
  assert.equal((await scanSkillPresence(hidden, { asset, assetId: 's1' })).kind, 'missing');
});

test('directory listing works with entries, fallback maps, and read permission', async () => {
  const root = createMemoryDirectory();
  await root.getDirectoryHandle('kept', { create: true });
  assert.deepEqual((await listChildDirectories(root)).map((item) => item.name), ['kept']);
  assert.deepEqual((await listChildDirectories({ _entries: new Map([['legacy', { type: 'dir', handle: {} }]]) })).map((item) => item.name), ['legacy']);
  assert.deepEqual(await listChildDirectories({}), []);
  assert.equal(await canReadHandle(null), false);
  assert.equal(await canReadHandle({}), true);
  let readPrompts = 0;
  assert.equal(await canReadHandle({
    async queryPermission() { return 'prompt'; },
    async requestPermission() { readPrompts += 1; return 'granted'; }
  }), false);
  assert.equal(readPrompts, 0);
  const indexed = await indexSkillDirectories(root);
  assert.equal(indexed.byKey.has('kept'), true);
});

test('applyDiskDeliveries writes ours, clears missing or present, and ignores unbound', () => {
  let database = saveAsset(createEmptyDatabase(), { type: 'skill', content: skill }, { id: 's1', now: 5 }).database;
  const ours = resolveDeliveryStatus(database.assets[0], 'cursor', {
    bound: true,
    disk: { kind: 'ours', slug: 'Email-reviewer', marker: { contentUpdatedAt: 5, deliveredAt: 6, slug: 'Email-reviewer' } }
  });
  database = applyDiskDeliveries(database, [{ assetId: 's1', target: 'cursor', status: ours }]);
  assert.equal(database.assets[0].skillDelivery.targets.cursor.slug, 'Email-reviewer');
  assert.equal(applyDiskDeliveries(database, [{ assetId: 's1', target: 'cursor', status: ours }]), null);
  database = applyDiskDeliveries(database, [{ assetId: 's1', target: 'cursor', status: { state: 'present' } }]);
  assert.equal(database.assets[0].skillDelivery, undefined);
  database = setSkillDeliveryTarget(database, 's1', 'codex', { slug: 'Email-reviewer', deliveredAt: 1, contentUpdatedAt: 5 });
  database = applyDiskDeliveries(database, [{ assetId: 's1', target: 'codex', status: { state: 'idle' } }]);
  assert.equal(database.assets[0].skillDelivery, undefined);
  assert.equal(applyDiskDeliveries(database, [{ assetId: 's1', target: 'cursor', status: { state: 'unbound' } }]), null);
  assert.equal(applyDiskDeliveries(database, [{ assetId: 'missing', target: 'cursor', status: ours }]), null);
});
