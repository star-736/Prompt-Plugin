import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSiteOrigin, sitePattern, siteHost, originOfUrl, shouldTrigger, slashCompletesTrigger, inlineAnchorQuery, INLINE_DISMISS_MS, SHORTCUT_LABEL, SITE_PRESETS, isPromptableSite, isRestrictedTabUrl, relatedMatchPatterns, originCoveredBySites, inPlaceAllowsOrigin, livePaletteUpdate, paletteTypesForUrl, patternsForSites, presetFor } from '../in-place.js';
import { createEmptyDatabase, disableSite, enableSite, updateInPlaceSettings } from '../store.js';

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

test('inPlaceAllowsOrigin is the live palette gate for coverage and master switch', () => {
  const inPlace = { enabled: true, triggerEnabled: true, sites: ['https://chatgpt.com'] };
  assert.equal(inPlaceAllowsOrigin(inPlace, 'https://chatgpt.com'), true);
  assert.equal(inPlaceAllowsOrigin(inPlace, 'https://chat.openai.com'), true);
  assert.equal(inPlaceAllowsOrigin(inPlace, 'https://www.douyin.com'), false);
  assert.equal(inPlaceAllowsOrigin({ ...inPlace, enabled: false }, 'https://chatgpt.com'), false);
  assert.equal(inPlaceAllowsOrigin(inPlace, null), false);
});

test('livePaletteUpdate destroys when uncovered, keeps script when only // trigger flips', () => {
  const inPlace = { enabled: true, triggerEnabled: true, sites: ['https://chatgpt.com'] };
  assert.deepEqual(livePaletteUpdate(inPlace, 'https://chatgpt.com'), { action: 'settings', enabled: true, triggerEnabled: true });
  assert.deepEqual(livePaletteUpdate({ ...inPlace, triggerEnabled: false }, 'https://chatgpt.com'), { action: 'settings', enabled: true, triggerEnabled: false });
  assert.deepEqual(livePaletteUpdate({ ...inPlace, enabled: false }, 'https://chatgpt.com'), { action: 'destroy' });
  assert.deepEqual(livePaletteUpdate(inPlace, 'https://www.douyin.com'), { action: 'destroy' });
  assert.deepEqual(livePaletteUpdate(inPlace, null), { action: 'destroy' });
});

test('disabling a stored site or the master switch drops the live palette gate', () => {
  let database = enableSite(createEmptyDatabase(), 'https://chatgpt.com');
  assert.equal(inPlaceAllowsOrigin(database.settings.inPlace, 'https://chatgpt.com'), true);
  database = disableSite(database, 'https://chatgpt.com');
  assert.equal(inPlaceAllowsOrigin(database.settings.inPlace, 'https://chatgpt.com'), false);
  assert.equal(livePaletteUpdate(database.settings.inPlace, 'https://chatgpt.com').action, 'destroy');
  database = updateInPlaceSettings(enableSite(createEmptyDatabase(), 'https://claude.ai'), { enabled: false });
  assert.equal(inPlaceAllowsOrigin(database.settings.inPlace, 'https://claude.ai'), false);
  assert.equal(livePaletteUpdate(database.settings.inPlace, 'https://claude.ai').action, 'destroy');
  database = updateInPlaceSettings(enableSite(createEmptyDatabase(), 'https://claude.ai'), { triggerEnabled: false });
  assert.deepEqual(livePaletteUpdate(database.settings.inPlace, 'https://claude.ai'), { action: 'settings', enabled: true, triggerEnabled: false });
});

test('normalizeSiteOrigin and site helpers reject invalid hosts', () => {
  assert.throws(() => normalizeSiteOrigin('https://not a host'), /有效/);
  assert.throws(() => normalizeSiteOrigin('nota-host'), /域名/);
  assert.equal(siteHost('not-a-url'), 'not-a-url');
  assert.equal(originOfUrl('::::'), null);
  assert.equal(isPromptableSite('not-https'), false);
  assert.equal(presetFor('https://chatgpt.com')?.label, 'ChatGPT');
  assert.equal(presetFor('https://example.com'), null);
});

test('relatedMatchPatterns and patternsForSites cover Gemini, ChatGPT, and custom sites', () => {
  assert.deepEqual(relatedMatchPatterns('https://gemini.google.com'), ['https://gemini.google.com/*', 'https://*.gemini.google.com/*']);
  assert.ok(relatedMatchPatterns('https://chatgpt.com').includes('https://chat.openai.com/*'));
  assert.deepEqual(relatedMatchPatterns('https://docs.example.com'), ['https://docs.example.com/*']);
  assert.deepEqual(relatedMatchPatterns(''), []);
  const patterns = patternsForSites(['https://chat.deepseek.com', 'https://chat.deepseek.com']);
  assert.ok(patterns.includes('https://*.deepseek.com/*'));
  assert.equal(originCoveredBySites('', ['https://chatgpt.com']), false);
  assert.deepEqual(paletteTypesForUrl('not-a-url'), ['generic', 'skill']);
  assert.deepEqual(paletteTypesForUrl('http://grok.com/imagine'), ['generic', 'skill']);
});

test('isRestrictedTabUrl treats browser pages as restricted', () => {
  assert.equal(isRestrictedTabUrl(''), true);
  assert.equal(isRestrictedTabUrl(null), true);
  assert.equal(isRestrictedTabUrl('chrome://extensions'), true);
  assert.equal(isRestrictedTabUrl('edge://settings'), true);
  assert.equal(isRestrictedTabUrl('about:blank'), true);
  assert.equal(isRestrictedTabUrl('chrome-extension://abc/popup.html'), true);
  assert.equal(isRestrictedTabUrl('devtools://devtools'), true);
  assert.equal(isRestrictedTabUrl('https://chatgpt.com/'), false);
});
