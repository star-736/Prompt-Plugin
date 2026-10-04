import { isReadOnlyDatabase } from '../../core/model.js';
import { loadDatabase, withDatabaseWriteLock } from '../../platform/database-storage.js';
import { deletePackage, listPackageIds } from '../../platform/package-store.js';

// Caller must hold the database write lock, or use an isolated persist adapter.
export async function deleteUnreferencedPackages(database, ids, remove = deletePackage) {
  const result = { deleted: 0, failed: 0, readOnly: isReadOnlyDatabase(database) };
  if (result.readOnly) return result;
  const referenced = new Set(database.assets.map((asset) => asset.skillPackage?.packageId).filter(Boolean));
  for (const id of new Set(ids)) {
    if (!id || referenced.has(id)) continue;
    try { await remove(id); result.deleted += 1; }
    catch { result.failed += 1; } // The durable package record remains for recovery.
  }
  return result;
}

export function recoverUnreferencedPackages({ storage = chrome.storage.local, packageIds, listPackages = listPackageIds, removePackage = deletePackage, ...lockOptions } = {}) {
  return withDatabaseWriteLock(storage, async () => {
    const latest = await loadDatabase(storage);
    if (isReadOnlyDatabase(latest)) return { deleted: 0, failed: 0, readOnly: true };
    const ids = packageIds ?? await listPackages();
    return deleteUnreferencedPackages(latest, ids, removePackage);
  }, lockOptions);
}

// Cleanup is never part of the acknowledged asset-save result. Lock, storage,
// or IndexedDB failures leave records discoverable by the next recovery sweep.
export async function cleanupPackageCandidates(ids, options) {
  if (!ids.length) return;
  try { await recoverUnreferencedPackages({ ...options, packageIds: ids }); } catch { /* Retry on recovery. */ }
}
