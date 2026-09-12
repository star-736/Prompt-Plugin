import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { createChromeStub, flush, installDom, loadFreshEntry, waitFor } from './helpers.mjs';

let window, document, stub, clipboard;

const assets = [
  { id: 'g1', type: 'generic', typeLabel: '通用', title: '周报', preview: '总结本周', pinned: true },
  { id: 's1', type: 'skill', typeLabel: 'Skill', title: 'Email reviewer', preview: 'Review email', pinned: false }
];

beforeEach(async () => {
({ window, document, clipboard } = installDom(`<!doctype html><html><body></body></html>`, { url: 'https://chatgpt.com/c/1' }));
stub = createChromeStub({
  sendMessage: async (message) => {
    if (message.type === 'palette-settings') return { ok: true, result: { enabled: true, triggerEnabled: true } };
    if (message.type === 'palette-query') return { ok: true, result: assets.filter((item) => !message.query || item.title.includes(message.query) || item.preview.includes(message.query)) };
    if (message.type === 'palette-insert') return { ok: true, result: { content: message.id === 's1' ? '基于以下 skill 辅助我解决问题\nbody' : '写一封邮件' } };
    return { ok: false, error: `unhandled ${message.type}` };
  }
});

await loadFreshEntry('../content-palette.js');
await waitFor(() => window.__futureContextPalette?.openFromShortcut);
});
afterEach(() => { window.__futureContextPalette?.destroy(); window.close(); });

function field() {
  let el = document.querySelector('textarea');
  if (!el) {
    el = document.createElement('textarea');
    document.body.appendChild(el);
  }
  el.focus();
  return el;
}

function trusted(event) {
  const impl = event[Object.getOwnPropertySymbols(event).find((symbol) => String(symbol) === 'Symbol(impl)')];
  if (impl) {
    Object.defineProperty(impl, 'isTrusted', {
      configurable: true,
      enumerable: true,
      get: () => true,
      set() {}
    });
  }
  return event;
}

function dispatchTrusted(target, event) {
  target.dispatchEvent(trusted(event));
  return event;
}

function paletteShadow() {
  return window.__futureContextPalette?.getShadow?.();
}

test('palette arms and opens from shortcut on a focused textarea', async () => {
  const el = field();
  el.value = 'hello';
  el.setSelectionRange(5, 5);
  assert.equal(window.__futureContextPalette.openFromShortcut(), true);
  await waitFor(() => paletteShadow()?.querySelector('.fc-palette, .fc-search, .fc-item, .fc-empty'));
  const host = document.querySelector('div');
  assert.ok(host);
  assert.equal(host.shadowRoot, null);
});

test('untrusted input cannot open the inline palette', async () => {
  const el = field();
  el.value = '//';
  el.setSelectionRange(2, 2);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush(40);
  assert.equal(paletteShadow()?.querySelector('.fc-item') ?? null, null);
});

