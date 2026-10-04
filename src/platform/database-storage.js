import { clone, createEmptyDatabase, databaseRevision, isReadOnlyDatabase, normalizeDatabase } from '../core/model.js';

export const APP_STORAGE_KEY = 'futurecontext.v1';
export const SAVE_CONFLICT_ATTEMPTS = 8;

export async function loadDatabase(storage = chrome.storage.local) {
  const result = await storage.get?.(APP_STORAGE_KEY) ?? {};
  if (result[APP_STORAGE_KEY] === undefined) {
    const database = createEmptyDatabase();
    // Stable ids let separate contexts agree before the first persisted write.
    // Only a missing database gets presets; existing/deleted categories stay as-is.
    database.categories = [
      { id: 'preset-command-terminal', name: '终端指令' },
      { id: 'preset-command-browser', name: '浏览器指令' }
    ].map((category) => ({ ...category, scope: 'command', createdAt: Date.now(), createdBy: 'human' }));
    return database;
  }
  return normalizeDatabase(result[APP_STORAGE_KEY]);
}
export const READ_ONLY_MESSAGE = '数据来自更新版本的 FutureContext，请升级扩展。当前为只读，所有修改都不会保存。';
export const SAVE_CONFLICT_MESSAGE = '保存冲突，请重试。';
export const DATABASE_WRITE_LOCK = `${APP_STORAGE_KEY}:write`;
export const SAVE_BUSY_MESSAGE = '资料库正忙，尚未开始保存，请稍后重试。';
const storageQueues = new WeakMap();

export async function withDatabaseWriteLock(storage, run, { locks = globalThis.navigator?.locks, lockTimeout = 10000 } = {}) {
  if (locks?.request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), lockTimeout);
    try {
      return await locks.request(DATABASE_WRITE_LOCK, { mode: 'exclusive', signal: controller.signal }, () => {
        // Only a pending request can time out. Never release a lock while a
        // storage write is still running, or report that write as cancelled.
        clearTimeout(timer);
        return run();
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(SAVE_BUSY_MESSAGE);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  if (globalThis.chrome?.runtime?.id && storage === chrome.storage.local) {
    throw new Error('浏览器不支持安全保存所需的 Web Locks，请升级浏览器。');
  }
  // Injected storage adapters (including Node tests) have no extension origin.
  const queued = (storageQueues.get(storage) ?? Promise.resolve()).then(run);
  const tail = queued.catch(() => {});
  storageQueues.set(storage, tail);
  try { return await queued; }
  finally { if (storageQueues.get(storage) === tail) storageQueues.delete(storage); }
}

export function saveDatabase(database, storage = chrome.storage.local, options = {}) {
  return withDatabaseWriteLock(storage, () => saveDatabaseUnlocked(database, storage), options);
}

async function saveDatabaseUnlocked(database, storage) {
  if (isReadOnlyDatabase(database)) return false;
  const stored = await loadDatabase(storage);
  if (isReadOnlyDatabase(stored)) return false;
  if (databaseRevision(stored) !== databaseRevision(database)) return false;
  const next = normalizeDatabase(clone(database));
  next.revision = databaseRevision(stored) + 1;
  await storage.set({ [APP_STORAGE_KEY]: next });
  return true;
}

export function applyDatabaseChange(mutator, storage = chrome.storage.local, { attempts = SAVE_CONFLICT_ATTEMPTS, onSaved, ...lockOptions } = {}) {
  return withDatabaseWriteLock(storage, () => applyDatabaseChangeUnlocked(mutator, storage, attempts, onSaved), lockOptions);
}

async function applyDatabaseChangeUnlocked(mutator, storage, attempts, onSaved) {
  for (let index = 0; index < attempts; index += 1) {
    const current = await loadDatabase(storage);
    if (isReadOnlyDatabase(current)) return false;
    const produced = await mutator(current);
    if (produced == null) { onSaved?.(current); return true; }
    const next = produced.database ?? produced;
    if (isReadOnlyDatabase(next)) return false;
    next.revision = databaseRevision(current);
    if (await saveDatabaseUnlocked(next, storage)) {
      // Let UI callers adopt the acknowledged snapshot without a second,
      // fallible read that could turn a successful save into a false failure.
      onSaved?.(normalizeDatabase({ ...next, revision: databaseRevision(current) + 1 }));
      return true;
    }
  }
  throw new Error(SAVE_CONFLICT_MESSAGE);
}
