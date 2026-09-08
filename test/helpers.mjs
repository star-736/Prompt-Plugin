import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { APP_STORAGE_KEY, createEmptyDatabase, normalizeDatabase } from '../store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function createMemoryIndexedDB() {
  const databases = new Map();

  function storeMap(name) {
    if (!databases.has(name)) databases.set(name, new Map());
    return databases.get(name);
  }

  function requestOf(run) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        request.result = run();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      }
    });
    return request;
  }

  return {
    open(name) {
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        const data = storeMap(name);
        const objectStoreNames = { contains: (storeName) => storeName === 'packages' && data.__created === true };
        const database = {
          objectStoreNames,
          createObjectStore() { data.__created = true; return {}; },
          close() {},
          transaction(_storeName, _mode) {
            const transaction = { error: null, oncomplete: null, onerror: null, onabort: null };
            let pending = 0;
            const finish = () => {
              pending -= 1;
              if (pending <= 0) queueMicrotask(() => transaction.oncomplete?.());
            };
            const store = {
              put(value) {
                pending += 1;
                return requestOf(() => {
                  if (!value?.id || !Array.isArray(value.files)) throw new Error('Skill 包数据不完整。');
                  data.set(value.id, structuredClone(value));
                  finish();
                  return value;
                });
              },
              get(id) {
                pending += 1;
                return requestOf(() => {
                  finish();
                  return data.has(id) ? structuredClone(data.get(id)) : undefined;
                });
              },
              delete(id) {
                pending += 1;
                return requestOf(() => {
                  data.delete(id);
                  finish();
                });
              }
            };
            queueMicrotask(() => { if (pending === 0) transaction.oncomplete?.(); });
            transaction.objectStore = () => store;
            return transaction;
          }
        };
        request.result = database;
        if (!data.__created) request.onupgradeneeded?.({ target: request });
        data.__created = true;
        request.onsuccess?.({ target: request });
      });
      return request;
    }
  };
}

function storageArea(bucket) {
  return {
    async get(keys) {
      if (keys == null) return { ...bucket };
      if (typeof keys === 'string') return { [keys]: bucket[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, bucket[key]]));
      return Object.fromEntries(Object.keys(keys).map((key) => [key, bucket[key] ?? keys[key]]));
    },
    async set(values) { Object.assign(bucket, values); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete bucket[key];
    }
  };
}

export function createChromeStub(options = {}) {
  const local = options.local ?? {};
  const session = options.session ?? {};
  const granted = new Set(options.grantedOrigins ?? []);
  const registered = [];
  const alarms = [];
  const listeners = {
    alarm: [],
    installed: [],
    startup: [],
    contextClicked: [],
    command: [],
    message: [],
    paletteMessage: []
  };
  const tabs = options.tabs ?? [{ id: 1, url: 'https://chatgpt.com/', active: true, windowId: 1 }];
  const executeScript = options.executeScript ?? (async ({ func, args = [] }) => {
    if (typeof func === 'function') return [{ result: func(...args) }];
    return [{ result: null }];
  });

  const chrome = {
    storage: { local: storageArea(local), session: storageArea(session) },
    permissions: {
      async contains({ origins = [] }) { return origins.every((origin) => granted.has(origin) || [...granted].some((item) => item === origin)); },
      async request({ origins = [] }) { origins.forEach((origin) => granted.add(origin)); return true; },
      async remove({ origins = [] }) { origins.forEach((origin) => granted.delete(origin)); return true; }
    },
    tabs: {
      async query(query = {}) {
        return tabs.filter((tab) => {
          if (query.active && !tab.active) return false;
          if (query.url && ![].concat(query.url).some((pattern) => (tab.url || '').startsWith(String(pattern).replace(/\*$/, '')))) return false;
          return true;
        });
      },
      async get(id) { return tabs.find((tab) => tab.id === id) ?? null; },
      async sendMessage(tabId, message) {
        listeners.paletteMessage.forEach((listener) => listener(message, { tab: { id: tabId } }));
        return { ok: true };
      }
    },
    scripting: {
      executeScript,
      async getRegisteredContentScripts() { return [...registered]; },
      async registerContentScripts(scripts) { registered.push(...scripts); },
      async updateContentScripts(scripts) {
        for (const script of scripts) {
          const index = registered.findIndex((item) => item.id === script.id);
          if (index >= 0) registered[index] = script; else registered.push(script);
        }
      },
      async unregisterContentScripts({ ids = [] }) {
        for (let index = registered.length - 1; index >= 0; index -= 1) {
          if (ids.includes(registered[index].id)) registered.splice(index, 1);
        }
      }
    },
    alarms: {
      async create(name, info) { alarms.push({ name, info }); },
      onAlarm: { addListener(listener) { listeners.alarm.push(listener); } }
    },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {},
      async openPopup() {}
    },
    contextMenus: {
      removeAll(callback) { callback?.(); },
      create() {},
      onClicked: { addListener(listener) { listeners.contextClicked.push(listener); } }
    },
    commands: { onCommand: { addListener(listener) { listeners.command.push(listener); } } },
    runtime: {
      async sendMessage(message) {
        if (typeof options.sendMessage === 'function') return options.sendMessage(message);
        const [listener] = listeners.message;
        if (!listener) return { ok: true, result: null };
        return await new Promise((resolve) => {
          const keep = listener(message, options.sender ?? {}, (response) => resolve(response));
          if (keep !== true && !responsePending(resolve)) resolve({ ok: true, result: null });
        });
      },
      onMessage: {
        addListener(listener) { listeners.message.push(listener); },
        removeListener(listener) { listeners.message = listeners.message.filter((item) => item !== listener); }
      },
      onInstalled: { addListener(listener) { listeners.installed.push(listener); } },
      onStartup: { addListener(listener) { listeners.startup.push(listener); } }
    }
  };

  globalThis.chrome = chrome;
  globalThis.indexedDB = options.indexedDB ?? createMemoryIndexedDB();
  return { chrome, local, session, granted, registered, alarms, listeners, tabs };
}

