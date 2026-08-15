import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  assetsFor,
  createBackup,
  createCategory,
  createEmptyDatabase,
  deleteCategory,
  getDraft,
  hasPrivacyLock,
  mergeBackup,
  moveAigcAsset,
  parseSkillMetadata,
  saveAsset,
  saveDraft,
  setPrivacyPassword,
  verifyPrivacyPassword
} from '../store.js';

const skill = `---\nname: Email reviewer\ndescription: Review email drafts\n---\n\n# Instructions\nReview the email.`;

test('privacy lock is recoverable and only validates the current local password', async () => {
  const database = await setPrivacyPassword(createEmptyDatabase(), '123456', webcrypto);
  assert.equal(hasPrivacyLock(database), true);
  assert.equal(await verifyPrivacyPassword(database, '123456', webcrypto), true);
  assert.equal(await verifyPrivacyPassword(database, 'wrong', webcrypto), false);
  const reset = await setPrivacyPassword(database, 'abcdef', webcrypto);
  assert.equal(await verifyPrivacyPassword(reset, 'abcdef', webcrypto), true);
  assert.equal(await verifyPrivacyPassword(reset, '123456', webcrypto), false);
});

test('resetting the privacy lock never removes private AIGC content', async () => {
  let database = createEmptyDatabase();
  database = saveAsset(database, { type: 'aigc', privacy: 'private', content: 'private visual idea' }, { now: 1, id: 'private-1' }).database;
  database = await setPrivacyPassword(database, '123456', webcrypto);
  const reset = await setPrivacyPassword(database, 'abcdef', webcrypto);
  assert.equal(reset.assets[0].content, 'private visual idea');
  assert.equal(await verifyPrivacyPassword(reset, 'abcdef', webcrypto), true);
});

test('asset validation enforces the three first-release asset shapes', () => {
  let database = createEmptyDatabase();
  assert.throws(() => saveAsset(database, { type: 'generic', title: '', content: 'body' }), /标题/);
  assert.throws(() => saveAsset(database, { type: 'skill', content: '# no frontmatter' }), /YAML/);
  const savedSkill = saveAsset(database, { type: 'skill', content: skill }, { now: 1, id: 'skill-1' });
  assert.equal(savedSkill.asset.title, 'Email reviewer');
  assert.equal(savedSkill.asset.skillDescription, 'Review email drafts');
  const savedAigc = saveAsset(savedSkill.database, { type: 'aigc', privacy: 'private', content: 'silver robot in a misty forest', categoryId: 'ignored' }, { now: 2, id: 'aigc-1' });
  assert.equal(savedAigc.asset.categoryId, null);
  assert.throws(() => saveAsset(savedAigc.database, { type: 'skill', privacy: 'private', content: skill }), /只有 AIGC/);
});

test('prompt and skill content is preserved verbatim after validation', () => {
  let database = createEmptyDatabase();
  const aigcContent = '  cinematic rain\n\n';
  database = saveAsset(database, { type: 'aigc', content: aigcContent }, { now: 1, id: 'aigc-raw' }).database;
  assert.equal(database.assets[0].content, aigcContent);
  const skillContent = `${skill}\n\n`;
  database = saveAsset(database, { type: 'skill', content: skillContent }, { now: 2, id: 'skill-raw' }).database;
  assert.equal(database.assets[1].content, skillContent);
});

test('categories are scoped, and deletion only moves its entries to uncategorized', () => {
  let database = createEmptyDatabase();
  const category = createCategory(database, 'generic', '写作', { now: 1, id: 'cat-1' });
  database = category.database;
  database = saveAsset(database, { type: 'generic', title: '周报', content: '总结本周工作', categoryId: 'cat-1' }, { now: 2, id: 'prompt-1' }).database;
  const removed = deleteCategory(database, 'cat-1');
  assert.equal(removed.assets[0].categoryId, null);
  assert.equal(removed.categories.length, 0);
});

test('drafts survive separately from saved assets and can be found again', () => {
  const database = saveDraft(createEmptyDatabase(), { type: 'aigc', privacy: 'private' }, { title: '', content: 'night rain', categoryId: null }, 1);
  assert.deepEqual(getDraft(database, { type: 'aigc', privacy: 'private' }), { title: '', content: 'night rain', categoryId: null, updatedAt: 1 });
  assert.equal(database.assets.length, 0);
});

test('moving an AIGC prompt clears its category and keeps the same item', () => {
  let database = createEmptyDatabase();
  database = saveAsset(database, { type: 'aigc', title: 'Scene', content: 'cinematic rain', categoryId: 'cat-1' }, { now: 1, id: 'aigc-1' }).database;
  const moved = moveAigcAsset(database, 'aigc-1', 'private', 2);
  assert.equal(moved.assets[0].privacy, 'private');
  assert.equal(moved.assets[0].categoryId, null);
  assert.equal(moved.assets[0].id, 'aigc-1');
});

test('backup import merges categories and skips fully identical items', () => {
  let source = createEmptyDatabase();
  source = createCategory(source, 'generic', '工作', { now: 1, id: 'source-category' }).database;
  source = saveAsset(source, { type: 'generic', title: '周报', content: '整理周报', categoryId: 'source-category' }, { now: 2, id: 'source-prompt' }).database;
  const backup = createBackup(source, 3);
  const first = mergeBackup(createEmptyDatabase(), backup, { now: 4, idFactory: (() => { let count = 0; return () => `new-${++count}`; })() });
  assert.equal(first.imported, 1);
  assert.equal(first.database.categories[0].name, '工作');
  const second = mergeBackup(first.database, backup, { now: 5, idFactory: () => 'unused' });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1);
  assert.equal(assetsFor(second.database, { type: 'generic' }).length, 1);
});

test('skill metadata reads the YAML name and description', () => {
  assert.deepEqual(parseSkillMetadata(skill), { name: 'Email reviewer', description: 'Review email drafts' });
});
