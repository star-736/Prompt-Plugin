(() => {
  if (window.__futureContextPalette) return;
  window.__futureContextPalette = true;

  const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5"/><path d="M9 3h6l1 7-4 3-4-3z"/></svg>';
  let host = null;
  let shadow = null;
  let panel = null;
  let toastHost = null;
  let toastShadow = null;
  let open = false;
  let mode = 'inline';
  let target = null;
  let anchor = null;
  let savedRange = null;
  let savedInputRange = null;
  let items = [];
  let selected = 0;
  let triggerEnabled = true;
  let queryInput = null;

  const editableAttr = (el) => {
    if (!el) return false;
    if (el.matches('textarea, input[type="text"], input[type="search"], input:not([type])')) return true;
    if (!el.matches('[contenteditable]')) return false;
    const v = el.getAttribute('contenteditable');
    return v === '' || v === 'true' || v === 'plaintext-only';
  };
  const editableFrom = (el) => (el && editableAttr(el) ? el : el?.closest?.('textarea, input[type="text"], input[type="search"], input:not([type]), [contenteditable]'));

  async function bg(type, payload = {}) {
    try {
      const res = await chrome.runtime.sendMessage({ type, ...payload });
      if (!res?.ok) throw new Error(res?.error || '后台失败');
      return res.result;
    } catch { close(); return null; }
  }

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;top:0;left:0;width:0;height:0;';
    (document.body || document.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `.fc-palette{pointer-events:auto;background:#fff;border:1px solid #dfe5ed;border-radius:10px;box-shadow:0 12px 30px #26384a18;font-family:Inter,"Microsoft YaHei UI",system-ui,sans-serif;overflow:hidden;position:fixed}.fc-search{width:100%;border:0;border-bottom:1px solid #edf0f4;box-sizing:border-box;font-size:13px;outline:0;padding:10px 12px}.fc-list{max-height:320px;overflow:auto;padding:4px}.fc-item{align-items:flex-start;background:transparent;border:0;border-radius:6px;color:#273141;cursor:pointer;display:grid;gap:2px;padding:8px 10px;text-align:left;width:100%}.fc-item.is-active{background:#edf3fa;color:#41668f}.fc-type{color:#8b96a5;font-size:11px}.fc-title{font-size:13px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc-preview{color:#8994a2;font-size:11px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc-pin{color:#5c7fa9;height:12px;position:absolute;right:10px;top:10px;width:12px;fill:none;stroke:currentColor;stroke-width:1.8}.fc-item-wrap{position:relative}.fc-empty{color:#8b96a5;font-size:12px;line-height:1.5;padding:14px 12px}.fc-empty-hint{color:#9aa4b2;font-size:11px;margin-top:4px}`;
    shadow.appendChild(style);
    panel = document.createElement('div');
    panel.className = 'fc-palette';
    panel.hidden = true;
    shadow.appendChild(panel);
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  function ensureToast() {
    if (toastHost?.isConnected) return;
    toastHost = document.createElement('div');
    toastHost.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;bottom:16px;right:16px;';
    (document.body || document.documentElement).appendChild(toastHost);
    toastShadow = toastHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.fc-toast{background:#2d4056;border-radius:8px;color:#fff;font-family:Inter,"Microsoft YaHei UI",system-ui,sans-serif;font-size:12px;opacity:0;padding:8px 12px;transition:opacity .12s}.fc-toast.show{opacity:1}';
    toastShadow.appendChild(style);
  }

  function showToast(text) {
    ensureToast();
    let el = toastShadow.querySelector('.fc-toast');
    if (!el) { el = document.createElement('div'); el.className = 'fc-toast'; toastShadow.appendChild(el); }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => el.classList.remove('show'), 2000);
  }

  function caretPos(el) {
    if (el.matches('textarea, input')) return el.selectionStart ?? 0;
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    return range.startOffset;
  }

  function textBefore(el, pos) {
    if (el.matches('textarea, input')) return el.value.slice(0, pos ?? el.selectionStart ?? 0);
    const sel = document.getSelection();
    if (!sel?.rangeCount) return '';
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) return '';
    return range.startContainer.textContent.slice(0, range.startOffset);
  }

  function shouldTrigger(before) {
    if (!before.endsWith('//')) return false;
    if (before.endsWith(':///') || before.endsWith('://') || before.endsWith('///')) return false;
    return true;
  }

  function saveSelection(el) {
    if (el.matches('textarea, input')) savedInputRange = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
    else { const sel = document.getSelection(); savedRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null; }
  }

  function restoreSelection(el) {
    if (el.matches('textarea, input') && savedInputRange) el.setSelectionRange(savedInputRange.start, savedInputRange.end);
    else if (savedRange) { const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); }
  }

  function selectInlineRange(el, start, end) {
    if (el.matches('textarea, input')) el.setSelectionRange(start, end);
    else if (anchor?.node) {
      const range = document.createRange();
      range.setStart(anchor.node, anchor.offset);
      range.setEnd(anchor.node, end);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  function positionPanel() {
    if (!target || !panel) return;
    const rect = target.getBoundingClientRect();
    const width = Math.min(560, Math.max(360, rect.width));
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, rect.left))}px`;
    panel.hidden = false;
    panel.style.visibility = 'hidden';
    const h = panel.offsetHeight || 240;
    let top = rect.top - h - 8;
    if (top < 8) top = rect.bottom + 8;
    panel.style.top = `${top}px`;
    panel.style.visibility = '';
  }

  function renderList() {
    if (!items.length) {
      panel.innerHTML = `<div class="fc-empty">没有匹配的资产<div class="fc-empty-hint">可在 FutureContext 弹窗中新建</div></div>`;
      return;
    }
    panel.innerHTML = `<div class="fc-list">${items.map((item, i) => `<div class="fc-item-wrap">${item.pinned ? PIN_SVG.replace('<svg', '<svg class="fc-pin"') : ''}<button type="button" class="fc-item ${i === selected ? 'is-active' : ''}" data-i="${i}"><span class="fc-type">${item.typeLabel}</span><span class="fc-title">${escapeHtml(item.title)}</span><span class="fc-preview">${escapeHtml(item.preview)}</span></button></div>`).join('')}</div>`;
    panel.querySelectorAll('.fc-item').forEach((btn) => btn.addEventListener('mousedown', (e) => { e.preventDefault(); void insert(Number(btn.dataset.i)); }));
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
  }

  async function runQuery(q) {
    const result = await bg('palette-query', { query: q });
    if (result === null) return;
    items = result;
    selected = 0;
    renderList();
    positionPanel();
  }

  function close() {
    if (!open) return;
    open = false;
    mode = 'inline';
    anchor = null;
    savedRange = null;
    savedInputRange = null;
    queryInput = null;
    if (panel) { panel.hidden = true; panel.innerHTML = ''; }
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('resize', positionPanel);
    window.removeEventListener('scroll', positionPanel, true);
    document.removeEventListener('selectionchange', onSelectionChange);
  }

  async function openInline(el) {
    ensureHost();
    target = el;
    mode = 'inline';
    open = true;
    selected = 0;
    const pos = caretPos(el);
    anchor = el.matches('textarea, input') ? { node: null, offset: pos - 2 } : { node: document.getSelection()?.anchorNode ?? null, offset: (pos ?? 2) - 2 };
    panel.innerHTML = '';
    panel.hidden = false;
    await runQuery('');
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
    document.addEventListener('selectionchange', onSelectionChange);
  }

  async function openStandalone(el) {
    ensureHost();
    target = el;
    mode = 'standalone';
    open = true;
    selected = 0;
    saveSelection(el);
    panel.innerHTML = `<input class="fc-search" type="search" placeholder="搜索资产…" autocomplete="off" />`;
    panel.hidden = false;
    queryInput = panel.querySelector('.fc-search');
    queryInput.addEventListener('input', () => { void runQuery(queryInput.value); });
    queryInput.focus();
    await runQuery('');
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
  }

  function inlineStillValid(el) {
    if (!anchor) return false;
    const pos = caretPos(el);
    if (pos === null || pos < anchor.offset) return false;
    const before = textBefore(el, pos);
    const slice = before.slice(anchor.offset, anchor.offset + 2);
    if (slice !== '//') return false;
    const query = before.slice(anchor.offset + 2, pos);
    if (query.includes('\n')) return false;
    return query;
  }

  function onInput(e) {
    if (!triggerEnabled || open) return;
    const el = editableFrom(e.target);
    if (!el) return;
    if (el.matches('textarea, input') && el.selectionStart !== el.selectionEnd) return;
    const before = textBefore(el, caretPos(el));
    if (shouldTrigger(before)) void openInline(el);
  }

  function onSelectionChange() {
    if (!open || mode !== 'inline' || !target) return;
    const q = inlineStillValid(target);
    if (q === false) return close();
    void runQuery(q);
  }

  function onInlineInput(e) {
    if (!open || mode !== 'inline') return;
    onSelectionChange();
  }

  function inHost(e) { return e.composedPath().includes(host); }

  function onOutside(e) {
    if (!open || inHost(e)) return;
    close();
  }

  function onFocusOut(e) {
    if (!open || !target) return;
    if (inHost(e)) return;
    if (e.target === target || target.contains(e.target)) close();
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); return close(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); selected = items.length ? (selected + 1) % items.length : 0; renderList(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); selected = items.length ? (selected - 1 + items.length) % items.length : 0; renderList(); return; }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      if (items.length) { e.preventDefault(); e.stopImmediatePropagation(); void insert(selected); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); }
    }
  }

  async function writeText(el, content) {
    if (el.matches('textarea, input')) {
      const before = el.value;
      el.focus();
      if (document.execCommand('insertText', false, content) && el.value !== before) return true;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (proto) proto.call(el, before.slice(0, start) + content + before.slice(end));
      else el.value = before.slice(0, start) + content + before.slice(end);
      const pos = start + content.length;
      el.setSelectionRange(pos, pos);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }));
      return el.value !== before;
    }
    const before = el.innerText;
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', content);
    if (el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) && el.innerText !== before) return true;
    if (document.execCommand('insertText', false, content) && el.innerText !== before) return true;
    return el.innerText !== before;
  }

  async function insert(index) {
    const item = items[index];
    if (!item || !target) return close();
    const el = target;
    const m = mode;
    const anc = anchor;
    const pos = caretPos(el);
    const insertId = item.id;
    close();
    const result = await bg('palette-insert', { id: insertId });
    if (!result?.content) return;
    el.focus();
    if (m === 'inline') selectInlineRange(el, anc.offset, pos ?? anc.offset);
    else restoreSelection(el);
    await new Promise((r) => setTimeout(r, 30));
    const ok = await writeText(el, result.content);
    if (!ok) {
      try { await navigator.clipboard.writeText(result.content); showToast('已复制，请粘贴到输入框'); } catch { showToast('写入失败，请手动粘贴'); }
    }
  }

  void bg('palette-settings').then((s) => { if (s) triggerEnabled = s.triggerEnabled !== false; });
  document.addEventListener('input', (e) => { onInput(e); onInlineInput(e); }, true);
  document.addEventListener('selectionchange', onSelectionChange);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'fc-toast') showToast(msg.text);
    if (msg.type === 'fc-open-palette') {
      const el = editableFrom(document.activeElement);
      if (!el) return showToast('请先点击一个输入框，再按 Alt+Shift+P');
      void openStandalone(el);
    }
  });
})();
