import { assertPackageLimits, isTextFile } from './package-store.js';

const API_ROOT = 'https://api.github.com';

function decodeBase64(value) {
  if (typeof Buffer !== 'undefined') return Buffer.from(value.replace(/\n/g, ''), 'base64').toString('utf8');
  return decodeURIComponent(Array.from(atob(value.replace(/\n/g, '')), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
}

async function json(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}）。`);
  return response.json();
}

export function validateGitHubSkillContext(context) {
  if (!context || !/^[\w.-]+\/[\w.-]+$/.test(context.repository ?? '') || !context.commit || !context.path?.endsWith('/SKILL.md') && context.path !== 'SKILL.md') {
    throw new Error('请先打开公开 GitHub 仓库中的具体 SKILL.md 文件页面。');
  }
  return { repository: context.repository, commit: context.commit, path: context.path.replace(/^\/+/, ''), url: context.url ?? '' };
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
  return fetchAtCommit(current, fetchImpl, info.default_branch);
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
