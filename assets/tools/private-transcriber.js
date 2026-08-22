import { context, downloadBlob, formatBytes, setStatus } from '../toolkit.js';

const app = context('private-transcriber');
if (app) initialize(app);

const MODELS = {
  english: { model: 'onnx-community/whisper-tiny.en_timestamped', revision: 'aeaa13760958b03fac5062f457d317d3319c3168' },
  multilingual: { model: 'onnx-community/whisper-tiny_timestamped', revision: '517244293732ee2d58139af5814231b7e6830a0d' }
};
const MAX_AUDIO_BYTES = 48 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 3 * 60;
const MAX_DECODED_PCM_BYTES = 96 * 1024 * 1024;
const TARGET_SAMPLE_RATE = 16_000;

function initialize({ root, t }) {
  root.innerHTML = `<div class="workbench-layout"><form class="workbench-controls" data-form><div class="workbench-section-heading"><h2>${t('Load and transcribe', 'Carregar e transcrever')}</h2><span>${t('Audio stays local', 'Áudio local')}</span></div>
    <label class="field-label" for="audio-file">${t('Audio file', 'Arquivo de áudio')}</label><input class="file-input" id="audio-file" type="file" accept="audio/*" aria-describedby="audio-limits" required data-file><p class="field-help" id="audio-limits">${t('Limits: 48 MiB per file, 3 minutes of decoded audio, and 96 MiB of estimated decoded PCM.', 'Limites: 48 MiB por arquivo, 3 minutos de áudio decodificado e estimativa de 96 MiB de PCM decodificado.')}</p>
    <label class="field-label" for="model-choice">${t('Model', 'Modelo')}</label><select id="model-choice" data-model><option value="english">Whisper Tiny · English · timestamped</option><option value="multilingual">Whisper Tiny · Multilingual · timestamped</option></select>
    <label class="field-label" for="transcript-language">${t('Spoken language', 'Idioma falado')}</label><select id="transcript-language" data-language-choice><option value="auto">${t('Detect automatically', 'Detectar automaticamente')}</option><option value="english">English</option><option value="portuguese">Português</option><option value="spanish">Español</option><option value="german">Deutsch</option><option value="french">Français</option><option value="japanese">日本語</option></select>
    <fieldset class="segmented-fieldset"><legend>${t('Backend', 'Backend')}</legend><label><input type="radio" name="transcriber-backend" value="webgpu" checked><span>WebGPU</span></label><label><input type="radio" name="transcriber-backend" value="wasm"><span>WASM</span></label></fieldset>
    <div class="notice-card"><strong>${t('First use downloads model assets.', 'O primeiro uso baixa os arquivos do modelo.')}</strong><p>${t('Approx. 120 MiB for WebGPU or 41 MiB for WASM, plus runtime/config files. These requests reveal normal network metadata to Hugging Face, never your audio. Browser cache may retain model files.', 'Aproximadamente 120 MiB no WebGPU ou 41 MiB no WASM, além de runtime/configuração. Essas requisições revelam metadados normais de rede ao Hugging Face, nunca seu áudio. O cache pode reter o modelo.')}</p></div>
    <div class="button-row"><button class="button button-secondary" type="button" data-load>${t('Load model', 'Carregar modelo')}</button><button class="button button-primary" type="submit" disabled data-transcribe>${t('Transcribe locally', 'Transcrever localmente')}</button><button class="button button-secondary" type="button" disabled data-stop>${t('Stop and release', 'Parar e liberar')}</button></div>
    <progress class="workbench-progress" max="100" value="0" hidden aria-label="${t('Model and transcription progress', 'Progresso do modelo e da transcrição')}" data-progress></progress><p class="workbench-status" role="status" aria-live="polite" data-status></p></form>
    <section class="workbench-results" aria-labelledby="transcript-results-title"><div class="workbench-section-heading"><h2 id="transcript-results-title" tabindex="-1">${t('Transcript', 'Transcrição')}</h2><div><button class="text-button" type="button" disabled data-export="txt">TXT</button><button class="text-button" type="button" disabled data-export="vtt">VTT</button><button class="text-button" type="button" disabled data-export="srt">SRT</button></div></div><div class="metric-grid" data-metrics></div><div hidden data-output><div class="transcript-text" tabindex="0" data-text></div><h3>${t('Timestamped cues', 'Trechos com tempo')}</h3><ol class="cue-list" data-cues></ol></div><div class="empty-result" data-empty><p>${t('Accuracy depends on language, speakers, noise, and device support. Review every transcript before relying on it.', 'A precisão depende do idioma, falantes, ruído e suporte do dispositivo. Revise toda transcrição antes de confiar nela.')}</p></div></section></div>`;
  const form = root.querySelector('[data-form]'); const load = root.querySelector('[data-load]'); const transcribe = root.querySelector('[data-transcribe]'); const stop = root.querySelector('[data-stop]'); const status = root.querySelector('[data-status]'); const progress = root.querySelector('[data-progress]'); let worker = null; let readyKey = ''; let activeLoadKey = ''; let loadSequence = 0; let activeLoadId = 0; let transcript = null; let decoded = null;
  function terminate() { activeLoadId = ++loadSequence; activeLoadKey = ''; if (worker) { worker.postMessage({ type: 'release', requestId: activeLoadId }); worker.terminate(); worker = null; } readyKey = ''; decoded = null; load.disabled = false; transcribe.disabled = true; stop.disabled = true; progress.hidden = true; }
  function settings() { const choice = root.querySelector('[data-model]').value; const device = form.elements['transcriber-backend'].value; return { choice, device, ...MODELS[choice], key: `${choice}:${device}` }; }
  async function ensureWorkerAndLoad() {
    const config = settings(); if (config.device === 'webgpu' && !navigator.gpu) throw new Error(t('WebGPU is unavailable. Choose WASM.', 'WebGPU não está disponível. Escolha WASM.'));
    if (!worker) { worker = new Worker('/assets/tools/private-transcriber-worker.js', { type: 'module' }); worker.onmessage = handleMessage; }
    const requestId = ++loadSequence; activeLoadId = requestId; activeLoadKey = config.key; readyKey = ''; load.disabled = true; transcribe.disabled = true;
    stop.disabled = false; progress.hidden = false; progress.max = 100; progress.value = 0; worker.postMessage({ type: 'load', ...config, requestId }); setStatus(status, t('Preparing runtime and model download…', 'Preparando runtime e download do modelo…'));
  }
  load.addEventListener('click', () => ensureWorkerAndLoad().catch((error) => setStatus(status, error.message, 'error')));
  function handleMessage({ data }) {
    if (data.requestId != null && (data.requestId !== activeLoadId || data.key !== activeLoadKey)) return;
    if (data.requestId == null && data.key && data.key !== readyKey) return;
    if (data.type === 'status') setStatus(status, data.message.includes('Whisper') ? t('Running local Whisper inference…', 'Executando inferência Whisper local…') : t('Loading the local AI runtime…', 'Carregando o runtime local de IA…'));
    if (data.type === 'model-progress') { const value = data.progress.progress; if (Number.isFinite(value)) progress.value = Math.max(progress.value, value); }
    if (data.type === 'ready') { if (data.key !== settings().key) return; readyKey = data.key; activeLoadKey = data.key; load.disabled = false; progress.hidden = true; transcribe.disabled = false; setStatus(status, t('Model ready. Select an audio file and start transcription.', 'Modelo pronto. Selecione um áudio e inicie a transcrição.'), 'success'); }
    if (data.type === 'error') { load.disabled = false; progress.hidden = true; transcribe.disabled = readyKey !== settings().key; setStatus(status, localizeWorkerError(data, t), 'error'); }
    if (data.type === 'complete') { load.disabled = false; progress.hidden = true; transcribe.disabled = false; transcript = normalizeTranscript(data.result); render(root, transcript, decoded, t); root.querySelectorAll('[data-export]').forEach((button) => { button.disabled = false; }); root.querySelector('[data-output]').hidden = false; root.querySelector('[data-empty]').hidden = true; setStatus(status, t('Transcription complete. Audio and transcript stayed in this tab.', 'Transcrição concluída. Áudio e texto permaneceram nesta aba.'), 'success'); root.querySelector('#transcript-results-title').focus(); }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); const file = root.querySelector('[data-file]').files[0]; if (!file) return; if (file.size > MAX_AUDIO_BYTES) { setStatus(status, t('Audio files are limited to 48 MiB.', 'Arquivos de áudio são limitados a 48 MiB.'), 'error'); return; }
    try { if (readyKey !== settings().key) { await ensureWorkerAndLoad(); setStatus(status, t('The selected model is loading. Start transcription when it reports ready.', 'O modelo selecionado está carregando. Inicie quando ele indicar que está pronto.')); return; } const transcriptionKey = readyKey; load.disabled = true; transcribe.disabled = true; setStatus(status, t('Checking, decoding, and resampling audio locally…', 'Verificando, decodificando e reamostrando o áudio localmente…')); decoded = await decodeAudio(file, t); if (transcriptionKey !== readyKey || transcriptionKey !== settings().key) throw new Error(t('Model setting changed while the audio was decoding. Load the selected model and try again.', 'A configuração do modelo mudou durante a decodificação. Carregue o modelo selecionado e tente novamente.')); progress.hidden = false; progress.removeAttribute('value'); worker.postMessage({ type: 'transcribe', key: transcriptionKey, audio: decoded.samples.buffer, language: root.querySelector('[data-language-choice]').value }, [decoded.samples.buffer]); }
    catch (error) { load.disabled = false; progress.hidden = true; transcribe.disabled = readyKey !== settings().key; setStatus(status, error.message, 'error'); }
  });
  stop.addEventListener('click', () => { terminate(); setStatus(status, t('Model, worker, and decoded audio released.', 'Modelo, worker e áudio decodificado liberados.'), 'success'); load.focus(); });
  root.addEventListener('click', (event) => { const button = event.target.closest('[data-export]'); if (!button || !transcript) return; const type = button.dataset.export; const content = type === 'txt' ? transcript.text : type === 'vtt' ? toVtt(transcript.cues) : toSrt(transcript.cues); downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), `private-transcript.${type}`); });
  root.querySelectorAll('[data-model], input[name="transcriber-backend"]').forEach((control) => control.addEventListener('change', () => { if (!readyKey && !activeLoadKey) return; terminate(); setStatus(status, t('Model setting changed. Load the selected model.', 'Configuração alterada. Carregue o modelo selecionado.'), 'warning'); }));
  addEventListener('pagehide', terminate, { once: true });
}

