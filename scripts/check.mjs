import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXTENSION_PATHS } from '../src/platform/extension-paths.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  }).sort();
}

function requireFile(path, owner) {
  assert.ok(existsSync(path), `${owner}: missing local resource ${path}`);
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.background.service_worker, EXTENSION_PATHS.background);
assert.equal(manifest.action.default_popup, EXTENSION_PATHS.popup);
for (const path of [...Object.values(EXTENSION_PATHS), ...Object.values(manifest.icons)]) {
  requireFile(join(root, path), 'manifest / extension paths');
}

const files = ['src', 'test', 'scripts'].flatMap((directory) => filesIn(join(root, directory)));
let scripts = 0;
for (const path of files) {
  const extension = extname(path);
  if (!['.js', '.mjs', '.html'].includes(extension)) continue;
  const source = readFileSync(path, 'utf8');
  if (extension === '.html') {
    for (const match of source.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      if (!/^(?:[a-z]+:|#|\/\/)/i.test(match[1])) requireFile(resolve(dirname(path), match[1]), path);
    }
    continue;
  }
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.error?.message || `Unable to check ${path}\n`);
    process.exit(1);
  }
  scripts += 1;
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+)["']/g)) {
    requireFile(resolve(dirname(path), match[1]), path);
  }
}

console.log(`Checked ${scripts} JavaScript files, manifest entries, and local module/page resources.`);
