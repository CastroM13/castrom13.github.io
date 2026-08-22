export function context(key) {
  const root = document.querySelector(`[data-tool-root="${key}"]`);
  if (!root) return null;
  const pt = root.dataset.language === 'pt-BR';
  return { root, pt, t: (en, portuguese) => pt ? portuguese : en };
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = -1;
  do { size /= 1024; unit += 1; } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1) return `${milliseconds.toFixed(3)} ms`;
  if (milliseconds < 100) return `${milliseconds.toFixed(2)} ms`;
  if (milliseconds < 1000) return `${milliseconds.toFixed(1)} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

export function percentile(values, fraction) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function downloadJson(value, filename) {
  downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), filename);
}

export function setStatus(element, message, kind = 'neutral') {
  element.textContent = message;
  element.dataset.kind = kind;
}

export function createCell(row, value, tag = 'td') {
  const cell = document.createElement(tag);
  cell.textContent = String(value ?? '—');
  row.append(cell);
  return cell;
}

export function mask(value, visible = 4) {
  const text = String(value ?? '');
  if (!text) return '—';
  if (text.length <= visible * 2) return '•'.repeat(Math.min(text.length, 12));
  return `${text.slice(0, visible)}…${text.slice(-visible)}`;
}

export function isProbablySensitiveKey(key) {
  return /(?:authorization|cookie|token|secret|pass(?:word)?|api[_-]?key|private|credential|session|signature|client[_-]?secret|access[_-]?key)/i.test(String(key));
}

export function deepRedact(value, path = [], sensitivePaths = new Set()) {
  const pathKey = path.join('.');
  if (sensitivePaths.has(pathKey) || (path.length && isProbablySensitiveKey(path.at(-1)))) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item, index) => deepRedact(item, [...path, String(index)], sensitivePaths));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepRedact(item, [...path, key], sensitivePaths)]));
  }
  return value;
}

export async function sha256(fileOrBuffer) {
  const buffer = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function entropy(text) {
  if (!text) return 0;
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) || 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

export function base64UrlBytes(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function base64UrlJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
}

export function loadScript(src, globalName) {
  if (globalName && globalThis[globalName]) return Promise.resolve(globalThis[globalName]);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-lazy-src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(globalName ? globalThis[globalName] : true), { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.dataset.lazySrc = src;
    script.onload = () => resolve(globalName ? globalThis[globalName] : true);
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

export function sanitizeFilename(value, fallback = 'export') {
  const clean = String(value).normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || fallback;
}

export function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function clearObjectUrls(urls) {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
}
