import {
  activeProvider,
  addStructureProposal,
  applyAiAssetResult,
  applyAiCategoryGroups,
  captureSelection,
  categoriesFor,
  commitGithubSkillPackage,
  decryptProviderKey,
  displayTitle,
  formatSkillInsert,
  isReadOnlyDatabase,
  loadDatabase,
  paletteAssets,
  READ_ONLY_MESSAGE,
  recordAssetUse,
  removeProviderConfig,
  saveDatabase,
  saveProviderConfig,
  updateAiSettings,
  verifyPrivacyPassword
} from './store.js';
import { buildAssetOrganizationPrompt, buildGroupingPrompt, buildStructurePrompt, chatCompletion, parseAssetResult, parseGroups } from './ai-organizer.js';
import { checkGitHubSkillUpdate, collectGitHubSkill, githubSkillUrlError, inspectGitHubSkillUrl, skillContextFromPage } from './github-skill.js';
import { deletePackage, putPackage } from './package-store.js';
import { inPlaceAllowsOrigin, isRestrictedTabUrl, livePaletteUpdate, originOfUrl, PALETTE_SCRIPT_FILE, PALETTE_SCRIPT_ID, paletteTypesForUrl, patternsForSites } from './in-place.js';

const SESSION_KEY = 'futurecontext.ai-session';
const AI_ALARM = 'futurecontext.ai-queue';
const CAPTURE_MENU_ID = 'futurecontext-capture-selection';
export const NOTICE_KEY = 'futurecontext.notice';
const paletteLabels = { generic: '通用', skill: 'Skill', aigc: 'AIGC' };
let badgeTimer;

function sessionStorage() { return chrome.storage.session; }

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function permissionGranted(origins, attempts = 3) {
  for (let index = 0; index < attempts; index += 1) {
    if (await chrome.permissions.contains({ origins }).catch(() => false)) return true;
    if (index < attempts - 1) await delay(50);
  }
  return false;
}

