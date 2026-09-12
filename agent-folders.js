import { AGENT_TARGET_IDS, isAgentTarget } from './agent-deliver.js';

const DATABASE_NAME = 'futurecontext.agent-folders';
const DATABASE_VERSION = 1;
const STORE_NAME = 'bindings';

function openDatabase(indexedDb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开 Agent 目录绑定。'));
  });
}

function transact(mode, callback, indexedDb) {
  return openDatabase(indexedDb).then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let output;
    transaction.oncomplete = () => { database.close(); Promise.resolve(output).then(resolve, reject); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('无法更新 Agent 目录绑定。')); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Agent 目录绑定操作已取消。')); };
    output = callback(store);
  }));
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Agent 目录绑定读取失败。'));
  });
}

export async function putBinding(binding, indexedDb = globalThis.indexedDB) {
  if (!isAgentTarget(binding?.id) || !binding.handle) throw new Error('目录绑定不完整。');
  const value = { id: binding.id, handle: binding.handle, displayName: String(binding.displayName ?? binding.handle.name ?? ''), boundAt: binding.boundAt ?? Date.now() };
  await transact('readwrite', (store) => store.put(value), indexedDb);
  return value;
}

export async function getBinding(id, indexedDb = globalThis.indexedDB) {
  if (!isAgentTarget(id)) return null;
  return (await transact('readonly', (store) => requestValue(store.get(id)), indexedDb)) ?? null;
}

export async function deleteBinding(id, indexedDb = globalThis.indexedDB) {
  if (!isAgentTarget(id)) return;
  await transact('readwrite', (store) => store.delete(id), indexedDb);
}

export async function listBindings(indexedDb = globalThis.indexedDB) {
  const rows = [];
  for (const id of AGENT_TARGET_IDS) {
    const row = await getBinding(id, indexedDb);
    if (row) rows.push({ id: row.id, displayName: row.displayName ?? '', boundAt: row.boundAt ?? null });
  }
  return rows;
}
