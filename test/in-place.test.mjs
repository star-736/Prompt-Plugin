import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSiteOrigin, sitePattern, siteHost, originOfUrl } from '../in-place.js';

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
