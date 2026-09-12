import { applyDatabaseChange, clearSkillDeliveryTarget, loadDatabase, setSkillDeliveryTarget } from './store.js';
import { agentPathHint, agentTarget, createDeliveryMarker, deliveryFiles, deliveryRecord, isAgentTarget, skillSlug } from './agent-deliver.js';
import { deleteBinding, getBinding, putBinding } from './agent-folders.js';
import { ensureReadWrite, recallDelivery, writeDelivery } from './agent-fs.js';
import { getPackage } from './package-store.js';

const app = globalThis.document?.querySelector?.('#app');
const params = new URLSearchParams(globalThis.location?.search ?? '');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function actionLabel(action) {
  if (action === 'recall') return '撤回投递';
  if (action === 'bind') return '选择目录';
  if (action === 'unbind') return '解除绑定';
  return '投递到 Agent';
}

function renderState({ title, body, error = '', done = false, needFolder = false, targetId = '', busy = false }) {
  if (!app) return;
  const hint = targetId ? agentPathHint(targetId) : '';
  app.innerHTML = `<section class="section-card">
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(body)}</p>
    ${hint && needFolder ? `<p class="form-help">请选择 ${escapeHtml(hint)}。弹窗关闭后不会自动写入。</p>` : ''}
    ${error ? `<p class="form-help deliver-error">${escapeHtml(error)}</p>` : ''}
    <div class="section-actions">
      ${needFolder ? `<button class="button button-primary" type="button" data-action="pick-folder" ${busy ? 'disabled' : ''}>选择 skills 目录</button>` : ''}
      ${!done && !needFolder ? `<button class="button button-primary" type="button" data-action="run" ${busy ? 'disabled' : ''}>${escapeHtml(actionLabel(params.get('action')))}</button>` : ''}
      <button class="button button-ghost" type="button" data-action="close">${done ? '关闭' : '取消'}</button>
    </div>
  </section>`;
}

async function pickDirectory(targetId) {
  if (typeof globalThis.showDirectoryPicker !== 'function') throw new Error('当前浏览器不支持选择本地目录。请使用 Edge 或 Chrome。');
  const handle = await globalThis.showDirectoryPicker({ id: `futurecontext-agent-${targetId}`, mode: 'readwrite' });
  await ensureReadWrite(handle);
  await putBinding({ id: targetId, handle, displayName: handle.name || 'skills' });
  return handle;
}

async function resolveFolder(targetId, allowPick) {
  const binding = await getBinding(targetId);
  if (binding?.handle) {
    try { return await ensureReadWrite(binding.handle, { prompt: false }); } catch { /* 需要用户点选后再授权。 */ }
  }
  if (!allowPick) throw new Error(binding?.handle ? '没有该目录的写入权限。请重新选择目录。' : '还没有选择该 Agent 的 skills 目录。');
  return pickDirectory(targetId);
}

export async function runDeliverAction({ action, assetId, target, pickFolder } = {}) {
  if (!['deliver', 'recall', 'bind', 'unbind'].includes(action)) throw new Error('不支持的投递操作。');
  if (!isAgentTarget(target)) throw new Error('不支持的 Agent。');
  const info = agentTarget(target);
  if (action === 'unbind') {
    await deleteBinding(target);
    return { message: `已解除 ${info.label} 的目录绑定。已投递的副本仍在磁盘上，需要时请再撤回。` };
  }
  if (action === 'bind') {
    if (!pickFolder) throw new Error('还没有选择该 Agent 的 skills 目录。');
    await pickDirectory(target);
    return { message: `已记住 ${info.label} 的 skills 目录。收藏不会自动写入。` };
  }
  const database = await loadDatabase();
  const asset = database.assets.find((item) => item.id === assetId && item.type === 'skill');
  if (!asset) throw new Error('找不到要投递的 Skill。');
  const root = await resolveFolder(target, Boolean(pickFolder));
  if (action === 'recall') {
    const record = deliveryRecord(asset, target);
    const slug = record?.slug || skillSlug(asset.title, asset.id);
    const result = await recallDelivery(root, { slug, assetId: asset.id });
    await applyDatabaseChange((db) => clearSkillDeliveryTarget(db, asset.id, target));
    return { message: result.recalled ? `已从 ${info.label} 撤回投递。库里的收藏还在。` : `${info.label} 目录里已没有这份副本。库里的收藏还在。` };
  }
  const packageRecord = asset.skillPackage?.packageId ? await getPackage(asset.skillPackage.packageId) : null;
  const files = deliveryFiles(asset, packageRecord);
  const slug = skillSlug(asset.title, asset.id);
  const marker = createDeliveryMarker(asset, target, slug);
  await writeDelivery(root, { slug, files, marker, assetId: asset.id });
  await applyDatabaseChange((db) => setSkillDeliveryTarget(db, asset.id, target, marker));
  return { message: `已投递到 ${info.label}。可随时撤回，库里的收藏不受影响。` };
}

export async function bootDeliver() {
  const action = params.get('action') || 'deliver';
  const assetId = params.get('assetId') || '';
  const target = params.get('target') || '';
  const info = agentTarget(target);
  const title = actionLabel(action);
  if (!info || !['deliver', 'recall', 'bind', 'unbind'].includes(action) || (['deliver', 'recall'].includes(action) && !assetId)) {
    renderState({ title, body: '缺少投递参数。', error: '请从 Skill 详情页重新打开。', done: true });
    return;
  }
  const body = action === 'deliver'
    ? `把「当前 Skill」写入 ${info.label} 的 skills 目录。这不是自动同步，只影响这一条。`
    : action === 'recall'
      ? `从 ${info.label} 的 skills 目录删除 FutureContext 写下的副本。库里的收藏保留。`
      : action === 'bind'
        ? `为 ${info.label} 选择本机 skills 文件夹。选择本身不会写入任何 Skill。`
        : `忘记 ${info.label} 的目录位置。不会删除已经写下的副本。`;

  const run = async ({ pickFolder = false } = {}) => {
    renderState({ title, body, targetId: target, busy: true });
    try {
      const result = await runDeliverAction({ action, assetId, target, pickFolder });
      renderState({ title, body: result.message, done: true, targetId: target });
    } catch (error) {
      const needFolder = /没有选择|重新选择|不支持选择本地目录/.test(error.message || '');
      renderState({ title, body, error: error.message || '操作失败。', needFolder, targetId: target });
    }
  };

  renderState({ title, body, targetId: target, needFolder: action === 'bind' });
  app.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.action === 'close') { globalThis.close(); return; }
    if (button.dataset.action === 'pick-folder') void run({ pickFolder: true });
    if (button.dataset.action === 'run') void run();
  });
  if (action !== 'bind') void run();
}

if (app && params.get('action')) void bootDeliver();
