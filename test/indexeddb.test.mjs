import assert from 'node:assert/strict';
import test from 'node:test';
import { getPackage } from '../src/platform/package-store.js';
import { getBinding } from '../src/features/agents/agent-folders.js';

// Unlike the simple record fixture, this adapter separates request success
// from transaction commit and exposes transaction failures and connection close.
function lifecycleDatabase({ stage, error } = {}) {
  const state = { closed: 0, aborted: 0, storeName: null, created: null, transaction: null };
  const failure = error;
  const indexedDb = { open() {
    const request = {};
    queueMicrotask(() => {
      if (stage === 'open') {
        request.error = failure;
        request.onerror();
        return;
      }
      request.result = {
        objectStoreNames: { contains: () => false },
        createObjectStore(name, options) { state.created = { name, options }; },
        close() { state.closed += 1; },
        transaction(name) {
          if (stage === 'transaction') throw new Error('transaction failed');
          state.storeName = name;
          const transaction = { abort() {
            state.aborted += 1;
            queueMicrotask(() => transaction.onabort());
          }, objectStore() { return { get() {
            if (stage === 'callback') throw new Error('request failed synchronously');
            const read = {};
            queueMicrotask(() => {
              if (stage === 'request') {
                read.error = failure;
                read.onerror();
                transaction.error = failure;
                transaction.onerror();
                transaction.onabort();
              } else if (stage === 'abort') {
                transaction.error = failure;
                transaction.onabort();
              } else {
                read.result = { id: 'saved' };
                read.onsuccess();
              }
            });
            return read;
          } }; } };
          state.transaction = transaction;
          return transaction;
        }
      };
      request.onupgradeneeded();
      request.onsuccess();
    });
    return request;
  } };
  return { indexedDb, state };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('IndexedDB reads wait for commit and close their connection exactly once', async () => {
  for (const [read, storeName, id] of [[getPackage, 'packages', 'pkg'], [getBinding, 'bindings', 'claude']]) {
    const { indexedDb, state } = lifecycleDatabase();
    let settled = false;
    const pending = read(id, indexedDb).then((value) => { settled = true; return value; });
    await turn();
    assert.equal(settled, false);
    assert.equal(state.closed, 0);
    assert.equal(state.storeName, storeName);
    assert.deepEqual(state.created, { name: storeName, options: { keyPath: 'id' } });
    state.transaction.oncomplete();
    assert.equal((await pending).id, 'saved');
    assert.equal(state.closed, 1);
  }
});

test('IndexedDB errors retain the cause and close failed transactions', async () => {
  for (const stage of ['open', 'transaction', 'callback', 'request', 'abort']) {
    const error = new Error(`failed ${stage}`);
    const { indexedDb, state } = lifecycleDatabase({ stage, error });
    await assert.rejects(getPackage('pkg', indexedDb), stage === 'transaction' ? /transaction failed/ : stage === 'callback' ? /request failed synchronously/ : error);
    await turn();
    assert.equal(state.closed, stage === 'open' ? 0 : 1);
    assert.equal(state.aborted, stage === 'callback' ? 1 : 0);
  }
});

test('IndexedDB failures without browser error objects preserve store-specific messages', async () => {
  for (const [read, id, label] of [[getPackage, 'pkg', '本地 Skill 文件库'], [getBinding, 'claude', 'Agent 目录绑定']]) {
    for (const stage of ['open', 'request', 'abort']) {
      const { indexedDb } = lifecycleDatabase({ stage });
      const prefix = stage === 'open' ? '无法打开' : stage === 'request' ? '无法更新' : '';
      const suffix = stage === 'abort' ? '操作已取消。' : '。';
      await assert.rejects(read(id, indexedDb), { message: `${prefix}${label}${suffix}` });
    }
  }
});
