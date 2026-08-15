import {
  assetsFor,
  categoriesFor,
  categoryUsage,
  createBackup,
  createCategory,
  deleteCategory,
  discardDraft,
  displayTitle,
  getDraft,
  hasPrivacyLock,
  loadDatabase,
  mergeBackup,
  moveAigcAsset,
  removeAsset,
  renameCategory,
  saveAsset,
  saveDatabase,
  saveDraft,
  scopeFor,
  setPrivacyPassword,
  verifyPrivacyPassword
} from './store.js';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const backupInput = document.querySelector('#backup-input');
const confirmDialog = document.querySelector('#confirm-dialog');
const confirmTitle = document.querySelector('#confirm-title');
const confirmDescription = document.querySelector('#confirm-description');
const confirmAction = document.querySelector('#confirm-action');

const labels = { generic: '通用 Prompt', skill: 'Skill', aigc: 'AIGC Prompt' };
const state = {
  database: null,
  view: 'library',
  activeTab: 'generic',
  privacy: 'normal',
  search: '',
  categoryId: null,
  categoryMenuOpen: false,
  unlockedPrivate: false,
  editor: null,
  manageScope: null,
  categoryEditId: null,
  lockReturn: null
};

let toastTimer;
let confirmCallback = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function lockIcon() {
  return '<svg class="lock-line" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
}

function backIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/><path d="M8 12h10"/></svg>';
}

function searchIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.6"/><path d="m15.2 15.2 4 4"/></svg>';
}

function chevronIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
}

function isPrivateView() {
  return state.activeTab === 'aigc' && state.privacy === 'private';
}

function activePrivacy() {
  return state.activeTab === 'aigc' ? state.privacy : 'normal';
}

function currentScope() {
  return scopeFor(state.activeTab, activePrivacy());
}

function categoryName(id) {
  return state.database.categories.find((category) => category.id === id)?.name ?? '未分类';
}

function currentCategoryLabel() {
  return state.categoryId ? categoryName(state.categoryId) : '全部分类';
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2400);
}

async function commit(next) {
  await saveDatabase(next);
  state.database = next;
}

function pageHeading(title, backAction = 'library') {
  return `<div class="page-heading"><button class="back-button" type="button" data-action="${backAction}">${backIcon()}返回</button><h1>${escapeHtml(title)}</h1><span aria-hidden="true"></span></div>`;
}

function renderTabs() {
  return `<nav class="tabs" aria-label="资产类型">
    ${Object.entries(labels).map(([type, label]) => `<button class="tab ${state.activeTab === type ? 'is-active' : ''}" type="button" data-tab="${type}">${label}</button>`).join('')}
  </nav>`;
}

function renderSubtabs() {
  if (state.activeTab !== 'aigc') return '';
  return `<div class="subtabs" aria-label="AIGC 资料库">
    <button class="subtab ${state.privacy === 'normal' ? 'is-active' : ''}" type="button" data-privacy="normal">普通</button>
    <button class="subtab private-tab ${state.privacy === 'private' ? 'is-active' : ''}" type="button" data-privacy="private">${lockIcon()}私密库</button>
  </div>`;
}

function renderCategoryPicker() {
  const categories = categoriesFor(state.database, currentScope());
  return `<div class="category-picker">
    <button class="category-trigger" type="button" data-action="toggle-category-menu">${escapeHtml(currentCategoryLabel())}${chevronIcon()}</button>
    <div class="category-menu" ${state.categoryMenuOpen ? '' : 'hidden'}>
      <button class="menu-item ${state.categoryId ? '' : 'is-active'}" type="button" data-category="">全部分类</button>
      ${categories.map((category) => `<button class="menu-item ${state.categoryId === category.id ? 'is-active' : ''}" type="button" data-category="${category.id}">${escapeHtml(category.name)}</button>`).join('')}
      <hr class="menu-separator" />
      <button class="menu-item" type="button" data-action="manage-categories">管理分类</button>
    </div>
  </div>`;
}

