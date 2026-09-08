const DATABASE_NAME = 'futurecontext.packages';
const DATABASE_VERSION = 1;
const STORE_NAME = 'packages';

function openDatabase(indexedDb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地 Skill 文件库。'));
  });
}

function transact(mode, callback, indexedDb) {
  return openDatabase(indexedDb).then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let output;
    transaction.oncomplete = () => { database.close(); Promise.resolve(output).then(resolve, reject); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('无法更新本地 Skill 文件库。')); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('本地 Skill 文件库操作已取消。')); };
    output = callback(store);
  }));
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地 Skill 文件库读取失败。'));
  });
}

export async function putPackage(packageRecord, indexedDb = globalThis.indexedDB) {
  const value = structuredClone(packageRecord);
  if (!value?.id || !Array.isArray(value.files)) throw new Error('Skill 包数据不完整。');
  await transact('readwrite', (store) => store.put(value), indexedDb);
  return value;
}

export async function getPackage(id, indexedDb = globalThis.indexedDB) {
  const result = await transact('readonly', (store) => requestValue(store.get(id)), indexedDb);
  return result ?? null;
}

export async function deletePackage(id, indexedDb = globalThis.indexedDB) {
  await transact('readwrite', (store) => store.delete(id), indexedDb);
}

export async function exportPackages(packageIds, indexedDb = globalThis.indexedDB) {
  const packages = [];
  for (const id of new Set(packageIds.filter(Boolean))) {
    const record = await getPackage(id, indexedDb);
    if (record) packages.push(record);
  }
  return packages;
}

export async function importPackages(packages, mappings, indexedDb = globalThis.indexedDB) {
  const mapping = new Map((mappings ?? []).map((item) => [item.sourcePackageId, item.targetPackageId]));
  let imported = 0;
  for (const source of packages ?? []) {
    const targetId = mapping.get(source.id);
    if (!targetId) continue;
    await putPackage({ ...source, id: targetId }, indexedDb);
    imported += 1;
  }
  return imported;
}

export const PACKAGE_LIMIT_BYTES = 10 * 1024 * 1024;
export const FILE_LIMIT_BYTES = 5 * 1024 * 1024;

export function assertPackageLimits(files) {
  const oversized = (files ?? []).filter((file) => Number(file.size) > FILE_LIMIT_BYTES);
  const totalSize = (files ?? []).reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (oversized.length || totalSize > PACKAGE_LIMIT_BYTES) {
    const details = oversized.map((file) => ({ path: file.path, size: Number(file.size) }));
    if (totalSize > PACKAGE_LIMIT_BYTES) details.push({ path: '整个 Skill 包', size: totalSize });
    const error = new Error('Skill 包超过保存大小限制。');
    error.code = 'PACKAGE_TOO_LARGE';
    error.details = details;
    throw error;
  }
  return totalSize;
}

export function isTextFile(path, contentType = '') {
  return /^(text\/|application\/(json|javascript|x-javascript|xml|yaml|x-yaml))/.test(contentType) || /\.(md|mdx|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|ps1|css|html?|xml|toml|ini|cfg|sql)$/i.test(path);
}
