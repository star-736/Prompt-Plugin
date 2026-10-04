import { AGENT_TARGET_IDS, isAgentTarget } from './agent-deliver.js';

import { createIndexedDbStore } from '../../platform/indexeddb.js';

const { transact, requestValue } = createIndexedDbStore({
  databaseName: 'futurecontext.agent-folders', storeName: 'bindings',
  messages: {
    open: '无法打开Agent 目录绑定。', write: '无法更新Agent 目录绑定。',
    abort: 'Agent 目录绑定操作已取消。', read: 'Agent 目录绑定读取失败。'
  }
});

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
