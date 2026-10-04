import { escapeHtml } from '../markup.js';
import { agentPathHint, agentTarget, folderPickerHelp } from '../../features/agents/agent-deliver.js';
import { copyPathHint, runDeliverAction } from '../../features/agents/delivery-service.js';

const app = globalThis.document?.querySelector?.('#app');
const params = new URLSearchParams(globalThis.location?.search ?? '');

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
