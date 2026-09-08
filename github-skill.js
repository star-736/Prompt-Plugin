import { assertPackageLimits, isTextFile } from './package-store.js';

const API_ROOT = 'https://api.github.com';
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const SKILL_MARKDOWN = /(^|\/)SKILL\.md$/i;
const GITHUB_FILE_ROUTES = new Set(['blob', 'tree']);
const GITHUB_RESERVED = new Set([
  'issues', 'pulls', 'pull', 'actions', 'projects', 'wiki', 'settings', 'security',
  'pulse', 'graphs', 'network', 'forks', 'releases', 'tags', 'branches', 'commit',
  'commits', 'compare', 'search', 'discussions', 'packages', 'codespaces', 'insights',
  'community', 'rules', 'deployments', 'raw', 'blame'
]);

function decodeBase64(value) {
  if (typeof Buffer !== 'undefined') return Buffer.from(value.replace(/\n/g, ''), 'base64').toString('utf8');
  return decodeURIComponent(Array.from(atob(value.replace(/\n/g, '')), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
}

async function json(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } });
  } catch {
    throw new Error('无法读取该仓库（可能是私有仓库或网络错误）。');
  }
  if (!response.ok) {
    if ([401, 403, 404].includes(response.status)) throw new Error('无法读取该仓库（可能是私有仓库或网络错误）。');
    throw new Error(`GitHub 请求失败（${response.status}）。`);
  }
  return response.json();
}

export function isSkillMarkdownPath(path) {
  return SKILL_MARKDOWN.test(String(path ?? '').replace(/^\/+/, '').split(/[?#]/)[0]);
}

export function isCommitSha(value) {
  return COMMIT_SHA.test(String(value ?? ''));
}

export function githubSkillUrlError(kind) {
  if (kind === 'github-directory') return '请点进某个技能目录里的 SKILL.md 文件再收集（现在是列表/目录页）。';
  if (kind === 'github-other') return '请打开具体的 SKILL.md 文件再收集。';
  if (kind === 'skill-file') return '无法读取该文件页的仓库信息，请刷新后重试。';
  return '请先打开公开 GitHub 仓库中的具体 SKILL.md 文件页面。';
}

function parseBlobRest(rest) {
  if (!Array.isArray(rest) || rest.length < 2) return null;
  if (rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags') && rest.length >= 4) {
    return { ref: rest[2], path: rest.slice(3).join('/') };
  }
  return { ref: rest[0], path: rest.slice(1).join('/') };
}

export function inspectGitHubSkillUrl(urlString) {
  let url;
  try { url = new URL(String(urlString ?? '')); } catch { return { kind: 'invalid', url: String(urlString ?? '') }; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') return { kind: 'not-github', url: url.href };
  const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return { kind: 'github-other', url: url.href };

  const route = parts[2] ?? '';
  const canParseFile = isSkillMarkdownPath(pathname) && (GITHUB_FILE_ROUTES.has(route) || (parts.length >= 4 && !GITHUB_RESERVED.has(route)));
  if (canParseFile) {
    const parsed = parseBlobRest(GITHUB_FILE_ROUTES.has(route) ? parts.slice(3) : parts.slice(2));
    if (parsed?.ref && isSkillMarkdownPath(parsed.path)) {
      return { kind: 'skill-file', repository: `${parts[0]}/${parts[1]}`, ref: parsed.ref, path: parsed.path.replace(/^\/+/, ''), url: url.href };
    }
  }
  if (parts.length === 2 || route === 'tree') return { kind: 'github-directory', url: url.href };
  return { kind: 'github-other', url: url.href };
}

export function skillContextFromPage(inspection, injected = {}) {
  if (inspection?.kind !== 'skill-file') throw new Error(githubSkillUrlError(inspection?.kind));
  return {
    repository: inspection.repository,
    path: inspection.path,
    ref: inspection.ref,
    commit: isCommitSha(injected.commit) ? injected.commit : '',
    url: inspection.url
  };
}

export function validateGitHubSkillContext(context) {
  if (!context || !/^[\w.-]+\/[\w.-]+$/.test(context.repository ?? '')) {
    throw new Error('无法读取该文件页的仓库信息，请刷新后重试。');
  }
  const path = String(context.path ?? '').replace(/^\/+/, '');
  if (!isSkillMarkdownPath(path)) throw new Error('请打开具体的 SKILL.md 文件再收集。');
  if (!context.commit && !context.ref) throw new Error('无法读取该文件页的仓库信息，请刷新后重试。');
  return { repository: context.repository, commit: context.commit || '', ref: context.ref || '', path, url: context.url ?? '' };
}

async function fetchAtCommit({ repository, commit, path, url }, fetchImpl, defaultBranch = null) {
  const [owner, repo] = repository.split('/');
  const tree = await json(fetchImpl, `${API_ROOT}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(commit)}?recursive=1`);
  if (tree.truncated) throw new Error('该 GitHub 仓库目录过大，无法安全收集此 Skill。');
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const prefix = directory ? `${directory}/` : '';
  const candidates = tree.tree.filter((entry) => entry.type === 'blob' && (entry.path === path || entry.path.startsWith(prefix)));
  if (!candidates.some((entry) => entry.path === path)) throw new Error('当前 Commit 中找不到 SKILL.md。');
  assertPackageLimits(candidates.map((entry) => ({ path: entry.path, size: entry.size })));
  const files = [];
  for (const entry of candidates) {
    const blob = await json(fetchImpl, `${API_ROOT}/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
    files.push({ path: entry.path.slice(prefix.length), sourcePath: entry.path, size: entry.size, sha: entry.sha, encoding: blob.encoding, content: blob.content, contentType: isTextFile(entry.path) ? 'text/plain' : 'application/octet-stream' });
  }
  const skill = files.find((file) => file.sourcePath === path);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `package-${Date.now()}`,
    skillContent: decodeBase64(skill.content), fileCount: files.length,
    totalSize: files.reduce((sum, file) => sum + file.size, 0), files,
    source: { repository, directory, commit, defaultBranch, url }
  };
}

export async function collectGitHubSkill(context, fetchImpl = fetch) {
  const current = validateGitHubSkillContext(context);
  const [owner, repo] = current.repository.split('/');
  const info = await json(fetchImpl, `${API_ROOT}/repos/${owner}/${repo}`);
  let commit = current.commit;
  if (!commit) {
    const commitInfo = await json(fetchImpl, `${API_ROOT}/repos/${owner}/${repo}/commits/${encodeURIComponent(current.ref || info.default_branch)}`);
    commit = commitInfo.sha;
  }
  return fetchAtCommit({ ...current, commit }, fetchImpl, info.default_branch);
}

export async function checkGitHubSkillUpdate(source, fetchImpl = fetch) {
  const [owner, repo] = String(source?.repository ?? '').split('/');
  if (!owner || !repo || source?.directory === undefined || source?.directory === null) throw new Error('该 Skill 没有可用的 GitHub 来源信息。');
  const info = await json(fetchImpl, `${API_ROOT}/repos/${owner}/${repo}`);
  const branch = info.default_branch;
  const commitInfo = await json(fetchImpl, `${API_ROOT}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`);
  const commit = commitInfo.sha;
  const path = source.directory ? `${source.directory}/SKILL.md` : 'SKILL.md';
  if (commit === source.commit) return { changed: false, commit, defaultBranch: branch };
  const packageRecord = await fetchAtCommit({ repository: source.repository, commit, path, url: source.url }, fetchImpl, branch);
  return { changed: true, commit, defaultBranch: branch, packageRecord };
}
