import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = [
  ['node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs', 'vendor/onnxruntime/ort.webgpu.bundle.min.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.wasm'],
  ['node_modules/pdf-lib/dist/pdf-lib.min.js', 'vendor/pdf-lib/pdf-lib.min.js'],
  ['node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs', 'vendor/transformers/ort-wasm-simd-threaded.jsep.mjs'],
  ['node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm', 'vendor/transformers/ort-wasm-simd-threaded.jsep.wasm']
  ,['node_modules/@wllama/wllama/esm/index.min.js', 'vendor/wllama/index.min.js']
  ,['node_modules/@wllama/wllama/esm/wasm/wllama.wasm', 'vendor/wllama/wllama.wasm']
  ,['node_modules/tesseract.js/dist/tesseract.esm.min.js', 'vendor/tesseract/tesseract.esm.min.js']
  ,['node_modules/tesseract.js/dist/worker.min.js', 'vendor/tesseract/worker.min.js']
  ,['node_modules/sql.js/dist/sql-wasm.js', 'vendor/sqlite/sql-wasm.js']
  ,['node_modules/sql.js/dist/sql-wasm.wasm', 'vendor/sqlite/sql-wasm.wasm']
  ,['node_modules/three/build/three.module.min.js', 'vendor/three/three.module.min.js']
  ,['node_modules/pyodide/pyodide.mjs', 'vendor/pyodide/pyodide.mjs']
  ,['node_modules/pyodide/pyodide.asm.js', 'vendor/pyodide/pyodide.asm.js']
  ,['node_modules/pyodide/pyodide.asm.wasm', 'vendor/pyodide/pyodide.asm.wasm']
  ,['node_modules/pyodide/python_stdlib.zip', 'vendor/pyodide/python_stdlib.zip']
  ,['node_modules/pyodide/pyodide-lock.json', 'vendor/pyodide/pyodide-lock.json']
  ,['node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm', 'vendor/duckdb/duckdb-eh.wasm']
  ,['node_modules/@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm', 'vendor/duckdb/duckdb-mvp.wasm']
  ,['node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js', 'vendor/duckdb/duckdb-browser-eh.worker.js']
  ,['node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js', 'vendor/duckdb/duckdb-browser-mvp.worker.js']
  ,['node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js', 'vendor/ffmpeg/core/ffmpeg-core.js']
  ,['node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', 'vendor/ffmpeg/core/ffmpeg-core.wasm']
  ,['node_modules/libarchive-wasm/dist/libarchive.wasm', 'vendor/libarchive/libarchive.wasm']
  ,['node_modules/@gameguild/emception-browser/dist/coi-serviceworker.js', 'coi-serviceworker.js']
  ,['node_modules/7z-wasm/7zz.es6.js', 'vendor/7zip/7zz.es6.js']
  ,['node_modules/7z-wasm/7zz.wasm', 'vendor/7zip/7zz.wasm']
  ,['node_modules/7z-wasm/License.txt', 'vendor/7zip/License.txt']
  ,['node_modules/7z-wasm/unRarLicense.txt', 'vendor/7zip/unRarLicense.txt']
  ,['node_modules/wasm-feature-detect/dist/esm/index.js', 'vendor/avif/wasm-feature-detect.js']
];

const directories = [
  ['node_modules/tesseract.js-core', 'vendor/tesseract/core'],
  ['node_modules/@ffmpeg/ffmpeg/dist/esm', 'vendor/ffmpeg/ffmpeg'],
  ['node_modules/libraw-wasm/dist', 'vendor/libraw'],
  ['node_modules/@ffmpeg/util/dist/esm', 'vendor/ffmpeg/util']
  ,['node_modules/emception/cdn', 'vendor/emception/cdn']
  ,['node_modules/@jsquash/avif', 'vendor/avif']
];

for (const [source, destination] of assets) {
  const target = path.join(root, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, source), target);
}

for (const [source, destination] of directories) {
  await cp(path.join(root, source), path.join(root, destination), { recursive: true, force: true });
}

const avifEncodePath = path.join(root, 'vendor/avif/encode.js');
const avifEncode = await readFile(avifEncodePath, 'utf8');
const browserReadyAvifEncode = avifEncode.replace("from 'wasm-feature-detect';", "from './wasm-feature-detect.js';");
if (browserReadyAvifEncode === avifEncode) throw new Error('Could not rewrite the AVIF encoder browser dependency.');
await writeFile(avifEncodePath, browserReadyAvifEncode, 'utf8');

await build({
  entryPoints: [path.join(root, 'node_modules/@huggingface/transformers/dist/transformers.web.min.js')],
  outfile: path.join(root, 'vendor/transformers/transformers.bundle.min.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  sourcemap: false,
  logLevel: 'silent'
});

const emceptionOutdir = path.join(root, 'vendor/emception');
await build({
  entryPoints: {
    browser: path.join(root, 'node_modules/@gameguild/emception-browser/dist/createEmception.js'),
    'worker-entry': path.join(root, 'node_modules/@gameguild/emception-browser/dist/worker-entry.js')
  },
  outdir: emceptionOutdir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  loader: { '.py': 'text' },
  logLevel: 'silent'
});
const emceptionBrowserPath = path.join(emceptionOutdir, 'browser.js');
const emceptionBrowser = await readFile(emceptionBrowserPath, 'utf8');
await writeFile(emceptionBrowserPath, emceptionBrowser.replaceAll('new URL("./worker-entry",import.meta.url)', 'new URL("./worker-entry.js",import.meta.url)'), 'utf8');

await build({
  entryPoints: {
    fflate: path.join(root, 'node_modules/fflate/esm/browser.js'),
    gifenc: path.join(root, 'node_modules/gifenc/dist/gifenc.esm.js'),
    exifr: path.join(root, 'node_modules/exifr/dist/full.esm.mjs'),
    utif: path.join(root, 'node_modules/utif/UTIF.js'),
    buffer: path.join(root, 'node_modules/buffer/index.js'),
    'isomorphic-git': path.join(root, 'node_modules/isomorphic-git/index.js'),
    duckdb: path.join(root, 'node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs')
  },
  outdir: path.join(root, 'vendor/suite'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  logLevel: 'silent'
});

await build({
  entryPoints: [path.join(root, 'node_modules/libarchive-wasm/dist/index.js')],
  outfile: path.join(root, 'vendor/suite/libarchive.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  external: ['fs', 'path', 'crypto'],
  logLevel: 'silent'
});

console.log(`Prepared ${assets.length + directories.length + 11} lazy browser runtime assets and bundles.`);
