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
    if (message.type === 'palette-used') return { ok: true, result: { recorded: true } };
    return { ok: false, error: `unhandled ${message.type}` };
  }
});

await loadFreshEntry('../src/content/content-palette.js');
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

test('standalone insertion restores the original textarea selection after searching', async () => {
  const el = field();
  el.value = 'hello world';
  el.setSelectionRange(6, 11);
  assert.equal(window.__futureContextPalette.openFromShortcut(), true);
  await waitFor(() => paletteShadow()?.querySelector('.fc-item'));
  const search = paletteShadow().querySelector('.fc-search');
  search.value = '周报';
  dispatchTrusted(search, new window.Event('input', { bubbles: true }));
  await waitFor(() => paletteShadow().querySelectorAll('.fc-item').length === 1);
  el.setSelectionRange(0, 0);
  dispatchTrusted(window, new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitFor(() => el.value === 'hello 写一封邮件');
  assert.equal(el.selectionStart, el.value.length);
  assert.equal(el.selectionEnd, el.value.length);
});

test('standalone insertion restores the saved contenteditable range before writing', async () => {
  const ed = document.createElement('div');
  ed.setAttribute('contenteditable', 'true');
  ed.textContent = 'hello world';
  document.body.appendChild(ed);
  ed.focus();
  const range = document.createRange();
  range.setStart(ed.firstChild, 6);
  range.setEnd(ed.firstChild, 11);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  assert.equal(window.__futureContextPalette.openFromShortcut(), true);
  await waitFor(() => paletteShadow()?.querySelector('.fc-item'));
  const changed = document.createRange();
  changed.setStart(ed.firstChild, 0);
  changed.collapse(true);
  selection.removeAllRanges();
  selection.addRange(changed);
  let observed;
  document.execCommand = (_command, _ui, content) => {
    const active = selection.getRangeAt(0);
    observed = active.toString();
    active.deleteContents();
    active.insertNode(document.createTextNode(content));
    return true;
  };
  dispatchTrusted(window, new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitFor(() => ed.textContent === 'hello 写一封邮件');
  assert.equal(observed, 'world');
});

afterEach(() => { assets.splice(2); });

async function templateTransport({ prepare, insert } = {}) {
  const { parsePromptTemplate } = await import('../src/core/prompt-template.js');
  const source = '一只 {{动物}}，位于 {{场景}}。{{动物}}';
  assets.push({ id: 'template', type: 'generic', typeLabel: '通用', title: '模板', preview: source, templateEnabled: true });
  const calls = [];
  const original = stub.chrome.runtime.sendMessage;
  stub.chrome.runtime.sendMessage = async (message) => {
    calls.push(message);
    if (message.type === 'palette-template') return prepare ? prepare(message) : { ok: true, result: { content: source, template: parsePromptTemplate(source) } };
    if (message.type === 'palette-insert' && message.id === 'template') return insert ? insert(message) : { ok: true, result: { content: `一只 ${message.values.动物}，位于 ${message.values.场景}。${message.values.动物}` } };
    return original(message);
  };
  return calls;
}

async function openTemplate() {
  window.__futureContextPalette.openFromShortcut();
  await waitFor(() => paletteShadow()?.querySelectorAll('.fc-item').length === 3);
  dispatchTrusted(paletteShadow().querySelectorAll('.fc-item')[2], new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await waitFor(() => paletteShadow().querySelector('.fc-template-form'));
  return paletteShadow();
}

function fillWebTemplate(panel, index, value) {
  const input = panel.querySelectorAll('.fc-variable')[index];
  input.value = value;
  dispatchTrusted(input, new window.Event('input', { bubbles: true, composed: true }));
}

test('web template fills inline with repeated fields, previews text and confirms before replacing original selection', async () => {
  const calls = await templateTransport();
  const target = field(); target.value = '前 原文 后'; target.setSelectionRange(2, 4);
  const panel = await openTemplate();
  assert.equal(calls.some((call) => call.type === 'palette-insert'), false);
  dispatchTrusted(panel.querySelector('.fc-template-form'), new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(panel.querySelector('.fc-template-error').textContent, /动物/);
  fillWebTemplate(panel, 0, '猫');
  assert.equal(panel.querySelectorAll('.fc-variable')[2].value, '猫');
  fillWebTemplate(panel, 1, '<海边>\n黄昏');
  dispatchTrusted(panel.querySelectorAll('.fc-template-toolbar button')[1], new window.MouseEvent('click', { bubbles: true }));
  assert.equal(panel.querySelector('.fc-template-result').textContent, '一只 猫，位于 <海边>\n黄昏。猫');
  assert.equal(panel.querySelector('.fc-template-result 海边'), null);
  dispatchTrusted(panel.querySelectorAll('.fc-template-toolbar button')[0], new window.MouseEvent('click', { bubbles: true }));
  dispatchTrusted(panel.querySelector('.fc-template-form'), new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => target.value === '前 一只 猫，位于 <海边>\n黄昏。猫 后');
  assert.equal(calls.filter((call) => call.type === 'palette-insert').length, 1);
  assert.equal(calls.filter((call) => call.type === 'palette-used').length, 1);
  assert.equal(calls.find((call) => call.type === 'palette-insert').templateContent, '一只 {{动物}}，位于 {{场景}}。{{动物}}');
});

test('web template // retains the trigger until filled and inserts with the explicit keyboard shortcut', async () => {
  await templateTransport();
  const target = field(); target.value = '//'; target.setSelectionRange(2, 2);
  dispatchTrusted(target, new window.Event('input', { bubbles: true }));
  await waitFor(() => paletteShadow()?.querySelectorAll('.fc-item').length === 3);
  dispatchTrusted(paletteShadow().querySelectorAll('.fc-item')[2], new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await waitFor(() => paletteShadow().querySelector('.fc-template-form'));
  const panel = paletteShadow();
  assert.equal(target.value, '//');
  fillWebTemplate(panel, 0, '狗'); fillWebTemplate(panel, 1, '雪山');
  dispatchTrusted(panel.querySelector('.fc-variable'), new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
  assert.equal(target.value, '//');
  dispatchTrusted(window, new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await waitFor(() => target.value === '一只 狗，位于 雪山。狗');
});

test('web template cancellation and delayed responses cannot write after dismissal or permission revocation', async () => {
  let resolvePrepare;
  const { parsePromptTemplate } = await import('../src/core/prompt-template.js');
  const source = '{{动物}}';
  await templateTransport({ prepare: () => new Promise((resolve) => { resolvePrepare = resolve; }) });
  const target = field(); target.value = '保留';
  window.__futureContextPalette.openFromShortcut();
  await waitFor(() => paletteShadow()?.querySelectorAll('.fc-item').length === 3);
  dispatchTrusted(paletteShadow().querySelectorAll('.fc-item')[2], new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await waitFor(() => resolvePrepare);
  dispatchTrusted(window, new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  resolvePrepare({ ok: true, result: { content: source, template: parsePromptTemplate(source) } });
  await flush(40);
  assert.equal(paletteShadow().querySelector('.fc-template-form'), null);
  assert.equal(target.value, '保留');
  assets.splice(2);
  let resolveInsert;
  const calls = await templateTransport({ insert: () => new Promise((resolve) => { resolveInsert = resolve; }) });
  target.focus();
  const panel = await openTemplate();
  fillWebTemplate(panel, 0, '猫'); fillWebTemplate(panel, 1, '海边');
  dispatchTrusted(panel.querySelector('.fc-template-form'), new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => resolveInsert);
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-settings', enabled: false }));
  resolveInsert({ ok: true, result: { content: '不应插入' } });
  await flush(60);
  assert.equal(target.value, '保留');
  assert.equal(calls.filter((call) => call.type === 'palette-insert').length, 1);
  assert.equal(calls.some((call) => call.type === 'palette-used'), false);
});

test('web template reports submission errors without automatic retry and protects changed original input', async () => {
  const calls = await templateTransport({ insert: async () => ({ ok: false, error: '模板已修改' }) });
  const target = field(); target.value = '保留';
  const panel = await openTemplate();
  fillWebTemplate(panel, 0, '猫'); fillWebTemplate(panel, 1, '海边');
  dispatchTrusted(panel.querySelector('.fc-template-form'), new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(120);
  assert.equal(calls.filter((call) => call.type === 'palette-insert').length, 1);
  assert.equal(panel.querySelector('.fc-variable').value, '猫');
  assert.equal(panel.querySelector('.fc-template-submit').disabled, false);
  target.value = '新输入';
  dispatchTrusted(panel.querySelector('.fc-template-form'), new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(40);
  assert.equal(target.value, '新输入');
  assert.equal(calls.filter((call) => call.type === 'palette-insert').length, 1);
});

test('web template cancel button never submits or changes the input', async () => {
  const calls = await templateTransport();
  const target = field(); target.value = '保留';
  const panel = await openTemplate();
  fillWebTemplate(panel, 0, '猫');
  dispatchTrusted(panel.querySelector('.fc-template-actions button'), new window.MouseEvent('click', { bubbles: true }));
  assert.equal(target.value, '保留');
  assert.equal(calls.some((call) => call.type === 'palette-insert'), false);
  assert.equal(document.activeElement, target);
});