// ---- 就地取用：启用站点的 content script 注册 ----
async function grantedMatches(database) {
  const sites = database.settings.inPlace.enabled ? database.settings.inPlace.sites : [];
  const patterns = patternsForSites(sites);
  const checks = await Promise.all(patterns.map((pattern) => permissionGranted([pattern])));
  return patterns.filter((_, index) => checks[index]);
}
async function broadcastPaletteMessage(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (msg) => { globalThis.__fcPaletteOnMessage?.(msg); },
      args: [message]
    });
  } catch {
    try { await chrome.tabs.sendMessage(tabId, message); } catch { /* 标签没有页面代码，或权限已收回。 */ }
  }
}
async function liveUpdatePaletteTabs(inPlace, queryPatterns) {
  const patterns = [...new Set((queryPatterns ?? []).filter(Boolean))];
  if (!patterns.length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: patterns }); } catch { return; }
  await Promise.all((tabs ?? []).map(async (tab) => {
    if (!tab.id) return;
    const update = livePaletteUpdate(inPlace, originOfUrl(tab.url ?? ''));
    const message = update.action === 'destroy'
      ? { type: 'fc-destroy' }
      : { type: 'fc-settings', enabled: update.enabled, triggerEnabled: update.triggerEnabled };
    await broadcastPaletteMessage(tab.id, message);
  }));
}
async function syncContentScripts() {
  const database = await loadDatabase();
  const matches = await grantedMatches(database);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [PALETTE_SCRIPT_ID] }).catch(() => []);
  const previousMatches = existing[0]?.matches ?? [];
  const queryPatterns = [...new Set([...previousMatches, ...matches, ...patternsForSites(database.settings.inPlace.sites)])];
  await liveUpdatePaletteTabs(database.settings.inPlace, queryPatterns);
  if (!matches.length) { if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [PALETTE_SCRIPT_ID] }); return { sites: 0 }; }
  const script = { id: PALETTE_SCRIPT_ID, js: [PALETTE_SCRIPT_FILE], matches, runAt: 'document_idle', allFrames: true, persistAcrossSessions: true };
  if (existing.length) await chrome.scripting.updateContentScripts([script]); else await chrome.scripting.registerContentScripts([script]);
  return { sites: matches.length };
}
async function activeTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab ?? null; }
async function notifyTab(tabId, text) { if (!tabId) return; try { await chrome.tabs.sendMessage(tabId, { type: 'fc-toast', text }); } catch { /* 未启用站点没有页面代码，静默。 */ } }
async function injectPalette(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [PALETTE_SCRIPT_FILE] });
}
async function invokeOpenPalette(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const api = globalThis.__futureContextPalette;
      if (!api?.openFromShortcut) return 'missing';
      return api.openFromShortcut() ? 'opened' : 'idle';
    }
  });
  const values = (results ?? []).map((item) => item?.result);
  if (values.includes('opened')) return;
  if (values.length && values.every((value) => value === 'idle')) return;
  throw new Error('Could not establish connection. Receiving end does not exist.');
}
async function openPaletteInActiveTab() {
  const tab = await activeTab();
  if (!tab?.id) return;
  const origin = originOfUrl(tab.url ?? '');
  const database = await loadDatabase();
  const inPlace = database.settings.inPlace;
  const covered = inPlaceAllowsOrigin(inPlace, origin);
  try {
    await invokeOpenPalette(tab.id);
    return;
  } catch (error) {
    if (covered) {
      try {
        await injectPalette(tab.id);
        await delay(80);
        await invokeOpenPalette(tab.id);
        return;
      } catch (retryError) {
        await flashBadge('!', `无法在当前页打开取用面板：${retryError.message || error.message || '页面代码未加载'}`);
        return;
      }
    }
    const hint = origin
      ? '当前网站还没启用就地取用，请在弹窗里点启用'
      : '当前页面无法使用就地取用。请打开一个已启用的 AI 网站后再按快捷键。';
    await flashBadge('!', `${hint}（${error.message || '没有页面代码在听'}）`);
    try { await chrome.action.openPopup(); } catch { /* 个别环境不支持程序打开弹窗。 */ }
  }
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
function senderPageUrl(sender) {
  return sender?.tab?.url || sender?.url || '';
}
function senderOrigin(sender) {
  return originOfUrl(senderPageUrl(sender));
}
async function queryPalette(query, sender) {
  const db = await loadDatabase();
  if (!inPlaceAllowsOrigin(db.settings.inPlace, senderOrigin(sender))) return [];
  return paletteAssets(db, query ?? '', 8, { types: paletteTypesForUrl(senderPageUrl(sender)) }).map(paletteSummary);
}
async function paletteInsert(id, sender) {
  const database = await loadDatabase();
  if (!inPlaceAllowsOrigin(database.settings.inPlace, senderOrigin(sender))) throw new Error('当前站点未启用就地取用。');
  const asset = database.assets.find((item) => item.id === id && item.privacy === 'normal');
  if (!asset) throw new Error('找不到该条目。');
  if (!isReadOnlyDatabase(database)) await saveDatabase(recordAssetUse(database, id));
  return { content: formatSkillInsert(asset.content, asset.type) };
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

async function collectFromActiveTab(message = {}) {
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
  const packageRecord = await collectGitHubSkill(skillContextFromPage(inspection, injected));
  const database = await loadDatabase();
  const saved = await commitGithubSkillPackage(database, packageRecord, { putPackage, deletePackage });
  if (saved.duplicate) return { duplicate: true, asset: saved.asset };
  if (saved.queued) await scheduleAi();
  return { duplicate: false, asset: saved.asset };
}

async function updateGitHubSkill(assetId) {
  const database = await loadDatabase();
  if (isReadOnlyDatabase(database)) throw new Error(READ_ONLY_MESSAGE);
  const asset = database.assets.find((item) => item.id === assetId);
  if (!asset?.skillPackage?.source) throw new Error('这不是可更新的 GitHub Skill。');
  const result = await checkGitHubSkillUpdate(asset.skillPackage.source);
  if (!result.changed) return { changed: false };
  const saved = await commitGithubSkillPackage(database, result.packageRecord, { updateAssetId: assetId, putPackage, deletePackage });
  if (saved.queued) await scheduleAi();
  return { changed: true, asset: saved.asset };
}

export async function handleRuntimeMessage(message, sender = {}) {
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
  if (message.type === 'collect-github-skill') return collectFromActiveTab(message);
  if (message.type === 'update-github-skill') return updateGitHubSkill(message.assetId);
  if (message.type === 'palette-settings') {
    const db = await loadDatabase();
    return { enabled: inPlaceAllowsOrigin(db.settings.inPlace, senderOrigin(sender)), triggerEnabled: db.settings.inPlace.triggerEnabled !== false };
  }
  if (message.type === 'palette-query') return queryPalette(message.query ?? '', sender);
  if (message.type === 'palette-insert') return paletteInsert(message.id, sender);
  if (message.type === 'sync-sites') return syncContentScripts();
  if (message.type === 'read-notice') { const stored = await sessionStorage().get(NOTICE_KEY); const notice = stored[NOTICE_KEY]; await sessionStorage().remove(NOTICE_KEY); return { message: notice?.message ?? null }; }
  throw new Error('未知的 FutureContext 后台请求。');
}

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === AI_ALARM) void processAiQueue(); });
chrome.runtime.onInstalled.addListener(() => { ensureContextMenu(); void syncContentScripts(); });
chrome.runtime.onStartup.addListener(() => { void sessionStorage().remove(SESSION_KEY); void syncContentScripts(); });
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === CAPTURE_MENU_ID) void captureFromMenu(info, tab); });
chrome.commands.onCommand.addListener((command) => { if (command === 'open-palette') void openPaletteInActiveTab(); });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender).then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: error.message || '操作失败。' }));
  return true;
});
