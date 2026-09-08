import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGitHubSkill, githubSkillUrlError, inspectGitHubSkillUrl, skillContextFromPage, validateGitHubSkillContext } from '../github-skill.js';
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
  assert.throws(() => validateGitHubSkillContext({ repository: 'acme/demo', commit: 'abc', path: 'README.md' }), /SKILL\.md 文件再收集/);
});

// https://github.com/vinvcn/mattpocock-skills-zh-CN/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md
// → owner/repo=vinvcn/mattpocock-skills-zh-CN  path=skills/engineering/improve-codebase-architecture/SKILL.md  ref=main
test('nested GitHub blob SKILL.md URL parses owner/repo/path', () => {
  const url = 'https://github.com/vinvcn/mattpocock-skills-zh-CN/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md';
  const page = inspectGitHubSkillUrl(url);
  assert.equal(page.kind, 'skill-file');
  assert.equal(page.repository, 'vinvcn/mattpocock-skills-zh-CN');
  assert.equal(page.path, 'skills/engineering/improve-codebase-architecture/SKILL.md');
  assert.equal(page.ref, 'main');
});

test('plain=1 and case-insensitive SKILL.md still count as a file page', () => {
  const page = inspectGitHubSkillUrl('https://github.com/acme/demo/blob/main/skills/demo/skill.md?plain=1#L1');
  assert.equal(page.kind, 'skill-file');
  assert.equal(page.repository, 'acme/demo');
  assert.equal(page.path, 'skills/demo/skill.md');
  assert.equal(page.ref, 'main');
});

test('skills tree listing is not collectable', () => {
  const page = inspectGitHubSkillUrl('https://github.com/vinvcn/mattpocock-skills-zh-CN/tree/main/skills');
  assert.equal(page.kind, 'github-directory');
  assert.match(githubSkillUrlError(page.kind), /列表\/目录页/);
});

test('deep SKILL.md path is accepted when page commit meta is missing', () => {
  const ctx = validateGitHubSkillContext({
    repository: 'vinvcn/mattpocock-skills-zh-CN',
    ref: 'main',
    path: 'skills/engineering/improve-codebase-architecture/SKILL.md'
  });
  assert.equal(ctx.path, 'skills/engineering/improve-codebase-architecture/SKILL.md');
  assert.equal(ctx.ref, 'main');
});

test('collection resolves branch ref via API when octolytics meta is empty', async () => {
  const url = 'https://github.com/vinvcn/mattpocock-skills-zh-CN/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md';
  const fetchMock = async (requestUrl) => {
    if (requestUrl.endsWith('/repos/vinvcn/mattpocock-skills-zh-CN')) return response({ default_branch: 'main' });
    if (requestUrl.includes('/commits/main')) return response({ sha: 'abc123ffffffffffffffffffffffffffffffff' });
    if (requestUrl.includes('/git/trees/')) return response({ truncated: false, tree: [
      { type: 'blob', path: 'skills/engineering/improve-codebase-architecture/SKILL.md', sha: 'skill', size: 56 }
    ] });
    if (requestUrl.endsWith('/git/blobs/skill')) return response({ encoding: 'base64', content: encodedSkill });
    throw new Error(`Unexpected URL ${requestUrl}`);
  };
  const result = await collectGitHubSkill(skillContextFromPage(inspectGitHubSkillUrl(url), {}), fetchMock);
  assert.equal(result.source.repository, 'vinvcn/mattpocock-skills-zh-CN');
  assert.equal(result.source.directory, 'skills/engineering/improve-codebase-architecture');
  assert.equal(result.source.commit, 'abc123ffffffffffffffffffffffffffffffff');
  assert.equal(result.files[0].sourcePath, 'skills/engineering/improve-codebase-architecture/SKILL.md');
});

test('a package is rejected as a whole when one file or total size exceeds its limit', () => {
  assert.throws(() => assertPackageLimits([{ path: 'too-big.bin', size: FILE_LIMIT_BYTES + 1 }]), (error) => error.code === 'PACKAGE_TOO_LARGE');
  assert.throws(() => assertPackageLimits([{ path: 'a', size: PACKAGE_LIMIT_BYTES }, { path: 'b', size: 1 }]), (error) => error.code === 'PACKAGE_TOO_LARGE');
});
