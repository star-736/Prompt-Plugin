import { escapeHtml } from '../markup.js';
import { createCategory, discardDraft, getDraft, saveAsset, saveDraft, scopeFor } from '../../core/store.js';
import { parsePromptTemplate } from '../../core/prompt-template.js';

// One instance owns one editor lifecycle, including the in-flight draft and save.
export function createAssetEditor({ getDatabase, commit, onChange, onExit, showConfirm, showToast, scheduleAi }) {
  let session = null;

  function editorValues() {
    const form = document.querySelector('#editor-form');
    if (!form) return session?.values ?? {};
    return {
      title: form.querySelector('#editor-title-input')?.value ?? '',
      content: form.querySelector('#editor-content')?.value ?? '',
      categoryId: form.querySelector('#editor-category')?.value || null,
      templateEnabled: form.querySelector('#editor-template-enabled')?.checked === true
    };
  }

  function editorChanged(values = editorValues()) {
    const baseline = session?.baseline ?? { title: '', content: '', categoryId: null };
    return values.title !== baseline.title || values.content !== baseline.content || (values.categoryId || null) !== (baseline.categoryId || null) || Boolean(values.templateEnabled) !== Boolean(baseline.templateEnabled);
  }

  function open({ asset = null, type = asset?.type, privacy = asset?.privacy, categoryId = null } = {}) {
    const reference = { type, privacy, id: asset?.id ?? null };
    const draft = getDraft(getDatabase(), reference);
    const baseline = asset
      ? { title: asset.type === 'generic' ? asset.title : '', content: asset.content, categoryId: ['generic', 'skill', 'command'].includes(asset.type) ? asset.categoryId : null, templateEnabled: asset.templateEnabled === true }
      : { title: '', content: '', categoryId: ['generic', 'skill', 'command'].includes(type) && privacy !== 'private' ? categoryId : null, templateEnabled: false };
    const values = draft ? { title: draft.title ?? '', content: draft.content ?? '', categoryId: draft.categoryId ?? null, templateEnabled: draft.templateEnabled === true } : baseline;
    session = { type, privacy, assetId: asset?.id ?? null, reference, baseline, values };
  }

  function updateEditorFeedback() {
    const editor = session;
    const form = document.querySelector('#editor-form');
    if (!editor || !form) return;
    const error = form.querySelector('#editor-error');
    error.textContent = editor.error ?? '';
    error.hidden = !editor.error;
    const progress = form.querySelector('#editor-progress');
    progress.textContent = editor.slowSave ? '保存仍在进行，结果尚未确认。请保持窗口打开，完成后会更新状态。' : '正在保存，请稍候…';
    const busy = Boolean(editor.saving || editor.closing);
    progress.hidden = !busy;
    form.setAttribute('aria-busy', String(busy));
    for (const control of form.elements) control.disabled = busy;
    form.querySelector('[type="submit"]').textContent = busy ? '正在保存…' : editor.error ? '重试保存' : '保存';
    const summary = form.querySelector('#editor-template-summary');
    if (summary) {
      const values = editorValues();
      form.querySelector('[data-action="copy-editor"]').textContent = values.templateEnabled ? '试用模板' : '复制';
      summary.hidden = !values.templateEnabled;
      try {
        const { names } = parsePromptTemplate(values.content);
        summary.textContent = names.length ? `已识别 ${names.length} 个占位符：${names.join('、')}` : '尚未识别到占位符，可在正文中使用 {{名称}}。';
      } catch (error) { summary.textContent = error.message; }
    }
  }

  function persistEditorDraft() {
    const editor = session;
    if (!editor || editor.saving || editor.closing) return;
    const values = editorValues();
    editor.values = values;
    editor.pendingDraft = values;
    if (editor.draftTask) return editor.draftTask;
    editor.draftTask = (async () => {
      while (editor.pendingDraft && session === editor && !editor.saving && !editor.closing) {
        const snapshot = editor.pendingDraft;
        editor.pendingDraft = null;
        try {
          await commit((db) => {
            if (session !== editor || editor.saving || editor.closing) return null;
            const baseline = editor.baseline;
            const changed = snapshot.title !== baseline.title || snapshot.content !== baseline.content || snapshot.categoryId !== baseline.categoryId || Boolean(snapshot.templateEnabled) !== Boolean(baseline.templateEnabled);
            return changed ? saveDraft(db, editor.reference, snapshot) : discardDraft(db, editor.reference);
          });
          if (editor.errorKind === 'draft') { editor.error = ''; editor.errorKind = null; }
        } catch (error) {
          editor.error = `草稿未保存：${error.message || '请重试。'} 当前输入仍保留，请点击保存。`;
          editor.errorKind = 'draft';
        }
        if (session === editor) updateEditorFeedback();
      }
    })().finally(() => { editor.draftTask = null; });
    return editor.draftTask;
  }

  async function beginEditorCategoryCreate() {
    const editor = session;
    if (!editor || editor.privacy === 'private' || editor.saving || editor.closing) return;
    const values = editorValues();
    editor.values = values;
    try {
      await commit((db) => session === editor && !editor.saving && !editor.closing ? saveDraft(db, editor.reference, values) : null);
      if (session !== editor || editor.saving || editor.closing) return;
      editor.categoryCreating = true;
      onChange();
      document.querySelector('#editor-new-category')?.focus();
    } catch (error) {
      if (session === editor) showToast(error.message || '无法保留当前草稿，请重试。');
    }
  }

  async function createEditorCategory() {
    const editor = session;
    if (!editor || editor.saving || editor.closing) return;
    const name = document.querySelector('#editor-new-category')?.value ?? '';
    let categoryId;
    try {
      await commit((db) => {
        if (session !== editor || editor.saving || editor.closing) return null;
        const created = createCategory(db, scopeFor(editor.type, editor.privacy), name);
        categoryId = created.category.id;
        return saveDraft(created.database, editor.reference, { ...editor.values, categoryId });
      });
      if (session !== editor || editor.saving || editor.closing || !categoryId) return;
      editor.values = { ...editor.values, categoryId };
      editor.categoryCreating = false;
      onChange();
      showToast('分类已新建并选中');
    } catch (error) {
      if (session === editor) showToast(error.message || '新建分类失败。');
    }
  }

  async function returnFromEditor() {
    if (!session || !editorChanged()) return finishEditorReturn();
    showConfirm({
      title: '放弃未保存的更改',
      description: '放弃后，这次编辑草稿将被删除。',
      actionLabel: '放弃草稿',
      danger: true,
      onConfirm: () => finishEditorReturn()
    });
  }

  async function finishEditorReturn() {
    const editor = session;
    if (editor?.saving || editor?.closing) return;
    try {
      if (editor) {
        editor.values = editorValues();
        editor.closing = true;
        editor.pendingDraft = null;
        updateEditorFeedback();
        await editor.draftTask;
        // Reverting to the baseline and immediately going back can cancel a
        // queued draft deletion. Always clear any older draft before leaving.
        await commit((db) => getDraft(db, editor.reference) ? discardDraft(db, editor.reference) : null);
      }
      if (session === editor) { session = null; onExit(); }
    } catch (error) {
      if (editor) { editor.error = error.message || '无法放弃草稿，请重试。'; editor.errorKind = 'save'; }
    } finally {
      if (editor) editor.closing = false;
      if (session === editor) updateEditorFeedback();
    }
  }

  async function saveEditor() {
    const editor = session;
    if (!editor || editor.saving || editor.closing) return;
    const values = editorValues();
    editor.values = values;
    editor.saving = true;
    editor.error = '';
    editor.errorKind = null;
    editor.pendingDraft = null;
    updateEditorFeedback();
    const slowTimer = setTimeout(() => {
      editor.slowSave = true;
      if (session === editor) updateEditorFeedback();
    }, 10000);
    const input = { id: editor.assetId, type: editor.type, privacy: editor.privacy, ...values };
    try {
      await editor.draftTask;
      let queued = false;
      await commit((db) => {
        const result = saveAsset(db, input);
        queued = result.queued;
        return result.database;
      });
      if (queued) Promise.resolve().then(scheduleAi).catch(() => {
        showToast('内容已保存，后台整理暂未启动。');
      });
      if (session === editor) {
        session = null;
        onExit();
        showToast('已保存');
      }
    } catch (error) {
      editor.error = error.message || '保存失败，请重试。';
      editor.errorKind = 'save';
    } finally {
      clearTimeout(slowTimer);
      editor.saving = false;
      editor.slowSave = false;
      if (session === editor) updateEditorFeedback();
    }
  }

  function renderEditor({ readOnlyBanner, heading, categories, delivery }) {
    const { type, assetId, values } = session;
    const existing = assetId ? getDatabase().assets.find((asset) => asset.id === assetId) : null;
    const isSkill = type === 'skill';
    const isCommand = type === 'command';
    const titleField = type === 'generic' ? '<div class="field"><label>标题（可选）<input id="editor-title-input" maxlength="120" value="' + escapeHtml(values.title) + '" /></label></div>' : '';
    const contentLabel = isSkill ? 'SKILL.md' : isCommand ? '指令' : '内容';
    const contentHelp = isSkill ? '<p class="form-help">保存时会校验 YAML frontmatter 中的 name 与 description。</p>' : isCommand ? '<p class="form-help">可保存终端命令或浏览器指令，例如 <code>git pull</code>、<code>chrome://restart</code>。</p>' : '';
    const management = existing?.type === 'aigc' ? `<div class="secondary-management">
        <button class="button button-ghost button-small" type="button" data-action="move-asset" data-id="${existing.id}" data-target="${existing.privacy === 'private' ? 'normal' : 'private'}">${existing.privacy === 'private' ? '移出私密库' : '移入私密库'}</button>
        <button class="button button-danger button-small" type="button" data-action="delete-asset" data-id="${existing.id}">永久删除</button>
      </div>` : existing ? `<div class="secondary-management">${existing.privacy === 'normal' ? `<button class="button button-ghost button-small pin-button ${existing.pinned ? 'is-pinned' : ''}" type="button" data-action="toggle-pin" data-id="${existing.id}">${existing.pinned ? '已置顶' : '置顶'}</button>` : ''}<button class="button button-danger button-small" type="button" data-action="delete-asset" data-id="${existing.id}">永久删除</button></div>` : '';
    return `${readOnlyBanner}${heading}<form class="editor-form" id="editor-form">
      ${titleField}
      ${categories}
      ${['generic', 'aigc'].includes(type) ? `<label class="template-toggle"><input id="editor-template-enabled" type="checkbox" ${values.templateEnabled ? 'checked' : ''} />启用占位符模式</label><p class="form-help">使用双花括号，例如 {{场景}}；使用时填写，收藏保留模板原文。</p><p class="form-help" id="editor-template-summary" hidden></p>` : ''}
      <div class="field"><label>${contentLabel}<textarea id="editor-content" class="${isSkill ? 'skill-editor' : isCommand ? 'command-editor' : ''}" ${isSkill ? '' : 'required'}>${escapeHtml(values.content)}</textarea></label>${contentHelp}</div>
      <p class="form-help editor-error" id="editor-error" role="alert" hidden></p>
      <p class="form-help" id="editor-progress" role="status" hidden></p>
      <div class="editor-footer">
        <button class="button button-ghost button-small copy-editor" type="button" data-action="copy-editor">${values.templateEnabled ? '试用模板' : '复制'}</button>
        <span class="status-line">${existing ? `上次保存 ${new Date(existing.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
        <button class="button button-primary button-small" type="submit">保存</button>
      </div>
      ${management}
      ${delivery}
    </form>`;
  }

  return {
    get current() { return session; },
    open,
    render: renderEditor,
    clear() { session = null; },
    values: editorValues,
    capture() { if (session) session.values = editorValues(); },
    feedback: updateEditorFeedback,
    persistDraft: persistEditorDraft,
    save: saveEditor,
    requestReturn: returnFromEditor,
    beginCategoryCreate: beginEditorCategoryCreate,
    createCategory: createEditorCategory,
    cancelCategoryCreate() { if (session) session.categoryCreating = false; }
  };
}
