import { ASSET_TYPES, BACKUP_FORMAT, CAPTURE_LIMIT, CATEGORY_SCOPES, SORT_OPTIONS, USAGE_LOG_DAYS, categoryKey, clone, ensureScope, newId, normalizedName, normalizeAi, normalizeAsset, normalizeDatabase, normalizeInPlace, scopeFor } from './model.js';
import { hasPrivacyLock } from './credentials.js';
import { DEFAULT_PALETTE_TYPES } from '../content/in-place.js';
import { deliveryRecord, diskDeliveryWrite, isAgentTarget, sameDeliveryRecord } from '../features/agents/agent-deliver.js';
import { parsePromptTemplate, promptTemplateEnabled } from './prompt-template.js';

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
  const templateEnabled = promptTemplateEnabled(input);
  if (templateEnabled) parsePromptTemplate(content);
  return { type, privacy, title: type === 'skill' ? metadata.name : normalizedName(input.title), content, categoryId, skillDescription: metadata?.description ?? null, ...(input.templateEnabled !== undefined ? { templateEnabled } : {}) };
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
  if (existing?.privacy === 'normal' && validated.privacy === 'private') next.syncWithdrawals = [...new Set([...(next.syncWithdrawals ?? []), existing.id])];
  const legacyAigc = existing?.type === 'aigc' ? { title: existing.title ?? '', categoryId: existing.categoryId ?? null } : null;
  const asset = { ...(existing ?? { id, createdAt: now, useCount: 0, lastUsedAt: null, pinned: false }), ...validated, ...(legacyAigc ?? {}), ...(existing?.privacy === 'private' && validated.privacy === 'normal' ? { id: newId() } : {}), titleSource: titleSource(existing, validated), categorySource: categorySource(existing, validated), updatedAt: now };
  if (promptTemplateEnabled(asset)) parsePromptTemplate(asset.content);
  else delete asset.templateEnabled;
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
      // A merge may keep one of its source categories as the destination.
      fromIds.delete(target.id);
      next.assets = next.assets.map((asset) => fromIds.has(asset.categoryId) ? { ...asset, categoryId: target.id, categorySource: 'proposal', updatedAt: Date.now() } : asset);
      next.categories = next.categories.filter((category) => !fromIds.has(category.id));
    }
  }
  proposal.status = action === 'apply' ? 'applied' : 'dismissed'; proposal.resolvedAt = Date.now(); return next;
}
export function updateStructureProposal(database, id, groups) { const next = normalizeDatabase(clone(database)); const proposal = next.ai.proposals.find((item) => item.id === id); if (!proposal || proposal.status !== 'pending') throw new Error('找不到可调整的分类方案。'); proposal.groups = (groups ?? []).map((group) => ({ from: Array.from(new Set((group.from ?? []).map(normalizedName).filter(Boolean))), to: normalizedName(group.to).slice(0, 40) })).filter((group) => group.from.length && group.to); return next; }
export function updateAiSettings(database, patch) { const next = normalizeDatabase(clone(database)); next.ai = normalizeAi({ ...next.ai, ...patch, thresholds: { ...next.ai.thresholds, ...(patch.thresholds ?? {}) } }); return next; }

export function removeAsset(database, id) { const next = normalizeDatabase(clone(database)); const asset = next.assets.find((item) => item.id === id); if (!asset) throw new Error('找不到要删除的条目。'); next.assets = next.assets.filter((item) => item.id !== id); next.ai.queue = next.ai.queue.filter((entry) => entry.assetId !== id); delete next.drafts[draftKey({ type: asset.type, privacy: asset.privacy, id })]; return next; }
export function moveAigcAsset(database, id, privacy, now = Date.now()) { if (!['normal', 'private'].includes(privacy)) throw new Error('不支持的目标资料库。'); const next = normalizeDatabase(clone(database)); const index = next.assets.findIndex((asset) => asset.id === id); if (index < 0 || next.assets[index].type !== 'aigc') throw new Error('只有 AIGC Prompt 可以在资料库间移动。'); if (next.assets[index].privacy === 'normal' && privacy === 'private') next.syncWithdrawals = [...new Set([...(next.syncWithdrawals ?? []), id])]; next.assets[index] = { ...next.assets[index], ...(next.assets[index].privacy === 'private' && privacy === 'normal' ? { id: newId() } : {}), privacy, categoryId: null, pinned: privacy === 'normal' && Boolean(next.assets[index].pinned), updatedAt: now }; return next; }

