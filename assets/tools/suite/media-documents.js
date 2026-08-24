import { downloadBlob, formatBytes, loadScript, sanitizeFilename, setStatus } from '../../toolkit.js';

export const toolKeys = Object.freeze([
  'video-editor',
  'animation-studio',
  'subtitle-editor',
  'audio-converter',
  'daw-lite',
  'audio-restoration',
  'music-analyzer',
  'pdf-toolbox',
  'pdf-editor',
  'office-viewer',
  'epub-studio',
  'publishing-studio',
  'archive-manager'
]);

const MiB = 1024 * 1024;
const MAX_MEDIA_BYTES = 768 * MiB;
const MAX_AUDIO_BYTES = 256 * MiB;
const MAX_AUDIO_SECONDS = 60 * 60;
const MAX_AUDIO_FRAMES = 80_000_000;
const MAX_DOCUMENT_BYTES = 256 * MiB;
const MAX_ARCHIVE_BYTES = 256 * MiB;
const MAX_ARCHIVE_FILES = 2_000;
const MAX_EXTRACTED_BYTES = 512 * MiB;
const MAX_ARCHIVE_ENTRY_BYTES = 256 * MiB;
const MAX_TEXT_CHARS = 4_000_000;
const encoder = new TextEncoder();
const utf8 = new TextDecoder();
const latin1 = new TextDecoder('latin1');

export function mountTool(key, app) {
  if (!toolKeys.includes(key)) throw new Error(`Unknown media/document tool: ${key}`);
  if (!app?.root || typeof app.t !== 'function') throw new TypeError('mountTool requires { root, t, pt }.');
  const mounts = {
    'video-editor': mountVideoEditor,
    'animation-studio': mountAnimationStudioV2,
    'subtitle-editor': mountSubtitleEditor,
    'audio-converter': mountAudioConverter,
    'daw-lite': mountDawLite,
    'audio-restoration': mountAudioRestoration,
    'music-analyzer': mountMusicAnalyzer,
    'pdf-toolbox': mountPdfToolbox,
    'pdf-editor': mountPdfEditor,
    'office-viewer': mountOfficeViewer,
    'epub-studio': mountEpubStudio,
    'publishing-studio': mountPublishingStudio,
    'archive-manager': mountArchiveManager
  };
  return mounts[key](app);
}

function fail(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

function checkedFile(file, maximum, t, label = 'file') {
  if (!file) throw fail(t(`Choose a ${label} first.`, `Escolha um ${label} primeiro.`));
  if (!file.size) throw fail(t('Empty files are not supported.', 'Arquivos vazios não são compatíveis.'));
  if (file.size > maximum) throw fail(t(`This file exceeds the ${formatBytes(maximum)} limit.`, `Este arquivo excede o limite de ${formatBytes(maximum)}.`));
  return file;
}

function renderError(error, t, fallback) {
  return error?.userFacing ? error.message : t(`${fallback}: ${error?.message || 'unknown error'}`, 'Não foi possível concluir a operação local. Verifique o formato, a compatibilidade e os limites do arquivo.');
}

function commonLayout(t, heading, headingPt, badge, badgePt, controls, results) {
  return `<div class="workbench-layout"><section class="workbench-controls"><div class="workbench-section-heading"><h2>${t(heading, headingPt)}</h2><span>${t(badge, badgePt)}</span></div>${controls}<p class="workbench-status" role="status" aria-live="polite" data-status></p></section><section class="workbench-results">${results}</section></div>`;
}

function metricGrid(root, values) {
  const grid = root.querySelector('[data-metrics]');
  if (!grid) return;
  grid.replaceChildren(...values.map(([label, value]) => {
    const item = root.ownerDocument.createElement('div');
    const span = root.ownerDocument.createElement('span');
    const strong = root.ownerDocument.createElement('strong');
    span.textContent = label;
    strong.textContent = String(value);
    item.append(span, strong);
    return item;
  }));
}

function attachCleanup(root, callback) {
  root.ownerDocument.defaultView?.addEventListener('pagehide', callback, { once: true });
  return callback;
}

function makeObjectUrl(root, blob, urls) {
  const view = root.ownerDocument.defaultView;
  if (!view?.URL) throw new Error('Object URLs are unavailable.');
  const url = view.URL.createObjectURL(blob);
  urls.add(url);
  return url;
}

function clearUrls(root, urls) {
  const URLApi = root.ownerDocument.defaultView?.URL;
  for (const url of urls) URLApi?.revokeObjectURL(url);
  urls.clear();
}

function stem(name, fallback) {
  return sanitizeFilename(String(name || '').replace(/\.[^.]+$/, ''), fallback);
}

function colorRgb(value) {
  const match = String(value).match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  return match ? match.slice(1).map((part) => Number.parseInt(part, 16) / 255) : [0, 0, 0];
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseTimestamp(value) {
  const text = String(value).trim().replace(',', '.');
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const match = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!match) throw new Error(`Invalid timestamp: ${value}`);
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) throw new Error(`Invalid timestamp: ${value}`);
  return hours * 3600 + minutes * 60 + seconds + Number(`0.${(match[4] || '').padEnd(3, '0') || '0'}`);
}

export function formatTimestamp(seconds, separator = ',') {
  if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('Timestamp must be a non-negative finite number.');
  let milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000); milliseconds -= hours * 3_600_000;
  const minutes = Math.floor(milliseconds / 60_000); milliseconds -= minutes * 60_000;
  const wholeSeconds = Math.floor(milliseconds / 1000); milliseconds -= wholeSeconds * 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}${separator}${String(milliseconds).padStart(3, '0')}`;
}

function cueId(index) { return `cue-${index + 1}`; }

export function parseSubtitles(source, hintedFormat = '') {
  const text = String(source).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const hint = String(hintedFormat).toLowerCase();
  if (hint === 'ass' || hint.endsWith('.ass') || /^\s*\[Script Info\]/im.test(text)) return parseAss(text);
  const vtt = hint === 'vtt' || hint.endsWith('.vtt') || /^WEBVTT(?:\s|$)/.test(text);
  const lines = text.split('\n');
  const cues = [];
  let index = vtt && /^WEBVTT/.test(lines[0]) ? 1 : 0;
  while (index < lines.length) {
    while (index < lines.length && !lines[index].trim()) index += 1;
    if (index >= lines.length) break;
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[index])) {
      index += 1;
      while (index < lines.length && lines[index].trim()) index += 1;
      continue;
    }
    let identifier = '';
    if (!lines[index].includes('-->')) { identifier = lines[index].trim(); index += 1; }
    const timing = lines[index]?.match(/^\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})(?:\s+(.*))?\s*$/);
    if (!timing) throw new Error(`Expected a cue timing near line ${index + 1}.`);
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    if (end <= start) throw new Error(`Cue ending near line ${index + 1} must be after its start.`);
    index += 1;
    const payload = [];
    while (index < lines.length && lines[index].trim()) { payload.push(lines[index]); index += 1; }
    cues.push({ id: identifier || cueId(cues.length), start, end, text: payload.join('\n'), settings: timing[3] || '' });
    if (cues.length > 20_000) throw new Error('Subtitle files are limited to 20,000 cues.');
  }
  return { format: vtt ? 'vtt' : 'srt', cues };
}

function parseAss(text) {
  const lines = text.split('\n');
  let inEvents = false;
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const cues = [];
  for (const line of lines) {
    if (/^\s*\[Events\]\s*$/i.test(line)) { inEvents = true; continue; }
    if (/^\s*\[/.test(line)) { inEvents = false; continue; }
    if (!inEvents) continue;
    const format = line.match(/^\s*Format\s*:\s*(.*)$/i);
    if (format) { fields = format[1].split(',').map((item) => item.trim().toLowerCase()); continue; }
    const dialogue = line.match(/^\s*Dialogue\s*:\s*(.*)$/i);
    if (!dialogue) continue;
    const parts = dialogue[1].split(',');
    if (parts.length < fields.length) continue;
    const values = {};
    fields.forEach((field, index) => { values[field] = index === fields.length - 1 ? parts.slice(index).join(',') : parts[index]; });
    const start = parseTimestamp(values.start);
    const end = parseTimestamp(values.end);
    if (end <= start) continue;
    cues.push({ id: cueId(cues.length), start, end, text: String(values.text || '').replaceAll('\\N', '\n').replace(/\{[^}]*\}/g, ''), settings: '', style: values.style || 'Default' });
    if (cues.length > 20_000) throw new Error('Subtitle files are limited to 20,000 cues.');
  }
  return { format: 'ass', cues };
}

export function transformCues(cues, { offset = 0, speed = 1, find = '', replacement = '' } = {}) {
  if (!Number.isFinite(offset) || !Number.isFinite(speed) || speed <= 0) throw new TypeError('Offset and speed must be finite; speed must be positive.');
  return cues.map((cue, index) => {
    const start = Math.max(0, cue.start / speed + offset);
    const end = Math.max(start + 0.001, cue.end / speed + offset);
    const text = find ? cue.text.split(find).join(replacement) : cue.text;
    return { ...cue, id: cue.id || cueId(index), start, end, text };
  });
}

export function validateCues(cues) {
  const issues = [];
  cues.forEach((cue, index) => {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start) issues.push({ index, type: 'timing' });
    if (!String(cue.text || '').trim()) issues.push({ index, type: 'empty' });
    if (index && cue.start < cues[index - 1].end) issues.push({ index, type: 'overlap' });
  });
  return issues;
}

export function serializeSubtitles(cues, format = 'srt') {
  const kind = format.toLowerCase();
  if (kind === 'vtt') {
    return `WEBVTT\n\n${cues.map((cue) => `${formatTimestamp(cue.start, '.')} --> ${formatTimestamp(cue.end, '.')}${cue.settings ? ` ${cue.settings}` : ''}\n${cue.text}`).join('\n\n')}\n`;
  }
  if (kind === 'ass') {
    const header = '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    const assTime = (value) => formatTimestamp(value, '.').replace(/^0/, '').replace(/\.\d$/, '$&0').replace(/\.\d{3}$/, (part) => part.slice(0, 3));
    return header + cues.map((cue) => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},${cue.style || 'Default'},,0,0,0,,${cue.text.replaceAll('\n', '\\N')}`).join('\n') + '\n';
  }
  return cues.map((cue, index) => `${index + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}`).join('\n\n') + '\n';
}

export function encodeWav(channels, sampleRate, options = {}) {
  if (!Array.isArray(channels) || !channels.length || channels.length > 8) throw new TypeError('WAV encoding requires one to eight channels.');
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000) throw new RangeError('Unsupported sample rate.');
  const frames = channels[0].length;
  if (!channels.every((channel) => channel instanceof Float32Array && channel.length === frames)) throw new TypeError('Channels must be equal-length Float32Arrays.');
  const float = options.float === true;
  const bitDepth = float ? 32 : Number(options.bitDepth || 16);
  if (!float && ![16, 24, 32].includes(bitDepth)) throw new RangeError('PCM bit depth must be 16, 24, or 32.');
  const bytesPerSample = bitDepth / 8;
  const dataSize = frames * channels.length * bytesPerSample;
  if (dataSize > 0xffffffff - 44) throw new RangeError('WAV exceeds the RIFF 4 GiB limit.');
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, channels.length, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * bytesPerSample, true); view.setUint16(32, channels.length * bytesPerSample, true); view.setUint16(34, bitDepth, true);
  writeAscii(bytes, 36, 'data'); view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame] || 0));
      if (float) { view.setFloat32(offset, sample, true); offset += 4; }
      else if (bitDepth === 16) { view.setInt16(offset, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true); offset += 2; }
      else if (bitDepth === 24) { let value = sample < 0 ? Math.round(sample * 8388608) : Math.round(sample * 8388607); if (value < 0) value += 0x1000000; bytes[offset] = value & 255; bytes[offset + 1] = (value >>> 8) & 255; bytes[offset + 2] = (value >>> 16) & 255; offset += 3; }
      else { view.setInt32(offset, sample < 0 ? Math.round(sample * 2147483648) : Math.round(sample * 2147483647), true); offset += 4; }
    }
  }
  return bytes;
}

function writeAscii(target, offset, value) {
  for (let index = 0; index < value.length; index += 1) target[offset + index] = value.charCodeAt(index);
}

export function resampleLinear(channel, sourceRate, targetRate) {
  if (!(channel instanceof Float32Array) || sourceRate <= 0 || targetRate <= 0) throw new TypeError('Invalid resampling input.');
  if (sourceRate === targetRate) return channel.slice();
  const length = Math.max(1, Math.round(channel.length * targetRate / sourceRate));
  const output = new Float32Array(length);
  const scale = sourceRate / targetRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * scale;
    const left = Math.min(channel.length - 1, Math.floor(position));
    const right = Math.min(channel.length - 1, left + 1);
    const fraction = position - left;
    output[index] = channel[left] * (1 - fraction) + channel[right] * fraction;
  }
  return output;
}

export function restoreAudio(channel, sampleRate, options = {}) {
  if (!(channel instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('Invalid audio samples.');
  const highPassHz = Math.max(0, Math.min(sampleRate * 0.45, Number(options.highPassHz || 0)));
  const lowPassHz = Math.max(0, Math.min(sampleRate * 0.45, Number(options.lowPassHz || 0)));
  const gateDb = Number.isFinite(Number(options.gateDb)) ? Number(options.gateDb) : -90;
  const gate = 10 ** (gateDb / 20);
  const output = new Float32Array(channel.length);
  let previousInput = 0; let highState = 0; let lowState = 0;
  const highAlpha = highPassHz ? 1 / (1 + 2 * Math.PI * highPassHz / sampleRate) : 0;
  const lowAlpha = lowPassHz ? 1 - Math.exp(-2 * Math.PI * lowPassHz / sampleRate) : 1;
  for (let index = 0; index < channel.length; index += 1) {
    let value = channel[index];
    if (highPassHz) { highState = highAlpha * (highState + value - previousInput); previousInput = value; value = highState; }
    if (lowPassHz) { lowState += lowAlpha * (value - lowState); value = lowState; }
    output[index] = Math.abs(value) < gate ? 0 : value;
  }
  const fadeFrames = Math.min(output.length >> 1, Math.round(Math.max(0, Number(options.fadeMs || 0)) * sampleRate / 1000));
  for (let index = 0; index < fadeFrames; index += 1) {
    const gain = index / Math.max(1, fadeFrames);
    output[index] *= gain;
    output[output.length - 1 - index] *= gain;
  }
  if (options.normalize !== false) {
    let peak = 0;
    for (const value of output) peak = Math.max(peak, Math.abs(value));
    const target = 10 ** (Number(options.targetPeakDb ?? -1) / 20);
    const gain = peak > 0 ? Math.min(32, target / peak) : 1;
    for (let index = 0; index < output.length; index += 1) output[index] *= gain;
  }
  return output;
}

export function detectSilenceRegions(channel, sampleRate, options = {}) {
  if (!(channel instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('Invalid silence-detection input.');
  const thresholdDb = Math.max(-120, Math.min(0, Number.isFinite(Number(options.thresholdDb)) ? Number(options.thresholdDb) : -50));
  const minDurationMs = Math.max(1, Math.min(60_000, Number.isFinite(Number(options.minDurationMs)) ? Number(options.minDurationMs) : 300));
  const windowMs = Math.max(1, Math.min(1_000, Number.isFinite(Number(options.windowMs)) ? Number(options.windowMs) : 20));
  const maximumRegions = Math.max(1, Math.min(10_000, Math.floor(Number(options.maximumRegions) || 500)));
  const windowFrames = Math.max(1, Math.round(sampleRate * windowMs / 1000)); const minimumFrames = Math.max(1, Math.round(sampleRate * minDurationMs / 1000)); const threshold = 10 ** (thresholdDb / 20);
  const regions = []; let runStart = -1; let totalFrames = 0; let found = 0;
  const finishRun = (endFrame) => {
    if (runStart < 0) return; const length = endFrame - runStart;
    if (length >= minimumFrames) { found += 1; totalFrames += length; if (regions.length < maximumRegions) regions.push({ startFrame: runStart, endFrame, start: runStart / sampleRate, end: endFrame / sampleRate, duration: length / sampleRate }); }
    runStart = -1;
  };
  for (let start = 0; start < channel.length; start += windowFrames) {
    const end = Math.min(channel.length, start + windowFrames); let squared = 0;
    for (let index = start; index < end; index += 1) squared += channel[index] * channel[index];
    const rms = Math.sqrt(squared / Math.max(1, end - start));
    if (rms <= threshold) { if (runStart < 0) runStart = start; } else finishRun(start);
  }
  finishRun(channel.length);
  return { thresholdDb, minDurationMs, windowMs, regions, regionCount: found, totalSilentSeconds: totalFrames / sampleRate, coverage: channel.length ? totalFrames / channel.length : 0, truncated: found > regions.length };
}

export function computeSpectrogram(channel, sampleRate, options = {}) {
  if (!(channel instanceof Float32Array) || channel.length < 32 || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('Invalid spectrogram input.');
  const timeBins = Math.max(1, Math.min(320, Math.floor(Number(options.timeBins) || 220))); const frequencyBins = Math.max(4, Math.min(128, Math.floor(Number(options.frequencyBins) || 96)));
  const requestedWindow = Math.max(32, Math.min(2048, Math.floor(Number(options.windowSize) || 512))); const windowSize = Math.min(channel.length, requestedWindow);
  const minFrequency = Math.max(10, Math.min(sampleRate * 0.4, Number(options.minFrequency) || 40)); const maxFrequency = Math.max(minFrequency, Math.min(sampleRate * 0.48, Number(options.maxFrequency) || Math.min(8_000, sampleRate * 0.48)));
  const frequencies = Array.from({ length: frequencyBins }, (_, index) => minFrequency * (maxFrequency / minFrequency) ** (index / Math.max(1, frequencyBins - 1)));
  const coefficients = frequencies.map((frequency) => 2 * Math.cos(2 * Math.PI * frequency / sampleRate)); const values = []; let minimumDb = Infinity; let maximumDb = -Infinity;
  for (let time = 0; time < timeBins; time += 1) {
    const start = timeBins === 1 ? Math.max(0, Math.floor((channel.length - windowSize) / 2)) : Math.floor((channel.length - windowSize) * time / (timeBins - 1)); const row = new Array(frequencyBins);
    for (let bin = 0; bin < frequencyBins; bin += 1) {
      const coefficient = coefficients[bin]; let previous = 0; let previous2 = 0;
      for (let index = 0; index < windowSize; index += 1) { const weight = windowSize === 1 ? 1 : 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (windowSize - 1)); const current = channel[start + index] * weight + coefficient * previous - previous2; previous2 = previous; previous = current; }
      const power = Math.max(1e-16, previous2 * previous2 + previous * previous - coefficient * previous * previous2); const db = 10 * Math.log10(power / (windowSize * windowSize)); row[bin] = db; minimumDb = Math.min(minimumDb, db); maximumDb = Math.max(maximumDb, db);
    }
    values.push(row);
  }
  const ceilingDb = Math.max(-40, Math.min(0, Math.ceil(maximumDb / 5) * 5)); const floorDb = Math.max(-140, ceilingDb - 80);
  return { sampleRate, windowSize, timeBins, frequencyBins, minFrequency, maxFrequency, frequencies, values, minimumDb, maximumDb, floorDb, ceilingDb, duration: channel.length / sampleRate };
}

export function detectOnsets(channel, sampleRate, options = {}) {
  if (!(channel instanceof Float32Array) || channel.length < 32 || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('Invalid onset-detection input.');
  const frameMs = Math.max(5, Math.min(100, Number(options.frameMs) || 20)); const hopMs = Math.max(2, Math.min(frameMs, Number(options.hopMs) || 10)); const minimumIntervalMs = Math.max(20, Math.min(2_000, Number(options.minimumIntervalMs) || 80)); const sensitivity = Math.max(0.25, Math.min(6, Number(options.sensitivity) || 1.5)); const maximumOnsets = Math.max(1, Math.min(10_000, Math.floor(Number(options.maximumOnsets) || 2_000)));
  const frameSize = Math.max(1, Math.round(sampleRate * frameMs / 1000)); const hopSize = Math.max(1, Math.round(sampleRate * hopMs / 1000)); const count = Math.max(1, Math.floor(Math.max(0, channel.length - frameSize) / hopSize) + 1); const envelope = new Float32Array(count); let previous = 0;
  for (let frame = 0; frame < count; frame += 1) { const start = frame * hopSize; let energy = 0; for (let index = start; index < Math.min(channel.length, start + frameSize); index += 1) energy += channel[index] * channel[index]; const current = Math.sqrt(energy / Math.max(1, Math.min(frameSize, channel.length - start))); envelope[frame] = Math.max(0, current - previous * 0.92); previous = current; }
  const radius = Math.max(2, Math.round(120 / hopMs)); const minimumFrames = Math.max(1, Math.round(minimumIntervalMs / hopMs)); const candidates = [];
  for (let frame = 1; frame + 1 < count; frame += 1) { const first = Math.max(0, frame - radius); const last = Math.min(count, frame + radius + 1); let sum = 0; let squares = 0; for (let index = first; index < last; index += 1) { sum += envelope[index]; squares += envelope[index] * envelope[index]; } const samples = last - first; const mean = sum / samples; const deviation = Math.sqrt(Math.max(0, squares / samples - mean * mean)); const value = envelope[frame]; if (value > 1e-6 && value >= envelope[frame - 1] && value > envelope[frame + 1] && value > mean + sensitivity * deviation) { const lastCandidate = candidates.at(-1); if (lastCandidate && frame - lastCandidate.frame < minimumFrames) { if (value > lastCandidate.value) candidates[candidates.length - 1] = { frame, value }; } else candidates.push({ frame, value }); } }
  let maximumStrength = 1e-12; for (const entry of candidates) maximumStrength = Math.max(maximumStrength, entry.value); const onsets = candidates.slice(0, maximumOnsets).map((entry) => ({ time: entry.frame * hopSize / sampleRate, strength: entry.value / maximumStrength }));
  return { onsets, count: candidates.length, truncated: candidates.length > onsets.length, frameMs, hopMs, minimumIntervalMs, sensitivity };
}

export function mixPcmTracks(tracks, sampleRate, durationSeconds = null) {
  if (!Array.isArray(tracks) || !tracks.length || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('Invalid mix.');
  const settings = tracks.map((track) => {
    const offset = Number(track.offset ?? 0); const gain = Number(track.gain ?? 1); const pan = Number(track.pan ?? 0); const channels = track.channels;
    if (!Array.isArray(channels) || !channels.length || channels.length > 2 || !channels.every((channel) => channel instanceof Float32Array && channel.length === channels[0].length)) throw new TypeError('Each mix track needs one or two equal-length Float32Array channels.');
    if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(gain) || gain < 0 || !Number.isFinite(pan)) throw new TypeError('Track offset, gain, and pan must be finite; offset and gain cannot be negative.');
    const sourceDuration = channels[0].length / sampleRate; const trimStart = Number(track.trimStart ?? 0); const trimEnd = Number(track.trimEnd ?? sourceDuration); const fadeIn = Number(track.fadeIn ?? 0); const fadeOut = Number(track.fadeOut ?? 0); const lowPassHz = Number(track.lowPassHz ?? 0);
    if (![trimStart, trimEnd, fadeIn, fadeOut, lowPassHz].every(Number.isFinite)) throw new TypeError('Track edits must be finite numbers.');
    if (trimStart < 0 || trimEnd <= trimStart || trimEnd > sourceDuration + 1 / sampleRate) throw new RangeError('Track trim must stay inside the source and end after it starts.');
    const startFrame = Math.max(0, Math.min(channels[0].length, Math.round(trimStart * sampleRate))); const endFrame = Math.max(startFrame, Math.min(channels[0].length, Math.round(trimEnd * sampleRate))); const editedFrames = endFrame - startFrame;
    if (!editedFrames) throw new RangeError('Track trim contains no audio frames.');
    const editedDuration = editedFrames / sampleRate;
    if (fadeIn < 0 || fadeOut < 0 || fadeIn > editedDuration || fadeOut > editedDuration || fadeIn + fadeOut > editedDuration + 1 / sampleRate) throw new RangeError('Track fades must fit inside the trimmed region.');
    if (lowPassHz < 0 || lowPassHz >= sampleRate / 2) throw new RangeError('Track low-pass cutoff must be zero or below Nyquist.');
    return { track, offset, gain: Math.min(4, gain), pan: Math.max(-1, Math.min(1, pan)), channels, startFrame, endFrame, editedFrames, fadeInFrames: Math.round(fadeIn * sampleRate), fadeOutFrames: Math.round(fadeOut * sampleRate), lowPassHz };
  });
  const inferred = Math.max(...settings.map(({ offset, editedFrames }) => offset + editedFrames / sampleRate));
  const duration = durationSeconds == null ? inferred : Number(durationSeconds);
  if (!Number.isFinite(duration) || duration < 0) throw new TypeError('Mix duration must be a non-negative finite number.');
  const frames = Math.ceil(duration * sampleRate);
  if (frames > MAX_AUDIO_FRAMES) throw new RangeError('Mixed output exceeds the decoded-frame safety cap.');
  const left = new Float32Array(frames); const right = new Float32Array(frames);
  for (const { track, offset: offsetSeconds, gain, pan, channels, startFrame, editedFrames, fadeInFrames, fadeOutFrames, lowPassHz } of settings) {
    if (track.mute) continue;
    const offset = Math.round(offsetSeconds * sampleRate);
    const leftGain = gain * Math.cos((pan + 1) * Math.PI / 4);
    const rightGain = gain * Math.sin((pan + 1) * Math.PI / 4);
    const sourceLeft = channels[0]; const sourceRight = channels[1] || sourceLeft;
    const filterAlpha = lowPassHz ? 1 - Math.exp(-2 * Math.PI * lowPassHz / sampleRate) : 1; let filteredLeft = 0; let filteredRight = 0;
    for (let index = 0; index < editedFrames && offset + index < frames; index += 1) {
      const sourceIndex = startFrame + index; let sourceLeftValue = sourceLeft[sourceIndex]; let sourceRightValue = sourceRight[sourceIndex];
      if (lowPassHz) { filteredLeft += filterAlpha * (sourceLeftValue - filteredLeft); filteredRight += filterAlpha * (sourceRightValue - filteredRight); sourceLeftValue = filteredLeft; sourceRightValue = filteredRight; }
      let envelope = 1; if (fadeInFrames) envelope *= Math.min(1, index / fadeInFrames); if (fadeOutFrames) envelope *= Math.min(1, (editedFrames - 1 - index) / fadeOutFrames);
      left[offset + index] += sourceLeftValue * leftGain * envelope;
      right[offset + index] += sourceRightValue * rightGain * envelope;
    }
  }
  let peak = 0;
  for (let index = 0; index < frames; index += 1) peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  if (peak > 1) for (let index = 0; index < frames; index += 1) { left[index] /= peak; right[index] /= peak; }
  return { channels: [left, right], peakBeforeLimiting: peak };
}

export function analyzePcm(channel, sampleRate) {
  if (!(channel instanceof Float32Array) || channel.length < 2 || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('Invalid PCM analysis input.');
  let sumSquares = 0; let peak = 0; let crossings = 0;
  for (let index = 0; index < channel.length; index += 1) {
    const value = channel[index]; sumSquares += value * value; peak = Math.max(peak, Math.abs(value));
    if (index && (value >= 0) !== (channel[index - 1] >= 0)) crossings += 1;
  }
  const rms = Math.sqrt(sumSquares / channel.length);
  const loudnessDb = 20 * Math.log10(Math.max(rms, 1e-12));
  const peakDb = 20 * Math.log10(Math.max(peak, 1e-12));
  const bpm = estimateBpm(channel, sampleRate);
  const spectrum = coarseSpectrum(channel, sampleRate, 48);
  const key = estimateMusicalKey(channel, sampleRate);
  const onsetAnalysis = detectOnsets(channel, sampleRate);
  return {
    duration: channel.length / sampleRate,
    rms,
    peak,
    loudnessDb,
    peakDb,
    crestDb: 20 * Math.log10(Math.max(peak / Math.max(rms, 1e-12), 1e-12)),
    zeroCrossingRate: crossings / (channel.length - 1),
    bpm: bpm.bpm,
    bpmConfidence: bpm.confidence,
    key: key.key,
    keyConfidence: key.confidence,
    spectrum,
    onsets: onsetAnalysis.onsets,
    onsetCount: onsetAnalysis.count,
    onsetTruncated: onsetAnalysis.truncated
  };
}

export function estimateMusicalKey(channel, sampleRate) {
  if (!(channel instanceof Float32Array) || channel.length < 2048 || sampleRate < 4_000) return { key: null, confidence: 0, chroma: Array(12).fill(0) };
  const windowSize = Math.min(8192, 2 ** Math.floor(Math.log2(channel.length)));
  const windows = Math.min(6, Math.max(1, Math.floor(channel.length / windowSize)));
  const chroma = Array(12).fill(0);
  for (let windowIndex = 0; windowIndex < windows; windowIndex += 1) {
    const start = windows === 1 ? Math.max(0, Math.floor((channel.length - windowSize) / 2)) : Math.floor((channel.length - windowSize) * windowIndex / (windows - 1));
    for (let midi = 36; midi <= 83; midi += 1) {
      const frequency = 440 * 2 ** ((midi - 69) / 12); if (frequency >= sampleRate * 0.48) continue;
      const omega = 2 * Math.PI * frequency / sampleRate; const coefficient = 2 * Math.cos(omega); let previous = 0; let previous2 = 0;
      for (let index = 0; index < windowSize; index += 1) { const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (windowSize - 1)); const current = channel[start + index] * weight + coefficient * previous - previous2; previous2 = previous; previous = current; }
      chroma[midi % 12] += Math.sqrt(Math.max(0, previous2 * previous2 + previous * previous - coefficient * previous * previous2));
    }
  }
  const total = chroma.reduce((sum, value) => sum + value, 0); if (!total) return { key: null, confidence: 0, chroma };
  for (let index = 0; index < 12; index += 1) chroma[index] /= total;
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minor = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']; const scores = [];
  for (let root = 0; root < 12; root += 1) for (const [mode, profile] of [['major', major], ['minor', minor]]) { let score = 0; for (let pitch = 0; pitch < 12; pitch += 1) score += chroma[(pitch + root) % 12] * profile[pitch]; scores.push({ key: `${names[root]} ${mode}`, score }); }
  scores.sort((a, b) => b.score - a.score); return { key: scores[0].key, confidence: Math.max(0, Math.min(1, (scores[0].score - scores[1].score) / Math.max(0.001, scores[0].score))), chroma };
}

export function estimateBpm(channel, sampleRate) {
  const envelopeRate = 200;
  const hop = Math.max(1, Math.round(sampleRate / envelopeRate));
  const count = Math.floor(channel.length / hop);
  if (count < envelopeRate * 4) return { bpm: null, confidence: 0 };
  const envelope = new Float32Array(count);
  let previous = 0; let mean = 0;
  for (let index = 0; index < count; index += 1) {
    let energy = 0;
    const start = index * hop;
    for (let sample = start; sample < Math.min(channel.length, start + hop); sample += 1) energy += channel[sample] * channel[sample];
    const current = Math.sqrt(energy / hop);
    envelope[index] = Math.max(0, current - previous * 0.93);
    previous = current; mean += envelope[index];
  }
  mean /= count;
  for (let index = 0; index < count; index += 1) envelope[index] -= mean;
  const minLag = Math.floor(envelopeRate * 60 / 200); const maxLag = Math.ceil(envelopeRate * 60 / 55);
  let bestLag = 0; let best = -Infinity; let total = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0; let normA = 0; let normB = 0;
    for (let index = lag; index < count; index += 1) { const a = envelope[index]; const b = envelope[index - lag]; score += a * b; normA += a * a; normB += b * b; }
    score /= Math.sqrt(normA * normB) || 1;
    total += Math.max(0, score);
    if (score > best) { best = score; bestLag = lag; }
  }
  let bpm = bestLag ? 60 * envelopeRate / bestLag : null;
  while (bpm && bpm < 70) bpm *= 2;
  while (bpm && bpm > 180) bpm /= 2;
  return { bpm: bpm ? Math.round(bpm * 10) / 10 : null, confidence: Math.max(0, Math.min(1, best / Math.max(0.05, total / (maxLag - minLag + 1)))) };
}

function coarseSpectrum(channel, sampleRate, bins) {
  const size = Math.min(4096, 2 ** Math.floor(Math.log2(channel.length)));
  const start = Math.max(0, Math.floor((channel.length - size) / 2));
  const output = [];
  const minHz = 30; const maxHz = Math.min(18_000, sampleRate / 2);
  for (let bin = 0; bin < bins; bin += 1) {
    const frequency = minHz * (maxHz / minHz) ** (bin / Math.max(1, bins - 1));
    const omega = 2 * Math.PI * frequency / sampleRate;
    const coefficient = 2 * Math.cos(omega);
    let previous = 0; let previous2 = 0;
    for (let index = 0; index < size; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (size - 1));
      const current = channel[start + index] * window + coefficient * previous - previous2;
      previous2 = previous; previous = current;
    }
    const power = previous2 * previous2 + previous * previous - coefficient * previous * previous2;
    output.push({ frequency: Math.round(frequency), db: 10 * Math.log10(Math.max(power / (size * size), 1e-12)) });
  }
  return output;
}

export function parsePageRanges(expression, pageCount, { allowGroups = false } = {}) {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new RangeError('pageCount must be positive.');
  const groups = String(expression || 'all').split(allowGroups ? ';' : /$^/).map((group) => group.trim() || 'all');
  return groups.map((group) => {
    if (group.toLowerCase() === 'all') return Array.from({ length: pageCount }, (_, index) => index);
    const pages = []; const seen = new Set();
    for (const raw of group.split(',')) {
      const token = raw.trim(); const match = token.match(/^(\d+)(?:-(\d+))?$/);
      if (!match) throw new Error(`Invalid page range: ${token || '(empty)'}`);
      const first = Number(match[1]); const last = Number(match[2] || match[1]);
      if (first < 1 || last < first || last > pageCount) throw new Error(`Page range ${token} is outside 1-${pageCount}.`);
      for (let page = first; page <= last; page += 1) { if (seen.has(page)) throw new Error(`Page ${page} is selected more than once.`); seen.add(page); pages.push(page - 1); }
    }
    return pages;
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let number = 0; number < 256; number += 1) {
    let value = number;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[number] = value >>> 0;
  }
  return table;
})();

export function crc32(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function normalizeArchivePath(value) {
  let path = String(value).replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.includes('\0') || /^\//.test(path) || /^[a-z]:/i.test(path)) throw new Error(`Unsafe archive path: ${value}`);
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Unsafe archive path: ${value}`);
    parts.push(part);
  }
  path = parts.join('/');
  if (!path) throw new Error(`Unsafe archive path: ${value}`);
  return path + (String(value).endsWith('/') ? '/' : '');
}

function libarchiveLimits(limits = {}) {
  const maximumFiles = limits.maximumFiles ?? MAX_ARCHIVE_FILES;
  const maximumExpanded = limits.maximumExpanded ?? MAX_EXTRACTED_BYTES;
  const maximumEntry = limits.maximumEntry ?? MAX_ARCHIVE_ENTRY_BYTES;
  if (![maximumFiles, maximumExpanded, maximumEntry].every((value) => Number.isInteger(value) && value >= 0)) throw new TypeError('Invalid libarchive safety limits.');
  return { maximumFiles, maximumExpanded, maximumEntry };
}

function validateLibarchiveEntry(raw, state, limits) {
  if (state.count >= limits.maximumFiles) throw new Error(`Archive contains more than ${limits.maximumFiles} entries.`);
  const originalName = String(raw.pathname ?? raw.name ?? ''); const type = String(raw.filetype ?? raw.type ?? 'Invalid'); const directory = type === 'Directory';
  if (!['File', 'Directory'].includes(type)) throw new Error(`Unsupported archive entry type ${type}: ${originalName || '(unnamed)'}`);
  if (raw.encrypted) throw new Error(`Encrypted archive entries are not supported: ${originalName || '(unnamed)'}`);
  if (raw.symlinkTarget || raw.hardlinkTarget) throw new Error(`Archive links are not extracted: ${originalName || '(unnamed)'}`);
  let name = normalizeArchivePath(originalName); if (directory && !name.endsWith('/')) name += '/';
  if (state.names.has(name)) throw new Error(`Duplicate normalized archive path: ${name}`);
  const size = Number(raw.size); if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid archive entry size: ${name}`);
  if (size > limits.maximumEntry) throw new Error(`Archive entry exceeds ${formatBytes(limits.maximumEntry)}: ${name}`);
  if (state.expanded + size > limits.maximumExpanded) throw new Error(`Expanded archive data exceeds ${formatBytes(limits.maximumExpanded)}.`);
  state.names.add(name); state.expanded += size; state.count += 1;
  return { name, size, directory, type, runtimeIndex: Number.isInteger(raw.runtimeIndex) ? raw.runtimeIndex : state.count - 1 };
}

export function validateLibarchiveEntries(entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError('Archive descriptors must be an array.');
  const limits = libarchiveLimits(options); const state = { count: 0, expanded: 0, names: new Set() };
  return entries.map((entry) => validateLibarchiveEntry(entry, state, limits));
}

async function createLibarchiveReader(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`Libarchive input must be 1 byte–${formatBytes(MAX_ARCHIVE_BYTES)}.`);
  const bundle = (await import('/vendor/suite/libarchive.js')).default;
  if (!bundle?.ArchiveReader || typeof bundle.libarchiveWasm !== 'function') throw new Error('The local libarchive runtime is unavailable.');
  const runtime = await bundle.libarchiveWasm({ locateFile: () => '/vendor/libarchive/libarchive.wasm' });
  const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { reader: new bundle.ArchiveReader(runtime, signed), runtime };
}

function rawLibarchiveEntry(entry, runtimeIndex) {
  return { pathname: entry.getPathname(), size: entry.getSize(), filetype: entry.getFiletype(), encrypted: entry.isEncrypted(), symlinkTarget: entry.getSymlinkTarget(), hardlinkTarget: entry.getHardlinkTarget(), runtimeIndex };
}

export async function inspectLibarchive(input, options = {}) {
  const limits = libarchiveLimits(options); const state = { count: 0, expanded: 0, names: new Set() }; let reader = null;
  try {
    const created = await createLibarchiveReader(input); reader = created.reader; const entries = []; let runtimeIndex = 0;
    for (const entry of reader.entries()) { entries.push(validateLibarchiveEntry(rawLibarchiveEntry(entry, runtimeIndex), state, limits)); runtimeIndex += 1; }
    if (reader.hasEncryptedData() === true) throw new Error('Encrypted archives are not supported.');
    if (!entries.length) throw new Error('Libarchive found no extractable regular files or directories.');
    return { entries, version: created.runtime.version_string() };
  } catch (error) { throw new Error(`Libarchive could not inspect this archive: ${error?.message || error}`); }
  finally { try { reader?.free(); } catch { /* runtime memory is discarded with this instance */ } }
}

export async function extractLibarchiveEntry(input, targetIndex, options = {}) {
  if (!Number.isInteger(targetIndex) || targetIndex < 0) throw new TypeError('Invalid libarchive entry index.');
  const limits = libarchiveLimits(options); const state = { count: 0, expanded: 0, names: new Set() }; let reader = null; let output = null; let descriptor = null;
  try {
    const created = await createLibarchiveReader(input); reader = created.reader; let runtimeIndex = 0;
    for (const entry of reader.entries()) {
      const current = validateLibarchiveEntry(rawLibarchiveEntry(entry, runtimeIndex), state, limits);
      if (runtimeIndex === targetIndex) {
        if (current.directory) throw new Error(`Cannot extract a directory as a file: ${current.name}`);
        const data = entry.readData(); output = data ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(); descriptor = current;
      }
      runtimeIndex += 1;
    }
    if (reader.hasEncryptedData() === true) throw new Error('Encrypted archives are not supported.');
    if (!descriptor || !output) throw new Error('The selected archive entry was not found.');
    if (output.length !== descriptor.size) throw new Error(`Extracted size does not match the archive header: ${descriptor.name}`);
    return { entry: descriptor, data: output };
  } catch (error) { throw new Error(`Libarchive could not extract this entry: ${error?.message || error}`); }
  finally { try { reader?.free(); } catch { /* runtime memory is discarded with this instance */ } }
}

function findZipEnd(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) if (readU32(bytes, offset) === 0x06054b50) return offset;
  return -1;
}

export function parseZipDirectory(input, limits = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const maximumFiles = limits.maximumFiles || MAX_ARCHIVE_FILES;
  const maximumExpanded = limits.maximumExpanded || MAX_EXTRACTED_BYTES;
  const end = findZipEnd(bytes);
  if (end < 0) throw new Error('ZIP end-of-directory record was not found.');
  const disk = readU16(bytes, end + 4); const centralDisk = readU16(bytes, end + 6);
  const entriesOnDisk = readU16(bytes, end + 8); const count = readU16(bytes, end + 10);
  const centralSize = readU32(bytes, end + 12); const centralOffset = readU32(bytes, end + 16);
  if (disk || centralDisk || entriesOnDisk !== count || count === 0xffff || centralOffset === 0xffffffff) throw new Error('Multi-disk and ZIP64 archives are not supported.');
  if (count > maximumFiles) throw new Error(`ZIP contains more than ${maximumFiles} entries.`);
  if (centralOffset + centralSize > bytes.length) throw new Error('ZIP central directory is truncated.');
  const entries = []; const names = new Set(); let offset = centralOffset; let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) throw new Error('Invalid ZIP central-directory entry.');
    const flags = readU16(bytes, offset + 8); const method = readU16(bytes, offset + 10); const crc = readU32(bytes, offset + 16);
    const compressedSize = readU32(bytes, offset + 20); const size = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28); const extraLength = readU16(bytes, offset + 30); const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const rawName = (flags & 0x800 ? utf8 : latin1).decode(nameBytes);
    const name = normalizeArchivePath(rawName);
    if (names.has(name)) throw new Error(`Duplicate normalized ZIP path: ${name}`); names.add(name);
    if (flags & 1) throw new Error(`Encrypted ZIP entry is not supported: ${name}`);
    if (![0, 8].includes(method) && !name.endsWith('/')) throw new Error(`Unsupported ZIP compression method ${method}: ${name}`);
    expanded += size;
    if (expanded > maximumExpanded) throw new Error(`Expanded ZIP data exceeds ${formatBytes(maximumExpanded)}.`);
    entries.push({ name, method, flags, crc, compressedSize, size, localOffset, directory: name.endsWith('/') });
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > centralOffset + centralSize) throw new Error('ZIP central directory is truncated.');
  }
  return entries;
}

