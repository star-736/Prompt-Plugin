export const APP_STORAGE_KEY = 'futurecontext.v1';
export const BACKUP_FORMAT = 'futurecontext.backup';
export const ASSET_TYPES = Object.freeze(['generic', 'skill', 'aigc']);
export const CATEGORY_SCOPES = Object.freeze(['generic', 'skill', 'aigc-normal']);

const encoder = new TextEncoder();

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `fc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clone(value) {
  return structuredClone(value);
}

function normalizedName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function categoryKey(scope, name) {
  return `${scope}:${normalizedName(name).toLocaleLowerCase()}`;
}

function isPrivacy(value) {
  return value === 'normal' || value === 'private';
}

function ensureScope(scope) {
  if (!CATEGORY_SCOPES.includes(scope)) throw new Error('不支持的分类区域。');
}

export function scopeFor(type, privacy = 'normal') {
  if (!ASSET_TYPES.includes(type)) throw new Error('不支持的资产类型。');
  if (!isPrivacy(privacy)) throw new Error('不支持的资料库。');
  if (privacy === 'private' && type !== 'aigc') throw new Error('只有 AIGC Prompt 可以存入私密库。');
  return privacy === 'private' ? 'aigc-private' : type === 'aigc' ? 'aigc-normal' : type;
}

export function createEmptyDatabase() {
  return {
    version: 1,
    lock: { passwordDigest: null },
    settings: { lastNormalTab: 'generic' },
    assets: [],
    categories: [],
    drafts: {}
  };
}

export function normalizeDatabase(value) {
  const empty = createEmptyDatabase();
  if (!value || typeof value !== 'object' || value.version !== 1) return empty;
  return {
    ...empty,
    ...value,
    lock: { ...empty.lock, ...(value.lock ?? {}) },
    settings: { ...empty.settings, ...(value.settings ?? {}) },
    assets: Array.isArray(value.assets) ? value.assets : [],
    categories: Array.isArray(value.categories) ? value.categories : [],
    drafts: value.drafts && typeof value.drafts === 'object' ? value.drafts : {}
  };
}

export async function digestPassword(password, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw new Error('浏览器不支持密码校验所需的加密能力。');
  const digest = await cryptoApi.subtle.digest('SHA-256', encoder.encode(password));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function setPrivacyPassword(database, password, cryptoApi = globalThis.crypto) {
  if (String(password).length < 6) throw new Error('密码至少需要 6 位。');
  const next = clone(database);
  next.lock.passwordDigest = await digestPassword(password, cryptoApi);
  return next;
}

export function hasPrivacyLock(database) {
  return Boolean(database.lock?.passwordDigest);
}

export async function verifyPrivacyPassword(database, password, cryptoApi = globalThis.crypto) {
  if (!hasPrivacyLock(database)) return false;
  return (await digestPassword(password, cryptoApi)) === database.lock.passwordDigest;
}

export function parseSkillMetadata(content) {
  const source = String(content ?? '').replace(/^\uFEFF/, '');
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) throw new Error('Skill 必须以 YAML frontmatter 开头。');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.+?)\s*$/);
    if (!field) continue;
    fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  if (!fields.name) throw new Error('Skill 缺少 YAML 中的 name。');
  if (!fields.description) throw new Error('Skill 缺少 YAML 中的 description。');
  return { name: fields.name, description: fields.description };
}

export function displayTitle(asset) {
  if (asset.title?.trim()) return asset.title.trim();
  const firstLine = String(asset.content ?? '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  return firstLine.length > 32 ? `${firstLine.slice(0, 32)}…` : firstLine || '未命名 AIGC Prompt';
}

export function validateAsset(input) {
  const type = input.type;
  const privacy = input.privacy ?? 'normal';
  scopeFor(type, privacy);
  const title = normalizedName(input.title);
  const content = String(input.content ?? '');
  if (!content.trim()) throw new Error('内容不能为空。');
  if (type === 'generic' && !title) throw new Error('通用 Prompt 需要标题。');
  const metadata = type === 'skill' ? parseSkillMetadata(content) : null;
  return {
    type,
    privacy,
    title: type === 'skill' ? metadata.name : title,
    content,
    categoryId: privacy === 'private' ? null : input.categoryId || null,
    skillDescription: metadata?.description ?? null
  };
}

export function saveAsset(database, input, { now = Date.now(), id = newId() } = {}) {
  const next = clone(database);
  const validated = validateAsset(input);
  const existingIndex = input.id ? next.assets.findIndex((asset) => asset.id === input.id) : -1;
  if (input.id && existingIndex === -1) throw new Error('找不到要更新的条目。');
  const asset = {
    ...(existingIndex >= 0 ? next.assets[existingIndex] : { id, createdAt: now }),
    ...validated,
    updatedAt: now
  };
  if (existingIndex >= 0) next.assets[existingIndex] = asset;
  else next.assets.push(asset);
  delete next.drafts[draftKey({ type: asset.type, privacy: asset.privacy, id: input.id || null })];
  return { database: next, asset };
}

export function removeAsset(database, id) {
  const next = clone(database);
  const asset = next.assets.find((item) => item.id === id);
  if (!asset) throw new Error('找不到要删除的条目。');
  next.assets = next.assets.filter((item) => item.id !== id);
  delete next.drafts[draftKey({ type: asset.type, privacy: asset.privacy, id })];
  return next;
}

export function moveAigcAsset(database, id, privacy, now = Date.now()) {
  if (!isPrivacy(privacy)) throw new Error('不支持的目标资料库。');
  const next = clone(database);
  const index = next.assets.findIndex((asset) => asset.id === id);
  if (index < 0 || next.assets[index].type !== 'aigc') throw new Error('只有 AIGC Prompt 可以在资料库间移动。');
  next.assets[index] = { ...next.assets[index], privacy, categoryId: null, updatedAt: now };
  return next;
}

export function assetsFor(database, { type, privacy = 'normal', query = '', categoryId = null }) {
  const needle = String(query).trim().toLocaleLowerCase();
  return database.assets
    .filter((asset) => asset.type === type && asset.privacy === privacy)
    .filter((asset) => !categoryId || asset.categoryId === categoryId)
    .filter((asset) => !needle || `${displayTitle(asset)}\n${asset.content}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function categoriesFor(database, scope) {
  ensureScope(scope);
  return database.categories
    .filter((category) => category.scope === scope)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export function createCategory(database, scope, name, { now = Date.now(), id = newId() } = {}) {
  ensureScope(scope);
  const cleanName = normalizedName(name);
  if (!cleanName) throw new Error('请输入分类名称。');
  if (cleanName.length > 40) throw new Error('分类名称不能超过 40 个字符。');
  const next = clone(database);
  if (next.categories.some((category) => categoryKey(category.scope, category.name) === categoryKey(scope, cleanName))) throw new Error('该分类已存在。');
  const category = { id, scope, name: cleanName, createdAt: now };
  next.categories.push(category);
  return { database: next, category };
}

export function renameCategory(database, id, name) {
  const next = clone(database);
  const index = next.categories.findIndex((category) => category.id === id);
  if (index < 0) throw new Error('找不到该分类。');
  const cleanName = normalizedName(name);
  if (!cleanName) throw new Error('请输入分类名称。');
  const category = next.categories[index];
  if (next.categories.some((item) => item.id !== id && categoryKey(item.scope, item.name) === categoryKey(category.scope, cleanName))) throw new Error('该分类已存在。');
  next.categories[index] = { ...category, name: cleanName };
  return next;
}

export function deleteCategory(database, id) {
  const next = clone(database);
  if (!next.categories.some((category) => category.id === id)) throw new Error('找不到该分类。');
  next.categories = next.categories.filter((category) => category.id !== id);
  next.assets = next.assets.map((asset) => asset.categoryId === id ? { ...asset, categoryId: null } : asset);
  return next;
}

export function categoryUsage(database, id) {
  return database.assets.filter((asset) => asset.categoryId === id).length;
}

export function draftKey({ type, privacy = 'normal', id = null }) {
  return `${type}:${privacy}:${id ?? 'new'}`;
}

export function getDraft(database, reference) {
  return database.drafts[draftKey(reference)] ?? null;
}

export function saveDraft(database, reference, values, now = Date.now()) {
  const next = clone(database);
  next.drafts[draftKey(reference)] = { ...values, updatedAt: now };
  return next;
}

export function discardDraft(database, reference) {
  const next = clone(database);
  delete next.drafts[draftKey(reference)];
  return next;
}

function categoryNameMap(database) {
  return new Map(database.categories.map((category) => [category.id, category.name]));
}

function assetFingerprint(asset, categoryNames) {
  return JSON.stringify([asset.type, asset.privacy, asset.title, asset.content, categoryNames.get(asset.categoryId) ?? '']);
}

export function createBackup(database, now = Date.now()) {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: now,
    categories: clone(database.categories),
    assets: clone(database.assets)
  };
}

