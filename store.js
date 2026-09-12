import { DEFAULT_PALETTE_TYPES } from './in-place.js';
import { assertPackageLimits } from './package-store.js';

export const APP_STORAGE_KEY = 'futurecontext.v1';
export const BACKUP_FORMAT = 'futurecontext.backup';
export const ASSET_TYPES = Object.freeze(['generic', 'skill', 'aigc', 'command']);
export const CATEGORY_SCOPES = Object.freeze(['generic', 'skill', 'aigc-normal', 'command']);
export const DEFAULT_AI_THRESHOLDS = Object.freeze({ uncategorized: 7, restructureChanges: 7, restructureDays: 14 });
export const CURRENT_DATABASE_VERSION = 2;
export const SORT_OPTIONS = Object.freeze({ updated: '最近编辑', lastUsed: '最近取用', mostUsed: '最常取用' });
export const USAGE_LOG_DAYS = 90;
export const CAPTURE_LIMIT = 100000;
export const SAVE_CONFLICT_ATTEMPTS = 8;

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

function normalizeInPlace(inPlace) {
  const sites = Array.isArray(inPlace?.sites) ? inPlace.sites.filter((site) => typeof site === 'string') : [];
  const ignoredSites = Array.isArray(inPlace?.ignoredSites) ? inPlace.ignoredSites.filter((site) => typeof site === 'string') : [];
  return { enabled: inPlace?.enabled !== false, triggerEnabled: inPlace?.triggerEnabled !== false, sites, ignoredSites };
}
function normalizeSettings(settings) {
  const sortBy = settings?.sortBy && typeof settings.sortBy === 'object' ? settings.sortBy : {};
  return { lastNormalTab: 'generic', ...(settings ?? {}), sortBy: Object.fromEntries(Object.entries(sortBy).filter(([, value]) => value in SORT_OPTIONS)), inPlace: normalizeInPlace(settings?.inPlace) };
}
function normalizeUsage(usage) { return { log: Array.isArray(usage?.log) ? usage.log.filter((time) => Number.isFinite(time)) : [] }; }
function normalizeAsset(asset) {
  const useCount = Number(asset.useCount); const lastUsedAt = Number(asset.lastUsedAt);
  return { ...asset, useCount: Number.isFinite(useCount) && useCount > 0 ? Math.floor(useCount) : 0, lastUsedAt: Number.isFinite(lastUsedAt) && lastUsedAt > 0 ? lastUsedAt : null, pinned: asset.privacy === 'normal' && asset.pinned === true };
}

export function databaseRevision(database) {
  const revision = Number(database?.revision);
  return Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 0;
}

export function createEmptyDatabase() {
  return { version: CURRENT_DATABASE_VERSION, revision: 0, lock: { passwordDigest: null }, settings: normalizeSettings(), ai: normalizeAi(), usage: normalizeUsage(), assets: [], categories: [], drafts: {} };
}

// 比当前代码更新的版本号不会被当成空库：数据原样保留、只读，等待用户升级扩展（ADR 0006）。
export function isReadOnlyDatabase(database) { return Number(database?.version) > CURRENT_DATABASE_VERSION; }