export async function extractZipEntry(input, entry) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (readU32(bytes, entry.localOffset) !== 0x04034b50) throw new Error(`Invalid local ZIP header: ${entry.name}`);
  const nameLength = readU16(bytes, entry.localOffset + 26); const extraLength = readU16(bytes, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength; const end = start + entry.compressedSize;
  if (end > bytes.length) throw new Error(`Truncated ZIP entry: ${entry.name}`);
  let output;
  if (entry.method === 0) output = bytes.slice(start, end);
  else if (entry.method === 8) output = await decompressBytes(bytes.subarray(start, end), 'deflate-raw', { expectedSize: entry.size, maximumSize: entry.size });
  else throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
  if (output.length !== entry.size || crc32(output) !== entry.crc) throw new Error(`ZIP integrity check failed: ${entry.name}`);
  return output;
}

export function createZip(files, options = {}) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_ARCHIVE_FILES) throw new Error('ZIP creation requires 1-2,000 entries.');
  const names = new Set();
  const records = files.map((file) => {
    const name = normalizeArchivePath(file.name);
    if (names.has(name)) throw new Error(`Duplicate normalized ZIP path: ${name}`); names.add(name);
    const data = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data ?? ''));
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 0xffff) throw new Error(`ZIP path is too long: ${name}`);
    return { name, nameBytes, data, crc: crc32(data) };
  });
  let localSize = 0; let centralSize = 0;
  for (const record of records) { localSize += 30 + record.nameBytes.length + record.data.length; centralSize += 46 + record.nameBytes.length; }
  if (localSize + centralSize + 22 > 0xffffffff) throw new Error('ZIP output exceeds the 4 GiB limit.');
  const output = new Uint8Array(localSize + centralSize + 22); const view = new DataView(output.buffer);
  const stamp = options.date instanceof Date ? options.date : new Date('1980-01-01T00:00:00Z');
  const { time, date } = dosDateTime(stamp); let offset = 0;
  for (const record of records) {
    record.localOffset = offset; view.setUint32(offset, 0x04034b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 0x800, true); view.setUint16(offset + 8, 0, true); view.setUint16(offset + 10, time, true); view.setUint16(offset + 12, date, true); view.setUint32(offset + 14, record.crc, true); view.setUint32(offset + 18, record.data.length, true); view.setUint32(offset + 22, record.data.length, true); view.setUint16(offset + 26, record.nameBytes.length, true); view.setUint16(offset + 28, 0, true); output.set(record.nameBytes, offset + 30); output.set(record.data, offset + 30 + record.nameBytes.length); offset += 30 + record.nameBytes.length + record.data.length;
  }
  const centralOffset = offset;
  for (const record of records) {
    view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 20, true); view.setUint16(offset + 8, 0x800, true); view.setUint16(offset + 10, 0, true); view.setUint16(offset + 12, time, true); view.setUint16(offset + 14, date, true); view.setUint32(offset + 16, record.crc, true); view.setUint32(offset + 20, record.data.length, true); view.setUint32(offset + 24, record.data.length, true); view.setUint16(offset + 28, record.nameBytes.length, true); view.setUint16(offset + 30, 0, true); view.setUint16(offset + 32, 0, true); view.setUint16(offset + 34, 0, true); view.setUint16(offset + 36, 0, true); view.setUint32(offset + 38, record.name.endsWith('/') ? 0x10 : 0, true); view.setUint32(offset + 42, record.localOffset, true); output.set(record.nameBytes, offset + 46); offset += 46 + record.nameBytes.length;
  }
  view.setUint32(offset, 0x06054b50, true); view.setUint16(offset + 4, 0, true); view.setUint16(offset + 6, 0, true); view.setUint16(offset + 8, records.length, true); view.setUint16(offset + 10, records.length, true); view.setUint32(offset + 12, offset - centralOffset, true); view.setUint32(offset + 16, centralOffset, true); view.setUint16(offset + 20, 0, true);
  return output;
}

function dosDateTime(value) {
  const year = Math.max(1980, Math.min(2107, value.getUTCFullYear()));
  return { time: (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | Math.floor(value.getUTCSeconds() / 2), date: ((year - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate() };
}

function readU16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error('Unexpected end of binary data.');
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error('Unexpected end of binary data.');
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function decompressBytes(bytes, format, { expectedSize = null, maximumSize = MAX_EXTRACTED_BYTES } = {}) {
  if (!Number.isInteger(maximumSize) || maximumSize < 0) throw new TypeError('Invalid decompression size limit.');
  if (expectedSize != null && (!Number.isInteger(expectedSize) || expectedSize < 0 || expectedSize > maximumSize)) throw new Error(`Advertised ${format} output exceeds ${formatBytes(maximumSize)}.`);
  if (typeof DecompressionStream === 'function') {
    try {
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader(); const chunks = []; const target = expectedSize == null ? null : new Uint8Array(expectedSize); let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          if (total + value.length > maximumSize || target && total + value.length > target.length) { await reader.cancel(); throw new Error(`Expanded ${format} data exceeds its declared or configured size limit.`); }
          if (target) target.set(value, total); else chunks.push(value.slice()); total += value.length;
        }
      } finally { reader.releaseLock(); }
      if (expectedSize != null && total !== expectedSize) throw new Error(`Expanded ${format} size does not match its declared size.`);
      if (target) return target;
      const output = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; } return output;
    } catch (error) {
      if (/size limit|declared size/.test(error?.message || '')) throw error;
      /* use the local fallback below */
    }
  }
  const fflate = await import('/vendor/suite/fflate.js');
  const options = expectedSize == null ? undefined : { out: new Uint8Array(expectedSize) };
  const output = format === 'deflate-raw' ? fflate.inflateSync(bytes, options) : format === 'gzip' ? fflate.gunzipSync(bytes, options) : null;
  if (!output) throw new Error(`No local ${format} decompressor is available.`);
  if (output.length > maximumSize || expectedSize != null && output.length !== expectedSize) throw new Error(`Expanded ${format} data exceeds or does not match its size limit.`);
  return output;
}

async function compressBytes(bytes, format) {
  if (typeof CompressionStream === 'function') {
    try { const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format)); return new Uint8Array(await new Response(stream).arrayBuffer()); } catch { /* use the local fallback below */ }
  }
  if (format === 'gzip') return (await import('/vendor/suite/fflate.js')).gzipSync(bytes, { level: 6 });
  throw new Error(`No local ${format} compressor is available.`);
}

export function parseTar(input, maximumExpanded = MAX_EXTRACTED_BYTES) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries = []; let offset = 0; let expanded = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const storedChecksum = parseTarNumber(header.subarray(148, 156));
    let checksum = 0; for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (storedChecksum !== checksum) throw new Error('TAR header checksum mismatch.');
    const rawName = readTarString(header.subarray(0, 100)); const prefix = readTarString(header.subarray(345, 500));
    const name = normalizeArchivePath(prefix ? `${prefix}/${rawName}` : rawName);
    const size = parseTarNumber(header.subarray(124, 136)); const type = String.fromCharCode(header[156] || 48);
    const dataOffset = offset + 512; const next = dataOffset + Math.ceil(size / 512) * 512;
    if (next > bytes.length) throw new Error(`Truncated TAR entry: ${name}`);
    if (!['0', '\0', '5'].includes(type)) throw new Error(`Unsupported TAR entry type ${type}: ${name}`);
    expanded += size; if (expanded > maximumExpanded) throw new Error(`Expanded TAR data exceeds ${formatBytes(maximumExpanded)}.`);
    entries.push({ name: type === '5' && !name.endsWith('/') ? `${name}/` : name, size, type, dataOffset, directory: type === '5' });
    if (entries.length > MAX_ARCHIVE_FILES) throw new Error(`TAR contains more than ${MAX_ARCHIVE_FILES} entries.`);
    offset = next;
  }
  return entries;
}

export function createTar(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_ARCHIVE_FILES) throw new Error('TAR creation requires 1-2,000 entries.');
  const records = files.map((file) => ({ name: normalizeArchivePath(file.name), data: file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data ?? '')) }));
  let total = 1024;
  for (const record of records) total += 512 + Math.ceil(record.data.length / 512) * 512;
  const output = new Uint8Array(total); let offset = 0;
  for (const record of records) {
    const nameBytes = encoder.encode(record.name); if (nameBytes.length > 100) throw new Error(`TAR path exceeds 100 UTF-8 bytes: ${record.name}`);
    output.set(nameBytes, offset); writeTarOctal(output, offset + 100, 8, 0o644); writeTarOctal(output, offset + 108, 8, 0); writeTarOctal(output, offset + 116, 8, 0); writeTarOctal(output, offset + 124, 12, record.data.length); writeTarOctal(output, offset + 136, 12, 0);
    output.fill(32, offset + 148, offset + 156); output[offset + 156] = 48; writeAscii(output, offset + 257, 'ustar\0'); writeAscii(output, offset + 263, '00');
    let checksum = 0; for (let index = 0; index < 512; index += 1) checksum += output[offset + index];
    const checksumText = checksum.toString(8).padStart(6, '0'); writeAscii(output, offset + 148, checksumText); output[offset + 154] = 0; output[offset + 155] = 32;
    output.set(record.data, offset + 512); offset += 512 + Math.ceil(record.data.length / 512) * 512;
  }
  return output;
}

function ensureSevenZipDirectory(FS, directory) {
  let current = '';
  for (const part of directory.split('/').filter(Boolean)) {
    current += `/${part}`;
    try { FS.lookupPath(current); } catch { FS.mkdir(current); }
  }
}

export async function createSevenZipArchive(files, format, options = {}) {
  if (!['7z', 'txz'].includes(format)) throw new Error(`Unsupported 7-Zip creation format: ${format}`);
  if (!Array.isArray(files) || !files.length || files.length > MAX_ARCHIVE_FILES) throw new Error('7-Zip creation requires 1-2,000 entries.');
  const names = new Set(); let retained = 0;
  const records = files.map((file) => {
    const name = normalizeArchivePath(file.name);
    if (name.endsWith('/')) throw new Error(`Archive input must be a regular file: ${name}`);
    if (names.has(name)) throw new Error(`Duplicate normalized archive path: ${name}`);
    names.add(name);
    const data = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data ?? ''));
    retained += data.length;
    if (retained > MAX_ARCHIVE_BYTES) throw new Error(`Retained archive input exceeds ${formatBytes(MAX_ARCHIVE_BYTES)}.`);
    return { name, data };
  });
  const bundledFactory = options.factory || (await import('/vendor/7zip/7zz.es6.js')).default;
  if (typeof bundledFactory !== 'function') throw new Error('The site-hosted 7-Zip runtime is unavailable.');
  const transcript = [];
  const factoryOptions = {
    print: (line) => { if (transcript.join('\n').length < 32_000) transcript.push(String(line)); },
    printErr: (line) => { if (transcript.join('\n').length < 32_000) transcript.push(String(line)); }
  };
  if (typeof options.locateFile === 'function') factoryOptions.locateFile = options.locateFile;
  else if (!options.factory) factoryOptions.locateFile = () => '/vendor/7zip/7zz.wasm';
  const sevenZip = await bundledFactory(factoryOptions);
  if (!sevenZip?.FS || typeof sevenZip.callMain !== 'function') throw new Error('The site-hosted 7-Zip runtime did not initialize.');
  ensureSevenZipDirectory(sevenZip.FS, '/m13/input');
  if (format === '7z') {
    sevenZip.FS.chdir('/m13/input');
    for (const record of records) {
      const slash = record.name.lastIndexOf('/');
      if (slash >= 0) ensureSevenZipDirectory(sevenZip.FS, `/m13/input/${record.name.slice(0, slash)}`);
      sevenZip.FS.writeFile(record.name, record.data);
    }
    sevenZip.callMain(['a', '-t7z', '-mx=5', '-bd', '-y', '/m13/local-archive.7z', '.']);
  } else {
    sevenZip.FS.writeFile('/m13/local-archive.tar', createTar(records));
    sevenZip.callMain(['a', '-txz', '-mx=5', '-bd', '-y', '/m13/local-archive.tar.xz', '/m13/local-archive.tar']);
  }
  const outputPath = format === '7z' ? '/m13/local-archive.7z' : '/m13/local-archive.tar.xz';
  const bytes = sevenZip.FS.readFile(outputPath).slice();
  if (!bytes.length || bytes.length > 320 * MiB) throw new Error('Created 7-Zip output is empty or exceeds the 320 MiB cap.');
  if (format === '7z' && ![0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c].every((byte, index) => bytes[index] === byte)) throw new Error('7-Zip output signature validation failed.');
  if (format === 'txz' && ![0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00].every((byte, index) => bytes[index] === byte)) throw new Error('XZ output signature validation failed.');
  return { bytes, transcript: transcript.join('\n') };
}

function writeTarOctal(bytes, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0') + '\0'; writeAscii(bytes, offset, text);
}

function readTarString(bytes) {
  const end = bytes.indexOf(0); return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end)).trim();
}

function parseTarNumber(bytes) {
  const text = latin1.decode(bytes).replaceAll('\0', '').trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('Invalid TAR numeric field.');
  return text ? Number.parseInt(text, 8) : 0;
}

function decodeXml(value) {
  return String(value).replace(/&#(x[\da-f]+|\d+);|&(?:amp|lt|gt|quot|apos);/gi, (entity, numeric) => {
    if (numeric) return String.fromCodePoint(Number.parseInt(numeric.slice(0, 1).toLowerCase() === 'x' ? numeric.slice(1) : numeric, numeric[0].toLowerCase() === 'x' ? 16 : 10));
    return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity.toLowerCase()] || entity;
  });
}

function stripXmlTags(value) { return decodeXml(String(value).replace(/<[^>]*>/g, '')); }

