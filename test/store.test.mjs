import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  assetsFor,
  applyAiAssetResult,
  applyAiCategoryGroups,
  captureSelection,
  createBackup,
  createCategory,
  createEmptyDatabase,
  decryptProviderKey,
  deleteCategory,
  displayTitle,
  encryptProviderKey,
  formatSkillInsert,
  getDraft,
  hasPrivacyLock,
  isReadOnlyDatabase,
  mergeBackup,
  moveAigcAsset,
  normalizeDatabase,
  paletteAssets,
  parseSkillMetadata,
  recordAssetUse,
  saveAsset,
  saveGithubSkillAsset,
  saveDraft,
  setAssetCategory,
  setAssetPinned,
  setPrivacyPassword,
  SKILL_INSERT_PREFIX,
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

test('formatSkillInsert prefixes skill payloads only and does not mutate saved assets', () => {
  assert.equal(formatSkillInsert(skill, 'skill'), `${SKILL_INSERT_PREFIX}\n${skill}`);
  assert.equal(formatSkillInsert(skill, 'generic'), skill);
  assert.equal(formatSkillInsert(skill, 'aigc'), skill);
  assert.equal(formatSkillInsert('', 'skill'), '');
  const saved = saveAsset(createEmptyDatabase(), { type: 'skill', content: skill }, { now: 1, id: 'skill-fmt' });
  assert.equal(saved.asset.content, skill);
  assert.equal(saved.asset.content.includes(SKILL_INSERT_PREFIX), false);
  const github = saveGithubSkillAsset(createEmptyDatabase(), { id: 'package-fmt', skillContent: skill, fileCount: 2, totalSize: 120, source: { repository: 'acme/demo', directory: 'skills/review', commit: 'abc', defaultBranch: 'main', url: 'https://github.com/acme/demo/blob/main/skills/review/SKILL.md' } }, { id: 'skill-gh-fmt' });
  assert.equal(github.asset.content, skill);
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

test('GitHub Skill collect stays uncategorized and does not use the directory name', () => {
  const packageInfo = { id: 'package-1', skillContent: skill, fileCount: 2, totalSize: 120, source: { repository: 'acme/demo', directory: 'skills/review', commit: 'abc', defaultBranch: 'main', url: 'https://github.com/acme/demo/blob/main/skills/review/SKILL.md' } };
  const saved = saveGithubSkillAsset(createEmptyDatabase(), packageInfo, { id: 'skill-1' });
  assert.equal(saved.asset.categoryId, null);
  assert.equal(saved.asset.categorySource, 'none');
  assert.equal(saved.queued, false);
  assert.equal(saved.database.categories.length, 0);
});

test('GitHub Skill first save queues AI categorization when background AI is enabled', () => {
  const packageInfo = { id: 'package-1', skillContent: skill, fileCount: 2, totalSize: 120, source: { repository: 'acme/demo', directory: 'skills/review', commit: 'abc', defaultBranch: 'main', url: 'https://github.com/acme/demo/blob/main/skills/review/SKILL.md' } };
  const database = updateAiSettings(createEmptyDatabase(), { enabled: true });
  const saved = saveGithubSkillAsset(database, packageInfo, { now: 10, id: 'skill-1' });
  assert.equal(saved.queued, true);
  assert.deepEqual(saved.database.ai.queue.map((item) => item.assetId), ['skill-1']);
  assert.equal(saved.asset.categoryId, null);
  assert.equal(saved.asset.content, skill);
});

test('AI can categorize a GitHub Skill without changing YAML', () => {
  const packageInfo = { id: 'package-1', skillContent: skill, fileCount: 2, totalSize: 120, source: { repository: 'acme/demo', directory: 'skills/review', commit: 'abc', defaultBranch: 'main', url: 'https://github.com/acme/demo/blob/main/skills/review/SKILL.md' } };
  let database = saveGithubSkillAsset(createEmptyDatabase(), packageInfo, { id: 'skill-1' }).database;
  database = createCategory(database, 'skill', '邮件', { id: 'mail' }).database;
  const result = applyAiAssetResult(database, 'skill-1', { title: 'AI 标题', categoryName: '邮件' });
  assert.equal(result.assets[0].categoryId, 'mail');
  assert.equal(result.assets[0].categorySource, 'ai');
  assert.equal(result.assets[0].title, 'Email reviewer');
  assert.equal(result.assets[0].content, skill);
});

test('GitHub Skill duplicate save does not queue again', () => {
  const packageInfo = { id: 'package-1', skillContent: skill, fileCount: 2, totalSize: 120, source: { repository: 'acme/demo', directory: 'skills/review', commit: 'abc', defaultBranch: 'main', url: 'https://github.com/acme/demo/blob/main/skills/review/SKILL.md' } };
  let database = updateAiSettings(createEmptyDatabase(), { enabled: true });
  database = saveGithubSkillAsset(database, packageInfo, { id: 'skill-1' }).database;
  const duplicate = saveGithubSkillAsset(database, { ...packageInfo, id: 'package-2' }, { id: 'skill-2' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.queued, false);
  assert.equal(duplicate.database.ai.queue.length, 1);
});

test('setAssetCategory writes a manual category without changing Skill content', () => {
  const packageInfo = { id: 'package-1', skillContent: skill, fileCount: 2, totalSize: 120, source: { repository: 'acme/demo', directory: 'skills/review', commit: 'abc', defaultBranch: 'main', url: 'https://github.com/acme/demo/blob/main/skills/review/SKILL.md' } };
  let database = createEmptyDatabase();
  database = createCategory(database, 'skill', '工作', { id: 'work' }).database;
  database = saveGithubSkillAsset(database, packageInfo, { now: 1, id: 'skill-1' }).database;
  const originalContent = database.assets[0].content;
  const originalPackage = database.assets[0].skillPackage;
  const updated = setAssetCategory(database, 'skill-1', 'work', { now: 2 });
  assert.equal(updated.assets[0].categoryId, 'work');
  assert.equal(updated.assets[0].categorySource, 'manual');
  assert.equal(updated.assets[0].updatedAt, 2);
  assert.equal(updated.assets[0].content, originalContent);
  assert.deepEqual(updated.assets[0].skillPackage, originalPackage);
  const cleared = setAssetCategory(updated, 'skill-1', null, { now: 3 });
  assert.equal(cleared.assets[0].categoryId, null);
  assert.equal(cleared.assets[0].categorySource, 'manual');
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

test('newer database versions are preserved as read-only', () => {
  const newer = { version: 3, assets: [{ id: 'a1', type: 'generic', privacy: 'normal', title: 't', content: 'c', updatedAt: 1, createdAt: 1 }], categories: [], settings: {}, ai: {}, usage: { log: [] }, lock: {} };
  const normalized = normalizeDatabase(newer);
  assert.equal(normalized.version, 3);
  assert.equal(normalized.assets[0].title, 't');
  assert.equal(isReadOnlyDatabase(normalized), true);
});

test('legacy databases gain usage fields on normalize', () => {
  const legacy = { version: 2, assets: [{ id: 'a1', type: 'generic', privacy: 'normal', title: 't', content: 'c', updatedAt: 1, createdAt: 1 }], categories: [], settings: {}, ai: {}, lock: {} };
  const normalized = normalizeDatabase(legacy);
  assert.equal(normalized.assets[0].useCount, 0);
  assert.equal(normalized.assets[0].lastUsedAt, null);
  assert.equal(normalized.assets[0].pinned, false);
});

test('recordAssetUse increments count without changing updatedAt', () => {
  let database = saveAsset(createEmptyDatabase(), { type: 'generic', title: 't', content: 'body' }, { now: 100, id: 'p1' }).database;
  const updated = recordAssetUse(database, 'p1', 200);
  assert.equal(updated.assets[0].useCount, 1);
  assert.equal(updated.assets[0].lastUsedAt, 200);
  assert.equal(updated.assets[0].updatedAt, 100);
  assert.ok(updated.usage.log.includes(200));
});

test('recordAssetUse trims usage log to 90 days', () => {
  let database = createEmptyDatabase();
  database.usage.log = [Date.now() - 91 * 86400000];
  database = saveAsset(database, { type: 'generic', content: 'x' }, { id: 'p1' }).database;
  const now = Date.now();
  const updated = recordAssetUse(database, 'p1', now);
  assert.equal(updated.usage.log.length, 1);
  assert.equal(updated.usage.log[0], now);
});

test('assetsFor respects pinned first and sort modes', () => {
  let database = createEmptyDatabase();
  database = saveAsset(database, { type: 'generic', title: 'A', content: 'a' }, { now: 1, id: 'a' }).database;
  database = saveAsset(database, { type: 'generic', title: 'B', content: 'b' }, { now: 2, id: 'b' }).database;
  database = saveAsset(database, { type: 'generic', title: 'C', content: 'c' }, { now: 3, id: 'c' }).database;
  database.assets.find((a) => a.id === 'b').pinned = true;
  database.assets.find((a) => a.id === 'a').useCount = 5;
  database.assets.find((a) => a.id === 'a').lastUsedAt = 10;
  database.assets.find((a) => a.id === 'c').useCount = 2;
  database.assets.find((a) => a.id === 'c').lastUsedAt = 20;
  assert.deepEqual(assetsFor(database, { type: 'generic', sortBy: 'mostUsed' }).map((a) => a.id), ['b', 'a', 'c']);
  assert.deepEqual(assetsFor(database, { type: 'generic', sortBy: 'lastUsed' }).map((a) => a.id), ['b', 'c', 'a']);
});

test('setAssetPinned rejects private library entries', () => {
  let database = saveAsset(createEmptyDatabase(), { type: 'aigc', privacy: 'private', content: 'secret' }, { id: 'priv' }).database;
  assert.throws(() => setAssetPinned(database, 'priv', true), /私密库不提供置顶/);
});

test('paletteAssets excludes private, prioritizes title match and pinned', () => {
  let database = createEmptyDatabase();
  database = saveAsset(database, { type: 'generic', title: 'alpha', content: 'zzz' }, { id: 'g1', now: 1 }).database;
  database = saveAsset(database, { type: 'generic', title: 'beta', content: 'alpha body' }, { id: 'g2', now: 2 }).database;
  database = saveAsset(database, { type: 'aigc', privacy: 'private', content: 'alpha secret' }, { id: 'p1', now: 3 }).database;
  database.assets.find((a) => a.id === 'g2').pinned = true;
  const results = paletteAssets(database, 'alpha', 8);
  assert.deepEqual(results.map((a) => a.id), ['g2', 'g1']);
});

test('paletteAssets limit applies', () => {
  let database = createEmptyDatabase();
  for (let i = 0; i < 10; i += 1) database = saveAsset(database, { type: 'generic', title: `t${i}`, content: 'x' }, { id: `g${i}`, now: i }).database;
  assert.equal(paletteAssets(database, '', 8).length, 8);
});

test('paletteAssets types option filters ordinary library entries', () => {
  let database = createEmptyDatabase();
  database = saveAsset(database, { type: 'generic', title: 'g', content: 'g' }, { id: 'g1', now: 1 }).database;
  database = saveAsset(database, { type: 'skill', content: skill }, { id: 's1', now: 2 }).database;
  database = saveAsset(database, { type: 'aigc', content: 'visual' }, { id: 'a1', now: 3 }).database;
  database = saveAsset(database, { type: 'aigc', privacy: 'private', content: 'secret' }, { id: 'p1', now: 4 }).database;
  assert.deepEqual(paletteAssets(database, '', 8).map((a) => a.id), ['a1', 's1', 'g1']);
  assert.deepEqual(paletteAssets(database, '', 8, { types: ['generic', 'skill'] }).map((a) => a.id), ['s1', 'g1']);
  assert.deepEqual(paletteAssets(database, '', 8, { types: ['generic', 'skill', 'aigc'] }).map((a) => a.id), ['a1', 's1', 'g1']);
});

test('captureSelection rejects empty text and queues when AI enabled', () => {
  assert.throws(() => captureSelection(createEmptyDatabase(), '   '), /为空/);
  let database = updateAiSettings(createEmptyDatabase(), { enabled: true });
  const saved = captureSelection(database, 'selected text', { now: 5, id: 'cap1' });
  assert.equal(saved.asset.type, 'generic');
  assert.equal(saved.asset.title, '');
  assert.equal(saved.asset.categoryId, null);
  assert.equal(saved.asset.titleSource, 'none');
  assert.equal(saved.queued, true);
});

test('mergeBackup preserves useCount and pinned fields', () => {
  let source = createEmptyDatabase();
  source = saveAsset(source, { type: 'generic', title: 'x', content: 'unique-body' }, { id: 's1', now: 1 }).database;
  source.assets[0].useCount = 4;
  source.assets[0].pinned = true;
  source.assets[0].lastUsedAt = 99;
  const backup = createBackup(source, 2);
  const merged = mergeBackup(createEmptyDatabase(), backup, { now: 3, idFactory: () => 'm1' });
  assert.equal(merged.imported, 1);
  assert.equal(merged.database.assets[0].useCount, 4);
  assert.equal(merged.database.assets[0].pinned, true);
  assert.equal(merged.database.assets[0].lastUsedAt, 99);
});
