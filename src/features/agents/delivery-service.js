import { applyDatabaseChange, clearSkillDeliveryTarget, isReadOnlyDatabase, READ_ONLY_MESSAGE, loadDatabase, setSkillDeliveryTarget } from '../../core/store.js';
import { agentPathHint, agentTarget, createDeliveryMarker, deliveryFiles, deliveryRecord, isAgentTarget, skillSlug } from './agent-deliver.js';
import { deleteBinding, getBinding, putBinding } from './agent-folders.js';
import { ensureReadWrite, recallDelivery, refreshLocalSkill, resolveSkillsDirectory, scanSkillPresence, writeDelivery } from './agent-fs.js';
import { getPackage } from '../../platform/package-store.js';

export async function copyPathHint(targetId) {
  const path = agentPathHint(targetId);
  if (!path || !globalThis.navigator?.clipboard?.writeText) return false;
  try {
    await globalThis.navigator.clipboard.writeText(path);
    return true;
  } catch {
    return false;
  }
}

async function pickDirectory(targetId) {
  if (typeof globalThis.showDirectoryPicker !== 'function') throw new Error('当前浏览器不支持选择本地目录。请使用 Edge 或 Chrome。');
  await copyPathHint(targetId);
  const handle = await globalThis.showDirectoryPicker({ id: `futurecontext-agent-${targetId}`, mode: 'readwrite' });
  await ensureReadWrite(handle);
  const resolved = await resolveSkillsDirectory(handle, targetId, { create: true });
  if (!resolved.handle) throw new Error('无法创建 skills 子目录。');
  const info = agentTarget(targetId);
  await putBinding({ id: targetId, handle: resolved.handle, displayName: `${info.label} 的 skills` });
  return resolved.handle;
}

async function resolveFolder(targetId, { pickFolder = false, allowAccess = false } = {}) {
  const binding = await getBinding(targetId);
  if (binding?.handle) {
    try {
      const handle = await ensureReadWrite(binding.handle, { prompt: allowAccess });
      const resolved = await resolveSkillsDirectory(handle, targetId);
      return resolved.handle;
    } catch (error) {
      if (!pickFolder) throw new Error(allowAccess ? (error.message || '没有该目录的访问权限。请允许访问。') : '没有该目录的访问权限。请允许访问。');
    }
  } else if (!pickFolder) {
    throw new Error('还没有选择该 Agent 的 skills 目录。');
  }
  return pickDirectory(targetId);
}

export async function runDeliverAction({ action, assetId, target, pickFolder, allowAccess } = {}) {
  if (!['deliver', 'recall', 'refresh', 'bind', 'allow', 'unbind'].includes(action)) throw new Error('不支持的投递操作。');
  if (!isAgentTarget(target)) throw new Error('不支持的 Agent。');
  const info = agentTarget(target);
  const database = await loadDatabase();
  if (isReadOnlyDatabase(database)) throw new Error(READ_ONLY_MESSAGE);
  if (action === 'unbind') {
    await deleteBinding(target);
    return { message: `已解除 ${info.label} 的目录绑定。已投递的副本仍在磁盘上，需要时请再撤回。` };
  }
  if (action === 'allow') {
    if (pickFolder) {
      await pickDirectory(target);
      return { message: `已记住 ${info.label} 的目录。收藏不会自动写入。` };
    }
    if (!allowAccess) throw new Error('没有该目录的访问权限。请允许访问。');
    const binding = await getBinding(target);
    if (!binding?.handle) throw new Error('还没有选择该 Agent 的 skills 目录。');
    await ensureReadWrite(binding.handle, { prompt: true });
    return { message: `已允许访问 ${info.label} 的目录。关闭后即可对照磁盘。` };
  }
  if (action === 'bind') {
    if (!pickFolder) throw new Error('还没有选择该 Agent 的 skills 目录。');
    await pickDirectory(target);
    return { message: `已记住 ${info.label} 的 skills 目录。收藏不会自动写入。` };
  }
  const asset = database.assets.find((item) => item.id === assetId && item.type === 'skill');
  if (!asset) throw new Error('找不到要投递的 Skill。');
  const root = await resolveFolder(target, { pickFolder: Boolean(pickFolder), allowAccess: Boolean(allowAccess) });
  if (action === 'refresh') {
    const inspection = await scanSkillPresence(root, { asset, assetId: asset.id, record: deliveryRecord(asset, target) });
    if (inspection.kind === 'missing') throw new Error(`${info.label} 目录里没有找到这份 Skill。`);
    const packageRecord = asset.skillPackage?.packageId ? await getPackage(asset.skillPackage.packageId) : null;
    await refreshLocalSkill(root, { slug: inspection.slug, files: deliveryFiles(asset, packageRecord) });
    return { message: `已用库里的版本更新 ${info.label} 里的本地副本。不是投递，撤回不会动它。` };
  }
  if (action === 'recall') {
    const record = deliveryRecord(asset, target);
    const slug = record?.slug || skillSlug(asset.title, asset.id);
    const result = await recallDelivery(root, { slug, assetId: asset.id });
    if (!await applyDatabaseChange((db) => clearSkillDeliveryTarget(db, asset.id, target))) throw new Error(READ_ONLY_MESSAGE);
    return { message: result.recalled ? `已从 ${info.label} 撤回投递。库里的收藏还在。` : `${info.label} 目录里已没有这份副本。库里的收藏还在。` };
  }
  const packageRecord = asset.skillPackage?.packageId ? await getPackage(asset.skillPackage.packageId) : null;
  const files = deliveryFiles(asset, packageRecord);
  const slug = skillSlug(asset.title, asset.id);
  const marker = createDeliveryMarker(asset, target, slug);
  await writeDelivery(root, { slug, files, marker, assetId: asset.id });
  if (!await applyDatabaseChange((db) => setSkillDeliveryTarget(db, asset.id, target, marker))) throw new Error(READ_ONLY_MESSAGE);
  return { message: `已投递到 ${info.label}。可随时撤回，库里的收藏不受影响。` };
}
