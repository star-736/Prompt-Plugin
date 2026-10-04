export const SYNC_SETTINGS_DRAFT_KEY = 'futurecontext.github-sync-draft';

const queues = new WeakMap();

// The worker owns pending writes so closing a popup does not abandon its queue.
// Reads and submission cleanup wait for earlier input, including failed writes.
function enqueue(storage, operation) {
  const task = (queues.get(storage) ?? Promise.resolve()).then(operation);
  queues.set(storage, task.catch(() => {}));
  return task;
}

function draftFields(input) {
  return {
    repository: String(input.repository ?? '').slice(0, 200),
    token: String(input.token ?? '').slice(0, 512),
    enabled: input.enabled === true,
    automatic: input.automatic !== false
  };
}

export function readSyncSettingsDraft(storage = chrome.storage.session) {
  return enqueue(storage, async () => {
    const stored = (await storage.get(SYNC_SETTINGS_DRAFT_KEY))[SYNC_SETTINGS_DRAFT_KEY];
    return stored ? draftFields(stored) : null;
  });
}

export function writeSyncSettingsDraft(input, storage = chrome.storage.session) {
  const draft = draftFields(input);
  return enqueue(storage, async () => {
    await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await storage.set({ [SYNC_SETTINGS_DRAFT_KEY]: draft });
    return { ok: true };
  });
}

export function discardSyncSettingsDraft(storage = chrome.storage.session) {
  return enqueue(storage, async () => { await storage.remove(SYNC_SETTINGS_DRAFT_KEY); return { ok: true }; });
}

export function submitSyncSettings(submit, storage = chrome.storage.session) {
  return enqueue(storage, async () => {
    const result = await submit();
    // Once settings are committed, cleanup failure must not report save failure.
    try { await storage.remove(SYNC_SETTINGS_DRAFT_KEY); }
    catch { return { ...result, draftWarning: '设置已保存，但暂存未能清除；请点击「放弃暂存」重试。' }; }
    return result;
  });
}
