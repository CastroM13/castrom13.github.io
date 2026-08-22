let session = null;
let ort = null;

self.onmessage = async ({ data }) => {
  if (data.type === 'release') { await release(); return; }
  if (data.type !== 'benchmark') return;
  try { await benchmark(data); }
  catch (error) { self.postMessage({ type: 'error', code: error.code || 'RUNTIME', detail: error.detail || {}, message: error.message || String(error) }); }
};

async function release() {
  if (session?.release) await session.release();
  session = null;
}

async function benchmark({ model, externalData, externalPath, backend, warmups, runs, shapes, samples }) {
  if (model.size > 512 * 1024 * 1024) throw failure('MODEL_CAP', 'The ONNX model exceeds the 512 MiB safety cap.');
  if (externalData?.size > 512 * 1024 * 1024) throw failure('EXTERNAL_CAP', 'External weights exceed the 512 MiB safety cap.');
  self.postMessage({ type: 'status', message: 'Loading the ONNX Runtime browser module…' });
  ort ||= await import('/vendor/onnxruntime/ort.webgpu.bundle.min.mjs');
  ort.env.wasm.wasmPaths = '/vendor/onnxruntime/';
  ort.env.wasm.proxy = false;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator.hardwareConcurrency || 1) : 1;
  await release();
  if (backend === 'webgpu' && !self.navigator.gpu) throw failure('WEBGPU_UNAVAILABLE', 'WebGPU is not available in this browser. Choose WASM.');
  const options = { executionProviders: [backend], graphOptimizationLevel: 'all' };
  if (externalData) options.externalData = [{ path: externalPath || './model.data', data: externalData }];
  const loadStart = performance.now();
  session = await ort.InferenceSession.create(new Uint8Array(await model.arrayBuffer()), options);
  const loadMs = performance.now() - loadStart;
  const metadata = normalizeMetadata(session);
  const feeds = {};
  const specifications = [];
  let inputBytes = 0;
  for (const input of metadata) {
    const dims = resolveDims(input, shapes?.[input.name]);
    const provided = samples?.[input.name];
    const count = dims.reduce((product, value) => product * value, 1);
    if (Array.isArray(provided) && provided.length !== count) throw failure('SAMPLE_COUNT', `Sample data has ${provided.length} values, but the tensor shape requires ${count}.`, { provided: provided.length, required: count, input: input.name });
    const bytes = tensorBytes(input.type, count);
    inputBytes += bytes;
    if (inputBytes > 256 * 1024 * 1024) throw failure('INPUT_CAP', 'Generated input tensors exceed the 256 MiB safety cap.');
    specifications.push({ input, dims, provided });
  }
  for (const { input, dims, provided } of specifications) feeds[input.name] = createTensor(input.type, dims, provided);
  self.postMessage({ type: 'metadata', metadata, resolved: Object.fromEntries(Object.entries(feeds).map(([name, tensor]) => [name, { type: tensor.type, dims: tensor.dims, bytes: tensor.data?.byteLength || 0 }])) });
  self.postMessage({ type: 'status', message: `Warming up ${warmups} run(s)…` });
  for (let index = 0; index < warmups; index += 1) await timedRun(feeds, false);
  const timings = []; let outputBytes = 0;
  self.postMessage({ type: 'status', message: `Measuring ${runs} sequential run(s)…` });
  for (let index = 0; index < runs; index += 1) {
    const measured = await timedRun(feeds, true);
    timings.push(measured.time);
    outputBytes = Math.max(outputBytes, measured.bytes);
    self.postMessage({ type: 'progress', value: index + 1, total: runs });
  }
  self.postMessage({ type: 'complete', loadMs, timings, modelBytes: model.size, inputBytes, outputBytes, backend, threads: ort.env.wasm.numThreads, crossOriginIsolated: self.crossOriginIsolated, metadata });
}

