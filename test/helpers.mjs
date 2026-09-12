import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import { JSDOM } from 'jsdom';
import { APP_STORAGE_KEY, createEmptyDatabase, normalizeDatabase } from '../store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fresh entry-point state with a stable source URL so V8 merges coverage from
// different fixtures rather than counting query-string imports as extra files.
export async function loadFreshEntry(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  const entry = new SourceTextModule(readFileSync(url, 'utf8'), { identifier: url.href });
  await entry.link(async (specifier) => {
    const namespace = await import(new URL(specifier, url).href);
    return new SyntheticModule(Object.keys(namespace), function () {
      for (const name of Object.keys(namespace)) this.setExport(name, namespace[name]);
    });
  });
  await entry.evaluate();
}

export function createMemoryIndexedDB() {
  const databases = new Map();

  function storeMap(name) {
    if (!databases.has(name)) databases.set(name, new Map());
    return databases.get(name);
  }

  function cloneRecord(value) {
  const copy = structuredClone({ ...value, handle: undefined });
  if (value?.handle) copy.handle = value.handle;
  return copy;
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
                  if (!value?.id) throw new Error('记录缺少 id。');
                  data.set(value.id, cloneRecord(value));
                  finish();
                  return value;
                });
              },
              get(id) {
                pending += 1;
                return requestOf(() => {
                  finish();
                  return data.has(id) ? cloneRecord(data.get(id)) : undefined;
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

function storageArea(bucket, { area = 'local', emit, accessLevels } = {}) {
  return {
    async setAccessLevel(value) {
      accessLevels?.push({ area, accessLevel: value?.accessLevel ?? value });
    },
    async get(keys) {
      if (keys == null) return { ...bucket };
      if (typeof keys === 'string') return { [keys]: bucket[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, bucket[key]]));
      return Object.fromEntries(Object.keys(keys).map((key) => [key, bucket[key] ?? keys[key]]));
    },
    async set(values) {
      const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: bucket[key], newValue: value }]));
      Object.assign(bucket, values);
      emit?.(changes, area);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = Object.fromEntries(list.map((key) => [key, { oldValue: bucket[key], newValue: undefined }]));
      for (const key of list) delete bucket[key];
      emit?.(changes, area);
    }
  };
}

export function createChromeStub(options = {}) {
  const local = options.local ?? {};
  const session = options.session ?? {};
  const granted = new Set(options.grantedOrigins ?? []);
  const registered = [];
  const alarms = [];
  const accessLevels = [];
  const listeners = {
    alarm: [],
    installed: [],
    startup: [],
    contextClicked: [],
    command: [],
    message: [],
    paletteMessage: [],
    storageChanged: []
  };
  const emitStorage = (changes, area) => {
    listeners.storageChanged.forEach((listener) => listener(changes, area));
  };
  const tabs = options.tabs ?? [{ id: 1, url: 'https://chatgpt.com/', active: true, windowId: 1 }];
  const executeScript = options.executeScript ?? (async ({ func, args = [] }) => {
    if (typeof func === 'function') return [{ result: func(...args) }];
    return [{ result: null }];
  });

  const chrome = {
    storage: {
      local: storageArea(local, { area: 'local', emit: emitStorage, accessLevels }),
      session: storageArea(session, { area: 'session', emit: emitStorage, accessLevels }),
      onChanged: {
        addListener(listener) { listeners.storageChanged.push(listener); },
        removeListener(listener) { listeners.storageChanged = listeners.storageChanged.filter((item) => item !== listener); }
      }
    },
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
    windows: {
      created: [],
      async create(info) {
        chrome.windows.created.push(info);
        return { id: 99, ...info };
      }
    },
    runtime: {
      getURL(path) { return `chrome-extension://futurecontext/${path}`; },
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
  return { chrome, local, session, granted, registered, alarms, listeners, tabs, accessLevels };
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
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
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
  if (typeof window.ClipboardEvent !== 'function') {
    window.ClipboardEvent = class ClipboardEvent extends window.Event {
      constructor(type, init = {}) {
        super(type, init);
        this.clipboardData = init.clipboardData ?? null;
      }
    };
  }
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
  assign('Range', window.Range);
  assign('Selection', window.Selection);
  window.document.execCommand ??= () => false;
  window.document.hasFocus = () => true;
  assign('hasFocus', window.document.hasFocus);
  assign('HTMLAnchorElement', window.HTMLAnchorElement);
  const originalElementClick = window.HTMLElement.prototype.click;
  window.HTMLElement.prototype.click = function click() {
    if (this.tagName === 'A' && (this.download || this.hasAttribute('download'))) return;
    return originalElementClick.call(this);
  };
  window.document.addEventListener('click', (event) => {
    const anchor = event.target?.closest?.('a');
    if (anchor && (anchor.download || anchor.hasAttribute('download'))) event.preventDefault();
  }, true);
  return { dom, window, document: window.document, clipboard: () => clipboard };
}

export function popupHtml() {
  return readFileSync(join(root, 'popup.html'), 'utf8');
}

export function deliverHtml() {
  return readFileSync(join(root, 'deliver.html'), 'utf8');
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

function memoryFileHandle(entry) {
  return {
    kind: 'file',
    async createWritable() {
      return {
        async write(data) {
          entry.bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
        },
        async close() {}
      };
    },
    async getFile() {
      return { async text() { return new TextDecoder().decode(entry.bytes); } };
    }
  };
}

export function createMemoryDirectory(name = 'skills') {
  const entries = new Map();
  return {
    name,
    kind: 'directory',
    _entries: entries,
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async *entries() {
      for (const [child, entry] of entries) yield [child, entry.type === 'dir' ? entry.handle : memoryFileHandle(entry)];
    },
    async getDirectoryHandle(child, { create } = {}) {
      if (!entries.has(child)) {
        if (!create) { const error = new Error('not found'); error.name = 'NotFoundError'; throw error; }
        entries.set(child, { type: 'dir', handle: createMemoryDirectory(child) });
      }
      const entry = entries.get(child);
      if (entry.type !== 'dir') throw new Error('TypeMismatchError');
      return entry.handle;
    },
    async getFileHandle(child, { create } = {}) {
      if (!entries.has(child)) {
        if (!create) { const error = new Error('not found'); error.name = 'NotFoundError'; throw error; }
        entries.set(child, { type: 'file', bytes: new Uint8Array() });
      }
      const entry = entries.get(child);
      if (entry.type !== 'file') throw new Error('TypeMismatchError');
      return memoryFileHandle(entry);
    },
    async removeEntry(child) { entries.delete(child); }
  };
}

export async function writeMemoryFile(directory, name, text) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}