export function normalizeDatabase(value) {
  const empty = createEmptyDatabase();
  const newer = value && typeof value === 'object' && isReadOnlyDatabase(value);
  if (!value || typeof value !== 'object' || (![1, 2].includes(value.version) && !newer)) return empty;
  return {
    ...empty, ...value, version: newer ? value.version : CURRENT_DATABASE_VERSION, revision: databaseRevision(value), lock: { ...empty.lock, ...(value.lock ?? {}) }, settings: normalizeSettings(value.settings), ai: normalizeAi(value.ai), usage: normalizeUsage(value.usage),
    assets: Array.isArray(value.assets) ? value.assets.map(normalizeAsset) : [], categories: Array.isArray(value.categories) ? value.categories : [], drafts: value.drafts && typeof value.drafts === 'object' ? value.drafts : {}
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

// 仅取用/复制时加前缀，不写入存储。空前缀不加换行；空内容沿用原样（插入侧会跳过）。
export const SKILL_INSERT_PREFIX = '基于以下 skill 辅助我解决问题';
export function formatSkillInsert(text, type) {
  const content = String(text ?? '');
  if (type !== 'skill' || !content || !SKILL_INSERT_PREFIX) return content;
  return `${SKILL_INSERT_PREFIX}\n${content}`;
}
// 取用/复制载荷只用正文。标题留在面板搜索与展示，不拼进插入文本。
export function formatPaletteInsert(asset) {
  return formatSkillInsert(asset?.content ?? '', asset?.type);
}
export function validateAsset(input, database = null) {
  const type = input.type; const privacy = input.privacy ?? 'normal'; const scope = scopeFor(type, privacy);
  const content = String(input.content ?? ''); if (!content.trim()) throw new Error('内容不能为空。');
  const metadata = type === 'skill' ? parseSkillMetadata(content) : null;
  const categoryId = type === 'aigc' || privacy === 'private' ? null : input.categoryId || null;
  if (categoryId && !database?.categories?.some((category) => category.id === categoryId && category.scope === scope)) throw new Error('找不到该分类。');
  return { type, privacy, title: type === 'skill' ? metadata.name : normalizedName(input.title), content, categoryId, skillDescription: metadata?.description ?? null };
}
function titleSource(existing, asset) { if (asset.type !== 'generic') return null; if (!existing) return asset.title ? 'manual' : 'none'; return asset.title === existing.title ? (existing.titleSource ?? (asset.title ? 'manual' : 'none')) : (asset.title ? 'manual' : 'none'); }
function categorySource(existing, asset) { if (!['generic', 'skill', 'command'].includes(asset.type)) return null; if (!existing) return asset.categoryId ? 'manual' : 'none'; return asset.categoryId === existing.categoryId ? (existing.categorySource ?? (asset.categoryId ? 'manual' : 'none')) : (asset.categoryId ? 'manual' : 'none'); }
function materiallyChanged(existing, asset) { return !existing || String(existing.content).trim() !== String(asset.content).trim(); }
function enqueueIfEligible(next, existing, asset, now) {
  if (!next.ai.enabled || !['generic', 'skill'].includes(asset.type) || !materiallyChanged(existing, asset)) return;
  next.ai.queue = next.ai.queue.filter((entry) => entry.assetId !== asset.id);
  next.ai.queue.push({ id: newId(), assetId: asset.id, assetType: asset.type, queuedAt: now }); next.ai.changeCountSinceRestructure += 1;
}

export function saveAsset(database, input, { now = Date.now(), id = newId() } = {}) {
  const next = normalizeDatabase(clone(database)); const validated = validateAsset(input, next);
  const existingIndex = input.id ? next.assets.findIndex((asset) => asset.id === input.id) : -1;
  if (input.id && existingIndex < 0) throw new Error('找不到要更新的条目。');
  const existing = existingIndex >= 0 ? next.assets[existingIndex] : null;
  const legacyAigc = existing?.type === 'aigc' ? { title: existing.title ?? '', categoryId: existing.categoryId ?? null } : null;
  const asset = { ...(existing ?? { id, createdAt: now, useCount: 0, lastUsedAt: null, pinned: false }), ...validated, ...(legacyAigc ?? {}), titleSource: titleSource(existing, validated), categorySource: categorySource(existing, validated), updatedAt: now };
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
export function moveAigcAsset(database, id, privacy, now = Date.now()) { if (!['normal', 'private'].includes(privacy)) throw new Error('不支持的目标资料库。'); const next = normalizeDatabase(clone(database)); const index = next.assets.findIndex((asset) => asset.id === id); if (index < 0 || next.assets[index].type !== 'aigc') throw new Error('只有 AIGC Prompt 可以在资料库间移动。'); next.assets[index] = { ...next.assets[index], privacy, categoryId: null, pinned: privacy === 'normal' && Boolean(next.assets[index].pinned), updatedAt: now }; return next; }

const sortComparators = {
  updated: (a, b) => b.updatedAt - a.updatedAt,
  lastUsed: (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.updatedAt - a.updatedAt,
  mostUsed: (a, b) => (b.useCount ?? 0) - (a.useCount ?? 0) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.updatedAt - a.updatedAt
};
function pinnedFirst(compare) { return (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || compare(a, b); }
export function assetsFor(database, { type, privacy = 'normal', query = '', categoryId = null, sortBy = 'updated' }) {
  const needle = String(query).trim().toLocaleLowerCase();
  const compare = sortComparators[privacy === 'private' ? 'updated' : sortBy] ?? sortComparators.updated;
  return database.assets.filter((asset) => asset.type === type && asset.privacy === privacy).filter((asset) => type === 'aigc' || !categoryId || asset.categoryId === categoryId).filter((asset) => !needle || `${displayTitle(asset)}\n${asset.content}`.toLocaleLowerCase().includes(needle)).sort(pinnedFirst(compare));
}
export function setSortBy(database, tab, sortBy) { if (!(sortBy in SORT_OPTIONS)) throw new Error('不支持的排序方式。'); const next = normalizeDatabase(clone(database)); next.settings.sortBy = { ...next.settings.sortBy, [tab]: sortBy }; return next; }
export function sortByFor(database, tab) { return database.settings?.sortBy?.[tab] ?? 'updated'; }

export function recordAssetUse(database, id, now = Date.now()) {
  const next = normalizeDatabase(clone(database)); const index = next.assets.findIndex((asset) => asset.id === id); if (index < 0) return next;
  next.assets[index] = { ...next.assets[index], useCount: (next.assets[index].useCount ?? 0) + 1, lastUsedAt: now };
  next.usage.log = [...next.usage.log.filter((time) => now - time <= USAGE_LOG_DAYS * 86400000), now];
  return next;
}
export function setAssetPinned(database, id, pinned) {
  const next = normalizeDatabase(clone(database)); const index = next.assets.findIndex((asset) => asset.id === id); if (index < 0) throw new Error('找不到该条目。');
  if (next.assets[index].privacy !== 'normal') throw new Error('私密库不提供置顶。');
  next.assets[index] = { ...next.assets[index], pinned: Boolean(pinned) }; return next;
}
export function setAssetCategory(database, id, categoryId, { now = Date.now() } = {}) {
  const next = normalizeDatabase(clone(database)); const index = next.assets.findIndex((asset) => asset.id === id); if (index < 0) throw new Error('找不到该条目。');
  const asset = next.assets[index];
  if (!['generic', 'skill', 'command'].includes(asset.type) || asset.privacy !== 'normal') throw new Error('只有普通库的 Prompt、Skill 和终端指令可以分类。');
  const nextCategoryId = categoryId || null;
  if (nextCategoryId && !next.categories.some((category) => category.id === nextCategoryId && category.scope === asset.type)) throw new Error('找不到该分类。');
  next.assets[index] = { ...asset, categoryId: nextCategoryId, categorySource: 'manual', updatedAt: now };
  return next;
}
export function usageSummary(database, now = Date.now()) {
  const log = database.usage?.log ?? []; const within = (days) => log.filter((time) => now - time <= days * 86400000).length;
  return { week: within(7), month: within(30), total: database.assets.reduce((sum, asset) => sum + (asset.useCount ?? 0), 0), sites: database.settings?.inPlace?.sites?.length ?? 0 };
}

// 取用面板：搜索普通库；私密库永不出现。types 缺省时只用聊天页默认类型（generic + skill），不含 command / aigc。
export function paletteAssets(database, query = '', limit = 8, { types } = {}) {
  const needle = String(query ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase(); const names = categoryNameMap(database);
  const allowed = new Set((Array.isArray(types) ? types : DEFAULT_PALETTE_TYPES).filter((type) => ASSET_TYPES.includes(type)));
  const scored = [];
  for (const asset of database.assets) {
    if (asset.privacy !== 'normal') continue;
    if (!allowed.has(asset.type)) continue;
    let score = 0;
    if (needle) {
      if (displayTitle(asset).toLocaleLowerCase().includes(needle)) score = 2;
      else if (`${asset.content}\n${asset.skillDescription ?? ''}\n${names.get(asset.categoryId) ?? ''}`.toLocaleLowerCase().includes(needle)) score = 1;
      else continue;
    }
    scored.push({ asset, score });
  }
  return scored.sort((a, b) => Number(Boolean(b.asset.pinned)) - Number(Boolean(a.asset.pinned)) || b.score - a.score || (b.asset.useCount ?? 0) - (a.asset.useCount ?? 0) || b.asset.updatedAt - a.asset.updatedAt).slice(0, limit).map((entry) => entry.asset);
}

// 就地保存：选中文字直接落为无标题、未分类的通用 Prompt。
export function captureSelection(database, text, { now = Date.now(), id = newId() } = {}) {
  const content = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('选中的文字为空，没有保存。');
  if (content.length > CAPTURE_LIMIT) throw new Error(`选中的文字超过 ${CAPTURE_LIMIT.toLocaleString('zh-CN')} 字符，没有保存。`);
  return saveAsset(database, { type: 'generic', title: '', content }, { now, id });
}

export function updateInPlaceSettings(database, patch) { const next = normalizeDatabase(clone(database)); next.settings.inPlace = normalizeInPlace({ ...next.settings.inPlace, ...patch }); return next; }
export function enableSite(database, origin) { const next = normalizeDatabase(clone(database)); const inPlace = next.settings.inPlace; if (!inPlace.sites.includes(origin)) inPlace.sites = [...inPlace.sites, origin]; inPlace.ignoredSites = inPlace.ignoredSites.filter((site) => site !== origin); return next; }
export function disableSite(database, origin) { const next = normalizeDatabase(clone(database)); next.settings.inPlace.sites = next.settings.inPlace.sites.filter((site) => site !== origin); return next; }
export function ignoreSite(database, origin) { const next = normalizeDatabase(clone(database)); const inPlace = next.settings.inPlace; if (!inPlace.ignoredSites.includes(origin)) inPlace.ignoredSites = [...inPlace.ignoredSites, origin]; return next; }
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
  for (const source of backup.assets) try { const categoryId = source.type === 'aigc' || source.privacy === 'private' ? source.categoryId ?? null : (categoryIds.get(source.categoryId) ?? null); const asset = validateAsset({ ...source, categoryId }, next); const candidate = { ...asset, title: source.type === 'aigc' ? (source.title ?? '') : asset.title, categoryId: source.type === 'aigc' ? (source.categoryId ?? null) : asset.categoryId, skillPackage: source.skillPackage ?? null }; const fingerprint = assetFingerprint(candidate, categoryNameMap(next)); if (fingerprints.has(fingerprint)) { skipped += 1; continue; } if (candidate.skillPackage?.packageId) { const targetPackageId = idFactory(); packageImports.push({ sourcePackageId: candidate.skillPackage.packageId, targetPackageId }); candidate.skillPackage = { ...candidate.skillPackage, packageId: targetPackageId }; } next.assets.push(normalizeAsset({ ...candidate, id: idFactory(), createdAt: source.createdAt ?? now, updatedAt: source.updatedAt ?? now, titleSource: source.titleSource ?? (candidate.title ? 'manual' : 'none'), categorySource: source.categorySource ?? (candidate.categoryId ? 'manual' : 'none'), useCount: source.useCount, lastUsedAt: source.lastUsedAt, pinned: source.pinned })); fingerprints.add(fingerprint); imported += 1; } catch { skipped += 1; }
  return { database: next, imported, skipped, packages: backup.packages, packageImports };
}
export function saveGithubSkillAsset(database, packageInfo, { now = Date.now(), id = newId(), updateAssetId = null } = {}) {
  const next = normalizeDatabase(clone(database)); const metadata = parseSkillMetadata(packageInfo.skillContent); const source = packageInfo.source;
  const duplicate = next.assets.find((asset) => asset.type === 'skill' && asset.skillPackage?.source?.repository === source.repository && asset.skillPackage?.source?.directory === source.directory && asset.skillPackage?.source?.commit === source.commit);
  if (duplicate && duplicate.id !== updateAssetId) return { database: next, asset: duplicate, duplicate: true, queued: false };
  const index = updateAssetId ? next.assets.findIndex((asset) => asset.id === updateAssetId) : -1; if (updateAssetId && index < 0) throw new Error('找不到要更新的 Skill。'); const current = index >= 0 ? next.assets[index] : null;
  const asset = { ...(current ?? { id, createdAt: now, categoryId: null, categorySource: 'none' }), type: 'skill', privacy: 'normal', title: metadata.name, content: packageInfo.skillContent, skillDescription: metadata.description, skillPackage: { packageId: packageInfo.id, source, fileCount: packageInfo.fileCount, totalSize: packageInfo.totalSize }, updatedAt: now };
  if (index >= 0) next.assets[index] = asset; else next.assets.push(asset);
  enqueueIfEligible(next, current, asset, now);
  return { database: next, asset, duplicate: false, queued: next.ai.queue.some((entry) => entry.assetId === asset.id) };
}
export async function loadDatabase(storage = chrome.storage.local) {
  const result = await storage.get?.(APP_STORAGE_KEY) ?? {};
  return normalizeDatabase(result[APP_STORAGE_KEY]);
}
export const READ_ONLY_MESSAGE = '数据来自更新版本的 FutureContext，请升级扩展。当前为只读，所有修改都不会保存。';
export const SAVE_CONFLICT_MESSAGE = '保存冲突，请重试。';
export async function saveDatabase(database, storage = chrome.storage.local) {
  if (isReadOnlyDatabase(database)) return false;
  const stored = await loadDatabase(storage);
  if (isReadOnlyDatabase(stored)) return false;
  if (databaseRevision(stored) !== databaseRevision(database)) return false;
  const next = normalizeDatabase(clone(database));
  next.revision = databaseRevision(stored) + 1;
  await storage.set({ [APP_STORAGE_KEY]: next });
  return true;
}

export async function applyDatabaseChange(mutator, storage = chrome.storage.local, { attempts = SAVE_CONFLICT_ATTEMPTS } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const current = await loadDatabase(storage);
    if (isReadOnlyDatabase(current)) return false;
    const produced = await mutator(current);
    if (produced == null) return true;
    const next = produced.database ?? produced;
    if (isReadOnlyDatabase(next)) return false;
    next.revision = databaseRevision(current);
    if (await saveDatabase(next, storage)) return true;
  }
  throw new Error(SAVE_CONFLICT_MESSAGE);
}

export function setLastNormalTab(database, tab) {
  const next = normalizeDatabase(clone(database));
  if (ASSET_TYPES.includes(tab)) next.settings.lastNormalTab = tab;
  return next;
}

export function hasPrivateAssets(database) {
  return (database?.assets ?? []).some((asset) => asset.privacy === 'private');
}

export function exportRequiresUnlock(database) {
  return hasPrivacyLock(database) && hasPrivateAssets(database);
}

async function rollbackPackages(ids, deletePackage) {
  for (const id of ids) {
    try { await deletePackage(id); } catch { /* 回滚尽力。 */ }
  }
}

export async function importBackupRecords(database, backupValue, { putPackage, deletePackage, persist, now = Date.now(), idFactory } = {}) {
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
    });
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

export async function commitGithubSkillPackage(database, packageRecord, { updateAssetId = null, putPackage, deletePackage, persist = saveDatabase } = {}) {
  assertWritableDatabase(database);
  const oldPackageId = updateAssetId ? database.assets.find((item) => item.id === updateAssetId)?.skillPackage?.packageId ?? null : null;
  await putPackage(packageRecord);
  const saved = saveGithubSkillAsset(database, packageRecord, { updateAssetId });
  if (saved.duplicate) { await deletePackage(packageRecord.id); return saved; }
  if (!await persist(saved.database)) throw new Error(READ_ONLY_MESSAGE);
  if (oldPackageId && oldPackageId !== packageRecord.id) await deletePackage(oldPackageId);
  return saved;
}

export async function removeAssetAndPackage(database, id, { persist = saveDatabase, deletePackage } = {}) {
  assertWritableDatabase(database);
  const packageId = database.assets.find((item) => item.id === id)?.skillPackage?.packageId ?? null;
  const next = removeAsset(database, id);
  if (!await persist(next)) throw new Error(READ_ONLY_MESSAGE);
  if (packageId) await deletePackage(packageId);
  return next;
}
