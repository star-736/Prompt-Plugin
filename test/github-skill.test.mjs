import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGitHubSkillUpdate, collectGitHubSkill, filterSkillPackageBlobs, githubSkillUrlError, inspectGitHubSkillUrl, isCommitSha, isSkillMarkdownPath, mapGitHubHttpError, skillCollectionPrefix, skillContextFromPage, validateGitHubSkillContext } from '../github-skill.js';
import { FILE_LIMIT_BYTES, PACKAGE_LIMIT_BYTES, assertPackageLimits } from '../package-store.js';

function response(payload, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => payload }; }
const encodedSkill = Buffer.from('---\nname: Test skill\ndescription: Test package\n---\n\nHello').toString('base64');

test('GitHub errors distinguish quota, secondary limits, invalid tokens and forbidden access', async () => {
  const context = { repository: 'acme/demo', path: 'SKILL.md', commit: 'a'.repeat(40) };
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const cases = [
    [403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, /请求额度已用完。请在/, false],
    [403, { message: 'secondary rate limit' }, { 'retry-after': '120' }, /临时限流。请在/, false],
    [429, {}, {}, /不要连续点击/, false],
    [403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-reset': 'invalid' }, /稍后重试/, false],
    [401, { message: 'Bad credentials' }, {}, /匿名额度不足或无权访问/, false],
    [401, { message: 'Bad credentials' }, {}, /Token 无效或已过期/, true],
    [403, { message: 'Resource not accessible' }, {}, /填写 Token/, false],
    [403, { message: 'Resource not accessible' }, {}, /Token 权限/, true]
  ];
  for (const [status, body, headers, expected, hasToken] of cases) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ...response(body, status), headers: { get: (key) => headers[key] ?? null } };
    };
    fetchImpl.hasToken = hasToken;
    await assert.rejects(() => collectGitHubSkill(context, fetchImpl), (error) => {
      assert.match(error.message, expected);
      if (!hasToken) assert.doesNotMatch(error.message, /Token 无效/);
      return true;
    });
    assert.equal(calls, 1, 'rate limits must not cause automatic retries');
  }
});

test('401 copy depends on whether a token is stored', () => {
  assert.match(mapGitHubHttpError(401, { hasToken: false }), /匿名额度不足或无权访问/);
  assert.doesNotMatch(mapGitHubHttpError(401, { hasToken: false }), /Token 无效/);
  assert.match(mapGitHubHttpError(401, { hasToken: true }), /请在设置中更新或移除/);
  assert.match(mapGitHubHttpError(403, { hasToken: false, body: { message: 'Resource not accessible' } }), /填写 Token/);
  assert.doesNotMatch(mapGitHubHttpError(403, { hasToken: false, body: { message: 'Resource not accessible' } }), /Token 无效/);
  assert.match(mapGitHubHttpError(403, { hasToken: true, body: { message: 'Resource not accessible' } }), /Token 权限/);
});

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

function blob(path) { return { type: 'blob', path, sha: path, size: 1 }; }

const mixedSkillTree = [
  blob('SKILL.md'),
  blob('LICENSE'),
  blob('scripts/run.py'),
  blob('references/api.md'),
  blob('assets/x.png'),
  blob('src/app.js'),
  blob('tests/a.js'),
  blob('node_modules/x'),
  blob('skills/foo/SKILL.md'),
  blob('skills/foo/scripts/nested/run.py'),
  blob('skills/foo/README.md'),
  blob('skills/other/SKILL.md'),
  blob('templates/prompt.md'),
  { type: 'tree', path: 'scripts' },
  { type: 'tree', path: 'src' }
];

test('nested SKILL.md collects only that skill folder, including nested scripts', () => {
  const paths = filterSkillPackageBlobs(mixedSkillTree, 'skills/foo/SKILL.md').map((entry) => entry.path);
  assert.deepEqual(paths, [
    'skills/foo/SKILL.md',
    'skills/foo/scripts/nested/run.py',
    'skills/foo/README.md'
  ]);
});

test('root SKILL.md collects root files plus scripts/references/assets only', () => {
  assert.equal(skillCollectionPrefix('SKILL.md'), '');
  const paths = filterSkillPackageBlobs(mixedSkillTree, 'SKILL.md').map((entry) => entry.path);
  assert.deepEqual(paths, [
    'SKILL.md',
    'LICENSE',
    'scripts/run.py',
    'references/api.md',
    'assets/x.png'
  ]);
  assert.ok(!paths.includes('src/app.js'));
  assert.ok(!paths.includes('tests/a.js'));
  assert.ok(!paths.includes('node_modules/x'));
  assert.ok(!paths.includes('skills/other/SKILL.md'));
  assert.ok(!paths.includes('templates/prompt.md'));
});

