import { configureSync, removeSyncConfiguration, syncSettings, runLibrarySync, scheduleLibrarySync, relevantLibraryChange, SYNC_CONFIG_KEY, SYNC_ALARM, SYNC_DEBOUNCE_ALARM } from '../features/github/github-sync.js';
import { restrictLocalStorage } from '../features/github/github-auth.js';
import { AI_ALARM, aiSessionStatus, clearAiSession, deleteProvider, processAiQueue, queueExisting, saveProvider, scheduleAi, testProvider, unlockAi } from './ai-worker.js';
import { collectFromActiveTab, updateGitHubSkill } from './github-collection.js';
import { CAPTURE_MENU_ID, captureFromMenu, ensureContextMenu, openPaletteInActiveTab, paletteInsert, preparePaletteTemplate, recordPaletteUse, paletteSettings, queryPalette, readNotice, syncContentScripts } from './palette-controller.js';
import { recoverUnreferencedPackages } from '../features/skills/package-lifecycle.js';
import { readSyncSettingsDraft, writeSyncSettingsDraft, discardSyncSettingsDraft, submitSyncSettings } from './sync-settings-draft.js';
export { NOTICE_KEY } from './palette-controller.js';
export { githubPageContext } from './github-collection.js';

const CONTENT_SCRIPT_MESSAGES = Object.freeze(['palette-settings', 'palette-query', 'palette-insert', 'palette-template', 'palette-used']);
export const PACKAGE_RECOVERY_ALARM = 'futurecontext.package-recovery';

function recoverPackages() { return recoverUnreferencedPackages().catch(() => {}); }
async function startPackageRecovery() {
  // Alarms may disappear after a browser restart. Recreate on every worker load.
  await chrome.alarms.create(PACKAGE_RECOVERY_ALARM, { periodInMinutes: 5 });
  await recoverPackages();
}

function senderIsContentScript(sender) {
  const extensionRoot = chrome.runtime.getURL('');
  const trustedPage = typeof sender?.url === 'string' && sender.url.startsWith(extensionRoot);
  return Boolean(sender?.tab?.id) && !trustedPage;
}

function assertMessageAllowed(type, sender) {
  if (senderIsContentScript(sender) && !CONTENT_SCRIPT_MESSAGES.includes(type)) {
    throw new Error('该操作只能从 FutureContext 扩展页发起。');
  }
}

export async function handleRuntimeMessage(message, sender = {}) {
  assertMessageAllowed(message.type, sender);
  if (message.type === 'library-sync-draft-read') return readSyncSettingsDraft();
  if (message.type === 'library-sync-draft-write') return writeSyncSettingsDraft(message.draft);
  if (message.type === 'library-sync-draft-discard') return discardSyncSettingsDraft();
  if (message.type === 'library-sync-remove') { const result = await submitSyncSettings(() => removeSyncConfiguration()); await scheduleLibrarySync(); return result; }
  if (message.type === 'library-sync-settings') return syncSettings();
  if (message.type === 'library-sync-configure') { const result = await submitSyncSettings(() => configureSync(message.config)); await scheduleLibrarySync(); return result; }
  if (message.type === 'library-sync-now') return runLibrarySync();
  if (message.type === 'library-sync-open') { await scheduleLibrarySync(); const settings = await syncSettings(); if (settings.enabled && settings.automatic) void runLibrarySync().catch(() => {}); return settings; }
  if (message.type === 'schedule-ai') { await scheduleAi(); return { ok: true }; }
  if (message.type === 'process-ai-now') { await processAiQueue(); return { ok: true }; }
  if (message.type === 'unlock-ai') return unlockAi(message.password);
  if (message.type === 'ai-session-status') return aiSessionStatus();
  if (message.type === 'save-provider') return saveProvider(message.provider, message.password);
  if (message.type === 'delete-provider') return deleteProvider(message.id);
  if (message.type === 'clear-ai-session') return clearAiSession();
  if (message.type === 'test-provider') return testProvider(message.id);
  if (message.type === 'queue-existing') return queueExisting();
  if (message.type === 'collect-github-skill') return collectFromActiveTab(message);
  if (message.type === 'update-github-skill') return updateGitHubSkill(message.assetId);
  if (message.type === 'palette-settings') return paletteSettings(sender);
  if (message.type === 'palette-query') return queryPalette(message.query ?? '', sender);
  if (message.type === 'palette-template') return preparePaletteTemplate(message.id, sender);
  if (message.type === 'palette-insert') return paletteInsert(message.id, sender, { values: message.values, templateContent: message.templateContent, deferUsage: message.deferUsage === true });
  if (message.type === 'palette-used') { await recordPaletteUse(message.id, sender); return { recorded: true }; }
  if (message.type === 'sync-sites') return syncContentScripts();
  if (message.type === 'read-notice') return readNotice();
  throw new Error('未知的 FutureContext 后台请求。');
}

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === AI_ALARM) void processAiQueue(); });
chrome.runtime.onInstalled.addListener(() => { void restrictLocalStorage(); ensureContextMenu(); void syncContentScripts(); });
chrome.runtime.onStartup.addListener(() => { void restrictLocalStorage(); void clearAiSession(); void syncContentScripts(); });
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === CAPTURE_MENU_ID) void captureFromMenu(info, tab); });
chrome.commands.onCommand.addListener((command) => { if (command === 'open-palette') void openPaletteInActiveTab(); });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender).then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: error.message || '操作失败。' }));
  return true;
});

let librarySyncTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SYNC_CONFIG_KEY]) void scheduleLibrarySync();
  const change = changes['futurecontext.v1'];
  if (!change || !relevantLibraryChange(change.oldValue, change.newValue)) return;
  void scheduleLibrarySync({ changed: true });
  clearTimeout(librarySyncTimer);
  librarySyncTimer = setTimeout(async () => { const settings = await syncSettings(); if (settings.enabled && settings.automatic) void runLibrarySync().catch(() => {}); }, 7000);
});
chrome.alarms.onAlarm.addListener((alarm) => { if ([SYNC_ALARM, SYNC_DEBOUNCE_ALARM].includes(alarm.name)) void syncSettings().then((settings) => { if (settings.enabled && settings.automatic) return runLibrarySync(); }).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void scheduleLibrarySync(); });
chrome.runtime.onInstalled.addListener(() => { void scheduleLibrarySync(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === PACKAGE_RECOVERY_ALARM) return recoverPackages(); });
chrome.runtime.onStartup.addListener(() => { void startPackageRecovery().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void startPackageRecovery().catch(() => {}); });
void startPackageRecovery().catch(() => {});