function responsePending() { return false; }

export function seedDatabase(local, database) {
  local[APP_STORAGE_KEY] = normalizeDatabase(database ?? createEmptyDatabase());
  return local[APP_STORAGE_KEY];
}

export async function waitFor(predicate, { timeout = 2000, interval = 15 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('waitFor timed out');
}

export function installDom(html, { url = 'https://chatgpt.com/' } = {}) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const assign = (key, value) => {
    try { globalThis[key] = value; } catch { /* 只读全局量跳过。 */ }
  };
  assign('window', window);
  assign('document', window.document);
  assign('navigator', window.navigator);
  assign('location', window.location);
  assign('HTMLElement', window.HTMLElement);
  assign('HTMLDialogElement', window.HTMLDialogElement);
  assign('HTMLInputElement', window.HTMLInputElement);
  assign('HTMLTextAreaElement', window.HTMLTextAreaElement);
  assign('Node', window.Node);
  assign('NodeFilter', window.NodeFilter);
  assign('Event', window.Event);
  assign('MouseEvent', window.MouseEvent);
  assign('KeyboardEvent', window.KeyboardEvent);
  assign('InputEvent', window.InputEvent);
  assign('ClipboardEvent', window.ClipboardEvent);
  assign('CustomEvent', window.CustomEvent);
  assign('FocusEvent', window.FocusEvent);
  assign('Blob', window.Blob);
  assign('File', window.File);
  assign('DocumentFragment', window.DocumentFragment);
  assign('DOMParser', window.DOMParser);
  assign('getSelection', window.getSelection.bind(window));
  assign('getComputedStyle', window.getComputedStyle.bind(window));
  assign('requestAnimationFrame', (callback) => setTimeout(callback, 0));
  assign('cancelAnimationFrame', (id) => clearTimeout(id));
  window.HTMLDialogElement.prototype.showModal ??= function showModal() {
    this.setAttribute('open', '');
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close ??= function close(returnValue) {
    this.removeAttribute('open');
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new window.Event('close'));
  };
  let clipboard = '';
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text) { clipboard = String(text ?? ''); },
      async readText() { return clipboard; }
    }
  });
  assign('URL', window.URL);
  window.URL.createObjectURL = () => 'blob:futurecontext-test';
  window.URL.revokeObjectURL = () => {};
  try {
    globalThis.URL.createObjectURL = () => 'blob:futurecontext-test';
    globalThis.URL.revokeObjectURL = () => {};
  } catch { /* Node URL.createObjectURL 可能不可重写。 */ }
  if (!window.DataTransfer) {
    window.DataTransfer = class DataTransfer {
      constructor() { this._data = new Map(); }
      setData(type, value) { this._data.set(type, value); }
      getData(type) { return this._data.get(type) ?? ''; }
    };
  }
  assign('DataTransfer', window.DataTransfer);
  window.document.execCommand ??= () => false;
  return { dom, window, document: window.document, clipboard: () => clipboard };
}

export function popupHtml() {
  return readFileSync(join(root, 'popup.html'), 'utf8');
}

export function click(selectorOrElement) {
  const element = typeof selectorOrElement === 'string' ? document.querySelector(selectorOrElement) : selectorOrElement;
  if (!element) throw new Error(`click missing ${selectorOrElement}`);
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return element;
}

export function confirmOpenDialog() {
  const dialog = document.querySelector('#confirm-dialog');
  dialog.returnValue = 'confirm';
  dialog.close();
}

export async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
