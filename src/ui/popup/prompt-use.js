import { escapeHtml } from '../markup.js';
import { fillPromptTemplate, parsePromptTemplate } from '../../core/prompt-template.js';

// This session is intentionally separate from persisted editor drafts.
export function createPromptUse({ onCopy, onExit, onEdit, validateSession }) {
  let session = null;

  function open(asset, { fromEditor = false } = {}) {
    const template = parsePromptTemplate(asset.content);
    session = { asset: structuredClone(asset), template, values: Object.create(null), view: 'fill', fromEditor, busy: false, error: '' };
  }

  function render() {
    const { template, values, fromEditor } = session;
    const seen = new Set();
    const document = template.segments.map((segment) => {
      if (segment.name === undefined) return escapeHtml(segment.text);
      const index = template.names.indexOf(segment.name);
      const repeated = seen.has(segment.name);
      seen.add(segment.name);
      return `<textarea class="prompt-variable" rows="1" data-variable="${index}" aria-label="${escapeHtml(segment.name)}" placeholder="${escapeHtml(segment.name)}" ${repeated ? 'tabindex="-1"' : ''}>${escapeHtml(values[segment.name] ?? '')}</textarea>`;
    }).join('');
    return `<div class="prompt-mode-tabs"><button class="button button-soft" type="button" aria-current="page">使用</button><button class="button button-ghost" type="button" data-action="prompt-edit">${fromEditor ? '继续编辑' : '编辑'}</button></div>
      <form id="prompt-use-form" class="prompt-use-form">
        <div class="prompt-use-toolbar"><div><button type="button" class="button button-small" data-action="prompt-fill">填写</button><button type="button" class="button button-small" data-action="prompt-result">渲染结果</button></div><span id="prompt-progress" class="form-help"></span></div>
        <div id="prompt-fill" class="prompt-document">${document}</div>
        <pre id="prompt-result" class="prompt-document" hidden></pre>
        <p id="prompt-use-error" class="form-help editor-error" role="alert" hidden></p>
        <p class="form-help">本次填写仅用于生成结果，不修改收藏，关闭后不保留。</p>
        <div class="editor-footer"><button type="button" class="button button-ghost" data-action="prompt-clear">清空</button><button type="submit" class="button button-primary">复制结果</button></div>
      </form>`;
  }

  function feedback() {
    const form = document.querySelector('#prompt-use-form');
    if (!session || !form) return;
    const problem = validateSession(session);
    const { names } = session.template;
    const missing = names.filter((name) => !session.values[name]?.trim());
    form.querySelector('#prompt-progress').textContent = `已填写 ${names.length - missing.length}/${names.length}`;
    form.querySelector('#prompt-result').textContent = fillPromptTemplate(session.template, session.values, { preview: true });
    form.querySelector('#prompt-fill').hidden = session.view !== 'fill';
    form.querySelector('#prompt-result').hidden = session.view !== 'result';
    form.querySelectorAll('[data-action="prompt-fill"], [data-action="prompt-result"]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.action === `prompt-${session.view}`));
    });
    const error = form.querySelector('#prompt-use-error');
    error.textContent = problem || session.error;
    error.hidden = !error.textContent;
    form.setAttribute('aria-busy', String(session.busy));
    for (const control of form.elements) control.disabled = session.busy;
    form.querySelector('[type="submit"]').disabled = session.busy || Boolean(problem);
  }

  function input(field) {
    if (!session || field.dataset.variable === undefined || session.busy) return;
    const name = session.template.names[Number(field.dataset.variable)];
    session.values[name] = field.value;
    session.error = '';
    document.querySelectorAll(`#prompt-use-form [data-variable="${field.dataset.variable}"]`).forEach((other) => {
      if (other !== field) other.value = field.value;
      other.style.height = 'auto';
      other.style.height = `${Math.max(34, other.scrollHeight)}px`;
    });
    feedback();
  }

  async function copy() {
    const current = session;
    if (!current || current.busy) return;
    try {
      const problem = validateSession(current);
      if (problem) throw new Error(problem);
      const content = fillPromptTemplate(current.template, current.values);
      current.busy = true;
      current.error = '';
      feedback();
      await onCopy(content, current);
    } catch (error) {
      current.error = error.message;
      current.view = 'fill';
      const missing = current.template.names.find((name) => !current.values[name]?.trim());
      if (session === current && missing) document.querySelector(`[data-variable="${current.template.names.indexOf(missing)}"]`)?.focus();
    } finally {
      current.busy = false;
      if (session === current) feedback();
    }
  }

  function action(action) {
    if (!session || session.busy) return;
    if (action === 'prompt-back') { const current = session; session = null; onExit(current); return; }
    if (action === 'prompt-edit') { const current = session; session = null; onEdit(current); return; }
    if (action === 'prompt-fill' || action === 'prompt-result') session.view = action.slice(7);
    if (action === 'prompt-clear') {
      session.values = Object.create(null);
      session.error = '';
      document.querySelectorAll('#prompt-use-form [data-variable]').forEach((field) => { field.value = ''; field.style.height = ''; });
    }
    feedback();
  }

  return { open, render, feedback, input, action, copy, clear() { session = null; }, get current() { return session; } };
}