test('trusted // trigger opens the inline palette and insert writes into the field', async () => {
  window.__futureContextPalette.destroy();
  stub.listeners.message[0]?.({ type: 'fc-settings', enabled: true, triggerEnabled: true });
  const el = field();
  el.value = '//';
  el.setSelectionRange(2, 2);
  dispatchTrusted(el, new window.Event('input', { bubbles: true }));
  await waitFor(() => paletteShadow()?.querySelector('.fc-item'));
  const panel = paletteShadow();
  assert.ok(panel);
  dispatchTrusted(panel.querySelector('.fc-item'), new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await flush(80);
  assert.equal(el.value, '写一封邮件');
});

test('keyboard navigation, escape, and settings/destroy messages', async () => {
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-settings', enabled: true, triggerEnabled: true }));
  const el = field();
  el.focus();
  window.__futureContextPalette.openFromShortcut();
  await waitFor(() => paletteShadow()?.querySelector('.fc-search, .fc-item, .fc-empty'));
  dispatchTrusted(window, new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  dispatchTrusted(window, new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  dispatchTrusted(window, new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-ping' }));
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-toast', text: '已保存到 FutureContext' }));
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-open-palette' }));
  await flush(30);
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-destroy' }));
  assert.equal(window.__futureContextPalette, undefined);
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-settings', enabled: true, triggerEnabled: false }));
  assert.ok(window.__futureContextPalette);
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-settings', enabled: false }));
});

function rearm(triggerEnabled = true) {
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-settings', enabled: true, triggerEnabled }));
}

test('Enter inserts, slash intercept, beforeinput, and trigger-off', async () => {
  rearm(true);
  const el = field();
  el.value = 'hello';
  el.setSelectionRange(5, 5);
  el.focus();
  assert.equal(window.__futureContextPalette.openFromShortcut(), true);
  await waitFor(() => paletteShadow()?.querySelectorAll('.fc-item').length === 2);
  dispatchTrusted(window, new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitFor(() => el.value === 'hello写一封邮件');
  el.value = '/';
  el.setSelectionRange(1, 1);
  dispatchTrusted(el, new window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
  dispatchTrusted(el, new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, data: '/', inputType: 'insertText' }));
  dispatchTrusted(el, new window.KeyboardEvent('keyup', { key: '/', bubbles: true, cancelable: true }));
  await flush(20);
  rearm(false);
  el.value = '//';
  el.setSelectionRange(2, 2);
  dispatchTrusted(el, new window.Event('input', { bubbles: true }));
  await flush(30);
  assert.equal(paletteShadow()?.querySelector('.fc-palette')?.hidden ?? true, true);
  rearm(true);
});

test('contenteditable search retries and failed insertion falls back to clipboard', async () => {
  rearm(true);
  let failures = 1;
  const originalSend = stub.chrome.runtime.sendMessage.bind(stub.chrome.runtime);
  stub.chrome.runtime.sendMessage = async (message) => {
    if (failures > 0 && message.type === 'palette-query') {
      failures -= 1;
      throw new Error('Extension context invalidated.');
    }
    return originalSend(message);
  };
  const ed = document.createElement('div');
  ed.setAttribute('contenteditable', 'true');
  ed.textContent = 'draft text';
  document.body.appendChild(ed);
  ed.focus();
  const range = document.createRange();
  range.selectNodeContents(ed);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  assert.equal(window.__futureContextPalette.openFromShortcut(), true);
  await waitFor(() => paletteShadow()?.querySelectorAll('.fc-item').length === 2);
  const search = paletteShadow()?.querySelector('.fc-search');
  assert.ok(search);
  {
    search.value = '周报';
    dispatchTrusted(search, new window.Event('input', { bubbles: true }));
    await flush(40);
    assert.equal(paletteShadow().querySelectorAll('.fc-item').length, 1);
    assert.match(paletteShadow().querySelector('.fc-item').textContent, /周报/);
  }
  dispatchTrusted(window, new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  await flush(80);
  assert.equal(failures, 0);
  assert.equal(clipboard(), '写一封邮件');
  assert.equal(ed.textContent, 'draft text');
  stub.chrome.runtime.sendMessage = originalSend;
});

test('inline // dismisses after the trigger is deleted', async () => {
  rearm(true);
  const el = field();
  el.value = '//';
  el.setSelectionRange(2, 2);
  dispatchTrusted(el, new window.Event('input', { bubbles: true }));
  await waitFor(() => paletteShadow()?.querySelector('.fc-item, .fc-empty'));
  await flush(90);
  el.value = '';
  el.setSelectionRange(0, 0);
  dispatchTrusted(el, new window.Event('input', { bubbles: true }));
  document.dispatchEvent(new window.Event('selectionchange'));
  await flush(120);
  assert.equal(paletteShadow().querySelector('.fc-palette').hidden, true);
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-destroy' }));
});

test('failed background query retries twice and leaves the input unchanged', async () => {
  rearm(true);
  const el = field();
  el.value = 'draft';
  el.setSelectionRange(5, 5);
  let attempts = 0;
  stub.chrome.runtime.sendMessage = async (message) => {
    assert.equal(message.type, 'palette-query');
    attempts += 1;
    throw new Error('no background');
  };
  assert.equal(window.__futureContextPalette.openFromShortcut(), true);
  await waitFor(() => attempts === 2);
  await flush(30);
  assert.equal(el.value, 'draft');
  assert.equal(clipboard(), '');
  assert.equal(paletteShadow().querySelectorAll('.fc-item').length, 0);
});