function emptyName() {
  return labels[state.activeTab];
}

function previewFor(asset) {
  if (asset.type === 'skill' && asset.skillDescription) return asset.skillDescription;
  return asset.content.replace(/\s+/g, ' ').trim();
}

function renderAssetList() {
  const assets = assetsFor(state.database, { type: state.activeTab, privacy: activePrivacy(), query: state.search, categoryId: state.categoryId });
  if (!assets.length) return `<div class="empty-state"><p>暂无${escapeHtml(emptyName())}</p><button class="button button-primary" type="button" data-action="new-asset">新建${escapeHtml(emptyName())}</button></div>`;
  return `<ul class="asset-list">${assets.map((asset) => `<li class="asset-row">
    <button class="asset-open" type="button" data-action="open-asset" data-id="${asset.id}">
      <span class="asset-title">${escapeHtml(displayTitle(asset))}</span>
      <span class="asset-preview">${escapeHtml(previewFor(asset))}</span>
      ${asset.privacy === 'normal' ? `<span class="asset-meta"><span class="category-badge">${escapeHtml(categoryName(asset.categoryId))}</span></span>` : ''}
    </button>
    <button class="button button-ghost button-small copy-button" type="button" data-action="copy-asset" data-id="${asset.id}">复制</button>
  </li>`).join('')}</ul>`;
}

function renderPrivateGate() {
  const isSetup = !hasPrivacyLock(state.database);
  return `<div class="gate"><section class="gate-card">
    <div class="gate-icon">${lockIcon()}</div>
    <h1>${isSetup ? '设置隐私锁' : '私密库'}</h1>
    <p>${isSetup ? '设置后，每次重新打开弹窗进入私密库时都需要输入密码。' : '输入隐私锁后查看内容。'}</p>
    <form class="editor-form" id="private-gate-form" data-mode="${isSetup ? 'setup' : 'unlock'}">
      <div class="field"><label>${isSetup ? '隐私锁密码' : '密码'}<input id="gate-password" type="password" minlength="6" autocomplete="${isSetup ? 'new-password' : 'current-password'}" required /></label></div>
      ${isSetup ? '<div class="field"><label>再次输入密码<input id="gate-confirm" type="password" minlength="6" autocomplete="new-password" required /></label></div>' : ''}
      <p class="form-help" id="gate-error" hidden></p>
      <button class="button button-primary" type="submit">${isSetup ? '设置并进入私密库' : '解锁'}</button>
    </form>
    <button class="back-button" type="button" data-action="private-gate-back">返回普通 AIGC</button>
  </section></div>`;
}

function renderLibrary() {
  const privateGate = isPrivateView() && !state.unlockedPrivate;
  const tools = privateGate ? '' : `<div class="library-tools">
    <label class="search-box">${searchIcon()}<input id="search" type="search" value="${escapeHtml(state.search)}" placeholder="搜索标题或内容" aria-label="搜索当前内容" /></label>
    ${isPrivateView() ? '' : renderCategoryPicker()}
    <button class="button button-primary" type="button" data-action="new-asset">+ 新建</button>
  </div>`;
  return `${renderTabs()}${renderSubtabs()}${tools}${privateGate ? renderPrivateGate() : renderAssetList()}`;
}

function editorValues() {
  const form = document.querySelector('#editor-form');
  if (!form) return state.editor?.values ?? {};
  return {
    title: form.querySelector('#editor-title-input')?.value ?? '',
    content: form.querySelector('#editor-content')?.value ?? '',
    categoryId: form.querySelector('#editor-category')?.value || null
  };
}

function editorChanged(values = editorValues()) {
  const baseline = state.editor?.baseline ?? { title: '', content: '', categoryId: null };
  return values.title !== baseline.title || values.content !== baseline.content || (values.categoryId || null) !== (baseline.categoryId || null);
}

