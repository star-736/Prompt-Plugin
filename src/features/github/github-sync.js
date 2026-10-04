import { applyDatabaseChange, loadDatabase, isReadOnlyDatabase, CATEGORY_SCOPES, ASSET_TYPES, parseSkillMetadata, withDatabaseWriteLock } from '../../core/store.js';
import { getPackage, putPackage, deletePackage, assertPackageLimits } from '../../platform/package-store.js';
import { cleanupPackageCandidates } from '../skills/package-lifecycle.js';
import { restrictLocalStorage } from './github-auth.js';
import { parsePromptTemplate } from '../../core/prompt-template.js';

export const SYNC_CONFIG_KEY = 'futurecontext.github-sync';
export const SYNC_STATUS_KEY = 'futurecontext.github-sync-status';
export const SYNC_FORMAT = 'futurecontext.library-sync';
export const SYNC_PATH = '.futurecontext/library.json';
export const SYNC_LIMIT = 15 * 1024 * 1024;
export const SYNC_ALARM = 'futurecontext.library-sync';
export const SYNC_DEBOUNCE_ALARM = 'futurecontext.library-sync-change';
const clone = (value) => structuredClone(value);
const canonical = (value) => { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; };
const same = (a, b) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
const string = (v, max = 10000000) => typeof v === 'string' && v.length <= max;
const validId = (v) => string(v, 256) && /^[\w.-]+$/.test(v);
const keys = (v, allowed) => Object.keys(v).every((key) => allowed.includes(key));
const pick = (v, fields) => Object.fromEntries(fields.filter((key) => v[key] !== undefined).map((key) => [key, clone(v[key])]));
const ASSET_FIELDS = ['id', 'type', 'privacy', 'title', 'content', 'categoryId', 'skillDescription', 'titleSource', 'categorySource', 'createdAt', 'updatedAt', 'pinned', 'templateEnabled'];
const CATEGORY_FIELDS = ['id', 'scope', 'name', 'createdBy'];
const SOURCE_FIELDS = ['repository', 'directory', 'commit', 'ref', 'url', 'owner', 'repo', 'branch', 'defaultBranch'];
const FILE_FIELDS = ['path', 'size', 'encoding', 'content', 'contentType'];