export function extractOfficeDocument(kind, entries) {
  const get = (name) => entries instanceof Map ? entries.get(name) : entries[name];
  if (kind === 'docx') {
    const xml = String(get('word/document.xml') || ''); if (!xml) throw new Error('word/document.xml is missing.');
    const blocks = [];
    for (const match of xml.matchAll(/<w:(p|tr)\b[^>]*>([\s\S]*?)<\/w:\1>/g)) {
      const cells = [...match[2].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map((cell) => [...cell[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((part) => stripXmlTags(part[1])).join(''));
      const text = cells.length ? cells.join(' | ') : [...match[2].matchAll(/<w:(?:t|tab|br)\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|br)\b[^>]*\/?\s*>/g)].map((part) => part[2] === 'tab' ? '\t' : part[2] === 'br' ? '\n' : stripXmlTags(part[1] || '')).join('');
      if (text.trim()) blocks.push(text.trim());
    }
    return { type: 'DOCX', sections: [{ title: 'Document', text: blocks.join('\n\n') }], summary: `${blocks.length} text blocks` };
  }
  if (kind === 'xlsx') {
    const shared = [...String(get('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) => [...item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => stripXmlTags(part[1])).join(''));
    const workbook = String(get('xl/workbook.xml') || '');
    const names = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) => decodeXml(match[1]));
    const sheetNames = [...(entries instanceof Map ? entries.keys() : Object.keys(entries))].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const sections = sheetNames.map((name, sheetIndex) => {
      const rows = [];
      for (const rowMatch of String(get(name)).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const row = [];
        for (const cell of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const reference = cell[1].match(/\br="([A-Z]+)\d+"/)?.[1] || ''; const column = reference ? columnIndex(reference) : row.length;
          while (row.length < column) row.push('');
          const type = cell[1].match(/\bt="([^"]+)"/)?.[1]; const value = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? cell[2].match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
          row[column] = type === 's' ? shared[Number(value)] ?? '' : stripXmlTags(value);
        }
        rows.push(row.join('\t'));
      }
      return { title: names[sheetIndex] || `Sheet ${sheetIndex + 1}`, text: rows.join('\n') };
    });
    return { type: 'XLSX', sections, summary: `${sections.length} worksheets` };
  }
  if (kind === 'pptx') {
    const slideNames = [...(entries instanceof Map ? entries.keys() : Object.keys(entries))].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const sections = slideNames.map((name, index) => ({ title: `Slide ${index + 1}`, text: [...String(get(name)).matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((part) => stripXmlTags(part[1])).join('\n') }));
    return { type: 'PPTX', sections, summary: `${sections.length} slides` };
  }
  throw new Error(`Unsupported Office kind: ${kind}`);
}

function columnIndex(letters) {
  let result = 0; for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64; return result - 1;
}

export function parseEpubPackage(opfXml) {
  const xml = String(opfXml);
  const read = (tag) => stripXmlTags(xml.match(new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)<\\/dc:${tag}>`, 'i'))?.[1] || '');
  const metadata = { title: read('title'), creator: read('creator'), language: read('language'), identifier: read('identifier'), publisher: read('publisher'), description: read('description') };
  const manifest = new Map();
  for (const match of xml.matchAll(/<item\b([^>]*?)\/?\s*>/gi)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map((part) => [part[1], decodeXml(part[3])]));
    if (attrs.id && attrs.href) manifest.set(attrs.id, attrs);
  }
  const spine = [...xml.matchAll(/<itemref\b([^>]*?)\/?\s*>/gi)].map((match) => match[1].match(/idref\s*=\s*["'](.*?)["']/i)?.[1]).filter(Boolean);
  return { metadata, manifest, spine };
}

export function updateEpubMetadata(opfXml, updates) {
  let xml = String(opfXml);
  for (const key of ['title', 'creator', 'language', 'identifier', 'publisher', 'description']) {
    if (!(key in updates)) continue;
    const escaped = escapeXml(String(updates[key] ?? ''));
    const pattern = new RegExp(`(<dc:${key}\\b[^>]*>)[\\s\\S]*?(<\\/dc:${key}>)`, 'i');
    if (pattern.test(xml)) xml = xml.replace(pattern, `$1${escaped}$2`);
    else xml = xml.replace(/<\/metadata>/i, `<dc:${key}>${escaped}</dc:${key}></metadata>`);
  }
  return xml;
}

export function updateEpubReadingOrder(opfXml, orderedIds) {
  const xml = String(opfXml); if (!Array.isArray(orderedIds) || !orderedIds.length) throw new TypeError('EPUB reading order must contain at least one manifest id.');
  const ids = orderedIds.map((value) => String(value)); if (new Set(ids).size !== ids.length || ids.some((value) => !value || !/^[\w.:-]+$/.test(value))) throw new Error('EPUB reading-order ids must be unique XML names.');
  const parsed = parseEpubPackage(xml); for (const id of ids) if (!parsed.manifest.has(id)) throw new Error(`Reading-order id is absent from the manifest: ${id}`);
  const spine = xml.match(/(<spine\b[^>]*>)([\s\S]*?)(<\/spine>)/i); if (!spine) throw new Error('EPUB package has no spine element.'); const originalById = new Map();
  for (const match of spine[2].matchAll(/<itemref\b[^>]*?\bidref\s*=\s*(["'])(.*?)\1[^>]*\/?>/gi)) originalById.set(decodeXml(match[2]), match[0]);
  const separator = /\n/.test(spine[2]) ? '\n    ' : ''; const itemrefs = ids.map((id) => originalById.get(id) || `<itemref idref="${escapeXml(id)}"/>`).join(separator); const body = separator ? `${separator}${itemrefs}\n  ` : itemrefs;
  return xml.replace(spine[0], `${spine[1]}${body}${spine[3]}`);
}

export function parseEpubNavigation(source, hintedKind = 'auto') {
  const xml = String(source); const kind = hintedKind === 'ncx' || (hintedKind === 'auto' && /<ncx\b/i.test(xml)) ? 'ncx' : 'nav'; const entries = [];
  if (kind === 'ncx') {
    for (const match of xml.matchAll(/<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi)) { const href = decodeXml(match[1].match(/<content\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2] || ''); const title = stripXmlTags(match[1].match(/<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>/i)?.[1] || ''); if (href) entries.push({ title: title || href, href }); }
  } else {
    const candidates = [...xml.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi)]; const toc = candidates.find((match) => /(?:epub:type|role)\s*=\s*(["'])(?:toc|doc-toc)\1/i.test(match[1])) || candidates[0];
    if (toc) for (const match of toc[2].matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) { const href = decodeXml(match[2]); const title = stripXmlTags(match[3]); if (href) entries.push({ title: title || href, href }); }
  }
  return { kind, entries };
}

export function updateEpubNavigation(source, entries, hintedKind = 'auto') {
  const xml = String(source); if (!Array.isArray(entries) || !entries.length) throw new TypeError('EPUB navigation entries are required.'); const normalized = entries.map((entry, index) => { const title = String(entry?.title || '').trim(); const href = String(entry?.href || '').trim(); if (!title || title.length > 500 || !href || /^(?:[a-z][\w+.-]*:|\/|\\)/i.test(href)) throw new Error(`Invalid navigation entry ${index + 1}.`); return { title, href }; }); const kind = hintedKind === 'ncx' || (hintedKind === 'auto' && /<ncx\b/i.test(xml)) ? 'ncx' : 'nav';
  if (kind === 'ncx') { const navMap = xml.match(/(<navMap\b[^>]*>)[\s\S]*?(<\/navMap>)/i); if (!navMap) throw new Error('NCX has no navMap.'); const body = normalized.map((entry, index) => `<navPoint id="navPoint-${index + 1}" playOrder="${index + 1}"><navLabel><text>${escapeXml(entry.title)}</text></navLabel><content src="${escapeXml(entry.href)}"/></navPoint>`).join(''); return xml.replace(navMap[0], `${navMap[1]}${body}${navMap[2]}`); }
  const candidates = [...xml.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi)]; const toc = candidates.find((match) => /(?:epub:type|role)\s*=\s*(["'])(?:toc|doc-toc)\1/i.test(match[1])) || candidates[0]; if (!toc) throw new Error('EPUB navigation document has no nav element.'); const heading = toc[2].match(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/i)?.[0] || ''; const list = `<ol>${normalized.map((entry) => `<li><a href="${escapeXml(entry.href)}">${escapeXml(entry.title)}</a></li>`).join('')}</ol>`; return xml.replace(toc[0], `<nav${toc[1]}>${heading}${list}</nav>`);
}

function escapeXml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }

export function renderPublication(source, mode = 'markdown') {
  const text = String(source).slice(0, MAX_TEXT_CHARS);
  if (mode === 'latex') return renderLatex(text);
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const output = []; let paragraph = []; let list = null; let inCode = false; let codeLanguage = ''; let code = [];
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`); paragraph = []; } };
  const closeList = () => { if (list) { output.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    const fence = line.match(/^```\s*([^\s]*)/);
    if (fence) { flushParagraph(); closeList(); if (!inCode) { inCode = true; codeLanguage = fence[1]; code = []; } else { output.push(`<pre><code${codeLanguage ? ` data-language="${escapeHtml(codeLanguage)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`); inCode = false; } continue; }
    if (inCode) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/); if (heading) { flushParagraph(); closeList(); const level = heading[1].length; output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
    const quote = line.match(/^>\s?(.*)$/); if (quote) { flushParagraph(); closeList(); output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); continue; }
    const item = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/); if (item) { flushParagraph(); const desired = item[2] ? 'ol' : 'ul'; if (list !== desired) { closeList(); output.push(`<${desired}>`); list = desired; } output.push(`<li>${inlineMarkdown(item[3])}</li>`); continue; }
    const rule = /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line); if (rule) { flushParagraph(); closeList(); output.push('<hr>'); continue; }
    paragraph.push(line.trim());
  }
  if (inCode) output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushParagraph(); closeList();
  return output.join('\n');
}

function inlineMarkdown(value) {
  let text = escapeHtml(value);
  const code = [];
  text = text.replace(/`([^`]+)`/g, (_, content) => { const token = `\u0000CODE${code.length}\u0000`; code.push(`<code>${content}</code>`); return token; });
  text = text.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => safeImageUrl(url) ? `<img src="${escapeHtml(url)}" alt="${alt}">` : alt);
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => safeUrl(url) ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${label}</a>` : label);
  text = text.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '<strong>$1$2</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*|(^|[^_])_([^_\n]+)_/g, '$1$3<em>$2$4</em>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  code.forEach((content, index) => { text = text.replace(`\u0000CODE${index}\u0000`, content); });
  return text;
}

function safeUrl(value) {
  const normalized = decodeXml(value).trim().toLowerCase();
  return /^(?:https?:|mailto:|#|\/|\.\/|\.\.\/)/.test(normalized) && !/[\u0000-\u001f]/.test(normalized);
}

function safeImageUrl(value) {
  const normalized = decodeXml(value).trim();
  return /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(normalized);
}

function renderLatex(value) {
  let text = escapeHtml(value);
  text = text.replace(/%[^\n]*/g, '');
  text = text.replace(/\\(?:documentclass|usepackage)(?:\[[^\]]*\])?\{[^}]*\}/g, '');
  text = text.replace(/\\begin\{document\}|\\end\{document\}/g, '');
  text = text.replace(/\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g, (_, type, title) => `<${type === 'section' ? 'h1' : type === 'subsection' ? 'h2' : 'h3'}>${title}</${type === 'section' ? 'h1' : type === 'subsection' ? 'h2' : 'h3'}>`);
  text = text.replace(/\\textbf\{([^}]*)\}/g, '<strong>$1</strong>').replace(/\\(?:textit|emph)\{([^}]*)\}/g, '<em>$1</em>').replace(/\\texttt\{([^}]*)\}/g, '<code>$1</code>');
  text = text.replace(/\\href\{([^}]*)\}\{([^}]*)\}/g, (_, url, label) => safeUrl(url) ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${label}</a>` : label);
  text = text.replace(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g, (_, a, b) => `<div class="math-block" role="math">${a || b}</div>`);
  text = text.replace(/\$([^$\n]+)\$/g, '<span class="math-inline" role="math">$1</span>');
  text = text.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, (_, body) => `<ul>${body.split(/\\item\s*/).filter((item) => item.trim()).map((item) => `<li>${item.trim()}</li>`).join('')}</ul>`);
  const blocks = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block) => /^<(?:h\d|ul|div)/.test(block) ? block : `<p>${block.replaceAll('\n', '<br>')}</p>`);
  return blocks.join('\n');
}

function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

export function selfContainedPublication(title, body, language = 'en') {
  return `<!doctype html>\n<html lang="${escapeHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{max-width:48rem;margin:3rem auto;padding:0 1.25rem;font:18px/1.65 system-ui;color:#171717}img{max-width:100%}pre{padding:1rem;overflow:auto;background:#f3f3f3}code{font-family:ui-monospace,monospace}blockquote{margin-left:0;padding-left:1rem;border-left:3px solid #777}.math-block{text-align:center;padding:1rem;font-family:serif}.math-inline{font-family:serif}@media print{body{margin:0;max-width:none}}</style></head><body>${body}</body></html>`;
}

