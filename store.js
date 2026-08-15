export const APP_STORAGE_KEY = 'futurecontext.v1';
export const BACKUP_FORMAT = 'futurecontext.backup';
export const ASSET_TYPES = Object.freeze(['generic', 'skill', 'aigc']);
export const CATEGORY_SCOPES = Object.freeze(['generic', 'skill', 'aigc-normal']);
export const DEFAULT_AI_THRESHOLDS = Object.freeze({ uncategorized: 7, restructureChanges: 7, restructureDays: 14 });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clone = (value) => structuredClone(value);
const normalizedName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const categoryKey = (scope, name) => `${scope}:${normalizedName(name).toLocaleLowerCase()}`;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `fc-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function ensureScope(scope) { if (!CATEGORY_SCOPES.includes(scope)) throw new Error('不支持的分类区域。'); }
function base64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}
function fromBase64(value) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function randomBytes(length, cryptoApi = globalThis.crypto) { const value = new Uint8Array(length); cryptoApi.getRandomValues(value); return value; }
function normalizeAi(ai) {
  return {
    enabled: false, activeProviderId: null, providers: [], queue: [], proposals: [],
    status: { state: 'idle', message: '' }, thresholds: { ...DEFAULT_AI_THRESHOLDS },
    lastRestructureAt: null, changeCountSinceRestructure: 0, ...(ai ?? {}),
    thresholds: { ...DEFAULT_AI_THRESHOLDS, ...(ai?.thresholds ?? {}) },
    providers: Array.isArray(ai?.providers) ? ai.providers : [], queue: Array.isArray(ai?.queue) ? ai.queue : [],
    proposals: Array.isArray(ai?.proposals) ? ai.proposals : [], status: { state: 'idle', message: '', ...(ai?.status ?? {}) }
  };
}

export function scopeFor(type, privacy = 'normal') {
  if (!ASSET_TYPES.includes(type)) throw new Error('不支持的资产类型。');
  if (!['normal', 'private'].includes(privacy)) throw new Error('不支持的资料库。');
  if (privacy === 'private' && type !== 'aigc') throw new Error('只有 AIGC Prompt 可以存入私密库。');
  return privacy === 'private' ? 'aigc-private' : type === 'aigc' ? 'aigc-normal' : type;
}

export function createEmptyDatabase() {
  return { version: 2, lock: { passwordDigest: null }, settings: { lastNormalTab: 'generic' }, ai: normalizeAi(), assets: [], categories: [], drafts: {} };
}

export function normalizeDatabase(value) {
  const empty = createEmptyDatabase();
  if (!value || typeof value !== 'object' || ![1, 2].includes(value.version)) return empty;
  return {
    ...empty, ...value, version: 2, lock: { ...empty.lock, ...(value.lock ?? {}) }, settings: { ...empty.settings, ...(value.settings ?? {}) }, ai: normalizeAi(value.ai),
    assets: Array.isArray(value.assets) ? value.assets : [], categories: Array.isArray(value.categories) ? value.categories : [], drafts: value.drafts && typeof value.drafts === 'object' ? value.drafts : {}
  };
}

export async function digestPassword(password, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw new Error('浏览器不支持密码校验所需的加密能力。');
  const digest = await cryptoApi.subtle.digest('SHA-256', encoder.encode(password));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function setPrivacyPassword(database, password, cryptoApi = globalThis.crypto) {
  if (String(password).length < 6) throw new Error('密码至少需要 6 位。');
  const next = normalizeDatabase(clone(database));
  next.lock.passwordDigest = await digestPassword(password, cryptoApi);
  next.ai = normalizeAi({ ...next.ai, providers: [], activeProviderId: null, queue: [], status: { state: 'idle', message: '' } });
  return next;
}
export function hasPrivacyLock(database) { return Boolean(database.lock?.passwordDigest); }
export async function verifyPrivacyPassword(database, password, cryptoApi = globalThis.crypto) { return hasPrivacyLock(database) && (await digestPassword(password, cryptoApi)) === database.lock.passwordDigest; }

async function encryptionKey(password, salt, cryptoApi = globalThis.crypto) {
  const material = await cryptoApi.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return cryptoApi.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptProviderKey(password, apiKey, cryptoApi = globalThis.crypto) {
  if (!String(apiKey ?? '').trim()) throw new Error('请输入 API Key。');
  const salt = randomBytes(16, cryptoApi); const iv = randomBytes(12, cryptoApi);
  const key = await encryptionKey(password, salt, cryptoApi);
  const cipher = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(apiKey));
  return { algorithm: 'AES-GCM/PBKDF2-SHA-256', salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(cipher)) };
}
export async function decryptProviderKey(password, secret, cryptoApi = globalThis.crypto) {
  if (!secret?.salt || !secret?.iv || !secret?.ciphertext) throw new Error('找不到加密的 API Key。');
  try {
    const key = await encryptionKey(password, fromBase64(secret.salt), cryptoApi);
    const plain = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(secret.iv) }, key, fromBase64(secret.ciphertext));
    return decoder.decode(plain);
  } catch { throw new Error('无法解锁 API Key，请检查隐私锁密码。'); }
}
export async function saveProviderConfig(database, providerInput, password, cryptoApi = globalThis.crypto) {
  if (!await verifyPrivacyPassword(database, password, cryptoApi)) throw new Error('隐私锁密码不正确。');
  const next = normalizeDatabase(clone(database));
  const input = { ...providerInput };
  if (!input.id) input.id = newId();
  if (!String(input.baseUrl ?? '').startsWith('https://')) throw new Error('Provider Base URL 必须是 HTTPS 地址。');
  if (!String(input.model ?? '').trim()) throw new Error('请输入 Model ID。');
  const existing = next.ai.providers.find((item) => item.id === input.id);
  const secret = String(input.apiKey ?? '').trim() ? await encryptProviderKey(password, input.apiKey, cryptoApi) : (input.secret ?? existing?.secret);
  if (!secret) throw new Error('请输入 API Key。');
  const provider = { id: input.id, kind: input.kind ?? 'custom', label: normalizedName(input.label) || 'Provider', baseUrl: String(input.baseUrl).replace(/\/+$/, ''), model: String(input.model).trim(), secret, createdAt: input.createdAt ?? Date.now(), updatedAt: Date.now() };
  const index = next.ai.providers.findIndex((item) => item.id === provider.id);
  if (index >= 0) next.ai.providers[index] = provider; else next.ai.providers.push(provider);
  if (!next.ai.activeProviderId) next.ai.activeProviderId = provider.id;
  return { database: next, provider: { ...provider, secret: undefined } };
}
export function removeProviderConfig(database, id) { const next = normalizeDatabase(clone(database)); next.ai.providers = next.ai.providers.filter((provider) => provider.id !== id); if (next.ai.activeProviderId === id) next.ai.activeProviderId = next.ai.providers[0]?.id ?? null; return next; }
export function activeProvider(database) { const next = normalizeDatabase(database); return next.ai.providers.find((provider) => provider.id === next.ai.activeProviderId) ?? null; }

export function parseSkillMetadata(content) {
  const source = String(content ?? '').replace(/^\uFEFF/, '');
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) throw new Error('Skill 必须以 YAML frontmatter 开头。');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) { const field = line.match(/^([A-Za-z][\w-]*):\s*(.+?)\s*$/); if (field) fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/, '$2').trim(); }
  if (!fields.name) throw new Error('Skill 缺少 YAML 中的 name。');
  if (!fields.description) throw new Error('Skill 缺少 YAML 中的 description。');
  return { name: fields.name, description: fields.description };
}
export function displayTitle(asset) {
  if (asset.type !== 'aigc' && asset.title?.trim()) return asset.title.trim();
  const first = String(asset.content ?? '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  const fallback = asset.type === 'aigc' ? '未命名 AIGC Prompt' : '未命名 Prompt';
  return first.length > 32 ? `${first.slice(0, 32)}…` : first || fallback;
}
export function validateAsset(input) {
  const type = input.type; const privacy = input.privacy ?? 'normal'; scopeFor(type, privacy);
  const content = String(input.content ?? ''); if (!content.trim()) throw new Error('内容不能为空。');
  const metadata = type === 'skill' ? parseSkillMetadata(content) : null;
  return { type, privacy, title: type === 'skill' ? metadata.name : normalizedName(input.title), content, categoryId: type === 'aigc' || privacy === 'private' ? null : input.categoryId || null, skillDescription: metadata?.description ?? null };
}
function titleSource(existing, asset) { if (asset.type !== 'generic') return null; if (!existing) return asset.title ? 'manual' : 'none'; return asset.title === existing.title ? (existing.titleSource ?? (asset.title ? 'manual' : 'none')) : (asset.title ? 'manual' : 'none'); }
function categorySource(existing, asset) { if (!['generic', 'skill'].includes(asset.type)) return null; if (!existing) return asset.categoryId ? 'manual' : 'none'; return asset.categoryId === existing.categoryId ? (existing.categorySource ?? (asset.categoryId ? 'manual' : 'none')) : (asset.categoryId ? 'manual' : 'none'); }
function materiallyChanged(existing, asset) { return !existing || String(existing.content).trim() !== String(asset.content).trim(); }
function enqueueIfEligible(next, existing, asset, now) {
  if (!next.ai.enabled || !['generic', 'skill'].includes(asset.type) || !materiallyChanged(existing, asset)) return;
  next.ai.queue = next.ai.queue.filter((entry) => entry.assetId !== asset.id);
  next.ai.queue.push({ id: newId(), assetId: asset.id, assetType: asset.type, queuedAt: now }); next.ai.changeCountSinceRestructure += 1;
}

export function saveAsset(database, input, { now = Date.now(), id = newId() } = {}) {
  const next = normalizeDatabase(clone(database)); const validated = validateAsset(input);
  const existingIndex = input.id ? next.assets.findIndex((asset) => asset.id === input.id) : -1;
  if (input.id && existingIndex < 0) throw new Error('找不到要更新的条目。');
  const existing = existingIndex >= 0 ? next.assets[existingIndex] : null;
  const legacyAigc = existing?.type === 'aigc' ? { title: existing.title ?? '', categoryId: existing.categoryId ?? null } : null;
  const asset = { ...(existing ?? { id, createdAt: now }), ...validated, ...(legacyAigc ?? {}), titleSource: titleSource(existing, validated), categorySource: categorySource(existing, validated), updatedAt: now };
  if (existingIndex >= 0) next.assets[existingIndex] = asset; else next.assets.push(asset);
  enqueueIfEligible(next, existing, asset, now); delete next.drafts[draftKey({ type: asset.type, privacy: asset.privacy, id: input.id || null })];
  return { database: next, asset, queued: next.ai.queue.some((entry) => entry.assetId === asset.id) };
}
export function applyAiAssetResult(database, id, result, now = Date.now()) {
  const next = normalizeDatabase(clone(database)); const index = next.assets.findIndex((asset) => asset.id === id); if (index < 0) return next;
  const asset = next.assets[index]; if (!['generic', 'skill'].includes(asset.type) || asset.privacy !== 'normal') return next;
  const patch = {};
  if (asset.type === 'generic' && asset.titleSource !== 'manual' && !asset.title?.trim() && normalizedName(result.title)) { patch.title = normalizedName(result.title).slice(0, 120); patch.titleSource = 'ai'; }
  if (asset.categorySource !== 'manual' && !asset.categoryId && normalizedName(result.categoryName)) {
    const category = next.categories.find((item) => item.scope === asset.type && categoryKey(item.scope, item.name) === categoryKey(asset.type, result.categoryName));
    if (category) { patch.categoryId = category.id; patch.categorySource = 'ai'; }
  }
  if (Object.keys(patch).length) next.assets[index] = { ...asset, ...patch, updatedAt: now }; return next;
}
export function applyAiCategoryGroups(database, scope, groups, now = Date.now()) {
  ensureScope(scope); const next = normalizeDatabase(clone(database));
  for (const group of Array.isArray(groups) ? groups : []) {
    const name = normalizedName(group.name).slice(0, 40); if (!name) continue;
    let category = next.categories.find((item) => categoryKey(item.scope, item.name) === categoryKey(scope, name));
    if (!category) { category = { id: newId(), scope, name, createdAt: now, createdBy: 'ai' }; next.categories.push(category); }
    for (const assetId of group.assetIds ?? []) { const index = next.assets.findIndex((item) => item.id === assetId); const asset = next.assets[index]; if (asset && asset.type === scope && !asset.categoryId && asset.categorySource !== 'manual') next.assets[index] = { ...asset, categoryId: category.id, categorySource: 'ai', updatedAt: now }; }
  }
  return next;
}
export function addStructureProposal(database, proposal, now = Date.now()) { const next = normalizeDatabase(clone(database)); next.ai.proposals.unshift({ id: newId(), status: 'pending', createdAt: now, ...proposal }); return next; }
export function resolveStructureProposal(database, id, action = 'dismiss') {
  const next = normalizeDatabase(clone(database)); const proposal = next.ai.proposals.find((item) => item.id === id); if (!proposal || proposal.status !== 'pending') return next;
  if (action === 'apply') {
    for (const group of proposal.groups ?? []) {
      const targetName = normalizedName(group.to).slice(0, 40); if (!targetName) continue;
      let target = next.categories.find((category) => category.scope === proposal.scope && categoryKey(category.scope, category.name) === categoryKey(proposal.scope, targetName));
      if (!target) { target = { id: newId(), scope: proposal.scope, name: targetName, createdAt: Date.now(), createdBy: 'proposal' }; next.categories.push(target); }
      const fromIds = new Set(next.categories.filter((category) => category.scope === proposal.scope && (group.from ?? []).some((name) => categoryKey(proposal.scope, name) === categoryKey(category.scope, category.name))).map((category) => category.id));
      next.assets = next.assets.map((asset) => fromIds.has(asset.categoryId) ? { ...asset, categoryId: target.id, categorySource: 'proposal', updatedAt: Date.now() } : asset);
      next.categories = next.categories.filter((category) => !fromIds.has(category.id));
    }
  }
  proposal.status = action === 'apply' ? 'applied' : 'dismissed'; proposal.resolvedAt = Date.now(); return next;
}
export function updateStructureProposal(database, id, groups) { const next = normalizeDatabase(clone(database)); const proposal = next.ai.proposals.find((item) => item.id === id); if (!proposal || proposal.status !== 'pending') throw new Error('找不到可调整的分类方案。'); proposal.groups = (groups ?? []).map((group) => ({ from: Array.from(new Set((group.from ?? []).map(normalizedName).filter(Boolean))), to: normalizedName(group.to).slice(0, 40) })).filter((group) => group.from.length && group.to); return next; }
export function updateAiSettings(database, patch) { const next = normalizeDatabase(clone(database)); next.ai = normalizeAi({ ...next.ai, ...patch, thresholds: { ...next.ai.thresholds, ...(patch.thresholds ?? {}) } }); return next; }

export function removeAsset(database, id) { const next = normalizeDatabase(clone(database)); const asset = next.assets.find((item) => item.id === id); if (!asset) throw new Error('找不到要删除的条目。'); next.assets = next.assets.filter((item) => item.id !== id); next.ai.queue = next.ai.queue.filter((entry) => entry.assetId !== id); delete next.drafts[draftKey({ type: asset.type, privacy: asset.privacy, id })]; return next; }
export function moveAigcAsset(database, id, privacy, now = Date.now()) { if (!['normal', 'private'].includes(privacy)) throw new Error('不支持的目标资料库。'); const next = normalizeDatabase(clone(database)); const index = next.assets.findIndex((asset) => asset.id === id); if (index < 0 || next.assets[index].type !== 'aigc') throw new Error('只有 AIGC Prompt 可以在资料库间移动。'); next.assets[index] = { ...next.assets[index], privacy, categoryId: null, updatedAt: now }; return next; }
export function assetsFor(database, { type, privacy = 'normal', query = '', categoryId = null }) { const needle = String(query).trim().toLocaleLowerCase(); return database.assets.filter((asset) => asset.type === type && asset.privacy === privacy).filter((asset) => type === 'aigc' || !categoryId || asset.categoryId === categoryId).filter((asset) => !needle || `${displayTitle(asset)}\n${asset.content}`.toLocaleLowerCase().includes(needle)).sort((a, b) => b.updatedAt - a.updatedAt); }
export function categoriesFor(database, scope) { ensureScope(scope); return database.categories.filter((category) => category.scope === scope).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')); }
export function createCategory(database, scope, name, { now = Date.now(), id = newId(), createdBy = 'human' } = {}) { ensureScope(scope); const cleanName = normalizedName(name); if (!cleanName) throw new Error('请输入分类名称。'); if (cleanName.length > 40) throw new Error('分类名称不能超过 40 个字符。'); const next = normalizeDatabase(clone(database)); if (next.categories.some((category) => categoryKey(category.scope, category.name) === categoryKey(scope, cleanName))) throw new Error('该分类已存在。'); const category = { id, scope, name: cleanName, createdAt: now, createdBy }; next.categories.push(category); return { database: next, category }; }
export function renameCategory(database, id, name) { const next = normalizeDatabase(clone(database)); const index = next.categories.findIndex((category) => category.id === id); if (index < 0) throw new Error('找不到该分类。'); const cleanName = normalizedName(name); if (!cleanName) throw new Error('请输入分类名称。'); const category = next.categories[index]; if (next.categories.some((item) => item.id !== id && categoryKey(item.scope, item.name) === categoryKey(category.scope, cleanName))) throw new Error('该分类已存在。'); next.categories[index] = { ...category, name: cleanName }; return next; }
export function deleteCategory(database, id) { const next = normalizeDatabase(clone(database)); if (!next.categories.some((category) => category.id === id)) throw new Error('找不到该分类。'); next.categories = next.categories.filter((category) => category.id !== id); next.assets = next.assets.map((asset) => asset.categoryId === id ? { ...asset, categoryId: null, categorySource: 'none' } : asset); return next; }
export const categoryUsage = (database, id) => database.assets.filter((asset) => asset.categoryId === id).length;
export const draftKey = ({ type, privacy = 'normal', id = null }) => `${type}:${privacy}:${id ?? 'new'}`;
export const getDraft = (database, reference) => database.drafts[draftKey(reference)] ?? null;
export function saveDraft(database, reference, values, now = Date.now()) { const next = normalizeDatabase(clone(database)); next.drafts[draftKey(reference)] = { ...values, updatedAt: now }; return next; }
export function discardDraft(database, reference) { const next = normalizeDatabase(clone(database)); delete next.drafts[draftKey(reference)]; return next; }

function categoryNameMap(database) { return new Map(database.categories.map((category) => [category.id, category.name])); }
function assetFingerprint(asset, names) { return JSON.stringify([asset.type, asset.privacy, asset.title, asset.content, names.get(asset.categoryId) ?? '', asset.skillPackage?.source?.repository ?? '']); }
export function createBackup(database, now = Date.now(), packages = []) { return { format: BACKUP_FORMAT, version: 2, exportedAt: now, categories: clone(database.categories), assets: clone(database.assets), packages: clone(packages) }; }
export function parseBackup(value) { const backup = typeof value === 'string' ? JSON.parse(value) : value; if (!backup || backup.format !== BACKUP_FORMAT || ![1, 2].includes(backup.version) || !Array.isArray(backup.assets) || !Array.isArray(backup.categories)) throw new Error('这不是 FutureContext 的有效备份文件。'); return { ...backup, packages: Array.isArray(backup.packages) ? backup.packages : [] }; }
export function mergeBackup(database, backupValue, { now = Date.now(), idFactory = newId } = {}) {
  const backup = parseBackup(backupValue); const next = normalizeDatabase(clone(database)); const categoryIds = new Map(); const known = new Map(next.categories.map((category) => [categoryKey(category.scope, category.name), category]));
  for (const category of backup.categories) { if (!CATEGORY_SCOPES.includes(category.scope) || !normalizedName(category.name)) continue; const key = categoryKey(category.scope, category.name); let target = known.get(key); if (!target) { target = { id: idFactory(), scope: category.scope, name: normalizedName(category.name), createdAt: now, createdBy: category.createdBy ?? 'human' }; next.categories.push(target); known.set(key, target); } categoryIds.set(category.id, target.id); }
  const fingerprints = new Set(next.assets.map((asset) => assetFingerprint(asset, categoryNameMap(next)))); const packageImports = []; let imported = 0; let skipped = 0;
  for (const source of backup.assets) try { const categoryId = source.type === 'aigc' || source.privacy === 'private' ? source.categoryId ?? null : (categoryIds.get(source.categoryId) ?? null); const asset = validateAsset({ ...source, categoryId }); const candidate = { ...asset, title: source.type === 'aigc' ? (source.title ?? '') : asset.title, categoryId: source.type === 'aigc' ? (source.categoryId ?? null) : asset.categoryId, skillPackage: source.skillPackage ?? null }; const fingerprint = assetFingerprint(candidate, categoryNameMap(next)); if (fingerprints.has(fingerprint)) { skipped += 1; continue; } if (candidate.skillPackage?.packageId) { const targetPackageId = idFactory(); packageImports.push({ sourcePackageId: candidate.skillPackage.packageId, targetPackageId }); candidate.skillPackage = { ...candidate.skillPackage, packageId: targetPackageId }; } next.assets.push({ ...candidate, id: idFactory(), createdAt: source.createdAt ?? now, updatedAt: source.updatedAt ?? now, titleSource: source.titleSource ?? (candidate.title ? 'manual' : 'none'), categorySource: source.categorySource ?? (candidate.categoryId ? 'manual' : 'none') }); fingerprints.add(fingerprint); imported += 1; } catch { skipped += 1; }
  return { database: next, imported, skipped, packages: backup.packages, packageImports };
}
export function saveGithubSkillAsset(database, packageInfo, { now = Date.now(), id = newId(), updateAssetId = null } = {}) {
  const next = normalizeDatabase(clone(database)); const metadata = parseSkillMetadata(packageInfo.skillContent); const source = packageInfo.source;
  const duplicate = next.assets.find((asset) => asset.type === 'skill' && asset.skillPackage?.source?.repository === source.repository && asset.skillPackage?.source?.directory === source.directory && asset.skillPackage?.source?.commit === source.commit);
  if (duplicate && duplicate.id !== updateAssetId) return { database: next, asset: duplicate, duplicate: true };
  const index = updateAssetId ? next.assets.findIndex((asset) => asset.id === updateAssetId) : -1; if (updateAssetId && index < 0) throw new Error('找不到要更新的 Skill。'); const current = index >= 0 ? next.assets[index] : null;
  const asset = { ...(current ?? { id, createdAt: now, categoryId: null, categorySource: 'none' }), type: 'skill', privacy: 'normal', title: metadata.name, content: packageInfo.skillContent, skillDescription: metadata.description, skillPackage: { packageId: packageInfo.id, source, fileCount: packageInfo.fileCount, totalSize: packageInfo.totalSize }, updatedAt: now };
  if (index >= 0) next.assets[index] = asset; else next.assets.push(asset); return { database: next, asset, duplicate: false };
}
export async function loadDatabase(storage = chrome.storage.local) { const result = await storage.get(APP_STORAGE_KEY); return normalizeDatabase(result[APP_STORAGE_KEY]); }
export async function saveDatabase(database, storage = chrome.storage.local) { await storage.set({ [APP_STORAGE_KEY]: normalizeDatabase(database) }); }
