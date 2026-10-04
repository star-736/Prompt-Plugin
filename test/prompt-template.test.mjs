import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePromptTemplate, fillPromptTemplate, promptTemplateEnabled } from '../src/core/prompt-template.js';
import { createEmptyDatabase, saveAsset, createBackup, mergeBackup, moveAigcAsset, CURRENT_DATABASE_VERSION } from '../src/core/store.js';
import { libraryRecords, validateSyncDocument, SYNC_FORMAT } from '../src/features/github/github-sync.js';

test('plain templates support Chinese names, spacing, repeat values and literal replacement text', () => {
  const template = parsePromptTemplate('给 {{ 角色 }}：{{内容}}\n再次称呼 {{角色}}');
  assert.deepEqual(template.names, ['角色', '内容']);
  const values = { 角色: '小林', 内容: '{{不要再解析}} $& <script>alert(1)</script>\n第二行' };
  assert.equal(fillPromptTemplate(template, values), '给 小林：{{不要再解析}} $& <script>alert(1)</script>\n第二行\n再次称呼 小林');
  assert.equal(fillPromptTemplate(template, { 角色: '小林' }, { preview: true }), '给 小林：{{内容}}\n再次称呼 小林');
  assert.throws(() => fillPromptTemplate(template, { 角色: ' ' }), /角色、内容/);
  assert.throws(() => fillPromptTemplate(template), /请填写/);
  assert.equal(fillPromptTemplate(parsePromptTemplate(), {}), '');
  assert.equal(fillPromptTemplate(parsePromptTemplate('原文'), {}), '原文');
  const prototypeNames = parsePromptTemplate('{{__proto__}} {{constructor}}');
  assert.throws(() => fillPromptTemplate(prototypeNames, {}), /请填写/);
  assert.equal(fillPromptTemplate(prototypeNames, JSON.parse('{"__proto__":"安全","constructor":"文本"}')), '安全 文本');
  for (const invalid of ['{{', '{{名称', '{{}}', '{{   }}', '{{多\n行}}', '{{{名称}}}', 'x {{ok}} {{bad']) assert.throws(() => parsePromptTemplate(invalid), /占位符/);
});

test('mode is opt-in, saved templates retain compatibility and unsupported types remain plain', () => {
  let database = createEmptyDatabase();
  assert.equal(promptTemplateEnabled(null), false);
  assert.equal(promptTemplateEnabled({ type: 'command', templateEnabled: true }), false);
  database = saveAsset(database, { type: 'generic', content: '{{未闭合' }, { id: 'plain' }).database;
  assert.equal(database.assets[0].templateEnabled, undefined);
  assert.throws(() => saveAsset(database, { type: 'generic', content: '{{未闭合', templateEnabled: true }), /占位符/);
  database = saveAsset(database, { type: 'generic', content: '{{主题}}', templateEnabled: true }, { id: 'template' }).database;
  assert.equal(database.version, CURRENT_DATABASE_VERSION);
  database = saveAsset(database, { id: 'template', type: 'generic', content: '{{新主题}}' }).database;
  assert.equal(database.assets[1].templateEnabled, true);
  database = saveAsset(database, { id: 'template', type: 'generic', content: '{{主题}}', templateEnabled: false }).database;
  assert.equal(database.assets[1].templateEnabled, undefined);
});

test('backup import distinguishes template mode and preserves it across private migration', () => {
  let database = saveAsset(createEmptyDatabase(), { type: 'aigc', content: '{{场景}}', templateEnabled: true }, { id: 'image' }).database;
  database = moveAigcAsset(database, 'image', 'private');
  const restored = mergeBackup(createEmptyDatabase(), createBackup(database)).database;
  assert.equal(restored.assets[0].templateEnabled, true);
  assert.equal(restored.assets[0].privacy, 'private');
  const normal = saveAsset(createEmptyDatabase(), { type: 'aigc', content: '{{场景}}' }).database;
  const template = saveAsset(createEmptyDatabase(), { type: 'aigc', content: '{{场景}}', templateEnabled: true }).database;
  const imported = mergeBackup(normal, createBackup(template));
  assert.equal(imported.imported, 1);
  assert.equal(mergeBackup(imported.database, createBackup(template)).skipped, 1);
});