export function publicationPdfBlocks(source, mode = 'markdown') {
  const html = renderPublication(source, mode); const blocks = [];
  for (const match of html.matchAll(/<(h[1-6]|p|li|blockquote|pre|div)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = match[1].toLowerCase();
    const text = decodeXml(match[2].replace(/<br\s*\/?>/gi, '\n').replace(/<img\b[^>]*\balt=(['"])(.*?)\1[^>]*>/gi, '$2').replace(/<[^>]*>/g, '')).replace(/\u00a0/g, ' ').trim();
    if (!text && tag !== 'p') continue;
    if (/^h[1-6]$/.test(tag)) blocks.push({ kind: 'heading', level: Number(tag[1]), text });
    else if (tag === 'li') blocks.push({ kind: 'list', text });
    else if (tag === 'blockquote') blocks.push({ kind: 'quote', text });
    else if (tag === 'pre') blocks.push({ kind: 'code', text });
    else if (tag === 'div') blocks.push({ kind: 'math', text });
    else blocks.push({ kind: 'paragraph', text });
  }
  return blocks;
}

function pdfEncodableText(value, font) {
  const substitutions = new Map([['\t', '    '], ['\u2013', '-'], ['\u2014', '--'], ['\u2018', "'"], ['\u2019', "'"], ['\u201c', '"'], ['\u201d', '"'], ['\u2026', '...'], ['\u2212', '-'], ['\u00a0', ' ']]); const cache = new Map(); let output = '';
  for (const character of String(value).normalize('NFC')) {
    if (substitutions.has(character)) { output += substitutions.get(character); continue; }
    if (!cache.has(character)) { try { font.encodeText(character); cache.set(character, character); } catch { cache.set(character, '?'); } }
    output += cache.get(character);
  }
  return output;
}

function wrapPdfLine(value, font, size, maximumWidth) {
  const line = pdfEncodableText(value, font); if (!line) return ['']; const words = line.split(/\s+/); const rows = []; let current = '';
  const pushWord = (word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maximumWidth) { current = candidate; return; }
    if (current) { rows.push(current); current = ''; }
    let chunk = '';
    for (const character of word) { const next = chunk + character; if (chunk && font.widthOfTextAtSize(next, size) > maximumWidth) { rows.push(chunk); chunk = character; } else chunk = next; }
    current = chunk;
  };
  words.forEach(pushWord); if (current) rows.push(current); return rows.length ? rows : [''];
}

export async function buildPublicationPdf(source, { mode = 'markdown', title = 'Local publication', language = 'en', PDFLib } = {}) {
  if (!PDFLib?.PDFDocument || !PDFLib?.StandardFonts || typeof PDFLib.rgb !== 'function') throw new TypeError('PDFLib runtime is required.');
  const text = String(source); if (text.length > 500_000) throw new Error('Direct PDF export is limited to 500,000 source characters.');
  const document = await PDFLib.PDFDocument.create({ updateMetadata: false }); document.setTitle(String(title || 'Local publication').slice(0, 300)); document.setLanguage(String(language || 'en').slice(0, 35)); document.setCreator('castrom13.github.io local publishing studio'); document.setProducer('pdf-lib');
  const regular = await document.embedFont(PDFLib.StandardFonts.Helvetica); const bold = await document.embedFont(PDFLib.StandardFonts.HelveticaBold); const mono = await document.embedFont(PDFLib.StandardFonts.Courier);
  const width = 595.28; const height = 841.89; const margin = 54; const bodyWidth = width - margin * 2; const pages = []; let page; let cursor;
  const addPage = () => { page = document.addPage([width, height]); pages.push(page); cursor = height - margin; };
  const ensure = (heightNeeded) => { if (!page || cursor - heightNeeded < margin + 20) addPage(); };
  const drawBlock = (textValue, { font = regular, size = 11, lineHeight = size * 1.45, before = 4, after = 8, prefix = '' } = {}) => {
    const sourceLines = String(textValue).split('\n'); const lines = [];
    sourceLines.forEach((line, index) => { const value = index === 0 ? `${prefix}${line}` : line; lines.push(...wrapPdfLine(value, font, size, bodyWidth)); });
    ensure(before + Math.max(1, lines.length) * lineHeight + after); cursor -= before;
    for (const line of lines) { ensure(lineHeight + after); page.drawText(line || ' ', { x: margin, y: cursor - size, size, font, color: PDFLib.rgb(0.08, 0.08, 0.09), maxWidth: bodyWidth }); cursor -= lineHeight; }
    cursor -= after;
  };
  drawBlock(title || 'Local publication', { font: bold, size: 25, lineHeight: 31, before: 0, after: 18 });
  const headingSizes = [0, 22, 18, 15, 13, 12, 11];
  for (const block of publicationPdfBlocks(text, mode)) {
    if (block.kind === 'heading') drawBlock(block.text, { font: bold, size: headingSizes[block.level], lineHeight: headingSizes[block.level] * 1.35, before: block.level <= 2 ? 12 : 8, after: 6 });
    else if (block.kind === 'code') drawBlock(block.text, { font: mono, size: 9, lineHeight: 12, before: 5, after: 10 });
    else if (block.kind === 'list') drawBlock(block.text, { prefix: '- ', before: 1, after: 3 });
    else if (block.kind === 'quote') drawBlock(block.text, { prefix: '> ', before: 4, after: 8 });
    else if (block.kind === 'math') drawBlock(block.text, { font: mono, size: 10, before: 6, after: 10 });
    else drawBlock(block.text, { before: 2, after: 8 });
  }
  pages.forEach((item, index) => item.drawText(`${index + 1} / ${pages.length}`, { x: width - margin - 40, y: 24, size: 8, font: regular, color: PDFLib.rgb(0.4, 0.4, 0.42) }));
  return document.save({ useObjectStreams: true, objectsPerTick: 50 });
}

function waitForEvent(target, eventName, errorName = 'error') {
  return new Promise((resolve, reject) => {
    const onSuccess = (event) => { cleanup(); resolve(event); };
    const onError = () => { cleanup(); reject(new Error(target.error?.message || `Could not load media (${errorName}).`)); };
    const cleanup = () => { target.removeEventListener(eventName, onSuccess); target.removeEventListener(errorName, onError); };
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener(errorName, onError, { once: true });
  });
}

function decodeBitmap(root, file, t) {
  const view = root.ownerDocument.defaultView;
  if (typeof view?.createImageBitmap !== 'function') throw fail(t('ImageBitmap decoding is unavailable in this browser.', 'A decodificação ImageBitmap não está disponível neste navegador.'));
  return view.createImageBitmap(file);
}

async function ffmpegTransform(file, command, outputPath, { progress, timeout = 20 * 60_000 } = {}) {
  const { FFmpeg } = await import('/vendor/ffmpeg/ffmpeg/index.js');
  const ffmpeg = new FFmpeg(); let lastLog = '';
  ffmpeg.on('progress', ({ progress: value }) => progress?.(Math.max(0, Math.min(1, Number(value) || 0))));
  ffmpeg.on('log', ({ message }) => { if (message) lastLog = message; });
  const extension = String(file.name).match(/\.[a-z\d]{1,8}$/i)?.[0].toLowerCase() || '.bin'; const inputPath = `input${extension}`;
  try {
    await ffmpeg.load({ coreURL: '/vendor/ffmpeg/core/ffmpeg-core.js', wasmURL: '/vendor/ffmpeg/core/ffmpeg-core.wasm' });
    await ffmpeg.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
    const code = await ffmpeg.exec(['-hide_banner', '-loglevel', 'warning', '-i', inputPath, ...command, outputPath], timeout);
    if (code !== 0) throw new Error(lastLog || `FFmpeg exited with code ${code}.`);
    const output = await ffmpeg.readFile(outputPath);
    if (!(output instanceof Uint8Array) || !output.length) throw new Error('FFmpeg returned an empty output.');
    return output.slice();
  } finally { ffmpeg.terminate(); }
}

export function parseFfmpegInspection(log) {
  const text = Array.isArray(log) ? log.join('\n') : String(log || '');
  const durationMatch = text.match(/Duration:\s*(\d{1,3}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  const videoLine = text.split(/\r?\n/).find((line) => /Stream\s+.*Video:/i.test(line));
  const dimensionMatch = videoLine?.match(/(?:^|[\s,])(\d{2,5})x(\d{2,5})(?=[\s,\[]|$)/);
  const duration = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : NaN;
  const width = Number(dimensionMatch?.[1]); const height = Number(dimensionMatch?.[2]);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('FFmpeg did not report a timed video stream.');
  return { duration, width, height };
}

export function videoTransitionOpacity(time, duration, fadeDuration) {
  if (![time, duration, fadeDuration].every(Number.isFinite) || duration <= 0 || fadeDuration < 0 || fadeDuration * 2 > duration + 1e-9) throw new TypeError('Transition timing is invalid.');
  if (!fadeDuration) return 0;
  const position = Math.max(0, Math.min(duration, time)); const fadeIn = Math.max(0, 1 - position / fadeDuration); const fadeOut = Math.max(0, 1 - (duration - position) / fadeDuration);
  return Math.max(fadeIn, fadeOut);
}

export function buildVideoFilter(maximumWidth, duration, options = {}) {
  const width = Number(maximumWidth); if (!Number.isInteger(width) || width < 2 || width > 7680) throw new TypeError('Video width is invalid.');
  if (!Number.isFinite(duration) || duration <= 0) throw new TypeError('Video duration is invalid.');
  const filters = [`scale=${width}:-2:force_original_aspect_ratio=decrease`];
  if (options.transition === 'fade') {
    const fade = Number(options.fadeDuration); const color = String(options.color || '#000000');
    if (!Number.isFinite(fade) || fade <= 0 || fade > 5 || fade * 2 > duration + 1e-9) throw new TypeError('Fade duration must be positive, at most five seconds, and no more than half the clip.');
    if (!/^#[\da-f]{6}$/i.test(color)) throw new TypeError('Fade color must be a six-digit hexadecimal color.');
    const value = (number) => String(Number(number.toFixed(3))); filters.push(`fade=t=in:st=0:d=${value(fade)}:color=0x${color.slice(1)}`, `fade=t=out:st=${value(duration - fade)}:d=${value(fade)}:color=0x${color.slice(1)}`);
  }
  return filters.join(',');
}

export function frameIndexAtElapsed(delaysInput, elapsedMilliseconds) {
  if (!Array.isArray(delaysInput) || !delaysInput.length) throw new TypeError('Frame delays are required.');
  const delays = delaysInput.map((value) => Number(value)); if (delays.some((value) => !Number.isFinite(value) || value < 20 || value > 10_000)) throw new RangeError('Frame delays must be between 20 and 10,000 milliseconds.');
  const cycle = delays.reduce((sum, value) => sum + value, 0); const elapsed = Number(elapsedMilliseconds); if (!Number.isFinite(elapsed)) throw new TypeError('Elapsed time must be finite.'); let position = ((elapsed % cycle) + cycle) % cycle;
  for (let index = 0; index < delays.length; index += 1) { if (position < delays[index]) return index; position -= delays[index]; }
  return delays.length - 1;
}

export function buildAnimationFfmpegPlan(options = {}) {
  const format = String(options.format || 'gif').toLowerCase(); if (!['gif', 'webp', 'apng'].includes(format)) throw new RangeError('Animation format must be GIF, WebP, or APNG.');
  const width = Math.floor(Number(options.width)); const height = Math.floor(Number(options.height)); const fps = Math.floor(Number(options.fps || 6)); const loops = Math.floor(Number(options.loops || 1)); const start = Number(options.start || 0); const duration = Number(options.duration);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 1920 || height > 1920 || width * height > 2_200_000) throw new RangeError('Animation dimensions exceed the bounded canvas.');
  if (!Number.isInteger(fps) || fps < 1 || fps > 30 || !Number.isInteger(loops) || loops < 1 || loops > 10) throw new RangeError('Animation frame rate or loop count is invalid.');
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 120) throw new RangeError('Animation range must be positive and no longer than 120 seconds.');
  const fit = options.fit === 'cover' ? 'cover' : 'contain'; const color = /^#[\da-f]{6}$/i.test(String(options.background || '')) ? String(options.background).slice(1) : '111111'; const quality = Math.max(1, Math.min(100, Math.round(Number(options.quality) || 80)));
  const sizing = fit === 'cover' ? `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}` : `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x${color}`; const filter = `fps=${fps},${sizing}`; const shared = ['-ss', String(start), '-t', String(duration), '-an', '-map_metadata', '-1'];
  if (format === 'gif') return { extension: 'gif', mime: 'image/gif', args: [...shared, '-filter_complex', `${filter},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`, '-loop', String(loops === 1 ? -1 : loops - 1)] };
  if (format === 'webp') return { extension: 'webp', mime: 'image/webp', args: [...shared, '-vf', filter, '-c:v', 'libwebp_anim', '-quality', String(quality), '-compression_level', '4', '-loop', String(loops)] };
  return { extension: 'png', mime: 'image/apng', args: [...shared, '-vf', filter, '-plays', String(loops), '-f', 'apng'] };
}

async function inspectWithFfmpeg(file) {
  const { FFmpeg } = await import('/vendor/ffmpeg/ffmpeg/index.js'); const ffmpeg = new FFmpeg(); const logs = []; const extension = String(file.name).match(/\.[a-z\d]{1,8}$/i)?.[0].toLowerCase() || '.bin'; const inputPath = `probe-input${extension}`;
  ffmpeg.on('log', ({ message }) => { if (message) logs.push(message); });
  try {
    await ffmpeg.load({ coreURL: '/vendor/ffmpeg/core/ffmpeg-core.js', wasmURL: '/vendor/ffmpeg/core/ffmpeg-core.wasm' });
    await ffmpeg.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
    await ffmpeg.exec(['-hide_banner', '-loglevel', 'info', '-i', inputPath, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], 120_000);
    return parseFfmpegInspection(logs);
  } finally { ffmpeg.terminate(); }
}

function mediaRecorderType(view, video = true) {
  const candidates = video
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((type) => view.MediaRecorder?.isTypeSupported?.(type)) || '';
}

async function recordCanvas(root, canvas, durationMs, drawFrame, { fps = 30, audioTracks = [], progress } = {}) {
  const view = root.ownerDocument.defaultView;
  if (!view?.MediaRecorder || typeof canvas.captureStream !== 'function') throw fail('MediaRecorder or canvas.captureStream is unavailable in this browser.');
  const mimeType = mediaRecorderType(view, true);
  if (!mimeType) throw fail('This browser does not expose a WebM MediaRecorder encoder.');
  const stream = canvas.captureStream(fps);
  for (const track of audioTracks) stream.addTrack(track);
  const chunks = []; let recorder;
  try { recorder = new view.MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 160_000 }); }
  catch (error) { for (const track of stream.getTracks()) track.stop(); throw error; }
  recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
  const stopped = waitForEvent(recorder, 'stop');
  try { recorder.start(500); } catch (error) { for (const track of stream.getTracks()) track.stop(); throw error; }
  const started = view.performance.now(); let loopError = null;
  try {
    while (true) {
      const elapsed = view.performance.now() - started;
      await drawFrame(elapsed);
      progress?.(Math.min(1, elapsed / Math.max(1, durationMs)));
      if (elapsed >= durationMs) break;
      await sleep(Math.min(1000 / fps, durationMs - elapsed));
    }
  } catch (error) { loopError = error; }
  finally {
    if (recorder.state !== 'inactive') recorder.stop();
    try { await stopped; } catch (error) { loopError ||= error; }
    for (const track of stream.getTracks()) track.stop();
  }
  if (loopError) throw loopError;
  if (!chunks.length) throw new Error('The browser encoder returned no video data.');
  return new Blob(chunks, { type: mimeType });
}

function mountVideoEditor({ root, t }) {
  root.innerHTML = commonLayout(t, 'Edit a local video clip', 'Editar um clipe de vídeo local', 'WebM · H.264 MP4', 'WebM · MP4 H.264', `
    <label class="field-label" for="video-editor-file">${t('Video file', 'Arquivo de vídeo')}</label><input class="file-input" id="video-editor-file" type="file" accept="video/*,.mkv" data-file>
    <button class="button button-secondary" type="button" data-open>${t('Open clip', 'Abrir clipe')}</button>
    <div class="field-grid"><label><span class="field-label">${t('Start (seconds)', 'Início (segundos)')}</span><input class="number-input" type="number" min="0" step="0.01" value="0" data-start></label><label><span class="field-label">${t('End (seconds)', 'Fim (segundos)')}</span><input class="number-input" type="number" min="0" step="0.01" value="0" data-end></label><label><span class="field-label">${t('Maximum width', 'Largura máxima')}</span><select data-width><option value="854">854 px</option><option value="1280" selected>1280 px</option><option value="1920">1920 px</option></select></label><label><span class="field-label">${t('Frame rate', 'Taxa de quadros')}</span><select data-fps><option>24</option><option selected>30</option><option>60</option></select></label><label><span class="field-label">${t('Render engine', 'Motor de renderização')}</span><select data-engine><option value="browser">${t('Browser WebM + text', 'WebM do navegador + texto')}</option><option value="mp4">FFmpeg H.264/AAC MP4</option><option value="webm">FFmpeg VP9/Opus WebM</option></select></label><label><span class="field-label">${t('Edge transition', 'Transição nas bordas')}</span><select data-transition><option value="none">${t('None', 'Nenhuma')}</option><option value="fade">${t('Fade in + fade out', 'Fade de entrada + saída')}</option></select></label><label><span class="field-label">${t('Fade duration per edge (s)', 'Duração do fade por borda (s)')}</span><input class="number-input" type="number" min="0.05" max="5" step="0.05" value="0.5" data-transition-duration></label><label><span class="field-label">${t('Fade color', 'Cor do fade')}</span><input type="color" value="#000000" data-transition-color></label></div>
    <label class="field-label" for="video-editor-title">${t('Text overlay (optional)', 'Texto sobreposto (opcional)')}</label><input class="text-input" id="video-editor-title" maxlength="120" data-title>
    <label class="check-row"><input type="checkbox" data-mute> ${t('Mute output', 'Silenciar saída')}</label>
    <button class="button button-primary" type="button" disabled data-render>${t('Render selected range', 'Renderizar trecho selecionado')}</button><progress class="workbench-progress" max="1" value="0" hidden data-progress></progress>
    <div class="notice-card"><strong>${t('Two real render paths with edge fades', 'Dois caminhos reais com fades nas bordas')}</strong><p>${t('Browser WebM renders text and a color crossfade-style fade in/out in real time. FFmpeg loads a local ~32 MiB WASM core only after Render and applies the same bounded visual fade while transcoding to MP4 or WebM; FFmpeg mode does not accept text. Multi-clip crossfades are outside this single-clip editor.', 'O WebM do navegador renderiza texto e fade de entrada/saída para uma cor em tempo real. O FFmpeg carrega um núcleo WASM local de ~32 MiB apenas após Renderizar e aplica o mesmo fade visual limitado ao transcodificar para MP4 ou WebM; o modo FFmpeg não aceita texto. Crossfades entre vários clipes estão fora deste editor de clipe único.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Timeline preview', 'Prévia da linha do tempo')}</h2><button class="text-button" type="button" disabled data-release>${t('Release media', 'Liberar mídia')}</button></div>
    <video controls playsinline preload="metadata" style="display:block;width:100%;max-height:34rem;background:#000" data-preview></video><div class="metric-grid" data-metrics></div><div data-output hidden><h3>${t('Rendered clip', 'Clipe renderizado')}</h3><video controls playsinline style="display:block;width:100%;max-height:34rem;background:#000" data-output-video></video><button class="button button-secondary" type="button" data-download>${t('Download rendered clip', 'Baixar clipe renderizado')}</button></div>
    <div class="empty-result" data-empty><p>${t('Open a clip to inspect its duration and dimensions. Audio is preserved when Web Audio can route the source; mute mode always works.', 'Abra um clipe para inspecionar duração e dimensões. O áudio é preservado quando a Web Audio consegue rotear a fonte; o modo silencioso sempre funciona.')}</p></div>`);
  const fileInput = root.querySelector('[data-file]'); const preview = root.querySelector('[data-preview]'); const status = root.querySelector('[data-status]'); const render = root.querySelector('[data-render]'); const progress = root.querySelector('[data-progress]'); const release = root.querySelector('[data-release]');
  const urls = new Set(); let sourceFile = null; let sourceUrl = ''; let sourceDuration = 0; let sourcePlayable = false; let output = null; let outputUrl = ''; let outputName = ''; let running = false;
  const clearOutput = () => { output = null; outputName = ''; if (outputUrl) { root.ownerDocument.defaultView.URL.revokeObjectURL(outputUrl); urls.delete(outputUrl); outputUrl = ''; } root.querySelector('[data-output-video]').removeAttribute('src'); root.querySelector('[data-output]').hidden = true; root.querySelector('[data-empty]').hidden = false; };
  const releaseAll = () => { running = false; preview.pause(); clearOutput(); clearUrls(root, urls); sourceUrl = ''; sourceFile = null; sourceDuration = 0; sourcePlayable = false; preview.removeAttribute('src'); preview.hidden = false; preview.load(); render.disabled = true; release.disabled = true; metricGrid(root, []); };
  root.querySelector('[data-open]').addEventListener('click', async () => {
    releaseAll();
    try {
      const file = checkedFile(fileInput.files[0], MAX_MEDIA_BYTES, t, t('video', 'vídeo')); sourceFile = file; sourceUrl = makeObjectUrl(root, file, urls); preview.src = sourceUrl; preview.load(); let width; let height;
      try { await waitForEvent(preview, 'loadedmetadata'); if (!Number.isFinite(preview.duration) || preview.duration <= 0) throw new Error('Missing browser duration.'); sourceDuration = preview.duration; width = preview.videoWidth; height = preview.videoHeight; sourcePlayable = true; }
      catch (browserError) { if (root.querySelector('[data-engine]').value === 'browser') throw fail(t('This codec does not play in the browser. Choose an FFmpeg engine and open the clip again.', 'Este codec não toca no navegador. Escolha um motor FFmpeg e abra o clipe novamente.')); if (file.size > 512 * MiB) throw fail(t('FFmpeg input is limited to 512 MiB.', 'A entrada FFmpeg é limitada a 512 MiB.')); setStatus(status, t('Browser preview is unavailable; inspecting with local FFmpeg…', 'A prévia do navegador não está disponível; inspecionando com o FFmpeg local…')); const probed = await inspectWithFfmpeg(file); sourceDuration = probed.duration; width = probed.width; height = probed.height; sourcePlayable = false; preview.removeAttribute('src'); preview.hidden = true; }
      root.querySelector('[data-start]').value = '0'; root.querySelector('[data-end]').value = String(Math.round(sourceDuration * 100) / 100); render.disabled = false; release.disabled = false;
      metricGrid(root, [[t('Duration', 'Duração'), formatTimestamp(sourceDuration, '.')], [t('Dimensions', 'Dimensões'), width && height ? `${width}×${height}` : t('Not reported', 'Não informado')], [t('Input size', 'Tamanho de entrada'), formatBytes(file.size)], [t('Preview', 'Prévia'), sourcePlayable ? t('Browser', 'Navegador') : t('FFmpeg inspection', 'Inspeção FFmpeg')]]);
      setStatus(status, sourcePlayable ? t('Clip opened locally. Set a range of at most 10 minutes.', 'Clipe aberto localmente. Defina um trecho de até 10 minutos.') : t('Clip inspected with local FFmpeg; timeline preview is unavailable for this codec.', 'Clipe inspecionado com FFmpeg local; a prévia da linha do tempo não está disponível para este codec.'), 'success');
    } catch (error) { releaseAll(); setStatus(status, renderError(error, t, 'Could not open the video'), 'error'); }
  });
  root.querySelector('[data-start]').addEventListener('change', () => { const value = Number(root.querySelector('[data-start]').value); if (Number.isFinite(value) && sourcePlayable) preview.currentTime = Math.min(value, sourceDuration || value); });
  render.addEventListener('click', async () => {
    if (running || !sourceFile) return;
    clearOutput(); const start = Number(root.querySelector('[data-start]').value); const end = Number(root.querySelector('[data-end]').value); const duration = end - start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > sourceDuration + 0.01 || duration <= 0) { setStatus(status, t('Choose a valid range inside the clip.', 'Escolha um trecho válido dentro do clipe.'), 'error'); return; }
    if (duration > 600) { setStatus(status, t('A single render is limited to 10 minutes.', 'Uma renderização é limitada a 10 minutos.'), 'error'); return; }
    const view = root.ownerDocument.defaultView; const doc = root.ownerDocument; const exportVideo = doc.createElement('video'); let audioContext = null; let audioTracks = []; running = true; render.disabled = true; release.disabled = true; progress.hidden = false; progress.value = 0;
    try {
      const engine = root.querySelector('[data-engine]').value; const title = root.querySelector('[data-title]').value.trim(); const maxWidth = Number(root.querySelector('[data-width]').value); const transition = root.querySelector('[data-transition]').value; const fadeDuration = transition === 'fade' ? Number(root.querySelector('[data-transition-duration]').value) : 0; const transitionColor = root.querySelector('[data-transition-color]').value; const videoFilter = buildVideoFilter(maxWidth, duration, { transition, fadeDuration, color: transitionColor }); let dimensions;
      if (engine !== 'browser') {
        if (title) throw fail(t('Text overlay is available with the Browser WebM engine. Clear it or change engines.', 'A sobreposição de texto está disponível no motor WebM do navegador. Limpe o texto ou troque de motor.'));
        if (sourceFile.size > 512 * MiB) throw fail(t('FFmpeg input is limited to 512 MiB because it is copied into WASM memory.', 'A entrada FFmpeg é limitada a 512 MiB porque é copiada para a memória WASM.'));
        setStatus(status, t('Loading the local FFmpeg core and transcoding…', 'Carregando o núcleo FFmpeg local e transcodificando…'));
        const mute = root.querySelector('[data-mute]').checked; const shared = ['-ss', String(start), '-t', String(duration), '-map', '0:v:0', ...(mute ? ['-an'] : ['-map', '0:a?', '-c:a', engine === 'mp4' ? 'aac' : 'libopus', '-b:a', '160k']), '-vf', videoFilter, '-r', root.querySelector('[data-fps]').value];
        const command = engine === 'mp4' ? [...shared, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] : [...shared, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '32', '-b:v', '0'];
        const extension = engine === 'mp4' ? 'mp4' : 'webm'; const type = engine === 'mp4' ? 'video/mp4' : 'video/webm'; const bytes = await ffmpegTransform(sourceFile, command, `edited.${extension}`, { progress: (value) => { progress.value = value; } }); if (bytes.length > 512 * MiB) throw fail(t('Rendered output exceeds the 512 MiB cap.', 'A saída renderizada excede o limite de 512 MiB.'));
        output = new Blob([bytes], { type }); outputName = `${stem(sourceFile.name, 'clip')}.edited.${extension}`; dimensions = t(`Up to ${maxWidth}px wide`, `Até ${maxWidth}px de largura`);
      } else {
        if (!sourcePlayable) throw fail(t('This source requires an FFmpeg render engine.', 'Esta fonte exige um motor de renderização FFmpeg.'));
        exportVideo.src = sourceUrl; exportVideo.preload = 'auto'; exportVideo.playsInline = true; exportVideo.muted = true; await waitForEvent(exportVideo, 'loadedmetadata');
        const scale = Math.min(1, maxWidth / exportVideo.videoWidth); const width = Math.max(2, Math.round(exportVideo.videoWidth * scale / 2) * 2); const height = Math.max(2, Math.round(exportVideo.videoHeight * scale / 2) * 2); dimensions = `${width}×${height}`;
        if (width * height > 2_200_000) throw fail(t('Output dimensions exceed the 2.2-megapixel render cap.', 'As dimensões de saída excedem o limite de renderização de 2,2 megapixels.'));
        const canvas = doc.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas 2D is unavailable.');
        if (!root.querySelector('[data-mute]').checked) { const AudioContext = view.AudioContext || view.webkitAudioContext; if (!AudioContext) throw fail(t('Web Audio is unavailable. Choose mute output to render video only.', 'Web Audio não está disponível. Escolha saída silenciosa para renderizar apenas o vídeo.')); audioContext = new AudioContext(); const source = audioContext.createMediaElementSource(exportVideo); const destination = audioContext.createMediaStreamDestination(); source.connect(destination); audioTracks = destination.stream.getAudioTracks(); exportVideo.muted = false; exportVideo.volume = 1; await audioContext.resume(); }
        exportVideo.currentTime = start; await waitForEvent(exportVideo, 'seeked'); await exportVideo.play(); const fps = Number(root.querySelector('[data-fps]').value);
        output = await recordCanvas(root, canvas, duration * 1000, async (elapsed) => { context.drawImage(exportVideo, 0, 0, width, height); if (title) { const size = Math.max(20, Math.round(width / 30)); context.font = `600 ${size}px system-ui`; context.textAlign = 'center'; context.textBaseline = 'bottom'; const x = width / 2; const y = height - size; const metrics = context.measureText(title); context.fillStyle = 'rgba(0,0,0,.68)'; context.fillRect(x - metrics.width / 2 - 18, y - size - 10, metrics.width + 36, size + 22); context.fillStyle = '#fff'; context.fillText(title, x, y); } if (transition === 'fade') { const opacity = videoTransitionOpacity(elapsed / 1000, duration, fadeDuration); if (opacity > 0) { context.save(); context.globalAlpha = opacity; context.fillStyle = transitionColor; context.fillRect(0, 0, width, height); context.restore(); } } if (exportVideo.currentTime >= end || exportVideo.ended) exportVideo.pause(); }, { fps, audioTracks, progress: (value) => { progress.value = value; } }); outputName = `${stem(sourceFile.name, 'clip')}.edited.webm`;
      }
      exportVideo.pause(); outputUrl = makeObjectUrl(root, output, urls); const outputVideo = root.querySelector('[data-output-video]'); outputVideo.src = outputUrl; root.querySelector('[data-output]').hidden = false; root.querySelector('[data-empty]').hidden = true; release.disabled = false;
      metricGrid(root, [[t('Range', 'Trecho'), `${formatTimestamp(start, '.')} – ${formatTimestamp(end, '.')}`], [t('Output', 'Saída'), formatBytes(output.size)], [t('Dimensions', 'Dimensões'), dimensions], [t('Transition', 'Transição'), transition === 'fade' ? `${fadeDuration.toFixed(2)} s · ${transitionColor}` : t('None', 'Nenhuma')], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('Local video render is ready.', 'A renderização de vídeo local está pronta.'), 'success');
    } catch (error) { clearOutput(); setStatus(status, renderError(error, t, 'Could not render the clip'), 'error'); }
    finally { exportVideo.pause(); exportVideo.removeAttribute('src'); audioTracks.forEach((track) => track.stop()); await audioContext?.close().catch(() => {}); running = false; render.disabled = !sourceFile; release.disabled = !sourceFile; progress.hidden = true; }
  });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, outputName); });
  release.addEventListener('click', () => { releaseAll(); setStatus(status, t('Media buffers and object URLs released.', 'Buffers de mídia e URLs de objeto liberados.'), 'success'); });
  attachCleanup(root, releaseAll);
}

function mountAnimationStudioV2({ root, t }) {
  root.innerHTML = commonLayout(t, 'Build or convert an animation', 'Criar ou converter uma animação', 'GIF · WebP · APNG · WebM', 'GIF · WebP · APNG · WebM', `
    <label class="field-label" for="animation-files">${t('Image frames', 'Quadros de imagem')}</label><input class="file-input" id="animation-files" type="file" accept="image/png,image/jpeg,image/webp,image/avif" multiple data-files>
    <label class="field-label" for="animation-video">${t('Or one source video', 'Ou um vídeo de origem')}</label><input class="file-input" id="animation-video" type="file" accept="video/*,.mkv,.mov,.avi,.m4v" data-video-file>
    <button class="button button-secondary" type="button" data-inspect>${t('Inspect source', 'Inspecionar origem')}</button>
    <div class="field-grid"><label><span class="field-label">${t('Frames per second / default delay', 'Quadros por segundo / atraso padrão')}</span><input class="number-input" type="number" min="1" max="30" value="6" data-fps></label><label><span class="field-label">${t('Loops', 'Repetições')}</span><input class="number-input" type="number" min="1" max="10" value="1" data-loops></label><label><span class="field-label">${t('Canvas width', 'Largura da tela')}</span><input class="number-input" type="number" min="64" max="1920" value="800" data-width></label><label><span class="field-label">${t('Canvas height', 'Altura da tela')}</span><input class="number-input" type="number" min="64" max="1920" value="600" data-height></label><label><span class="field-label">${t('Frame fit', 'Ajuste do quadro')}</span><select data-fit><option value="contain">${t('Contain', 'Conter')}</option><option value="cover">${t('Cover', 'Cobrir')}</option></select></label><label><span class="field-label">${t('Background', 'Fundo')}</span><input type="color" value="#111111" data-background></label><label><span class="field-label">${t('Animated WebP quality', 'Qualidade do WebP animado')}</span><input type="range" min="1" max="100" value="80" data-quality><output data-quality-out>80%</output></label><label><span class="field-label">${t('Video start (seconds)', 'Início do vídeo (segundos)')}</span><input class="number-input" type="number" min="0" step="0.01" value="0" data-start></label><label><span class="field-label">${t('Video duration (seconds)', 'Duração do vídeo (segundos)')}</span><input class="number-input" type="number" min="0.05" max="120" step="0.01" value="5" data-duration></label></div>
    <button class="button button-secondary" type="button" disabled data-apply-fps>${t('Apply FPS delay to every image frame', 'Aplicar atraso do FPS a todos os quadros')}</button>
    <div class="field-grid"><button class="button button-primary" type="button" disabled data-gif>${t('Encode GIF', 'Codificar GIF')}</button><button class="button button-secondary" type="button" disabled data-webp>${t('Encode animated WebP', 'Codificar WebP animado')}</button><button class="button button-secondary" type="button" disabled data-apng>${t('Encode APNG', 'Codificar APNG')}</button><button class="button button-secondary" type="button" disabled data-animate>${t('Render WebM', 'Renderizar WebM')}</button><button class="button button-secondary" type="button" disabled data-sheet>${t('Create PNG sprite sheet', 'Criar sprite sheet PNG')}</button></div><progress class="workbench-progress" max="1" value="0" hidden data-progress></progress>
    <div class="notice-card"><strong>${t('Two-way animation workflow', 'Fluxo de animação bidirecional')}</strong><p>${t('Image frames can be reordered, removed, timed independently, encoded as GIF/WebP/APNG, rendered to WebM, or laid out as a sprite sheet. A video can be clipped, resized, frame-rate limited, and converted to GIF/WebP/APNG with the lazy local FFmpeg core. GIF palette quantization, WebP quality, dimensions, and frame rate provide bounded optimization controls.', 'Quadros de imagem podem ser reordenados, removidos, temporizados separadamente, codificados como GIF/WebP/APNG, renderizados em WebM ou organizados em sprite sheet. Um vídeo pode ser cortado, redimensionado, limitado em FPS e convertido para GIF/WebP/APNG com o núcleo FFmpeg local e sob demanda. Quantização de paleta GIF, qualidade WebP, dimensões e FPS oferecem controles limitados de otimização.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Frame editor and output', 'Editor de quadros e saída')}</h2><button class="text-button" type="button" disabled data-release>${t('Release output', 'Liberar saída')}</button></div><div class="metric-grid" data-metrics></div><ol class="file-order-list" data-frame-list></ol><div data-result hidden><canvas style="display:block;width:100%;height:auto;border:1px solid var(--line)" hidden data-canvas aria-label="${t('Sprite sheet output', 'Saída da sprite sheet')}"></canvas><video controls loop playsinline style="display:block;width:100%;max-height:32rem;background:#000" hidden data-video></video><img alt="${t('Rendered animation preview', 'Prévia da animação renderizada')}" style="display:block;max-width:100%;height:auto" hidden data-image><button class="button button-secondary" type="button" data-download>${t('Download output', 'Baixar saída')}</button></div><div class="empty-result" data-empty><p>${t('Choose 2–120 images or one video. Image input is capped at 128 MiB; video at 512 MiB; each animation run is capped at 120 seconds.', 'Escolha de 2 a 120 imagens ou um vídeo. A entrada de imagens é limitada a 128 MiB; vídeo a 512 MiB; cada execução de animação é limitada a 120 segundos.')}</p></div>`);

  const status = root.querySelector('[data-status]'); const progress = root.querySelector('[data-progress]'); const canvas = root.querySelector('[data-canvas]'); const release = root.querySelector('[data-release]'); const urls = new Set();
  const buttons = { gif: root.querySelector('[data-gif]'), webp: root.querySelector('[data-webp]'), apng: root.querySelector('[data-apng]'), webm: root.querySelector('[data-animate]'), sheet: root.querySelector('[data-sheet]'), applyFps: root.querySelector('[data-apply-fps]') };
  let frames = []; let videoSource = null; let output = null; let outputName = ''; let outputUrl = ''; let busy = false;

  const dimensions = () => {
    const width = Number(root.querySelector('[data-width]').value); const height = Number(root.querySelector('[data-height]').value);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 1920 || height > 1920 || width * height > 2_200_000) throw fail(t('Canvas must be 64–1920 px per side and at most 2.2 megapixels.', 'A tela deve ter 64–1920 px por lado e no máximo 2,2 megapixels.'));
    return { width, height };
  };
  const settings = () => ({ ...dimensions(), fps: Math.max(1, Math.min(30, Math.floor(Number(root.querySelector('[data-fps]').value) || 6))), loops: Math.max(1, Math.min(10, Math.floor(Number(root.querySelector('[data-loops]').value) || 1))), fit: root.querySelector('[data-fit]').value, background: root.querySelector('[data-background]').value, quality: Math.max(1, Math.min(100, Math.round(Number(root.querySelector('[data-quality]').value) || 80))) });
  const drawFrame = (context, bitmap, config, offsetX = 0, offsetY = 0) => { const scale = config.fit === 'cover' ? Math.max(config.width / bitmap.width, config.height / bitmap.height) : Math.min(config.width / bitmap.width, config.height / bitmap.height); const drawWidth = bitmap.width * scale; const drawHeight = bitmap.height * scale; context.fillStyle = config.background; context.fillRect(offsetX, offsetY, config.width, config.height); context.drawImage(bitmap, offsetX + (config.width - drawWidth) / 2, offsetY + (config.height - drawHeight) / 2, drawWidth, drawHeight); };
  const setButtonState = () => { const imageReady = frames.length >= 2; const videoReady = Boolean(videoSource); const disabled = busy || (!imageReady && !videoReady); buttons.gif.disabled = disabled; buttons.webp.disabled = disabled; buttons.apng.disabled = disabled; buttons.webm.disabled = busy || !imageReady; buttons.sheet.disabled = busy || !imageReady; buttons.applyFps.disabled = busy || !imageReady; };
  const clearOutput = () => { output = null; outputName = ''; if (outputUrl) { root.ownerDocument.defaultView.URL.revokeObjectURL(outputUrl); urls.delete(outputUrl); outputUrl = ''; } const video = root.querySelector('[data-video]'); video.pause(); video.removeAttribute('src'); video.hidden = true; const image = root.querySelector('[data-image]'); image.removeAttribute('src'); image.hidden = true; canvas.hidden = true; root.querySelector('[data-result]').hidden = true; root.querySelector('[data-empty]').hidden = !(frames.length || videoSource); release.disabled = true; };
  const clearAll = () => { clearOutput(); frames = []; videoSource = null; root.querySelector('[data-frame-list]').replaceChildren(); metricGrid(root, []); clearUrls(root, urls); setButtonState(); root.querySelector('[data-empty]').hidden = false; };
  const finishOutput = (blob, name, previewKind, metrics) => { output = blob; outputName = name; outputUrl = makeObjectUrl(root, blob, urls); if (previewKind === 'video') { const video = root.querySelector('[data-video]'); video.src = outputUrl; video.hidden = false; } else if (previewKind === 'image') { const image = root.querySelector('[data-image]'); image.src = outputUrl; image.hidden = false; } else canvas.hidden = false; root.querySelector('[data-result]').hidden = false; root.querySelector('[data-empty]').hidden = true; release.disabled = false; metricGrid(root, metrics); };
  const run = async (action) => { if (busy) return; busy = true; setButtonState(); clearOutput(); progress.hidden = false; progress.value = 0; try { await action(); } catch (error) { clearOutput(); setStatus(status, renderError(error, t, 'Could not create the animation'), 'error'); } finally { busy = false; progress.hidden = true; setButtonState(); } };

  const renderFrameList = () => {
    const list = root.querySelector('[data-frame-list]'); list.replaceChildren();
    frames.forEach((frame, index) => { const item = root.ownerDocument.createElement('li'); const description = root.ownerDocument.createElement('span'); description.textContent = `${index + 1}. ${frame.file.name} · ${frame.width}×${frame.height} · ${formatBytes(frame.file.size)}`; const controls = root.ownerDocument.createElement('span'); const label = root.ownerDocument.createElement('label'); label.textContent = `${t('Delay', 'Atraso')} `; const delay = root.ownerDocument.createElement('input'); delay.type = 'number'; delay.className = 'number-input'; delay.min = '20'; delay.max = '10000'; delay.step = '10'; delay.value = String(frame.delayMs); delay.dataset.delayIndex = String(index); delay.setAttribute('aria-label', t(`Delay for frame ${index + 1} in milliseconds`, `Atraso do quadro ${index + 1} em milissegundos`)); label.append(delay, ' ms'); controls.append(label); for (const [delta, textValue] of [[-1, t('Up', 'Subir')], [1, t('Down', 'Descer')]]) { const button = root.ownerDocument.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.dataset.moveIndex = String(index); button.dataset.moveDelta = String(delta); button.disabled = index + delta < 0 || index + delta >= frames.length; button.textContent = textValue; controls.append(button); } const remove = root.ownerDocument.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.dataset.removeIndex = String(index); remove.disabled = frames.length <= 2; remove.textContent = t('Remove', 'Remover'); controls.append(remove); item.append(description, controls); list.append(item); });
  };

  root.querySelector('[data-quality]').addEventListener('input', (event) => { root.querySelector('[data-quality-out]').value = `${event.target.value}%`; });
  root.querySelector('[data-frame-list]').addEventListener('change', (event) => { const input = event.target.closest('[data-delay-index]'); if (!input) return; const value = Number(input.value); if (!Number.isFinite(value) || value < 20 || value > 10_000) { input.value = String(frames[Number(input.dataset.delayIndex)].delayMs); setStatus(status, t('Frame delay must be 20–10,000 ms.', 'O atraso do quadro deve ser de 20 a 10.000 ms.'), 'error'); return; } frames[Number(input.dataset.delayIndex)].delayMs = Math.round(value); clearOutput(); setButtonState(); });
  root.querySelector('[data-frame-list]').addEventListener('click', (event) => { const move = event.target.closest('[data-move-index]'); const remove = event.target.closest('[data-remove-index]'); if (move) { const index = Number(move.dataset.moveIndex); const target = index + Number(move.dataset.moveDelta); [frames[index], frames[target]] = [frames[target], frames[index]]; } else if (remove) frames.splice(Number(remove.dataset.removeIndex), 1); else return; clearOutput(); renderFrameList(); setButtonState(); metricGrid(root, [[t('Frames', 'Quadros'), frames.length], [t('Cycle duration', 'Duração do ciclo'), `${(frames.reduce((sum, frame) => sum + frame.delayMs, 0) / 1000).toFixed(3)} s`], [t('Uploads', 'Uploads'), '0']]); });
  buttons.applyFps.addEventListener('click', () => { const delay = Math.round(1000 / settings().fps); frames.forEach((frame) => { frame.delayMs = delay; }); clearOutput(); renderFrameList(); setButtonState(); setStatus(status, t(`Applied ${delay} ms to every frame.`, `${delay} ms aplicados a todos os quadros.`), 'success'); });

  root.querySelector('[data-inspect]').addEventListener('click', async () => {
    clearAll();
    try {
      const imageFiles = [...root.querySelector('[data-files]').files]; const selectedVideo = root.querySelector('[data-video-file]').files[0]; if ((imageFiles.length && selectedVideo) || (!imageFiles.length && !selectedVideo)) throw fail(t('Choose either 2–120 image frames or one video.', 'Escolha 2–120 quadros de imagem ou um vídeo.'));
      if (selectedVideo) {
        const file = checkedFile(selectedVideo, 512 * MiB, t, t('video', 'vídeo')); setStatus(status, t('Inspecting the video with local FFmpeg…', 'Inspecionando o vídeo com o FFmpeg local…')); const inspected = await inspectWithFfmpeg(file); videoSource = { file, ...inspected }; root.querySelector('[data-start]').max = String(inspected.duration); root.querySelector('[data-duration]').value = String(Math.min(5, inspected.duration).toFixed(2)); const item = root.ownerDocument.createElement('li'); item.textContent = `${file.name} · ${inspected.width}×${inspected.height} · ${formatTimestamp(inspected.duration, '.')} · ${formatBytes(file.size)}`; root.querySelector('[data-frame-list]').append(item); metricGrid(root, [[t('Source', 'Origem'), t('Video', 'Vídeo')], [t('Duration', 'Duração'), formatTimestamp(inspected.duration, '.')], [t('Dimensions', 'Dimensões'), `${inspected.width}×${inspected.height}`], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('Video inspected. Choose a bounded range and animation output.', 'Vídeo inspecionado. Escolha um trecho limitado e a saída da animação.'), 'success');
      } else {
        const total = imageFiles.reduce((sum, file) => sum + file.size, 0); if (imageFiles.length < 2 || imageFiles.length > 120 || total > 128 * MiB) throw fail(t('Choose 2–120 images totaling at most 128 MiB.', 'Escolha 2–120 imagens totalizando no máximo 128 MiB.')); const delayMs = Math.round(1000 / settings().fps);
        for (let index = 0; index < imageFiles.length; index += 1) { const bitmap = await decodeBitmap(root, imageFiles[index], t); frames.push({ file: imageFiles[index], width: bitmap.width, height: bitmap.height, delayMs }); bitmap.close(); progress.hidden = false; progress.value = (index + 1) / imageFiles.length; await sleep(0); } progress.hidden = true; renderFrameList(); metricGrid(root, [[t('Source', 'Origem'), t('Editable image frames', 'Quadros editáveis')], [t('Frames', 'Quadros'), frames.length], [t('Cycle duration', 'Duração do ciclo'), `${(frames.reduce((sum, frame) => sum + frame.delayMs, 0) / 1000).toFixed(3)} s`], [t('Input size', 'Tamanho de entrada'), formatBytes(total)]]); setStatus(status, t('Frames decoded. Reorder, remove, or edit each delay before encoding.', 'Quadros decodificados. Reordene, remova ou edite cada atraso antes de codificar.'), 'success');
      }
      root.querySelector('[data-empty]').hidden = true; setButtonState();
    } catch (error) { clearAll(); setStatus(status, renderError(error, t, 'Could not inspect the animation source'), 'error'); }
  });

  const encodeGifFrames = async () => {
    const config = settings(); const totalDuration = frames.reduce((sum, frame) => sum + frame.delayMs, 0) * config.loops / 1000; if (totalDuration > 120 || config.width * config.height * frames.length > 50_000_000) throw fail(t('GIF work exceeds the 120-second or 50-million-pixel cap.', 'O trabalho GIF excede o limite de 120 segundos ou 50 milhões de pixels.'));
    const { GIFEncoder, quantize, applyPalette } = await import('/vendor/suite/gifenc.js'); const encoderInstance = GIFEncoder(); canvas.width = config.width; canvas.height = config.height; const context = canvas.getContext('2d', { willReadFrequently: true }); let bitmap = null;
    try { for (let index = 0; index < frames.length; index += 1) { bitmap = await decodeBitmap(root, frames[index].file, t); drawFrame(context, bitmap, config); bitmap.close(); bitmap = null; const rgba = context.getImageData(0, 0, config.width, config.height).data; const palette = quantize(rgba, 256, { format: 'rgb444' }); encoderInstance.writeFrame(applyPalette(rgba, palette, 'rgb444'), config.width, config.height, { palette, delay: frames[index].delayMs, repeat: index === 0 ? (config.loops === 1 ? -1 : config.loops - 1) : 0 }); progress.value = (index + 1) / frames.length; await sleep(0); } } finally { bitmap?.close(); }
    encoderInstance.finish(); const bytes = encoderInstance.bytes(); if (!bytes.length || bytes.length > 128 * MiB) throw fail(t('GIF output is empty or exceeds 128 MiB.', 'A saída GIF está vazia ou excede 128 MiB.')); const blob = new Blob([bytes], { type: 'image/gif' }); finishOutput(blob, `${stem(frames[0].file.name, 'animation')}.animation.gif`, 'image', [[t('Frames', 'Quadros'), frames.length], [t('Cycle duration', 'Duração do ciclo'), `${(totalDuration / config.loops).toFixed(3)} s`], [t('Output', 'Saída'), formatBytes(blob.size)], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('Optimized-palette GIF encoded locally.', 'GIF com paleta otimizada codificado localmente.'), 'success');
  };

  const encodeFfmpegFrames = async (format) => {
    const config = settings(); const duration = frames.reduce((sum, frame) => sum + frame.delayMs, 0) / 1000; if (duration * config.loops > 120 || config.width * config.height * frames.length > 80_000_000) throw fail(t('Animation work exceeds the 120-second or 80-million-pixel cap.', 'O trabalho da animação excede o limite de 120 segundos ou 80 milhões de pixels.'));
    const { FFmpeg } = await import('/vendor/ffmpeg/ffmpeg/index.js'); const ffmpeg = new FFmpeg(); let lastLog = ''; ffmpeg.on('progress', ({ progress: value }) => { progress.value = Math.max(progress.value, Math.max(0, Math.min(1, Number(value) || 0))); }); ffmpeg.on('log', ({ message }) => { if (message) lastLog = message; }); const outputPath = format === 'webp' ? 'animation.webp' : 'animation.apng'; let bitmap = null;
    try {
      await ffmpeg.load({ coreURL: '/vendor/ffmpeg/core/ffmpeg-core.js', wasmURL: '/vendor/ffmpeg/core/ffmpeg-core.wasm' }); canvas.width = config.width; canvas.height = config.height; const context = canvas.getContext('2d'); const lines = [];
      for (let index = 0; index < frames.length; index += 1) { bitmap = await decodeBitmap(root, frames[index].file, t); drawFrame(context, bitmap, config); bitmap.close(); bitmap = null; const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png')); if (!blob) throw new Error('PNG frame encoding failed.'); const name = `frame-${String(index).padStart(4, '0')}.png`; await ffmpeg.writeFile(name, new Uint8Array(await blob.arrayBuffer())); lines.push(`file '${name}'`, `duration ${(frames[index].delayMs / 1000).toFixed(6)}`); progress.value = (index + 1) / frames.length * 0.45; }
      lines.push(`file 'frame-${String(frames.length - 1).padStart(4, '0')}.png'`); await ffmpeg.writeFile('frames.txt', encoder.encode(lines.join('\n'))); const formatArgs = format === 'webp' ? ['-vsync', 'vfr', '-c:v', 'libwebp_anim', '-quality', String(config.quality), '-compression_level', '4', '-loop', String(config.loops)] : ['-vsync', 'vfr', '-plays', String(config.loops), '-f', 'apng']; const code = await ffmpeg.exec(['-hide_banner', '-loglevel', 'warning', '-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-an', '-map_metadata', '-1', ...formatArgs, outputPath], 20 * 60_000); if (code !== 0) throw new Error(lastLog || `FFmpeg exited with code ${code}.`); const bytes = await ffmpeg.readFile(outputPath); if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 128 * MiB) throw fail(t('Animation output is empty or exceeds 128 MiB.', 'A saída da animação está vazia ou excede 128 MiB.')); const mime = format === 'webp' ? 'image/webp' : 'image/apng'; const blob = new Blob([bytes.slice()], { type: mime }); finishOutput(blob, `${stem(frames[0].file.name, 'animation')}.animation.${format === 'webp' ? 'webp' : 'apng'}`, 'image', [[t('Frames', 'Quadros'), frames.length], [t('Cycle duration', 'Duração do ciclo'), `${duration.toFixed(3)} s`], [t('Output', 'Saída'), formatBytes(blob.size)], [t('Encoder', 'Codificador'), format === 'webp' ? `libwebp_anim · Q${config.quality}` : 'FFmpeg APNG']]); setStatus(status, format === 'webp' ? t('Animated WebP encoded locally.', 'WebP animado codificado localmente.') : t('APNG encoded locally.', 'APNG codificado localmente.'), 'success');
    } finally { bitmap?.close(); ffmpeg.terminate(); }
  };

  const encodeVideoAnimation = async (format) => {
    const config = settings(); const start = Number(root.querySelector('[data-start]').value); const duration = Number(root.querySelector('[data-duration]').value); if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || start >= videoSource.duration || start + duration > videoSource.duration + 0.01) throw fail(t('Video range must stay inside the source.', 'O trecho de vídeo deve ficar dentro da origem.')); const plan = buildAnimationFfmpegPlan({ format, ...config, start, duration }); setStatus(status, t('Loading local FFmpeg and converting the video…', 'Carregando o FFmpeg local e convertendo o vídeo…')); const bytes = await ffmpegTransform(videoSource.file, plan.args, `converted.${plan.extension}`, { progress: (value) => { progress.value = value; } }); if (bytes.length > 128 * MiB) throw fail(t('Animation output exceeds 128 MiB.', 'A saída da animação excede 128 MiB.')); const blob = new Blob([bytes], { type: plan.mime }); finishOutput(blob, `${stem(videoSource.file.name, 'video')}.animation.${format === 'apng' ? 'apng' : plan.extension}`, 'image', [[t('Source range', 'Trecho de origem'), `${start.toFixed(2)}–${(start + duration).toFixed(2)} s`], [t('Frame rate', 'Taxa de quadros'), `${config.fps} FPS`], [t('Dimensions', 'Dimensões'), `${config.width}×${config.height}`], [t('Output', 'Saída'), formatBytes(blob.size)]]); setStatus(status, t(`Video converted to ${format.toUpperCase()} locally.`, `Vídeo convertido localmente para ${format.toUpperCase()}.`), 'success');
  };

  buttons.gif.addEventListener('click', () => run(() => videoSource ? encodeVideoAnimation('gif') : encodeGifFrames())); buttons.webp.addEventListener('click', () => run(() => videoSource ? encodeVideoAnimation('webp') : encodeFfmpegFrames('webp'))); buttons.apng.addEventListener('click', () => run(() => videoSource ? encodeVideoAnimation('apng') : encodeFfmpegFrames('apng')));
  buttons.webm.addEventListener('click', () => run(async () => { const config = settings(); const delays = frames.map((frame) => frame.delayMs); const cycle = delays.reduce((sum, value) => sum + value, 0); const duration = cycle * config.loops / 1000; if (duration > 120) throw fail(t('WebM duration is limited to 120 seconds.', 'A duração WebM é limitada a 120 segundos.')); canvas.width = config.width; canvas.height = config.height; const context = canvas.getContext('2d'); let bitmap = null; let current = -1; const renderFps = Math.min(30, Math.max(config.fps, Math.ceil(1000 / Math.max(34, Math.min(...delays))))); try { output = await recordCanvas(root, canvas, duration * 1000, async (elapsed) => { const index = frameIndexAtElapsed(delays, elapsed); if (index !== current) { bitmap?.close(); bitmap = await decodeBitmap(root, frames[index].file, t); drawFrame(context, bitmap, config); current = index; } }, { fps: renderFps, progress: (value) => { progress.value = value; } }); } finally { bitmap?.close(); } finishOutput(output, `${stem(frames[0].file.name, 'animation')}.animation.webm`, 'video', [[t('Frames', 'Quadros'), frames.length], [t('Duration', 'Duração'), `${duration.toFixed(3)} s`], [t('Render rate', 'Taxa de renderização'), `${renderFps} FPS`], [t('Output', 'Saída'), formatBytes(output.size)]]); setStatus(status, t('Timed frames rendered to WebM locally.', 'Quadros temporizados renderizados localmente em WebM.'), 'success'); }));
  buttons.sheet.addEventListener('click', () => run(async () => { const config = settings(); const columns = Math.ceil(Math.sqrt(frames.length)); const rows = Math.ceil(frames.length / columns); if (config.width * columns * config.height * rows > 100_000_000) throw fail(t('Sprite sheet exceeds 100 megapixels.', 'A sprite sheet excede 100 megapixels.')); canvas.width = config.width * columns; canvas.height = config.height * rows; const context = canvas.getContext('2d'); let bitmap = null; try { for (let index = 0; index < frames.length; index += 1) { bitmap = await decodeBitmap(root, frames[index].file, t); drawFrame(context, bitmap, config, index % columns * config.width, Math.floor(index / columns) * config.height); bitmap.close(); bitmap = null; progress.value = (index + 1) / frames.length; await sleep(0); } } finally { bitmap?.close(); } const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png')); if (!blob) throw new Error('PNG sprite encoding failed.'); finishOutput(blob, `${stem(frames[0].file.name, 'animation')}.sprites.png`, 'canvas', [[t('Grid', 'Grade'), `${columns}×${rows}`], [t('Sheet dimensions', 'Dimensões da folha'), `${canvas.width}×${canvas.height}`], [t('Output', 'Saída'), formatBytes(blob.size)], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('PNG sprite sheet created locally.', 'Sprite sheet PNG criada localmente.'), 'success'); }));
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, outputName); }); release.addEventListener('click', () => { clearOutput(); setButtonState(); setStatus(status, t('Rendered output released.', 'Saída renderizada liberada.'), 'success'); }); attachCleanup(root, clearAll); setButtonState();
}

function mountSubtitleEditor({ root, t }) {
  root.innerHTML = commonLayout(t, 'Edit and synchronize subtitles', 'Editar e sincronizar legendas', 'SRT · VTT · ASS', 'SRT · VTT · ASS', `
    <label class="field-label" for="subtitle-file">${t('Subtitle file', 'Arquivo de legenda')}</label><input class="file-input" id="subtitle-file" type="file" accept=".srt,.vtt,.ass,text/vtt,text/plain" data-file><button class="button button-secondary" type="button" data-open>${t('Open subtitle', 'Abrir legenda')}</button>
    <label class="field-label" for="subtitle-source">${t('Subtitle source (editable)', 'Fonte da legenda (editável)')}</label><textarea class="code-input" id="subtitle-source" rows="16" spellcheck="false" data-source></textarea>
    <div class="field-grid"><label><span class="field-label">${t('Shift (seconds)', 'Deslocamento (segundos)')}</span><input class="number-input" type="number" step="0.001" value="0" data-offset></label><label><span class="field-label">${t('Timing speed', 'Velocidade do tempo')}</span><input class="number-input" type="number" min="0.1" max="10" step="0.001" value="1" data-speed></label><label><span class="field-label">${t('Find literal text', 'Localizar texto literal')}</span><input class="text-input" data-find></label><label><span class="field-label">${t('Replace with', 'Substituir por')}</span><input class="text-input" data-replacement></label></div>
    <button class="button button-primary" type="button" data-apply>${t('Parse and apply changes', 'Analisar e aplicar alterações')}</button>
    <label class="field-label" for="subtitle-video">${t('Optional local preview video', 'Vídeo local opcional para prévia')}</label><input class="file-input" id="subtitle-video" type="file" accept="video/*" data-video-file>
    <div class="field-grid"><label><span class="field-label">${t('Export format', 'Formato de exportação')}</span><select data-format><option value="srt">SRT</option><option value="vtt">WebVTT</option><option value="ass">ASS</option></select></label><button class="button button-secondary" type="button" disabled data-download>${t('Download subtitle', 'Baixar legenda')}</button></div>`, `
    <div class="workbench-section-heading"><h2>${t('Cue review', 'Revisão dos trechos')}</h2><button class="text-button" type="button" data-release>${t('Clear workspace', 'Limpar espaço')}</button></div><video controls playsinline style="display:block;width:100%;max-height:30rem;background:#000" hidden data-video></video><div class="notice-card" hidden data-overlay-wrap><strong>${t('Active cue', 'Trecho ativo')}</strong><p data-overlay></p></div><div class="metric-grid" data-metrics></div><div class="table-scroll" role="region" tabindex="0" hidden data-table-wrap><table class="data-table"><caption>${t('First 500 parsed cues', 'Primeiros 500 trechos analisados')}</caption><thead><tr><th>#</th><th>${t('Start', 'Início')}</th><th>${t('End', 'Fim')}</th><th>${t('Text', 'Texto')}</th></tr></thead><tbody data-cues></tbody></table></div><div class="empty-result" data-empty><p>${t('Paste or open SRT, WebVTT, or ASS. Timing transforms are non-destructive until the source textarea is replaced.', 'Cole ou abra SRT, WebVTT ou ASS. As transformações de tempo não alteram a fonte até que a área de texto seja substituída.')}</p></div>`);
  const status = root.querySelector('[data-status]'); const source = root.querySelector('[data-source]'); const download = root.querySelector('[data-download]'); const video = root.querySelector('[data-video]'); const urls = new Set(); let cues = []; let inputName = 'subtitles'; let videoUrl = '';
  const renderCues = () => { const issues = validateCues(cues); const body = root.querySelector('[data-cues]'); body.replaceChildren(); cues.slice(0, 500).forEach((cue, index) => { const row = root.ownerDocument.createElement('tr'); for (const value of [index + 1, formatTimestamp(cue.start, '.'), formatTimestamp(cue.end, '.'), cue.text]) { const cell = root.ownerDocument.createElement('td'); cell.textContent = String(value); row.append(cell); } body.append(row); }); root.querySelector('[data-table-wrap]').hidden = !cues.length; root.querySelector('[data-empty]').hidden = !!cues.length; download.disabled = !cues.length; metricGrid(root, [[t('Cues', 'Trechos'), cues.length], [t('Duration', 'Duração'), cues.length ? formatTimestamp(Math.max(...cues.map((cue) => cue.end)), '.') : '—'], [t('Validation issues', 'Problemas de validação'), issues.length], [t('Uploads', 'Uploads'), '0']]); return issues; };
  const apply = () => { const parsed = parseSubtitles(source.value, inputName); cues = transformCues(parsed.cues, { offset: Number(root.querySelector('[data-offset]').value), speed: Number(root.querySelector('[data-speed]').value), find: root.querySelector('[data-find]').value, replacement: root.querySelector('[data-replacement]').value }); const issues = renderCues(); setStatus(status, issues.length ? t(`${cues.length} cues parsed with ${issues.length} validation warning(s).`, `${cues.length} trechos analisados com ${issues.length} alerta(s) de validação.`) : t(`${cues.length} cues parsed without timing issues.`, `${cues.length} trechos analisados sem problemas de tempo.`), issues.length ? 'warning' : 'success'); };
  root.querySelector('[data-open]').addEventListener('click', async () => { try { const file = checkedFile(root.querySelector('[data-file]').files[0], 5 * MiB, t, t('subtitle file', 'arquivo de legenda')); inputName = file.name; source.value = (await file.text()).slice(0, MAX_TEXT_CHARS); root.querySelector('[data-offset]').value = '0'; root.querySelector('[data-speed]').value = '1'; apply(); } catch (error) { setStatus(status, renderError(error, t, 'Could not open the subtitle'), 'error'); } });
  root.querySelector('[data-apply]').addEventListener('click', () => { try { apply(); } catch (error) { cues = []; renderCues(); setStatus(status, renderError(error, t, 'Could not parse the subtitle'), 'error'); } });
  root.querySelector('[data-video-file]').addEventListener('change', () => { if (videoUrl) { root.ownerDocument.defaultView.URL.revokeObjectURL(videoUrl); urls.delete(videoUrl); } const file = root.querySelector('[data-video-file]').files[0]; if (!file) { video.hidden = true; return; } try { checkedFile(file, MAX_MEDIA_BYTES, t, t('video', 'vídeo')); videoUrl = makeObjectUrl(root, file, urls); video.src = videoUrl; video.hidden = false; root.querySelector('[data-overlay-wrap]').hidden = false; } catch (error) { setStatus(status, error.message, 'error'); } });
  video.addEventListener('timeupdate', () => { const active = cues.filter((cue) => cue.start <= video.currentTime && cue.end >= video.currentTime).map((cue) => cue.text).join('\n'); root.querySelector('[data-overlay]').textContent = active || t('No active cue', 'Nenhum trecho ativo'); });
  download.addEventListener('click', () => { const format = root.querySelector('[data-format]').value; downloadBlob(new Blob([serializeSubtitles(cues, format)], { type: format === 'vtt' ? 'text/vtt' : 'text/plain' }), `${stem(inputName, 'subtitles')}.edited.${format}`); });
  const clear = () => { cues = []; source.value = ''; video.pause(); video.removeAttribute('src'); video.hidden = true; root.querySelector('[data-overlay-wrap]').hidden = true; root.querySelector('[data-overlay]').textContent = ''; clearUrls(root, urls); videoUrl = ''; renderCues(); };
  root.querySelector('[data-release]').addEventListener('click', () => { clear(); setStatus(status, t('Subtitle workspace cleared.', 'Espaço de legendas limpo.'), 'success'); }); attachCleanup(root, clear);
}

async function decodeAudio(root, file, t) {
  checkedFile(file, MAX_AUDIO_BYTES, t, t('audio file', 'arquivo de áudio'));
  const view = root.ownerDocument.defaultView; const AudioContext = view.AudioContext || view.webkitAudioContext; if (!AudioContext) throw fail(t('Web Audio decoding is unavailable in this browser.', 'A decodificação Web Audio não está disponível neste navegador.'));
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (!buffer.length || !buffer.numberOfChannels || buffer.duration > MAX_AUDIO_SECONDS || buffer.length * buffer.numberOfChannels > MAX_AUDIO_FRAMES) throw fail(t('Decoded audio exceeds the one-hour or decoded-frame safety cap.', 'O áudio decodificado excede o limite de uma hora ou de quadros decodificados.'));
    return { sampleRate: buffer.sampleRate, duration: buffer.duration, channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice()) };
  } finally { await context.close().catch(() => {}); }
}

