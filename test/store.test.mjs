import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  assetsFor,
  applyAiAssetResult,
  applyAiCategoryGroups,
  createBackup,
  createCategory,
  createEmptyDatabase,
  decryptProviderKey,
  deleteCategory,
  displayTitle,
  encryptProviderKey,
  getDraft,
  hasPrivacyLock,
  mergeBackup,
  moveAigcAsset,
  parseSkillMetadata,
  saveAsset,
  saveGithubSkillAsset,
  saveDraft,
  setPrivacyPassword,
  updateAiSettings,
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

test('asset validation accepts a title-less generic Prompt and preserves Skill validation', () => {
  let database = createEmptyDatabase();
  const untitled = saveAsset(database, { type: 'generic', title: '', content: 'body' }, { now: 1, id: 'generic-untitled' });
  assert.equal(displayTitle(untitled.asset), 'body');
  database = untitled.database;
  assert.throws(() => saveAsset(database, { type: 'skill', content: '# no frontmatter' }), /YAML/);
  const savedSkill = saveAsset(database, { type: 'skill', content: skill }, { now: 1, id: 'skill-1' });
  assert.equal(savedSkill.asset.title, 'Email reviewer');
  assert.equal(savedSkill.asset.skillDescription, 'Review email drafts');
  const savedAigc = saveAsset(savedSkill.database, { type: 'aigc', privacy: 'private', content: 'silver robot in a misty forest', categoryId: 'ignored' }, { now: 2, id: 'aigc-1' });
  assert.equal(savedAigc.asset.categoryId, null);
  assert.throws(() => saveAsset(savedAigc.database, { type: 'skill', privacy: 'private', content: skill }), /只有 AIGC/);
});

test('provider keys are encrypted and become inaccessible after privacy password reset', async () => {
  const secret = await encryptProviderKey('123456', 'sk-secret-value', webcrypto);
  assert.equal(JSON.stringify(secret).includes('sk-secret-value'), false);
  assert.equal(await decryptProviderKey('123456', secret, webcrypto), 'sk-secret-value');
  await assert.rejects(() => decryptProviderKey('wrong-password', secret, webcrypto), /无法解锁/);
  const database = await setPrivacyPassword(createEmptyDatabase(), '123456', webcrypto);
  const reset = await setPrivacyPassword({ ...database, ai: { ...database.ai, providers: [{ id: 'p1', secret }] } }, 'abcdef', webcrypto);
  assert.equal(reset.ai.providers.length, 0);
});

test('AI only queues saved generic and Skill content after background AI is enabled', () => {
  let database = updateAiSettings(createEmptyDatabase(), { enabled: true });
  database = saveAsset(database, { type: 'generic', content: 'write a polite email' }, { now: 1, id: 'prompt-1' }).database;
  database = saveAsset(database, { type: 'aigc', content: 'a moonlit portrait' }, { now: 2, id: 'aigc-1' }).database;
  assert.deepEqual(database.ai.queue.map((item) => item.assetId), ['prompt-1']);
  database = saveAsset(database, { id: 'prompt-1', type: 'generic', content: 'write a polite email' }, { now: 3 }).database;
  assert.equal(database.ai.queue.length, 1);
});

test('AI never overwrites human title or category choices', () => {
  let database = createEmptyDatabase();
  database = createCategory(database, 'generic', '工作', { id: 'work' }).database;
  database = saveAsset(database, { type: 'generic', title: '周报', content: '总结本周', categoryId: 'work' }, { id: 'prompt-1' }).database;
  const result = applyAiAssetResult(database, 'prompt-1', { title: 'AI 标题', categoryName: '其他' });
  assert.equal(result.assets[0].title, '周报');
  assert.equal(result.assets[0].categoryId, 'work');
});

test('AI grouping only moves eligible uncategorized entries', () => {
  let database = createEmptyDatabase();
  database = saveAsset(database, { type: 'generic', content: '写邮件' }, { id: 'auto' }).database;
  database = saveAsset(database, { type: 'generic', content: '我的手动分类', categoryId: null }, { id: 'manual' }).database;
  database.assets.find((asset) => asset.id === 'manual').categorySource = 'manual';
  database = applyAiCategoryGroups(database, 'generic', [{ name: '工作沟通', assetIds: ['auto', 'manual'] }]);
  assert.ok(database.assets.find((asset) => asset.id === 'auto').categoryId);
  assert.equal(database.assets.find((asset) => asset.id === 'manual').categoryId, null);
});

test('GitHub Skill direct update preserves its local category', () => {
  const githubSkill = (commit, id, content = skill) => ({ id, skillContent: content, fileCount: 2, totalSize: 120, source: { repository: 'acme/demo', directory: 'skills/review', commit, defaultBranch: 'main', url: 'https://github.com/acme/demo/blob/main/skills/review/SKILL.md' } });
  let database = createEmptyDatabase();
  database = createCategory(database, 'skill', '工作', { id: 'work' }).database;
  const first = saveGithubSkillAsset(database, githubSkill('abc', 'package-1'), { id: 'skill-1' });
  database = first.database;
  database.assets[0].categoryId = 'work';
  database.assets[0].categorySource = 'manual';
  const second = saveGithubSkillAsset(database, githubSkill('def', 'package-2', skill.replace('Review email drafts', 'Review important email drafts')), { updateAssetId: 'skill-1' });
  assert.equal(second.asset.skillPackage.source.commit, 'def');
  assert.equal(second.asset.skillPackage.packageId, 'package-2');
  assert.equal(second.asset.categoryId, 'work');
  assert.equal(second.asset.categorySource, 'manual');
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
