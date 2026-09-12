import { applyDatabaseChange, clearSkillDeliveryTarget, loadDatabase, setSkillDeliveryTarget } from './store.js';
import { agentPathHint, agentTarget, createDeliveryMarker, deliveryFiles, deliveryRecord, folderPickerHelp, isAgentTarget, skillSlug } from './agent-deliver.js';
import { deleteBinding, getBinding, putBinding } from './agent-folders.js';
import { ensureReadWrite, recallDelivery, refreshLocalSkill, resolveSkillsDirectory, scanSkillPresence, writeDelivery } from './agent-fs.js';
import { getPackage } from './package-store.js';

const app = globalThis.document?.querySelector?.('#app');
const params = new URLSearchParams(globalThis.location?.search ?? '');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function actionLabel(action) {
  if (action === 'recall') return '撤回投递';
  if (action === 'refresh') return '更新本地';
  if (action === 'bind') return '选择目录';
  if (action === 'allow') return '允许访问';
  if (action === 'unbind') return '解除绑定';
  return '投递到 Agent';
}

function renderState({ title, body, error = '', done = false, needFolder = false, needAllow = false, targetId = '', busy = false }) {
  if (!app) return;
  const help = targetId && needFolder ? folderPickerHelp(targetId) : '';
  app.innerHTML = `<section class="section-card">
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(body)}</p>
    ${help ? `<p class="form-help">${escapeHtml(help)}</p>` : ''}
    ${error ? `<p class="form-help deliver-error">${escapeHtml(error)}</p>` : ''}
    <div class="section-actions">
      ${needAllow ? `<button class="button button-primary" type="button" data-action="allow-access" ${busy ? 'disabled' : ''}>允许访问</button>` : ''}
      ${needFolder ? `<button class="${needAllow ? 'button button-ghost' : 'button button-primary'}" type="button" data-action="pick-folder" ${busy ? 'disabled' : ''}>${needAllow ? '更换目录' : '选择 skills 目录'}</button>` : ''}
      ${needFolder ? `<button class="button button-ghost" type="button" data-action="copy-path" ${busy ? 'disabled' : ''}>复制路径</button>` : ''}
      ${!done && !needFolder && !needAllow ? `<button class="button button-primary" type="button" data-action="run" ${busy ? 'disabled' : ''}>${escapeHtml(actionLabel(params.get('action')))}</button>` : ''}
      <button class="button button-ghost" type="button" data-action="close">${done ? '关闭' : '取消'}</button>
    </div>
  </section>`;
}

async function copyPathHint(targetId) {
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
  const database = await loadDatabase();
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
  if (!info || !['deliver', 'recall', 'refresh', 'bind', 'allow', 'unbind'].includes(action) || (['deliver', 'recall', 'refresh'].includes(action) && !assetId)) {
    renderState({ title, body: '缺少投递参数。', error: '请从 Skill 详情页重新打开。', done: true });
    return;
  }
  const body = action === 'deliver'
    ? `把「当前 Skill」写入 ${info.label} 的 skills 目录。这不是自动同步，只影响这一条。`
    : action === 'recall'
      ? `从 ${info.label} 的 skills 目录删除 FutureContext 写下的副本。库里的收藏保留。`
      : action === 'refresh'
        ? `用库里的 SKILL.md 覆盖 ${info.label} 里已有的同名副本。不写投递标记，撤回不会删除它。`
      : action === 'bind'
        ? `为 ${info.label} 选择本机 skills 文件夹。选择本身不会写入任何 Skill。可先复制路径，再在文件夹窗口里粘贴前往。`
        : action === 'allow'
          ? `已记住 ${info.label} 的目录。浏览器不会自动读取，点一次允许访问即可对照磁盘。`
          : `忘记 ${info.label} 的目录位置。不会删除已经写下的副本。`;

  const folderFlags = (error) => {
    const message = error?.message || '';
    const needAllow = /允许访问|访问权限/.test(message);
    const needFolder = /没有选择|重新选择|不支持选择本地目录|无法识别/.test(message) || needAllow;
    return { needAllow, needFolder };
  };

  const run = async ({ pickFolder = false, allowAccess = false } = {}) => {
    renderState({ title, body, targetId: target, busy: true });
    try {
      const result = await runDeliverAction({ action, assetId, target, pickFolder, allowAccess });
      renderState({ title, body: result.message, done: true, targetId: target });
    } catch (error) {
      renderState({ title, body, error: error.message || '操作失败。', targetId: target, ...folderFlags(error) });
    }
  };

  renderState({ title, body, targetId: target, needFolder: action === 'bind', needAllow: action === 'allow' });
  app.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.action === 'close') { globalThis.close(); return; }
    if (button.dataset.action === 'copy-path') {
      void copyPathHint(target).then((copied) => {
        renderState({
          title,
          body: copied ? `路径已复制。${body}` : body,
          error: copied ? '' : `无法自动复制时请手动复制 ${agentPathHint(target)}。`,
          needFolder: true,
          needAllow: action === 'allow',
          targetId: target
        });
      });
      return;
    }
    if (button.dataset.action === 'pick-folder') void run({ pickFolder: true });
    if (button.dataset.action === 'allow-access') void run({ allowAccess: true });
    if (button.dataset.action === 'run') void run();
  });
  if (action !== 'bind' && action !== 'allow') void run();
}

if (app && params.get('action')) void bootDeliver();
