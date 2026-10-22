import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { EXTENSION_PATHS } from '../dist/platform/extension-paths.js';

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

const files = ['src', 'dist', 'test', 'scripts'].flatMap((directory) => filesIn(join(root, directory)));
const sourceRoot = join(root, 'src');
const outputRoot = join(root, 'dist');
const sourceFiles = filesIn(sourceRoot);
const sources = sourceFiles.filter((path) => extname(path) === '.ts' && !path.endsWith('.d.ts'));
assert.ok(sources.length > 0, 'Expected TypeScript application sources.');
for (const path of sources) requireFile(join(outputRoot, relative(sourceRoot, path).replace(/\.ts$/, '.js')), path);
assert.ok(!sourceFiles.some((path) => ['.js', '.mjs'].includes(extname(path))), 'Application source must be TypeScript.');
// Dynamic registration requires a classic script, even though other entries use ESM.
new Script(readFileSync(join(root, EXTENSION_PATHS.palette), 'utf8'), { filename: EXTENSION_PATHS.palette });
for (const [page, entry] of [[EXTENSION_PATHS.popup, 'dist/ui/popup/popup.js'], [EXTENSION_PATHS.deliver, 'dist/ui/deliver/deliver.js']]) {
  const html = readFileSync(join(root, page), 'utf8');
  const modules = [...html.matchAll(/<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/g)];
  assert.equal(modules.length, 1, `${page}: expected one compiled module entry`);
  assert.equal(resolve(dirname(join(root, page)), modules[0][1]), join(root, entry));
}
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

console.log(`Checked ${sources.length} TypeScript sources, ${scripts} JavaScript files, manifest entries, and local module/page resources.`);
