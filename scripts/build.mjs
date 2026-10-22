import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
// Start from a clean output tree so removed/renamed source files cannot ship.
rmSync(new URL('dist/', root), { recursive: true, force: true });
const compiler = fileURLToPath(new URL('node_modules/typescript/bin/tsc', root));
const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.json'], {
  cwd: fileURLToPath(root), stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