function normalizeMetadata(current) {
  if (Array.isArray(current.inputMetadata)) return current.inputMetadata.map((item) => ({ name: item.name, type: item.type || 'float32', shape: item.shape || item.dims || [] }));
  const names = current.inputNames || Object.keys(current.inputMetadata || {});
  return names.map((name) => { const item = current.inputMetadata?.[name] || {}; return { name, type: item.type || 'float32', shape: item.shape || item.dimensions || item.dims || [] }; });
}

function resolveDims(input, override) {
  const dims = Array.isArray(override) ? override : input.shape;
  if (!Array.isArray(dims) || !dims.length) throw failure('NO_SHAPE', `Input ${input.name} has no usable shape. Add a JSON shape override.`, { input: input.name });
  const resolved = dims.map(Number);
  if (resolved.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw failure('INVALID_DIMS', `Input ${input.name} contains symbolic or invalid dimensions. Add a positive integer override.`, { input: input.name });
  const count = resolved.reduce((product, value) => product * value, 1);
  if (!Number.isSafeInteger(count) || count > 64_000_000) throw failure('ELEMENT_CAP', `Input ${input.name} exceeds the 64-million-element safety cap.`, { input: input.name });
  return resolved;
}

function createTensor(type, dims, provided) {
  const count = dims.reduce((product, value) => product * value, 1);
  const source = Array.isArray(provided) ? provided : null;
  let values;
  switch (type) {
    case 'float32': values = fill(new Float32Array(count), source, (index) => ((index * 13) % 101) / 100); break;
    case 'float64': values = fill(new Float64Array(count), source, (index) => ((index * 13) % 101) / 100); break;
    case 'int8': values = fill(new Int8Array(count), source, (index) => index % 127); break;
    case 'uint8':
    case 'bool': values = fill(new Uint8Array(count), source, (index) => type === 'bool' ? index % 2 : index % 255); break;
    case 'int16': values = fill(new Int16Array(count), source, (index) => index % 32767); break;
    case 'uint16':
    case 'float16': values = fill(new Uint16Array(count), source, (index) => type === 'float16' ? float32ToFloat16(((index * 13) % 101) / 100) : index % 65535); break;
    case 'int32': values = fill(new Int32Array(count), source, (index) => index); break;
    case 'uint32': values = fill(new Uint32Array(count), source, (index) => index); break;
    case 'int64': values = fill(new BigInt64Array(count), source, (index) => index, true); break;
    case 'uint64': values = fill(new BigUint64Array(count), source, (index) => index, true); break;
    default: throw failure('UNSUPPORTED_TYPE', `Input type ${type} is not supported by generated data.`, { type });
  }
  return new ort.Tensor(type, values, dims);
}

function tensorBytes(type, count) {
  const width = { bool: 1, int8: 1, uint8: 1, float16: 2, int16: 2, uint16: 2, float32: 4, int32: 4, uint32: 4, float64: 8, int64: 8, uint64: 8 }[type];
  if (!width) throw failure('UNSUPPORTED_TYPE', `Input type ${type} is not supported by generated data.`, { type });
  return count * width;
}
function fill(target, source, callback, useBigInt = false) { for (let index = 0; index < target.length; index += 1) { const value = source ? source[index] : callback(index); target[index] = useBigInt ? BigInt(value) : value; } return target; }
function failure(code, message, detail = {}) { const error = new Error(message); error.code = code; error.detail = detail; return error; }
function float32ToFloat16(value) {
  const float = new Float32Array([value]); const bits = new Uint32Array(float.buffer)[0]; const sign = (bits >> 16) & 0x8000; let exponent = ((bits >> 23) & 0xff) - 127 + 15; let mantissa = bits & 0x7fffff;
  if (exponent <= 0) return sign; if (exponent >= 31) return sign | 0x7c00; mantissa >>= 13; return sign | (exponent << 10) | mantissa;
}

async function timedRun(feeds, measure) {
  const start = performance.now(); const outputs = await session.run(feeds); let bytes = 0;
  for (const output of Object.values(outputs)) { const data = output.getData ? await output.getData() : output.data; bytes += data?.byteLength || 0; output.dispose?.(); }
  return { time: measure ? performance.now() - start : 0, bytes };
}