function categoryOptions(type, privacy, selectedId, creating = false) {
  if (privacy === 'private') return '';
  const options = categoriesFor(state.database, scopeFor(type, privacy));
  return `<div class="field"><label>分类<select id="editor-category"><option value="">未分类</option>${options.map((category) => `<option value="${category.id}" ${selectedId === category.id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}</select></label>
    ${creating ? `<div class="inline-create editor-category-create"><input id="editor-new-category" maxlength="40" placeholder="新建分类" /><button class="button button-soft button-small" type="button" data-action="create-category-from-editor">创建</button><button class="button button-ghost button-small" type="button" data-action="cancel-category-from-editor">取消</button></div>` : '<button class="inline-action" type="button" data-action="new-category-from-editor">+ 新建分类</button>'}
  </div>`;
}

function renderEditor() {
  const { type, privacy, assetId, values } = state.editor;
  const existing = assetId ? state.database.assets.find((asset) => asset.id === assetId) : null;
  const isSkill = type === 'skill';
  const heading = existing ? `编辑${labels[type]}` : `新建${labels[type]}`;
  const titleField = isSkill ? '' : `<div class="field"><label>${type === 'generic' ? '标题' : '标题（可选）'}<input id="editor-title-input" maxlength="120" value="${escapeHtml(values.title)}" ${type === 'generic' ? 'required' : ''} /></label></div>`;
  const contentLabel = isSkill ? 'SKILL.md' : '内容';
  const contentHelp = isSkill ? '<p class="form-help">保存时会校验 YAML frontmatter 中的 name 与 description。</p>' : '';
  const management = existing?.type === 'aigc' ? `<div class="secondary-management">
      <button class="button button-ghost button-small" type="button" data-action="move-asset" data-id="${existing.id}" data-target="${existing.privacy === 'private' ? 'normal' : 'private'}">${existing.privacy === 'private' ? '移出私密库' : '移入私密库'}</button>
      <button class="button button-danger button-small" type="button" data-action="delete-asset" data-id="${existing.id}">永久删除</button>
    </div>` : existing ? `<div class="secondary-management"><button class="button button-danger button-small" type="button" data-action="delete-asset" data-id="${existing.id}">永久删除</button></div>` : '';
  return `${pageHeading(heading, 'editor-back')}<form class="editor-form" id="editor-form">
    ${titleField}
    ${categoryOptions(type, privacy, values.categoryId, state.editor.categoryCreating)}
    <div class="field"><label>${contentLabel}<textarea id="editor-content" class="${isSkill ? 'skill-editor' : ''}" ${isSkill ? '' : 'required'}>${escapeHtml(values.content)}</textarea></label>${contentHelp}</div>
    <div class="editor-footer">
      <button class="button button-ghost copy-editor" type="button" data-action="copy-editor">复制</button>
      <span class="status-line">${existing ? `上次保存 ${new Date(existing.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
      <button class="button button-primary" type="submit">保存</button>
    </div>
    ${management}
  </form>`;
}

function renderCategories() {
  const scope = state.manageScope;
  const categories = categoriesFor(state.database, scope);
  return `${pageHeading('管理分类', 'library')}<form class="inline-create" id="category-create-form"><input id="new-category-name" maxlength="40" placeholder="新建分类" required /><button class="button button-primary" type="submit">新建</button></form>
    <div class="category-list">${categories.map((category) => state.categoryEditId === category.id ? `<form class="category-row" id="category-rename-form" data-id="${category.id}"><input class="inline-edit" name="name" value="${escapeHtml(category.name)}" maxlength="40" required /><div class="category-actions"><button class="button button-soft button-small" type="submit">保存</button><button class="button button-ghost button-small" type="button" data-action="cancel-category-rename">取消</button></div></form>` : `<div class="category-row"><div><div class="category-name">${escapeHtml(category.name)}</div><div class="category-count">${categoryUsage(state.database, category.id)} 项</div></div><div class="category-actions"><button class="button button-ghost button-small" type="button" data-action="rename-category" data-id="${category.id}">重命名</button><button class="button button-ghost button-small" type="button" data-action="delete-category" data-id="${category.id}">删除</button></div></div>`).join('') || '<div class="empty-state"><p>暂无分类</p></div>'}</div>`;
}

function renderSettings() {
  const lockStatus = hasPrivacyLock(state.database) ? '已设置' : '未设置';
  return `${pageHeading('设置', 'library')}<div class="settings-list">
    <div class="setting-row"><div><div class="setting-title">隐私锁</div><div class="setting-description">${lockStatus}。重设不会删除私密内容。</div></div><button class="button button-ghost button-small" type="button" data-action="reset-lock">${hasPrivacyLock(state.database) ? '重设隐私锁' : '设置隐私锁'}</button></div>
    <div class="setting-row"><div><div class="setting-title">导出全部数据</div><div class="setting-description">导出一个包含普通与私密内容的 JSON 备份文件。</div></div><button class="button button-ghost button-small" type="button" data-action="export-backup">导出</button></div>
    <div class="setting-row"><div><div class="setting-title">导入备份</div><div class="setting-description">只合并新内容，不覆盖或删除已有条目。</div></div><button class="button button-ghost button-small" type="button" data-action="import-backup">导入</button></div>
  </div>`;
}

function renderLockReset() {
  return `<div class="gate"><section class="gate-card"><div class="gate-icon">${lockIcon()}</div><h1>设置新的隐私锁</h1><p>重设后可直接进入私密库并设置新密码。</p><form class="editor-form" id="reset-lock-form"><div class="field"><label>新密码<input id="reset-password" type="password" minlength="6" autocomplete="new-password" required /></label></div><div class="field"><label>再次输入密码<input id="reset-confirm" type="password" minlength="6" autocomplete="new-password" required /></label></div><p class="form-help" id="reset-error" hidden></p><button class="button button-primary" type="submit">设置新密码</button></form><button class="back-button" type="button" data-action="settings">返回设置</button></section></div>`;
}

function render() {
  if (!state.database) return;
  if (state.view === 'editor') app.innerHTML = renderEditor();
  else if (state.view === 'categories') app.innerHTML = renderCategories();
  else if (state.view === 'settings') app.innerHTML = renderSettings();
  else if (state.view === 'reset-lock') app.innerHTML = renderLockReset();
  else app.innerHTML = renderLibrary();
}

async function setNormalTab(tab) {
  state.activeTab = tab;
  state.privacy = 'normal';
  state.search = '';
  state.categoryId = null;
  const next = structuredClone(state.database);
  next.settings.lastNormalTab = tab;
  await commit(next);
  render();
}

function openPrivate() {
  state.activeTab = 'aigc';
  state.privacy = 'private';
  state.search = '';
  state.categoryId = null;
  state.view = 'library';
  render();
}

function assetById(id) {
  return state.database.assets.find((asset) => asset.id === id);
}

function openEditor(asset = null) {
  const type = asset?.type ?? state.activeTab;
  const privacy = asset?.privacy ?? activePrivacy();
  const reference = { type, privacy, id: asset?.id ?? null };
  const draft = getDraft(state.database, reference);
  const baseline = asset ? { title: asset.type === 'skill' ? '' : asset.title, content: asset.content, categoryId: asset.categoryId } : { title: '', content: '', categoryId: privacy === 'private' ? null : state.categoryId };
  const values = draft ? { title: draft.title ?? '', content: draft.content ?? '', categoryId: draft.categoryId ?? null } : baseline;
  state.editor = { type, privacy, assetId: asset?.id ?? null, reference, baseline, values };
  state.view = 'editor';
  render();
}

async function persistEditorDraft() {
  if (!state.editor) return;
  const values = editorValues();
  state.editor.values = values;
  if (!editorChanged(values)) return;
  try {
    await commit(saveDraft(state.database, state.editor.reference, values));
  } catch {
    showToast('草稿保存失败，请重试。');
  }
}

async function beginEditorCategoryCreate() {
  if (!state.editor || state.editor.privacy === 'private') return;
  const values = editorValues();
  state.editor.values = values;
  await commit(saveDraft(state.database, state.editor.reference, values));
  state.editor.categoryCreating = true;
  render();
  document.querySelector('#editor-new-category')?.focus();
}

async function createEditorCategory() {
  if (!state.editor) return;
  const name = document.querySelector('#editor-new-category')?.value ?? '';
  try {
    const created = createCategory(state.database, scopeFor(state.editor.type, state.editor.privacy), name);
    state.editor.values = { ...state.editor.values, categoryId: created.category.id };
    state.editor.categoryCreating = false;
    await commit(saveDraft(created.database, state.editor.reference, state.editor.values));
    render();
    showToast('分类已新建并选中');
  } catch (error) {
    showToast(error.message || '新建分类失败。');
  }
}

async function returnFromEditor() {
  if (!state.editor || !editorChanged()) return finishEditorReturn(false);
  showConfirm({
    title: '放弃未保存的更改',
    description: '放弃后，这次编辑草稿将被删除。',
    actionLabel: '放弃草稿',
    danger: true,
    onConfirm: () => finishEditorReturn(true)
  });
}

async function finishEditorReturn(discard) {
  if (discard && state.editor) await commit(discardDraft(state.database, state.editor.reference));
  state.editor = null;
  state.view = 'library';
  render();
}

function showConfirm({ title, description, actionLabel, danger = false, onConfirm }) {
  confirmTitle.textContent = title;
  confirmDescription.textContent = description;
  confirmAction.textContent = actionLabel;
  confirmAction.className = `button ${danger ? 'button-danger' : 'button-primary'}`;
  confirmCallback = onConfirm;
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch {
    showToast('复制失败，请手动复制。');
  }
}

async function saveEditor() {
  const values = editorValues();
  const input = { id: state.editor.assetId, type: state.editor.type, privacy: state.editor.privacy, ...values };
  try {
    const result = saveAsset(state.database, input);
    await commit(result.database);
    state.editor = null;
    state.view = 'library';
    render();
    showToast('已保存');
  } catch (error) {
    showToast(error.message || '保存失败，请重试。');
  }
}

async function deleteAsset(id) {
  const asset = assetById(id);
  if (!asset) return;
  showConfirm({
    title: '永久删除',
    description: `“${displayTitle(asset)}”将被永久删除，无法恢复。`,
    actionLabel: '永久删除',
    danger: true,
    onConfirm: async () => {
      await commit(removeAsset(state.database, id));
      state.editor = null;
      state.view = 'library';
      render();
      showToast('已永久删除');
    }
  });
}

function moveAsset(id, target) {
  const asset = assetById(id);
  if (!asset) return;
  const isPrivateTarget = target === 'private';
  showConfirm({
    title: isPrivateTarget ? '移入私密库' : '移出私密库',
    description: isPrivateTarget
      ? `“${displayTitle(asset)}”将从普通 AIGC Prompt 移入私密库。移入成功后，普通库中的原件将被删除。`
      : `“${displayTitle(asset)}”将转为普通 AIGC Prompt，可在未解锁状态下直接查看。移出成功后，私密库中的原件将被删除。`,
    actionLabel: isPrivateTarget ? '移入私密库' : '移出私密库',
    onConfirm: async () => {
      await commit(moveAigcAsset(state.database, id, target));
      state.editor = null;
      state.activeTab = 'aigc';
      state.privacy = target;
      state.view = 'library';
      render();
      showToast(isPrivateTarget ? '已移入私密库' : '已移出私密库');
    }
  });
}

async function handlePrivateGate(form) {
  const mode = form.dataset.mode;
  const password = form.querySelector('#gate-password').value;
  const error = form.querySelector('#gate-error');
  const setError = (message) => { error.textContent = message; error.hidden = false; };
  if (mode === 'setup') {
    if (password !== form.querySelector('#gate-confirm').value) return setError('两次输入的密码不一致。');
    try { await commit(await setPrivacyPassword(state.database, password)); } catch (reason) { return setError(reason.message); }
  } else if (!await verifyPrivacyPassword(state.database, password)) return setError('密码不正确。');
  state.unlockedPrivate = true;
  if (state.lockReturn === 'export') {
    state.lockReturn = null;
    state.view = 'settings';
    render();
    await requestExport();
  } else {
    state.view = 'library';
    render();
  }
}

async function resetLock(form) {
  const password = form.querySelector('#reset-password').value;
  const error = form.querySelector('#reset-error');
  if (password !== form.querySelector('#reset-confirm').value) {
    error.textContent = '两次输入的密码不一致。';
    error.hidden = false;
    return;
  }
  try {
    await commit(await setPrivacyPassword(state.database, password));
    state.unlockedPrivate = true;
    state.view = 'settings';
    render();
    showToast('隐私锁已更新');
  } catch (reason) {
    error.textContent = reason.message || '设置失败，请重试。';
    error.hidden = false;
  }
}

async function requestExport() {
  if (!state.unlockedPrivate) {
    showConfirm({
      title: '需要解锁私密库',
      description: '解锁后才能导出包含私密内容的完整备份。',
      actionLabel: '前往解锁',
      onConfirm: () => {
        state.lockReturn = 'export';
        openPrivate();
      }
    });
    return;
  }
  showConfirm({
    title: '导出全部数据',
    description: '备份文件包含私密内容，请自行妥善保存。',
    actionLabel: '导出备份',
    onConfirm: performExport
  });
}

function performExport() {
  const backup = createBackup(state.database);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `futurecontext-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast('备份已导出，请妥善保存。');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const result = mergeBackup(state.database, await file.text());
    await commit(result.database);
    state.categoryId = null;
    render();
    showToast(`已导入 ${result.imported} 项，跳过 ${result.skipped} 项`);
  } catch (error) {
    showToast(error.message || '导入失败，请选择有效的备份文件。');
  } finally {
    backupInput.value = '';
  }
}

async function handleClick(event) {
  const button = event.target.closest('button');
  if (!button) {
    if (!event.target.closest('.category-picker') && state.categoryMenuOpen) {
      state.categoryMenuOpen = false;
      render();
    }
    return;
  }
  const action = button.dataset.action;
  if (button.dataset.tab) return setNormalTab(button.dataset.tab);
  if (button.dataset.privacy === 'normal') return setNormalTab('aigc');
  if (button.dataset.privacy === 'private') return openPrivate();
  if (button.dataset.category !== undefined) {
    state.categoryId = button.dataset.category || null;
    state.categoryMenuOpen = false;
    return render();
  }
  if (!action) return;
  if (action === 'home') return state.view === 'editor' ? returnFromEditor() : (state.view = 'library', render());
  if (action === 'settings') return state.view === 'editor' ? returnFromEditor() : (state.view = 'settings', render());
  if (action === 'library') { state.view = 'library'; return render(); }
  if (action === 'editor-back') return returnFromEditor();
  if (action === 'new-asset') return openEditor();
  if (action === 'open-asset') return openEditor(assetById(button.dataset.id));
  if (action === 'copy-asset') return copyText(assetById(button.dataset.id)?.content ?? '');
  if (action === 'copy-editor') return copyText(editorValues().content);
  if (action === 'new-category-from-editor') return beginEditorCategoryCreate();
  if (action === 'create-category-from-editor') return createEditorCategory();
  if (action === 'cancel-category-from-editor') { state.editor.categoryCreating = false; return render(); }
  if (action === 'toggle-category-menu') { state.categoryMenuOpen = !state.categoryMenuOpen; return render(); }
  if (action === 'manage-categories') { state.manageScope = currentScope(); state.categoryEditId = null; state.view = 'categories'; return render(); }
  if (action === 'rename-category') { state.categoryEditId = button.dataset.id; return render(); }
  if (action === 'cancel-category-rename') { state.categoryEditId = null; return render(); }
  if (action === 'delete-category') return deleteManagedCategory(button.dataset.id);
  if (action === 'delete-asset') return deleteAsset(button.dataset.id);
  if (action === 'move-asset') return moveAsset(button.dataset.id, button.dataset.target);
  if (action === 'private-gate-back') { state.lockReturn = null; state.privacy = 'normal'; return render(); }
  if (action === 'reset-lock') return beginResetLock();
  if (action === 'export-backup') return requestExport();
  if (action === 'import-backup') return backupInput.click();
}

async function deleteManagedCategory(id) {
  const category = state.database.categories.find((item) => item.id === id);
  if (!category) return;
  const count = categoryUsage(state.database, id);
  showConfirm({
    title: '删除分类',
    description: count ? `“${category.name}”中的 ${count} 项内容将移入未分类。` : `“${category.name}”将被删除。`,
    actionLabel: '删除分类',
    danger: true,
    onConfirm: async () => {
      await commit(deleteCategory(state.database, id));
      if (state.categoryId === id) state.categoryId = null;
      render();
      showToast('分类已删除');
    }
  });
}

function beginResetLock() {
  const goToReset = () => { state.view = 'reset-lock'; render(); };
  if (!hasPrivacyLock(state.database)) return goToReset();
  showConfirm({
    title: '重设隐私锁',
    description: '重设后可直接进入私密库并设置新密码。',
    actionLabel: '重设隐私锁',
    danger: true,
    onConfirm: goToReset
  });
}

async function handleSubmit(event) {
  const form = event.target;
  event.preventDefault();
  if (form.id === 'editor-form') return saveEditor();
  if (form.id === 'private-gate-form') return handlePrivateGate(form);
  if (form.id === 'reset-lock-form') return resetLock(form);
  if (form.id === 'category-create-form') {
    try {
      const result = createCategory(state.database, state.manageScope, form.querySelector('#new-category-name').value);
      await commit(result.database);
      render();
      showToast('分类已新建');
    } catch (error) { showToast(error.message || '新建分类失败。'); }
  }
  if (form.id === 'category-rename-form') {
    try {
      await commit(renameCategory(state.database, form.dataset.id, form.elements.name.value));
      state.categoryEditId = null;
      render();
      showToast('分类已重命名');
    } catch (error) { showToast(error.message || '重命名失败。'); }
  }
}

async function initialize() {
  try {
    state.database = await loadDatabase();
    state.activeTab = ['generic', 'skill', 'aigc'].includes(state.database.settings.lastNormalTab) ? state.database.settings.lastNormalTab : 'generic';
    render();
  } catch {
    app.innerHTML = '<div class="empty-state"><p>无法读取本地资料库。</p></div>';
  }
}

document.addEventListener('click', (event) => { void handleClick(event); });
app.addEventListener('input', (event) => {
  if (event.target.id === 'search') {
    state.search = event.target.value;
    render();
    const search = document.querySelector('#search');
    search?.focus();
    search?.setSelectionRange(state.search.length, state.search.length);
    return;
  }
  if (event.target.closest('#editor-form')) void persistEditorDraft();
});
app.addEventListener('change', (event) => { if (event.target.closest('#editor-form')) void persistEditorDraft(); });
app.addEventListener('submit', (event) => { void handleSubmit(event); });
backupInput.addEventListener('change', () => { void importBackup(backupInput.files[0]); });
confirmDialog.addEventListener('close', () => {
  if (confirmDialog.returnValue === 'confirm') void confirmCallback?.();
  confirmCallback = null;
});

initialize();
