import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  activeProvider,
  addStructureProposal,
  applyAiAssetResult,
  applyAiCategoryGroups,
  assetsFor,
  captureSelection,
  categoriesFor,
  categoryUsage,
  commitGithubSkillPackage,
  createBackup,
  createCategory,
  createEmptyDatabase,
  decryptProviderKey,
  deleteCategory,
  discardDraft,
  displayTitle,
  encryptProviderKey,
  formatPaletteInsert,
  formatSkillInsert,
  getDraft,
  hasPrivacyLock,
  ignoreSite,
  isReadOnlyDatabase,
  loadDatabase,
  mergeBackup,
  moveAigcAsset,
  normalizeDatabase,
  paletteAssets,
  parseBackup,
  parseSkillMetadata,
  READ_ONLY_MESSAGE,
  recordAssetUse,
  removeAsset,
  removeAssetAndPackage,
  removeProviderConfig,
  renameCategory,
  resolveStructureProposal,
  saveAsset,
  saveDatabase,
  saveDraft,
  saveGithubSkillAsset,
  saveProviderConfig,
  scopeFor,
  setAssetCategory,
  setAssetPinned,
  setPrivacyPassword,
  setSortBy,
  SKILL_INSERT_PREFIX,
  sortByFor,
  updateAiSettings,
  updateStructureProposal,
  usageSummary,
  validateAsset,
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

test('terminal command assets are content-first, categorizable, searchable, and stay local', () => {
  let database = createEmptyDatabase();
  assert.equal(scopeFor('command'), 'command');
  assert.throws(() => scopeFor('command', 'private'), /只有 AIGC/);

  const cat = createCategory(database, 'command', 'AI Agent 更新');
  database = cat.database;
  assert.deepEqual(categoriesFor(database, 'command').map((c) => c.name), ['AI Agent 更新']);

  const validated = validateAsset({ type: 'command', content: 'npm install -g @openai/codex@latest', categoryId: cat.category.id });
  assert.equal(validated.type, 'command');
  assert.equal(validated.categoryId, cat.category.id);
  assert.throws(() => validateAsset({ type: 'command', content: '   ' }), /内容不能为空/);

  const plain = saveAsset(database, { type: 'command', content: 'chrome://restart' }, { now: 1, id: 'cmd-plain' });
  // Content-first: the command itself is the searchable identifier.
  assert.equal(displayTitle(plain.asset), 'chrome://restart');
  database = plain.database;

  const withCat = saveAsset(database, { type: 'command', content: 'codex --dangerously-bypass-approvals-and-sandbox', categoryId: cat.category.id }, { now: 2, id: 'cmd-cat' });
  database = withCat.database;
  assert.equal(withCat.asset.categoryId, cat.category.id);
  assert.equal(withCat.asset.categorySource, 'manual');
  assert.equal(plain.asset.categorySource, 'none');

  database = setAssetCategory(database, 'cmd-plain', cat.category.id, { now: 4 });
  const recategorized = database.assets.find((asset) => asset.id === 'cmd-plain');
  assert.equal(recategorized.categoryId, cat.category.id);
  assert.equal(recategorized.categorySource, 'manual');
  database = setAssetCategory(database, 'cmd-plain', null, { now: 5 });
  assert.equal(database.assets.find((asset) => asset.id === 'cmd-plain').categoryId, null);
  assert.equal(database.assets.find((asset) => asset.id === 'cmd-plain').categorySource, 'manual');
  assert.throws(() => setAssetCategory(database, 'cmd-plain', 'no-such'), /找不到该分类/);

  // Terminal commands never enter the AI queue even when background AI is enabled.
  database = updateAiSettings(database, { enabled: true });
  database = saveAsset(database, { id: 'cmd-cat', type: 'command', content: 'codex --dangerously-bypass-approvals-and-sandbox v2', categoryId: cat.category.id }, { now: 3 }).database;
  assert.equal(database.ai.queue.length, 0);

  const listed = assetsFor(database, { type: 'command' });
  assert.deepEqual(listed.map((a) => a.id).sort(), ['cmd-cat', 'cmd-plain']);
  const searched = assetsFor(database, { type: 'command', query: 'dangerously' });
  assert.deepEqual(searched.map((a) => a.id), ['cmd-cat']);
  const byCategory = assetsFor(database, { type: 'command', categoryId: cat.category.id });
  assert.deepEqual(byCategory.map((a) => a.id), ['cmd-cat']);
  assert.equal(paletteAssets(database, '', 8, { types: ['generic', 'skill'] }).some((asset) => asset.type === 'command'), false);
});