const sortComparators = {
  updated: (a, b) => b.updatedAt - a.updatedAt,
  lastUsed: (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.updatedAt - a.updatedAt,
  mostUsed: (a, b) => (b.useCount ?? 0) - (a.useCount ?? 0) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.updatedAt - a.updatedAt
};
function pinnedFirst(compare) { return (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || compare(a, b); }
export function assetsFor(database, { type, privacy = 'normal', query = '', categoryId = null, sortBy = 'updated' }) {
  const needle = String(query).trim().toLocaleLowerCase();
  const compare = sortComparators[privacy === 'private' ? 'updated' : sortBy] ?? sortComparators.updated;
  const names = needle ? categoryNameMap(database) : null;
  return database.assets.filter((asset) => asset.type === type && asset.privacy === privacy).filter((asset) => type === 'aigc' || !categoryId || asset.categoryId === categoryId).filter((asset) => !needle || `${displayTitle(asset)}\n${asset.content}\n${names.get(asset.categoryId) ?? ''}`.toLocaleLowerCase().includes(needle)).sort(pinnedFirst(compare));
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
export function setSkillDeliveryTarget(database, id, target, record, now = Date.now()) {
  if (!isAgentTarget(target)) throw new Error('不支持的 Agent。');
  const next = normalizeDatabase(clone(database));
  const index = next.assets.findIndex((asset) => asset.id === id);
  if (index < 0 || next.assets[index].type !== 'skill') throw new Error('只有 Skill 可以投递到 Agent。');
  const asset = next.assets[index];
  const slug = String(record?.slug ?? '').trim();
  if (!slug) throw new Error('投递缺少目录名。');
  next.assets[index] = {
    ...asset,
    skillDelivery: {
      targets: {
        ...(asset.skillDelivery?.targets ?? {}),
        [target]: {
          slug,
          deliveredAt: Number(record.deliveredAt) || now,
          contentUpdatedAt: Number(record.contentUpdatedAt) || asset.updatedAt || now
        }
      }
    }
  };
  return next;
}
export function clearSkillDeliveryTarget(database, id, target) {
  if (!isAgentTarget(target)) throw new Error('不支持的 Agent。');
  const next = normalizeDatabase(clone(database));
  const index = next.assets.findIndex((asset) => asset.id === id);
  if (index < 0) throw new Error('找不到该条目。');
  const targets = { ...(next.assets[index].skillDelivery?.targets ?? {}) };
  delete targets[target];
  next.assets[index] = { ...next.assets[index], skillDelivery: Object.keys(targets).length ? { targets } : undefined };
  return next;
}
export function applyDiskDeliveries(database, updates) {
  let next = database;
  let changed = false;
  for (const { assetId, target, status } of updates ?? []) {
    if (!isAgentTarget(target)) continue;
    const asset = next.assets.find((item) => item.id === assetId);
    if (!asset || asset.type !== 'skill') continue;
    const write = diskDeliveryWrite(status);
    const existing = deliveryRecord(asset, target);
    if (write.action === 'set' && write.record?.slug) {
      if (!sameDeliveryRecord(existing, write.record)) {
        next = setSkillDeliveryTarget(next, assetId, target, write.record);
        changed = true;
      }
    } else if (write.action === 'clear' && existing) {
      next = clearSkillDeliveryTarget(next, assetId, target);
      changed = true;
    }
  }
  return changed ? next : null;
}
export function setAssetCategory(database, id, categoryId, { now = Date.now() } = {}) {
  const next = normalizeDatabase(clone(database)); const index = next.assets.findIndex((asset) => asset.id === id); if (index < 0) throw new Error('找不到该条目。');
  const asset = next.assets[index];
  if (!['generic', 'skill', 'command'].includes(asset.type) || asset.privacy !== 'normal') throw new Error('只有普通库的 Prompt、Skill 和指令可以分类。');
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
function assetFingerprint(asset, names) { return JSON.stringify([asset.type, asset.privacy, asset.title, asset.content, names.get(asset.categoryId) ?? '', asset.skillPackage?.source?.repository ?? '', promptTemplateEnabled(asset)]); }
export function createBackup(database, now = Date.now(), packages = []) { return { format: BACKUP_FORMAT, version: 2, exportedAt: now, categories: clone(database.categories), assets: clone(database.assets), packages: clone(packages) }; }
export function parseBackup(value) { const backup = typeof value === 'string' ? JSON.parse(value) : value; if (!backup || backup.format !== BACKUP_FORMAT || ![1, 2].includes(backup.version) || !Array.isArray(backup.assets) || !Array.isArray(backup.categories)) throw new Error('这不是 FutureContext 的有效备份文件。'); return { ...backup, packages: Array.isArray(backup.packages) ? backup.packages : [] }; }
export function mergeBackup(database, backupValue, { now = Date.now(), idFactory = newId } = {}) {
  const backup = parseBackup(backupValue); const next = normalizeDatabase(clone(database)); const categoryIds = new Map(); const known = new Map(next.categories.map((category) => [categoryKey(category.scope, category.name), category]));
  for (const category of backup.categories) { if (!CATEGORY_SCOPES.includes(category.scope) || !normalizedName(category.name)) continue; const key = categoryKey(category.scope, category.name); let target = known.get(key); if (!target) { target = { id: idFactory(), scope: category.scope, name: normalizedName(category.name), createdAt: now, createdBy: category.createdBy ?? 'human' }; next.categories.push(target); known.set(key, target); } categoryIds.set(category.id, target.id); }
  const fingerprints = new Set(next.assets.map((asset) => assetFingerprint(asset, categoryNameMap(next)))); const packageImports = []; let imported = 0; let skipped = 0;
  for (const source of backup.assets) try { const categoryId = source.type === 'aigc' || source.privacy === 'private' ? source.categoryId ?? null : (categoryIds.get(source.categoryId) ?? null); const asset = validateAsset({ ...source, categoryId }, next); const candidate = { ...asset, title: source.type === 'aigc' ? (source.title ?? '') : asset.title, categoryId: source.type === 'aigc' ? (source.categoryId ?? null) : asset.categoryId, skillPackage: source.skillPackage ?? null }; const fingerprint = assetFingerprint(candidate, categoryNameMap(next)); if (fingerprints.has(fingerprint)) { skipped += 1; continue; } if (candidate.skillPackage?.packageId) { const targetPackageId = idFactory(); packageImports.push({ sourcePackageId: candidate.skillPackage.packageId, targetPackageId }); candidate.skillPackage = { ...candidate.skillPackage, packageId: targetPackageId }; } next.assets.push(normalizeAsset({ ...candidate, id: idFactory(), createdAt: source.createdAt ?? now, updatedAt: source.updatedAt ?? now, titleSource: source.titleSource ?? (candidate.title ? 'manual' : 'none'), categorySource: source.categorySource ?? (candidate.categoryId ? 'manual' : 'none'), useCount: source.useCount, lastUsedAt: source.lastUsedAt, pinned: source.pinned, skillDelivery: undefined })); fingerprints.add(fingerprint); imported += 1; } catch { skipped += 1; }
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
