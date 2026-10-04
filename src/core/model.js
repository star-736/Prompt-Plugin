import { normalizeSkillDelivery } from '../features/agents/agent-deliver.js';

export const BACKUP_FORMAT = 'futurecontext.backup';
export const ASSET_TYPES = Object.freeze(['generic', 'skill', 'aigc', 'command']);
export const CATEGORY_SCOPES = Object.freeze(['generic', 'skill', 'aigc-normal', 'command']);
export const DEFAULT_AI_THRESHOLDS = Object.freeze({ uncategorized: 7, restructureChanges: 7, restructureDays: 14 });
export const CURRENT_DATABASE_VERSION = 2;
export const SORT_OPTIONS = Object.freeze({ updated: '最近编辑', lastUsed: '最近取用', mostUsed: '最常取用' });
export const USAGE_LOG_DAYS = 90;
export const CAPTURE_LIMIT = 100000;

export const clone = (value) => structuredClone(value);
export const normalizedName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
export const categoryKey = (scope, name) => `${scope}:${normalizedName(name).toLocaleLowerCase()}`;
export const newId = () => globalThis.crypto?.randomUUID?.() ?? `fc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
export function ensureScope(scope) { if (!CATEGORY_SCOPES.includes(scope)) throw new Error('不支持的分类区域。'); }
export function normalizeAi(ai) {
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

export function normalizeInPlace(inPlace) {
  const sites = Array.isArray(inPlace?.sites) ? inPlace.sites.filter((site) => typeof site === 'string') : [];
  const ignoredSites = Array.isArray(inPlace?.ignoredSites) ? inPlace.ignoredSites.filter((site) => typeof site === 'string') : [];
  return { enabled: inPlace?.enabled !== false, triggerEnabled: inPlace?.triggerEnabled !== false, sites, ignoredSites };
}
function normalizeSettings(settings) {
  const sortBy = settings?.sortBy && typeof settings.sortBy === 'object' ? settings.sortBy : {};
  return { lastNormalTab: 'generic', ...(settings ?? {}), sortBy: Object.fromEntries(Object.entries(sortBy).filter(([, value]) => value in SORT_OPTIONS)), inPlace: normalizeInPlace(settings?.inPlace) };
}
function normalizeUsage(usage) { return { log: Array.isArray(usage?.log) ? usage.log.filter((time) => Number.isFinite(time)) : [] }; }
export function normalizeAsset(asset) {
  const useCount = Number(asset.useCount); const lastUsedAt = Number(asset.lastUsedAt);
  const skillDelivery = asset.type === 'skill' ? normalizeSkillDelivery(asset.skillDelivery) : undefined;
  return { ...asset, useCount: Number.isFinite(useCount) && useCount > 0 ? Math.floor(useCount) : 0, lastUsedAt: Number.isFinite(lastUsedAt) && lastUsedAt > 0 ? lastUsedAt : null, pinned: asset.privacy === 'normal' && asset.pinned === true, skillDelivery };
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
