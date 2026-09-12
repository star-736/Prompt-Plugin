import {
  DELIVERY_MARKER,
  agentRootAliases,
  folderMatchesAsset,
  inspectDeliveryDirectory,
  isAgentTarget,
  normalizeFolderKey,
  skillFolderCandidates,
  skillSlug,
  skillYamlName
} from './agent-deliver.js';

function isMissing(error) {
  return error?.name === 'NotFoundError' || /not found|not exist/i.test(String(error?.message ?? ''));
}

export async function canReadHandle(handle) {
  if (!handle) return false;
  if (!handle.queryPermission) return true;
  return (await handle.queryPermission({ mode: 'read' })) === 'granted';
}

export async function ensureReadWrite(handle, { prompt = true } = {}) {
  if (!handle) throw new Error('还没有选择该 Agent 的 skills 目录。');
  const current = handle.queryPermission ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted';
  if (current === 'granted') return handle;
  if (prompt && handle.requestPermission) {
    const next = await handle.requestPermission({ mode: 'readwrite' });
    if (next === 'granted') return handle;
  }
  throw new Error('没有该目录的访问权限。请允许访问。');
}

export async function getChildDirectory(root, name, create = false) {
  try {
    return await root.getDirectoryHandle(name, { create });
  } catch (error) {
    if (!create && isMissing(error)) return null;
    throw error;
  }
}

export async function readFileText(directory, name) {
  try {
    const fileHandle = await directory.getFileHandle(name);
    return await (await fileHandle.getFile()).text();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function readSkillMarkdown(directory) {
  return await readFileText(directory, 'SKILL.md') ?? await readFileText(directory, 'skill.md');
}

export async function resolveSkillsDirectory(handle, targetId, { create = false } = {}) {
  if (!handle) throw new Error('还没有选择该 Agent 的 skills 目录。');
  if (!isAgentTarget(targetId)) throw new Error('不支持的 Agent。');
  const name = normalizeFolderKey(handle.name);
  if (name === 'skills') return { handle, displayName: handle.name || 'skills' };

  const enterSkills = async (root, label) => {
    const skills = await getChildDirectory(root, 'skills', create);
    if (skills) return { handle: skills, displayName: `${label}/skills` };
    return { handle: null, displayName: `${label}/skills` };
  };

  if (agentRootAliases(targetId).includes(name)) return enterSkills(handle, handle.name);

  const children = await listChildDirectories(handle);
  const agentChild = children.find((child) => agentRootAliases(targetId).includes(normalizeFolderKey(child.name)));
  if (agentChild) return enterSkills(agentChild.handle, agentChild.name);
  const skillsChild = children.find((child) => normalizeFolderKey(child.name) === 'skills');
  if (skillsChild) return { handle: skillsChild.handle, displayName: `${handle.name}/skills` };
  if (create) return enterSkills(handle, handle.name);
  return { handle, displayName: handle.name || 'skills' };
}

export async function writeFileBytes(directory, name, bytes) {
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function ensureParent(root, segments) {
  let current = root;
  for (const part of segments.slice(0, -1)) current = await current.getDirectoryHandle(part, { create: true });
  return { directory: current, name: segments[segments.length - 1] };
}

export async function listChildDirectories(root) {
  const items = [];
  if (typeof root?.entries === 'function') {
    for await (const [name, handle] of root.entries()) {
      const kind = handle?.kind ?? (typeof handle?.getDirectoryHandle === 'function' ? 'directory' : 'file');
      if (kind === 'directory') items.push({ name, handle });
    }
    return items;
  }
  if (root?._entries) {
    for (const [name, entry] of root._entries) {
      if (entry.type === 'dir') items.push({ name, handle: entry.handle });
    }
  }
  return items;
}

export async function indexSkillDirectories(root) {
  const byKey = new Map();
  const pendingYaml = [];
  for (const child of await listChildDirectories(root)) {
    if (String(child.name).startsWith('.')) continue;
    const item = { name: child.name, handle: child.handle, yamlName: '' };
    byKey.set(String(child.name).trim().toLocaleLowerCase(), item);
    pendingYaml.push(item);
  }
  return {
    byKey,
    async ensureYaml() {
      for (const item of pendingYaml) {
        if (item._yamlLoaded) continue;
        item.yamlName = skillYamlName(await readSkillMarkdown(item.handle) ?? '');
        item._yamlLoaded = true;
        if (!item.yamlName) continue;
        const yamlKey = item.yamlName.trim().toLocaleLowerCase();
        if (!byKey.has(yamlKey)) byKey.set(yamlKey, item);
        const slugKey = skillSlug(item.yamlName).toLocaleLowerCase();
        if (slugKey && !byKey.has(slugKey)) byKey.set(slugKey, item);
      }
    }
  };
}

export async function scanSkillPresence(root, { asset, assetId, record }, index) {
  const idx = index ?? await indexSkillDirectories(root);
  const candidates = skillFolderCandidates(asset, record);
  const lookup = async () => {
    for (const name of candidates) {
      const item = idx.byKey.get(String(name).trim().toLocaleLowerCase());
      if (item) return item;
    }
    return null;
  };
  let item = await lookup();
  if (!item) {
    await idx.ensureYaml();
    item = await lookup();
    if (!item) {
      for (const candidate of idx.byKey.values()) {
        if (folderMatchesAsset(candidate.name, candidate.yamlName, candidates)) {
          item = candidate;
          break;
        }
      }
    }
  }
  if (!item) return { kind: 'missing' };
  const markerText = await readFileText(item.handle, DELIVERY_MARKER);
  return { ...inspectDeliveryDirectory({ exists: true, markerText, assetId }), slug: item.name };
}

export async function inspectWritableSlot(root, slug, assetId) {
  const skillDir = await getChildDirectory(root, slug, false);
  if (!skillDir) return { kind: 'missing' };
  const markerText = await readFileText(skillDir, DELIVERY_MARKER);
  const verdict = inspectDeliveryDirectory({ exists: true, markerText, assetId });
  if (verdict.kind === 'foreign') throw new Error(`目录 ${slug} 已存在且不是 FutureContext 投递的，未覆盖。`);
  if (verdict.kind === 'ours-other') throw new Error(`目录 ${slug} 已被另一条 FutureContext Skill 占用，未覆盖。`);
  return verdict;
}

export async function writeDelivery(root, { slug, files, marker, assetId }) {
  await inspectWritableSlot(root, slug, assetId);
  const skillDir = await root.getDirectoryHandle(slug, { create: true });
  for (const file of files) {
    const { directory, name } = await ensureParent(skillDir, file.segments);
    await writeFileBytes(directory, name, file.bytes);
  }
  await writeFileBytes(skillDir, DELIVERY_MARKER, new TextEncoder().encode(`${JSON.stringify(marker, null, 2)}\n`));
}

export async function recallDelivery(root, { slug, assetId }) {
  const skillDir = await getChildDirectory(root, slug, false);
  if (!skillDir) return { recalled: false, reason: 'missing' };
  const verdict = inspectDeliveryDirectory({ exists: true, markerText: await readFileText(skillDir, DELIVERY_MARKER), assetId });
  if (verdict.kind === 'ours') {
    await root.removeEntry(slug, { recursive: true });
    return { recalled: true, reason: 'ours' };
  }
  if (verdict.kind === 'missing') return { recalled: false, reason: 'missing' };
  throw new Error('该目录不是这条 Skill 的投递副本，已停止删除。');
}