function trimChannels(channels, sampleRate, start, end) {
  const first = Math.max(0, Math.floor(start * sampleRate)); const last = Math.min(channels[0].length, Math.ceil(end * sampleRate)); if (last <= first) throw new Error('Trim ending must be after its start.'); return channels.map((channel) => channel.slice(first, last));
}

function convertChannels(channels, mode) {
  if (mode === 'mono') { const mono = new Float32Array(channels[0].length); for (const channel of channels) for (let index = 0; index < mono.length; index += 1) mono[index] += channel[index] / channels.length; return [mono]; }
  return channels.length === 1 ? [channels[0].slice(), channels[0].slice()] : [channels[0].slice(), channels[1].slice()];
}

function mountAudioConverter({ root, t }) {
  root.innerHTML = commonLayout(t, 'Decode and convert audio', 'Decodificar e converter áudio', 'WAV · MP3 · FLAC · Opus · AAC', 'WAV · MP3 · FLAC · Opus · AAC', `
    <label class="field-label" for="audio-converter-file">${t('Audio file', 'Arquivo de áudio')}</label><input class="file-input" id="audio-converter-file" type="file" accept="audio/*,.flac,.m4a,.aac,.opus" data-file><button class="button button-secondary" type="button" data-open>${t('Decode audio', 'Decodificar áudio')}</button>
    <div class="field-grid"><label><span class="field-label">${t('Trim start (seconds)', 'Início do corte (segundos)')}</span><input class="number-input" type="number" min="0" step="0.001" value="0" data-start></label><label><span class="field-label">${t('Trim end (seconds)', 'Fim do corte (segundos)')}</span><input class="number-input" type="number" min="0" step="0.001" value="0" data-end></label><label><span class="field-label">${t('Sample rate', 'Taxa de amostragem')}</span><select data-rate><option value="original">${t('Keep source', 'Manter original')}</option><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option><option value="96000">96 kHz</option></select></label><label><span class="field-label">${t('Channels', 'Canais')}</span><select data-channels><option value="stereo">Stereo</option><option value="mono">Mono</option></select></label><label><span class="field-label">${t('Output format', 'Formato de saída')}</span><select data-format><option value="wav">WAV</option><option value="mp3">MP3</option><option value="flac">FLAC</option><option value="opus">Opus</option><option value="aac">AAC / M4A</option></select></label><label><span class="field-label">${t('WAV encoding', 'Codificação WAV')}</span><select data-depth><option value="16">16-bit PCM</option><option value="24">24-bit PCM</option><option value="32">32-bit PCM</option><option value="float">32-bit float</option></select></label></div>
    <button class="button button-primary" type="button" disabled data-convert>${t('Convert audio', 'Converter áudio')}</button><progress class="workbench-progress" max="1" value="0" hidden data-progress></progress><div class="notice-card"><strong>${t('Lazy local codec runtime', 'Runtime local de codecs sob demanda')}</strong><p>${t('WAV uses the tested JavaScript PCM encoder. MP3, FLAC, Opus, and AAC load the local ~32 MiB FFmpeg WASM core only after Convert; no network API receives the audio.', 'WAV usa o codificador PCM JavaScript testado. MP3, FLAC, Opus e AAC carregam o núcleo FFmpeg WASM local de ~32 MiB apenas após Converter; nenhuma API de rede recebe o áudio.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Converted audio', 'Áudio convertido')}</h2><button class="text-button" type="button" disabled data-release>${t('Release audio', 'Liberar áudio')}</button></div><div class="metric-grid" data-metrics></div><audio controls style="width:100%" hidden data-audio></audio><button class="button button-secondary" type="button" hidden data-download>${t('Download converted audio', 'Baixar áudio convertido')}</button><div class="empty-result" data-empty><p>${t('Decode first to inspect the real channel count, duration, and sample rate.', 'Decodifique primeiro para inspecionar a contagem real de canais, duração e taxa de amostragem.')}</p></div>`);
  const status = root.querySelector('[data-status]'); const convert = root.querySelector('[data-convert]'); const progress = root.querySelector('[data-progress]'); const audio = root.querySelector('[data-audio]'); const urls = new Set(); let decoded = null; let sourceFile = null; let output = null; let outputUrl = ''; let outputName = '';
  const clearOutput = () => { output = null; outputName = ''; if (outputUrl) { root.ownerDocument.defaultView.URL.revokeObjectURL(outputUrl); urls.delete(outputUrl); outputUrl = ''; } audio.pause(); audio.removeAttribute('src'); audio.hidden = true; root.querySelector('[data-download]').hidden = true; root.querySelector('[data-empty]').hidden = false; root.querySelector('[data-release]').disabled = !decoded; };
  root.querySelector('[data-open]').addEventListener('click', async () => { clearOutput(); decoded = null; convert.disabled = true; try { sourceFile = root.querySelector('[data-file]').files[0]; decoded = await decodeAudio(root, sourceFile, t); root.querySelector('[data-start]').value = '0'; root.querySelector('[data-end]').value = String(Math.round(decoded.duration * 1000) / 1000); convert.disabled = false; root.querySelector('[data-release]').disabled = false; metricGrid(root, [[t('Duration', 'Duração'), `${decoded.duration.toFixed(3)} s`], [t('Sample rate', 'Taxa de amostragem'), `${decoded.sampleRate} Hz`], [t('Channels', 'Canais'), decoded.channels.length], [t('Input', 'Entrada'), formatBytes(sourceFile.size)]]); setStatus(status, t('Audio decoded locally.', 'Áudio decodificado localmente.'), 'success'); } catch (error) { decoded = null; setStatus(status, renderError(error, t, 'Could not decode the audio'), 'error'); } });
  convert.addEventListener('click', async () => { clearOutput(); convert.disabled = true; progress.hidden = false; progress.value = 0; try { const start = Number(root.querySelector('[data-start]').value); const end = Number(root.querySelector('[data-end]').value); if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > decoded.duration + 0.001 || end <= start) throw fail(t('Choose a valid trim range.', 'Escolha um intervalo de corte válido.')); const targetRate = root.querySelector('[data-rate]').value === 'original' ? decoded.sampleRate : Number(root.querySelector('[data-rate]').value); const channelMode = root.querySelector('[data-channels]').value; const channelCount = channelMode === 'mono' ? 1 : 2; const format = root.querySelector('[data-format]').value; let bytes; let type;
      if (format === 'wav') { let channels = trimChannels(decoded.channels, decoded.sampleRate, start, end); channels = convertChannels(channels, channelMode).map((channel) => resampleLinear(channel, decoded.sampleRate, targetRate)); const depth = root.querySelector('[data-depth]').value; bytes = encodeWav(channels, targetRate, { float: depth === 'float', bitDepth: depth === 'float' ? 32 : Number(depth) }); type = 'audio/wav'; outputName = `${stem(sourceFile.name, 'audio')}.converted.wav`; progress.value = 1; }
      else { if (end - start > 1800) throw fail(t('FFmpeg audio conversion is limited to 30 minutes per run.', 'A conversão de áudio FFmpeg é limitada a 30 minutos por execução.')); if (sourceFile.size > 200 * MiB) throw fail(t('FFmpeg audio input is limited to 200 MiB.', 'A entrada de áudio FFmpeg é limitada a 200 MiB.')); setStatus(status, t('Loading the local FFmpeg core and encoding…', 'Carregando o núcleo FFmpeg local e codificando…')); const formats = { mp3: { extension: 'mp3', type: 'audio/mpeg', codec: ['-c:a', 'libmp3lame', '-q:a', '2'] }, flac: { extension: 'flac', type: 'audio/flac', codec: ['-c:a', 'flac', '-compression_level', '5'] }, opus: { extension: 'opus', type: 'audio/ogg', codec: ['-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on'] }, aac: { extension: 'm4a', type: 'audio/mp4', codec: ['-c:a', 'aac', '-b:a', '160k'] } }; const config = formats[format]; const command = ['-ss', String(start), '-t', String(end - start), '-vn', '-ar', String(targetRate), '-ac', String(channelCount), ...config.codec]; bytes = await ffmpegTransform(sourceFile, command, `converted.${config.extension}`, { progress: (value) => { progress.value = value; } }); type = config.type; outputName = `${stem(sourceFile.name, 'audio')}.converted.${config.extension}`; }
      if (bytes.length > 256 * MiB) throw fail(t('Audio output exceeds the 256 MiB retained-output cap.', 'A saída de áudio excede o limite retido de 256 MiB.')); output = new Blob([bytes], { type }); outputUrl = makeObjectUrl(root, output, urls); audio.src = outputUrl; audio.hidden = false; root.querySelector('[data-download]').hidden = false; root.querySelector('[data-empty]').hidden = true; root.querySelector('[data-release]').disabled = false; metricGrid(root, [[t('Duration', 'Duração'), `${(end - start).toFixed(3)} s`], [t('Sample rate', 'Taxa de amostragem'), `${targetRate} Hz`], [t('Channels', 'Canais'), channelCount], [t('Output', 'Saída'), formatBytes(output.size)]]); setStatus(status, t(`${format.toUpperCase()} conversion completed locally.`, `Conversão ${format.toUpperCase()} concluída localmente.`), 'success'); } catch (error) { setStatus(status, renderError(error, t, 'Could not convert the audio'), 'error'); } finally { convert.disabled = !decoded; progress.hidden = true; } });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, outputName); }); const clear = () => { clearOutput(); decoded = null; sourceFile = null; convert.disabled = true; clearUrls(root, urls); metricGrid(root, []); }; root.querySelector('[data-release]').addEventListener('click', () => { clear(); setStatus(status, t('Decoded and converted audio released.', 'Áudio decodificado e convertido liberado.'), 'success'); }); attachCleanup(root, clear);
}

function mountDawLite({ root, t }) {
  root.innerHTML = commonLayout(t, 'Mix a multitrack session', 'Mixar uma sessão multifaixa', 'Up to 8 local tracks', 'Até 8 faixas locais', `
    <label class="field-label" for="daw-files">${t('Audio tracks', 'Faixas de áudio')}</label><input class="file-input" id="daw-files" type="file" accept="audio/*" multiple data-files><button class="button button-secondary" type="button" data-load>${t('Decode tracks', 'Decodificar faixas')}</button>
    <div class="field-grid"><label><span class="field-label">${t('Session sample rate', 'Taxa da sessão')}</span><select data-rate><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option></select></label><label><span class="field-label">${t('Master format', 'Formato master')}</span><select data-depth><option value="16">16-bit WAV</option><option value="24">24-bit WAV</option></select></label></div><button class="button button-primary" type="button" disabled data-mix>${t('Render stereo master', 'Renderizar master estéreo')}</button><progress class="workbench-progress" max="1" value="0" hidden data-progress></progress>
    <div class="notice-card"><strong>${t('Waveform edits and deterministic offline mix', 'Edições de forma de onda e mixagem offline determinística')}</strong><p>${t('Each row provides non-destructive trim, edge fades, a one-pole low-pass tone filter, offset, gain, constant-power pan, and mute. The waveform shows the retained region; the master limits only when summed samples clip.', 'Cada linha oferece corte não destrutivo, fades nas bordas, filtro tonal passa-baixas de um polo, deslocamento, ganho, panorama de potência constante e silêncio. A forma de onda mostra a região mantida; o master limita apenas quando a soma satura.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Session tracks', 'Faixas da sessão')}</h2><button class="text-button" type="button" disabled data-release>${t('Release session', 'Liberar sessão')}</button></div><div class="metric-grid" data-metrics></div><div class="table-scroll" hidden data-table-wrap><table class="data-table"><caption>${t('Non-destructive track controls', 'Controles não destrutivos das faixas')}</caption><thead><tr><th>${t('Track', 'Faixa')}</th><th>${t('Offset s', 'Desloc. s')}</th><th>${t('Trim start', 'Início')}</th><th>${t('Trim end', 'Fim')}</th><th>${t('Fade in', 'Fade in')}</th><th>${t('Fade out', 'Fade out')}</th><th>${t('Low-pass Hz', 'Passa-baixas Hz')}</th><th>${t('Gain', 'Ganho')}</th><th>${t('Pan', 'Panorama')}</th><th>${t('Mute', 'Silenciar')}</th></tr></thead><tbody data-tracks></tbody></table></div><canvas width="960" height="360" style="display:block;width:100%;height:auto;border:1px solid var(--line)" hidden data-waveform aria-label="${t('Editable multitrack waveform overview', 'Visão editável das formas de onda multifaixa')}"></canvas><audio controls style="width:100%" hidden data-audio></audio><button class="button button-secondary" type="button" hidden data-download>${t('Download master WAV', 'Baixar master WAV')}</button><div class="empty-result" data-empty><p>${t('Tracks are decoded one by one and resampled into a common session rate. The rendered session is limited to 10 minutes.', 'As faixas são decodificadas uma a uma e reamostradas para uma taxa comum. A sessão renderizada é limitada a 10 minutos.')}</p></div>`);
  const status = root.querySelector('[data-status]'); const mix = root.querySelector('[data-mix]'); const progress = root.querySelector('[data-progress]'); const waveform = root.querySelector('[data-waveform]'); const urls = new Set(); let tracks = []; let output = null; let outputUrl = ''; let sessionRate = 44_100;
  const clearOutput = () => { output = null; if (outputUrl) { root.ownerDocument.defaultView.URL.revokeObjectURL(outputUrl); urls.delete(outputUrl); outputUrl = ''; } const audio = root.querySelector('[data-audio]'); audio.pause(); audio.removeAttribute('src'); audio.hidden = true; root.querySelector('[data-download]').hidden = true; };
  root.querySelector('[data-load]').addEventListener('click', async () => { clearOutput(); tracks = []; root.querySelector('[data-rate]').disabled = false; mix.disabled = true; const files = [...root.querySelector('[data-files]').files]; if (!files.length || files.length > 8 || files.reduce((sum, file) => sum + file.size, 0) > MAX_AUDIO_BYTES) { setStatus(status, t('Choose 1–8 tracks totaling at most 256 MiB.', 'Escolha de 1 a 8 faixas totalizando no máximo 256 MiB.'), 'error'); return; } progress.hidden = false; progress.max = files.length;
    try { sessionRate = Number(root.querySelector('[data-rate]').value); let decodedFrames = 0; for (let index = 0; index < files.length; index += 1) { const decoded = await decodeAudio(root, files[index], t); const channels = convertChannels(decoded.channels, 'stereo').map((channel) => resampleLinear(channel, decoded.sampleRate, sessionRate)); decodedFrames += channels[0].length * channels.length; if (decodedFrames > 80_000_000) throw fail(t('Decoded session exceeds the 80-million-sample memory cap.', 'A sessão decodificada excede o limite de 80 milhões de amostras.')); const duration = channels[0].length / sessionRate; tracks.push({ name: files[index].name, channels, offset: 0, trimStart: 0, trimEnd: duration, fadeIn: 0, fadeOut: 0, lowPassHz: 0, gain: 1, pan: 0, mute: false }); progress.value = index + 1; }
      const body = root.querySelector('[data-tracks]'); body.replaceChildren(); tracks.forEach((track, index) => { const duration = track.channels[0].length / sessionRate; const row = root.ownerDocument.createElement('tr'); const name = root.ownerDocument.createElement('td'); name.textContent = `${track.name} · ${duration.toFixed(2)} s`; row.append(name); for (const [field, min, max, step] of [['offset', 0, 600, 0.01], ['trimStart', 0, duration, 0.001], ['trimEnd', 0, duration, 0.001], ['fadeIn', 0, duration, 0.001], ['fadeOut', 0, duration, 0.001], ['lowPassHz', 0, Math.floor(sessionRate / 2) - 1, 1], ['gain', 0, 4, 0.01], ['pan', -1, 1, 0.01]]) { const cell = root.ownerDocument.createElement('td'); const input = root.ownerDocument.createElement('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(Math.round(Number(track[field]) * 1000) / 1000); input.dataset.index = String(index); input.dataset.field = field; input.setAttribute('aria-label', `${track.name} ${field}`); cell.append(input); row.append(cell); } const muteCell = root.ownerDocument.createElement('td'); const mute = root.ownerDocument.createElement('input'); mute.type = 'checkbox'; mute.dataset.index = String(index); mute.dataset.field = 'mute'; mute.setAttribute('aria-label', `${track.name} mute`); muteCell.append(mute); row.append(muteCell); body.append(row); }); root.querySelector('[data-rate]').disabled = true; root.querySelector('[data-table-wrap]').hidden = false; root.querySelector('[data-empty]').hidden = true; root.querySelector('[data-release]').disabled = false; mix.disabled = false; waveform.hidden = false; drawDawWaveforms(waveform, tracks, sessionRate, t); metricGrid(root, [[t('Tracks', 'Faixas'), tracks.length], [t('Session rate', 'Taxa da sessão'), `${sessionRate} Hz`], [t('Decoded samples', 'Amostras decodificadas'), decodedFrames.toLocaleString()], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('Tracks decoded. Adjust trim, fades, tone, and mix controls before rendering.', 'Faixas decodificadas. Ajuste corte, fades, tom e mixagem antes de renderizar.'), 'success');
    } catch (error) { tracks = []; root.querySelector('[data-table-wrap]').hidden = true; setStatus(status, renderError(error, t, 'Could not decode the session'), 'error'); } finally { progress.hidden = true; } });
  root.querySelector('[data-tracks]').addEventListener('input', (event) => { const input = event.target.closest('[data-field]'); if (!input) return; const track = tracks[Number(input.dataset.index)]; if (track) { track[input.dataset.field] = input.type === 'checkbox' ? input.checked : Number(input.value); drawDawWaveforms(waveform, tracks, sessionRate, t); } clearOutput(); });
  mix.addEventListener('click', () => { clearOutput(); try { const duration = Math.max(...tracks.map((track) => Number(track.offset || 0) + (Number(track.trimEnd) - Number(track.trimStart)))); if (!Number.isFinite(duration) || duration > 600) throw fail(t('The mixed session is limited to 10 minutes and requires valid edit ranges.', 'A sessão mixada é limitada a 10 minutos e exige intervalos de edição válidos.')); const result = mixPcmTracks(tracks, sessionRate); const renderedDuration = result.channels[0].length / sessionRate; const bytes = encodeWav(result.channels, sessionRate, { bitDepth: Number(root.querySelector('[data-depth]').value) }); if (bytes.length > 256 * MiB) throw fail(t('Master WAV exceeds the 256 MiB output cap.', 'O WAV master excede o limite de saída de 256 MiB.')); output = new Blob([bytes], { type: 'audio/wav' }); outputUrl = makeObjectUrl(root, output, urls); const audio = root.querySelector('[data-audio]'); audio.src = outputUrl; audio.hidden = false; root.querySelector('[data-download]').hidden = false; root.querySelector('[data-release]').disabled = false; metricGrid(root, [[t('Tracks', 'Faixas'), tracks.length], [t('Duration', 'Duração'), `${renderedDuration.toFixed(2)} s`], [t('Pre-limiter peak', 'Pico pré-limitador'), result.peakBeforeLimiting.toFixed(3)], [t('Master size', 'Tamanho do master'), formatBytes(output.size)]]); setStatus(status, result.peakBeforeLimiting > 1 ? t('Edited master rendered; peak limiting prevented clipping.', 'Master editado renderizado; o limitador de pico evitou saturação.') : t('Edited master rendered without peak limiting.', 'Master editado renderizado sem limitação de pico.'), 'success'); } catch (error) { setStatus(status, renderError(error, t, 'Could not render the master'), 'error'); } });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, 'local-session.master.wav'); }); const clear = () => { clearOutput(); tracks = []; root.querySelector('[data-rate]').disabled = false; root.querySelector('[data-tracks]').replaceChildren(); root.querySelector('[data-table-wrap]').hidden = true; waveform.hidden = true; root.querySelector('[data-empty]').hidden = false; mix.disabled = true; root.querySelector('[data-release]').disabled = true; clearUrls(root, urls); metricGrid(root, []); }; root.querySelector('[data-release]').addEventListener('click', () => { clear(); setStatus(status, t('Session buffers released.', 'Buffers da sessão liberados.'), 'success'); }); attachCleanup(root, clear);
}

function drawDawWaveforms(canvas, tracks, sampleRate, t) {
  const context = canvas.getContext('2d'); if (!context) return; const { width, height } = canvas; context.clearRect(0, 0, width, height); context.fillStyle = '#111'; context.fillRect(0, 0, width, height);
  if (!tracks.length) return; const laneHeight = height / tracks.length; const padding = 10; context.font = '13px ui-monospace, monospace'; context.textBaseline = 'top';
  tracks.forEach((track, trackIndex) => {
    const channel = track.channels[0]; const duration = channel.length / sampleRate; const laneTop = trackIndex * laneHeight; const center = laneTop + laneHeight / 2; const samplesPerColumn = Math.max(1, Math.ceil(channel.length / width)); context.strokeStyle = track.mute ? '#666' : '#b8ff47'; context.beginPath();
    for (let x = 0; x < width; x += 1) { const first = x * samplesPerColumn; if (first >= channel.length) break; let peak = 0; for (let index = first; index < Math.min(channel.length, first + samplesPerColumn); index += 1) peak = Math.max(peak, Math.abs(channel[index])); const amplitude = peak * Math.max(2, laneHeight / 2 - padding); context.moveTo(x + 0.5, center - amplitude); context.lineTo(x + 0.5, center + amplitude); } context.stroke();
    const clampTime = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(duration, Number(value))) : fallback; const trimStart = clampTime(track.trimStart, 0); const trimEnd = clampTime(track.trimEnd, duration); const startX = width * trimStart / Math.max(duration, 1e-9); const endX = width * trimEnd / Math.max(duration, 1e-9); context.fillStyle = 'rgba(255,80,80,.28)'; context.fillRect(0, laneTop, startX, laneHeight); context.fillRect(endX, laneTop, width - endX, laneHeight);
    const edited = Math.max(0, trimEnd - trimStart); const fadeIn = Math.min(edited, Math.max(0, Number(track.fadeIn) || 0)); const fadeOut = Math.min(edited, Math.max(0, Number(track.fadeOut) || 0)); context.strokeStyle = '#64c8ff'; context.beginPath(); context.moveTo(startX, laneTop + laneHeight - 2); context.lineTo(startX + width * fadeIn / Math.max(duration, 1e-9), laneTop + 2); context.moveTo(endX - width * fadeOut / Math.max(duration, 1e-9), laneTop + 2); context.lineTo(endX, laneTop + laneHeight - 2); context.stroke();
    context.fillStyle = '#fff'; context.fillText(`${trackIndex + 1}. ${track.name} · ${t('kept', 'mantido')} ${Math.max(0, edited).toFixed(2)} s`, 8, laneTop + 5); if (trackIndex) { context.strokeStyle = '#444'; context.beginPath(); context.moveTo(0, laneTop); context.lineTo(width, laneTop); context.stroke(); }
  });
}

