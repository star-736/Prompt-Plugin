import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGitHubSkill, validateGitHubSkillContext } from '../github-skill.js';
import { FILE_LIMIT_BYTES, PACKAGE_LIMIT_BYTES, assertPackageLimits } from '../package-store.js';

function response(payload, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => payload }; }
const encodedSkill = Buffer.from('---\nname: Test skill\ndescription: Test package\n---\n\nHello').toString('base64');

test('GitHub collection saves the complete directory at the exact page commit', async () => {
  const fetchMock = async (url) => {
    if (url.endsWith('/repos/acme/demo')) return response({ default_branch: 'main' });
    if (url.includes('/git/trees/abc123')) return response({ truncated: false, tree: [
      { type: 'blob', path: 'skills/demo/SKILL.md', sha: 'skill', size: 56 },
      { type: 'blob', path: 'skills/demo/scripts/check.py', sha: 'script', size: 12 },
      { type: 'blob', path: 'other/SKILL.md', sha: 'other', size: 1 }
    ] });
    if (url.endsWith('/git/blobs/skill')) return response({ encoding: 'base64', content: encodedSkill });
    if (url.endsWith('/git/blobs/script')) return response({ encoding: 'base64', content: Buffer.from('print("ok")').toString('base64') });
    throw new Error(`Unexpected URL ${url}`);
  };
  const result = await collectGitHubSkill({ repository: 'acme/demo', commit: 'abc123', path: 'skills/demo/SKILL.md', url: 'https://github.com/acme/demo/blob/main/skills/demo/SKILL.md' }, fetchMock);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[1].path, 'scripts/check.py');
  assert.equal(result.source.commit, 'abc123');
  assert.match(result.skillContent, /name: Test skill/);
});

test('GitHub collection only accepts a concrete SKILL.md path', () => {
  assert.throws(() => validateGitHubSkillContext({ repository: 'acme/demo', commit: 'abc', path: 'README.md' }), /具体 SKILL.md/);
});

test('a package is rejected as a whole when one file or total size exceeds its limit', () => {
  assert.throws(() => assertPackageLimits([{ path: 'too-big.bin', size: FILE_LIMIT_BYTES + 1 }]), (error) => error.code === 'PACKAGE_TOO_LARGE');
  assert.throws(() => assertPackageLimits([{ path: 'a', size: PACKAGE_LIMIT_BYTES }, { path: 'b', size: 1 }]), (error) => error.code === 'PACKAGE_TOO_LARGE');
});
