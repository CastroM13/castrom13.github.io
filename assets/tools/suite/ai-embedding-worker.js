let extractor = null;
let generation = 0;
let loadingPromise = null;
let inferenceQueue = Promise.resolve();

self.onmessage = ({ data }) => {
  let operation;
  if (data.type === 'load') operation = load(data.requestId);
  if (data.type === 'embed') {
    operation = inferenceQueue.then(() => embed(data.requestId, data.texts));
    inferenceQueue = operation.then(() => undefined, () => undefined);
  }
  if (data.type === 'release') operation = release(data.requestId, ++generation);
  if (!operation) return;
  operation.catch((error) => self.postMessage({ type: 'error', requestId: data.requestId, message: error?.message || String(error) }));
};

async function load(requestId) {
  if (extractor) { self.postMessage({ type: 'ready', requestId }); return; }
  if (!loadingPromise) loadingPromise = createExtractor(requestId, ++generation);
  const operation = loadingPromise;
  try { await operation; } finally { if (loadingPromise === operation) loadingPromise = null; }
  if (!extractor) throw new DOMException('Embedding model load was canceled.', 'AbortError');
  self.postMessage({ type: 'ready', requestId });
}

async function createExtractor(requestId, currentGeneration) {
  const { env, pipeline } = await import('/vendor/transformers/transformers.bundle.min.js');
  if (currentGeneration !== generation) return;
  env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/';
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  const candidate = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (progress) => self.postMessage({
      type: 'progress', requestId, status: progress?.status || '', file: progress?.file || progress?.name || '',
      progress: Number.isFinite(progress?.progress) ? progress.progress : null
    })
  });
  if (currentGeneration !== generation) { await candidate.dispose?.(); return; }
  extractor = candidate;
}

async function embed(requestId, texts) {
  if (!extractor) throw new Error('Load the semantic embedding model first.');
  if (!Array.isArray(texts) || !texts.length || texts.length > 100) throw new RangeError('Embed between 1 and 100 records per batch.');
  const normalized = texts.map((text) => String(text || '').slice(0, 20_000));
  let output = null;
  try {
    output = await extractor(normalized, { pooling: 'mean', normalize: true });
    const dimensions = Number(output?.dims?.at(-1));
    if (!Number.isSafeInteger(dimensions) || dimensions < 16 || output.data.length !== normalized.length * dimensions) throw new Error('Embedding model returned an unexpected tensor shape.');
    const embeddings = normalized.map((_, index) => Array.from(output.data.slice(index * dimensions, (index + 1) * dimensions)));
    self.postMessage({ type: 'complete', requestId, dimensions, embeddings });
  } finally { output?.dispose?.(); }
}

async function release(requestId, currentGeneration) {
  const current = extractor; extractor = null;
  const loading = loadingPromise;
  try { await loading; } catch (_) { /* the requesting load reports its own error */ }
  if (current) await current.dispose?.();
  if (currentGeneration === generation) self.postMessage({ type: 'released', requestId });
}