async function decodeAudio(file, t) {
  const duration = await probeAudioDuration(file, t);
  if (duration > MAX_AUDIO_SECONDS) throw new Error(t('Audio is limited to 3 minutes per run. Split longer recordings before transcribing.', 'O áudio é limitado a 3 minutos por execução. Divida gravações mais longas antes de transcrever.'));
  let context;
  try { context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE }); }
  catch (_) { throw new Error(t('This browser cannot create the memory-bounded 16 kHz audio decoder.', 'Este navegador não conseguiu criar o decodificador de áudio de 16 kHz com memória limitada.')); }
  let buffer = null;
  try {
    if (context.sampleRate !== TARGET_SAMPLE_RATE) throw new Error(t('This browser did not honor the memory-bounded 16 kHz decode rate.', 'Este navegador não respeitou a taxa de decodificação de 16 kHz com memória limitada.'));
    buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error(t('The browser reported an invalid audio duration.', 'O navegador informou uma duração de áudio inválida.'));
    if (buffer.duration > MAX_AUDIO_SECONDS) throw new Error(t('Audio is limited to 3 minutes per run. Split longer recordings before transcribing.', 'O áudio é limitado a 3 minutos por execução. Divida gravações mais longas antes de transcrever.'));
    if (!buffer.numberOfChannels || !buffer.length || !buffer.sampleRate) throw new Error(t('The browser decoded an empty audio stream.', 'O navegador decodificou um fluxo de áudio vazio.'));
    const decodedBytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    if (!Number.isFinite(decodedBytes) || decodedBytes > MAX_DECODED_PCM_BYTES) throw new Error(t('Decoded PCM is limited to an estimated 96 MiB. Try shorter audio or fewer channels.', 'O PCM decodificado é limitado a uma estimativa de 96 MiB. Tente um áudio mais curto ou com menos canais.'));
    const sourceDuration = buffer.duration; const sourceRate = buffer.sampleRate; const sourceChannels = buffer.numberOfChannels;
    const channels = Array.from({ length: sourceChannels }, (_, channel) => buffer.getChannelData(channel));
    const length = Math.ceil(sourceDuration * TARGET_SAMPLE_RATE); const samples = new Float32Array(length); const ratio = sourceRate / TARGET_SAMPLE_RATE;
    for (let index = 0; index < length; index += 1) {
      const position = index * ratio; const left = Math.floor(position); const right = Math.min(buffer.length - 1, left + 1); const fraction = position - left;
      let mixed = 0;
      for (const channel of channels) mixed += channel[left] * (1 - fraction) + channel[right] * fraction;
      samples[index] = mixed / sourceChannels;
    }
    channels.length = 0; buffer = null;
    return { samples, duration: sourceDuration, sourceRate, sourceChannels, sourceBytes: file.size };
  } finally { await context.close(); }
}

