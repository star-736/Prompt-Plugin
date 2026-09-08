import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_PRESETS,
  buildAssetOrganizationPrompt,
  buildGroupingPrompt,
  buildStructurePrompt,
  chatCompletion,
  normalizeProvider,
  parseAssetResult,
  parseGroups,
  providerOrigin
} from '../ai-organizer.js';

test('normalizeProvider fills presets and rejects unsafe URLs', () => {
  const openai = normalizeProvider({ kind: 'openai', model: 'gpt-4.1-mini' });
  assert.equal(openai.baseUrl, PROVIDER_PRESETS.openai.baseUrl);
  assert.equal(providerOrigin(openai), 'https://api.openai.com');
  assert.throws(() => normalizeProvider({ kind: 'custom', baseUrl: 'http://evil.test', model: 'x' }), /HTTPS/);
  assert.throws(() => normalizeProvider({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: '  ' }), /Model ID/);
});

test('prompt builders mention JSON-only output', () => {
  const asset = { id: 'a1', type: 'generic', title: '', content: '写一封礼貌的邮件' };
  assert.match(buildAssetOrganizationPrompt(asset, [{ name: '工作' }]), /allowedCategories/);
  assert.match(buildGroupingPrompt('generic', [asset]), /groups/);
  assert.match(buildStructurePrompt('generic', [{ id: 'c1', name: '工作' }], [{ id: 'a1', categoryId: 'c1' }]), /proposal/);
});

test('parseAssetResult and parseGroups keep only eligible ids', () => {
  assert.deepEqual(parseAssetResult('```json\n{"title":"周报","categoryName":"工作"}\n```'), { title: '周报', categoryName: '工作' });
  assert.deepEqual(parseGroups({ groups: [{ name: '工作', assetIds: ['a', 'a', 'missing'] }, { name: '', assetIds: ['b'] }] }, ['a', 'b']), [
    { name: '工作', assetIds: ['a'] }
  ]);
});

test('chatCompletion uses JSON mode then falls back and parses fenced JSON', async () => {
  const provider = normalizeProvider({ kind: 'openai', model: 'gpt-4.1-mini' });
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n{"title":"AI","categoryName":null}\n```' } }] }) };
  };
  const result = await chatCompletion(provider, 'sk-test', 'hello', fetchImpl);
  assert.equal(calls[0].response_format.type, 'json_object');
  assert.equal('response_format' in calls[1], false);
  assert.equal(result.title, 'AI');
});

test('chatCompletion rejects empty or failed provider responses', async () => {
  const provider = normalizeProvider({ kind: 'openai', model: 'gpt-4.1-mini' });
  await assert.rejects(() => chatCompletion(provider, 'sk', 'p', async () => ({ ok: false, status: 500, json: async () => ({}) })), /500/);
  await assert.rejects(() => chatCompletion(provider, 'sk', 'p', async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })), /未返回/);
  assert.throws(() => parseAssetResult('not-json'), /JSON/);
});
