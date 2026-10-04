import { applyDatabaseChange, captureSelection, displayTitle, formatPaletteInsert, isReadOnlyDatabase, loadDatabase, paletteAssets, READ_ONLY_MESSAGE, recordAssetUse } from '../core/store.js';
import { inPlaceAllowsOrigin, livePaletteUpdate, originOfUrl, PALETTE_SCRIPT_FILE, PALETTE_SCRIPT_ID, paletteTypesForUrl, patternsForSites } from '../content/in-place.js';
import { scheduleAi } from './ai-worker.js';

export const CAPTURE_MENU_ID = 'futurecontext-capture-selection';
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
export async function syncContentScripts() {
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
export async function openPaletteInActiveTab() {
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
export async function captureFromMenu(info, tab) {
  let text = info.selectionText ?? '';
  if (tab?.id) {
    try { const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [info.frameId ?? 0] }, func: readPageSelection }); if (String(injected?.result ?? '').trim()) text = injected.result; } catch { /* 无法读取精确选区时退回菜单提供的文本。 */ }
  }
  try {
    let queued = false;
    await applyDatabaseChange((database) => {
      if (isReadOnlyDatabase(database)) throw new Error(READ_ONLY_MESSAGE);
      const saved = captureSelection(database, text);
      queued = saved.queued;
      return saved.database;
    });
    if (queued) await scheduleAi();
    await flashBadge('✓');
    await notifyTab(tab?.id, '已保存到 FutureContext');
  } catch (error) { await flashBadge('!', error.message || '就地保存失败。'); }
}
export function ensureContextMenu() {
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
export async function queryPalette(query, sender) {
  const db = await loadDatabase();
  if (!inPlaceAllowsOrigin(db.settings.inPlace, senderOrigin(sender))) return [];
  return paletteAssets(db, query ?? '', 8, { types: paletteTypesForUrl(senderPageUrl(sender)) }).map(paletteSummary);
}
export async function paletteInsert(id, sender) {
  const database = await loadDatabase();
  if (!inPlaceAllowsOrigin(database.settings.inPlace, senderOrigin(sender))) throw new Error('当前站点未启用就地取用。');
  const allowed = new Set(paletteTypesForUrl(senderPageUrl(sender)));
  const asset = database.assets.find((item) => item.id === id && item.privacy === 'normal');
  if (!asset) throw new Error('找不到该条目。');
  if (!allowed.has(asset.type)) throw new Error('当前页面不能取用该类型的资产。');
  if (!isReadOnlyDatabase(database)) await applyDatabaseChange((latest) => recordAssetUse(latest, id));
  return { content: formatPaletteInsert(asset) };
}

export async function paletteSettings(sender) {
  const db = await loadDatabase();
  return { enabled: inPlaceAllowsOrigin(db.settings.inPlace, senderOrigin(sender)), triggerEnabled: db.settings.inPlace.triggerEnabled !== false };
}

export async function readNotice() {
  const stored = await sessionStorage().get(NOTICE_KEY);
  await sessionStorage().remove(NOTICE_KEY);
  return { message: stored[NOTICE_KEY]?.message ?? null };
}
