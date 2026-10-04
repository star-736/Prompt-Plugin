import { isReadOnlyDatabase } from '../../core/model.js';
import { mergeBackup, removeAsset, saveGithubSkillAsset } from '../../core/library.js';
import { applyDatabaseChange, READ_ONLY_MESSAGE, SAVE_CONFLICT_MESSAGE } from '../../platform/database-storage.js';
import { assertPackageLimits } from '../../platform/package-store.js';

async function rollbackPackages(ids, deletePackage) {
  for (const id of ids) {
    try { await deletePackage(id); } catch { /* 回滚尽力。 */ }
  }
}

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
  const writeRecords = async (records) => {
    const written = [];
    try {
      for (const record of records) {
        await putPackage(record);
        written.push(record.id);
      }
      return written;
    } catch (error) {
      await rollbackPackages(written, deletePackage);
      throw error;
    }
  };
  if (persist) {
    const prepared = prepare(database);
    const written = await writeRecords(prepared.records);
    try {
      if (!await persist(prepared.result.database)) throw new Error(READ_ONLY_MESSAGE);
      return prepared.result;
    } catch (error) {
      await rollbackPackages(written, deletePackage);
      throw error;
    }
  }
  let lastWritten = [];
  try {
    let imported = null;
    const saved = await applyDatabaseChange(async (latest) => {
      await rollbackPackages(lastWritten, deletePackage);
      lastWritten = [];
      const prepared = prepare(latest);
      lastWritten = await writeRecords(prepared.records);
      imported = prepared.result;
      return prepared.result.database;
    }, storage, { onSaved: (acknowledged) => { imported.database = acknowledged; } });
    if (!saved) throw new Error(READ_ONLY_MESSAGE);
    return imported;
  } catch (error) {
    await rollbackPackages(lastWritten, deletePackage);
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
      await putPackage(packageRecord);
      written = true;
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
    if (written && !referencedIncoming) await rollbackPackages([packageRecord.id], deletePackage);
    throw error;
  }
  if (result.duplicate) {
    if (written && !referencedIncoming) await rollbackPackages([packageRecord.id], deletePackage);
  } else if (oldPackageId && !result.database.assets.some((asset) => asset.skillPackage?.packageId === oldPackageId)) {
    await rollbackPackages([oldPackageId], deletePackage);
  }
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
  if (packageId && !next.assets.some((asset) => asset.skillPackage?.packageId === packageId)) await rollbackPackages([packageId], deletePackage);
  return next;
}
