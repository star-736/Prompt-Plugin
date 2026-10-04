import { createIndexedDbStore } from './indexeddb.js';

const { transact, requestValue } = createIndexedDbStore({
  databaseName: 'futurecontext.packages', storeName: 'packages',
  messages: {
    open: '无法打开本地 Skill 文件库。', write: '无法更新本地 Skill 文件库。',
    abort: '本地 Skill 文件库操作已取消。', read: '本地 Skill 文件库读取失败。'
  }
});

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

// Inventory only: recovery must not load all package file bytes into memory.
export async function listPackageIds(indexedDb = globalThis.indexedDB) {
  return transact('readonly', (store) => requestValue(store.getAllKeys()), indexedDb);
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

function pathSegments(path) {
  return String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
}

function comparePackageTreeNodes(a, b, pinSkillMd) {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  if (pinSkillMd && a.type === 'file') {
    if (a.name === 'SKILL.md' && b.name !== 'SKILL.md') return -1;
    if (b.name === 'SKILL.md' && a.name !== 'SKILL.md') return 1;
  }
  return a.name.localeCompare(b.name, 'en');
}

function sortPackageTree(nodes, pinSkillMd) {
  nodes.sort((a, b) => comparePackageTreeNodes(a, b, pinSkillMd));
  for (const node of nodes) {
    if (node.type === 'dir') sortPackageTree(node.children, false);
  }
  return nodes;
}

export function buildPackageFileTree(files) {
  const root = [];
  for (const file of files ?? []) {
    const parts = pathSegments(file.path);
    if (!parts.length) continue;
    let siblings = root;
    let prefix = '';
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      prefix = prefix ? `${prefix}/${name}` : name;
      let folder = siblings.find((node) => node.type === 'dir' && node.name === name);
      if (!folder) {
        folder = { type: 'dir', name, path: prefix, children: [] };
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    const name = parts[parts.length - 1];
    siblings.push({ type: 'file', name, path: parts.join('/'), file });
  }
  return sortPackageTree(root, true);
}
