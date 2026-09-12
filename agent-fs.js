import { DELIVERY_MARKER, inspectDeliveryDirectory } from './agent-deliver.js';

function isMissing(error) {
  return error?.name === 'NotFoundError' || /not found|not exist/i.test(String(error?.message ?? ''));
}

export async function ensureReadWrite(handle, { prompt = true } = {}) {
  if (!handle) throw new Error('还没有选择该 Agent 的 skills 目录。');
  const current = handle.queryPermission ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted';
  if (current === 'granted') return handle;
  if (prompt && handle.requestPermission) {
    const next = await handle.requestPermission({ mode: 'readwrite' });
    if (next === 'granted') return handle;
  }
  throw new Error('没有该目录的写入权限。请重新选择目录。');
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
