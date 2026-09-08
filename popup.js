import {
  assetsFor,
  categoriesFor,
  categoryUsage,
  createBackup,
  createCategory,
  deleteCategory,
  discardDraft,
  disableSite,
  displayTitle,
  enableSite,
  formatSkillInsert,
  getDraft,
  hasPrivacyLock,
  ignoreSite,
  isReadOnlyDatabase,
  loadDatabase,
  mergeBackup,
  moveAigcAsset,
  READ_ONLY_MESSAGE,
  recordAssetUse,
  removeAssetAndPackage,
  resolveStructureProposal,
  renameCategory,
  saveAsset,
  saveDatabase,
  saveDraft,
  setAssetCategory,
  setAssetPinned,
  setSortBy,
  sortByFor,
  SORT_OPTIONS,
  updateAiSettings,
  updateInPlaceSettings,
  updateStructureProposal,
  removeProviderConfig,
  scopeFor,
  setPrivacyPassword,
  usageSummary,
  verifyPrivacyPassword
} from './store.js';
import { PROVIDER_PRESETS, providerOrigin } from './ai-organizer.js';
import { deletePackage, exportPackages, getPackage, importPackages, isTextFile } from './package-store.js';
import { githubSkillUrlError, inspectGitHubSkillUrl } from './github-skill.js';
import { isPromptableSite, isRestrictedTabUrl, normalizeSiteOrigin, originCoveredBySites, originOfUrl, PALETTE_SCRIPT_FILE, patternsForSites, relatedMatchPatterns, SHORTCUT_LABEL, SITE_PRESETS, siteHost } from './in-place.js';

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
  sortMenuOpen: false,
  unlockedPrivate: false,
  readOnly: false,
  notice: null,
  tabId: null,
  tabUrl: '',
  tabOrigin: null,
  editor: null,
  manageScope: null,
  categoryEditId: null,
  lockReturn: null,
  providerEditId: null,
  packageAssetId: null,
  packageRecord: null,
  packageCategoryCreating: false,
  aiUnlockAction: null,
  proposalEditingId: null
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

async function sendBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '后台操作失败。');
  return response.result;
}

async function requestOrigins(origins) {
  if (!await chrome.permissions.request({ origins })) throw new Error('需要授权对应网站后才能继续。');
}

async function commit(next) {
  if (state.readOnly) {
    showToast('当前为只读，修改不会保存。');
    throw new Error(READ_ONLY_MESSAGE);
  }
  if (!await saveDatabase(next)) {
    showToast('当前为只读，修改不会保存。');
    throw new Error(READ_ONLY_MESSAGE);
  }
  state.database = next;
}

function renderReadOnlyBanner() {
  return state.readOnly ? `<div class="notice-banner is-readonly">${escapeHtml(READ_ONLY_MESSAGE)}</div>` : '';
}

function renderNoticeBanner() {
  if (!state.notice) return '';
  return `<div class="notice-banner"><span>${escapeHtml(state.notice)}</span><button class="button button-ghost button-small" type="button" data-action="dismiss-notice">关闭</button></div>`;
}

function renderSiteHint() {
  const inPlace = state.database.settings.inPlace;
  if (!inPlace.enabled || !state.tabOrigin || !isPromptableSite(state.tabOrigin) || inPlace.sites.includes(state.tabOrigin) || inPlace.ignoredSites.includes(state.tabOrigin)) return '';
  const host = siteHost(state.tabOrigin);
  return `<div class="site-hint"><span>要在 ${escapeHtml(host)} 用 // 或 ${SHORTCUT_LABEL} 取用，请先启用此站点。启用后当前页立即生效，不必刷新。</span><span class="site-hint-actions"><button class="button button-primary button-small" type="button" data-action="enable-current-site">启用</button><button class="button button-ghost button-small" type="button" data-action="ignore-current-site">忽略</button></span></div>`;
}

function renderSortPicker() {
  if (state.activeTab === 'aigc' && state.privacy === 'private') return '';
  const current = sortByFor(state.database, state.activeTab);
  const label = SORT_OPTIONS[current] ?? SORT_OPTIONS.updated;
  return `<div class="sort-picker category-picker">
    <button class="category-trigger" type="button" data-action="toggle-sort-menu">${escapeHtml(label)}${chevronIcon()}</button>
    <div class="category-menu" ${state.sortMenuOpen ? '' : 'hidden'}>
      ${Object.entries(SORT_OPTIONS).map(([value, text]) => `<button class="menu-item ${current === value ? 'is-active' : ''}" type="button" data-action="set-sort" data-sort="${value}">${escapeHtml(text)}</button>`).join('')}
    </div>
  </div>`;
}

async function enableSiteOrigin(origin) {
  await requestOrigins(relatedMatchPatterns(origin));
  await commit(enableSite(state.database, origin));
  try {
    await sendBackground({ type: 'sync-sites' });
  } catch (error) {
    showToast(`启用后同步失败：${error.message || '后台无响应'}`);
    throw error;
  }
  if (state.tabId && state.tabOrigin && originCoveredBySites(state.tabOrigin, [origin])) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: state.tabId, allFrames: true }, files: [PALETTE_SCRIPT_FILE] });
    } catch (error) {
      showToast(`启用后无法注入页面代码：${error.message || '未知错误'}`);
      return;
    }
    try {
      await chrome.tabs.sendMessage(state.tabId, { type: 'fc-ping' });
    } catch (error) {
      showToast(`已授权但当前页未响应：${error.message || '请刷新页面后再试'}`);
      return;
    }
    showToast(`已启用就地取用，当前页可直接输入 // 或按 ${SHORTCUT_LABEL}`);
    return;
  }
  showToast('已启用就地取用');
}