test('backup round-trips terminal commands and their categories, and re-import is idempotent', () => {
  let db = createEmptyDatabase();
  const cat = createCategory(db, 'command', 'AI Agent 更新');
  db = cat.database;
  db = saveAsset(db, { type: 'command', content: 'npm i -g @openai/codex@latest', categoryId: cat.category.id }, { id: 'c1', now: 1 }).database;
  db = saveAsset(db, { type: 'command', content: 'chrome://restart' }, { id: 'c2', now: 2 }).database;

  const backup = createBackup(db);
  let ids = 0;
  const idFactory = () => `imp-${++ids}`;
  let restored = mergeBackup(createEmptyDatabase(), backup, { now: 5, idFactory });
  assert.equal(restored.imported, 2);
  const restoredCommands = assetsFor(restored.database, { type: 'command' });
  assert.deepEqual(restoredCommands.map((a) => a.content).sort(), ['chrome://restart', 'npm i -g @openai/codex@latest']);
  const restoredCats = categoriesFor(restored.database, 'command');
  assert.deepEqual(restoredCats.map((c) => c.name), ['AI Agent 更新']);
  assert.equal(restoredCommands.find((a) => a.content.includes('codex')).categoryId, restoredCats[0].id);

  const reimport = mergeBackup(restored.database, backup, { now: 6, idFactory });
  assert.equal(reimport.imported, 0);
  assert.equal(reimport.skipped, 2);
  assert.equal(assetsFor(reimport.database, { type: 'command' }).length, 2);
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

test('formatPaletteInsert uses content only and never prepends title', () => {
  const generic = { type: 'generic', title: '周报标题', content: '总结本周工作' };
  assert.equal(formatPaletteInsert(generic), '总结本周工作');
  assert.notEqual(formatPaletteInsert(generic), `${generic.title}${generic.content}`);
  assert.notEqual(formatPaletteInsert(generic), `${generic.title}\n${generic.content}`);
  const aigc = { type: 'aigc', title: '场景', content: '电影感雨夜' };
  assert.equal(formatPaletteInsert(aigc), '电影感雨夜');
  assert.notEqual(formatPaletteInsert(aigc), `${aigc.title}\n${aigc.content}`);
  const skillAsset = { type: 'skill', title: 'Email reviewer', content: skill };
  assert.equal(formatPaletteInsert(skillAsset), `${SKILL_INSERT_PREFIX}\n${skill}`);
  assert.notEqual(formatPaletteInsert(skillAsset), `${SKILL_INSERT_PREFIX}\n${skillAsset.title}\n${skill}`);
  assert.equal(formatPaletteInsert({ type: 'skill', title: 'Email reviewer', content: '' }), '');
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

function githubPackage(id, commit) {
  return { id, skillContent: skill, fileCount: 1, totalSize: 80, source: { repository: 'acme/demo', directory: 'skills/review', commit, defaultBranch: 'main', url: 'https://github.com/acme/demo/blob/main/skills/review/SKILL.md' } };
}

function githubSkillDatabase(packageId = 'old-pkg') {
  return saveGithubSkillAsset(createEmptyDatabase(), githubPackage(packageId, 'old-commit'), { id: 'skill-1', now: 1 }).database;
}

function trackPackages() {
  const calls = [];
  return {
    calls,
    putPackage: async (record) => { calls.push(`put:${record.id}`); },
    deletePackage: async (id) => { calls.push(`delete:${id}`); },
    persist: async (database) => { calls.push('save'); return !isReadOnlyDatabase(database); }
  };
}

test('saveDatabase refuses a newer read-only database', async () => {
  const stored = {};
  const storage = { async set(value) { Object.assign(stored, value); } };
  assert.equal(await saveDatabase({ ...createEmptyDatabase(), version: 3 }, storage), false);
  assert.equal(Object.keys(stored).length, 0);
});

test('read-only GitHub update does not put or delete packages', async () => {
  const database = { ...githubSkillDatabase(), version: 3 };
  const tracker = trackPackages();
  await assert.rejects(() => commitGithubSkillPackage(database, githubPackage('new-pkg', 'new-commit'), { updateAssetId: 'skill-1', ...tracker }), { message: READ_ONLY_MESSAGE });
  assert.deepEqual(tracker.calls, []);
  assert.equal(database.assets[0].skillPackage.packageId, 'old-pkg');
});

test('writable GitHub update deletes the old package only after a successful save', async () => {
  const tracker = trackPackages();
  const saved = await commitGithubSkillPackage(githubSkillDatabase(), githubPackage('new-pkg', 'new-commit'), { updateAssetId: 'skill-1', ...tracker });
  assert.deepEqual(tracker.calls, ['put:new-pkg', 'save', 'delete:old-pkg']);
  assert.equal(saved.asset.skillPackage.packageId, 'new-pkg');
  assert.equal(saved.duplicate, false);
});

test('GitHub update keeps the old package when saveDatabase returns false', async () => {
  const tracker = trackPackages();
  tracker.persist = async () => { tracker.calls.push('save'); return false; };
  await assert.rejects(() => commitGithubSkillPackage(githubSkillDatabase(), githubPackage('new-pkg', 'new-commit'), { updateAssetId: 'skill-1', ...tracker }), { message: READ_ONLY_MESSAGE });
  assert.deepEqual(tracker.calls, ['put:new-pkg', 'save']);
});

test('read-only delete does not remove the skill package', async () => {
  const database = { ...githubSkillDatabase(), version: 3 };
  const tracker = trackPackages();
  await assert.rejects(() => removeAssetAndPackage(database, 'skill-1', tracker), { message: READ_ONLY_MESSAGE });
  assert.deepEqual(tracker.calls, []);
});

test('writable delete removes the skill package only after a successful save', async () => {
  const tracker = trackPackages();
  const next = await removeAssetAndPackage(githubSkillDatabase(), 'skill-1', tracker);
  assert.deepEqual(tracker.calls, ['save', 'delete:old-pkg']);
  assert.equal(next.assets.length, 0);
});

test('delete keeps the skill package when saveDatabase returns false', async () => {
  const tracker = trackPackages();
  tracker.persist = async () => { tracker.calls.push('save'); return false; };
  await assert.rejects(() => removeAssetAndPackage(githubSkillDatabase(), 'skill-1', tracker), { message: READ_ONLY_MESSAGE });
  assert.deepEqual(tracker.calls, ['save']);
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

test('scopeFor, validateAsset, and displayTitle cover remaining branches', () => {
  assert.equal(scopeFor('generic'), 'generic');
  assert.equal(scopeFor('aigc', 'private'), 'aigc-private');
  assert.throws(() => scopeFor('unknown'), /资产类型/);
  assert.throws(() => scopeFor('generic', 'secret'), /资料库/);
  assert.throws(() => validateAsset({ type: 'generic', content: '   ' }), /不能为空/);
  assert.equal(displayTitle({ type: 'aigc', content: '   ' }), '未命名 AIGC Prompt');
  assert.equal(displayTitle({ type: 'generic', title: '', content: 'x'.repeat(40) }).endsWith('…'), true);
  assert.throws(() => parseSkillMetadata('# no yaml'), /frontmatter/);
  assert.throws(() => parseSkillMetadata('---\ndescription: only\n---\n'), /name/);
});

test('provider config, categories, sort, drafts, and usage helpers work', async () => {
  let database = await setPrivacyPassword(createEmptyDatabase(), '123456', webcrypto);
  const saved = await saveProviderConfig(database, { kind: 'openai', label: 'Work', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: 'sk-test' }, '123456', webcrypto);
  database = saved.database;
  assert.equal(activeProvider(database).id, saved.provider.id);
  const updated = await saveProviderConfig(database, { id: saved.provider.id, kind: 'openai', label: 'Work 2', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-4.1-mini' }, '123456', webcrypto);
  assert.equal(updated.provider.label, 'Work 2');
  database = removeProviderConfig(updated.database, saved.provider.id);
  assert.equal(activeProvider(database), null);
  await assert.rejects(() => saveProviderConfig(createEmptyDatabase(), { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' }, '123456', webcrypto), /不正确/);

  database = createCategory(createEmptyDatabase(), 'generic', '写作', { id: 'cat-1' }).database;
  assert.equal(categoriesFor(database, 'generic')[0].name, '写作');
  assert.throws(() => createCategory(database, 'generic', '写作'), /已存在/);
  assert.throws(() => createCategory(database, 'generic', ''), /请输入/);
  assert.throws(() => createCategory(database, 'generic', 'x'.repeat(41)), /40/);
  database = renameCategory(database, 'cat-1', '工作沟通');
  assert.equal(database.categories[0].name, '工作沟通');
  assert.throws(() => renameCategory(database, 'missing', 'x'), /找不到/);
  database = saveAsset(database, { type: 'generic', content: 'body', categoryId: 'cat-1' }, { id: 'g1' }).database;
  assert.equal(categoryUsage(database, 'cat-1'), 1);
  database = setSortBy(database, 'generic', 'mostUsed');
  assert.equal(sortByFor(database, 'generic'), 'mostUsed');
  assert.throws(() => setSortBy(database, 'generic', 'nope'), /排序/);
  const summary = usageSummary(recordAssetUse(database, 'g1', Date.now()));
  assert.equal(summary.total, 1);
  assert.ok('week' in summary);
  database = ignoreSite(database, 'https://chatgpt.com');
  assert.ok(database.settings.inPlace.ignoredSites.includes('https://chatgpt.com'));
  database = saveDraft(database, { type: 'generic' }, { title: 'd', content: 'c' });
  database = discardDraft(database, { type: 'generic' });
  assert.equal(getDraft(database, { type: 'generic' }), null);
  database = removeAsset(database, 'g1');
  assert.equal(database.assets.length, 0);
  assert.throws(() => removeAsset(database, 'g1'), /找不到/);
});

test('structure proposals can be edited, applied, and dismissed', () => {
  let database = createEmptyDatabase();
  database = createCategory(database, 'generic', '旧分类', { id: 'old' }).database;
  database = saveAsset(database, { type: 'generic', content: 'x', categoryId: 'old' }, { id: 'g1' }).database;
  database = addStructureProposal(database, { scope: 'generic', summary: '合并', groups: [{ from: ['旧分类'], to: '新分类' }] }, 1);
  const id = database.ai.proposals[0].id;
  database = updateStructureProposal(database, id, [{ from: ['旧分类'], to: '通讯' }]);
  assert.equal(database.ai.proposals[0].groups[0].to, '通讯');
  database = resolveStructureProposal(database, id, 'apply');
  assert.equal(database.ai.proposals[0].status, 'applied');
  assert.equal(database.categories[0].name, '通讯');
  database = addStructureProposal(database, { scope: 'generic', summary: '忽略', groups: [{ from: ['通讯'], to: '其它' }] });
  database = resolveStructureProposal(database, database.ai.proposals[0].id, 'dismiss');
  assert.equal(database.ai.proposals[0].status, 'dismissed');
  assert.throws(() => updateStructureProposal(database, 'missing', []), /找不到/);
});

test('AI apply, grouping, palette content match, and backup parse cover leftovers', async () => {
  let database = createEmptyDatabase();
  database = createCategory(database, 'generic', '工作', { id: 'work' }).database;
  database = saveAsset(database, { type: 'generic', title: '', content: '写周报' }, { id: 'g1' }).database;
  database = applyAiAssetResult(database, 'g1', { title: '周报标题', categoryName: '工作' });
  assert.equal(database.assets[0].title, '周报标题');
  assert.equal(database.assets[0].categoryId, 'work');
  assert.equal(applyAiAssetResult(database, 'missing', { title: 'x' }).assets[0].id, 'g1');
  database = applyAiCategoryGroups(database, 'generic', [{ name: '', assetIds: ['g1'] }, { name: '沟通', assetIds: ['missing'] }]);
  database = saveAsset(createEmptyDatabase(), { type: 'generic', title: 'alpha', content: 'zzz' }, { id: 'g1' }).database;
  database = createCategory(database, 'generic', '邮件', { id: 'mail' }).database;
  database.assets[0].categoryId = 'mail';
  assert.equal(paletteAssets(database, '邮件', 8)[0].id, 'g1');
  assert.throws(() => parseBackup({ format: 'nope' }), /有效备份/);
  const backup = parseBackup(JSON.stringify(createBackup(database, 9)));
  assert.equal(backup.version, 2);
  const stored = {};
  const storage = { async get() { return { 'futurecontext.v1': database }; }, async set(value) { Object.assign(stored, value); } };
  assert.equal(normalizeDatabase(null).assets.length, 0);
  assert.ok(await loadDatabase(storage));
  assert.equal(await saveDatabase(database, storage), true);
  assert.ok(stored['futurecontext.v1']);
  assert.throws(() => setAssetPinned(database, 'missing', true), /找不到/);
  assert.throws(() => setAssetCategory(database, 'g1', 'no-such'), /找不到该分类/);
  assert.throws(() => moveAigcAsset(database, 'g1', 'private'), /AIGC/);
  assert.throws(() => captureSelection(database, 'x'.repeat(100001)), /超过/);
});

test('GitHub collect duplicate deletes the newly put package', async () => {
  const tracker = trackPackages();
  const first = await commitGithubSkillPackage(createEmptyDatabase(), githubPackage('pkg-1', 'old-commit'), tracker);
  const duplicate = await commitGithubSkillPackage(first.database, githubPackage('pkg-2', 'old-commit'), tracker);
  assert.equal(duplicate.duplicate, true);
  assert.ok(tracker.calls.includes('delete:pkg-2'));
});

test('removeAssetAndPackage without a package only persists', async () => {
  const tracker = trackPackages();
  let database = saveAsset(createEmptyDatabase(), { type: 'generic', content: 'body' }, { id: 'g1' }).database;
  const next = await removeAssetAndPackage(database, 'g1', tracker);
  assert.deepEqual(tracker.calls, ['save']);
  assert.equal(next.assets.length, 0);
});