test('sync whitelists template mode while excluding filled values and rejecting malformed templates', async () => {
  const database = saveAsset(createEmptyDatabase(), { type: 'generic', content: '{{主题}}', templateEnabled: true }, { id: 'template' }).database;
  database.assets[0].templateValues = { 主题: '本次私密输入' };
  database.assets.push({ ...database.assets[0], id: 'private', type: 'aigc', privacy: 'private' });
  const records = await libraryRecords(database);
  assert.equal(records['asset:template'].value.templateEnabled, true);
  assert.doesNotMatch(JSON.stringify(records), /私密输入|templateValues|asset:private/);
  const document = { format: SYNC_FORMAT, version: 1, records };
  validateSyncDocument(document);
  for (const patch of [{ templateEnabled: 'true' }, { content: '{{broken' }, { type: 'command' }]) {
    const invalid = structuredClone(document);
    Object.assign(invalid.records['asset:template'].value, patch);
    assert.throws(() => validateSyncDocument(invalid), /格式无效/);
  }
});

test('web template preparation is read-only and final insertion validates latest mode, content and permissions', async () => {
  const { createChromeStub, seedDatabase } = await import('./helpers.mjs');
  const { preparePaletteTemplate, paletteInsert, recordPaletteUse } = await import('../src/background/palette-controller.js');
  const stub = createChromeStub();
  let database = saveAsset(createEmptyDatabase(), { type: 'generic', content: '总结 {{主题}}', templateEnabled: true }, { id: 't' }).database;
  database.settings.inPlace.sites = ['https://chatgpt.com'];
  database = saveAsset(database, { type: 'aigc', privacy: 'private', content: '{{私密}}', templateEnabled: true }, { id: 'private' }).database;
  seedDatabase(stub.local, database);
  const sender = { tab: { id: 1, url: 'https://chatgpt.com/c/1' } };
  const prepared = await preparePaletteTemplate('t', sender);
  assert.deepEqual(prepared.template.names, ['主题']);
  assert.equal(stub.local['futurecontext.v1'].assets[0].useCount, 0);
  await assert.rejects(() => paletteInsert('t', sender), /模板已修改/);
  await assert.rejects(() => paletteInsert('t', sender, { templateContent: prepared.content }), /请先填写/);
  await assert.rejects(() => paletteInsert('t', sender, { templateContent: prepared.content, values: {} }), /请填写/);
  assert.equal((await paletteInsert('t', sender, { templateContent: prepared.content, values: { 主题: '本周工作' } })).content, '总结 本周工作');
  assert.equal(stub.local['futurecontext.v1'].assets[0].useCount, 1);
  assert.equal(stub.local['futurecontext.v1'].assets[0].content, '总结 {{主题}}');
  assert.doesNotMatch(JSON.stringify(stub.local), /本周工作/);
  await paletteInsert('t', sender, { templateContent: prepared.content, values: { 主题: '已确认' }, deferUsage: true });
  assert.equal(stub.local['futurecontext.v1'].assets[0].useCount, 1);
  await recordPaletteUse('t', sender);
  assert.equal(stub.local['futurecontext.v1'].assets[0].useCount, 2);
  await assert.rejects(() => recordPaletteUse('private', sender), /找不到/);
  await assert.rejects(() => preparePaletteTemplate('private', sender), /找不到/);
  await assert.rejects(() => preparePaletteTemplate('t', { tab: { id: 1, url: 'https://example.org' } }), /未启用/);
  stub.local['futurecontext.v1'].assets[0].content = '{{新主题}}';
  await assert.rejects(() => paletteInsert('t', sender, { templateContent: prepared.content, values: { 主题: '过期输入' } }), /模板已修改/);
  stub.local['futurecontext.v1'].assets[0].templateEnabled = false;
  await assert.rejects(() => preparePaletteTemplate('t', sender), /未启用占位符/);
  await assert.rejects(() => paletteInsert('t', sender, { templateContent: prepared.content }), /模式已修改/);
  stub.local['futurecontext.v1'].version = 999;
  await recordPaletteUse('t', sender);
  assert.equal((await paletteInsert('t', sender)).content, '{{新主题}}');
});
