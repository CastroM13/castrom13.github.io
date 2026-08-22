let pipelineInstance = null;
let pipelineKey = '';
let multilingual = false;
let loadGeneration = 0;
let pendingDisposal = Promise.resolve();

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await loadModel(data, ++loadGeneration);
    if (data.type === 'transcribe') await transcribe(data);
    if (data.type === 'release') { loadGeneration += 1; await disposePipeline(); }
  } catch (error) { self.postMessage({ type: 'error', code: error.code || 'RUNTIME', operation: data.type, message: error.message || String(error), requestId: data.requestId, key: data.key }); }
};

async function disposePipeline() {
  const current = pipelineInstance; pipelineInstance = null; pipelineKey = ''; multilingual = false;
  const previous = pendingDisposal.catch(() => {});
  pendingDisposal = current?.dispose ? previous.then(() => current.dispose()) : previous;
  await pendingDisposal;
}

async function loadModel({ model, revision, device, key = `${model}:${revision}:${device}`, requestId }, generation) {
  if (pipelineInstance && pipelineKey === key) { self.postMessage({ type: 'ready', requestId, key }); return; }
  await disposePipeline();
  if (generation !== loadGeneration) return;
  self.postMessage({ type: 'status', message: 'Loading the local Transformers.js runtime…', requestId, key });
  const { env, pipeline } = await import('/vendor/transformers/transformers.bundle.min.js');
  if (generation !== loadGeneration) return;
  env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/';
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  const configuration = device === 'webgpu'
    ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }
    : { device: 'wasm', dtype: 'q8' };
  const candidate = await pipeline('automatic-speech-recognition', model, {
    ...configuration,
    revision,
    progress_callback: (progress) => { if (generation === loadGeneration) self.postMessage({ type: 'model-progress', progress: normalizeProgress(progress), requestId, key }); }
  });
  if (generation !== loadGeneration) { if (candidate?.dispose) await candidate.dispose(); return; }
  pipelineInstance = candidate;
  pipelineKey = key;
  multilingual = !model.includes('whisper-tiny.en_');
  self.postMessage({ type: 'ready', requestId, key });
}

async function transcribe({ audio, language, key }) {
  if (!pipelineInstance || key !== pipelineKey) { const error = new Error('Load the selected model before transcribing.'); error.code = 'MODEL_NOT_READY'; throw error; }
  const generation = loadGeneration; const current = pipelineInstance;
  const samples = new Float32Array(audio);
  self.postMessage({ type: 'status', message: 'Running local Whisper inference…', key });
  const result = await current(samples, {
    return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5,
    ...(multilingual ? { task: 'transcribe' } : {}),
    ...(multilingual && language && language !== 'auto' ? { language } : {})
  });
  if (generation === loadGeneration && current === pipelineInstance) self.postMessage({ type: 'complete', result, key });
}

function normalizeProgress(progress) {
  return {
    status: progress?.status || '',
    file: progress?.file || progress?.name || '',
    progress: Number.isFinite(progress?.progress) ? progress.progress : null,
    loaded: progress?.loaded || null,
    total: progress?.total || null
  };
}