function probeAudioDuration(file, t) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error(t('Reading local audio metadata timed out.', 'A leitura local dos metadados do áudio excedeu o tempo limite.'))), 10_000);
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => {
      const duration = audio.duration;
      if (!Number.isFinite(duration) || duration <= 0) finish(new Error(t('The browser could not determine a safe audio duration.', 'O navegador não conseguiu determinar uma duração segura para o áudio.')));
      else finish(null, duration);
    }, { once: true });
    audio.addEventListener('error', () => finish(new Error(t('The browser could not read this audio file.', 'O navegador não conseguiu ler este arquivo de áudio.'))), { once: true });
    audio.src = url;
  });
}
function localizeWorkerError(data, t) {
  if (data.code === 'MODEL_NOT_READY') return t(data.message, 'Carregue o modelo selecionado antes de transcrever.');
  return data.operation === 'load'
    ? t(data.message, 'Não foi possível carregar o modelo neste dispositivo. Tente outro backend ou modelo.')
    : t(data.message, 'Não foi possível concluir a transcrição local. Tente outro backend ou arquivo de áudio.');
}
function normalizeTranscript(result) { const words = Array.isArray(result?.chunks) ? result.chunks.map((item) => ({ text: String(item.text || '').trim(), start: Number(item.timestamp?.[0] ?? 0), end: Number(item.timestamp?.[1] ?? item.timestamp?.[0] ?? 0) })).filter((item) => item.text) : []; const cues = []; let current = null; for (const word of words) { if (!current) current = { start: word.start, end: word.end, text: word.text }; else if (word.end - current.start <= 7 && current.text.length < 90) { current.end = word.end; current.text += `${/^[,.;:!?]/.test(word.text) ? '' : ' '}${word.text}`; } else { cues.push(current); current = { start: word.start, end: word.end, text: word.text }; } } if (current) cues.push(current); if (!cues.length && result?.text) cues.push({ start: 0, end: 0, text: String(result.text).trim() }); return { text: String(result?.text || cues.map((cue) => cue.text).join(' ')).trim(), cues }; }
function render(root, transcript, audio, t) { root.querySelector('[data-text]').textContent = transcript.text; const list = root.querySelector('[data-cues]'); list.replaceChildren(); for (const cue of transcript.cues) { const item = document.createElement('li'); const time = document.createElement('time'); time.textContent = `${clock(cue.start)} → ${clock(cue.end)}`; const text = document.createElement('span'); text.textContent = cue.text; item.append(time, text); list.append(item); } const metrics = root.querySelector('[data-metrics]'); const values = [[t('Duration', 'Duração'), audio ? clock(audio.duration) : '—'], [t('Cues', 'Trechos'), transcript.cues.length], [t('Characters', 'Caracteres'), transcript.text.length], [t('Audio uploaded', 'Áudio enviado'), '0 B']]; metrics.replaceChildren(...values.map(([label, value]) => { const item = document.createElement('div'); const span = document.createElement('span'); span.textContent = label; const strong = document.createElement('strong'); strong.textContent = value; item.append(span, strong); return item; })); }
function clock(seconds) { const safe = Math.max(0, Number(seconds) || 0); const hours = Math.floor(safe / 3600); const minutes = Math.floor((safe % 3600) / 60); const secs = safe % 60; return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`; }
function toVtt(cues) { return `WEBVTT\n\n${cues.map((cue) => `${clock(cue.start).replace('.', '.')} --> ${clock(cue.end).replace('.', '.')}\n${cue.text}`).join('\n\n')}\n`; }
function toSrt(cues) { return `${cues.map((cue, index) => `${index + 1}\n${clock(cue.start).replace('.', ',')} --> ${clock(cue.end).replace('.', ',')}\n${cue.text}`).join('\n\n')}\n`; }
