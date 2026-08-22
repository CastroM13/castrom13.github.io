import { context, downloadJson, formatBytes, formatDuration, percentile, setStatus } from '../toolkit.js';

const app = context('edgebench');
if (app) initialize(app);

function initialize({ root, t }) {
  root.innerHTML = `<div class="workbench-layout"><form class="workbench-controls" data-form><div class="workbench-section-heading"><h2>${t('Configure benchmark', 'Configurar benchmark')}</h2><span>${t('Runtime on demand', 'Runtime sob demanda')}</span></div>
    <label class="field-label" for="onnx-model">${t('ONNX model', 'Modelo ONNX')}</label><input class="file-input" id="onnx-model" type="file" accept=".onnx,application/octet-stream" required data-model>
    <label class="field-label" for="onnx-data">${t('External weights (optional)', 'Pesos externos (opcional)')}</label><input class="file-input" id="onnx-data" type="file" data-external><label class="field-label" for="external-path">${t('External path stored in model', 'Caminho externo armazenado no modelo')}</label><input class="text-input" id="external-path" value="./model.data" data-external-path>
    <fieldset class="segmented-fieldset"><legend>${t('Backend', 'Backend')}</legend><label><input type="radio" name="backend" value="webgpu" checked><span>WebGPU</span></label><label><input type="radio" name="backend" value="wasm"><span>WASM</span></label></fieldset>
    <div class="field-grid"><label><span class="field-label">${t('Warm-up runs', 'Execuções de aquecimento')}</span><input class="number-input" type="number" min="0" max="50" value="3" data-warmups></label><label><span class="field-label">${t('Measured runs', 'Execuções medidas')}</span><input class="number-input" type="number" min="3" max="200" value="20" data-runs></label></div>
    <label class="field-label" for="shape-overrides">${t('Shape overrides JSON', 'JSON de dimensões substitutas')}</label><textarea class="code-input" id="shape-overrides" rows="5" spellcheck="false" data-shapes placeholder='{"input": [1, 3, 224, 224]}'></textarea>
    <label class="field-label" for="sample-inputs">${t('Flat sample arrays JSON (optional)', 'Arrays planos de amostra JSON (opcional)')}</label><textarea class="code-input" id="sample-inputs" rows="5" spellcheck="false" data-samples placeholder='{"input": [0.1, 0.2]}'></textarea>
    <div class="button-row"><button class="button button-primary" type="submit">${t('Load and benchmark', 'Carregar e medir')}</button><button class="button button-secondary" type="button" disabled data-stop>${t('Stop and release', 'Parar e liberar')}</button></div><progress class="workbench-progress" max="1" value="0" hidden aria-label="${t('Benchmark progress', 'Progresso do benchmark')}" data-progress></progress><p class="workbench-status" role="status" aria-live="polite" data-status></p></form>
    <section class="workbench-results" aria-labelledby="edge-results-title"><div class="workbench-section-heading"><h2 id="edge-results-title" tabindex="-1">${t('Benchmark result', 'Resultado do benchmark')}</h2><button class="text-button" type="button" disabled data-export>${t('Export raw timings', 'Exportar tempos brutos')}</button></div><div class="metric-grid" data-metrics></div><div hidden data-output><div class="notice-card"><strong>${t('A local measurement, not a device guarantee.', 'Uma medição local, não uma garantia do dispositivo.')}</strong><p data-environment></p></div><h3>${t('Inputs discovered', 'Entradas encontradas')}</h3><div class="table-scroll" role="region" tabindex="0" aria-label="${t('Model inputs table', 'Tabela de entradas do modelo')}"><table class="data-table"><caption>${t('Model input metadata and resolved shapes', 'Metadados e dimensões resolvidas das entradas')}</caption><thead><tr><th>${t('Name', 'Nome')}</th><th>${t('Type', 'Tipo')}</th><th>${t('Model shape', 'Dimensão do modelo')}</th><th>${t('Resolved', 'Resolvida')}</th></tr></thead><tbody data-inputs></tbody></table></div></div><div class="empty-result" data-empty><p>${t('The ~24 MiB runtime is fetched from this site only after you start. Model, weights, and samples remain in the worker.', 'O runtime de ~24 MiB é baixado deste site apenas ao iniciar. Modelo, pesos e amostras permanecem no worker.')}</p></div></section></div>`;
  const form = root.querySelector('[data-form]'); const status = root.querySelector('[data-status]'); const progress = root.querySelector('[data-progress]'); const stop = root.querySelector('[data-stop]'); const exportButton = root.querySelector('[data-export]'); let worker = null; let report = null; let metadata = null;
  function terminate() { if (worker) { worker.postMessage({ type: 'release' }); worker.terminate(); worker = null; } stop.disabled = true; progress.hidden = true; }
  form.addEventListener('submit', (event) => {
    event.preventDefault(); terminate(); report = null; exportButton.disabled = true;
    const model = root.querySelector('[data-model]').files[0]; const externalData = root.querySelector('[data-external]').files[0]; if (!model) return;
    if (model.size > 512 * 1024 * 1024) { setStatus(status, t('Models are limited to 512 MiB in this browser benchmark.', 'Modelos são limitados a 512 MiB neste benchmark.'), 'error'); return; }
    let shapes = {}; let samples = {};
    try { if (root.querySelector('[data-shapes]').value.trim()) shapes = JSON.parse(root.querySelector('[data-shapes]').value); if (root.querySelector('[data-samples]').value.trim()) samples = JSON.parse(root.querySelector('[data-samples]').value); }
    catch (_) { setStatus(status, t('Shape and sample inputs must be valid JSON objects.', 'Dimensões e amostras precisam ser objetos JSON válidos.'), 'error'); return; }
    const backend = form.elements.backend.value; worker = new Worker('/assets/tools/edgebench-worker.js', { type: 'module' }); stop.disabled = false; progress.hidden = false; progress.max = Number(root.querySelector('[data-runs]').value); progress.value = 0; setStatus(status, t('Starting isolated runtime…', 'Iniciando runtime isolado…'));
    worker.onmessage = ({ data }) => {
      if (data.type === 'status') setStatus(status, localizeRuntime(data.message, t));
      if (data.type === 'metadata') metadata = data;
      if (data.type === 'progress') { progress.max = data.total; progress.value = data.value; }
      if (data.type === 'error') { terminate(); setStatus(status, localizeRuntimeError(data, t), 'error'); }
      if (data.type === 'complete') { report = summarize(data); render(root, report, metadata, t); exportButton.disabled = false; root.querySelector('[data-output]').hidden = false; root.querySelector('[data-empty]').hidden = true; setStatus(status, t('Benchmark complete. The worker remains available until you stop or leave.', 'Benchmark concluído. O worker permanece disponível até você parar ou sair.'), 'success'); progress.hidden = true; root.querySelector('#edge-results-title').focus(); }
    };
    worker.postMessage({ type: 'benchmark', model, externalData, externalPath: root.querySelector('[data-external-path]').value, backend, warmups: Math.max(0, Math.min(50, Number(root.querySelector('[data-warmups]').value) || 0)), runs: Math.max(3, Math.min(200, Number(root.querySelector('[data-runs]').value) || 20)), shapes, samples });
  });
  stop.addEventListener('click', () => {
    terminate();
    setStatus(status, t('Runtime stopped and session released.', 'Runtime encerrado e sessão liberada.'), 'success');
    form.querySelector('button[type="submit"]').focus();
  });
  exportButton.addEventListener('click', () => report && downloadJson(report, 'edgebench-result.json')); addEventListener('pagehide', terminate, { once: true });
}
function localizeRuntime(message, t) { if (message.startsWith('Loading')) return t('Loading the local ONNX runtime…', 'Carregando o runtime ONNX local…'); const warm = message.match(/^Warming up (\d+) run/); if (warm) return t(message, `Executando ${warm[1]} ciclo(s) de aquecimento…`); const measure = message.match(/^Measuring (\d+) sequential/); if (measure) return t(message, `Medindo ${measure[1]} execução(ões) sequencial(is)…`); return message; }
function localizeRuntimeError(data, t) {
  const input = data.detail?.input || '';
  const messages = {
    MODEL_CAP: 'O modelo ONNX excede o limite de segurança de 512 MiB.',
    EXTERNAL_CAP: 'Os pesos externos excedem o limite de segurança de 512 MiB.',
    WEBGPU_UNAVAILABLE: 'WebGPU não está disponível neste navegador. Selecione WASM.',
    INPUT_CAP: 'Os tensores de entrada excedem o limite de segurança de 256 MiB.',
    NO_SHAPE: `A entrada ${input} não tem dimensão utilizável. Informe uma substituição em JSON.`,
    INVALID_DIMS: `A entrada ${input} contém dimensões simbólicas ou inválidas. Informe inteiros positivos.`,
    ELEMENT_CAP: `A entrada ${input} excede o limite de 64 milhões de elementos.`,
    SAMPLE_COUNT: `A amostra da entrada ${input} tem ${data.detail?.provided} valores; a dimensão exige ${data.detail?.required}.`,
    UNSUPPORTED_TYPE: `O tipo de entrada ${data.detail?.type || ''} não permite dados gerados.`
  };
  return t(data.message, messages[data.code] || 'O benchmark local falhou. Verifique o modelo, as dimensões de entrada e o backend selecionado.');
}
function summarize(data) { const mean = data.timings.reduce((sum, value) => sum + value, 0) / data.timings.length; return { tool: 'EdgeBench', generatedAt: new Date().toISOString(), backend: data.backend, environment: { userAgent: navigator.userAgent, crossOriginIsolated: data.crossOriginIsolated, wasmThreads: data.threads, webgpuAvailable: Boolean(navigator.gpu) }, loadMs: data.loadMs, timings: data.timings, statistics: { min: Math.min(...data.timings), mean, p50: percentile(data.timings, 0.5), p95: percentile(data.timings, 0.95), max: Math.max(...data.timings), sequentialInferencesPerSecond: 1000 / mean }, bytes: { model: data.modelBytes, inputs: data.inputBytes, outputs: data.outputBytes, lowerBound: data.modelBytes + data.inputBytes + data.outputBytes }, inputs: data.metadata }; }
function render(root, report, metadata, t) {
  const values = [['p50', formatDuration(report.statistics.p50)], ['p95', formatDuration(report.statistics.p95)], [t('Mean', 'Média'), formatDuration(report.statistics.mean)], [t('Sequential inferences/s', 'Inferências sequenciais/s'), report.statistics.sequentialInferencesPerSecond.toFixed(2)], [t('Session load', 'Carga da sessão'), formatDuration(report.loadMs)], [t('Memory lower bound', 'Limite inferior de memória'), formatBytes(report.bytes.lowerBound)]];
  const metrics = root.querySelector('[data-metrics]'); metrics.replaceChildren(...values.map(([label, value]) => { const item = document.createElement('div'); const span = document.createElement('span'); span.textContent = label; const strong = document.createElement('strong'); strong.textContent = value; item.append(span, strong); return item; }));
  root.querySelector('[data-environment]').textContent = report.backend === 'wasm' && !report.environment.crossOriginIsolated ? t('GitHub Pages does not provide cross-origin isolation here, so this WASM run used one thread. Power mode, thermals, other tabs, and operator support affect timing.', 'O GitHub Pages não fornece isolamento de origem aqui, então o WASM usou uma thread. Energia, temperatura, outras abas e suporte de operadores afetam o tempo.') : t('Power mode, thermal throttling, other tabs, and operator support affect this wall-clock measurement.', 'Energia, temperatura, outras abas e suporte de operadores afetam esta medição de tempo real.');
  const body = root.querySelector('[data-inputs]'); body.replaceChildren();
  for (const input of report.inputs) { const resolved = metadata?.resolved?.[input.name]; const row = document.createElement('tr'); for (const value of [input.name, input.type, JSON.stringify(input.shape), resolved ? `${JSON.stringify(resolved.dims)} · ${formatBytes(resolved.bytes)}` : '—']) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } body.append(row); }
}
