import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPackageLimits, deletePackage, exportPackages, FILE_LIMIT_BYTES, getPackage, importPackages, isTextFile, PACKAGE_LIMIT_BYTES, putPackage } from '../package-store.js';
import { createMemoryIndexedDB } from './helpers.mjs';

test('isTextFile recognizes markdown, scripts, and JSON content types', () => {
  assert.equal(isTextFile('SKILL.md'), true);
  assert.equal(isTextFile('run.py'), true);
  assert.equal(isTextFile('notes.txt'), true);
  assert.equal(isTextFile('data.bin'), false);
  assert.equal(isTextFile('blob', 'application/json'), true);
  assert.equal(isTextFile('blob', 'image/png'), false);
});

test('assertPackageLimits accepts a small package and reports oversized files', () => {
  assert.equal(assertPackageLimits([{ path: 'SKILL.md', size: 12 }]), 12);
  assert.throws(() => assertPackageLimits([{ path: 'big.bin', size: FILE_LIMIT_BYTES + 1 }]), (error) => error.code === 'PACKAGE_TOO_LARGE' && error.details[0].path === 'big.bin');
  assert.throws(() => assertPackageLimits([{ path: 'a', size: PACKAGE_LIMIT_BYTES }, { path: 'b', size: 1 }]), (error) => error.details.some((item) => item.path === '整个 Skill 包'));
});

test('IndexedDB package helpers put, get, export, import, and delete', async () => {
  const indexedDb = createMemoryIndexedDB();
  const record = { id: 'pkg-1', files: [{ path: 'SKILL.md', content: 'abc', size: 3 }], fileCount: 1, totalSize: 3 };
  await putPackage(record, indexedDb);
  assert.equal((await getPackage('pkg-1', indexedDb)).files[0].path, 'SKILL.md');
  assert.equal(await getPackage('missing', indexedDb), undefined);
  const exported = await exportPackages(['pkg-1', 'pkg-1', ''], indexedDb);
  assert.equal(exported.length, 1);
  const imported = await importPackages(exported, [{ sourcePackageId: 'pkg-1', targetPackageId: 'pkg-2' }], indexedDb);
  assert.equal(imported, 1);
  assert.equal((await getPackage('pkg-2', indexedDb)).id, 'pkg-2');
  assert.equal(await importPackages(exported, [], indexedDb), 0);
  await deletePackage('pkg-1', indexedDb);
  assert.equal(await getPackage('pkg-1', indexedDb), null);
});

test('putPackage rejects an incomplete record', async () => {
  await assert.rejects(() => putPackage({ id: 'x' }, createMemoryIndexedDB()), /不完整/);
});