function mountAudioRestoration({ root, t }) {
  root.innerHTML = commonLayout(t, 'Restore a decoded recording', 'Restaurar uma gravação decodificada', 'Filters · silence · normalize', 'Filtros · silêncio · normalizar', `
    <label class="field-label" for="restoration-file">${t('Audio recording', 'Gravação de áudio')}</label><input class="file-input" id="restoration-file" type="file" accept="audio/*" data-file><button class="button button-secondary" type="button" data-open>${t('Decode recording', 'Decodificar gravação')}</button>
    <div class="field-grid"><label><span class="field-label">${t('High-pass cutoff (Hz; 0 off)', 'Corte passa-altas (Hz; 0 desliga)')}</span><input class="number-input" type="number" min="0" max="2000" value="70" data-high></label><label><span class="field-label">${t('Low-pass cutoff (Hz; 0 off)', 'Corte passa-baixas (Hz; 0 desliga)')}</span><input class="number-input" type="number" min="0" max="40000" value="15000" data-low></label><label><span class="field-label">${t('Noise gate (dBFS)', 'Noise gate (dBFS)')}</span><input class="number-input" type="number" min="-100" max="-10" value="-50" data-gate></label><label><span class="field-label">${t('Target peak (dBFS)', 'Pico alvo (dBFS)')}</span><input class="number-input" type="number" min="-12" max="0" step="0.1" value="-1" data-peak></label><label><span class="field-label">${t('Edge fade (ms)', 'Fade nas bordas (ms)')}</span><input class="number-input" type="number" min="0" max="5000" value="15" data-fade></label><label><span class="field-label">${t('Silence threshold (dBFS)', 'Limiar de silêncio (dBFS)')}</span><input class="number-input" type="number" min="-120" max="0" value="-50" data-silence-threshold></label><label><span class="field-label">${t('Minimum silence (ms)', 'Silêncio mínimo (ms)')}</span><input class="number-input" type="number" min="1" max="60000" value="300" data-silence-min></label><label><span class="field-label">${t('Analysis window (ms)', 'Janela de análise (ms)')}</span><input class="number-input" type="number" min="1" max="1000" value="20" data-silence-window></label></div><label class="check-row"><input type="checkbox" checked data-normalize> ${t('Peak normalize after filters', 'Normalizar pico após os filtros')}</label><button class="button button-primary" type="button" disabled data-process>${t('Analyze silence, process, and create WAV', 'Analisar silêncio, processar e criar WAV')}</button>
    <div class="notice-card"><strong>${t('Classical DSP, no AI claims', 'DSP clássico, sem promessas de IA')}</strong><p>${t('The chain uses first-order high/low-pass filters, a hard noise gate, fades, and peak normalization. Windowed RMS silence detection creates a reviewable report but does not remove regions automatically. It does not run RNNoise or reconstruct missing speech.', 'A cadeia usa filtros passa-altas/baixas de primeira ordem, noise gate rígido, fades e normalização de pico. A detecção de silêncio por RMS em janelas cria um relatório revisável, mas não remove regiões automaticamente. Ela não executa RNNoise nem reconstrói fala ausente.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Restored output and silence report', 'Saída restaurada e relatório de silêncio')}</h2><button class="text-button" type="button" disabled data-release>${t('Release audio', 'Liberar áudio')}</button></div><div class="metric-grid" data-metrics></div><audio controls style="width:100%" hidden data-audio></audio><pre class="code-output" hidden data-silence-report></pre><div class="field-grid"><button class="button button-secondary" type="button" hidden data-download>${t('Download restored WAV', 'Baixar WAV restaurado')}</button><button class="button button-secondary" type="button" hidden data-download-report>${t('Download silence JSON', 'Baixar JSON de silêncio')}</button></div><div class="empty-result" data-empty><p>${t('Decode a browser-supported recording, then tune the transparent DSP chain and silence detector.', 'Decodifique uma gravação compatível com o navegador e ajuste a cadeia DSP transparente e o detector de silêncio.')}</p></div>`);
  const status = root.querySelector('[data-status]'); const process = root.querySelector('[data-process]'); const urls = new Set(); let decoded = null; let sourceFile = null; let output = null; let outputUrl = ''; let silenceReport = null;
  const clearOutput = () => { output = null; silenceReport = null; if (outputUrl) { root.ownerDocument.defaultView.URL.revokeObjectURL(outputUrl); urls.delete(outputUrl); outputUrl = ''; } const audio = root.querySelector('[data-audio]'); audio.pause(); audio.removeAttribute('src'); audio.hidden = true; root.querySelector('[data-download]').hidden = true; root.querySelector('[data-download-report]').hidden = true; root.querySelector('[data-silence-report]').hidden = true; root.querySelector('[data-empty]').hidden = false; };
  root.querySelector('[data-open]').addEventListener('click', async () => { clearOutput(); decoded = null; process.disabled = true; try { sourceFile = root.querySelector('[data-file]').files[0]; decoded = await decodeAudio(root, sourceFile, t); if (decoded.duration > 1800) throw fail(t('Restoration is limited to 30 minutes per file.', 'A restauração é limitada a 30 minutos por arquivo.')); process.disabled = false; root.querySelector('[data-release]').disabled = false; metricGrid(root, [[t('Duration', 'Duração'), `${decoded.duration.toFixed(2)} s`], [t('Sample rate', 'Taxa de amostragem'), `${decoded.sampleRate} Hz`], [t('Channels', 'Canais'), decoded.channels.length], [t('Input', 'Entrada'), formatBytes(sourceFile.size)]]); setStatus(status, t('Recording decoded locally.', 'Gravação decodificada localmente.'), 'success'); } catch (error) { setStatus(status, renderError(error, t, 'Could not decode the recording'), 'error'); } });
  process.addEventListener('click', () => { clearOutput(); try { const options = { highPassHz: Number(root.querySelector('[data-high]').value), lowPassHz: Number(root.querySelector('[data-low]').value), gateDb: Number(root.querySelector('[data-gate]').value), targetPeakDb: Number(root.querySelector('[data-peak]').value), fadeMs: Number(root.querySelector('[data-fade]').value), normalize: root.querySelector('[data-normalize]').checked }; const silenceOptions = { thresholdDb: Number(root.querySelector('[data-silence-threshold]').value), minDurationMs: Number(root.querySelector('[data-silence-min]').value), windowMs: Number(root.querySelector('[data-silence-window]').value), maximumRegions: 1_000 }; const before = decoded.channels.reduce((peak, channel) => Math.max(peak, ...peakChunked(channel)), 0); const mono = convertChannels(decoded.channels, 'mono')[0]; const detection = detectSilenceRegions(mono, decoded.sampleRate, silenceOptions); silenceReport = { file: { name: sourceFile.name, size: sourceFile.size, duration: decoded.duration, sampleRate: decoded.sampleRate, channels: decoded.channels.length }, detection, method: 'Windowed RMS at or below threshold; intervals are reported and not automatically removed.' }; const channels = decoded.channels.map((channel) => restoreAudio(channel, decoded.sampleRate, options)); const after = channels.reduce((peak, channel) => Math.max(peak, ...peakChunked(channel)), 0); const bytes = encodeWav(channels, decoded.sampleRate, { bitDepth: 16 }); if (bytes.length > 256 * MiB) throw fail(t('Restored WAV exceeds the 256 MiB output cap.', 'O WAV restaurado excede o limite de saída de 256 MiB.')); output = new Blob([bytes], { type: 'audio/wav' }); outputUrl = makeObjectUrl(root, output, urls); const audio = root.querySelector('[data-audio]'); audio.src = outputUrl; audio.hidden = false; root.querySelector('[data-download]').hidden = false; root.querySelector('[data-download-report]').hidden = false; root.querySelector('[data-empty]').hidden = true; const reportElement = root.querySelector('[data-silence-report]'); const shown = detection.regions.slice(0, 200).map((region, index) => `${String(index + 1).padStart(3, ' ')}  ${formatTimestamp(region.start, '.')} – ${formatTimestamp(region.end, '.')}  ${region.duration.toFixed(3)} s`); reportElement.textContent = `${t('Detected silence regions', 'Regiões de silêncio detectadas')}: ${detection.regionCount}\n${t('Threshold', 'Limiar')}: ${detection.thresholdDb} dBFS · ${t('minimum', 'mínimo')} ${detection.minDurationMs} ms · ${t('window', 'janela')} ${detection.windowMs} ms\n\n${shown.join('\n')}${detection.regionCount > shown.length ? `\n… ${detection.regionCount - shown.length} ${t('additional regions are in the JSON report', 'regiões adicionais estão no relatório JSON')}` : ''}`; reportElement.hidden = false; metricGrid(root, [[t('Input peak', 'Pico de entrada'), before.toFixed(4)], [t('Output peak', 'Pico de saída'), after.toFixed(4)], [t('Silence regions', 'Regiões de silêncio'), detection.regionCount], [t('Detected silence', 'Silêncio detectado'), `${detection.totalSilentSeconds.toFixed(2)} s (${Math.round(detection.coverage * 100)}%)`], [t('Output', 'Saída'), formatBytes(output.size)], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('Restoration and reviewable silence analysis completed locally.', 'Restauração e análise revisável de silêncio concluídas localmente.'), 'success'); } catch (error) { setStatus(status, renderError(error, t, 'Could not restore the recording'), 'error'); } });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, `${stem(sourceFile?.name, 'recording')}.restored.wav`); }); root.querySelector('[data-download-report]').addEventListener('click', () => { if (silenceReport) downloadBlob(new Blob([JSON.stringify(silenceReport, null, 2)], { type: 'application/json' }), `${stem(sourceFile?.name, 'recording')}.silence.json`); }); const clear = () => { clearOutput(); decoded = null; sourceFile = null; process.disabled = true; root.querySelector('[data-release]').disabled = true; clearUrls(root, urls); metricGrid(root, []); }; root.querySelector('[data-release]').addEventListener('click', () => { clear(); setStatus(status, t('Restoration buffers released.', 'Buffers de restauração liberados.'), 'success'); }); attachCleanup(root, clear);
}

function peakChunked(channel) { let peak = 0; for (const value of channel) peak = Math.max(peak, Math.abs(value)); return [peak]; }

function mountMusicAnalyzer({ root, t }) {
  root.innerHTML = commonLayout(t, 'Analyze musical audio', 'Analisar áudio musical', 'Tempo · key · spectrogram', 'Tempo · tom · espectrograma', `
    <label class="field-label" for="music-file">${t('Music file', 'Arquivo de música')}</label><input class="file-input" id="music-file" type="file" accept="audio/*" data-file><div class="field-grid"><label><span class="field-label">${t('Spectrogram time bins', 'Colunas do espectrograma')}</span><input class="number-input" type="number" min="20" max="320" value="220" data-time-bins></label><label><span class="field-label">${t('Frequency bins', 'Faixas de frequência')}</span><input class="number-input" type="number" min="16" max="128" value="96" data-frequency-bins></label></div><button class="button button-primary" type="button" data-analyze>${t('Decode and analyze', 'Decodificar e analisar')}</button>
    <div class="notice-card"><strong>${t('Measured estimates', 'Estimativas medidas')}</strong><p>${t('BPM uses onset-envelope autocorrelation; key uses pitch-class energy profiles; loudness is RMS dBFS, not standards-compliant LUFS. The bounded time-frequency spectrogram uses Hann-windowed Goertzel bins. Confidence is shown so ambiguous material is not overstated.', 'O BPM usa autocorrelação do envelope de ataques; o tom usa perfis de energia por classe de altura; a intensidade é RMS dBFS, não LUFS normativo. O espectrograma tempo-frequência limitado usa faixas Goertzel com janela Hann. A confiança é exibida para não superestimar material ambíguo.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Analysis report', 'Relatório de análise')}</h2><button class="text-button" type="button" disabled data-release>${t('Release analysis', 'Liberar análise')}</button></div><div class="metric-grid" data-metrics></div><canvas width="960" height="360" style="display:block;width:100%;height:auto;border:1px solid var(--line)" hidden data-spectrogram aria-label="${t('Time-frequency spectrogram', 'Espectrograma tempo-frequência')}"></canvas><canvas width="960" height="360" style="display:block;width:100%;height:auto;border:1px solid var(--line);margin-top:1rem" hidden data-spectrum aria-label="${t('Log-frequency spectrum chart', 'Gráfico de espectro em frequência logarítmica')}"></canvas><button class="button button-secondary" type="button" hidden data-download>${t('Download JSON report', 'Baixar relatório JSON')}</button><div class="empty-result" data-empty><p>${t('Analysis is local. Audio is resampled for analysis and only the first 20 minutes are analyzed to bound memory and CPU.', 'A análise é local. O áudio é reamostrado e apenas os primeiros 20 minutos são analisados para limitar memória e CPU.')}</p></div>`);
  const status = root.querySelector('[data-status]'); const spectrumCanvas = root.querySelector('[data-spectrum]'); const spectrogramCanvas = root.querySelector('[data-spectrogram]'); let report = null; let sourceFile = null;
  root.querySelector('[data-analyze]').addEventListener('click', async () => { report = null; spectrumCanvas.hidden = true; spectrogramCanvas.hidden = true; root.querySelector('[data-download]').hidden = true; try { sourceFile = root.querySelector('[data-file]').files[0]; const decoded = await decodeAudio(root, sourceFile, t); let mono = convertChannels(decoded.channels, 'mono')[0]; const analysisRate = Math.min(11_025, decoded.sampleRate); mono = resampleLinear(mono, decoded.sampleRate, analysisRate); if (mono.length > analysisRate * 1200) mono = mono.slice(0, analysisRate * 1200); const spectrogram = computeSpectrogram(mono, analysisRate, { timeBins: Number(root.querySelector('[data-time-bins]').value), frequencyBins: Number(root.querySelector('[data-frequency-bins]').value) });
      report = { file: { name: sourceFile.name, size: sourceFile.size, sourceDuration: decoded.duration, sourceSampleRate: decoded.sampleRate, channels: decoded.channels.length }, analysis: analyzePcm(mono, analysisRate), spectrogram, method: { loudness: 'RMS dBFS', tempo: 'onset-envelope autocorrelation 55–200 BPM', key: 'Goertzel chroma + Krumhansl profiles', spectrogram: 'Hann-windowed log-frequency Goertzel energy' } };
      const a = report.analysis; metricGrid(root, [[t('Tempo estimate', 'Estimativa de tempo'), a.bpm ? `${a.bpm.toFixed(1)} BPM (${Math.round(a.bpmConfidence * 100)}%)` : t('Insufficient duration', 'Duração insuficiente')], [t('Key estimate', 'Estimativa de tom'), a.key ? `${a.key} (${Math.round(a.keyConfidence * 100)}%)` : t('Undetermined', 'Indeterminado')], [t('RMS loudness', 'Intensidade RMS'), `${a.loudnessDb.toFixed(2)} dBFS`], [t('True sample peak', 'Pico de amostra'), `${a.peakDb.toFixed(2)} dBFS`], [t('Crest factor', 'Fator de crista'), `${a.crestDb.toFixed(2)} dB`], [t('Detected onsets', 'Ataques detectados'), `${a.onsetCount}${a.onsetTruncated ? '+' : ''}`], [t('Spectrogram', 'Espectrograma'), `${spectrogram.timeBins}×${spectrogram.frequencyBins}`], [t('Duration', 'Duração'), `${decoded.duration.toFixed(2)} s`]]); drawSpectrogram(spectrogramCanvas, spectrogram, t, a.onsets); drawSpectrum(spectrumCanvas, a.spectrum, t); spectrumCanvas.hidden = false; spectrogramCanvas.hidden = false; root.querySelector('[data-download]').hidden = false; root.querySelector('[data-empty]').hidden = true; root.querySelector('[data-release]').disabled = false; setStatus(status, t('Music analysis, onset detection, and spectrogram completed locally.', 'Análise musical, detecção de ataques e espectrograma concluídos localmente.'), 'success');
    } catch (error) { metricGrid(root, []); setStatus(status, renderError(error, t, 'Could not analyze the music'), 'error'); } });
  root.querySelector('[data-download]').addEventListener('click', () => { if (report) downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `${stem(sourceFile?.name, 'music')}.analysis.json`); }); const clear = () => { report = null; sourceFile = null; spectrumCanvas.hidden = true; spectrogramCanvas.hidden = true; root.querySelector('[data-download]').hidden = true; root.querySelector('[data-empty]').hidden = false; root.querySelector('[data-release]').disabled = true; metricGrid(root, []); }; root.querySelector('[data-release]').addEventListener('click', () => { clear(); setStatus(status, t('Analysis data released.', 'Dados da análise liberados.'), 'success'); });
}

function drawSpectrum(canvas, spectrum, t) { const context = canvas.getContext('2d'); if (!context) return; const { width, height } = canvas; context.clearRect(0, 0, width, height); context.fillStyle = '#111'; context.fillRect(0, 0, width, height); const padding = 48; const floor = -90; const ceiling = -10; const bar = (width - padding * 2) / spectrum.length; context.fillStyle = '#b8ff47'; spectrum.forEach((bin, index) => { const normalized = Math.max(0, Math.min(1, (bin.db - floor) / (ceiling - floor))); context.fillRect(padding + index * bar, height - padding - normalized * (height - padding * 2), Math.max(1, bar - 2), normalized * (height - padding * 2)); }); context.fillStyle = '#fff'; context.font = '18px ui-monospace, monospace'; context.fillText(t('Log-frequency spectrum', 'Espectro em frequência logarítmica'), padding, 28); context.fillText(`${spectrum[0]?.frequency || 0} Hz`, padding, height - 14); context.textAlign = 'right'; context.fillText(`${spectrum.at(-1)?.frequency || 0} Hz`, width - padding, height - 14); context.textAlign = 'left'; }

function drawSpectrogram(canvas, spectrogram, t, onsets = []) {
  const context = canvas.getContext('2d'); if (!context) return; const { width, height } = canvas; const paddingX = 58; const paddingTop = 40; const paddingBottom = 42; const plotWidth = width - paddingX - 18; const plotHeight = height - paddingTop - paddingBottom; context.clearRect(0, 0, width, height); context.fillStyle = '#111'; context.fillRect(0, 0, width, height);
  const span = Math.max(1, spectrogram.ceilingDb - spectrogram.floorDb); const cellWidth = plotWidth / spectrogram.timeBins; const cellHeight = plotHeight / spectrogram.frequencyBins;
  for (let time = 0; time < spectrogram.timeBins; time += 1) for (let bin = 0; bin < spectrogram.frequencyBins; bin += 1) { const normalized = Math.max(0, Math.min(1, (spectrogram.values[time][bin] - spectrogram.floorDb) / span)); const hue = 255 - normalized * 210; const lightness = 8 + normalized * 58; context.fillStyle = `hsl(${hue} 88% ${lightness}%)`; context.fillRect(paddingX + time * cellWidth, paddingTop + (spectrogram.frequencyBins - 1 - bin) * cellHeight, Math.ceil(cellWidth + 0.25), Math.ceil(cellHeight + 0.25)); }
  context.strokeStyle = 'rgba(255,255,255,.72)'; context.lineWidth = 1; context.beginPath(); for (const onset of onsets.slice(0, 2_000)) { const x = paddingX + Math.max(0, Math.min(1, onset.time / Math.max(1e-9, spectrogram.duration))) * plotWidth; context.moveTo(x + 0.5, paddingTop); context.lineTo(x + 0.5, paddingTop + plotHeight); } context.stroke();
  context.fillStyle = '#fff'; context.font = '18px ui-monospace, monospace'; context.fillText(t('Time–frequency spectrogram · onset markers', 'Espectrograma tempo–frequência · marcadores de ataques'), paddingX, 26); context.font = '14px ui-monospace, monospace'; context.fillText(`${Math.round(spectrogram.maxFrequency)} Hz`, 4, paddingTop + 5); context.fillText(`${Math.round(spectrogram.minFrequency)} Hz`, 4, paddingTop + plotHeight); context.fillText('0 s', paddingX, height - 14); context.textAlign = 'right'; context.fillText(`${spectrogram.duration.toFixed(1)} s`, paddingX + plotWidth, height - 14); context.textAlign = 'left';
}

async function pdfRuntime() { return loadScript('/vendor/pdf-lib/pdf-lib.min.js', 'PDFLib'); }

function stripPdfMetadata(document, PDFLib) {
  document.setTitle(''); document.setAuthor(''); document.setSubject(''); document.setKeywords([]); document.setProducer(''); document.setCreator('');
  document.catalog.delete(PDFLib.PDFName.of('Metadata'));
}

export function parseFieldAssignments(source) {
  const values = new Map();
  for (const [index, raw] of String(source).replaceAll('\r\n', '\n').split('\n').entries()) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue; const separator = line.indexOf('='); if (separator <= 0) throw new Error(`Invalid field assignment on line ${index + 1}.`);
    const name = line.slice(0, separator).trim(); const value = line.slice(separator + 1); if (values.has(name)) throw new Error(`Field ${name} is assigned more than once.`); values.set(name, value);
  }
  return values;
}

export function pdfFieldKind(field, PDFLib) {
  const types = [
    ['TextField', PDFLib?.PDFTextField],
    ['CheckBox', PDFLib?.PDFCheckBox],
    ['Dropdown', PDFLib?.PDFDropdown],
    ['OptionList', PDFLib?.PDFOptionList],
    ['RadioGroup', PDFLib?.PDFRadioGroup],
    ['Button', PDFLib?.PDFButton],
    ['Signature', PDFLib?.PDFSignature]
  ];
  const match = types.find(([, Type]) => typeof Type === 'function' && field instanceof Type);
  return match?.[0] || String(field?.constructor?.name || 'Unknown').replace(/^PDF/, '');
}

