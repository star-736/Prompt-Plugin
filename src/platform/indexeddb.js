// Shared lifecycle for the extension's separate, single-store IndexedDB databases.
export function createIndexedDbStore({ databaseName, storeName, version = 1, messages }) {
  function openDatabase(indexedDb) {
    return new Promise((resolve, reject) => {
      const request = indexedDb.open(databaseName, version);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(messages.open));
    });
  }

  async function transact(mode, callback, indexedDb = globalThis.indexedDB) {
    const database = await openDatabase(indexedDb);
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        database.close();
        if (error) reject(error); else resolve(value);
      };
      let transaction;
      let output;
      try {
        transaction = database.transaction(storeName, mode);
        transaction.oncomplete = () => {
          output.then((result) => finish(result.error, result.value));
        };
        transaction.onerror = () => finish(transaction.error ?? new Error(messages.write));
        transaction.onabort = () => finish(transaction.error ?? new Error(messages.abort));
        // Observe request rejections immediately, even before the transaction
        // abort event. A successful request is acknowledged only after commit.
        output = Promise.resolve(callback(transaction.objectStore(storeName))).then(
          (value) => ({ value }), (error) => ({ error })
        );
      } catch (error) {
        transaction?.abort?.();
        finish(error);
      }
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(messages.read));
    });
  }

  return { transact, requestValue };
}
