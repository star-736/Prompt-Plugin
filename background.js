import {
  activeProvider,
  addStructureProposal,
  applyAiAssetResult,
  applyAiCategoryGroups,
  categoriesFor,
  decryptProviderKey,
  loadDatabase,
  removeProviderConfig,
  saveDatabase,
  saveGithubSkillAsset,
  saveProviderConfig,
  updateAiSettings,
  verifyPrivacyPassword
} from './store.js';
import { buildAssetOrganizationPrompt, buildGroupingPrompt, buildStructurePrompt, chatCompletion, parseAssetResult, parseGroups } from './ai-organizer.js';
import { checkGitHubSkillUpdate, collectGitHubSkill } from './github-skill.js';
import { deletePackage, putPackage } from './package-store.js';

const SESSION_KEY = 'futurecontext.ai-session';
const AI_ALARM = 'futurecontext.ai-queue';

function sessionStorage() { return chrome.storage.session; }
async function setStatus(database, state, message = '') { const next = updateAiSettings(database, { status: { state, message } }); await saveDatabase(next); return next; }

async function sessionForProvider(providerId) {
  const stored = await sessionStorage().get(SESSION_KEY);
  const session = stored[SESSION_KEY];
  return session?.providerId === providerId ? session : null;
}

async function scheduleAi() {
  await chrome.alarms.create(AI_ALARM, { delayInMinutes: 0.2 });
}

function uncategorized(database, scope) {
  return database.assets.filter((asset) => asset.type === scope && asset.privacy === 'normal' && !asset.categoryId && asset.categorySource !== 'manual');
}

async function processAiQueue() {
  let database = await loadDatabase();
  if (!database.ai.enabled || !database.ai.queue.length) return;
  const provider = activeProvider(database);
  if (!provider) return setStatus(database, 'paused', '后台整理暂停，检查 Provider 配置。');
  const session = await sessionForProvider(provider.id);
  if (!session?.apiKey) return setStatus(database, 'paused', '后台整理已等待解锁。');
  try {
    const queue = [...database.ai.queue];
    for (const entry of queue) {
      const asset = database.assets.find((item) => item.id === entry.assetId);
      if (!asset || !['generic', 'skill'].includes(asset.type) || asset.privacy !== 'normal') { database.ai.queue = database.ai.queue.filter((item) => item.id !== entry.id); continue; }
      const result = parseAssetResult(await chatCompletion(provider, session.apiKey, buildAssetOrganizationPrompt(asset, categoriesFor(database, asset.type))));
      database = applyAiAssetResult(database, asset.id, result);
      database.ai.queue = database.ai.queue.filter((item) => item.id !== entry.id);
    }
    for (const scope of ['generic', 'skill']) {
      const open = uncategorized(database, scope);
      if (open.length >= database.ai.thresholds.uncategorized) {
        const response = await chatCompletion(provider, session.apiKey, buildGroupingPrompt(scope, open.slice(0, 50)));
        database = applyAiCategoryGroups(database, scope, parseGroups(response, open.map((item) => item.id)));
      }
    }
    const elapsedDays = database.ai.lastRestructureAt ? (Date.now() - database.ai.lastRestructureAt) / 86400000 : Infinity;
    if (database.ai.changeCountSinceRestructure >= database.ai.thresholds.restructureChanges && elapsedDays >= database.ai.thresholds.restructureDays) {
      for (const scope of ['generic', 'skill']) {
        const categories = categoriesFor(database, scope);
        if (!categories.length) continue;
        const response = await chatCompletion(provider, session.apiKey, buildStructurePrompt(scope, categories, database.assets.filter((asset) => asset.type === scope)));
        if (response?.proposal?.groups?.length) database = addStructureProposal(database, { scope, ...response.proposal });
      }
      database = updateAiSettings(database, { lastRestructureAt: Date.now(), changeCountSinceRestructure: 0 });
    }
    database = updateAiSettings(database, { status: { state: 'idle', message: '' } });
    await saveDatabase(database);
  } catch {
    await setStatus(database, 'paused', '后台整理暂停，检查 Provider 配置。');
  }
}

async function unlockAi(password) {
  const database = await loadDatabase();
  if (!await verifyPrivacyPassword(database, password)) throw new Error('隐私锁密码不正确。');
  const provider = activeProvider(database);
  if (!provider) throw new Error('请先保存并选择一个 Provider。');
  const apiKey = await decryptProviderKey(password, provider.secret);
  await sessionStorage().set({ [SESSION_KEY]: { providerId: provider.id, apiKey, unlockedAt: Date.now() } });
  await saveDatabase(updateAiSettings(database, { status: { state: 'idle', message: '' } }));
  await scheduleAi();
  return { providerId: provider.id };
}