function mountPdfToolbox({ root, t }) {
  root.innerHTML = commonLayout(t, 'Arrange PDF pages', 'Organizar páginas PDF', 'Fresh local PDFs', 'Novos PDFs locais', `
    <label class="field-label" for="pdf-toolbox-files">${t('PDF files', 'Arquivos PDF')}</label><input class="file-input" id="pdf-toolbox-files" type="file" accept="application/pdf,.pdf" multiple data-files><button class="button button-secondary" type="button" data-analyze>${t('Analyze PDFs', 'Analisar PDFs')}</button><ol class="file-order-list" data-file-list></ol>
    <div class="field-grid"><label><span class="field-label">${t('Operation', 'Operação')}</span><select data-operation><option value="merge">${t('Merge all files', 'Unir todos os arquivos')}</option><option value="extract">${t('Extract groups from first', 'Extrair grupos do primeiro')}</option><option value="reorder">${t('Reorder first file', 'Reordenar primeiro arquivo')}</option><option value="optimize">${t('Rewrite/optimize first', 'Regravar/otimizar primeiro')}</option></select></label><label><span class="field-label">${t('Rotate copied pages', 'Girar páginas copiadas')}</span><select data-rotation><option value="0">0°</option><option value="90">+90°</option><option value="180">180°</option><option value="270">-90°</option></select></label></div>
    <label class="field-label" for="pdf-toolbox-range">${t('Page expression', 'Expressão de páginas')}</label><input class="text-input" id="pdf-toolbox-range" value="all" data-range><p class="field-help">${t('Extract groups use semicolons: 1-3;4,6. Reorder preserves expression order: 3,1-2.', 'Grupos de extração usam ponto e vírgula: 1-3;4,6. A reordenação preserva a ordem: 3,1-2.')}</p>
    <label class="check-row"><input type="checkbox" data-strip> ${t('Remove common document metadata', 'Remover metadados comuns do documento')}</label><button class="button button-primary" type="button" disabled data-create>${t('Create output PDF(s)', 'Criar PDF(s) de saída')}</button><progress class="workbench-progress" max="1" value="0" hidden data-progress></progress>
    <div class="notice-card"><strong>${t('Optimization scope', 'Escopo da otimização')}</strong><p>${t('The local pdf-lib runtime copies pages and writes object streams. It does not recompress embedded photos, preserve every bookmark/tag, or open encrypted PDFs.', 'O pdf-lib local copia páginas e grava object streams. Ele não recomprime fotos incorporadas, preserva todos os marcadores/tags nem abre PDFs criptografados.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('PDF outputs', 'Saídas PDF')}</h2><button class="text-button" type="button" disabled data-release>${t('Release outputs', 'Liberar saídas')}</button></div><div class="metric-grid" data-metrics></div><ul class="download-list" data-outputs></ul><div class="empty-result" data-empty><p>${t('The PDF runtime loads from this site only after Analyze; document bytes stay in this tab.', 'O runtime PDF é carregado deste site apenas após Analisar; os bytes ficam nesta aba.')}</p></div>`);
  const status = root.querySelector('[data-status]'); const create = root.querySelector('[data-create]'); const progress = root.querySelector('[data-progress]'); const release = root.querySelector('[data-release]'); let records = []; let outputs = [];
  const clearOutputs = () => { outputs = []; root.querySelector('[data-outputs]').replaceChildren(); root.querySelector('[data-empty]').hidden = false; release.disabled = true; };
  root.querySelector('[data-analyze]').addEventListener('click', async () => { records = []; clearOutputs(); create.disabled = true; root.querySelector('[data-file-list]').replaceChildren(); try { const files = [...root.querySelector('[data-files]').files]; if (!files.length || files.length > 50) throw fail(t('Choose 1–50 PDFs.', 'Escolha de 1 a 50 PDFs.')); if (files.reduce((sum, file) => sum + file.size, 0) > 250 * MiB) throw fail(t('Total PDF input is limited to 250 MiB.', 'A entrada total de PDFs é limitada a 250 MiB.')); const PDFLib = await pdfRuntime(); for (const file of files) { const bytes = new Uint8Array(await file.arrayBuffer()); const document = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false }); records.push({ file, bytes, pages: document.getPageCount() }); } const list = root.querySelector('[data-file-list]'); records.forEach((record, index) => { const item = root.ownerDocument.createElement('li'); const label = root.ownerDocument.createElement('span'); label.textContent = `${record.file.name} · ${record.pages} ${t('pages', 'páginas')} · ${formatBytes(record.file.size)}`; const controls = root.ownerDocument.createElement('span'); for (const [delta, text] of [[-1, t('Up', 'Subir')], [1, t('Down', 'Descer')]]) { const button = root.ownerDocument.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.dataset.index = String(index); button.dataset.delta = String(delta); button.disabled = index + delta < 0 || index + delta >= records.length; button.textContent = text; controls.append(button); } item.append(label, controls); list.append(item); }); create.disabled = false; metricGrid(root, [[t('Files', 'Arquivos'), records.length], [t('Pages', 'Páginas'), records.reduce((sum, record) => sum + record.pages, 0)], [t('Input', 'Entrada'), formatBytes(files.reduce((sum, file) => sum + file.size, 0))], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('PDFs analyzed locally. Selection order is the merge order.', 'PDFs analisados localmente. A ordem da seleção é a ordem de união.'), 'success'); } catch (error) { records = []; setStatus(status, renderError(error, t, 'Could not analyze the PDFs'), 'error'); } });
  const renderFileOrder = () => { const list = root.querySelector('[data-file-list]'); list.replaceChildren(); records.forEach((record, index) => { const item = root.ownerDocument.createElement('li'); const label = root.ownerDocument.createElement('span'); label.textContent = `${record.file.name} · ${record.pages} ${t('pages', 'páginas')}`; const controls = root.ownerDocument.createElement('span'); for (const [delta, text] of [[-1, t('Up', 'Subir')], [1, t('Down', 'Descer')]]) { const button = root.ownerDocument.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.dataset.index = String(index); button.dataset.delta = String(delta); button.disabled = index + delta < 0 || index + delta >= records.length; button.textContent = text; controls.append(button); } item.append(label, controls); list.append(item); }); };
  root.querySelector('[data-file-list]').addEventListener('click', (event) => { const button = event.target.closest('[data-delta]'); if (!button) return; const index = Number(button.dataset.index); const target = index + Number(button.dataset.delta); [records[index], records[target]] = [records[target], records[index]]; renderFileOrder(); clearOutputs(); setStatus(status, t('PDF order updated.', 'Ordem dos PDFs atualizada.'), 'success'); });
  create.addEventListener('click', async () => { clearOutputs(); progress.hidden = false; try { const PDFLib = await pdfRuntime(); const operation = root.querySelector('[data-operation]').value; const expression = root.querySelector('[data-range]').value.trim() || 'all'; const rotation = Number(root.querySelector('[data-rotation]').value); const groups = operation === 'extract' ? parsePageRanges(expression, records[0].pages, { allowGroups: true }) : [operation === 'merge' || operation === 'optimize' ? null : parsePageRanges(expression, records[0].pages)[0]]; if (groups.length > 100) throw fail(t('Extraction is limited to 100 output groups.', 'A extração é limitada a 100 grupos de saída.')); progress.max = groups.length;
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) { const outputDocument = await PDFLib.PDFDocument.create({ updateMetadata: false }); const sources = operation === 'merge' ? records : records.slice(0, 1); for (const record of sources) { const sourceDocument = await PDFLib.PDFDocument.load(record.bytes, { updateMetadata: false }); const indices = groups[groupIndex] || Array.from({ length: sourceDocument.getPageCount() }, (_, index) => index); const pages = await outputDocument.copyPages(sourceDocument, indices); for (const page of pages) { if (rotation) page.setRotation(PDFLib.degrees((page.getRotation().angle + rotation) % 360)); outputDocument.addPage(page); } } if (root.querySelector('[data-strip]').checked) stripPdfMetadata(outputDocument, PDFLib); const bytes = await outputDocument.save({ useObjectStreams: true, objectsPerTick: 50 }); const total = outputs.reduce((sum, item) => sum + item.blob.size, 0) + bytes.length; if (total > 256 * MiB) throw fail(t('Retained PDF outputs exceed 256 MiB.', 'As saídas PDF retidas excedem 256 MiB.')); const suffix = operation === 'extract' ? `part-${groupIndex + 1}` : operation; outputs.push({ name: `${stem(records[0].file.name, 'document')}.${suffix}.pdf`, blob: new Blob([bytes], { type: 'application/pdf' }), pages: outputDocument.getPageCount() }); progress.value = groupIndex + 1; }
      const list = root.querySelector('[data-outputs]'); outputs.forEach((item, index) => { const row = root.ownerDocument.createElement('li'); const label = root.ownerDocument.createElement('span'); label.textContent = `${item.name} · ${item.pages} ${t('pages', 'páginas')} · ${formatBytes(item.blob.size)}`; const button = root.ownerDocument.createElement('button'); button.type = 'button'; button.className = 'button button-secondary compact-button'; button.dataset.outputIndex = String(index); button.textContent = t('Download', 'Baixar'); row.append(label, button); list.append(row); }); root.querySelector('[data-empty]').hidden = true; release.disabled = false; metricGrid(root, [[t('Outputs', 'Saídas'), outputs.length], [t('Pages', 'Páginas'), outputs.reduce((sum, item) => sum + item.pages, 0)], [t('Output', 'Saída'), formatBytes(outputs.reduce((sum, item) => sum + item.blob.size, 0))], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('Fresh PDF output is ready.', 'A nova saída PDF está pronta.'), 'success');
    } catch (error) { clearOutputs(); setStatus(status, renderError(error, t, 'Could not create the PDF output'), 'error'); } finally { progress.hidden = true; } });
  root.querySelector('[data-outputs]').addEventListener('click', (event) => { const item = outputs[Number(event.target.closest('[data-output-index]')?.dataset.outputIndex)]; if (item) downloadBlob(item.blob, item.name); }); release.addEventListener('click', () => { clearOutputs(); setStatus(status, t('Generated PDFs released.', 'PDFs gerados liberados.'), 'success'); }); attachCleanup(root, clearOutputs);
}

function mountPdfEditor({ root, t }) {
  root.innerHTML = commonLayout(t, 'Edit a PDF copy', 'Editar uma cópia PDF', 'Text · forms · pages', 'Texto · formulários · páginas', `
    <label class="field-label" for="pdf-editor-file">${t('PDF file', 'Arquivo PDF')}</label><input class="file-input" id="pdf-editor-file" type="file" accept="application/pdf,.pdf" data-file><button class="button button-secondary" type="button" data-open>${t('Inspect PDF', 'Inspecionar PDF')}</button>
    <div class="field-grid"><label><span class="field-label">${t('Target page', 'Página alvo')}</span><input class="number-input" type="number" min="1" value="1" data-page></label><label><span class="field-label">${t('Rotate target', 'Girar alvo')}</span><select data-rotation><option value="0">0°</option><option value="90">+90°</option><option value="180">180°</option><option value="270">-90°</option></select></label><label><span class="field-label">X (pt)</span><input class="number-input" type="number" min="0" value="36" data-x></label><label><span class="field-label">Y (pt)</span><input class="number-input" type="number" min="0" value="36" data-y></label><label><span class="field-label">${t('Font size (pt)', 'Tamanho da fonte (pt)')}</span><input class="number-input" type="number" min="4" max="144" value="18" data-size></label><label><span class="field-label">${t('Ink color', 'Cor da tinta')}</span><input type="color" value="#111111" data-color></label></div>
    <label class="field-label" for="pdf-editor-text">${t('Text to draw (optional)', 'Texto a desenhar (opcional)')}</label><textarea class="code-input" id="pdf-editor-text" rows="4" maxlength="4000" data-text></textarea>
    <label class="field-label" for="pdf-editor-signature">${t('Optional PNG/JPEG signature image', 'Imagem de assinatura PNG/JPEG opcional')}</label><input class="file-input" id="pdf-editor-signature" type="file" accept="image/png,image/jpeg" data-signature>
    <label class="field-label" for="pdf-editor-remove">${t('Pages to remove (optional)', 'Páginas a remover (opcional)')}</label><input class="text-input" id="pdf-editor-remove" placeholder="2,4-6" data-remove>
    <label class="field-label" for="pdf-editor-fields">${t('Form values, one field=value per line', 'Valores do formulário, um campo=valor por linha')}</label><textarea class="code-input" id="pdf-editor-fields" rows="5" spellcheck="false" data-assignments></textarea><label class="check-row"><input type="checkbox" data-flatten> ${t('Flatten forms after filling', 'Achatar formulários após preencher')}</label><button class="button button-primary" type="button" disabled data-save>${t('Apply edits to a new PDF', 'Aplicar edições em um novo PDF')}</button>
    <div class="notice-card"><strong>${t('Visible signature, not a digital certificate', 'Assinatura visível, não certificado digital')}</strong><p>${t('An inserted image is only a visual mark. This tool does not create cryptographic PDF signatures or attest identity.', 'Uma imagem inserida é apenas uma marca visual. Esta ferramenta não cria assinaturas PDF criptográficas nem atesta identidade.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Document inspection', 'Inspeção do documento')}</h2><button class="text-button" type="button" disabled data-release>${t('Release document', 'Liberar documento')}</button></div><div class="metric-grid" data-metrics></div><div class="table-scroll" hidden data-table-wrap><table class="data-table"><caption>${t('Detected AcroForm fields', 'Campos AcroForm detectados')}</caption><thead><tr><th>${t('Name', 'Nome')}</th><th>${t('Type', 'Tipo')}</th><th>${t('Current value', 'Valor atual')}</th></tr></thead><tbody data-fields></tbody></table></div><button class="button button-secondary" type="button" hidden data-download>${t('Download edited PDF', 'Baixar PDF editado')}</button><div class="empty-result" data-empty><p>${t('Open a PDF to inspect page count and fillable fields before making a fresh copy.', 'Abra um PDF para inspecionar a contagem de páginas e campos preenchíveis antes de criar uma nova cópia.')}</p></div>`);
  const status = root.querySelector('[data-status]'); const save = root.querySelector('[data-save]'); let record = null; let output = null;
  const clearOutput = () => { output = null; root.querySelector('[data-download]').hidden = true; };
  root.querySelector('[data-open]').addEventListener('click', async () => { record = null; clearOutput(); save.disabled = true; try { const file = checkedFile(root.querySelector('[data-file]').files[0], MAX_DOCUMENT_BYTES, t, 'PDF'); const PDFLib = await pdfRuntime(); const bytes = new Uint8Array(await file.arrayBuffer()); const document = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false }); const fields = []; try { for (const field of document.getForm().getFields()) { let value = ''; try { value = field.getText?.() ?? field.getSelected?.()?.join(', ') ?? (field.isChecked?.() ? 'checked' : ''); } catch { value = ''; } fields.push({ name: field.getName(), type: pdfFieldKind(field, PDFLib), value }); } } catch { /* no AcroForm */ } record = { file, bytes, pages: document.getPageCount(), fields }; root.querySelector('[data-page]').max = String(record.pages); const body = root.querySelector('[data-fields]'); body.replaceChildren(); fields.forEach((field) => { const row = root.ownerDocument.createElement('tr'); for (const value of [field.name, field.type, field.value || '—']) { const cell = root.ownerDocument.createElement('td'); cell.textContent = value; row.append(cell); } body.append(row); }); root.querySelector('[data-table-wrap]').hidden = !fields.length; root.querySelector('[data-empty]').hidden = false; root.querySelector('[data-release]').disabled = false; save.disabled = false; metricGrid(root, [[t('Pages', 'Páginas'), record.pages], [t('Form fields', 'Campos de formulário'), fields.length], [t('Input', 'Entrada'), formatBytes(file.size)], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('PDF inspected locally.', 'PDF inspecionado localmente.'), 'success'); } catch (error) { setStatus(status, renderError(error, t, 'Could not inspect the PDF'), 'error'); } });
  save.addEventListener('click', async () => { clearOutput(); try { const PDFLib = await pdfRuntime(); const document = await PDFLib.PDFDocument.load(record.bytes, { updateMetadata: false }); const pageNumber = Number(root.querySelector('[data-page]').value); if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.getPageCount()) throw fail(t('Target page is outside this document.', 'A página alvo está fora deste documento.')); const page = document.getPage(pageNumber - 1); const rotation = Number(root.querySelector('[data-rotation]').value); if (rotation) page.setRotation(PDFLib.degrees((page.getRotation().angle + rotation) % 360)); const x = Number(root.querySelector('[data-x]').value); const y = Number(root.querySelector('[data-y]').value); const fontSize = Number(root.querySelector('[data-size]').value); const text = root.querySelector('[data-text]').value; if (text) { const font = await document.embedFont(PDFLib.StandardFonts.Helvetica); const [r, g, b] = colorRgb(root.querySelector('[data-color]').value); const lines = text.split('\n'); lines.forEach((line, index) => page.drawText(line, { x, y: y - index * fontSize * 1.2, size: fontSize, font, color: PDFLib.rgb(r, g, b), maxWidth: Math.max(1, page.getWidth() - x) })); }
      const signature = root.querySelector('[data-signature]').files[0]; if (signature) { checkedFile(signature, 10 * MiB, t, t('signature image', 'imagem de assinatura')); const bytes = new Uint8Array(await signature.arrayBuffer()); const isPng = signature.type === 'image/png' || /\.png$/i.test(signature.name); const isJpeg = signature.type === 'image/jpeg' || /\.jpe?g$/i.test(signature.name); const image = isPng ? await document.embedPng(bytes) : isJpeg ? await document.embedJpg(bytes) : null; if (!image) throw fail(t('Signature image must be PNG or JPEG.', 'A imagem de assinatura deve ser PNG ou JPEG.')); const dimensions = image.scaleToFit(180, 80); page.drawImage(image, { x, y, width: dimensions.width, height: dimensions.height }); }
      const assignments = parseFieldAssignments(root.querySelector('[data-assignments]').value); if (assignments.size) { const form = document.getForm(); const fields = new Map(form.getFields().map((field) => [field.getName(), field])); for (const [name, value] of assignments) { const field = fields.get(name); if (!field) throw fail(t(`Form field not found: ${name}`, `Campo de formulário não encontrado: ${name}`)); const type = pdfFieldKind(field, PDFLib); if (type === 'TextField') field.setText(value); else if (type === 'CheckBox') /^(?:1|true|yes|on|checked)$/i.test(value) ? field.check() : field.uncheck(); else if (type === 'Dropdown' || type === 'OptionList' || type === 'RadioGroup') field.select(value); else throw fail(t(`Unsupported form field type for ${name}: ${type}`, `Tipo de campo não compatível para ${name}: ${type}`)); } if (root.querySelector('[data-flatten]').checked) form.flatten(); }
      const remove = root.querySelector('[data-remove]').value.trim(); if (remove) { const indices = parsePageRanges(remove, document.getPageCount())[0].sort((a, b) => b - a); if (indices.length >= document.getPageCount()) throw fail(t('At least one PDF page must remain.', 'Pelo menos uma página PDF deve permanecer.')); for (const index of indices) document.removePage(index); }
      const bytes = await document.save({ useObjectStreams: true, objectsPerTick: 50 }); if (bytes.length > 256 * MiB) throw fail(t('Edited PDF exceeds the 256 MiB output cap.', 'O PDF editado excede o limite de saída de 256 MiB.')); output = new Blob([bytes], { type: 'application/pdf' }); root.querySelector('[data-download]').hidden = false; root.querySelector('[data-empty]').hidden = true; metricGrid(root, [[t('Pages', 'Páginas'), document.getPageCount()], [t('Form values applied', 'Valores aplicados'), assignments.size], [t('Visual marks', 'Marcas visuais'), Number(Boolean(text)) + Number(Boolean(signature))], [t('Output', 'Saída'), formatBytes(output.size)]]); setStatus(status, t('Edited PDF copy is ready.', 'A cópia PDF editada está pronta.'), 'success');
    } catch (error) { setStatus(status, renderError(error, t, 'Could not apply the PDF edits'), 'error'); } });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, `${stem(record?.file.name, 'document')}.edited.pdf`); }); const clear = () => { record = null; clearOutput(); save.disabled = true; root.querySelector('[data-fields]').replaceChildren(); root.querySelector('[data-table-wrap]').hidden = true; root.querySelector('[data-empty]').hidden = false; root.querySelector('[data-release]').disabled = true; metricGrid(root, []); }; root.querySelector('[data-release]').addEventListener('click', () => { clear(); setStatus(status, t('Document bytes released.', 'Bytes do documento liberados.'), 'success'); }); attachCleanup(root, clear);
}

async function zipTextMap(bytes, entries, predicate, maximumChars = MAX_TEXT_CHARS) {
  const values = new Map(); let total = 0; let characters = 0;
  for (const entry of entries) {
    if (entry.directory || !predicate(entry.name)) continue;
    const data = await extractZipEntry(bytes, entry); total += data.length;
    if (total > maximumChars * 4) throw new Error('Decoded XML/text exceeds the document text cap.');
    const text = utf8.decode(data); characters += text.length; if (characters > maximumChars) throw new Error('Decoded document text exceeds the character cap.'); values.set(entry.name, text);
  }
  return values;
}