async function disableSiteOrigin(origin) {
  await commit(disableSite(state.database, origin));
  await sendBackground({ type: 'sync-sites' });
  const leftover = relatedMatchPatterns(origin).filter((pattern) => !patternsForSites(state.database.settings.inPlace.sites).includes(pattern));
  try { if (leftover.length) await chrome.permissions.remove({ origins: leftover }); } catch { /* 权限可能已撤销。 */ }
  showToast('已停用就地取用');
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
  const assets = assetsFor(state.database, { type: state.activeTab, privacy: activePrivacy(), query: state.search, categoryId: state.categoryId, sortBy: sortByFor(state.database, state.activeTab) });
  const githubCollect = state.activeTab === 'skill' ? '<button class="button button-ghost" type="button" data-action="collect-github-skill">从当前 GitHub 页面收集</button>' : '';
  const pinBtn = (asset) => asset.privacy === 'normal' ? `<button class="button button-ghost button-small pin-button ${asset.pinned ? 'is-pinned' : ''}" type="button" data-action="toggle-pin" data-id="${asset.id}">${asset.pinned ? '已置顶' : '置顶'}</button>` : '';
  if (!assets.length) return `<div class="empty-state"><p>暂无${escapeHtml(emptyName())}</p><div class="empty-actions"><button class="button button-primary" type="button" data-action="new-asset">新建${escapeHtml(emptyName())}</button>${githubCollect}</div></div>`;
  return `<ul class="asset-list">${assets.map((asset) => `<li class="asset-row">
    <button class="asset-open" type="button" data-action="open-asset" data-id="${asset.id}">
      ${asset.type === 'aigc' ? `<span class="asset-aigc-content">${escapeHtml(asset.content)}</span>` : `<span class="asset-title">${escapeHtml(displayTitle(asset))}</span><span class="asset-preview">${escapeHtml(previewFor(asset))}</span>${asset.privacy === 'normal' ? `<span class="asset-meta"><span class="category-badge">${escapeHtml(categoryName(asset.categoryId))}</span></span>` : ''}`}
    </button>
    <div class="asset-actions">${pinBtn(asset)}<button class="button button-ghost button-small copy-button" type="button" data-action="copy-asset" data-id="${asset.id}">复制</button><button class="button button-ghost button-small" type="button" data-action="delete-asset" data-id="${asset.id}">删除</button></div>
  </li>`).join('')}</ul>${githubCollect ? `<div class="library-secondary-action">${githubCollect}</div>` : ''}`;
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
    ${isPrivateView() ? '' : renderSortPicker()}
    ${isPrivateView() ? '' : renderCategoryPicker()}
    <button class="button button-primary" type="button" data-action="new-asset">+ 新建</button>
  </div>`;
  return `${renderReadOnlyBanner()}${renderNoticeBanner()}${renderSiteHint()}${renderTabs()}${renderSubtabs()}${tools}${privateGate ? renderPrivateGate() : renderAssetList()}`;
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
  if (privacy === 'private' || type === 'aigc') return '';
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
  const titleField = type === 'generic' ? '<div class="field"><label>标题（可选）<input id="editor-title-input" maxlength="120" value="' + escapeHtml(values.title) + '" /></label></div>' : '';
  const contentLabel = isSkill ? 'SKILL.md' : '内容';
  const contentHelp = isSkill ? '<p class="form-help">保存时会校验 YAML frontmatter 中的 name 与 description。</p>' : '';
  const management = existing?.type === 'aigc' ? `<div class="secondary-management">
      <button class="button button-ghost button-small" type="button" data-action="move-asset" data-id="${existing.id}" data-target="${existing.privacy === 'private' ? 'normal' : 'private'}">${existing.privacy === 'private' ? '移出私密库' : '移入私密库'}</button>
      <button class="button button-danger button-small" type="button" data-action="delete-asset" data-id="${existing.id}">永久删除</button>
    </div>` : existing ? `<div class="secondary-management">${existing.privacy === 'normal' ? `<button class="button button-ghost button-small pin-button ${existing.pinned ? 'is-pinned' : ''}" type="button" data-action="toggle-pin" data-id="${existing.id}">${existing.pinned ? '已置顶' : '置顶'}</button>` : ''}<button class="button button-danger button-small" type="button" data-action="delete-asset" data-id="${existing.id}">永久删除</button></div>` : '';
  return `${renderReadOnlyBanner()}${pageHeading(heading, 'editor-back')}<form class="editor-form" id="editor-form">
    ${titleField}
    ${categoryOptions(type, privacy, values.categoryId, state.editor.categoryCreating)}
    <div class="field"><label>${contentLabel}<textarea id="editor-content" class="${isSkill ? 'skill-editor' : ''}" ${isSkill ? '' : 'required'}>${escapeHtml(values.content)}</textarea></label>${contentHelp}</div>
    <div class="editor-footer">
      <button class="button button-ghost button-small copy-editor" type="button" data-action="copy-editor">复制</button>
      <span class="status-line">${existing ? `上次保存 ${new Date(existing.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
      <button class="button button-primary button-small" type="submit">保存</button>
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
  const ai = state.database.ai;
  const current = ai.providers.find((provider) => provider.id === ai.activeProviderId);
  const status = ai.status?.state === 'paused' ? ai.status.message : ai.enabled ? '后台整理已开启' : '后台整理未开启';
  const inPlace = state.database.settings.inPlace;
  const usage = usageSummary(state.database);
  return `${renderReadOnlyBanner()}${pageHeading('设置', 'library')}<div class="settings-list">
    <div class="setting-row"><div><div class="setting-title">隐私锁</div><div class="setting-description">${lockStatus}。重设不会删除私密内容。</div></div><button class="button button-ghost button-small" type="button" data-action="reset-lock">${hasPrivacyLock(state.database) ? '重设隐私锁' : '设置隐私锁'}</button></div>
    <div class="setting-row setting-row-stack"><div><div class="setting-title">后台 AI 整理</div><div class="setting-description">${escapeHtml(status)}${current ? ` 当前 Provider：${escapeHtml(current.label)}。` : ' 还未配置 Provider。'}</div></div><div class="setting-actions"><label class="switch-label"><input id="ai-enabled" type="checkbox" ${ai.enabled ? 'checked' : ''} />开启</label><button class="button button-ghost button-small" type="button" data-action="manage-providers">Provider</button></div></div>
    <div class="setting-row setting-row-stack"><div><div class="setting-title">就地取用</div><div class="setting-description">在启用站点的输入框输入 // 或按 ${SHORTCUT_LABEL} 调出取用面板。已启用 ${inPlace.sites.length} 个站点。实际快捷键以 edge://extensions/shortcuts（Chrome 为 chrome://extensions/shortcuts）为准；被浏览器占用时可在那里改绑。</div></div><div class="setting-actions"><label class="switch-label"><input id="inplace-enabled" type="checkbox" ${inPlace.enabled ? 'checked' : ''} />开启</label><label class="switch-label"><input id="inplace-trigger" type="checkbox" ${inPlace.triggerEnabled ? 'checked' : ''} />// 触发符</label><button class="button button-ghost button-small" type="button" data-action="manage-sites">站点</button></div></div>
    <div class="setting-row"><div><div class="setting-title">取用概览</div><div class="setting-description">本周 ${usage.week} 次 · 近 30 天 ${usage.month} 次 · 累计 ${usage.total} 次</div></div><span></span></div>
    <div class="setting-row"><div><div class="setting-title">整理现有内容</div><div class="setting-description">仅处理通用 Prompt 与 Skill；AIGC 永不发送。</div></div><button class="button button-ghost button-small" type="button" data-action="organize-existing">整理</button></div>
    <div class="setting-row"><div><div class="setting-title">分类结构建议</div><div class="setting-description">已有分类的合并、重命名或拆分必须由你确认应用。</div></div><button class="button button-ghost button-small" type="button" data-action="view-proposals">${ai.proposals.filter((proposal) => proposal.status === 'pending').length ? '查看建议' : '暂无建议'}</button></div>
    <div class="setting-row"><div><div class="setting-title">整理阈值</div><div class="setting-description">未分类 ${ai.thresholds.uncategorized} 条；结构检查 ${ai.thresholds.restructureChanges} 条 / ${ai.thresholds.restructureDays} 天。</div></div><button class="button button-ghost button-small" type="button" data-action="edit-ai-thresholds">调整</button></div>
    <div class="setting-row"><div><div class="setting-title">导出全部数据</div><div class="setting-description">导出一个包含普通与私密内容的 JSON 备份文件。</div></div><button class="button button-ghost button-small" type="button" data-action="export-backup">导出</button></div>
    <div class="setting-row"><div><div class="setting-title">导入备份</div><div class="setting-description">只合并新内容，不覆盖或删除已有条目。</div></div><button class="button button-ghost button-small" type="button" data-action="import-backup">导入</button></div>
  </div>`;
}

function renderProviders() {
  const providers = state.database.ai.providers;
  return `${pageHeading('Provider', 'settings')}<div class="provider-intro">API Key 只会以隐私锁密码加密后保存。本次浏览器会话首次使用后台 AI 时解锁一次。</div><div class="settings-list">${providers.map((provider) => `<div class="setting-row"><div><div class="setting-title">${escapeHtml(provider.label)}${provider.id === state.database.ai.activeProviderId ? ' · 当前' : ''}</div><div class="setting-description">${escapeHtml(provider.model)} · ${escapeHtml(provider.baseUrl)}</div></div><div class="setting-actions"><button class="button button-ghost button-small" type="button" data-action="activate-provider" data-id="${provider.id}">设为当前</button><button class="button button-ghost button-small" type="button" data-action="test-provider" data-id="${provider.id}">测试</button><button class="button button-ghost button-small" type="button" data-action="edit-provider" data-id="${provider.id}">编辑</button><button class="button button-danger button-small" type="button" data-action="delete-provider" data-id="${provider.id}">删除</button></div></div>`).join('') || '<div class="empty-state compact-empty"><p>暂无 Provider</p></div>'}</div><div class="editor-footer"><button class="button button-primary" type="button" data-action="new-provider">+ 添加 Provider</button></div>`;
}

function renderProviderEditor() {
  const existing = state.providerEditId ? state.database.ai.providers.find((provider) => provider.id === state.providerEditId) : null;
  const provider = existing ?? { kind: 'openai', label: 'OpenAI', baseUrl: PROVIDER_PRESETS.openai.baseUrl, model: PROVIDER_PRESETS.openai.modelHint };
  return `${pageHeading(existing ? '编辑 Provider' : '添加 Provider', 'manage-providers')}<form class="editor-form" id="provider-form" data-id="${escapeHtml(provider.id ?? '')}"><div class="field"><label>Provider<select id="provider-kind">${Object.entries(PROVIDER_PRESETS).map(([key, item]) => `<option value="${key}" ${provider.kind === key ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label></div><div class="field"><label>显示名称<input id="provider-label" maxlength="60" value="${escapeHtml(provider.label)}" required /></label></div><div class="field"><label>Base URL<input id="provider-base-url" value="${escapeHtml(provider.baseUrl)}" required /></label></div><div class="field"><label>Model ID<input id="provider-model" value="${escapeHtml(provider.model)}" required /></label></div><div class="field"><label>${existing ? '新的 API Key（留空则保留原 Key）' : 'API Key'}<input id="provider-api-key" type="password" autocomplete="off" ${existing ? '' : 'required'} /></label></div><div class="field"><label>隐私锁密码<input id="provider-password" type="password" autocomplete="current-password" required /></label><p class="form-help">用于加密 API Key；FutureContext 不会长期明文保存它。</p></div><button class="button button-primary" type="submit">保存 Provider</button></form>`;
}

function renderThresholds() {
  const values = state.database.ai.thresholds;
  return `${pageHeading('整理阈值', 'settings')}<form class="editor-form" id="threshold-form"><div class="field"><label>未分类条目数<input name="uncategorized" type="number" min="2" max="50" value="${values.uncategorized}" required /></label></div><div class="field"><label>结构检查新增/编辑条数<input name="restructureChanges" type="number" min="1" max="100" value="${values.restructureChanges}" required /></label></div><div class="field"><label>结构检查最短间隔天数<input name="restructureDays" type="number" min="1" max="365" value="${values.restructureDays}" required /></label></div><button class="button button-primary" type="submit">保存阈值</button></form>`;
}

function renderAiUnlock() {
  return `<div class="gate"><section class="gate-card"><div class="gate-icon">${lockIcon()}</div><h1>解锁后台 AI</h1><p>本次 Edge 浏览器会话只需输入一次。API Key 不会长期明文保存。</p><form class="editor-form" id="ai-unlock-form"><div class="field"><label>隐私锁密码<input id="ai-unlock-password" type="password" autocomplete="current-password" required /></label></div><p class="form-help" id="ai-unlock-error" hidden></p><button class="button button-primary" type="submit">解锁并继续</button></form><button class="back-button" type="button" data-action="manage-providers">返回 Provider</button></section></div>`;
}

function renderProposals() {
  const proposals = state.database.ai.proposals.filter((proposal) => proposal.status === 'pending');
  return `${pageHeading('分类结构建议', 'settings')}<div class="proposal-list">${proposals.map((proposal) => state.proposalEditingId === proposal.id ? `<section class="section-card"><h2>调整分类方案</h2><form id="proposal-form" data-id="${proposal.id}">${(proposal.groups ?? []).map((group, index) => `<div class="proposal-edit-row"><label>现有分类（用 / 分隔）<input name="from-${index}" value="${escapeHtml((group.from ?? []).join(' / '))}" required /></label><label>归纳为<input name="to-${index}" value="${escapeHtml(group.to ?? '')}" required /></label></div>`).join('')}<div class="section-actions"><button class="button button-primary button-small" type="submit">保存并应用</button><button class="button button-ghost button-small" type="button" data-action="cancel-proposal-edit">取消</button></div></form></section>` : `<section class="section-card"><h2>${escapeHtml(proposal.summary || '分类结构建议')}</h2>${(proposal.groups ?? []).map((group) => `<p>${escapeHtml((group.from ?? []).join(' / '))} → ${escapeHtml(group.to ?? '')}</p>`).join('')}<div class="section-actions"><button class="button button-primary button-small" type="button" data-action="apply-proposal" data-id="${proposal.id}">应用方案</button><button class="button button-ghost button-small" type="button" data-action="edit-proposal" data-id="${proposal.id}">调整方案</button><button class="button button-ghost button-small" type="button" data-action="dismiss-proposal" data-id="${proposal.id}">保持现有</button></div></section>`).join('') || '<div class="empty-state compact-empty"><p>暂无分类结构建议</p></div>'}</div>`;
}

function decodePackageText(file) {
  try { return decodeURIComponent(Array.from(atob(String(file.content ?? '').replace(/\n/g, '')), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')); } catch { return ''; }
}

function renderPackageDetail() {
  const asset = state.database.assets.find((item) => item.id === state.packageAssetId);
  const record = state.packageRecord;
  if (!asset || !record) return `${pageHeading('Skill 文件', 'library')}<div class="empty-state"><p>无法读取本地 Skill 文件。</p></div>`;
  return `${renderReadOnlyBanner()}${pageHeading(asset.title, 'library')}<section class="section-card package-source"><h2>GitHub Skill</h2><p>${escapeHtml(asset.skillPackage.source.repository)} · ${escapeHtml(asset.skillPackage.source.directory)} · ${escapeHtml(asset.skillPackage.source.commit.slice(0, 7))}</p><div class="section-actions"><button class="button button-ghost button-small" type="button" data-action="update-github-skill" data-id="${asset.id}">检查 GitHub 更新</button><button class="button button-ghost button-small pin-button ${asset.pinned ? 'is-pinned' : ''}" type="button" data-action="toggle-pin" data-id="${asset.id}">${asset.pinned ? '已置顶' : '置顶'}</button><button class="button button-ghost button-small" type="button" data-action="copy-asset" data-id="${asset.id}">复制 SKILL.md</button><button class="button button-ghost button-small" type="button" data-action="delete-asset" data-id="${asset.id}">永久删除</button></div></section><div class="package-category">${categoryOptions('skill', 'normal', asset.categoryId, state.packageCategoryCreating)}</div><div class="package-tree">${record.files.map((file) => `<details class="package-file" ${file.path === 'SKILL.md' ? 'open' : ''}><summary>${escapeHtml(file.path)} <span>${Math.ceil(file.size / 1024)} KB</span></summary>${isTextFile(file.path, file.contentType) ? `${/\.(py|sh|bash|zsh|ps1|js|mjs|cjs)$/i.test(file.path) ? '<p class="script-note">仅保存，不执行。</p>' : ''}<pre>${escapeHtml(decodePackageText(file))}</pre>` : '<p class="script-note">二进制资源：仅保存，不执行。</p>'}</details>`).join('')}</div>`;
}

function renderLockReset() {
  return `<div class="gate"><section class="gate-card"><div class="gate-icon">${lockIcon()}</div><h1>设置新的隐私锁</h1><p>重设后可直接进入私密库并设置新密码。</p><form class="editor-form" id="reset-lock-form"><div class="field"><label>新密码<input id="reset-password" type="password" minlength="6" autocomplete="new-password" required /></label></div><div class="field"><label>再次输入密码<input id="reset-confirm" type="password" minlength="6" autocomplete="new-password" required /></label></div><p class="form-help" id="reset-error" hidden></p><button class="button button-primary" type="submit">设置新密码</button></form><button class="back-button" type="button" data-action="settings">返回设置</button></section></div>`;
}

function renderSites() {
  const enabled = new Set(state.database.settings.inPlace.sites);
  const extra = state.database.settings.inPlace.sites.filter((origin) => !SITE_PRESETS.some((preset) => preset.origin === origin));
  const presetRows = SITE_PRESETS.map((preset) => `<div class="setting-row"><div><div class="setting-title">${escapeHtml(preset.label)}</div><div class="setting-description">${escapeHtml(siteHost(preset.origin))}</div></div><button class="button button-ghost button-small" type="button" data-action="${enabled.has(preset.origin) ? 'disable-site' : 'enable-site'}" data-origin="${escapeHtml(preset.origin)}">${enabled.has(preset.origin) ? '停用' : '启用'}</button></div>`).join('');
  const extraRows = extra.map((origin) => `<div class="setting-row"><div><div class="setting-title">${escapeHtml(siteHost(origin))}</div><div class="setting-description">${escapeHtml(origin)}</div></div><button class="button button-ghost button-small" type="button" data-action="disable-site" data-origin="${escapeHtml(origin)}">停用</button></div>`).join('');
  return `${renderReadOnlyBanner()}${pageHeading('启用站点', 'settings')}<div class="provider-intro">只有启用站点会加载取用面板；FutureContext 只读取你正在输入的输入框里的文字以识别 //。停用会同时撤销该网站的权限。</div><form class="inline-create" id="site-form"><input id="site-origin" placeholder="例如 chat.example.com" required /><button class="button button-primary" type="submit">启用</button></form><div class="settings-list">${presetRows}${extraRows}</div>`;
}

function render() {
  if (!state.database) return;
  if (state.view === 'editor') app.innerHTML = renderEditor();
  else if (state.view === 'categories') app.innerHTML = renderReadOnlyBanner() + renderCategories();
  else if (state.view === 'settings') app.innerHTML = renderSettings();
  else if (state.view === 'sites') app.innerHTML = renderSites();
  else if (state.view === 'providers') app.innerHTML = renderReadOnlyBanner() + renderProviders();
  else if (state.view === 'provider-editor') app.innerHTML = renderReadOnlyBanner() + renderProviderEditor();
  else if (state.view === 'thresholds') app.innerHTML = renderReadOnlyBanner() + renderThresholds();
  else if (state.view === 'ai-unlock') app.innerHTML = renderReadOnlyBanner() + renderAiUnlock();
  else if (state.view === 'proposals') app.innerHTML = renderReadOnlyBanner() + renderProposals();
  else if (state.view === 'package-detail') app.innerHTML = renderPackageDetail();
  else if (state.view === 'reset-lock') app.innerHTML = renderReadOnlyBanner() + renderLockReset();
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
  const baseline = asset
    ? { title: asset.type === 'generic' ? asset.title : '', content: asset.content, categoryId: ['generic', 'skill'].includes(asset.type) ? asset.categoryId : null }
    : { title: '', content: '', categoryId: ['generic', 'skill'].includes(type) && privacy !== 'private' ? state.categoryId : null };
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

async function beginPackageCategoryCreate() {
  state.packageCategoryCreating = true;
  render();
  document.querySelector('#editor-new-category')?.focus();
}

async function createPackageCategory() {
  const name = document.querySelector('#editor-new-category')?.value ?? '';
  try {
    const created = createCategory(state.database, 'skill', name);
    await commit(setAssetCategory(created.database, state.packageAssetId, created.category.id));
    state.packageCategoryCreating = false;
    render();
    showToast('分类已新建并选中');
  } catch (error) {
    showToast(error.message || '新建分类失败。');
  }
}

async function updatePackageCategory(categoryId) {
  const asset = assetById(state.packageAssetId);
  if (!asset) return;
  const nextId = categoryId || null;
  if ((asset.categoryId || null) === nextId && asset.categorySource === 'manual') return;
  try {
    await commit(setAssetCategory(state.database, asset.id, nextId));
    render();
    showToast('分类已更新');
  } catch (error) {
    showToast(error.message || '分类更新失败。');
    render();
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

async function copyText(text, { recordId = null } = {}) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
    if (recordId && !state.readOnly) await commit(recordAssetUse(state.database, recordId));
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
    if (result.queued) void sendBackground({ type: 'schedule-ai' });
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
      if (state.readOnly) {
        showToast('当前为只读，修改不会保存。');
        throw new Error(READ_ONLY_MESSAGE);
      }
      state.database = await removeAssetAndPackage(state.database, id, { persist: saveDatabase, deletePackage });
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
    void sendBackground({ type: 'clear-ai-session' });
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

async function performExport() {
  const packages = await exportPackages(state.database.assets.map((asset) => asset.skillPackage?.packageId));
  const backup = createBackup(state.database, Date.now(), packages);
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
    await importPackages(result.packages, result.packageImports);
    state.categoryId = null;
    render();
    showToast(`已导入 ${result.imported} 项，跳过 ${result.skipped} 项`);
  } catch (error) {
    showToast(error.message || '导入失败，请选择有效的备份文件。');
  } finally {
    backupInput.value = '';
  }
}

async function openAsset(asset) {
  if (!asset) return;
  if (asset.skillPackage?.packageId) {
    state.packageAssetId = asset.id;
    state.packageRecord = await getPackage(asset.skillPackage.packageId);
    state.packageCategoryCreating = false;
    state.view = 'package-detail';
    render();
    return;
  }
  openEditor(asset);
}

async function activateProvider(id) {
  await commit(updateAiSettings(state.database, { activeProviderId: id }));
  render();
  showToast('已设为当前 Provider');
}

function deleteProvider(id) {
  const provider = state.database.ai.providers.find((item) => item.id === id);
  if (!provider) return;
  showConfirm({ title: '删除 Provider', description: `“${provider.label}”的加密 API Key 将被删除。`, actionLabel: '删除 Provider', danger: true, onConfirm: async () => {
    await sendBackground({ type: 'delete-provider', id });
    state.database = await loadDatabase(); state.view = 'providers'; render(); showToast('Provider 已删除');
  } });
}

async function beginAiAction(action) {
  const provider = action.providerId ? state.database.ai.providers.find((item) => item.id === action.providerId) : state.database.ai.providers.find((item) => item.id === state.database.ai.activeProviderId);
  if (!provider) return showToast('请先配置并选择一个 Provider。');
  if (action.providerId && action.providerId !== state.database.ai.activeProviderId) await activateProvider(action.providerId);
  const status = await sendBackground({ type: 'ai-session-status' });
  state.aiUnlockAction = action;
  if (!status.unlocked) { state.view = 'ai-unlock'; return render(); }
  await completeAiAction();
}

async function completeAiAction() {
  const action = state.aiUnlockAction;
  if (!action) return;
  if (action.type === 'test') { await sendBackground({ type: 'test-provider', id: action.providerId ?? state.database.ai.activeProviderId }); showToast('连接测试成功'); state.view = 'providers'; }
  if (action.type === 'organize') { const result = await sendBackground({ type: 'queue-existing' }); showToast(result.count ? `已加入 ${result.count} 项后台整理` : '没有可整理的内容'); state.view = 'settings'; }
  state.aiUnlockAction = null;
  state.database = await loadDatabase(); render();
}

async function resolveProposal(id, action) {
  await commit(resolveStructureProposal(state.database, id, action));
  render();
  showToast(action === 'apply' ? '分类方案已应用' : '已保留当前分类');
}

async function queryContentTab() {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current?.id && !isRestrictedTabUrl(current.url)) return current;
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused?.id && !isRestrictedTabUrl(focused.url)) return focused;
  return current ?? focused ?? null;
}

async function collectGitHubSkillFromPage() {
  try {
    let tabId = state.tabId;
    let tabUrl = state.tabUrl || '';
    await requestOrigins(['https://github.com/*', 'https://api.github.com/*']);
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url) tabUrl = tab.url;
      } catch { /* 打开弹窗时的标签可能已关闭。 */ }
    }
    if (isRestrictedTabUrl(tabUrl)) {
      const tab = await queryContentTab();
      tabId = tab?.id ?? tabId;
      tabUrl = tab?.url || tabUrl;
    }
    const inspection = inspectGitHubSkillUrl(tabUrl);
    if (inspection.kind !== 'skill-file') throw new Error(githubSkillUrlError(inspection.kind));
    if (!tabId) throw new Error('无法读取该文件页的仓库信息，请刷新后重试。');
    const result = await sendBackground({ type: 'collect-github-skill', tabId, url: tabUrl });
    state.database = await loadDatabase(); render();
    showToast(result.duplicate ? '已是当前保存版本' : 'GitHub Skill 已保存');
  } catch (error) { showToast(error.message || '收集 GitHub Skill 失败。'); }
}

async function updateGitHubSkill(id) {
  try {
    const result = await sendBackground({ type: 'update-github-skill', assetId: id });
    state.database = await loadDatabase();
    if (result.changed) { state.packageRecord = await getPackage(result.asset.skillPackage.packageId); render(); showToast('已更新为 GitHub 最新版本'); }
    else showToast('已是当前保存版本');
  } catch (error) { showToast(error.message || '检查 GitHub 更新失败。'); }
}

async function handleClick(event) {
  const button = event.target.closest('button');
  if (!button) {
    if (!event.target.closest('.category-picker') && (state.categoryMenuOpen || state.sortMenuOpen)) {
      state.categoryMenuOpen = false;
      state.sortMenuOpen = false;
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
  if (action === 'open-asset') return openAsset(assetById(button.dataset.id));
  if (action === 'copy-asset') {
    const asset = assetById(button.dataset.id);
    return copyText(formatSkillInsert(asset?.content ?? '', asset?.type), { recordId: button.dataset.id });
  }
  if (action === 'copy-editor') {
    const content = formatSkillInsert(editorValues().content, state.editor?.type);
    return state.editor?.assetId ? copyText(content, { recordId: state.editor.assetId }) : copyText(content);
  }
  if (action === 'new-category-from-editor') return state.view === 'package-detail' ? beginPackageCategoryCreate() : beginEditorCategoryCreate();
  if (action === 'create-category-from-editor') return state.view === 'package-detail' ? createPackageCategory() : createEditorCategory();
  if (action === 'cancel-category-from-editor') {
    if (state.view === 'package-detail') state.packageCategoryCreating = false;
    else if (state.editor) state.editor.categoryCreating = false;
    return render();
  }
  if (action === 'toggle-category-menu') { state.categoryMenuOpen = !state.categoryMenuOpen; state.sortMenuOpen = false; return render(); }
  if (action === 'toggle-sort-menu') { state.sortMenuOpen = !state.sortMenuOpen; state.categoryMenuOpen = false; return render(); }
  if (action === 'set-sort') { try { await commit(setSortBy(state.database, state.activeTab, button.dataset.sort)); state.sortMenuOpen = false; render(); } catch (error) { showToast(error.message || '排序切换失败。'); } return; }
  if (action === 'toggle-pin') { try { const asset = assetById(button.dataset.id); await commit(setAssetPinned(state.database, button.dataset.id, !asset?.pinned)); render(); showToast(asset?.pinned ? '已取消置顶' : '已置顶'); } catch (error) { showToast(error.message || '置顶操作失败。'); } return; }
  if (action === 'dismiss-notice') { state.notice = null; return render(); }
  if (action === 'enable-current-site') { try { await enableSiteOrigin(state.tabOrigin); render(); } catch (error) { showToast(error.message || '启用失败。'); } return; }
  if (action === 'ignore-current-site') { try { await commit(ignoreSite(state.database, state.tabOrigin)); render(); } catch (error) { showToast(error.message || '操作失败。'); } return; }
  if (action === 'manage-sites') { state.view = 'sites'; return render(); }
  if (action === 'enable-site') { try { await enableSiteOrigin(button.dataset.origin); render(); } catch (error) { showToast(error.message || '启用失败。'); } return; }
  if (action === 'disable-site') { try { await disableSiteOrigin(button.dataset.origin); render(); } catch (error) { showToast(error.message || '停用失败。'); } return; }
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
  if (action === 'manage-providers') { state.view = 'providers'; return render(); }
  if (action === 'new-provider') { state.providerEditId = null; state.view = 'provider-editor'; return render(); }
  if (action === 'edit-provider') { state.providerEditId = button.dataset.id; state.view = 'provider-editor'; return render(); }
  if (action === 'activate-provider') return activateProvider(button.dataset.id);
  if (action === 'delete-provider') return deleteProvider(button.dataset.id);
  if (action === 'test-provider') return beginAiAction({ type: 'test', providerId: button.dataset.id });
  if (action === 'organize-existing') return beginAiAction({ type: 'organize' });
  if (action === 'view-proposals') { state.view = 'proposals'; return render(); }
  if (action === 'edit-ai-thresholds') { state.view = 'thresholds'; return render(); }
  if (action === 'apply-proposal') return resolveProposal(button.dataset.id, 'apply');
  if (action === 'dismiss-proposal') return resolveProposal(button.dataset.id, 'dismiss');
  if (action === 'edit-proposal') { state.proposalEditingId = button.dataset.id; return render(); }
  if (action === 'cancel-proposal-edit') { state.proposalEditingId = null; return render(); }
  if (action === 'collect-github-skill') return collectGitHubSkillFromPage();
  if (action === 'update-github-skill') return updateGitHubSkill(button.dataset.id);
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
  if (form.id === 'provider-form') {
    const kind = form.querySelector('#provider-kind').value;
    const provider = {
      id: form.dataset.id || undefined,
      kind,
      label: form.querySelector('#provider-label').value,
      baseUrl: form.querySelector('#provider-base-url').value,
      model: form.querySelector('#provider-model').value,
      apiKey: form.querySelector('#provider-api-key').value
    };
    try {
      await requestOrigins([`${providerOrigin({ baseUrl: provider.baseUrl })}/*`]);
      await sendBackground({ type: 'save-provider', provider, password: form.querySelector('#provider-password').value });
      state.database = await loadDatabase(); state.view = 'providers'; render(); showToast('Provider 已保存');
    } catch (error) { showToast(error.message || '保存 Provider 失败。'); }
    return;
  }
  if (form.id === 'threshold-form') {
    const thresholds = Object.fromEntries(['uncategorized', 'restructureChanges', 'restructureDays'].map((name) => [name, Number(form.elements[name].value)]));
    await commit(updateAiSettings(state.database, { thresholds })); state.view = 'settings'; render(); showToast('整理阈值已保存'); return;
  }
  if (form.id === 'ai-unlock-form') {
    const error = form.querySelector('#ai-unlock-error');
    try { await sendBackground({ type: 'unlock-ai', password: form.querySelector('#ai-unlock-password').value }); await completeAiAction(); }
    catch (reason) { error.textContent = reason.message || '解锁失败。'; error.hidden = false; }
    return;
  }
  if (form.id === 'proposal-form') {
    const proposal = state.database.ai.proposals.find((item) => item.id === form.dataset.id);
    const groups = (proposal?.groups ?? []).map((_, index) => ({ from: form.elements[`from-${index}`].value.split('/'), to: form.elements[`to-${index}`].value }));
    await commit(updateStructureProposal(state.database, form.dataset.id, groups));
    state.proposalEditingId = null;
    await resolveProposal(form.dataset.id, 'apply');
    return;
  }
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
  if (form.id === 'site-form') {
    try {
      const origin = normalizeSiteOrigin(form.querySelector('#site-origin').value);
      await enableSiteOrigin(origin);
      state.view = 'sites';
      render();
    } catch (error) { showToast(error.message || '启用失败。'); }
  }
}

async function initialize() {
  try {
    state.database = await loadDatabase();
    state.readOnly = isReadOnlyDatabase(state.database);
    state.activeTab = ['generic', 'skill', 'aigc'].includes(state.database.settings.lastNormalTab) ? state.database.settings.lastNormalTab : 'generic';
    try {
      const notice = await sendBackground({ type: 'read-notice' });
      if (notice?.message) state.notice = notice.message;
    } catch { /* 后台可能尚未就绪。 */ }
    try {
      const tab = await queryContentTab();
      state.tabId = tab?.id ?? null;
      state.tabUrl = tab?.url ?? '';
      state.tabOrigin = originOfUrl(tab?.url ?? '');
    } catch { /* 无 tabs 权限时跳过。 */ }
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
app.addEventListener('change', (event) => {
  if (event.target.id === 'editor-category' && state.view === 'package-detail') {
    void updatePackageCategory(event.target.value || null);
    return;
  }
  if (event.target.closest('#editor-form')) void persistEditorDraft();
  if (event.target.id === 'ai-enabled') {
    const next = updateAiSettings(state.database, { enabled: event.target.checked });
    void commit(next).then(() => { if (event.target.checked) return sendBackground({ type: 'schedule-ai' }); }).then(() => { render(); showToast(event.target.checked ? '后台 AI 已开启' : '后台 AI 已关闭'); }).catch(() => showToast('更新后台 AI 设置失败。'));
  }
  if (event.target.id === 'inplace-enabled' || event.target.id === 'inplace-trigger') {
    const patch = event.target.id === 'inplace-enabled' ? { enabled: event.target.checked } : { triggerEnabled: event.target.checked };
    void commit(updateInPlaceSettings(state.database, patch)).then(() => sendBackground({ type: 'sync-sites' })).then(() => { render(); showToast('就地取用设置已保存'); }).catch(() => showToast('更新就地取用设置失败。'));
  }
  if (event.target.id === 'provider-kind') {
    const preset = PROVIDER_PRESETS[event.target.value];
    const form = event.target.closest('form');
    if (preset && !form.dataset.id) {
      form.querySelector('#provider-label').value = preset.label;
      form.querySelector('#provider-base-url').value = preset.baseUrl;
      form.querySelector('#provider-model').value = preset.modelHint;
    }
  }
});
app.addEventListener('submit', (event) => { void handleSubmit(event); });
backupInput.addEventListener('change', () => { void importBackup(backupInput.files[0]); });
confirmDialog.addEventListener('close', () => {
  if (confirmDialog.returnValue === 'confirm') void confirmCallback?.();
  confirmCallback = null;
});

initialize();
