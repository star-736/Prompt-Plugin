import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSiteOrigin, sitePattern, siteHost, originOfUrl, shouldTrigger, slashCompletesTrigger, inlineAnchorQuery, INLINE_DISMISS_MS, SHORTCUT_LABEL, SITE_PRESETS, isPromptableSite, relatedMatchPatterns, originCoveredBySites, paletteTypesForUrl } from '../in-place.js';

test('normalizeSiteOrigin accepts bare host and full https URL', () => {
  assert.equal(normalizeSiteOrigin('chatgpt.com'), 'https://chatgpt.com');
  assert.equal(normalizeSiteOrigin('https://claude.ai/chat'), 'https://claude.ai');
});

test('normalizeSiteOrigin rejects http and empty values', () => {
  assert.throws(() => normalizeSiteOrigin(''), /请输入/);
  assert.throws(() => normalizeSiteOrigin('http://example.com'), /HTTPS/);
});

test('site helpers derive pattern, host, and origin', () => {
  const origin = 'https://chatgpt.com';
  assert.equal(sitePattern(origin), 'https://chatgpt.com/*');
  assert.equal(siteHost(origin), 'chatgpt.com');
  assert.equal(originOfUrl('https://chatgpt.com/c/1'), origin);
  assert.equal(originOfUrl('http://chatgpt.com'), null);
});

test('shouldTrigger fires on line-start // and ignores URL protocols', () => {
  assert.equal(shouldTrigger('//'), true);
  assert.equal(shouldTrigger('hello//'), true);
  assert.equal(shouldTrigger('https://example.com\n//'), true);
  assert.equal(shouldTrigger('/'), false);
  assert.equal(shouldTrigger('https://'), false);
  assert.equal(shouldTrigger('http://'), false);
  assert.equal(shouldTrigger('foo://'), false);
  assert.equal(shouldTrigger('///'), false);
  assert.equal(shouldTrigger('see https://'), false);
});

test('slashCompletesTrigger is true only for the second slash of //', () => {
  assert.equal(slashCompletesTrigger('/'), true);
  assert.equal(slashCompletesTrigger('hello/'), true);
  assert.equal(slashCompletesTrigger('https://example.com\n/'), true);
  assert.equal(slashCompletesTrigger(''), false);
  assert.equal(slashCompletesTrigger('hello'), false);
  assert.equal(slashCompletesTrigger('//'), false);
  assert.equal(slashCompletesTrigger('https:/'), false);
  assert.equal(slashCompletesTrigger('https://'), false);
});

test('inlineAnchorQuery keeps empty query, treats missing caret as unknown', () => {
  assert.equal(inlineAnchorQuery('//', 2, 0), '');
  assert.equal(inlineAnchorQuery('//foo', 5, 0), 'foo');
  assert.equal(inlineAnchorQuery('hello//bar', 10, 5), 'bar');
  assert.equal(inlineAnchorQuery('hello//', 7, 5), '');
  assert.equal(inlineAnchorQuery('//foo', 5, 0, true), null);
  assert.equal(inlineAnchorQuery('', 0, 5, true), null);
  assert.equal(inlineAnchorQuery('hello', 5, 3), false);
  assert.equal(inlineAnchorQuery('//foo', 1, 0), false);
  assert.equal(inlineAnchorQuery('//foo\nbar', 9, 0), false);
  assert.equal(INLINE_DISMISS_MS >= 50 && INLINE_DISMISS_MS <= 100, true);
});

test('default shortcut label avoids Edge/Chrome print and InPrivate chords', () => {
  assert.equal(SHORTCUT_LABEL, 'Alt+Shift+F');
  assert.notEqual(SHORTCUT_LABEL, 'Alt+Shift+P');
  assert.notEqual(SHORTCUT_LABEL, 'Ctrl+Shift+P');
});

test('SITE_PRESETS keeps six AI brands', () => {
  assert.deepEqual(SITE_PRESETS.map((site) => site.label), ['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'Kimi', 'Grok']);
});

test('isPromptableSite matches preset siblings and ignores other https sites', () => {
  assert.equal(isPromptableSite('https://chatgpt.com'), true);
  assert.equal(isPromptableSite('https://chat.openai.com'), true);
  assert.equal(isPromptableSite('https://claude.ai'), true);
  assert.equal(isPromptableSite('https://gemini.google.com'), true);
  assert.equal(isPromptableSite('https://chat.deepseek.com'), true);
  assert.equal(isPromptableSite('https://platform.deepseek.com'), true);
  assert.equal(isPromptableSite('https://www.kimi.com'), true);
  assert.equal(isPromptableSite('https://kimi.com'), true);
  assert.equal(isPromptableSite('https://grok.com'), true);
  assert.equal(isPromptableSite('https://www.google.com'), false);
  assert.equal(isPromptableSite('https://mail.google.com'), false);
  assert.equal(isPromptableSite('https://www.douyin.com'), false);
  assert.equal(isPromptableSite('https://www.tongyi.com'), false);
  assert.equal(isPromptableSite('https://www.doubao.com'), false);
  assert.equal(isPromptableSite('https://www.perplexity.ai'), false);
  assert.equal(isPromptableSite('https://copilot.microsoft.com'), false);
});

test('relatedMatchPatterns cover DeepSeek siblings without requesting all hosts', () => {
  const patterns = relatedMatchPatterns('https://platform.deepseek.com');
  assert.ok(patterns.includes('https://*.deepseek.com/*'));
  assert.ok(patterns.includes('https://deepseek.com/*'));
  assert.equal(originCoveredBySites('https://platform.deepseek.com', ['https://chat.deepseek.com']), true);
  assert.equal(originCoveredBySites('https://www.douyin.com', ['https://chat.deepseek.com']), false);
});

test('paletteTypesForUrl hides AIGC on chat pages and is AIGC-only on Grok imagine', () => {
  assert.deepEqual(paletteTypesForUrl('https://grok.com/'), ['generic', 'skill']);
  assert.deepEqual(paletteTypesForUrl('https://grok.com/imagine'), ['aigc']);
  assert.deepEqual(paletteTypesForUrl('https://grok.com/imagine/foo'), ['aigc']);
  assert.deepEqual(paletteTypesForUrl('https://www.grok.com/imagine'), ['aigc']);
  assert.deepEqual(paletteTypesForUrl('https://chatgpt.com/'), ['generic', 'skill']);
});
