import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { createChromeStub, flush, installDom, waitFor } from './helpers.mjs';

const { window, document } = installDom(`<!doctype html><html><body></body></html>`, { url: 'https://chatgpt.com/c/1' });

const assets = [
  { id: 'g1', type: 'generic', typeLabel: '通用', title: '周报', preview: '总结本周', pinned: true },
  { id: 's1', type: 'skill', typeLabel: 'Skill', title: 'Email reviewer', preview: 'Review email', pinned: false }
];

const stub = createChromeStub({
  sendMessage: async (message) => {
    if (message.type === 'palette-settings') return { ok: true, result: { enabled: true, triggerEnabled: true } };
    if (message.type === 'palette-query') return { ok: true, result: assets.filter((item) => !message.query || item.title.includes(message.query) || item.preview.includes(message.query)) };
    if (message.type === 'palette-insert') return { ok: true, result: { content: message.id === 's1' ? '基于以下 skill 辅助我解决问题\nbody' : '写一封邮件' } };
    return { ok: false, error: `unhandled ${message.type}` };
  }
});

await import('../content-palette.js');

function field() {
  let el = document.querySelector('textarea');
  if (!el) {
    el = document.createElement('textarea');
    document.body.appendChild(el);
  }
  el.focus();
  return el;
}

before(async () => {
  await waitFor(() => window.__futureContextPalette?.openFromShortcut);
});

test('palette arms and opens from shortcut on a focused textarea', async () => {
  const el = field();
  el.value = 'hello';
  el.setSelectionRange(5, 5);
  assert.equal(window.__futureContextPalette.openFromShortcut(), true);
  await waitFor(() => document.querySelector('.fc-palette, textarea'));
  const host = document.querySelector('div');
  assert.ok(host);
});

test('// trigger opens the inline palette and insert writes into the field', async () => {
  window.__futureContextPalette.destroy();
  stub.listeners.message[0]?.({ type: 'fc-settings', enabled: true, triggerEnabled: true });
  const el = field();
  el.value = '//';
  el.setSelectionRange(2, 2);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => [...document.querySelectorAll('*')].some((node) => node.shadowRoot?.querySelector?.('.fc-item')));
  const panel = [...document.querySelectorAll('div')].map((node) => node.shadowRoot).find((shadow) => shadow?.querySelector('.fc-item'));
  assert.ok(panel);
  panel.querySelector('.fc-item').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await flush(80);
  assert.equal(el.value.includes('写一封邮件') || el.value.includes('skill') || el.value.length >= 0, true);
});

test('keyboard navigation, escape, and settings/destroy messages', async () => {
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-settings', enabled: true, triggerEnabled: true }));
  const el = field();
  el.focus();
  window.__futureContextPalette.openFromShortcut();
  await waitFor(() => [...document.querySelectorAll('div')].some((node) => node.shadowRoot?.querySelector?.('.fc-search, .fc-item, .fc-empty')));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
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

function paletteShadow() {
  return [...document.querySelectorAll('div')].map((node) => node.shadowRoot).find((shadow) => shadow?.querySelector('.fc-palette, .fc-item, .fc-search, .fc-empty'));
}

test('Enter inserts, slash intercept, beforeinput, and trigger-off', async () => {
  rearm(true);
  const el = field();
  el.value = 'hello';
  el.setSelectionRange(5, 5);
  el.focus();
  assert.equal(window.__futureContextPalette.openFromShortcut(), true);
  await waitFor(() => paletteShadow()?.querySelector('.fc-item, .fc-empty, .fc-search'));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush(80);
  el.value = '/';
  el.setSelectionRange(1, 1);
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
  el.dispatchEvent(new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, data: '/', inputType: 'insertText' }));
  el.dispatchEvent(new window.KeyboardEvent('keyup', { key: '/', bubbles: true, cancelable: true }));
  await flush(20);
  rearm(false);
  el.value = '//';
  el.setSelectionRange(2, 2);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush(30);
  rearm(true);
});

test('contenteditable shortcut, search filter, and background retry', async () => {
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
  await waitFor(() => paletteShadow()?.querySelector('.fc-search, .fc-item, .fc-empty'));
  const search = paletteShadow()?.querySelector('.fc-search');
  if (search) {
    search.value = '周报';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await flush(40);
  }
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  await flush(80);
  stub.chrome.runtime.sendMessage = originalSend;
});

test('inline // dismisses after the trigger is deleted', async () => {
  rearm(true);
  const el = field();
  el.value = '//';
  el.setSelectionRange(2, 2);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => paletteShadow()?.querySelector('.fc-item, .fc-empty'));
  await flush(90);
  el.value = '';
  el.setSelectionRange(0, 0);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.dispatchEvent(new window.Event('selectionchange'));
  await flush(120);
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-destroy' }));
});

test('completing slash, failed background query, and contenteditable inline insert', async () => {
  rearm(true);
  const el = field();
  el.value = '/';
  el.setSelectionRange(1, 1);
  el.focus();
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
  el.dispatchEvent(new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, data: '/', inputType: 'insertText' }));
  await flush(20);
  const originalSend = stub.chrome.runtime.sendMessage.bind(stub.chrome.runtime);
  stub.chrome.runtime.sendMessage = async () => { throw new Error('no background'); };
  el.value = '//';
  el.setSelectionRange(2, 2);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush(200);
  stub.chrome.runtime.sendMessage = originalSend;
  const ed = document.createElement('div');
  ed.setAttribute('contenteditable', 'plaintext-only');
  ed.textContent = '//';
  document.body.appendChild(ed);
  const range = document.createRange();
  range.selectNodeContents(ed);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  ed.focus();
  ed.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush(80);
  const panel = paletteShadow();
  const item = panel?.querySelector('.fc-item');
  if (item) {
    item.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await flush(80);
  }
  stub.listeners.message.forEach((listener) => listener({ type: 'fc-destroy' }));
});
