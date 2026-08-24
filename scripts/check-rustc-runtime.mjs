import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(root, 'assets/runtime/rustc');
const manifest = JSON.parse(await readFile(path.join(runtimeRoot, 'RUNTIME-MANIFEST.json'), 'utf8'));

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function collect(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file, output);
    else output.push(file);
  }
  return output;
}

assert.equal(manifest.format, 'castrom13-rustc-runtime');
assert.equal(manifest.version, 1);
assert.match(manifest.upstream.commit, /^[a-f0-9]{40}$/);
assert.equal(manifest.target, 'wasm32-wasip1');
assert.equal(manifest.networkPolicy, 'same-origin-only');

const compilerManifestPath = path.join(runtimeRoot, manifest.compiler.manifest);
const compilerManifest = JSON.parse(await readFile(compilerManifestPath, 'utf8'));
assert.equal(compilerManifest.version, 1);
assert.equal(compilerManifest.encoding, 'br');
assert.equal(compilerManifest.originalSize, manifest.compiler.originalBytes);
assert.equal(compilerManifest.compressedSize, manifest.compiler.compressedBytes);
assert.deepEqual(compilerManifest.parts.map((item) => [item.file, item.size]), manifest.compiler.parts.map((item) => [path.basename(item.path), item.bytes]));
assert.equal(manifest.compiler.parts.reduce((sum, item) => sum + item.bytes, 0), manifest.compiler.compressedBytes);
for (const item of manifest.compiler.parts) {
  const file = path.join(runtimeRoot, item.path);
  assert.equal((await stat(file)).size, item.bytes, `${item.path} size`);
  assert.equal(await sha256(file), item.sha256, `${item.path} SHA-256`);
}

const sysrootPath = path.join(runtimeRoot, manifest.sysroot.path);
assert.equal((await stat(sysrootPath)).size, manifest.sysroot.bytes);
assert.equal(await sha256(sysrootPath), manifest.sysroot.sha256);
const sysrootTar = brotliDecompressSync(await readFile(sysrootPath));
assert.equal(sysrootTar.subarray(257, 262).toString('ascii'), 'ustar');
assert.notEqual(sysrootTar.indexOf(Buffer.from('libstd-')), -1, 'WASI sysroot should contain the Rust standard library');

const indexPath = path.join(runtimeRoot, manifest.shell.path);
assert.equal(await sha256(indexPath), manifest.shell.sha256);
const index = await readFile(indexPath, 'utf8');
assert.match(index, /Rust workspace · castrom13/);
assert.match(index, /Content-Security-Policy/);
assert.match(index, /connect-src 'self'/);

const files = await collect(runtimeRoot);
const maximumAssetBytes = 24 * 1024 * 1024;
for (const file of files) assert.ok((await stat(file)).size <= maximumAssetBytes, `${path.relative(runtimeRoot, file)} exceeds the 24 MiB checked-asset limit`);
assert.equal(files.some((file) => /vfs\.core-.*\.wasm$/.test(file)), false, 'uncompressed 429 MiB VFS must not be retained');
const scripts = (await Promise.all(files.filter((file) => file.endsWith('.js')).map((file) => readFile(file, 'utf8')))).join('\n');
for (const marker of ['m13-rust-source', './disabled-crates-proxy/', './sysroot/', '.tar.bin']) assert.ok(scripts.includes(marker), `runtime marker missing: ${marker}`);

const playground = await readFile(path.join(root, 'assets/tools/suite/data-developer.js'), 'utf8');
assert.match(playground, /\/assets\/runtime\/rustc\/index\.html/);
assert.match(playground, /allow-scripts allow-same-origin allow-downloads/);
assert.match(await readFile(path.join(runtimeRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /MIT License text/);

console.log(`Verified Rust runtime: ${manifest.compiler.compressedBytes.toLocaleString()} compressed compiler bytes, ${manifest.sysroot.bytes.toLocaleString()} sysroot bytes, ${files.length} bounded files, same-origin CSP and source handoff.`);
