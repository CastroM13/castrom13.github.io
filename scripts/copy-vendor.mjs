import { copyFile, mkdir } from 'node:fs/promises';
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
];

for (const [source, destination] of assets) {
  const target = path.join(root, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, source), target);
}

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

console.log(`Prepared ${assets.length + 1} lazy browser runtime assets.`);
