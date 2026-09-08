import {
  activeProvider,
  addStructureProposal,
  applyAiAssetResult,
  applyAiCategoryGroups,
  captureSelection,
  categoriesFor,
  decryptProviderKey,
  displayTitle,
  isReadOnlyDatabase,
  loadDatabase,
  paletteAssets,
  READ_ONLY_MESSAGE,
  recordAssetUse,
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
import { PALETTE_SCRIPT_FILE, PALETTE_SCRIPT_ID, sitePattern } from './in-place.js';

const SESSION_KEY = 'futurecontext.ai-session';
const AI_ALARM = 'futurecontext.ai-queue';
const CAPTURE_MENU_ID = 'futurecontext-capture-selection';
export const NOTICE_KEY = 'futurecontext.notice';
const paletteLabels = { generic: '通用', skill: 'Skill', aigc: 'AIGC' };
let badgeTimer;

function sessionStorage() { return chrome.storage.session; }

// ---- 就地取用：启用站点的 content script 注册 ----
async function grantedSites(database) {
  const sites = database.settings.inPlace.enabled ? database.settings.inPlace.sites : [];
  const checks = await Promise.all(sites.map((origin) => chrome.permissions.contains({ origins: [sitePattern(origin)] }).catch(() => false)));
  return sites.filter((_, index) => checks[index]);
}
async function syncContentScripts() {
  const database = await loadDatabase();
  const matches = (await grantedSites(database)).map(sitePattern);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [PALETTE_SCRIPT_ID] });
  if (!matches.length) { if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [PALETTE_SCRIPT_ID] }); return { sites: 0 }; }
  const script = { id: PALETTE_SCRIPT_ID, js: [PALETTE_SCRIPT_FILE], matches, runAt: 'document_idle', allFrames: false, persistAcrossSessions: true };
  if (existing.length) await chrome.scripting.updateContentScripts([script]); else await chrome.scripting.registerContentScripts([script]);
  return { sites: matches.length };
}
async function activeTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab ?? null; }
async function notifyTab(tabId, text) { if (!tabId) return; try { await chrome.tabs.sendMessage(tabId, { type: 'fc-toast', text }); } catch { /* 未启用站点没有页面代码，静默。 */ } }
async function openPaletteInActiveTab() {
  const tab = await activeTab(); if (!tab?.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: 'fc-open-palette' }); }
  catch { await flashBadge('!', '这个网站还没有启用就地取用。在弹窗顶部或设置中启用后再按快捷键。'); }
}

// ---- 就地保存：右键菜单 ----
async function flashBadge(text, notice = null) {
  clearTimeout(badgeTimer);
  await chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#a45762' : '#6d90b9' });
  await chrome.action.setBadgeText({ text });
  if (notice) await sessionStorage().set({ [NOTICE_KEY]: { message: notice, at: Date.now() } });
  badgeTimer = setTimeout(() => { void chrome.action.setBadgeText({ text: '' }); }, 3000);
}
function readPageSelection() { return String(globalThis.getSelection?.() ?? ''); }
async function captureFromMenu(info, tab) {
  let text = info.selectionText ?? '';
  if (tab?.id) {
    try { const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [info.frameId ?? 0] }, func: readPageSelection }); if (String(injected?.result ?? '').trim()) text = injected.result; } catch { /* 无法读取精确选区时退回菜单提供的文本。 */ }
  }
  try {
    const database = await loadDatabase();
    if (isReadOnlyDatabase(database)) throw new Error(READ_ONLY_MESSAGE);
    const saved = captureSelection(database, text);
    await saveDatabase(saved.database);
    if (saved.queued) await scheduleAi();
    await flashBadge('✓');
    await notifyTab(tab?.id, '已保存到 FutureContext');
  } catch (error) { await flashBadge('!', error.message || '就地保存失败。'); }
}
function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => { chrome.contextMenus.create({ id: CAPTURE_MENU_ID, title: '保存到 FutureContext', contexts: ['selection'] }); });
}

// ---- 取用面板消息 ----
function paletteSummary(asset) {
  const preview = (asset.type === 'skill' && asset.skillDescription ? asset.skillDescription : asset.content).replace(/\s+/g, ' ').trim();
  return { id: asset.id, type: asset.type, typeLabel: paletteLabels[asset.type] ?? asset.type, title: displayTitle(asset), preview: preview.slice(0, 160), pinned: Boolean(asset.pinned) };
}
async function paletteInsert(id) {
  const database = await loadDatabase();
  const asset = database.assets.find((item) => item.id === id && item.privacy === 'normal');
  if (!asset) throw new Error('找不到该条目。');
  if (!isReadOnlyDatabase(database)) await saveDatabase(recordAssetUse(database, id));
  return { content: asset.content };
}
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
chrome.runtime.onInstalled.addListener(() => { ensureContextMenu(); void syncContentScripts(); });
chrome.runtime.onStartup.addListener(() => { void sessionStorage().remove(SESSION_KEY); void syncContentScripts(); });
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === CAPTURE_MENU_ID) void captureFromMenu(info, tab); });
chrome.commands.onCommand.addListener((command) => { if (command === 'open-palette') void openPaletteInActiveTab(); });
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
    if (message.type === 'palette-settings') { const db = await loadDatabase(); return { enabled: db.settings.inPlace.enabled, triggerEnabled: db.settings.inPlace.triggerEnabled }; }
    if (message.type === 'palette-query') { const db = await loadDatabase(); return paletteAssets(db, message.query ?? '').map(paletteSummary); }
    if (message.type === 'palette-insert') return paletteInsert(message.id);
    if (message.type === 'sync-sites') return syncContentScripts();
    if (message.type === 'read-notice') { const stored = await sessionStorage().get(NOTICE_KEY); const notice = stored[NOTICE_KEY]; await sessionStorage().remove(NOTICE_KEY); return { message: notice?.message ?? null }; }
    throw new Error('未知的 FutureContext 后台请求。');
  };
  run().then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: error.message || '操作失败。' }));
  return true;
});
