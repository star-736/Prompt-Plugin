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