function mountOfficeViewer({ root, t }) {
  root.innerHTML = commonLayout(t, 'Read modern Office documents', 'Ler documentos Office modernos', 'Semantic local view', 'Visualização semântica local', `
    <label class="field-label" for="office-file">${t('DOCX, XLSX, or PPTX file', 'Arquivo DOCX, XLSX ou PPTX')}</label><input class="file-input" id="office-file" type="file" accept=".docx,.xlsx,.pptx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" data-file><button class="button button-primary" type="button" data-open>${t('Open semantic view', 'Abrir visualização semântica')}</button>
    <div class="notice-card"><strong>${t('Readable structure, not pixel-perfect Office', 'Estrutura legível, não Office pixel-perfect')}</strong><p>${t('This parser reads document text, worksheet cell values, and slide text directly from OOXML ZIP parts. It does not render macros, charts, images, formulas, animations, or proprietary layout exactly.', 'Este parser lê texto de documentos, valores de células e texto de slides diretamente das partes ZIP OOXML. Ele não renderiza macros, gráficos, imagens, fórmulas, animações ou layout proprietário com exatidão.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Document view', 'Visualização do documento')}</h2><button class="text-button" type="button" disabled data-release>${t('Release document', 'Liberar documento')}</button></div><div class="metric-grid" data-metrics></div><label class="field-label" for="office-section" hidden data-section-label>${t('Section', 'Seção')}</label><select id="office-section" hidden data-section></select><pre class="code-output" tabindex="0" style="min-height:18rem;max-height:42rem;overflow:auto;white-space:pre-wrap" hidden data-output></pre><button class="button button-secondary" type="button" hidden data-download>${t('Download extracted text', 'Baixar texto extraído')}</button><div class="empty-result" data-empty><p>${t('OOXML data stays in memory in this tab and is discarded when released.', 'Os dados OOXML ficam na memória desta aba e são descartados quando liberados.')}</p></div>`);
  const status = root.querySelector('[data-status]'); const sectionSelect = root.querySelector('[data-section]'); const outputElement = root.querySelector('[data-output]'); let result = null; let sourceFile = null;
  const showSection = () => { if (!result) return; outputElement.textContent = result.sections[Number(sectionSelect.value)]?.text || ''; };
  root.querySelector('[data-open]').addEventListener('click', async () => { result = null; try { sourceFile = checkedFile(root.querySelector('[data-file]').files[0], 128 * MiB, t, t('Office document', 'documento Office')); const extension = sourceFile.name.split('.').pop().toLowerCase(); if (!['docx', 'xlsx', 'pptx'].includes(extension)) throw fail(t('Choose a DOCX, XLSX, or PPTX file.', 'Escolha um arquivo DOCX, XLSX ou PPTX.')); const bytes = new Uint8Array(await sourceFile.arrayBuffer()); const directory = parseZipDirectory(bytes, { maximumFiles: 5000, maximumExpanded: 256 * MiB }); const predicate = extension === 'docx' ? (name) => name === 'word/document.xml' : extension === 'xlsx' ? (name) => name === 'xl/workbook.xml' || name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name) : (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name); const entries = await zipTextMap(bytes, directory, predicate); result = extractOfficeDocument(extension, entries); sectionSelect.replaceChildren(); result.sections.forEach((section, index) => { const option = root.ownerDocument.createElement('option'); option.value = String(index); option.textContent = section.title; sectionSelect.append(option); }); sectionSelect.hidden = false; root.querySelector('[data-section-label]').hidden = false; outputElement.hidden = false; root.querySelector('[data-download]').hidden = false; root.querySelector('[data-empty]').hidden = true; root.querySelector('[data-release]').disabled = false; showSection(); const characters = result.sections.reduce((sum, section) => sum + section.text.length, 0); metricGrid(root, [[t('Format', 'Formato'), result.type], [t('Sections', 'Seções'), result.sections.length], [t('Extracted characters', 'Caracteres extraídos'), characters.toLocaleString()], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('Office document opened locally.', 'Documento Office aberto localmente.'), 'success'); } catch (error) { clearOffice(); setStatus(status, renderError(error, t, 'Could not open the Office document'), 'error'); } });
  sectionSelect.addEventListener('change', showSection); root.querySelector('[data-download]').addEventListener('click', () => { if (!result) return; const text = result.sections.map((section) => `# ${section.title}\n\n${section.text}`).join('\n\n'); downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${stem(sourceFile?.name, 'office')}.extracted.txt`); });
  function clearOffice() { result = null; sourceFile = null; sectionSelect.replaceChildren(); sectionSelect.hidden = true; root.querySelector('[data-section-label]').hidden = true; outputElement.textContent = ''; outputElement.hidden = true; root.querySelector('[data-download]').hidden = true; root.querySelector('[data-empty]').hidden = false; root.querySelector('[data-release]').disabled = true; metricGrid(root, []); }
  root.querySelector('[data-release]').addEventListener('click', () => { clearOffice(); setStatus(status, t('Office document data released.', 'Dados do documento Office liberados.'), 'success'); }); attachCleanup(root, clearOffice);
}

export function resolveArchiveRelative(base, href) {
  const cleanHref = String(href).split(/[?#]/, 1)[0]; let decoded = cleanHref; try { decoded = decodeURIComponent(cleanHref); } catch { /* use raw href */ }
  if (!decoded || decoded.includes('\0') || decoded.startsWith('/') || /^[a-z]:/i.test(decoded)) throw new Error(`Unsafe relative resource path: ${href}`);
  const parts = String(base).split('/'); parts.pop();
  for (const part of decoded.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error(`Unsafe relative resource path: ${href}`); parts.pop(); }
    else parts.push(part);
  }
  return normalizeArchivePath(parts.join('/'));
}

export function makeArchiveRelativeHref(fromDocument, targetPath) {
  const from = normalizeArchivePath(fromDocument).split('/'); from.pop(); const target = normalizeArchivePath(targetPath).split('/'); let common = 0; while (common < from.length && common < target.length && from[common] === target[common]) common += 1; const segments = [...Array(from.length - common).fill('..'), ...target.slice(common)]; return segments.map((segment) => segment === '..' ? segment : encodeURIComponent(segment).replaceAll('%3A', ':')).join('/') || './';
}

function readableHtml(source) {
  return decodeXml(String(source).replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, '').replace(/<\/(?:p|div|h[1-6]|li|blockquote|tr|section|article)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}

function mountEpubStudio({ root, t }) {
  root.innerHTML = commonLayout(t, 'Inspect and edit an EPUB', 'Inspecionar e editar um EPUB', 'Metadata · spine · repack', 'Metadados · ordem · reempacotar', `
    <label class="field-label" for="epub-file">${t('EPUB file', 'Arquivo EPUB')}</label><input class="file-input" id="epub-file" type="file" accept="application/epub+zip,.epub" data-file><button class="button button-secondary" type="button" data-open>${t('Open and validate', 'Abrir e validar')}</button>
    <div class="field-grid"><label><span class="field-label">${t('Title', 'Título')}</span><input class="text-input" maxlength="500" data-title></label><label><span class="field-label">${t('Creator', 'Autor')}</span><input class="text-input" maxlength="500" data-creator></label><label><span class="field-label">${t('Language', 'Idioma')}</span><input class="text-input" maxlength="40" data-language></label><label><span class="field-label">${t('Identifier', 'Identificador')}</span><input class="text-input" maxlength="500" data-identifier></label><label><span class="field-label">${t('Publisher', 'Editora')}</span><input class="text-input" maxlength="500" data-publisher></label></div><label class="field-label" for="epub-description">${t('Description', 'Descrição')}</label><textarea class="code-input" id="epub-description" rows="4" maxlength="10000" data-description></textarea><button class="button button-primary" type="button" disabled data-save>${t('Save edited EPUB', 'Salvar EPUB editado')}</button><progress class="workbench-progress" max="1" value="0" hidden data-progress></progress>
    <div class="notice-card"><strong>${t('Standards-aware metadata, reading order, and TOC', 'Metadados, ordem de leitura e sumário cientes do padrão')}</strong><p>${t('The spine can be reordered and chapter labels are written to every existing EPUB3 navigation document and NCX table of contents. The mimetype entry remains first and uncompressed. Other resources are copied byte-for-byte, but the new ZIP uses store mode, so output may be larger. DRM-protected books are not supported.', 'A ordem de leitura pode ser reorganizada e os títulos dos capítulos são gravados em cada documento de navegação EPUB3 e sumário NCX existente. A entrada mimetype permanece primeiro e sem compressão. Outros recursos são copiados byte a byte, mas o novo ZIP usa modo armazenado, então a saída pode ser maior. Livros com DRM não são compatíveis.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Book structure and TOC editor', 'Estrutura do livro e editor de sumário')}</h2><button class="text-button" type="button" disabled data-release>${t('Release book', 'Liberar livro')}</button></div><div class="metric-grid" data-metrics></div><h3 hidden data-toc-heading>${t('Reading order and chapter titles', 'Ordem de leitura e títulos dos capítulos')}</h3><ol class="file-order-list" data-toc-editor></ol><label class="field-label" for="epub-chapter" hidden data-chapter-label>${t('Preview chapter', 'Pré-visualizar capítulo')}</label><select id="epub-chapter" hidden data-chapter></select><pre class="code-output" tabindex="0" style="min-height:18rem;max-height:38rem;overflow:auto;white-space:pre-wrap" hidden data-output></pre><button class="button button-secondary" type="button" hidden data-download>${t('Download edited EPUB', 'Baixar EPUB editado')}</button><ul data-issues></ul><div class="empty-result" data-empty><p>${t('Open an EPUB to validate its container, package metadata, manifest, navigation documents, and reading order.', 'Abra um EPUB para validar o contêiner, metadados do pacote, manifesto, documentos de navegação e ordem de leitura.')}</p></div>`);
  const status = root.querySelector('[data-status]'); const chapter = root.querySelector('[data-chapter]'); const outputElement = root.querySelector('[data-output]'); const progress = root.querySelector('[data-progress]'); let book = null; let output = null;
  const renderChapter = async () => { if (!book) return; try { const item = book.chapters[Number(chapter.value)]; if (!item) { outputElement.textContent = t('No readable spine chapter.', 'Nenhum capítulo legível na ordem.'); return; } const entry = book.entryMap.get(item.path); if (!entry) throw new Error(`Missing chapter: ${item.path}`); const data = await extractZipEntry(book.bytes, entry); outputElement.textContent = readableHtml(utf8.decode(data)).slice(0, MAX_TEXT_CHARS); } catch (error) { outputElement.textContent = error.message; } };
  const renderTocEditor = () => {
    const editor = root.querySelector('[data-toc-editor]'); editor.replaceChildren(); chapter.replaceChildren(); if (!book) return;
    book.chapters.forEach((item, index) => { const row = root.ownerDocument.createElement('li'); const label = root.ownerDocument.createElement('label'); label.textContent = `${index + 1}. `; const title = root.ownerDocument.createElement('input'); title.type = 'text'; title.className = 'text-input'; title.maxLength = 500; title.value = item.title; title.dataset.tocTitleIndex = String(index); title.setAttribute('aria-label', t(`TOC title for chapter ${index + 1}`, `Título do sumário para o capítulo ${index + 1}`)); label.append(title); const controls = root.ownerDocument.createElement('span'); for (const [delta, textValue] of [[-1, t('Up', 'Subir')], [1, t('Down', 'Descer')]]) { const button = root.ownerDocument.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.dataset.tocMoveIndex = String(index); button.dataset.tocMoveDelta = String(delta); button.disabled = index + delta < 0 || index + delta >= book.chapters.length; button.textContent = textValue; controls.append(button); } const path = root.ownerDocument.createElement('small'); path.textContent = item.path; row.append(label, controls, path); editor.append(row); const option = root.ownerDocument.createElement('option'); option.value = String(index); option.textContent = `${index + 1}. ${item.title}`; chapter.append(option); });
    root.querySelector('[data-toc-heading]').hidden = !book.chapters.length;
  };
  root.querySelector('[data-open]').addEventListener('click', async () => {
    clearEpub();
    try {
      const file = checkedFile(root.querySelector('[data-file]').files[0], 128 * MiB, t, 'EPUB');
      const bytes = new Uint8Array(await file.arrayBuffer()); const entries = parseZipDirectory(bytes, { maximumFiles: 5000, maximumExpanded: 256 * MiB }); const entryMap = new Map(entries.map((entry) => [entry.name, entry])); const issues = [];
      const mimeEntry = entryMap.get('mimetype');
      if (!mimeEntry) issues.push(t('Missing mimetype entry.', 'Entrada mimetype ausente.'));
      else { if (utf8.decode(await extractZipEntry(bytes, mimeEntry)) !== 'application/epub+zip') issues.push(t('Invalid mimetype value.', 'Valor de mimetype inválido.')); if (entries[0] !== mimeEntry || mimeEntry.method !== 0) issues.push(t('The mimetype entry is not first and stored.', 'A entrada mimetype não está primeiro e sem compressão.')); }
      const containerEntry = entryMap.get('META-INF/container.xml'); if (!containerEntry) throw fail(t('META-INF/container.xml is missing.', 'META-INF/container.xml está ausente.'));
      const container = utf8.decode(await extractZipEntry(bytes, containerEntry)); const opfPathRaw = container.match(/<rootfile\b[^>]*full-path=["']([^"']+)["']/i)?.[1]; if (!opfPathRaw) throw fail(t('The EPUB container does not name a package document.', 'O contêiner EPUB não indica um documento de pacote.'));
      const opfPath = normalizeArchivePath(decodeXml(opfPathRaw)); const opfEntry = entryMap.get(opfPath); if (!opfEntry) throw fail(t('The EPUB package document is missing.', 'O documento de pacote EPUB está ausente.'));
      const opfXml = utf8.decode(await extractZipEntry(bytes, opfEntry)); const packageData = parseEpubPackage(opfXml); for (const field of ['title', 'creator', 'language', 'identifier', 'publisher', 'description']) root.querySelector(`[data-${field}]`).value = packageData.metadata[field] || '';
      if (!packageData.metadata.title) issues.push(t('Package title is missing.', 'O título do pacote está ausente.')); if (!packageData.metadata.identifier) issues.push(t('Package identifier is missing.', 'O identificador do pacote está ausente.'));
      const navigationDocuments = []; const seenNavigationPaths = new Set();
      for (const [, item] of packageData.manifest) {
        const properties = String(item.properties || '').split(/\s+/); const kind = properties.includes('nav') ? 'nav' : item['media-type'] === 'application/x-dtbncx+xml' ? 'ncx' : null; if (!kind) continue;
        let path; try { path = resolveArchiveRelative(opfPath, item.href); } catch (error) { issues.push(error.message); continue; } if (seenNavigationPaths.has(path)) continue; seenNavigationPaths.add(path); const entry = entryMap.get(path); if (!entry) { issues.push(t(`Navigation resource is missing: ${path}`, `Recurso de navegação ausente: ${path}`)); continue; }
        const xml = utf8.decode(await extractZipEntry(bytes, entry)); const parsed = parseEpubNavigation(xml, kind); const hrefByPath = new Map(); for (const navigationEntry of parsed.entries) { try { hrefByPath.set(resolveArchiveRelative(path, navigationEntry.href), navigationEntry); } catch (error) { issues.push(error.message); } } if (!parsed.entries.length) issues.push(t(`Navigation document has no readable entries: ${path}`, `Documento de navegação sem entradas legíveis: ${path}`)); navigationDocuments.push({ path, kind, xml, hrefByPath });
      }
      if (!navigationDocuments.length) issues.push(t('No editable EPUB3 navigation document or NCX table of contents was found; reading-order edits still work.', 'Nenhum documento de navegação EPUB3 ou sumário NCX editável foi encontrado; alterações da ordem de leitura ainda funcionam.'));
      const chapters = packageData.spine.map((id) => ({ id, item: packageData.manifest.get(id) })).filter((entry) => entry.item).map((entry) => ({ id: entry.id, title: entry.item.href, path: resolveArchiveRelative(opfPath, entry.item.href), mediaType: entry.item['media-type'] || '' }));
      for (const id of packageData.spine) if (!packageData.manifest.has(id)) issues.push(t(`Spine reference is missing from manifest: ${id}`, `Referência da ordem ausente do manifesto: ${id}`)); for (const item of chapters) { if (!entryMap.has(item.path)) issues.push(t(`Manifest resource is missing: ${item.path}`, `Recurso do manifesto ausente: ${item.path}`)); for (const document of navigationDocuments) { const match = document.hrefByPath.get(item.path); if (match?.title) { item.title = match.title; break; } } }
      book = { file, bytes, entries, entryMap, mimeEntry, opfPath, opfXml, packageData, chapters, navigationDocuments, issues }; renderTocEditor(); chapter.hidden = false; root.querySelector('[data-chapter-label]').hidden = false; outputElement.hidden = false; root.querySelector('[data-empty]').hidden = true; root.querySelector('[data-save]').disabled = false; root.querySelector('[data-release]').disabled = false; const list = root.querySelector('[data-issues]'); issues.forEach((issue) => { const item = root.ownerDocument.createElement('li'); item.textContent = issue; list.append(item); }); metricGrid(root, [[t('Spine items', 'Itens na ordem'), chapters.length], [t('Navigation documents', 'Documentos de navegação'), navigationDocuments.length], [t('Archive entries', 'Entradas do arquivo'), entries.length], [t('Validation issues', 'Problemas de validação'), issues.length], [t('Input', 'Entrada'), formatBytes(file.size)]]); await renderChapter(); setStatus(status, issues.length ? t(`EPUB opened with ${issues.length} validation issue(s).`, `EPUB aberto com ${issues.length} problema(s) de validação.`) : t('EPUB structure and navigation validated locally.', 'Estrutura e navegação EPUB validadas localmente.'), issues.length ? 'warning' : 'success');
    } catch (error) { clearEpub(); setStatus(status, renderError(error, t, 'Could not open the EPUB'), 'error'); }
  });
  chapter.addEventListener('change', renderChapter);
  root.querySelector('[data-toc-editor]').addEventListener('change', (event) => { const input = event.target.closest('[data-toc-title-index]'); if (!input || !book) return; const value = input.value.trim(); if (!value) { input.value = book.chapters[Number(input.dataset.tocTitleIndex)].title; setStatus(status, t('Chapter titles cannot be empty.', 'Os títulos dos capítulos não podem ficar vazios.'), 'error'); return; } book.chapters[Number(input.dataset.tocTitleIndex)].title = value; output = null; root.querySelector('[data-download]').hidden = true; renderTocEditor(); setStatus(status, t('Chapter title updated in the local edit model.', 'Título do capítulo atualizado no modelo local de edição.'), 'success'); });
  root.querySelector('[data-toc-editor]').addEventListener('click', async (event) => { const button = event.target.closest('[data-toc-move-index]'); if (!button || !book) return; const index = Number(button.dataset.tocMoveIndex); const target = index + Number(button.dataset.tocMoveDelta); [book.chapters[index], book.chapters[target]] = [book.chapters[target], book.chapters[index]]; output = null; root.querySelector('[data-download]').hidden = true; renderTocEditor(); chapter.value = String(target); await renderChapter(); setStatus(status, t('Reading order updated in the local edit model.', 'Ordem de leitura atualizada no modelo local de edição.'), 'success'); });
  root.querySelector('[data-save]').addEventListener('click', async () => {
    output = null; root.querySelector('[data-download]').hidden = true; progress.hidden = false;
    try {
      const updates = Object.fromEntries(['title', 'creator', 'language', 'identifier', 'publisher', 'description'].map((field) => [field, root.querySelector(`[data-${field}]`).value])); if (!updates.title.trim() || !updates.identifier.trim()) throw fail(t('Title and identifier are required for export.', 'Título e identificador são obrigatórios para exportar.')); if (book.chapters.some((item) => !item.title.trim())) throw fail(t('Every chapter needs a non-empty TOC title.', 'Cada capítulo precisa de um título de sumário não vazio.'));
      let opfXml = updateEpubMetadata(book.opfXml, updates); opfXml = updateEpubReadingOrder(opfXml, book.chapters.map((item) => item.id)); const replacements = new Map([[book.opfPath, encoder.encode(opfXml)]]);
      for (const document of book.navigationDocuments) { const navigationEntries = book.chapters.map((item) => ({ title: item.title, href: document.hrefByPath.get(item.path)?.href || makeArchiveRelativeHref(document.path, item.path) })); replacements.set(document.path, encoder.encode(updateEpubNavigation(document.xml, navigationEntries, document.kind))); }
      const files = []; let retained = 0; const ordered = [book.entryMap.get('mimetype'), ...book.entries.filter((entry) => entry.name !== 'mimetype')].filter(Boolean); progress.max = ordered.length;
      for (let index = 0; index < ordered.length; index += 1) { const entry = ordered[index]; const data = entry.directory ? new Uint8Array() : replacements.get(entry.name) || await extractZipEntry(book.bytes, entry); retained += data.length; if (retained > 240 * MiB) throw fail(t('Expanded EPUB exceeds the 240 MiB repackaging cap.', 'O EPUB expandido excede o limite de reempacotamento de 240 MiB.')); files.push({ name: entry.name, data }); progress.value = index + 1; }
      const bytes = createZip(files); if (bytes.length > 256 * MiB) throw fail(t('Edited EPUB exceeds the 256 MiB output cap.', 'O EPUB editado excede o limite de saída de 256 MiB.')); output = new Blob([bytes], { type: 'application/epub+zip' }); root.querySelector('[data-download]').hidden = false; metricGrid(root, [[t('Spine items', 'Itens na ordem'), book.chapters.length], [t('TOC documents updated', 'Documentos de sumário atualizados'), book.navigationDocuments.length], [t('Archive entries', 'Entradas do arquivo'), book.entries.length], [t('Output', 'Saída'), formatBytes(output.size)], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('Metadata, reading order, and available TOC documents were repackaged locally.', 'Metadados, ordem de leitura e documentos de sumário disponíveis foram reempacotados localmente.'), 'success');
    } catch (error) { setStatus(status, renderError(error, t, 'Could not save the EPUB'), 'error'); } finally { progress.hidden = true; }
  });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, `${stem(book?.file.name, 'book')}.edited.epub`); });
  function clearEpub() { book = null; output = null; chapter.replaceChildren(); chapter.hidden = true; root.querySelector('[data-chapter-label]').hidden = true; root.querySelector('[data-toc-editor]').replaceChildren(); root.querySelector('[data-toc-heading]').hidden = true; outputElement.textContent = ''; outputElement.hidden = true; root.querySelector('[data-download]').hidden = true; root.querySelector('[data-save]').disabled = true; root.querySelector('[data-release]').disabled = true; root.querySelector('[data-issues]').replaceChildren(); root.querySelector('[data-empty]').hidden = false; metricGrid(root, []); }
  root.querySelector('[data-release]').addEventListener('click', () => { clearEpub(); setStatus(status, t('EPUB data and output released.', 'Dados e saída EPUB liberados.'), 'success'); }); attachCleanup(root, clearEpub);
}

function mountPublishingStudio({ root, t, pt }) {
  const sample = pt ? '# Meu documento\n\nEscreva em **Markdown** ou selecione LaTeX leve.\n\n- Prévia local\n- HTML autocontido\n- Impressão em PDF' : '# My document\n\nWrite in **Markdown** or select lightweight LaTeX.\n\n- Local preview\n- Self-contained HTML\n- Print to PDF';
  root.innerHTML = commonLayout(t, 'Publish Markdown or lightweight LaTeX', 'Publicar Markdown ou LaTeX leve', 'Safe HTML preview', 'Prévia HTML segura', `
    <div class="field-grid"><label><span class="field-label">${t('Source format', 'Formato da fonte')}</span><select data-mode><option value="markdown">Markdown</option><option value="latex">${t('Lightweight LaTeX', 'LaTeX leve')}</option></select></label><label><span class="field-label">${t('Document title', 'Título do documento')}</span><input class="text-input" value="${t('Local publication', 'Publicação local')}" maxlength="300" data-title></label></div><label class="field-label" for="publishing-source">${t('Source', 'Fonte')}</label><textarea class="code-input" id="publishing-source" rows="24" spellcheck="false" data-source>${escapeHtml(sample)}</textarea><button class="button button-primary" type="button" data-render>${t('Render preview', 'Renderizar prévia')}</button>
    <div class="notice-card"><strong>${t('Supported publishing subset', 'Subconjunto de publicação compatível')}</strong><p>${t('Markdown supports headings, lists, links, images, quotes, emphasis, and fenced code. Lightweight LaTeX supports sections, emphasis, links, lists, and visibly preserved math source; it is not a TeX engine.', 'Markdown aceita títulos, listas, links, imagens, citações, ênfase e blocos de código. LaTeX leve aceita seções, ênfase, links, listas e preserva visualmente a fonte matemática; não é um motor TeX.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Publication preview', 'Prévia da publicação')}</h2><button class="text-button" type="button" data-clear>${t('Clear preview', 'Limpar prévia')}</button></div><div class="metric-grid" data-metrics></div><iframe title="${t('Rendered document preview', 'Prévia do documento renderizado')}" sandbox="allow-modals" style="display:block;width:100%;min-height:36rem;border:1px solid var(--line)" data-preview></iframe><div class="field-grid"><button class="button button-secondary" type="button" disabled data-download>${t('Download HTML', 'Baixar HTML')}</button><button class="button button-secondary" type="button" disabled data-pdf>${t('Download PDF', 'Baixar PDF')}</button><button class="button button-secondary" type="button" disabled data-print>${t('Print / Save styled PDF', 'Imprimir / salvar PDF estilizado')}</button></div>`);
  const status = root.querySelector('[data-status]'); const preview = root.querySelector('[data-preview]'); let html = '';
  const render = () => { try { const source = root.querySelector('[data-source]').value; if (source.length > MAX_TEXT_CHARS) throw fail(t('Source exceeds the four-million-character cap.', 'A fonte excede o limite de quatro milhões de caracteres.')); const body = renderPublication(source, root.querySelector('[data-mode]').value); html = selfContainedPublication(root.querySelector('[data-title]').value || t('Untitled', 'Sem título'), body, pt ? 'pt-BR' : 'en'); preview.srcdoc = html; root.querySelector('[data-download]').disabled = false; root.querySelector('[data-pdf]').disabled = source.length > 500_000; root.querySelector('[data-print]').disabled = false; metricGrid(root, [[t('Source characters', 'Caracteres da fonte'), source.length.toLocaleString()], [t('Rendered HTML', 'HTML renderizado'), formatBytes(encoder.encode(html).length)], [t('Direct PDF', 'PDF direto'), source.length <= 500_000 ? t('Available', 'Disponível') : t('500,000-character limit', 'Limite de 500.000 caracteres')], [t('Uploads', 'Uploads'), '0']]); setStatus(status, t('Safe local preview rendered.', 'Prévia local segura renderizada.'), 'success'); } catch (error) { setStatus(status, renderError(error, t, 'Could not render the publication'), 'error'); } };
  root.querySelector('[data-render]').addEventListener('click', render); root.querySelector('[data-download]').addEventListener('click', () => { if (html) downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${stem(root.querySelector('[data-title]').value, 'publication')}.html`); }); root.querySelector('[data-pdf]').addEventListener('click', async () => { if (!html) return; const button = root.querySelector('[data-pdf]'); button.disabled = true; try { setStatus(status, t('Building the PDF entirely in this tab…', 'Criando o PDF inteiramente nesta aba…')); const PDFLib = await pdfRuntime(); const bytes = await buildPublicationPdf(root.querySelector('[data-source]').value, { mode: root.querySelector('[data-mode]').value, title: root.querySelector('[data-title]').value || t('Untitled', 'Sem título'), language: pt ? 'pt-BR' : 'en', PDFLib }); downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${stem(root.querySelector('[data-title]').value, 'publication')}.pdf`); setStatus(status, t('A real local PDF was generated and downloaded.', 'Um PDF local real foi gerado e baixado.'), 'success'); } catch (error) { setStatus(status, renderError(error, t, 'Could not build the PDF'), 'error'); } finally { button.disabled = root.querySelector('[data-source]').value.length > 500_000 || !html; } }); root.querySelector('[data-print]').addEventListener('click', () => { if (!html) return; const frameWindow = preview.contentWindow; if (!frameWindow) { setStatus(status, t('Preview printing is unavailable.', 'A impressão da prévia não está disponível.'), 'error'); return; } frameWindow.focus(); frameWindow.print(); setStatus(status, t('The browser print dialog can save this document as a styled PDF.', 'A janela de impressão do navegador pode salvar este documento como PDF estilizado.'), 'success'); }); root.querySelector('[data-clear]').addEventListener('click', () => { html = ''; preview.srcdoc = ''; root.querySelector('[data-download]').disabled = true; root.querySelector('[data-pdf]').disabled = true; root.querySelector('[data-print]').disabled = true; metricGrid(root, []); setStatus(status, t('Preview cleared.', 'Prévia limpa.'), 'success'); }); render();
}

function archiveKind(file, bytes) {
  const name = file.name.toLowerCase(); const signature = bytes.length >= 4 ? readU32(bytes, 0) : 0; const begins = (...values) => values.every((value, index) => bytes[index] === value);
  if (signature === 0x04034b50 || signature === 0x06054b50 || name.endsWith('.zip')) return 'zip';
  if (begins(0x1f, 0x8b)) return 'gzip';
  if (begins(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) || name.endsWith('.7z')) return '7z';
  if (begins(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) || /\.(?:xz|txz|lzma|tlz)$/i.test(name)) return 'xz/lzma';
  if (latin1.decode(bytes.subarray(257, 262)) === 'ustar' || name.endsWith('.tar')) return 'tar';
  return 'libarchive';
}

function mountArchiveManager({ root, t }) {
  root.innerHTML = commonLayout(t, 'Open or create an archive', 'Abrir ou criar um arquivo', 'ZIP · 7z · TAR.XZ', 'ZIP · 7z · TAR.XZ', `
    <label class="field-label" for="archive-open-file">${t('Archive to inspect', 'Arquivo para inspecionar')}</label><input class="file-input" id="archive-open-file" type="file" accept=".zip,.tar,.gz,.tgz,.7z,.xz,.txz,.lzma,.tlz,.rar,.cab,.bz2,.tbz2,application/zip,application/gzip" data-archive><button class="button button-primary" type="button" data-open>${t('Open archive', 'Abrir arquivo')}</button>
    <hr><label class="field-label" for="archive-create-files">${t('Files for a new archive', 'Arquivos para novo pacote')}</label><input class="file-input" id="archive-create-files" type="file" multiple data-files><div class="field-grid"><label><span class="field-label">${t('Output format', 'Formato de saída')}</span><select data-format><option value="zip">ZIP Deflate</option><option value="zip-store">ZIP (${t('store mode', 'modo armazenado')})</option><option value="tar">TAR</option><option value="tgz">TAR.GZ</option><option value="7z">7z (7-Zip WASM)</option><option value="txz">TAR.XZ (7-Zip WASM)</option></select></label><button class="button button-secondary" type="button" data-create>${t('Create archive', 'Criar arquivo')}</button></div><progress class="workbench-progress" max="1" value="0" hidden data-progress></progress>
    <div class="notice-card"><strong>${t('Validated pure paths plus local archive runtimes', 'Caminhos puros validados e runtimes locais de arquivos')}</strong><p>${t('ZIP, TAR, GZIP, and TAR.GZ use tested JavaScript paths. Lazy site-hosted WASM runtimes provide genuine 7z and TAR.XZ creation plus 7z, XZ/LZMA-compressed TAR, RAR, and other libarchive-supported extraction. Encryption, links, devices, traversal paths, standalone raw XZ streams, and oversized entries are rejected.', 'ZIP, TAR, GZIP e TAR.GZ usam caminhos JavaScript testados. Runtimes WASM hospedados no site e carregados sob demanda fornecem criação real de 7z e TAR.XZ, além de extração de 7z, TAR comprimido com XZ/LZMA, RAR e outros formatos aceitos pelo libarchive. Criptografia, links, dispositivos, caminhos de travessia, fluxos XZ brutos isolados e entradas grandes demais são recusados.')}</p></div>`, `
    <div class="workbench-section-heading"><h2>${t('Archive entries', 'Entradas do arquivo')}</h2><button class="text-button" type="button" disabled data-release>${t('Release archive', 'Liberar arquivo')}</button></div><div class="metric-grid" data-metrics></div><div class="table-scroll" hidden data-table-wrap><table class="data-table"><caption>${t('Validated safe paths', 'Caminhos seguros validados')}</caption><thead><tr><th>${t('Path', 'Caminho')}</th><th>${t('Size', 'Tamanho')}</th><th>${t('Method', 'Método')}</th><th>${t('Action', 'Ação')}</th></tr></thead><tbody data-entries></tbody></table></div><button class="button button-secondary" type="button" hidden data-download-created>${t('Download created archive', 'Baixar arquivo criado')}</button><div class="empty-result" data-empty><p>${t('Entry paths are normalized and traversal paths are rejected before extraction.', 'Os caminhos são normalizados e caminhos de travessia são recusados antes da extração.')}</p></div>`);
  const status = root.querySelector('[data-status]'); const progress = root.querySelector('[data-progress]'); let opened = null; let created = null; let createdName = '';
  const renderEntries = () => { const body = root.querySelector('[data-entries]'); body.replaceChildren(); if (!opened) { root.querySelector('[data-table-wrap]').hidden = true; root.querySelector('[data-empty]').hidden = false; root.querySelector('[data-release]').disabled = !created; metricGrid(root, []); return; } opened.entries.forEach((entry, index) => { const row = root.ownerDocument.createElement('tr'); for (const value of [entry.name, formatBytes(entry.size), entry.methodLabel]) { const cell = root.ownerDocument.createElement('td'); cell.textContent = value; row.append(cell); } const action = root.ownerDocument.createElement('td'); if (!entry.directory) { const button = root.ownerDocument.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.dataset.entryIndex = String(index); button.textContent = t('Extract', 'Extrair'); action.append(button); } else action.textContent = t('Directory', 'Diretório'); row.append(action); body.append(row); }); root.querySelector('[data-table-wrap]').hidden = !opened.entries.length; root.querySelector('[data-empty]').hidden = !!opened.entries.length; root.querySelector('[data-release]').disabled = false; metricGrid(root, [[t('Format', 'Formato'), opened.kind.toUpperCase()], [t('Entries', 'Entradas'), opened.entries.length], [t('Expanded size', 'Tamanho expandido'), formatBytes(opened.entries.reduce((sum, entry) => sum + entry.size, 0))], [t('Uploads', 'Uploads'), '0']]); };
  root.querySelector('[data-open]').addEventListener('click', async () => {
    opened = null;
    try {
      const file = checkedFile(root.querySelector('[data-archive]').files[0], MAX_ARCHIVE_BYTES, t, t('archive', 'arquivo')); const source = new Uint8Array(await file.arrayBuffer()); const kind = archiveKind(file, source);
      if (kind === 'zip') { const entries = parseZipDirectory(source).map((entry) => ({ ...entry, methodLabel: entry.directory ? '—' : entry.method === 0 ? t('Stored', 'Armazenado') : 'Deflate' })); opened = { file, kind, bytes: source, entries }; }
      else if (kind === 'tar') { const entries = parseTar(source).map((entry) => ({ ...entry, methodLabel: 'TAR' })); opened = { file, kind, bytes: source, entries }; }
      else if (kind === 'gzip') {
        if (source.length < 18) throw fail(t('The GZIP stream is truncated.', 'O fluxo GZIP está truncado.')); const expectedSize = readU32(source, source.length - 4); const decompressed = await decompressBytes(source, 'gzip', { expectedSize, maximumSize: MAX_EXTRACTED_BYTES }); const innerTar = latin1.decode(decompressed.subarray(257, 262)) === 'ustar' || /\.(?:tar\.gz|tgz)$/i.test(file.name);
        if (innerTar) { const entries = parseTar(decompressed).map((entry) => ({ ...entry, methodLabel: 'TAR.GZ' })); opened = { file, kind: 'tar.gz', bytes: decompressed, entries }; }
        else { const name = normalizeArchivePath(file.name.replace(/\.gz$/i, '') || 'decompressed.bin'); opened = { file, kind: 'gzip', bytes: decompressed, entries: [{ name, size: decompressed.length, dataOffset: 0, directory: false, methodLabel: 'GZIP', gzipSingle: true }] }; }
      } else {
        setStatus(status, t('Loading the local libarchive runtime and validating entries…', 'Carregando o runtime libarchive local e validando as entradas…'));
        const inspected = await inspectLibarchive(source); const entries = inspected.entries.map((entry) => ({ ...entry, methodLabel: 'libarchive' })); opened = { file, kind, backend: 'libarchive', bytes: source, entries, version: inspected.version };
      }
      renderEntries(); setStatus(status, opened.backend === 'libarchive' ? t(`Archive validated with ${opened.version}.`, `Arquivo validado com ${opened.version}.`) : t('Archive opened and paths validated locally.', 'Arquivo aberto e caminhos validados localmente.'), 'success');
    } catch (error) { opened = null; renderEntries(); setStatus(status, renderError(error, t, 'Could not open the archive'), 'error'); }
  });
  root.querySelector('[data-entries]').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-entry-index]'); if (!button || !opened) return; const entry = opened.entries[Number(button.dataset.entryIndex)];
    try {
      let data; if (opened.backend === 'libarchive') { setStatus(status, t('Reopening locally with libarchive for bounded extraction…', 'Reabrindo localmente com libarchive para extração limitada…')); data = (await extractLibarchiveEntry(opened.bytes, entry.runtimeIndex)).data; }
      else if (opened.kind === 'zip') data = await extractZipEntry(opened.bytes, entry); else if (entry.gzipSingle) data = opened.bytes.slice(); else data = opened.bytes.slice(entry.dataOffset, entry.dataOffset + entry.size);
      downloadBlob(new Blob([data], { type: 'application/octet-stream' }), entry.name.split('/').pop() || 'extracted.bin'); setStatus(status, t(`Extracted ${entry.name} after integrity and path checks.`, `${entry.name} extraído após verificações de integridade e caminho.`), 'success');
    } catch (error) { setStatus(status, renderError(error, t, 'Could not extract the entry'), 'error'); }
  });
  root.querySelector('[data-create]').addEventListener('click', async () => {
    created = null; root.querySelector('[data-download-created]').hidden = true;
    const files = [...root.querySelector('[data-files]').files];
    if (!files.length || files.length > MAX_ARCHIVE_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_ARCHIVE_BYTES) { setStatus(status, t('Choose 1–2,000 files totaling at most 256 MiB.', 'Escolha de 1 a 2.000 arquivos totalizando no máximo 256 MiB.'), 'error'); return; }
    progress.hidden = false; progress.max = files.length;
    try {
      const records = []; let retained = 0; const names = new Set();
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]; const data = new Uint8Array(await file.arrayBuffer()); retained += data.length;
        if (retained > MAX_ARCHIVE_BYTES) throw fail(t('Retained input exceeds 256 MiB.', 'A entrada retida excede 256 MiB.'));
        const name = normalizeArchivePath(file.webkitRelativePath || file.name);
        if (names.has(name)) throw fail(t(`Duplicate archive path: ${name}`, `Caminho duplicado no arquivo: ${name}`));
        names.add(name); records.push({ name, data }); progress.value = index + 1;
      }
      const format = root.querySelector('[data-format]').value; let bytes;
      if (format === 'zip') { const { zipSync } = await import('/vendor/suite/fflate.js'); bytes = zipSync(Object.fromEntries(records.map((record) => [record.name, record.data])), { level: 6 }); }
      else if (format === 'zip-store') bytes = createZip(records);
      else if (format === '7z' || format === 'txz') {
        setStatus(status, t('Loading the site-hosted 7-Zip runtime and creating the archive locally…', 'Carregando o runtime 7-Zip hospedado no site e criando o arquivo localmente…'));
        bytes = (await createSevenZipArchive(records, format)).bytes;
      } else { bytes = createTar(records); if (format === 'tgz') bytes = await compressBytes(bytes, 'gzip'); }
      if (bytes.length > 320 * MiB) throw fail(t('Created archive exceeds the 320 MiB output cap.', 'O arquivo criado excede o limite de saída de 320 MiB.'));
      const output = {
        zip: ['application/zip', 'local-archive.zip'], 'zip-store': ['application/zip', 'local-archive.zip'],
        tar: ['application/x-tar', 'local-archive.tar'], tgz: ['application/gzip', 'local-archive.tar.gz'],
        '7z': ['application/x-7z-compressed', 'local-archive.7z'], txz: ['application/x-xz', 'local-archive.tar.xz']
      }[format];
      if (!output) throw fail(t('Choose a supported output format.', 'Escolha um formato de saída compatível.'));
      created = new Blob([bytes], { type: output[0] }); createdName = output[1];
      root.querySelector('[data-download-created]').hidden = false; root.querySelector('[data-release]').disabled = false;
      metricGrid(root, [[t('Created format', 'Formato criado'), format.toUpperCase()], [t('Files', 'Arquivos'), files.length], [t('Input', 'Entrada'), formatBytes(retained)], [t('Output', 'Saída'), formatBytes(created.size)]]);
      setStatus(status, t('Archive created locally.', 'Arquivo criado localmente.'), 'success');
    } catch (error) { setStatus(status, renderError(error, t, 'Could not create the archive'), 'error'); }
    finally { progress.hidden = true; }
  });
  root.querySelector('[data-download-created]').addEventListener('click', () => { if (created) downloadBlob(created, createdName); }); const clear = () => { opened = null; created = null; createdName = ''; root.querySelector('[data-entries]').replaceChildren(); root.querySelector('[data-table-wrap]').hidden = true; root.querySelector('[data-download-created]').hidden = true; root.querySelector('[data-empty]').hidden = false; root.querySelector('[data-release]').disabled = true; metricGrid(root, []); }; root.querySelector('[data-release]').addEventListener('click', () => { clear(); setStatus(status, t('Archive buffers released.', 'Buffers do arquivo liberados.'), 'success'); }); attachCleanup(root, clear);
}