async function queueExisting() {
  const database = await loadDatabase();
  if (!database.ai.enabled) throw new Error('请先开启后台 AI 整理。');
  const queuedIds = new Set(database.ai.queue.map((entry) => entry.assetId));
  let count = 0;
  for (const asset of database.assets) {
    if (!['generic', 'skill'].includes(asset.type) || asset.privacy !== 'normal' || queuedIds.has(asset.id)) continue;
    database.ai.queue.push({ id: crypto.randomUUID(), assetId: asset.id, assetType: asset.type, queuedAt: Date.now() });
    count += 1;
  }
  await saveDatabase(database);
  if (count) await scheduleAi();
  return { count };
}

async function testProvider(id) {
  const database = await loadDatabase();
  const provider = database.ai.providers.find((item) => item.id === id);
  if (!provider) throw new Error('找不到 Provider。');
  const session = await sessionForProvider(provider.id);
  if (!session?.apiKey) throw new Error('请先解锁此 Provider。');
  await chatCompletion(provider, session.apiKey, '返回 {"ok":true}。');
  return { ok: true };
}

function githubPageContext() {
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? '';
  const repository = meta('octolytics-dimension-repository_nwo');
  const commit = meta('octolytics-dimension-commit_id');
  const path = meta('octolytics-dimension-path') || document.querySelector('[data-path]')?.getAttribute('data-path') || '';
  return { repository, commit, path, url: location.href };
}

async function collectFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !String(tab.url).startsWith('https://github.com/')) throw new Error('请先打开公开 GitHub 仓库中的具体 SKILL.md 文件页面。');
  const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: githubPageContext });
  const packageRecord = await collectGitHubSkill(injected?.result);
  await putPackage(packageRecord);
  const database = await loadDatabase();
  const saved = saveGithubSkillAsset(database, packageRecord);
  if (saved.duplicate) { await deletePackage(packageRecord.id); return { duplicate: true, asset: saved.asset }; }
  await saveDatabase(saved.database);
  return { duplicate: false, asset: saved.asset };
}

async function updateGitHubSkill(assetId) {
  const database = await loadDatabase();
  const asset = database.assets.find((item) => item.id === assetId);
  if (!asset?.skillPackage?.source) throw new Error('这不是可更新的 GitHub Skill。');
  const result = await checkGitHubSkillUpdate(asset.skillPackage.source);
  if (!result.changed) return { changed: false };
  await putPackage(result.packageRecord);
  const saved = saveGithubSkillAsset(database, result.packageRecord, { updateAssetId: assetId });
  await saveDatabase(saved.database);
  await deletePackage(asset.skillPackage.packageId);
  return { changed: true, asset: saved.asset };
}

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === AI_ALARM) void processAiQueue(); });
chrome.runtime.onStartup.addListener(() => { void sessionStorage().remove(SESSION_KEY); });
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    if (message.type === 'schedule-ai') { await scheduleAi(); return { ok: true }; }
    if (message.type === 'process-ai-now') { await processAiQueue(); return { ok: true }; }
    if (message.type === 'unlock-ai') return unlockAi(message.password);
    if (message.type === 'ai-session-status') { const database = await loadDatabase(); const provider = activeProvider(database); return { unlocked: Boolean(provider && await sessionForProvider(provider.id)), providerId: provider?.id ?? null }; }
    if (message.type === 'save-provider') {
      const database = await loadDatabase();
      const result = await saveProviderConfig(database, message.provider, message.password);
      const saved = result.database.ai.providers.find((provider) => provider.id === result.provider.id);
      const apiKey = await decryptProviderKey(message.password, saved.secret);
      await saveDatabase(result.database);
      await sessionStorage().set({ [SESSION_KEY]: { providerId: saved.id, apiKey, unlockedAt: Date.now() } });
      return result.provider;
    }
    if (message.type === 'delete-provider') { const database = await loadDatabase(); await saveDatabase(removeProviderConfig(database, message.id)); await sessionStorage().remove(SESSION_KEY); return { ok: true }; }
    if (message.type === 'clear-ai-session') { await sessionStorage().remove(SESSION_KEY); return { ok: true }; }
    if (message.type === 'test-provider') return testProvider(message.id);
    if (message.type === 'queue-existing') return queueExisting();
    if (message.type === 'collect-github-skill') return collectFromActiveTab();
    if (message.type === 'update-github-skill') return updateGitHubSkill(message.assetId);
    throw new Error('未知的 FutureContext 后台请求。');
  };
  run().then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: error.message || '操作失败。' }));
  return true;
});
