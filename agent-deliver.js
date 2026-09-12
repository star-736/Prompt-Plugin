export const DELIVERY_MARKER = '.futurecontext-delivery.json';
export const AGENT_TARGETS = Object.freeze([
  { id: 'claude', label: 'Claude Code', pathUnix: '~/.claude', pathWindows: '%USERPROFILE%\\.claude' },
  { id: 'cursor', label: 'Cursor', pathUnix: '~/.cursor', pathWindows: '%USERPROFILE%\\.cursor' },
  { id: 'codex', label: 'Codex', pathUnix: '~/.codex', pathWindows: '%USERPROFILE%\\.codex' },
  { id: 'hermes', label: 'Hermes Agent', pathUnix: '~/.hermes', pathWindows: '%LOCALAPPDATA%\\hermes' },
  { id: 'agents', label: '通用 Agent', pathUnix: '~/.agents', pathWindows: '%USERPROFILE%\\.agents' }
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

export function agentFolderBindGuide(platform = globalThis.navigator?.platform ?? '') {
  if (/win/i.test(String(platform))) {
    return '选该 Agent 的目录即可（例如 .cursor），扩展会自动使用其中的 skills 子目录，没有就创建。点「选择目录」后把路径粘到弹出窗口顶部地址栏。不要选整个用户主目录。';
  }
  return '选该 Agent 的目录即可（例如 .cursor），扩展会自动使用其中的 skills 子目录，没有就创建。点「选择目录」后按 Command+Shift+G 粘贴路径。不要选整个用户主目录。';
}

export function folderPickerHelp(id, platform = globalThis.navigator?.platform ?? '') {
  const path = agentPathHint(id, platform);
  if (!path) return '';
  if (/win/i.test(String(platform))) {
    return `选 ${path} 这一层即可。扩展会自动进入 skills 子目录。路径默认隐藏：在文件夹窗口顶部地址栏粘贴后回车。不要选整个用户主目录。`;
  }
  return `选 ${path} 这一层即可。扩展会自动进入 skills 子目录。按 Command+Shift+G 粘贴路径前往。不要选整个用户主目录。`;
}

export function agentRootAliases(id) {
  if (!isAgentTarget(id)) return [];
  return [id, `.${id}`].map(normalizeFolderKey);
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

export function normalizeSkillText(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
}

export function skillContentsMatch(left, right) {
  return normalizeSkillText(left) === normalizeSkillText(right);
}

export function skillYamlName(content) {
  const source = String(content ?? '').replace(/^\uFEFF/, '');
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return '';
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^name:\s*(.+?)\s*$/i);
    if (field) return field[1].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return '';
}

export function normalizeFolderKey(name) {
  return String(name ?? '').trim().toLocaleLowerCase();
}

export function skillFolderCandidates(asset, record = null) {
  const yaml = skillYamlName(asset?.content);
  const names = [record?.slug, asset?.title, yaml, skillSlug(asset?.title, asset?.id), skillSlug(yaml, asset?.id)];
  const seen = new Set();
  const candidates = [];
  for (const name of names) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) continue;
    for (const variant of [trimmed, skillSlug(trimmed, asset?.id)]) {
      const key = normalizeFolderKey(variant);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push(variant);
    }
  }
  return candidates;
}

export function folderMatchesAsset(folderName, yamlName, candidates) {
  const wanted = new Set(candidates.map(normalizeFolderKey));
  if (wanted.has(normalizeFolderKey(folderName))) return true;
  const yaml = String(yamlName ?? '').trim();
  if (!yaml) return false;
  return wanted.has(normalizeFolderKey(yaml)) || wanted.has(normalizeFolderKey(skillSlug(yaml)));
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

export function sameDeliveryRecord(left, right) {
  return Boolean(left && right && left.slug === right.slug && Number(left.deliveredAt ?? 0) === Number(right.deliveredAt ?? 0) && Number(left.contentUpdatedAt ?? 0) === Number(right.contentUpdatedAt ?? 0));
}

function statusFromDisk(asset, target, disk, record) {
  if (disk.kind === 'ours') {
    const contentUpdatedAt = Number(disk.marker?.contentUpdatedAt ?? record?.contentUpdatedAt ?? 0);
    const deliveredAt = Number(disk.marker?.deliveredAt ?? record?.deliveredAt ?? 0);
    const stale = Number(asset?.updatedAt ?? 0) > contentUpdatedAt;
    return {
      state: stale ? 'stale' : 'delivered',
      record: {
        slug: disk.slug || disk.marker?.slug || record?.slug,
        deliveredAt: deliveredAt || null,
        contentUpdatedAt: contentUpdatedAt || null
      }
    };
  }
  if (disk.kind === 'foreign' || disk.kind === 'ours-other') {
    return { state: disk.current === false ? 'outdated' : 'present', record: null, slug: disk.slug ?? null };
  }
  return { state: 'idle', record: null };
}

export function resolveDeliveryStatus(asset, target, { bound = false, disk } = {}) {
  const record = deliveryRecord(asset, target);
  if (!bound) {
    if (!record) return { state: 'unbound', record: null };
    const stale = Number(asset?.updatedAt ?? 0) > Number(record.contentUpdatedAt ?? 0);
    return { state: stale ? 'stale' : 'delivered', record, unconfirmed: true };
  }
  if (disk == null) {
    if (!record) return { state: 'idle', record: null, unconfirmed: true };
    const stale = Number(asset?.updatedAt ?? 0) > Number(record.contentUpdatedAt ?? 0);
    return { state: stale ? 'stale' : 'delivered', record, unconfirmed: true };
  }
  return statusFromDisk(asset, target, disk, record);
}

export function diskDeliveryWrite(status) {
  if (status?.state === 'delivered' || status?.state === 'stale') return { action: 'set', record: status.record };
  if (status?.state === 'idle' || status?.state === 'present' || status?.state === 'outdated') return { action: 'clear' };
  return { action: 'none' };
}

export function deliveryStateLabel(status, { bound = false } = {}) {
  if (status?.state === 'unbound') return '未选择目录，请先在设置中绑定';
  if (status?.state === 'present') return '目录里已有 · 版本一致，撤回不会动它';
  if (status?.state === 'outdated') return '目录里已有 · 版本不一致';
  if (status?.state === 'delivered') return status.unconfirmed ? (bound ? '已投递 · 已记住目录，点一次允许访问即可对照' : '已投递 · 未选择目录，无法确认磁盘是否仍在') : '已投递';
  if (status?.state === 'stale') return status.unconfirmed ? (bound ? '库已更新 · 已记住目录，点一次允许访问即可对照' : '库已更新 · 未选择目录，无法确认磁盘是否仍在') : '库已更新';
  if (status?.unconfirmed) return bound ? '已记住目录，点一次允许访问即可对照' : '无法确认磁盘是否已有';
  return '本地没有找到这份 Skill';
}

export function deliveryActionPlan(status) {
  if (!status || status.state === 'present') return {};
  if (status.state === 'unbound') return { bind: true };
  if (status.unconfirmed) {
    if (status.state === 'delivered') return { recall: true };
    if (status.state === 'stale') return { deliver: 'update' };
    return { allow: true };
  }
  if (status.state === 'idle') return { deliver: 'deliver' };
  if (status.state === 'stale') return { deliver: 'update' };
  if (status.state === 'outdated') return { refresh: true };
  if (status.state === 'delivered') return { recall: true };
  return {};
}

export function deliverySummary(asset) {
  return deliveredTargetIds(asset).map((id) => agentTarget(id)?.label ?? id);
}
