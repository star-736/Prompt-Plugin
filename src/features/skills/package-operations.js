import { isReadOnlyDatabase } from '../../core/model.js';
import { mergeBackup, removeAsset, saveGithubSkillAsset } from '../../core/library.js';
import { applyDatabaseChange, READ_ONLY_MESSAGE, SAVE_CONFLICT_MESSAGE } from '../../platform/database-storage.js';
import { assertPackageLimits } from '../../platform/package-store.js';
import { cleanupPackageCandidates, deleteUnreferencedPackages } from './package-lifecycle.js';

export async function importBackupRecords(database, backupValue, { putPackage, deletePackage, persist, storage, now = Date.now(), idFactory } = {}) {
  const prepare = (base) => {
    const result = mergeBackup(base, backupValue, { now, idFactory });
    const records = [];
    for (const mapping of result.packageImports) {
      const source = (result.packages ?? []).find((item) => item.id === mapping.sourcePackageId);
      if (!source) continue;
      assertPackageLimits((source.files ?? []).map((file) => ({ path: file.path, size: file.size })));
      records.push({ ...source, id: mapping.targetPackageId });
    }
    return { result, records };
  };
  const writeRecords = async (base, records, written) => {
    for (const record of records) {
      if (base.assets.some((asset) => asset.skillPackage?.packageId === record.id)) {
        throw new Error('Skill 包 ID 已被资料库引用，请重新导入后重试。');
      }
      // Include a rejected write: the adapter may have committed before failing.
      written.push(record.id);
      await putPackage(record);
    }
  };
  if (persist) {
    const prepared = prepare(database);
    const written = [];
    try {
      await writeRecords(database, prepared.records, written);
      if (!await persist(prepared.result.database)) throw new Error(READ_ONLY_MESSAGE);
      return prepared.result;
    } catch (error) {
      await deleteUnreferencedPackages(database, written, deletePackage);
      throw error;
    }
  }
  let lastWritten = [];
  try {
    let imported = null;
    const saved = await applyDatabaseChange(async (latest) => {
      await deleteUnreferencedPackages(latest, lastWritten, deletePackage);
      lastWritten = [];
      const prepared = prepare(latest);
      await writeRecords(latest, prepared.records, lastWritten);
      imported = prepared.result;
      return prepared.result.database;
    }, storage, { onSaved: (acknowledged) => { imported.database = acknowledged; } });
    if (!saved) throw new Error(READ_ONLY_MESSAGE);
    return imported;
  } catch (error) {
    await cleanupPackageCandidates(lastWritten, { storage, removePackage: deletePackage });
    throw error;
  }
}

function assertWritableDatabase(database) {
  if (isReadOnlyDatabase(database)) throw new Error(READ_ONLY_MESSAGE);
}

export async function commitGithubSkillPackage(database, packageRecord, { updateAssetId = null, putPackage, deletePackage, persist, storage } = {}) {
  assertWritableDatabase(database);
  let result;
  let oldPackageId;
  let written = false;
  let referencedIncoming = false;
  const prepare = async (latest) => {
    assertWritableDatabase(latest);
    referencedIncoming = latest.assets.some((asset) => asset.skillPackage?.packageId === packageRecord.id);
    result = saveGithubSkillAsset(latest, packageRecord, { updateAssetId });
    if (result.duplicate) return null;
    const alreadySaved = latest.assets.find((asset) => asset.id === updateAssetId && asset.skillPackage?.packageId === packageRecord.id);
    if (alreadySaved && alreadySaved.content === packageRecord.skillContent &&
      ['repository', 'directory', 'commit'].every((key) => alreadySaved.skillPackage.source?.[key] === packageRecord.source?.[key])) {
      result = { database: latest, asset: alreadySaved, duplicate: true, queued: false };
      return null;
    }
    // Packages are immutable once referenced. Reusing an id would overwrite
    // the old files before the asset commit, and make rollback destructive.
    if (referencedIncoming) {
      throw new Error('Skill 包 ID 已被资料库引用，请重新收集后重试。');
    }
    oldPackageId = updateAssetId ? latest.assets.find((asset) => asset.id === updateAssetId)?.skillPackage?.packageId ?? null : null;
    if (!written) {
      written = true;
      await putPackage(packageRecord);
    }
    return result.database;
  };
  try {
    if (persist) {
      const next = await prepare(database);
      if (next && !await persist(next)) throw new Error(SAVE_CONFLICT_MESSAGE);
    } else {
      const saved = await applyDatabaseChange(prepare, storage, {
        onSaved: (acknowledged) => { result.database = acknowledged; }
      });
      if (!saved) throw new Error(READ_ONLY_MESSAGE);
    }
  } catch (error) {
    if (written) {
      if (persist) await deleteUnreferencedPackages(database, [packageRecord.id], deletePackage);
      else await cleanupPackageCandidates([packageRecord.id], { storage, removePackage: deletePackage });
    }
    throw error;
  }
  const candidates = result.duplicate ? (written ? [packageRecord.id] : []) : [oldPackageId].filter(Boolean);
  if (persist) await deleteUnreferencedPackages(result.database, candidates, deletePackage);
  else await cleanupPackageCandidates(candidates, { storage, removePackage: deletePackage });
  return result;
}

export async function removeAssetAndPackage(database, id, { persist, deletePackage, storage } = {}) {
  assertWritableDatabase(database);
  let packageId;
  let next;
  const prepare = (latest) => {
    assertWritableDatabase(latest);
    packageId = latest.assets.find((asset) => asset.id === id)?.skillPackage?.packageId ?? null;
    next = removeAsset(latest, id);
    return next;
  };
  if (persist) {
    prepare(database);
    if (!await persist(next)) throw new Error(SAVE_CONFLICT_MESSAGE);
  } else {
    const saved = await applyDatabaseChange(prepare, storage, { onSaved: (acknowledged) => { next = acknowledged; } });
    if (!saved) throw new Error(READ_ONLY_MESSAGE);
  }
  if (packageId) {
    if (persist) await deleteUnreferencedPackages(next, [packageId], deletePackage);
    else await cleanupPackageCandidates([packageId], { storage, removePackage: deletePackage });
  }
  return next;
}
