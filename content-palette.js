(() => {
  try { window.__futureContextPalette?.destroy?.(); } catch { /* 扩展重载后旧脚本上下文已失效。 */ }

  const SHORTCUT_LABEL = 'Alt+Shift+F';
  const unbind = [];
  let host = null;
  let shadow = null;
  let panel = null;
  let toastHost = null;
  let toastShadow = null;
  let open = false;
  let mode = 'inline';
  let target = null;
  let anchorOffset = 0;
  let savedRange = null;
  let savedInputRange = null;
  let items = [];
  let selected = 0;
  let triggerEnabled = true;
  let queryInput = null;
  let openedAt = 0;
  let dismissTimer = 0;
  let queryGen = 0;
  const INLINE_DISMISS_MS = 80;

  const isField = (el) => el.matches('textarea, input');
  const editableAttr = (el) => {
    if (!el) return false;
    if (el.matches('textarea, input[type="text"], input[type="search"], input:not([type])')) return true;
    if (!el.matches('[contenteditable]')) return false;
    const v = el.getAttribute('contenteditable');
    return v === '' || v === 'true' || v === 'plaintext-only';
  };
  const editableFrom = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) el = el?.parentElement;
    while (el) {
      if (editableAttr(el)) return el;
      el = el.parentElement;
    }
    return null;
  };

  async function bg(type, payload = {}, silent = false) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await chrome.runtime.sendMessage({ type, ...payload });
        if (!res?.ok) throw new Error(res?.error || '后台失败');
        return res.result;
      } catch {
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    if (!silent) close();
    return null;
  }

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;top:0;left:0;width:0;height:0;';
    (document.body || document.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `.fc-palette{pointer-events:auto;background:#fff;border:1px solid #dfe5ed;border-radius:10px;box-shadow:0 12px 30px #26384a18;font-family:Inter,"Microsoft YaHei UI",system-ui,sans-serif;overflow:hidden;position:fixed}.fc-search{width:100%;border:0;border-bottom:1px solid #edf0f4;box-sizing:border-box;font-size:13px;outline:0;padding:10px 12px}.fc-list{max-height:320px;overflow:auto;padding:4px}.fc-item{align-items:flex-start;background:transparent;border:0;border-radius:6px;color:#273141;cursor:pointer;display:grid;gap:2px;padding:8px 10px;text-align:left;width:100%}.fc-item.is-active{background:#edf3fa;color:#41668f}.fc-type{color:#8b96a5;font-size:11px}.fc-title{font-size:13px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc-preview{color:#8994a2;font-size:11px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc-pin{color:#5c7fa9;font-size:10px;font-weight:500;margin-left:6px}.fc-item-wrap{position:relative}.fc-empty{color:#8b96a5;font-size:12px;line-height:1.5;padding:14px 12px}.fc-empty-hint{color:#9aa4b2;font-size:11px;margin-top:4px}`;
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

  // 与 in-place.js 保持一致：只挡掉以 :// 结尾的 URL 协议，不挡行首 //。
  function shouldTrigger(before) {
    const text = String(before ?? '');
    if (!text.endsWith('//')) return false;
    if (text.endsWith('://')) return false;
    if (text.endsWith('///')) return false;
    return true;
  }

  function slashCompletesTrigger(before) {
    const text = String(before ?? '');
    if (!text.endsWith('/')) return false;
    if (text.endsWith('//')) return false;
    if (text.endsWith(':/')) return false;
    return true;
  }

  function inlineAnchorQuery(before, pos, anchorOffset, caretUnknown = false) {
    if (caretUnknown) return null;
    if (!Number.isFinite(pos) || pos < anchorOffset + 2) return false;
    const text = String(before ?? '');
    if (text.slice(anchorOffset, anchorOffset + 2) !== '//') return false;
    const query = text.slice(anchorOffset + 2, pos);
    if (query.includes('\n')) return false;
    return query;
  }

  function caretRange(el) {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (range.startContainer !== el && !el.contains(range.startContainer)) return null;
    return range;
  }

  function textBeforeCaret(el) {
    if (isField(el)) return el.value.slice(0, el.selectionStart ?? 0);
    const range = caretRange(el);
    if (!range) return '';
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let out = '';
      let node;
      while ((node = walker.nextNode())) {
        const len = node.textContent.length;
        if (range.comparePoint(node, 0) > 0) break;
        if (range.comparePoint(node, len) <= 0) {
          out += node.textContent;
          continue;
        }
        if (node === range.startContainer && node.nodeType === Node.TEXT_NODE) {
          out += node.textContent.slice(0, range.startOffset);
        } else {
          let i = 0;
          while (i < len && range.comparePoint(node, i) < 0) i += 1;
          out += node.textContent.slice(0, i);
        }
        break;
      }
      return out;
    } catch {
      try {
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(range.startContainer, range.startOffset);
        return pre.toString();
      } catch { return ''; }
    }
  }

  function caretCharOffset(el) {
    if (isField(el)) return el.selectionStart ?? 0;
    return textBeforeCaret(el).length;
  }

  function charOffsetsToRange(el, start, end) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let startNode;
    let startOff = 0;
    let endNode;
    let endOff = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (!startNode && seen + len >= start) {
        startNode = node;
        startOff = start - seen;
      }
      if (seen + len >= end) {
        endNode = node;
        endOff = end - seen;
        break;
      }
      seen += len;
    }
    if (!startNode) return null;
    const range = document.createRange();
    range.setStart(startNode, Math.max(0, startOff));
    range.setEnd(endNode || startNode, endNode ? Math.max(0, endOff) : Math.max(0, startOff));
    return range;
  }

  function saveSelection(el) {
    if (isField(el)) savedInputRange = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
    else { const sel = document.getSelection(); savedRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null; }
  }

  function restoreSelection(el) {
    if (isField(el) && savedInputRange) el.setSelectionRange(savedInputRange.start, savedInputRange.end);
    else if (savedRange) { const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); }
  }

  function selectInlineRange(el, start, end) {
    if (isField(el)) {
      el.setSelectionRange(start, end);
      return;
    }
    const range = charOffsetsToRange(el, start, end);
    if (!range) return;
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
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
    if (!panel) return;
    const body = !items.length
      ? `<div class="fc-empty">没有匹配的资产<div class="fc-empty-hint">可在 FutureContext 弹窗中新建</div></div>`
      : `<div class="fc-list">${items.map((item, i) => `<div class="fc-item-wrap"><button type="button" class="fc-item ${i === selected ? 'is-active' : ''}" data-i="${i}"><span class="fc-type">${item.typeLabel}${item.pinned ? '<span class="fc-pin">置顶</span>' : ''}</span><span class="fc-title">${escapeHtml(item.title)}</span><span class="fc-preview">${escapeHtml(item.preview)}</span></button></div>`).join('')}</div>`;
    if (mode === 'standalone') {
      let search = panel.querySelector('.fc-search');
      if (!search) {
        panel.innerHTML = `<input class="fc-search" type="search" placeholder="搜索资产…" autocomplete="off" />`;
        search = panel.querySelector('.fc-search');
        search.addEventListener('input', () => { void runQuery(search.value); });
      }
      queryInput = search;
      panel.querySelectorAll('.fc-list, .fc-empty').forEach((node) => node.remove());
      const wrap = document.createElement('div');
      wrap.innerHTML = body;
      while (wrap.firstChild) panel.appendChild(wrap.firstChild);
    } else {
      panel.innerHTML = body;
    }
    panel.querySelectorAll('.fc-item').forEach((btn) => btn.addEventListener('mousedown', (e) => { e.preventDefault(); void insert(Number(btn.dataset.i)); }));
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
  }

  async function runQuery(q) {
    const gen = ++queryGen;
    const result = await bg('palette-query', { query: q }, true);
    if (!open || gen !== queryGen) return;
    items = Array.isArray(result) ? result : [];
    selected = 0;
    renderList();
    positionPanel();
  }

  function cancelDismiss() {
    if (!dismissTimer) return;
    clearTimeout(dismissTimer);
    dismissTimer = 0;
  }

  function addOpenListeners() {
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onOutside, true);
    if (mode === 'standalone') document.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
  }

  function close() {
    if (!open) return;
    open = false;
    mode = 'inline';
    anchorOffset = 0;
    openedAt = 0;
    queryGen += 1;
    cancelDismiss();
    savedRange = null;
    savedInputRange = null;
    queryInput = null;
    if (panel) { panel.hidden = true; panel.style.visibility = ''; }
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('resize', positionPanel);
    window.removeEventListener('scroll', positionPanel, true);
  }

  async function openInline(el) {
    ensureHost();
    cancelDismiss();
    target = el;
    mode = 'inline';
    open = true;
    openedAt = Date.now();
    selected = 0;
    items = [];
    anchorOffset = Math.max(0, caretCharOffset(el) - 2);
    renderList();
    positionPanel();
    addOpenListeners();
    await runQuery('');
  }

  async function openStandalone(el) {
    ensureHost();
    cancelDismiss();
    target = el;
    mode = 'standalone';
    open = true;
    openedAt = Date.now();
    selected = 0;
    items = [];
    saveSelection(el);
    queryInput = null;
    renderList();
    positionPanel();
    queryInput?.focus();
    addOpenListeners();
    await runQuery('');
  }

  function liveTarget() {
    if (target?.isConnected) return target;
    const el = editableFrom(document.activeElement);
    if (el) target = el;
    return target;
  }

  function readInlineQuery() {
    const el = liveTarget();
    if (!el) return false;
    const caretUnknown = !isField(el) && !caretRange(el);
    return inlineAnchorQuery(textBeforeCaret(el), caretCharOffset(el), anchorOffset, caretUnknown);
  }

  function scheduleInlineCheck() {
    if (!open || mode !== 'inline') return;
    const q = readInlineQuery();
    if (q === null) return;
    if (q === false) {
      if (Date.now() - openedAt < INLINE_DISMISS_MS) return;
      scheduleDismiss();
      return;
    }
    cancelDismiss();
    void runQuery(q);
  }

  function scheduleDismiss() {
    if (dismissTimer) return;
    dismissTimer = setTimeout(() => {
      dismissTimer = 0;
      if (!open || mode !== 'inline') return;
      const q = readInlineQuery();
      if (q === false) close();
      else if (q !== null) void runQuery(q);
    }, INLINE_DISMISS_MS);
  }

  function considerOpen(el) {
    if (!triggerEnabled || open || !el) return;
    if (isField(el) && el.selectionStart !== el.selectionEnd) return;
    if (!isField(el) && !caretRange(el)) return;
    const before = textBeforeCaret(el);
    if (shouldTrigger(before)) void openInline(el);
  }

  function interceptCompletingSlash(e, el) {
    if (!el) return false;
    if (open && mode === 'inline') {
      e.stopImmediatePropagation();
      return true;
    }
    if (!open && slashCompletesTrigger(textBeforeCaret(el))) {
      e.stopImmediatePropagation();
      return true;
    }
    return false;
  }

  function onDocInput(e) {
    if (inHost(e)) return;
    const el = editableFrom(e.target) || editableFrom(document.activeElement);
    if (open) {
      if (mode === 'inline') scheduleInlineCheck();
      return;
    }
    considerOpen(el);
  }

  function onBeforeInput(e) {
    if (!triggerEnabled || inHost(e)) return;
    const el = editableFrom(e.target) || editableFrom(document.activeElement);
    const data = e.data;
    if (typeof data === 'string' && data.includes('/')) interceptCompletingSlash(e, el);
    if (open || typeof data !== 'string' || !data.includes('/')) return;
    if (!el) return;
    queueMicrotask(() => considerOpen(el));
  }

  function onDocKeyDown(e) {
    if (!triggerEnabled || inHost(e)) return;
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    interceptCompletingSlash(e, editableFrom(e.target) || editableFrom(document.activeElement));
  }

  function onKeyUp(e) {
    if (!triggerEnabled || open || inHost(e)) return;
    considerOpen(editableFrom(e.target) || editableFrom(document.activeElement));
  }

  function onSelectionChange() {
    if (!open || mode !== 'inline') return;
    scheduleInlineCheck();
  }

  function inHost(e) { return Boolean(host) && e.composedPath().includes(host); }
  function inTarget(e) { return Boolean(target) && e.composedPath().includes(target); }

  function onOutside(e) {
    if (!open || inHost(e)) return;
    if (!e.isTrusted) return;
    if (inTarget(e)) return;
    if (mode === 'inline' && Date.now() - openedAt < INLINE_DISMISS_MS) return;
    close();
  }

  function onFocusOut(e) {
    if (!open || mode !== 'standalone' || !target) return;
    if (inHost(e)) return;
    const next = e.relatedTarget;
    if (next && (host === next || host?.contains(next) || (queryInput && (next === queryInput || queryInput.contains(next))))) return;
    queueMicrotask(() => {
      if (!open || mode !== 'standalone') return;
      if (shadow?.activeElement === queryInput) return;
      close();
    });
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
    if (isField(el)) {
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
    const start = anchorOffset;
    const pos = caretCharOffset(el);
    const insertId = item.id;
    close();
    const result = await bg('palette-insert', { id: insertId });
    if (!result?.content) return;
    el.focus();
    if (m === 'inline') selectInlineRange(el, start, pos ?? start);
    else restoreSelection(el);
    await new Promise((r) => setTimeout(r, 30));
    const ok = await writeText(el, result.content);
    if (!ok) {
      try { await navigator.clipboard.writeText(result.content); showToast('已复制，请粘贴到输入框'); } catch { showToast('写入失败，请手动粘贴'); }
    }
  }

  function bind(targetEl, type, handler, opts) {
    targetEl.addEventListener(type, handler, opts);
    unbind.push(() => targetEl.removeEventListener(type, handler, opts));
  }

  let armed = false;

  function destroy() {
    close();
    unbind.splice(0).forEach((off) => { try { off(); } catch { /* 旧监听可能已失效 */ } });
    host?.remove();
    toastHost?.remove();
    host = null;
    shadow = null;
    panel = null;
    toastHost = null;
    toastShadow = null;
    armed = false;
    if (window.__futureContextPalette?.destroy === destroy) delete window.__futureContextPalette;
  }

  function arm() {
    if (armed) return;
    bind(document, 'input', onDocInput, true);
    bind(document, 'keyup', onKeyUp, true);
    bind(document, 'keydown', onDocKeyDown, true);
    bind(document, 'beforeinput', onBeforeInput, true);
    bind(document, 'compositionend', onDocInput, true);
    bind(document, 'selectionchange', onSelectionChange);
    armed = true;
    window.__futureContextPalette = { destroy, openFromShortcut };
  }

  function applySettings(s) {
    if (!s) return;
    if (s.enabled === false) {
      destroy();
      return;
    }
    triggerEnabled = s.triggerEnabled !== false;
    arm();
  }

  function openFromShortcut() {
    if (!armed) return false;
    if (!document.hasFocus()) return false;
    const el = editableFrom(document.activeElement);
    if (!el) {
      showToast(`请先点击一个输入框，再按 ${SHORTCUT_LABEL}`);
      return false;
    }
    void openStandalone(el);
    return true;
  }

  function onMessage(msg) {
    if (msg?.type === 'fc-destroy') { destroy(); return; }
    if (msg?.type === 'fc-settings') { applySettings(msg); return; }
    if (!armed) return;
    if (msg.type === 'fc-ping') return;
    if (msg.type === 'fc-toast') showToast(msg.text);
    if (msg.type === 'fc-open-palette') openFromShortcut();
  }

  if (globalThis.__fcPaletteOnMessage) {
    try { chrome.runtime.onMessage.removeListener(globalThis.__fcPaletteOnMessage); } catch { /* 旧监听可能已失效。 */ }
  }
  globalThis.__fcPaletteOnMessage = onMessage;
  chrome.runtime.onMessage.addListener(onMessage);

  arm();
  void bg('palette-settings', {}, true).then((s) => applySettings(s));
})();
