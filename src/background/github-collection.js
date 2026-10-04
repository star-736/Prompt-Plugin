import { commitGithubSkillPackage, isReadOnlyDatabase, loadDatabase, READ_ONLY_MESSAGE } from '../core/store.js';
import { checkGitHubSkillUpdate, collectGitHubSkill, githubSkillUrlError, inspectGitHubSkillUrl, skillContextFromPage } from '../features/github/github-skill.js';
import { deletePackage, putPackage } from '../platform/package-store.js';
import { githubFetch } from '../features/github/github-auth.js';
import { isRestrictedTabUrl } from '../content/in-place.js';
import { scheduleAi } from './ai-worker.js';

export function githubPageContext() {
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? '';
  const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? '';
  const repository = meta('octolytics-dimension-repository_nwo');
  let commit = meta('octolytics-dimension-commit_id') || attr('[data-commit-oid]', 'data-commit-oid') || attr('[data-oid]', 'data-oid') || '';
  let path = meta('octolytics-dimension-path') || attr('[data-path]', 'data-path') || '';
  const permalink = attr('a[data-hotkey="y"]', 'href');
  const permalinkSha = permalink.match(/\/(?:blob|raw)\/([0-9a-f]{40})\//i);
  if (!commit && permalinkSha) commit = permalinkSha[1];
  const parts = decodeURIComponent(location.pathname || '').replace(/\/+$/, '').split('/').filter(Boolean);
  const parsedRepo = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : '';
  const route = parts[2] === 'blob' || parts[2] === 'tree' ? parts[2] : '';
  const rest = route ? parts.slice(3) : [];
  let ref = '';
  let parsedPath = '';
  if (rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags') && rest.length >= 4) {
    ref = rest[2];
    parsedPath = rest.slice(3).join('/');
  } else if (rest.length >= 2) {
    ref = rest[0];
    parsedPath = rest.slice(1).join('/');
  }
  return { repository: repository || parsedRepo, commit, path: path || parsedPath, ref, url: location.href };
}

async function resolveCollectTab(message = {}) {
  if (message.tabId) {
    try { return await chrome.tabs.get(message.tabId); } catch { return null; }
  }
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current?.id && !isRestrictedTabUrl(current.url)) return current;
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return focused ?? current ?? null;
}

export async function collectFromActiveTab(message = {}) {
  if (isReadOnlyDatabase(await loadDatabase())) throw new Error(READ_ONLY_MESSAGE);
  const tab = await resolveCollectTab(message);
  const url = message.url || tab?.url || '';
  const inspection = inspectGitHubSkillUrl(url);
  if (inspection.kind !== 'skill-file') throw new Error(githubSkillUrlError(inspection.kind));
  if (!tab?.id) throw new Error('无法读取该文件页的仓库信息，请刷新后重试。');
  let injected = {};
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: githubPageContext });
    injected = result?.result ?? {};
  } catch { /* 新 UI 或缺 meta 时改用 URL / API。 */ }
  const fetchImpl = await githubFetch();
  const packageRecord = await collectGitHubSkill(skillContextFromPage(inspection, injected), fetchImpl);
  const database = await loadDatabase();
  const saved = await commitGithubSkillPackage(database, packageRecord, { putPackage, deletePackage });
  if (saved.duplicate) return { duplicate: true, asset: saved.asset, hasToken: fetchImpl.hasToken };
  if (saved.queued) await scheduleAi();
  return { duplicate: false, asset: saved.asset, hasToken: fetchImpl.hasToken };
}

export async function updateGitHubSkill(assetId) {
  const database = await loadDatabase();
  if (isReadOnlyDatabase(database)) throw new Error(READ_ONLY_MESSAGE);
  const asset = database.assets.find((item) => item.id === assetId);
  if (!asset?.skillPackage?.source) throw new Error('这不是可更新的 GitHub Skill。');
  const fetchImpl = await githubFetch();
  const result = await checkGitHubSkillUpdate(asset.skillPackage.source, fetchImpl);
  if (!result.changed) return { changed: false, hasToken: fetchImpl.hasToken };
  const saved = await commitGithubSkillPackage(database, result.packageRecord, { updateAssetId: assetId, putPackage, deletePackage });
  if (saved.queued) await scheduleAi();
  return { changed: true, asset: saved.asset, hasToken: fetchImpl.hasToken };
}