test('empty skill collection prefix does not match the whole tree', () => {
  assert.equal(skillCollectionPrefix('SKILL.md'), '');
  const paths = filterSkillPackageBlobs(mixedSkillTree, 'SKILL.md').map((entry) => entry.path);
  assert.equal(paths.length, 5);
  assert.ok(paths.every((path) => !path.includes('/') || /^(scripts|references|assets)\//.test(path)));
});

test('root GitHub Skill collection fetches only the allowlisted companion files', async () => {
  const fetchMock = async (url) => {
    if (url.endsWith('/repos/acme/demo')) return response({ default_branch: 'main' });
    if (url.includes('/git/trees/def456')) return response({ truncated: false, tree: mixedSkillTree.map((entry) => (
      entry.type === 'blob' ? { ...entry, sha: entry.path.replace(/[^\w]+/g, '_'), size: 8 } : entry
    )) });
    const blobShas = {
      SKILL_md: encodedSkill,
      LICENSE: Buffer.from('MIT').toString('base64'),
      scripts_run_py: Buffer.from('print(1)').toString('base64'),
      references_api_md: Buffer.from('# api').toString('base64'),
      assets_x_png: Buffer.from('png').toString('base64')
    };
    for (const [sha, content] of Object.entries(blobShas)) {
      if (url.endsWith(`/git/blobs/${sha}`)) return response({ encoding: 'base64', content });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const result = await collectGitHubSkill({
    repository: 'acme/demo',
    commit: 'def456',
    path: 'SKILL.md',
    url: 'https://github.com/acme/demo/blob/main/SKILL.md'
  }, fetchMock);
  assert.deepEqual(result.files.map((file) => file.path), [
    'SKILL.md',
    'LICENSE',
    'scripts/run.py',
    'references/api.md',
    'assets/x.png'
  ]);
  assert.equal(result.source.directory, '');
});

test('inspectGitHubSkillUrl covers invalid, reserved, refs, and directory pages', () => {
  assert.equal(inspectGitHubSkillUrl('not a url').kind, 'invalid');
  assert.equal(inspectGitHubSkillUrl('https://gitlab.com/acme/demo/blob/main/SKILL.md').kind, 'not-github');
  assert.equal(inspectGitHubSkillUrl('https://github.com/acme').kind, 'github-other');
  assert.equal(inspectGitHubSkillUrl('https://github.com/acme/demo/issues/1').kind, 'github-other');
  assert.equal(inspectGitHubSkillUrl('https://github.com/acme/demo').kind, 'github-directory');
  const refs = inspectGitHubSkillUrl('https://github.com/acme/demo/blob/refs/heads/main/skills/demo/SKILL.md');
  assert.equal(refs.kind, 'skill-file');
  assert.equal(refs.ref, 'main');
  assert.equal(refs.path, 'skills/demo/SKILL.md');
  assert.equal(isSkillMarkdownPath('SKILL.md'), true);
  assert.equal(isCommitSha('a'.repeat(40)), true);
  assert.equal(isCommitSha('short'), false);
});

test('githubSkillUrlError covers remaining kinds', () => {
  assert.match(githubSkillUrlError('github-other'), /具体的 SKILL\.md/);
  assert.match(githubSkillUrlError('skill-file'), /仓库信息/);
  assert.match(githubSkillUrlError('not-github'), /公开 GitHub/);
});

test('validateGitHubSkillContext rejects missing repository, path, or ref', () => {
  assert.throws(() => validateGitHubSkillContext(null), /仓库信息/);
  assert.throws(() => validateGitHubSkillContext({ repository: 'acme/demo', path: 'README.md', ref: 'main' }), /SKILL\.md/);
  assert.throws(() => validateGitHubSkillContext({ repository: 'acme/demo', path: 'SKILL.md' }), /仓库信息/);
  assert.throws(() => skillContextFromPage({ kind: 'github-other' }), /具体的 SKILL\.md/);
});

test('collection maps network and GitHub HTTP errors', async () => {
  await assert.rejects(() => collectGitHubSkill({ repository: 'acme/demo', path: 'SKILL.md', commit: 'a'.repeat(40) }, async () => { throw new Error('offline'); }), /无法连接 GitHub API/);
  await assert.rejects(() => collectGitHubSkill({ repository: 'acme/demo', path: 'SKILL.md', commit: 'a'.repeat(40) }, async () => response({}, 404)), /404/);
  await assert.rejects(() => collectGitHubSkill({ repository: 'acme/demo', path: 'SKILL.md', commit: 'a'.repeat(40) }, async () => response({}, 500)), /500/);
});

test('truncated trees and missing SKILL.md are rejected', async () => {
  const fetchMock = async (url) => {
    if (url.endsWith('/repos/acme/demo')) return response({ default_branch: 'main' });
    if (url.includes('/git/trees/')) return response({ truncated: true, tree: [] });
    throw new Error(`Unexpected URL ${url}`);
  };
  await assert.rejects(() => collectGitHubSkill({ repository: 'acme/demo', path: 'SKILL.md', commit: 'a'.repeat(40) }, fetchMock), /过大/);
});

test('checkGitHubSkillUpdate reports unchanged and changed default-branch commits', async () => {
  const skillBlob = { type: 'blob', path: 'skills/demo/SKILL.md', sha: 'skill', size: 56 };
  const unchanged = async (url) => {
    if (url.endsWith('/repos/acme/demo')) return response({ default_branch: 'main' });
    if (url.includes('/commits/main')) return response({ sha: 'abc123ffffffffffffffffffffffffffffffff' });
    throw new Error(`Unexpected URL ${url}`);
  };
  const same = await checkGitHubSkillUpdate({ repository: 'acme/demo', directory: 'skills/demo', commit: 'abc123ffffffffffffffffffffffffffffffff' }, unchanged);
  assert.equal(same.changed, false);
  const changedFetch = async (url) => {
    if (url.endsWith('/repos/acme/demo')) return response({ default_branch: 'main' });
    if (url.includes('/commits/main')) return response({ sha: 'def456ffffffffffffffffffffffffffffffff' });
    if (url.includes('/git/trees/')) return response({ truncated: false, tree: [skillBlob] });
    if (url.endsWith('/git/blobs/skill')) return response({ encoding: 'base64', content: encodedSkill });
    throw new Error(`Unexpected URL ${url}`);
  };
  const changed = await checkGitHubSkillUpdate({ repository: 'acme/demo', directory: 'skills/demo', commit: 'old', url: 'https://github.com/acme/demo' }, changedFetch);
  assert.equal(changed.changed, true);
  assert.match(changed.packageRecord.skillContent, /Test skill/);
  await assert.rejects(() => checkGitHubSkillUpdate({}, async () => response({})), /来源信息/);
});
