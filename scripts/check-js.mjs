import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['assets/site.js', 'assets/password.js', 'assets/contrast.js', 'assets/toolkit.js', 'qrcode/a11y.js', 'qrcode/sw.js'];

async function collect(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(relative);
    else if (entry.name.endsWith('.js')) files.push(relative);
  }
}

await collect('assets/tools');
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

console.log(`Syntax-checked ${files.length} JavaScript files.`);
