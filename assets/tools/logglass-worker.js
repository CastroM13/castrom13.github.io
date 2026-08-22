import { redactLogLine } from './logglass-redaction.js';

let cancelled = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { cancelled = true; return; }
  if (data.type !== 'scan') return;
  cancelled = false;
  try { await scan(data.file, data.options); }
  catch (error) { self.postMessage({ type: 'error', message: error.message || String(error) }); }
};

async function scan(file, options) {
  let matcher = null;
  if (options.query) {
    if (options.regex) {
      if (options.query.length > 256) throw new Error('Regular expressions are limited to 256 characters.');
      matcher = new RegExp(options.query, options.caseSensitive ? '' : 'i');
    } else {
      const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
      matcher = (line) => (options.caseSensitive ? line : line.toLowerCase()).includes(needle);
    }
  }
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  let carry = ''; let discardingOversizedLine = false; let bytes = 0; let lines = 0; let matches = 0; let oversized = 0; let omitted = 0;
  let lastProgress = 0; let exportBytes = 0; let exportTooLarge = false;
  const preview = []; const exportChunks = []; const levels = new Map(); const statuses = new Map(); const formats = { json: 0, text: 0 };
  const processLine = (raw, forcedOversized = false) => {
    lines += 1;
    if (forcedOversized || raw.length > 1_048_576) { raw = `${raw.slice(0, 1_048_576)}…[TRUNCATED]`; oversized += 1; }
    let parsed = null;
    try { const value = JSON.parse(raw); if (value && typeof value === 'object' && !Array.isArray(value)) { parsed = value; formats.json += 1; } else formats.text += 1; } catch (_) { formats.text += 1; }
    const level = inferLevel(raw, parsed); levels.set(level, (levels.get(level) || 0) + 1);
    const httpStatus = inferStatus(raw, parsed); if (httpStatus) statuses.set(httpStatus, (statuses.get(httpStatus) || 0) + 1);
    let accepted = !matcher;
    if (matcher instanceof RegExp) { matcher.lastIndex = 0; accepted = matcher.test(raw.slice(0, 65_536)); }
    else if (typeof matcher === 'function') accepted = matcher(raw);
    if (!accepted || (options.level !== 'ALL' && level !== options.level)) return;
    matches += 1;
    const safe = redactLogLine(raw, options);
    if (preview.length < 5_000) preview.push({ line: lines, level, text: safe.slice(0, 16_384) }); else omitted += 1;
    const chunk = `${safe}\n`;
    exportBytes += new TextEncoder().encode(chunk).byteLength;
    if (!exportTooLarge && exportBytes <= 100 * 1024 * 1024) exportChunks.push(chunk);
    else { exportTooLarge = true; exportChunks.length = 0; }
  };

  while (true) {
    if (cancelled) { reader.cancel(); self.postMessage({ type: 'cancelled' }); return; }
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    let decoded = decoder.decode(value, { stream: true });
    if (discardingOversizedLine) {
      const boundary = decoded.search(/[\r\n]/);
      if (boundary < 0) continue;
      processLine(carry, true);
      const separatorLength = decoded[boundary] === '\r' && decoded[boundary + 1] === '\n' ? 2 : 1;
      decoded = decoded.slice(boundary + separatorLength);
      carry = '';
      discardingOversizedLine = false;
    }
    carry += decoded;
    const drained = drainLines(carry, false); carry = drained.carry;
    for (const line of drained.lines) processLine(line);
    if (carry.length > 1_048_576) { carry = carry.slice(0, 1_048_576); discardingOversizedLine = true; }
    const now = performance.now();
    if (now - lastProgress > 250) { self.postMessage({ type: 'progress', bytes, total: file.size, lines }); lastProgress = now; }
  }
  if (discardingOversizedLine) processLine(carry, true);
  else {
    carry += decoder.decode();
    const drained = drainLines(carry, true);
    for (const line of drained.lines) processLine(line);
    if (drained.carry) processLine(drained.carry);
  }
  self.postMessage({ type: 'complete', summary: { bytes, lines, matches, omitted, oversized, levels: Object.fromEntries(levels), statuses: Object.fromEntries(statuses), formats, exportTooLarge }, preview, exportText: exportTooLarge || oversized ? null : exportChunks.join('') });
}

function drainLines(value, final) {
  const lines = []; let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\n') { lines.push(value.slice(start, index)); start = index + 1; continue; }
    if (character !== '\r') continue;
    if (index + 1 >= value.length && !final) break;
    lines.push(value.slice(start, index));
    if (value[index + 1] === '\n') index += 1;
    start = index + 1;
  }
  return { lines, carry: value.slice(start) };
}

function inferLevel(line, object) {
  const candidate = object?.level ?? object?.severity ?? object?.['log.level'];
  const text = String(candidate || line.match(/\b(?:TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/i)?.[0] || 'OTHER').toUpperCase();
  if (text === 'WARNING') return 'WARN';
  if (text === 'CRITICAL') return 'FATAL';
  return ['TRACE', 'DEBUG', 'INFO', 'NOTICE', 'WARN', 'ERROR', 'FATAL'].includes(text) ? text : 'OTHER';
}

function inferStatus(line, object) {
  const value = Number(object?.status ?? object?.statusCode ?? object?.['http.status_code'] ?? line.match(/\b[1-5]\d\d\b/)?.[0]);
  return value >= 100 && value <= 599 ? `${Math.floor(value / 100)}xx` : null;
}