export function parseBackup(value) {
  const backup = typeof value === 'string' ? JSON.parse(value) : value;
  if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== 1 || !Array.isArray(backup.assets) || !Array.isArray(backup.categories)) {
    throw new Error('这不是 FutureContext 的有效备份文件。');
  }
  return backup;
}

export function mergeBackup(database, backupValue, { now = Date.now(), idFactory = newId } = {}) {
  const backup = parseBackup(backupValue);
  const next = clone(database);
  const categoryIds = new Map();
  const knownCategories = new Map(next.categories.map((category) => [categoryKey(category.scope, category.name), category]));
  for (const category of backup.categories) {
    if (!CATEGORY_SCOPES.includes(category.scope) || !normalizedName(category.name)) continue;
    const key = categoryKey(category.scope, category.name);
    let target = knownCategories.get(key);
    if (!target) {
      target = { id: idFactory(), scope: category.scope, name: normalizedName(category.name), createdAt: now };
      next.categories.push(target);
      knownCategories.set(key, target);
    }
    categoryIds.set(category.id, target.id);
  }
  const existingNames = categoryNameMap(next);
  const fingerprints = new Set(next.assets.map((asset) => assetFingerprint(asset, existingNames)));
  let imported = 0;
  let skipped = 0;
  for (const source of backup.assets) {
    try {
      const categoryId = source.privacy === 'private' ? null : (categoryIds.get(source.categoryId) ?? null);
      const asset = validateAsset({ ...source, categoryId });
      const fingerprint = assetFingerprint(asset, categoryNameMap(next));
      if (fingerprints.has(fingerprint)) {
        skipped += 1;
        continue;
      }
      next.assets.push({ ...asset, id: idFactory(), createdAt: source.createdAt ?? now, updatedAt: source.updatedAt ?? now });
      fingerprints.add(fingerprint);
      imported += 1;
    } catch {
      skipped += 1;
    }
  }
  return { database: next, imported, skipped };
}

export async function loadDatabase(storage = chrome.storage.local) {
  const result = await storage.get(APP_STORAGE_KEY);
  return normalizeDatabase(result[APP_STORAGE_KEY]);
}

export async function saveDatabase(database, storage = chrome.storage.local) {
  await storage.set({ [APP_STORAGE_KEY]: database });
}
