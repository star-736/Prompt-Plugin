export const DELIVERY_MARKER = '.futurecontext-delivery.json';
export const AGENT_TARGETS = Object.freeze([
  { id: 'claude', label: 'Claude Code', pathUnix: '~/.claude/skills', pathWindows: '%USERPROFILE%\\.claude\\skills' },
  { id: 'cursor', label: 'Cursor', pathUnix: '~/.cursor/skills', pathWindows: '%USERPROFILE%\\.cursor\\skills' },
  { id: 'codex', label: 'Codex', pathUnix: '~/.codex/skills', pathWindows: '%USERPROFILE%\\.codex\\skills' },
  { id: 'hermes', label: 'Hermes Agent', pathUnix: '~/.hermes/skills', pathWindows: '%LOCALAPPDATA%\\hermes\\skills' },
  { id: 'agents', label: '通用 Agent', pathUnix: '~/.agents/skills', pathWindows: '%USERPROFILE%\\.agents\\skills' }
]);
export const AGENT_TARGET_IDS = Object.freeze(AGENT_TARGETS.map((target) => target.id));

const RESERVED_SLUGS = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3', 'lpt4']);

export function isAgentTarget(id) {
  return AGENT_TARGET_IDS.includes(id);
}

export function agentTarget(id) {
  return AGENT_TARGETS.find((target) => target.id === id) ?? null;
}

export function agentPathHint(id, platform = globalThis.navigator?.platform ?? '') {
  const target = agentTarget(id);
  if (!target) return '';
  return /win/i.test(String(platform)) ? target.pathWindows : target.pathUnix;
}

export function skillSlug(name, fallbackId = '') {
  const cleaned = String(name ?? '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/[\s.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  if (cleaned && !RESERVED_SLUGS.has(cleaned.toLocaleLowerCase())) return cleaned;
  const fallback = String(fallbackId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return fallback ? `skill-${fallback}` : 'skill';
}

export function safeSegments(path) {
  const parts = String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || /[:*?"<>|]/.test(part))) {
    throw new Error(`Skill 包含不安全的文件路径：${path}`);
  }
  return parts;
}

export function decodePackageBytes(file) {
  const raw = String(file?.content ?? '').replace(/\s+/g, '');
  if (!raw) return new Uint8Array();
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(raw, 'base64'));
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function deliveryFiles(asset, packageRecord = null) {
  const files = [];
  const seen = new Set();
  for (const file of packageRecord?.files ?? []) {
    const segments = safeSegments(file.path);
    if (!segments.length) continue;
    const path = segments.join('/');
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, segments, bytes: decodePackageBytes(file) });
  }
  if (!seen.has('SKILL.md')) {
    files.unshift({ path: 'SKILL.md', segments: ['SKILL.md'], bytes: new TextEncoder().encode(String(asset?.content ?? '')) });
  }
  if (!files.some((file) => file.path === 'SKILL.md')) throw new Error('没有可投递的 SKILL.md。');
  return files;
}

export function createDeliveryMarker(asset, target, slug, now = Date.now()) {
  if (!isAgentTarget(target)) throw new Error('不支持的 Agent。');
  return {
    source: 'futurecontext',
    assetId: asset.id,
    target,
    slug,
    deliveredAt: now,
    contentUpdatedAt: asset.updatedAt ?? now
  };
}

export function parseDeliveryMarker(text) {
  try {
    const marker = JSON.parse(String(text ?? ''));
    if (marker?.source !== 'futurecontext' || !marker.assetId || !isAgentTarget(marker.target) || !marker.slug) return null;
    return marker;
  } catch {
    return null;
  }
}

export function inspectDeliveryDirectory({ exists, markerText, assetId }) {
  if (!exists) return { kind: 'missing' };
  const marker = parseDeliveryMarker(markerText);
  if (!marker) return { kind: 'foreign' };
  if (marker.assetId === assetId) return { kind: 'ours', marker };
  return { kind: 'ours-other', marker };
}

export function normalizeSkillDelivery(value) {
  const targets = {};
  for (const [id, record] of Object.entries(value?.targets ?? {})) {
    if (!isAgentTarget(id) || !record?.slug) continue;
    const deliveredAt = Number(record.deliveredAt);
    const contentUpdatedAt = Number(record.contentUpdatedAt);
    targets[id] = {
      slug: String(record.slug),
      deliveredAt: Number.isFinite(deliveredAt) && deliveredAt > 0 ? deliveredAt : null,
      contentUpdatedAt: Number.isFinite(contentUpdatedAt) && contentUpdatedAt > 0 ? contentUpdatedAt : null
    };
  }
  return Object.keys(targets).length ? { targets } : undefined;
}

export function deliveredTargetIds(asset) {
  return Object.keys(asset?.skillDelivery?.targets ?? {}).filter(isAgentTarget);
}

export function deliveryRecord(asset, target) {
  return asset?.skillDelivery?.targets?.[target] ?? null;
}

export function deliveryStatus(asset, target) {
  const record = deliveryRecord(asset, target);
  if (!record) return { state: 'idle', record: null };
  const stale = Number(asset?.updatedAt ?? 0) > Number(record.contentUpdatedAt ?? 0);
  return { state: stale ? 'stale' : 'delivered', record };
}

export function deliverySummary(asset) {
  return deliveredTargetIds(asset).map((id) => agentTarget(id)?.label ?? id);
}