function cleanPackage(record) {
  if (!record) throw new Error('Skill 辅助文件缺失，请恢复文件包后重试同步。');
  return { files: record.files.map((file) => pick(file, FILE_FIELDS)) };
}
export async function libraryRecords(database, readPackage = getPackage) {
  const records = {};
  for (const category of database.categories) if (CATEGORY_SCOPES.includes(category.scope)) records[`category:${category.id}`] = { value: pick(category, CATEGORY_FIELDS) };
  for (const asset of database.assets) {
    if (asset.privacy !== 'normal' || !ASSET_TYPES.includes(asset.type)) continue;
    const value = pick(asset, ASSET_FIELDS);
    if (asset.skillPackage?.packageId && asset.type === 'skill') {
      value.package = cleanPackage(await readPackage(asset.skillPackage.packageId));
      value.package.source = pick(asset.skillPackage.source ?? {}, SOURCE_FIELDS);
    }
    records[`asset:${asset.id}`] = { value };
  }
  return records;
}
function invalid() { throw new Error('远端同步文件格式无效，未修改本地资料库。'); }
export function validateSyncDocument(input) {
  if (!input || input.format !== SYNC_FORMAT || input.version !== 1 || !keys(input, ['format', 'version', 'records']) || !input.records || typeof input.records !== 'object' || Array.isArray(input.records) || Object.keys(input.records).length > 20000) invalid();
  const document = clone(input);
  for (const [key, record] of Object.entries(document.records)) {
    const match = key.match(/^(asset|category):([\w.-]{1,256})$/);
    if (!match || !record || !keys(record, ['value', 'deleted', 'withdrawn']) || (record.deleted !== true && !record.value) || (record.deleted && record.value)) invalid();
    if (record.deleted !== undefined && record.deleted !== true) invalid();
    if (record.withdrawn !== undefined && (record.withdrawn !== true || record.deleted !== true || match[1] !== 'asset')) invalid();
    if (record.deleted === true) continue;
    const v = record.value;
    if (!validId(v.id) || v.id !== match[2]) invalid();
    if (match[1] === 'category') {
      if (v.createdBy !== undefined && !['human', 'ai', 'proposal'].includes(v.createdBy)) invalid();
      if (!keys(v, CATEGORY_FIELDS) || !CATEGORY_SCOPES.includes(v.scope) || !string(v.name, 40) || !v.name.trim()) invalid();
    } else {
      if (!keys(v, [...ASSET_FIELDS, 'package']) || !ASSET_TYPES.includes(v.type) || v.privacy !== 'normal' || !string(v.title, 100000) || !string(v.content) || !v.content.trim() || (v.categoryId != null && !validId(v.categoryId))) invalid();
      for (const field of ['createdAt', 'updatedAt']) if (!Number.isFinite(v[field]) || v[field] < 0) invalid();
      if (v.skillDescription != null && !string(v.skillDescription, 100000)) invalid();
      if (v.titleSource != null && !['manual', 'none', 'ai'].includes(v.titleSource)) invalid();
      if (v.categorySource != null && !['manual', 'none', 'ai', 'proposal'].includes(v.categorySource)) invalid();
      if (v.pinned !== undefined && typeof v.pinned !== 'boolean') invalid();
      if (v.templateEnabled !== undefined && typeof v.templateEnabled !== 'boolean') invalid();
      if (v.templateEnabled) {
        if (!['generic', 'aigc'].includes(v.type)) invalid();
        try { parsePromptTemplate(v.content); } catch { invalid(); }
      }
      if (v.type === 'skill') { try { parseSkillMetadata(v.content); } catch { invalid(); } }
      if (v.package) {
        if (v.type !== 'skill' || !keys(v.package, ['files', 'source']) || !Array.isArray(v.package.files) || v.package.files.length > 2000 || !v.package.source || !keys(v.package.source, SOURCE_FIELDS)) invalid();
        if (Object.values(v.package.source).some((value) => !string(value, 2048))) invalid();
        const source = v.package.source;
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository ?? '') || !string(source.directory, 1024) || !/^[a-fA-F0-9]{40}$/.test(source.commit ?? '') || !string(source.defaultBranch, 256) || !source.defaultBranch) invalid();
        const paths = new Set();
        for (const file of v.package.files) {
          if (!keys(file, FILE_FIELDS) || !string(file.path, 1024) || !file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some((part) => !part || part === '.' || part === '..') || paths.has(file.path) || file.encoding !== 'base64' || !string(file.content) || !/^[A-Za-z0-9+/=\s]*$/.test(file.content) || !Number.isFinite(file.size) || file.size < 0) invalid();
          if (file.contentType !== undefined && !['text/plain', 'application/octet-stream'].includes(file.contentType)) invalid();
          paths.add(file.path);
          const bytes = decodeBytes(file.content).length;
          if (bytes !== file.size) invalid();
        }
        const skillFile = v.package.files.find((file) => file.path === 'SKILL.md');
        if (!skillFile || decode(skillFile.content).replace(/^\uFEFF/, '') !== v.content.replace(/^\uFEFF/, '')) invalid();
        try { assertPackageLimits(v.package.files); } catch { invalid(); }
      }
    }
  }
  return document;
}
function encode(text) { const bytes = new TextEncoder().encode(text); let result = ''; for (let i = 0; i < bytes.length; i += 32768) result += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(result); }
function decodeBytes(text) { return Uint8Array.from(atob(text.replace(/\s/g, '')), (c) => c.charCodeAt(0)); }
function decode(text) { return new TextDecoder('utf-8', { fatal: true }).decode(decodeBytes(text)); }
function conflictId(id, record) { let a = 2166136261; let b = 5381; for (const c of JSON.stringify(canonical(record))) { a = Math.imul(a ^ c.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ c.charCodeAt(0); } return `${id.slice(0, 210)}.conflict-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`; }
export function mergeLibrary(local, remote, base = {}, privateIds = []) {
  const records = {}; const privateConflicts = []; let conflicts = 0;
  const withdrawn = new Set([...privateIds, ...Object.entries(remote).filter(([, r]) => r.withdrawn).map(([key]) => key.slice(6)), ...Object.entries(base).filter(([, r]) => r.withdrawn).map(([key]) => key.slice(6))]);
  const blocked = (key) => key.startsWith('asset:') && [...withdrawn].some((id) => key === `asset:${id}` || key.startsWith(`asset:${id}.conflict-`));
  for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[key] ?? (base[key] ? { deleted: true } : undefined);
    const r = remote[key]; const b = base[key];
    if (blocked(key)) {
      records[key] = { deleted: true, withdrawn: true };
      if (l?.value && !privateIds.includes(l.value.id) && !same(l, b)) { privateConflicts.push(clone(l.value)); conflicts += 1; }
      continue;
    }
    if (same(l, r) || same(r, b)) records[key] = clone(l ?? r);
    else if (same(l, b)) records[key] = clone(r ?? l);
    else if (!l) records[key] = clone(r);
    else if (!r) records[key] = clone(l);
    else {
      records[key] = clone(r.deleted ? r : l); conflicts += 1;
      if (r.deleted && l.value) {
        const id = conflictId(l.value.id, l); const copy = clone(l); copy.value.id = id;
        if (key.startsWith('asset:') && ['generic', 'command'].includes(copy.value.type)) copy.value.title = `${copy.value.title.slice(0, 99985)}（同步冲突）`;
        if (key.startsWith('category:')) copy.value.name = `${copy.value.name.slice(0, 29)}（同步冲突）`;
        records[`${key.split(':')[0]}:${id}`] = copy;
      }
      if (r.value) {
        const id = conflictId(r.value.id, r); const copy = clone(r);
        copy.value.id = id;
        if (key.startsWith('asset:') && ['generic', 'command'].includes(copy.value.type)) copy.value.title = `${copy.value.title.slice(0, 99985)}（同步冲突）`;
        if (key.startsWith('category:')) copy.value.name = `${copy.value.name.slice(0, 29)}（同步冲突）`;
        records[`${key.split(':')[0]}:${id}`] = copy;
      }
    }
  }
  // Remote versions of assets follow the preserved remote category version.
  for (const [key, remoteCategory] of Object.entries(remote)) {
    if (!key.startsWith('category:') || !remoteCategory.value || !local[key]?.value || same(local[key], remoteCategory) || same(local[key], base[key]) || same(remoteCategory, base[key])) continue;
    const copiedId = conflictId(remoteCategory.value.id, remoteCategory);
    for (const record of Object.values(records)) if (record.value?.categoryId === remoteCategory.value.id) {
      const remoteAsset = remote[`asset:${record.value.id}`];
      if (same(record, remoteAsset) || record.value.id.includes('.conflict-')) record.value.categoryId = copiedId;
    }
  }
  return { records: Object.fromEntries(Object.entries(records).filter(([, value]) => value)), conflicts, privateConflicts };
}
export function applyLibrary(database, records, privateConflicts = []) {
  const next = clone(database);
  const privateIds = database.assets.filter((a) => a.privacy === 'private').map((a) => a.id);
  for (const [key, record] of Object.entries(records)) {
    const [kind, id] = key.split(':');
    if (kind === 'asset' && privateIds.some((v) => id === v || id.startsWith(`${v}.conflict-`))) continue;
    const list = kind === 'asset' ? next.assets : next.categories;
    const index = list.findIndex((v) => v.id === id);
    if (record.withdrawn) next.syncWithdrawals = [...new Set([...(next.syncWithdrawals ?? []), id])];
    if (record.deleted) { if (index >= 0) list.splice(index, 1); continue; }
    let value = clone(record.value);
    if (kind === 'asset') {
      const { package: pkg, ...asset } = value; value = { ...asset, useCount: list[index]?.useCount ?? 0, lastUsedAt: list[index]?.lastUsedAt ?? null, skillDelivery: list[index]?.skillDelivery };
      if (pkg) value.skillPackage = { packageId: packageIdFor(record.value), source: pkg.source, fileCount: pkg.files.length, totalSize: pkg.files.reduce((s, f) => s + f.size, 0) };
    } else value.createdAt = list[index]?.createdAt ?? 0;
    if (index >= 0) list[index] = value; else list.push(value);
  }
  for (const value of privateConflicts) {
    const id = conflictId(value.id, { privateConflict: value });
    if (value.type === 'aigc' && !next.assets.some((a) => a.id === id)) next.assets.push({ ...value, id, privacy: 'private', categoryId: null, pinned: false });
  }
  for (const asset of next.assets) if (asset.privacy === 'normal' && asset.categoryId && !next.categories.some((c) => c.id === asset.categoryId && c.scope === (asset.type === 'aigc' ? 'aigc-normal' : asset.type))) asset.categoryId = null;
  return next;
}
function packageIdFor(asset) { return `sync-${conflictId(asset.id, asset.package)}`; }
export function removeSyncConfiguration(storage = chrome.storage.local, options = {}) {
  cancellation?.abort();
  return withDatabaseWriteLock(storage, async () => { await storage.remove(SYNC_CONFIG_KEY); await storage.set({ [SYNC_STATUS_KEY]: { state: 'idle', message: '同步设置与 Token 已移除' } }); return syncSettings(storage); }, options);
}
let active;
let cancellation;
export async function syncSettings(storage = chrome.storage.local) {
  const values = await storage.get([SYNC_CONFIG_KEY, SYNC_STATUS_KEY]); const config = values[SYNC_CONFIG_KEY] ?? {};
  return { repository: config.repository ?? '', enabled: config.enabled === true, automatic: config.automatic !== false, configured: Boolean(config.token), status: values[SYNC_STATUS_KEY] ?? { state: 'idle', message: '尚未同步' } };
}
export function configureSync(input, storage = chrome.storage.local, options = {}) {
  cancellation?.abort();
  return withDatabaseWriteLock(storage, () => configureSyncUnlocked(input, storage), options);
}
async function configureSyncUnlocked(input, storage) {
  cancellation?.abort();
  await restrictLocalStorage(storage);
  const stored = (await storage.get(SYNC_CONFIG_KEY))[SYNC_CONFIG_KEY] ?? {};
  const repository = String(input.repository ?? '').trim().replace(/^https:\/\/github.com\//, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('请输入 owner/repo 格式的已有私有仓库。');
  const token = String(input.token || stored.token || '').trim();
  if (!/^[A-Za-z0-9_]{1,512}$/.test(token)) throw new Error('请输入专用 GitHub Token。');
  await storage.set({ [SYNC_CONFIG_KEY]: { repository, token, enabled: input.enabled === true, automatic: input.automatic !== false, generation: crypto.randomUUID() }, [SYNC_STATUS_KEY]: { state: 'idle', message: input.enabled ? '已保存，等待同步' : '同步已关闭' } });
  return syncSettings(storage);
}
export function runLibrarySync(options = {}) {
  if (active) return active;
  active = performSync(options).finally(() => { active = null; }); return active;
}
async function performSync({ storage = chrome.storage.local, fetchImpl = fetch, readPackage = getPackage, writePackage = putPackage, removePackage = deletePackage, locks } = {}) {
  const config = (await storage.get(SYNC_CONFIG_KEY))[SYNC_CONFIG_KEY];
  if (!config?.enabled) return syncSettings(storage);
  cancellation = new AbortController(); const signal = cancellation.signal;
  const packageCandidates = new Set();
  const assertCurrent = async () => { const latest = (await storage.get(SYNC_CONFIG_KEY))[SYNC_CONFIG_KEY]; if (signal.aborted || !same(config, latest)) throw new Error('同步设置已变更，本次同步已取消。'); };
  const status = async (state, message, extra = {}) => { await assertCurrent(); await storage.set({ [SYNC_STATUS_KEY]: { state, message, ...extra } }); };
  const request = async (path, options = {}) => {
    await assertCurrent();
    const timer = setTimeout(() => cancellation?.abort(), 8000);
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${config.repository}${path}`, { ...options, signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${config.token}`, ...options.headers } });
      if (!response.ok) { const error = new Error(`GitHub 同步失败（${response.status}）。请检查网络、私有仓库和 Token 的 Contents 读写权限。`); error.status = response.status; throw error; }
      return await response.json();
    } finally { clearTimeout(timer); }
  };
  try {
    await status('syncing', '正在同步…');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const repository = await request('');
      if (repository.private !== true || repository.owner?.type !== 'User') throw new Error('同步仅支持个人已有的私有仓库，未上传任何资料。');
      let remote = { format: SYNC_FORMAT, version: 1, records: {} }; let sha;
      let file;
      try { file = await request(`/contents/${SYNC_PATH}`); } catch (error) { if (error.status !== 404) throw error; }
      if (file) {
        sha = file.sha;
        if (!string(sha, 128) || !/^[A-Za-z0-9]+$/.test(sha) || !Number.isFinite(file.size) || file.size < 0) invalid();
        if (file.size > SYNC_LIMIT) throw new Error('同步文件超过 15 MiB，请缩减资料库后重试。');
        const blob = file.content ? file : await request(`/git/blobs/${sha}`);
        if (!string(blob.content, Math.ceil(SYNC_LIMIT * 1.5))) invalid();
        const decoded = decode(blob.content);
        if (new TextEncoder().encode(decoded).length > SYNC_LIMIT) throw new Error('同步文件超过 15 MiB，请缩减资料库后重试。');
        remote = validateSyncDocument(JSON.parse(decoded));
      }
      const database = await loadDatabase(storage);
      if (isReadOnlyDatabase(database)) throw new Error('资料库为只读，未进行同步。');
      const local = await libraryRecords(database, readPackage);
      const base = database.syncLedger?.repository === config.repository ? database.syncLedger.records : {};
      const merged = mergeLibrary(local, remote.records, base, [...(database.syncWithdrawals ?? []), ...database.assets.filter((a) => a.privacy === 'private').map((a) => a.id)]);
      const document = validateSyncDocument({ format: SYNC_FORMAT, version: 1, records: merged.records });
      const payload = JSON.stringify(document);
      if (new TextEncoder().encode(payload).length > SYNC_LIMIT) throw new Error('同步文件超过 15 MiB（含 Skill 文件），本地保存仍可使用。');
      try {
        await withDatabaseWriteLock(storage, async () => {
        // Recheck privacy immediately before each upload; retain ordinary Git history.
        const latestBeforeUpload = await loadDatabase(storage);
        if (latestBeforeUpload.revision !== database.revision) { const error = new Error('资料库正在编辑，请稍后重试同步。'); error.status = 409; throw error; }
        const verified = await request('');
        if (verified.private !== true || verified.owner?.type !== 'User') throw new Error('仓库已不是个人私有仓库，已停止上传。');
        if (!same(remote.records, merged.records)) await request(`/contents/${SYNC_PATH}`, { method: 'PUT', body: JSON.stringify({ message: 'Sync FutureContext normal library', content: encode(payload), ...(sha ? { sha } : {}) }), headers: { 'Content-Type': 'application/json' } });
        }, { locks });
      } catch (error) { if ([409, 422].includes(error.status) && attempt < 2) continue; throw error; }
      await assertCurrent();
      let finalConflicts = merged.conflicts; let privateConflictCount = merged.privateConflicts.length;
      const saved = await applyDatabaseChange(async (latest) => {
        await assertCurrent();
        for (const asset of latest.assets) if (asset.skillPackage?.packageId) packageCandidates.add(asset.skillPackage.packageId);
        const current = await libraryRecords(latest, readPackage);
        const pulled = mergeLibrary(current, merged.records, local, [...(latest.syncWithdrawals ?? []), ...latest.assets.filter((a) => a.privacy === 'private').map((a) => a.id)]);
        finalConflicts += pulled.conflicts; privateConflictCount += pulled.privateConflicts.length;
        for (const record of Object.values(pulled.records)) if (record.value?.package) {
          const asset = record.value;
          if (latest.assets.some((item) => item.skillPackage?.packageId === packageIdFor(asset))) continue;
          packageCandidates.add(packageIdFor(asset));
          await writePackage({ id: packageIdFor(asset), files: asset.package.files, source: asset.package.source });
        }
        await assertCurrent();
        const next = applyLibrary(latest, pulled.records, [...merged.privateConflicts, ...pulled.privateConflicts]);
        next.syncLedger = { repository: config.repository, records: merged.records };
        return same(next, latest) ? null : next;
      }, storage, { locks });
      if (!saved) throw new Error('资料库为只读，未应用远端资料。');
      await status('success', privateConflictCount ? '同步完成，撤回条目的离线编辑已保留到本机私密库' : finalConflicts ? `同步完成，已保留 ${finalConflicts} 项冲突副本` : '同步完成', { lastSyncedAt: Date.now(), conflicts: finalConflicts });
      return syncSettings(storage);
    }
  } catch (error) {
    try { const latest = (await storage.get(SYNC_CONFIG_KEY))[SYNC_CONFIG_KEY]; if (same(config, latest)) await storage.set({ [SYNC_STATUS_KEY]: { state: 'error', message: signal.aborted ? '同步已取消或网络超时，请重试；本地保存仍可使用。' : error.message } }); } catch { /* New config owns status. */ }
    throw error;
  } finally {
    await cleanupPackageCandidates([...packageCandidates], { storage, removePackage, locks });
    cancellation = null;
  }
}
export async function scheduleLibrarySync({ changed = false, storage = chrome.storage.local, alarms = chrome.alarms } = {}) {
  const config = (await storage.get(SYNC_CONFIG_KEY))[SYNC_CONFIG_KEY];
  if (config?.enabled && config.automatic !== false) {
    await alarms.create(changed ? SYNC_DEBOUNCE_ALARM : SYNC_ALARM, changed ? { delayInMinutes: 0.5 } : { periodInMinutes: 5 });
  } else { await alarms.clear(SYNC_ALARM); await alarms.clear(SYNC_DEBOUNCE_ALARM); }
}
export function relevantLibraryChange(oldValue, newValue) {
  const project = (db) => ({ assets: (db?.assets ?? []).filter((a) => a.privacy === 'normal').map((a) => ({ ...pick(a, ASSET_FIELDS), skillPackage: a.skillPackage ? pick(a.skillPackage, ['packageId', 'source']) : null })), categories: (db?.categories ?? []).filter((c) => CATEGORY_SCOPES.includes(c.scope)).map((c) => pick(c, CATEGORY_FIELDS)) });
  return !same(project(oldValue), project(newValue));
}
