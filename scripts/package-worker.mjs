/** Stage one already-built worker executable into the external DSH bundle. */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const targetIndex = process.argv.indexOf('--target');
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
const known = {
  'x86_64-pc-windows-msvc': { platform: 'win32-x64', executable: 'companion-memory-worker.exe' },
  'x86_64-unknown-linux-gnu': { platform: 'linux-x64', executable: 'companion-memory-worker' },
};
const destination = target === undefined ? undefined : known[target];
if (destination === undefined) {
  throw new Error('expected --target x86_64-pc-windows-msvc or x86_64-unknown-linux-gnu');
}
const source = join('target', target, 'release', destination.executable);
if (!existsSync(source)) {
  throw new Error(`worker binary is missing: run cargo build --release --target ${target} first`);
}
const output = join('packages', 'dsh-plugin', 'bin', destination.platform, destination.executable);
mkdirSync(join('packages', 'dsh-plugin', 'bin', destination.platform), { recursive: true });
copyFileSync(source, output);
if (target === 'x86_64-unknown-linux-gnu') chmodSync(output, 0o755);
process.stdout.write(`staged ${output}\n`);
