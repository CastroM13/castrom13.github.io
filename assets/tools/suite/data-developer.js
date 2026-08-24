/*
 * Data & developer workbenches (tools 27-39).
 *
 * This module deliberately has no top-level DOM lookup. The suite router passes
 * an app context to mountTool(), which keeps the pure parsers usable in Node.
 */

export const toolKeys = Object.freeze([
  'file-inspector',
  'file-deduplicator',
  'encryption-vault',
  'sqlite-workbench',
  'duckdb-studio',
  'data-converter',
  'bi-dashboard',
  'data-notebook',
  'regex-workbench',
  'git-client',
  'binary-diff',
  'code-playground',
  'packet-analyzer'
]);

const KiB = 1024;
const MiB = KiB ** 2;
const GiB = KiB ** 3;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const mountedCleanups = new WeakMap();
const runtimePromises = new Map();

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected an ArrayBuffer or byte view.');
}

function matches(bytes, offset, expected) {
  return offset >= 0 && offset + expected.length <= bytes.length && expected.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes, start = 0, end = bytes.length) {
  const limit = Math.min(end, bytes.length);
  let output = '';
  // Spreading a long typed array over String.fromCharCode overflows the JS
  // argument stack. Binary strings can legitimately span the whole sample, so
  // decode them in bounded chunks instead.
  for (let cursor = start; cursor < limit; cursor += 32 * KiB) {
    output += String.fromCharCode(...bytes.subarray(cursor, Math.min(cursor + 32 * KiB, limit)));
  }
  return output;
}

function safeName(value, fallback = 'export') {
  const clean = String(value || '').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || fallback;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < KiB) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let index = -1;
  do { amount /= KiB; index += 1; } while (amount >= KiB && index < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`;
}

function localPath(file) {
  return String(file.webkitRelativePath || file.name || 'unnamed').replaceAll('\\', '/');
}

export function normalizeVaultArchivePath(value) {
  const input = String(value || '').normalize('NFC').replaceAll('\\', '/');
  if (!input || input.length > 4_096 || /[\0-\x1f\x7f]/.test(input)) throw new Error('Archive path is missing, too long, or contains control characters.');
  const parts = input.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) throw new Error(`Unsafe archive path: ${input}`);
  const normalized = parts.join('/');
  if (textEncoder.encode(normalized).length > 4_096) throw new Error(`Archive path is too long: ${input}`);
  return normalized;
}

function status(element, message, kind = 'neutral') {
  element.textContent = message;
  element.dataset.kind = kind;
}

function downloadBytes(root, value, filename, type = 'application/octet-stream') {
  const doc = root.ownerDocument;
  const blob = value instanceof Blob ? value : new Blob([value], { type });
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = safeName(filename);
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function renderMetrics(root, values) {
  const target = root.querySelector('[data-metrics]');
  const doc = root.ownerDocument;
  target.replaceChildren(...values.map(([label, value]) => {
    const item = doc.createElement('div');
    const span = doc.createElement('span');
    const strong = doc.createElement('strong');
    span.textContent = label;
    strong.textContent = String(value);
    item.append(span, strong);
    return item;
  }));
}

function renderTable(body, rows) {
  const doc = body.ownerDocument;
  body.replaceChildren(...rows.map((values) => {
    const row = doc.createElement('tr');
    for (const value of values) {
      const cell = doc.createElement('td');
      cell.textContent = String(value ?? '—');
      row.append(cell);
    }
    return row;
  }));
}

function toggleResult(root, visible) {
  const output = root.querySelector('[data-output]');
  const empty = root.querySelector('[data-empty]');
  if (output) output.hidden = !visible;
  if (empty) empty.hidden = visible;
}

function shell({ root, t }, { key, title, titlePt, badge, badgePt, results, resultsPt, controls, output, empty, emptyPt, action = '', actionPt = '' }) {
  root.innerHTML = `<div class="workbench-layout">
    <form class="workbench-controls" data-form>
      <div class="workbench-section-heading"><h2>${t(title, titlePt)}</h2><span>${t(badge, badgePt)}</span></div>
      ${controls}
      <p class="workbench-status" role="status" aria-live="polite" data-status></p>
    </form>
    <section class="workbench-results" aria-labelledby="${key}-results-title">
      <div class="workbench-section-heading"><h2 id="${key}-results-title" tabindex="-1">${t(results, resultsPt)}</h2>${action ? `<button class="text-button" type="button" disabled data-download>${t(action, actionPt)}</button>` : ''}</div>
      <div class="metric-grid" data-metrics></div>
      <section hidden data-output>${output}</section>
      <div class="empty-result" data-empty><p>${t(empty, emptyPt)}</p></div>
    </section>
  </div>`;
  return {
    form: root.querySelector('[data-form]'),
    status: root.querySelector('[data-status]'),
    download: root.querySelector('[data-download]')
  };
}

function makeCleanup(root) {
  const callbacks = [];
  return {
    add(callback) { callbacks.push(callback); },
    run() {
      for (const callback of callbacks.splice(0)) {
        try { callback(); } catch (_) { /* cleanup is best effort */ }
      }
      if (root.isConnected) root.replaceChildren();
    }
  };
}

async function readFileBytes(file, cap, label = 'File') {
  if (!file) throw new Error(`${label} is required.`);
  if (file.size > cap) throw new Error(`${label} exceeds the ${formatBytes(cap)} in-memory limit.`);
  return new Uint8Array(await file.arrayBuffer());
}

export function shannonEntropy(value) {
  const bytes = asBytes(value);
  if (!bytes.length) return 0;
  const counts = new Uint32Array(256);
  for (const byte of bytes) counts[byte] += 1;
  let result = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / bytes.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

export function detectFileType(value, filename = '') {
  const bytes = asBytes(value);
  const lower = String(filename).toLowerCase();
  const signature = (offset, values) => matches(bytes, offset, values);
  if (signature(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { id: 'png', label: 'PNG image', mime: 'image/png', confidence: 'signature' };
  if (signature(0, [0xff, 0xd8, 0xff])) return { id: 'jpeg', label: 'JPEG image', mime: 'image/jpeg', confidence: 'signature' };
  if (signature(0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return { id: 'gif', label: 'GIF image', mime: 'image/gif', confidence: 'signature' };
  if (signature(0, [0x52, 0x49, 0x46, 0x46]) && signature(8, [0x57, 0x45, 0x42, 0x50])) return { id: 'webp', label: 'WebP image', mime: 'image/webp', confidence: 'signature' };
  if (signature(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { id: 'pdf', label: 'PDF document', mime: 'application/pdf', confidence: 'signature' };
  if (signature(0, [0x50, 0x4b, 0x03, 0x04]) || signature(0, [0x50, 0x4b, 0x05, 0x06]) || signature(0, [0x50, 0x4b, 0x07, 0x08])) return { id: 'zip', label: 'ZIP archive', mime: 'application/zip', confidence: 'signature' };
  if (signature(0, [0x1f, 0x8b, 0x08])) return { id: 'gzip', label: 'Gzip stream', mime: 'application/gzip', confidence: 'signature' };
  if (signature(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { id: '7z', label: '7-Zip archive', mime: 'application/x-7z-compressed', confidence: 'signature' };
  if (signature(0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return { id: 'rar', label: 'RAR archive', mime: 'application/vnd.rar', confidence: 'signature' };
  if (signature(0, [0x7f, 0x45, 0x4c, 0x46])) return { id: 'elf', label: 'ELF executable', mime: 'application/x-elf', confidence: 'signature' };
  if (signature(0, [0x4d, 0x5a])) return { id: 'pe', label: 'DOS/PE executable', mime: 'application/vnd.microsoft.portable-executable', confidence: 'signature' };
  if (signature(0, [0x00, 0x61, 0x73, 0x6d])) return { id: 'wasm', label: 'WebAssembly module', mime: 'application/wasm', confidence: 'signature' };
  if (signature(0, [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])) return { id: 'sqlite', label: 'SQLite 3 database', mime: 'application/vnd.sqlite3', confidence: 'signature' };
  // The inspector intentionally receives only a leading sample for very large
  // files. PAR1 at the front is enough for type detection; full envelope
  // validation remains the responsibility of inspectParquetEnvelope().
  if (signature(0, [0x50, 0x41, 0x52, 0x31])) return { id: 'parquet', label: 'Apache Parquet', mime: 'application/vnd.apache.parquet', confidence: 'signature' };
  if (signature(0, [0xd4, 0xc3, 0xb2, 0xa1]) || signature(0, [0xa1, 0xb2, 0xc3, 0xd4]) || signature(0, [0x4d, 0x3c, 0xb2, 0xa1]) || signature(0, [0xa1, 0xb2, 0x3c, 0x4d])) return { id: 'pcap', label: 'PCAP capture', mime: 'application/vnd.tcpdump.pcap', confidence: 'signature' };
  if (signature(0, [0x0a, 0x0d, 0x0d, 0x0a])) return { id: 'pcapng', label: 'PCAP Next Generation capture', mime: 'application/x-pcapng', confidence: 'signature' };
  if (signature(0, [0xca, 0xfe, 0xba, 0xbe])) return { id: 'java', label: 'Java class / Mach-O universal', mime: 'application/octet-stream', confidence: 'signature' };

  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * KiB));
  let printable = 0;
  let nul = 0;
  for (const byte of sample) {
    if (byte === 0) nul += 1;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 0xc2) printable += 1;
  }
  if (sample.length && !nul && printable / sample.length > 0.88) {
    const decoded = textDecoder.decode(sample).replace(/^\uFEFF/, '').trimStart();
    if (/^[\[{]/.test(decoded)) {
      try { JSON.parse(textDecoder.decode(bytes)); return { id: 'json', label: 'JSON data', mime: 'application/json', confidence: 'content' }; } catch (_) { /* textual but not valid JSON */ }
    }
    if (/^<\?xml\b|^<[A-Za-z][\s\S]*>/.test(decoded)) return { id: 'xml', label: 'XML / markup text', mime: 'application/xml', confidence: 'content' };
    if (lower.endsWith('.csv')) return { id: 'csv', label: 'Delimited text (CSV)', mime: 'text/csv', confidence: 'extension+content' };
    return { id: 'text', label: 'Plain text', mime: 'text/plain', confidence: 'content' };
  }
  return { id: 'binary', label: 'Unknown binary', mime: 'application/octet-stream', confidence: 'fallback' };
}

export function extractAsciiStrings(value, minimumLength = 4, maxResults = 5_000) {
  const bytes = asBytes(value);
  if (!Number.isInteger(minimumLength) || minimumLength < 2 || minimumLength > 1_024) throw new RangeError('minimumLength must be between 2 and 1024.');
  const results = [];
  let start = -1;
  for (let index = 0; index <= bytes.length; index += 1) {
    const byte = bytes[index];
    const printable = index < bytes.length && (byte === 9 || (byte >= 32 && byte <= 126));
    if (printable && start < 0) start = index;
    if (!printable && start >= 0) {
      const length = index - start;
      if (length >= minimumLength) results.push({ offset: start, length, text: ascii(bytes, start, index).replaceAll('\t', '\\t') });
      start = -1;
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

export function makeHexRows(value, offset = 0, length = 512, width = 16) {
  const bytes = asBytes(value);
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('offset must be a nonnegative integer.');
  if (!Number.isInteger(width) || width < 4 || width > 64) throw new RangeError('width must be between 4 and 64.');
  const end = Math.min(bytes.length, offset + Math.max(0, length));
  const rows = [];
  for (let cursor = offset; cursor < end; cursor += width) {
    const slice = bytes.subarray(cursor, Math.min(cursor + width, end));
    rows.push({
      offset: cursor,
      offsetHex: cursor.toString(16).padStart(8, '0'),
      hex: [...slice].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
      text: [...slice].map((byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('')
    });
  }
  return rows;
}

export function inspectFileBytes(value, filename = '') {
  const bytes = asBytes(value);
  const entropySample = bytes.length <= 8 * MiB ? bytes : bytes.subarray(0, 8 * MiB);
  return {
    name: filename,
    size: bytes.length,
    type: detectFileType(bytes, filename),
    entropy: shannonEntropy(entropySample),
    entropySampledBytes: entropySample.length,
    strings: extractAsciiStrings(bytes.subarray(0, Math.min(bytes.length, 8 * MiB)), 4, 1_000),
    hexRows: makeHexRows(bytes, 0, Math.min(bytes.length, 2 * KiB))
  };
}

export function inspectKnownBinaryStructure(value, filename = '') {
  const bytes = asBytes(value);
  const type = detectFileType(bytes, filename);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = { format: type.label, type: type.id, sampledBytes: bytes.length, complete: true };

  if (type.id === 'png') {
    if (bytes.length < 24) return { ...result, complete: false, reason: 'PNG IHDR is truncated.' };
    const chunks = [];
    let cursor = 8;
    let truncated = false;
    while (cursor + 12 <= bytes.length && chunks.length < 256) {
      const length = view.getUint32(cursor);
      const name = ascii(bytes, cursor + 4, cursor + 8);
      if (length > 256 * MiB || cursor + 12 + length > bytes.length) { truncated = true; break; }
      chunks.push({ type: name, offset: cursor, dataBytes: length });
      cursor += 12 + length;
      if (name === 'IEND') break;
    }
    return {
      ...result,
      complete: chunks.at(-1)?.type === 'IEND' && !truncated,
      width: view.getUint32(16),
      height: view.getUint32(20),
      bitDepth: bytes[24] ?? null,
      colorType: bytes[25] ?? null,
      chunks,
      chunksTruncated: truncated || chunks.length === 256
    };
  }

  if (type.id === 'jpeg') {
    const segments = [];
    let width = null;
    let height = null;
    let precision = null;
    let cursor = 2;
    let truncated = false;
    while (cursor < bytes.length && segments.length < 256) {
      while (cursor < bytes.length && bytes[cursor] !== 0xff) cursor += 1;
      while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
      if (cursor >= bytes.length) break;
      const marker = bytes[cursor++];
      if (marker === 0xd9) { segments.push({ marker: 'FFD9', offset: cursor - 2, dataBytes: 0 }); break; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (cursor + 2 > bytes.length) { truncated = true; break; }
      const length = view.getUint16(cursor);
      if (length < 2 || cursor + length > bytes.length) { truncated = true; break; }
      const markerOffset = cursor - 2;
      segments.push({ marker: `FF${marker.toString(16).padStart(2, '0').toUpperCase()}`, offset: markerOffset, dataBytes: length - 2 });
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        precision = bytes[cursor + 2];
        height = view.getUint16(cursor + 3);
        width = view.getUint16(cursor + 5);
      }
      cursor += length;
      if (marker === 0xda) break; // entropy-coded scan data follows
    }
    return { ...result, complete: !truncated, width, height, precision, segments, segmentsTruncated: truncated || segments.length === 256 };
  }

  if (type.id === 'sqlite') {
    try { return { ...result, header: parseSQLiteHeader(bytes) }; }
    catch (error) { return { ...result, complete: false, reason: error.message }; }
  }
  if (type.id === 'parquet') {
    const hasTrailer = bytes.length >= 12 && matches(bytes, bytes.length - 4, [0x50, 0x41, 0x52, 0x31]);
    if (!hasTrailer) return { ...result, complete: false, reason: 'Only the leading Parquet sample is available; footer validation needs the complete file.' };
    try { return { ...result, envelope: inspectParquetEnvelope(bytes) }; }
    catch (error) { return { ...result, complete: false, reason: error.message }; }
  }
  if (type.id === 'wasm') {
    try { return { ...result, ...parseWasmSections(bytes) }; }
    catch (error) { return { ...result, complete: false, reason: error.message }; }
  }
  if (type.id === 'elf') {
    if (bytes.length < 20) return { ...result, complete: false, reason: 'ELF identification header is truncated.' };
    const bits = bytes[4] === 1 ? 32 : bytes[4] === 2 ? 64 : null;
    const littleEndian = bytes[5] === 1;
    return { ...result, bits, littleEndian, objectType: view.getUint16(16, littleEndian), machine: view.getUint16(18, littleEndian), abi: bytes[7] };
  }
  if (type.id === 'pe') {
    if (bytes.length < 64) return { ...result, complete: false, reason: 'DOS header is truncated.' };
    const peOffset = view.getUint32(0x3c, true);
    if (peOffset + 24 > bytes.length || !matches(bytes, peOffset, [0x50, 0x45, 0, 0])) return { ...result, complete: false, peOffset, reason: 'PE header is outside the retained sample or invalid.' };
    return { ...result, peOffset, machine: view.getUint16(peOffset + 4, true), sections: view.getUint16(peOffset + 6, true), timestamp: view.getUint32(peOffset + 8, true), optionalHeaderMagic: peOffset + 26 <= bytes.length ? `0x${view.getUint16(peOffset + 24, true).toString(16)}` : null };
  }
  if (type.id === 'zip') {
    if (bytes.length < 30 || !matches(bytes, 0, [0x50, 0x4b, 0x03, 0x04])) return { ...result, complete: false, reason: 'No complete ZIP local-file header is present in the sample.' };
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    return {
      ...result,
      versionNeeded: view.getUint16(4, true),
      flags: `0x${view.getUint16(6, true).toString(16)}`,
      compressionMethod: view.getUint16(8, true),
      compressedBytes: view.getUint32(18, true),
      uncompressedBytes: view.getUint32(22, true),
      firstEntry: 30 + nameLength <= bytes.length ? textDecoder.decode(bytes.subarray(30, 30 + nameLength)) : '(truncated)',
      extraBytes: extraLength
    };
  }
  if (type.id === 'pcap') {
    if (bytes.length < 24) return { ...result, complete: false, reason: 'PCAP global header is truncated.' };
    const littleEndian = matches(bytes, 0, [0xd4, 0xc3, 0xb2, 0xa1]) || matches(bytes, 0, [0x4d, 0x3c, 0xb2, 0xa1]);
    return { ...result, littleEndian, version: `${view.getUint16(4, littleEndian)}.${view.getUint16(6, littleEndian)}`, snapLength: view.getUint32(16, littleEndian), linkType: view.getUint32(20, littleEndian) };
  }
  if (type.id === 'pcapng') return { ...result, sectionHeader: 'PCAPNG Section Header Block', complete: bytes.length >= 28 };
  return { ...result, complete: false, reason: 'No additional bounded structure decoder is registered for this signature.' };
}

export async function sha256Hex(value, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle) throw new Error('Web Crypto SHA-256 is unavailable in this context.');
  const digest = await cryptoProvider.subtle.digest('SHA-256', asBytes(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function groupDuplicateRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const digest = String(record.digest || '').toLowerCase();
    const size = Number(record.size);
    if (!/^[a-f0-9]{16,}$/.test(digest) || !Number.isSafeInteger(size) || size < 0) continue;
    const key = `${size}:${digest}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...record, digest, size });
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ digest: group[0].digest, size: group[0].size, reclaimableBytes: group[0].size * (group.length - 1), files: group }))
    .sort((left, right) => right.reclaimableBytes - left.reclaimableBytes || left.digest.localeCompare(right.digest));
}

export function differenceHashFromRgba(value, width, height, hashWidth = 8, hashHeight = 8) {
  const rgba = asBytes(value);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < hashWidth + 1 || height < hashHeight || rgba.length < width * height * 4) throw new Error('RGBA dimensions are too small or inconsistent for dHash.');
  if (!Number.isInteger(hashWidth) || !Number.isInteger(hashHeight) || hashWidth < 1 || hashHeight < 1 || hashWidth * hashHeight > 256) throw new Error('dHash dimensions are unsupported.');
  const bits = [];
  const luminance = (x, y) => {
    const offset = (y * width + x) * 4;
    return rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722;
  };
  for (let y = 0; y < hashHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / hashHeight));
    for (let x = 0; x < hashWidth; x += 1) {
      const leftX = Math.min(width - 1, Math.floor((x + 0.5) * width / (hashWidth + 1)));
      const rightX = Math.min(width - 1, Math.floor((x + 1.5) * width / (hashWidth + 1)));
      bits.push(luminance(leftX, sourceY) > luminance(rightX, sourceY) ? 1 : 0);
    }
  }
  let hex = '';
  for (let index = 0; index < bits.length; index += 4) hex += parseInt(bits.slice(index, index + 4).join('').padEnd(4, '0'), 2).toString(16);
  return hex.padStart(Math.ceil(bits.length / 4), '0');
}

export function hammingDistanceHex(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  if (!/^[a-f0-9]+$/.test(a) || a.length !== b.length) throw new Error('Perceptual hashes must be same-length hexadecimal strings.');
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    let xor = parseInt(a[index], 16) ^ parseInt(b[index], 16);
    while (xor) { distance += xor & 1; xor >>= 1; }
  }
  return distance;
}

export function groupPerceptualHashes(records, maxDistance = 8) {
  if (!Number.isInteger(maxDistance) || maxDistance < 0 || maxDistance > 64) throw new RangeError('Perceptual distance must be between 0 and 64.');
  if (records.length > 2_000) throw new Error('Perceptual grouping is capped at 2,000 images.');
  const parent = records.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left, right) => { const a = find(left); const b = find(right); if (a !== b) parent[b] = a; };
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      if (hammingDistanceHex(records[left].hash, records[right].hash) <= maxDistance) union(left, right);
    }
  }
  const groups = new Map();
  records.forEach((record, index) => { const key = find(index); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record); });
  return [...groups.values()].filter((group) => group.length > 1).map((files) => ({
    hash: files[0].hash,
    files,
    maximumDistance: Math.max(...files.flatMap((left, index) => files.slice(index + 1).map((right) => hammingDistanceHex(left.hash, right.hash))))
  })).sort((left, right) => right.files.length - left.files.length || left.files[0].path.localeCompare(right.files[0].path));
}

const VAULT_MAGIC = Uint8Array.from([0x4d, 0x31, 0x33, 0x56, 0x41, 0x55, 0x4c, 0x54]); // M13VAULT
export const VAULT_DEFAULT_ITERATIONS = 310_000;

function joinBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function buildVaultHeader({ filename = 'encrypted.bin', mime = 'application/octet-stream', originalSize = 0, iterations = VAULT_DEFAULT_ITERATIONS, salt, iv }) {
  const saltBytes = asBytes(salt);
  const ivBytes = asBytes(iv);
  const nameBytes = textEncoder.encode(String(filename));
  const mimeBytes = textEncoder.encode(String(mime));
  if (saltBytes.length < 16 || saltBytes.length > 64) throw new RangeError('Vault salt must contain 16-64 bytes.');
  if (ivBytes.length !== 12) throw new RangeError('Vault AES-GCM IV must contain 12 bytes.');
  if (nameBytes.length > 4_096 || mimeBytes.length > 1_024) throw new RangeError('Vault metadata is too large.');
  if (!Number.isSafeInteger(originalSize) || originalSize < 0) throw new RangeError('Vault originalSize must be a nonnegative safe integer.');
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 5_000_000) throw new RangeError('Vault PBKDF2 iterations must be between 100,000 and 5,000,000.');
  const headerLength = 32 + saltBytes.length + ivBytes.length + nameBytes.length + mimeBytes.length;
  if (headerLength > 65_535) throw new RangeError('Vault header exceeds 65,535 bytes.');
  const fixed = new Uint8Array(32);
  fixed.set(VAULT_MAGIC, 0);
  const view = new DataView(fixed.buffer);
  fixed[8] = 1; // container version
  fixed[9] = 1; // AES-256-GCM + PBKDF2-SHA-256
  view.setUint16(10, headerLength, true);
  view.setUint32(12, iterations, true);
  fixed[16] = saltBytes.length;
  fixed[17] = ivBytes.length;
  view.setUint16(18, nameBytes.length, true);
  view.setUint16(20, mimeBytes.length, true);
  view.setBigUint64(24, BigInt(originalSize), true);
  return joinBytes(fixed, saltBytes, ivBytes, nameBytes, mimeBytes);
}

export function parseVaultContainer(value) {
  const bytes = asBytes(value);
  if (bytes.length < 48 || !matches(bytes, 0, VAULT_MAGIC)) throw new Error('Not an M13VAULT container.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[8];
  const algorithmId = bytes[9];
  const headerLength = view.getUint16(10, true);
  const iterations = view.getUint32(12, true);
  const saltLength = bytes[16];
  const ivLength = bytes[17];
  const filenameLength = view.getUint16(18, true);
  const mimeLength = view.getUint16(20, true);
  const originalSizeBig = view.getBigUint64(24, true);
  const expectedHeaderLength = 32 + saltLength + ivLength + filenameLength + mimeLength;
  if (version !== 1 || algorithmId !== 1) throw new Error(`Unsupported vault version or algorithm (${version}/${algorithmId}).`);
  if (headerLength !== expectedHeaderLength || headerLength >= bytes.length) throw new Error('Vault header length is inconsistent.');
  if (saltLength < 16 || saltLength > 64 || ivLength !== 12) throw new Error('Vault salt or IV metadata is invalid.');
  if (iterations < 100_000 || iterations > 5_000_000) throw new Error('Vault PBKDF2 iteration count is outside supported safety bounds.');
  if (originalSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Vault original size is too large for this browser.');
  let cursor = 32;
  const salt = bytes.slice(cursor, cursor += saltLength);
  const iv = bytes.slice(cursor, cursor += ivLength);
  const filename = textDecoder.decode(bytes.subarray(cursor, cursor += filenameLength));
  const mime = textDecoder.decode(bytes.subarray(cursor, cursor += mimeLength));
  const ciphertext = bytes.slice(headerLength);
  if (ciphertext.length < 16) throw new Error('Vault ciphertext is missing its AES-GCM authentication tag.');
  return {
    version,
    algorithm: 'AES-256-GCM/PBKDF2-SHA-256',
    iterations,
    originalSize: Number(originalSizeBig),
    filename,
    mime,
    salt,
    iv,
    header: bytes.slice(0, headerLength),
    ciphertext
  };
}

async function vaultKey(password, salt, iterations, cryptoProvider) {
  const passwordBytes = textEncoder.encode(String(password));
  if (!passwordBytes.length || passwordBytes.length > 1_024) throw new Error('Passphrase must contain 1-1,024 UTF-8 bytes.');
  const material = await cryptoProvider.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
  return cryptoProvider.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptVault(value, password, metadata = {}, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle || typeof cryptoProvider.getRandomValues !== 'function') throw new Error('Web Crypto AES-GCM is unavailable in this context.');
  const plaintext = asBytes(value);
  const salt = cryptoProvider.getRandomValues(new Uint8Array(16));
  const iv = cryptoProvider.getRandomValues(new Uint8Array(12));
  const header = buildVaultHeader({ ...metadata, originalSize: plaintext.length, salt, iv });
  const parsed = parseVaultContainer(joinBytes(header, new Uint8Array(16)));
  const key = await vaultKey(password, salt, parsed.iterations, cryptoProvider);
  const encrypted = await cryptoProvider.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, key, plaintext);
  return joinBytes(header, new Uint8Array(encrypted));
}

export async function decryptVault(value, password, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle) throw new Error('Web Crypto AES-GCM is unavailable in this context.');
  const parsed = parseVaultContainer(value);
  const key = await vaultKey(password, parsed.salt, parsed.iterations, cryptoProvider);
  try {
    const decrypted = await cryptoProvider.subtle.decrypt({ name: 'AES-GCM', iv: parsed.iv, additionalData: parsed.header, tagLength: 128 }, key, parsed.ciphertext);
    const bytes = new Uint8Array(decrypted);
    if (bytes.length !== parsed.originalSize) throw new Error('Authenticated content size does not match the container metadata.');
    return { bytes, metadata: { filename: parsed.filename, mime: parsed.mime, originalSize: parsed.originalSize, iterations: parsed.iterations } };
  } catch (error) {
    if (/content size/.test(String(error?.message))) throw error;
    throw new Error('Decryption failed: the passphrase is wrong or the container was modified.');
  }
}

export function parseSQLiteHeader(value) {
  const bytes = asBytes(value);
  if (bytes.length < 100 || !matches(bytes, 0, [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])) throw new Error('Not a SQLite 3 database header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pageSizeRaw = view.getUint16(16);
  const pageSize = pageSizeRaw === 1 ? 65_536 : pageSizeRaw;
  if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) throw new Error(`Invalid SQLite page size ${pageSize}.`);
  const encodingId = view.getUint32(56);
  const encodings = { 0: 'unspecified', 1: 'UTF-8', 2: 'UTF-16le', 3: 'UTF-16be' };
  return {
    pageSize,
    writeVersion: bytes[18] === 1 ? 'legacy rollback' : bytes[18] === 2 ? 'WAL' : `unknown (${bytes[18]})`,
    readVersion: bytes[19] === 1 ? 'legacy rollback' : bytes[19] === 2 ? 'WAL' : `unknown (${bytes[19]})`,
    reservedBytesPerPage: bytes[20],
    changeCounter: view.getUint32(24),
    declaredPages: view.getUint32(28),
    freelistPages: view.getUint32(36),
    schemaCookie: view.getUint32(40),
    schemaFormat: view.getUint32(44),
    textEncoding: encodings[encodingId] || `unknown (${encodingId})`,
    userVersion: view.getUint32(60),
    applicationId: view.getUint32(68),
    versionValidFor: view.getUint32(92),
    sqliteVersionNumber: view.getUint32(96)
  };
}

export function extractSQLiteSchemaStrings(value, maxStatements = 500) {
  const bytes = asBytes(value);
  const sample = bytes.subarray(0, Math.min(bytes.length, 128 * MiB));
  const strings = extractAsciiStrings(sample, 12, 50_000);
  const statements = [];
  const seen = new Set();
  for (const item of strings) {
    const index = item.text.search(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER|VIRTUAL\s+TABLE)\b/i);
    if (index < 0) continue;
    const statement = item.text.slice(index).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 16 * KiB);
    const canonical = statement.toLowerCase();
    if (!seen.has(canonical)) statements.push({ offset: item.offset + index, sql: statement });
    seen.add(canonical);
    if (statements.length >= maxStatements) break;
  }
  return statements;
}

export function inspectSQLite(value) {
  const bytes = asBytes(value);
  const header = parseSQLiteHeader(bytes);
  const expectedMinimumBytes = header.declaredPages * header.pageSize;
  return {
    header,
    schema: extractSQLiteSchemaStrings(bytes),
    actualBytes: bytes.length,
    expectedMinimumBytes,
    sizeConsistent: header.declaredPages === 0 || bytes.length >= expectedMinimumBytes
  };
}

export function inspectParquetEnvelope(value) {
  const bytes = asBytes(value);
  if (bytes.length < 12 || !matches(bytes, 0, [0x50, 0x41, 0x52, 0x31]) || !matches(bytes, bytes.length - 4, [0x50, 0x41, 0x52, 0x31])) throw new Error('Not a complete Apache Parquet envelope.');
  const footerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 8, true);
  const footerOffset = bytes.length - 8 - footerLength;
  if (footerLength < 1 || footerOffset < 4) throw new Error('Parquet footer length is inconsistent with the file size.');
  return { size: bytes.length, footerLength, footerOffset, dataBytes: footerOffset - 4, magic: 'PAR1' };
}

function sniffDelimiter(text) {
  const line = String(text).split(/\r\n|\n|\r/, 1)[0] || '';
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestCount = -1;
  for (const delimiter of candidates) {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '"') quoted = !quoted;
      else if (!quoted && line[index] === delimiter) count += 1;
    }
    if (count > bestCount) { best = delimiter; bestCount = count; }
  }
  return best;
}

function uniqueColumns(header) {
  const counts = new Map();
  return header.map((value, index) => {
    const base = String(value ?? '').replace(/^\uFEFF/, '').trim() || `column_${index + 1}`;
    const folded = base.toLocaleLowerCase();
    const count = (counts.get(folded) || 0) + 1;
    counts.set(folded, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

export function parseDelimited(text, options = {}) {
  const source = String(text ?? '');
  const delimiter = options.delimiter || sniffDelimiter(source);
  const maxRows = options.maxRows ?? 100_000;
  const maxColumns = options.maxColumns ?? 1_000;
  const maxCellChars = options.maxCellChars ?? MiB;
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || /[\r\n"]/.test(delimiter)) throw new Error('Delimiter must be one non-quote, non-newline character.');
  const matrix = [];
  let row = [];
  let field = '';
  let quoted = false;
  let justClosedQuote = false;
  const pushField = () => {
    if (field.length > maxCellChars) throw new Error(`A delimited cell exceeds ${maxCellChars.toLocaleString()} characters.`);
    row.push(field);
    if (row.length > maxColumns) throw new Error(`Delimited input exceeds ${maxColumns.toLocaleString()} columns.`);
    field = '';
    justClosedQuote = false;
  };
  const pushRow = () => {
    pushField();
    matrix.push(row);
    if (matrix.length > maxRows + 1) throw new Error(`Delimited input exceeds ${maxRows.toLocaleString()} data rows.`);
    row = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; justClosedQuote = true; }
      } else field += character;
      continue;
    }
    if (character === '"' && field === '' && !justClosedQuote) { quoted = true; continue; }
    if (character === delimiter) { pushField(); continue; }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      pushRow();
      continue;
    }
    if (justClosedQuote && !/\s/.test(character)) throw new Error(`Unexpected character after a closing quote near position ${index}.`);
    if (!justClosedQuote || /\s/.test(character)) field += character;
  }
  if (quoted) throw new Error('Delimited input ends inside a quoted field.');
  if (source.length && (field !== '' || row.length || source.endsWith(delimiter))) pushRow();
  while (matrix.length && matrix.at(-1).every((cell) => cell === '')) matrix.pop();
  if (!matrix.length) return { columns: [], rows: [], delimiter };
  const columns = uniqueColumns(matrix.shift());
  const rows = matrix.map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ''])));
  return { columns, rows, delimiter };
}

function normalizeObjectRows(value, maxRows, options = {}) {
  const source = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [value];
  const maxColumns = options.maxColumns ?? 1_000;
  const maxCellChars = options.maxCellChars ?? MiB;
  if (source.length > maxRows) throw new Error(`Dataset exceeds ${maxRows.toLocaleString()} rows.`);
  const rows = source.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { value: item };
    const entries = Object.entries(item);
    if (entries.length > maxColumns) throw new Error(`Dataset exceeds ${maxColumns.toLocaleString()} columns.`);
    return Object.fromEntries(entries.map(([key, cell]) => {
      const normalized = cell && typeof cell === 'object' ? JSON.stringify(cell) : cell;
      if (typeof normalized === 'string' && normalized.length > maxCellChars) throw new Error(`A dataset cell exceeds ${maxCellChars.toLocaleString()} characters.`);
      return [key, normalized];
    }));
  });
  const columns = [];
  const seen = new Set();
  for (const row of rows) for (const key of Object.keys(row)) if (!seen.has(key)) {
    if (columns.length >= maxColumns) throw new Error(`Dataset exceeds ${maxColumns.toLocaleString()} columns.`);
    seen.add(key); columns.push(key);
  }
  return { columns, rows };
}

export function parseDatasetText(text, format = 'auto', options = {}) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const maxRows = options.maxRows ?? 100_000;
  let selected = String(format || 'auto').toLowerCase();
  if (selected === 'auto') {
    const trimmed = source.trimStart();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) selected = 'json';
    else {
      const firstLines = source.split(/\r\n|\n|\r/).filter((line) => line.trim()).slice(0, 3);
      selected = firstLines.length > 1 && firstLines.every((line) => /^\s*\{/.test(line)) ? 'ndjson' : 'csv';
    }
  }
  if (selected === 'csv' || selected === 'tsv') {
    const parsed = parseDelimited(source, { ...options, delimiter: selected === 'tsv' ? '\t' : options.delimiter });
    return { ...parsed, format: selected };
  }
  if (selected === 'json') return { ...normalizeObjectRows(JSON.parse(source), maxRows, options), format: 'json' };
  if (selected === 'ndjson' || selected === 'jsonl') {
    const values = [];
    const lines = source.split(/\r\n|\n|\r/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      if (values.length >= maxRows) throw new Error(`Dataset exceeds ${maxRows.toLocaleString()} rows.`);
      try { values.push(JSON.parse(lines[index])); } catch (_) { throw new Error(`Invalid NDJSON on line ${index + 1}.`); }
    }
    return { ...normalizeObjectRows(values, maxRows, options), format: 'ndjson' };
  }
  throw new Error(`Unsupported text dataset format: ${format}.`);
}

function csvCell(value, spreadsheetSafe = true) {
  let string = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (spreadsheetSafe && /^[\t\r\n ]*[=+\-@]/.test(string)) string = `'${string}`;
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export function datasetToCSV(rows, columns = null, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const selected = columns?.length ? columns : [...new Set(safeRows.flatMap((row) => Object.keys(row || {})))];
  const lines = [selected.map((column) => csvCell(column, false)).join(',')];
  for (const row of safeRows) lines.push(selected.map((column) => csvCell(row?.[column], options.spreadsheetSafe !== false)).join(','));
  return lines.join('\r\n');
}

export function datasetToNDJSON(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(row)).join('\n');
}

function splitSqlItems(value) {
  const items = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote) {
        if (value[index + 1] === quote) { current += value[++index]; }
        else quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) { items.push(current.trim()); current = ''; }
    else current += character;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function stripIdentifier(value) {
  const trimmed = String(value).trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('`') && trimmed.endsWith('`')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) return trimmed.slice(1, -1).replaceAll(trimmed[0] + trimmed[0], trimmed[0]);
  if (!/^[A-Za-z_$][\w$.-]*$/.test(trimmed)) throw new Error(`Invalid or unsupported column identifier: ${trimmed}.`);
  return trimmed;
}

function clausePositions(rest) {
  const candidates = ['WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT'];
  const found = [];
  let quote = '';
  let depth = 0;
  const upper = rest.toUpperCase();
  for (let index = 0; index < rest.length; index += 1) {
    const character = rest[index];
    if (quote) {
      if (character === quote) {
        if (rest[index + 1] === quote) index += 1;
        else quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '(') { depth += 1; continue; }
    if (character === ')') { depth -= 1; continue; }
    if (depth) continue;
    for (const name of candidates) {
      if (upper.startsWith(name, index) && !/[A-Z0-9_]/.test(upper[index - 1] || '') && !/[A-Z0-9_]/.test(upper[index + name.length] || '')) found.push({ name, index });
    }
  }
  return found.sort((left, right) => left.index - right.index);
}

function sqlLiteral(value) {
  const trimmed = value.trim();
  if (/^NULL$/i.test(trimmed)) return null;
  if (/^TRUE$/i.test(trimmed)) return true;
  if (/^FALSE$/i.test(trimmed)) return false;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replaceAll('""', '"');
  throw new Error(`WHERE literal is unsupported: ${trimmed}. Quote text values.`);
}

export function parseSimpleSelect(sql) {
  const source = String(sql || '').trim().replace(/;\s*$/, '');
  if (source.length > 16 * KiB) throw new Error('Query exceeds 16 KiB.');
  const match = source.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+(?:data|dataset)\b([\s\S]*)$/i);
  if (!match) throw new Error('Supported syntax starts with SELECT ... FROM data.');
  const select = splitSqlItems(match[1]).map((item) => {
    if (item === '*') return { type: 'wildcard', alias: '*' };
    const aggregate = item.match(/^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(\*|[^)]+)\s*\)(?:\s+AS\s+(.+))?$/i);
    if (aggregate) {
      const fn = aggregate[1].toLowerCase();
      const column = aggregate[2] === '*' ? '*' : stripIdentifier(aggregate[2]);
      if (column === '*' && fn !== 'count') throw new Error(`${fn.toUpperCase()}(*) is unsupported.`);
      return { type: 'aggregate', fn, column, alias: aggregate[3] ? stripIdentifier(aggregate[3]) : `${fn}_${column === '*' ? 'all' : column}` };
    }
    const columnMatch = item.match(/^(.+?)(?:\s+AS\s+(.+))?$/i);
    const column = stripIdentifier(columnMatch[1]);
    return { type: 'column', column, alias: columnMatch[2] ? stripIdentifier(columnMatch[2]) : column };
  });
  if (!select.length || (select.some((item) => item.type === 'wildcard') && select.length !== 1)) throw new Error('Use * alone or list explicit selected fields.');
  const rest = match[2] || '';
  const positions = clausePositions(rest);
  const clauses = {};
  for (let index = 0; index < positions.length; index += 1) {
    const current = positions[index];
    if (clauses[current.name]) throw new Error(`Duplicate ${current.name} clause.`);
    const start = current.index + current.name.length;
    const end = positions[index + 1]?.index ?? rest.length;
    clauses[current.name] = rest.slice(start, end).trim();
  }
  if (rest.slice(0, positions[0]?.index ?? rest.length).trim()) throw new Error('Unsupported text after FROM data.');
  let where = null;
  if (clauses.WHERE) {
    const whereMatch = clauses.WHERE.match(/^(.+?)\s*(>=|<=|<>|!=|=|>|<|\bCONTAINS\b)\s*([\s\S]+)$/i);
    if (!whereMatch) throw new Error('WHERE supports one comparison: =, !=, <, <=, >, >=, or CONTAINS.');
    where = { column: stripIdentifier(whereMatch[1]), operator: whereMatch[2].toUpperCase(), value: sqlLiteral(whereMatch[3]) };
  }
  const groupBy = clauses['GROUP BY'] ? stripIdentifier(clauses['GROUP BY']) : null;
  let orderBy = null;
  if (clauses['ORDER BY']) {
    const orderMatch = clauses['ORDER BY'].match(/^(.+?)(?:\s+(ASC|DESC))?$/i);
    orderBy = { column: stripIdentifier(orderMatch[1]), direction: (orderMatch[2] || 'ASC').toUpperCase() };
  }
  const limit = clauses.LIMIT ? Number(clauses.LIMIT) : 1_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('LIMIT must be an integer between 1 and 10,000.');
  return { select, where, groupBy, orderBy, limit };
}

function compareCell(cell, operator, expected) {
  if (operator === 'CONTAINS') return String(cell ?? '').toLocaleLowerCase().includes(String(expected ?? '').toLocaleLowerCase());
  if (operator === '=' || operator === '!=' || operator === '<>') {
    const equal = expected === null ? cell == null || cell === '' : typeof expected === 'number' ? Number(cell) === expected : String(cell) === String(expected);
    return operator === '=' ? equal : !equal;
  }
  const leftNumber = Number(cell);
  const rightNumber = Number(expected);
  const [left, right] = Number.isFinite(leftNumber) && Number.isFinite(rightNumber) ? [leftNumber, rightNumber] : [String(cell ?? ''), String(expected ?? '')];
  if (operator === '>') return left > right;
  if (operator === '>=') return left >= right;
  if (operator === '<') return left < right;
  if (operator === '<=') return left <= right;
  return false;
}

function aggregateValue(rows, item) {
  if (item.fn === 'count') return item.column === '*' ? rows.length : rows.filter((row) => row?.[item.column] != null && row[item.column] !== '').length;
  const values = rows.map((row) => row?.[item.column]).filter((value) => value !== '' && value != null).map(Number).filter(Number.isFinite);
  if (!values.length) return null;
  if (item.fn === 'sum') return values.reduce((sum, value) => sum + value, 0);
  if (item.fn === 'avg') return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (item.fn === 'min') { let result = Infinity; for (const value of values) if (value < result) result = value; return result; }
  if (item.fn === 'max') { let result = -Infinity; for (const value of values) if (value > result) result = value; return result; }
  return null;
}

export function executeDatasetQuery(rows, query) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array.');
  if (rows.length > 1_000_000) throw new Error('In-memory query input is capped at 1,000,000 rows.');
  const plan = typeof query === 'string' ? parseSimpleSelect(query) : query;
  let working = plan.where ? rows.filter((row) => compareCell(row?.[plan.where.column], plan.where.operator, plan.where.value)) : [...rows];
  const hasAggregate = plan.select.some((item) => item.type === 'aggregate');
  if (hasAggregate) {
    for (const item of plan.select) if (item.type === 'column' && item.column !== plan.groupBy) throw new Error(`Selected column ${item.column} must be the GROUP BY column.`);
    const groups = new Map();
    for (const row of working) {
      const key = plan.groupBy ? String(row?.[plan.groupBy] ?? '') : '__all__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    if (!working.length && !plan.groupBy) groups.set('__all__', []);
    working = [...groups.entries()].map(([key, groupRows]) => Object.fromEntries(plan.select.map((item) => {
      if (item.type === 'aggregate') return [item.alias, aggregateValue(groupRows, item)];
      return [item.alias, plan.groupBy ? groupRows[0]?.[item.column] ?? key : null];
    })));
  } else if (plan.select[0]?.type !== 'wildcard') {
    working = working.map((row) => Object.fromEntries(plan.select.map((item) => [item.alias, row?.[item.column] ?? null])));
  }
  if (plan.orderBy) {
    working.sort((left, right) => {
      const a = left?.[plan.orderBy.column];
      const b = right?.[plan.orderBy.column];
      const numeric = Number.isFinite(Number(a)) && Number.isFinite(Number(b));
      const compared = numeric ? Number(a) - Number(b) : String(a ?? '').localeCompare(String(b ?? ''));
      return plan.orderBy.direction === 'DESC' ? -compared : compared;
    });
  }
  return working.slice(0, plan.limit);
}

export function inferColumns(rows) {
  const columns = [...new Set((Array.isArray(rows) ? rows.slice(0, 10_000) : []).flatMap((row) => Object.keys(row || {})))];
  return columns.map((name) => {
    const values = rows.slice(0, 1_000).map((row) => row?.[name]).filter((value) => value !== '' && value != null);
    const boolean = values.length > 0 && values.every((value) => typeof value === 'boolean' || /^(?:true|false)$/i.test(String(value)));
    const numeric = !boolean && values.length > 0 && values.every((value) => Number.isFinite(Number(value)));
    return { name, type: boolean ? 'boolean' : numeric ? 'number' : 'string', nonEmpty: values.length };
  });
}

export function aggregateForChart(rows, { category, value = null, aggregation = 'count', limit = 30 } = {}) {
  if (!category) throw new Error('A category field is required.');
  if (!['count', 'sum', 'avg', 'min', 'max'].includes(aggregation)) throw new Error(`Unsupported chart aggregation: ${aggregation}.`);
  if (aggregation !== 'count' && !value) throw new Error('A numeric value field is required for this aggregation.');
  const groups = new Map();
  for (const row of rows) {
    const label = String(row?.[category] ?? '(empty)');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }
  return [...groups].map(([label, group]) => {
    const item = { type: 'aggregate', fn: aggregation, column: aggregation === 'count' ? '*' : value };
    return { label, value: aggregateValue(group, item), rows: group.length };
  }).sort((left, right) => Number(right.value ?? -Infinity) - Number(left.value ?? -Infinity) || left.label.localeCompare(right.label)).slice(0, Math.max(1, Math.min(limit, 100)));
}

export function filterDatasetRows(rows, { field = '', operator = 'contains', value = '' } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array.');
  if (!field || value === '') return [...rows];
  const normalizedOperator = String(operator).toUpperCase();
  if (!['CONTAINS', '=', '!=', '<>', '>', '>=', '<', '<='].includes(normalizedOperator)) throw new Error(`Unsupported filter operator: ${operator}.`);
  let expected = value;
  if (['>', '>=', '<', '<='].includes(normalizedOperator)) {
    expected = Number(value);
    if (!Number.isFinite(expected)) throw new Error('Comparison filters require a finite numeric value.');
  }
  return rows.filter((row) => compareCell(row?.[field], normalizedOperator, expected));
}

export function pivotDataset(rows, { row: rowField, column: columnField, value = null, aggregation = 'count' } = {}) {
  if (!rowField || !columnField) throw new Error('Pivot row and column fields are required.');
  if (!['count', 'sum', 'avg', 'min', 'max'].includes(aggregation)) throw new Error(`Unsupported pivot aggregation: ${aggregation}.`);
  if (aggregation !== 'count' && !value) throw new Error('A numeric value field is required for this pivot aggregation.');
  const columnValues = [...new Set(rows.map((item) => String(item?.[columnField] ?? '(empty)')))].sort();
  if (columnValues.length > 100) throw new Error('Pivot output is capped at 100 distinct columns.');
  const rowValues = [...new Set(rows.map((item) => String(item?.[rowField] ?? '(empty)')))].sort();
  if (rowValues.length > 1_000) throw new Error('Pivot output is capped at 1,000 distinct rows.');
  const groups = new Map(rowValues.map((rowValue) => [rowValue, new Map()]));
  for (const item of rows) {
    const rowValue = String(item?.[rowField] ?? '(empty)');
    const columnValue = String(item?.[columnField] ?? '(empty)');
    const rowGroups = groups.get(rowValue);
    let accumulator = rowGroups.get(columnValue);
    if (!accumulator) {
      accumulator = { rows: 0, numeric: 0, sum: 0, min: Infinity, max: -Infinity };
      rowGroups.set(columnValue, accumulator);
    }
    accumulator.rows += 1;
    const raw = item?.[value];
    const numeric = raw === '' || raw == null ? NaN : Number(raw);
    if (aggregation !== 'count' && Number.isFinite(numeric)) {
      accumulator.numeric += 1;
      accumulator.sum += numeric;
      if (numeric < accumulator.min) accumulator.min = numeric;
      if (numeric > accumulator.max) accumulator.max = numeric;
    }
  }
  const resolve = (accumulator) => {
    if (!accumulator) return aggregation === 'count' ? 0 : null;
    if (aggregation === 'count') return accumulator.rows;
    if (!accumulator.numeric) return null;
    if (aggregation === 'sum') return accumulator.sum;
    if (aggregation === 'avg') return accumulator.sum / accumulator.numeric;
    if (aggregation === 'min') return accumulator.min;
    return accumulator.max;
  };
  const output = rowValues.map((rowValue) => {
    const result = { [rowField]: rowValue };
    for (const columnValue of columnValues) result[columnValue] = resolve(groups.get(rowValue).get(columnValue));
    return result;
  });
  return { columns: [rowField, ...columnValues], rows: output };
}

export function joinDatasets(leftRows, rightRows, { leftKey, rightKey = leftKey, type = 'inner', maxRows = 100_000 } = {}) {
  if (!Array.isArray(leftRows) || !Array.isArray(rightRows)) throw new TypeError('Both join inputs must be row arrays.');
  if (!leftKey || !rightKey) throw new Error('Both join keys are required.');
  if (!['inner', 'left', 'full'].includes(type)) throw new Error(`Unsupported join type: ${type}.`);
  const keyOf = (value) => value == null ? null : `\u0001${String(value)}`;
  const rightIndex = new Map();
  rightRows.forEach((row, index) => {
    const key = keyOf(row?.[rightKey]);
    if (key === null) return;
    if (!rightIndex.has(key)) rightIndex.set(key, []);
    rightIndex.get(key).push({ row, index });
  });
  const matchedRight = new Set();
  const result = [];
  const merge = (left, right) => {
    const output = { ...(left || {}) };
    for (const [key, value] of Object.entries(right || {})) {
      if (key === rightKey && leftKey === rightKey && Object.hasOwn(output, key)) continue;
      output[Object.hasOwn(output, key) ? `right.${key}` : key] = value;
    }
    return output;
  };
  const push = (row) => { if (result.length >= maxRows) throw new Error(`Join output exceeds ${maxRows.toLocaleString()} rows.`); result.push(row); };
  for (const left of leftRows) {
    const key = keyOf(left?.[leftKey]);
    const matches = key === null ? [] : rightIndex.get(key) || [];
    if (matches.length) for (const item of matches) { matchedRight.add(item.index); push(merge(left, item.row)); }
    else if (type === 'left' || type === 'full') push(merge(left, null));
  }
  if (type === 'full') rightRows.forEach((right, index) => { if (!matchedRight.has(index)) push(merge(null, right)); });
  return result;
}

export function serializeNotebook(cells, metadata = {}) {
  if (!Array.isArray(cells) || cells.length > 500) throw new Error('Notebook must contain at most 500 cells.');
  return {
    format: 'm13-local-notebook',
    version: 1,
    metadata: { ...metadata, title: String(metadata.title || 'Local notebook').slice(0, 200) },
    cells: cells.map((cell, index) => ({
      id: String(cell.id || `cell-${index + 1}`).slice(0, 200),
      language: ['python', 'data-query', 'markdown', 'javascript'].includes(cell.language) ? cell.language : 'javascript',
      source: String(cell.source || '').slice(0, MiB),
      output: String(cell.output || '').slice(0, MiB),
      state: ['idle', 'success', 'error'].includes(cell.state) ? cell.state : 'idle'
    }))
  };
}

export function parseNotebook(value) {
  let parsed = value;
  if (typeof value === 'string') {
    if (value.length > 8 * MiB) throw new Error('Notebook JSON exceeds 8 MiB.');
    parsed = JSON.parse(value);
  }
  if (!parsed || parsed.format !== 'm13-local-notebook' || parsed.version !== 1 || !Array.isArray(parsed.cells)) throw new Error('Unsupported local notebook format.');
  return serializeNotebook(parsed.cells, parsed.metadata || {});
}

export async function evaluateJavaScriptCell(source, context = {}) {
  const code = String(source || '');
  if (code.length > 256 * KiB) throw new Error('JavaScript cell exceeds 256 KiB.');
  if (/\bimport\s*\(/.test(code) || /\bimportScripts\s*\(/.test(code)) throw new Error('Dynamic imports are disabled in the local code worker.');
  const logs = [];
  const notebookConsole = Object.freeze({
    log: (...values) => logs.push(values.map(formatNotebookValue).join(' ')),
    info: (...values) => logs.push(values.map(formatNotebookValue).join(' ')),
    warn: (...values) => logs.push(`WARN ${values.map(formatNotebookValue).join(' ')}`),
    error: (...values) => logs.push(`ERROR ${values.map(formatNotebookValue).join(' ')}`)
  });
  const AsyncFunction = context.AsyncFunction || Object.getPrototypeOf(async function () {}).constructor;
  const runner = new AsyncFunction('data', 'console', `"use strict";\n${code}`);
  const result = await runner(context.data ?? null, notebookConsole);
  return { result, logs };
}

function formatNotebookValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return `${value}n`;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

export function runRegex(pattern, flags, input, options = {}) {
  const source = String(pattern ?? '');
  const text = String(input ?? '');
  const maxPatternChars = options.maxPatternChars ?? 4_096;
  const maxInputChars = options.maxInputChars ?? 5 * MiB;
  const maxMatches = options.maxMatches ?? 10_000;
  const timeBudgetMs = options.timeBudgetMs ?? 500;
  const contextChars = Math.max(0, Math.min(Number(options.contextChars ?? 80) || 0, 1_000));
  if (source.length > maxPatternChars) throw new Error(`Pattern exceeds ${maxPatternChars.toLocaleString()} characters.`);
  if (text.length > maxInputChars) throw new Error(`Input exceeds ${maxInputChars.toLocaleString()} characters.`);
  const normalizedFlags = String(flags || 'g');
  if (!/^[dgimsuvy]*$/.test(normalizedFlags) || new Set(normalizedFlags).size !== normalizedFlags.length) throw new Error('Regex flags are invalid or duplicated.');
  const effectiveFlags = normalizedFlags.includes('g') ? normalizedFlags : `${normalizedFlags}g`;
  const expression = new RegExp(source, effectiveFlags);
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  const matchesFound = [];
  let truncated = false;
  for (const match of text.matchAll(expression)) {
    matchesFound.push({
      index: match.index,
      end: match.index + match[0].length,
      match: match[0],
      groups: match.slice(1),
      namedGroups: match.groups ? { ...match.groups } : null,
      indices: match.indices ? match.indices.map((range) => range ? [...range] : null) : null,
      context: text.slice(Math.max(0, match.index - contextChars), Math.min(text.length, match.index + match[0].length + contextChars))
    });
    if (matchesFound.length >= maxMatches) { truncated = true; break; }
    const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
    if (elapsed > timeBudgetMs) { truncated = true; break; }
  }
  return { pattern: source, flags: effectiveFlags, matches: matchesFound, truncated, elapsedMs: (globalThis.performance?.now?.() ?? Date.now()) - startedAt };
}

export function parseGitHead(text) {
  const value = String(text || '').trim();
  const symbolic = value.match(/^ref:\s*(refs\/(?:heads|tags|remotes)\/.+)$/);
  if (symbolic) return { type: 'symbolic', ref: symbolic[1], branch: symbolic[1].replace(/^refs\/heads\//, '') };
  if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value)) return { type: 'detached', oid: value.toLowerCase(), branch: null };
  throw new Error('HEAD is neither a supported symbolic ref nor a 40/64-character object ID.');
}

export function parseGitConfig(text) {
  const result = { sections: [], remotes: [], identity: {}, core: {} };
  let section = null;
  const source = String(text || '');
  if (source.length > MiB) throw new Error('Git config exceeds 1 MiB.');
  for (const [index, rawLine] of source.split(/\r\n|\n|\r/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]$/);
    if (sectionMatch) {
      section = { name: sectionMatch[1].toLowerCase(), subsection: sectionMatch[2]?.replace(/\\(["\\])/g, '$1') || null, values: {} };
      result.sections.push(section);
      continue;
    }
    const setting = line.match(/^([A-Za-z][A-Za-z0-9.-]*)\s*(?:=\s*(.*))?$/);
    if (!setting || !section) throw new Error(`Invalid Git config syntax on line ${index + 1}.`);
    const key = setting[1].toLowerCase();
    const value = (setting[2] ?? 'true').trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["\\])/g, '$1');
    section.values[key] = value;
  }
  for (const item of result.sections) {
    if (item.name === 'remote' && item.subsection) result.remotes.push({ name: item.subsection, url: item.values.url || '', fetch: item.values.fetch || '' });
    if (item.name === 'user') result.identity = { name: item.values.name || '', email: item.values.email || '' };
    if (item.name === 'core') result.core = { ...item.values };
  }
  return result;
}

export function parseGitLog(text, maxEntries = 5_000) {
  const entries = [];
  const source = String(text || '');
  if (source.length > 16 * MiB) throw new Error('Git reflog exceeds 16 MiB.');
  for (const line of source.split(/\r\n|\n|\r/)) {
    if (!line || entries.length >= maxEntries) continue;
    const match = line.match(/^([a-f0-9]{40,64}) ([a-f0-9]{40,64}) (.+) <([^<>]*)> (\d+) ([+-]\d{4})\t(.*)$/i);
    if (!match) continue;
    entries.push({ oldOid: match[1].toLowerCase(), newOid: match[2].toLowerCase(), name: match[3], email: match[4], timestamp: Number(match[5]), timezone: match[6], message: match[7] });
  }
  return entries;
}

export function parsePackedRefs(text) {
  const refs = [];
  let previous = null;
  for (const line of String(text || '').split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('^') && previous && /^\^[a-f0-9]{40,64}$/i.test(line)) { previous.peeled = line.slice(1).toLowerCase(); continue; }
    const match = line.match(/^([a-f0-9]{40,64}) (refs\/(?:heads|tags|remotes)\/.+)$/i);
    if (match) { previous = { oid: match[1].toLowerCase(), ref: match[2] }; refs.push(previous); }
  }
  return refs;
}

export function analyzeGitSnapshot(entries) {
  const normalized = new Map(entries.map((entry) => [String(entry.path || entry.name).replaceAll('\\', '/'), String(entry.text ?? '')]));
  const bySuffix = (suffix) => [...normalized].find(([path]) => path.endsWith(suffix))?.[1] ?? null;
  const headText = bySuffix('/.git/HEAD') ?? normalized.get('.git/HEAD') ?? bySuffix('/HEAD');
  if (headText == null) throw new Error('No .git/HEAD metadata file was selected.');
  const head = parseGitHead(headText);
  const configText = bySuffix('/.git/config') ?? normalized.get('.git/config');
  const logText = bySuffix('/.git/logs/HEAD') ?? normalized.get('.git/logs/HEAD');
  const packedText = bySuffix('/.git/packed-refs') ?? normalized.get('.git/packed-refs');
  const refs = [];
  for (const [path, value] of normalized) {
    const marker = path.lastIndexOf('/.git/refs/');
    const relative = marker >= 0 ? path.slice(marker + 6) : path.startsWith('.git/refs/') ? path.slice(5) : null;
    if (relative && /^[a-f0-9]{40,64}\s*$/i.test(value)) refs.push({ ref: relative, oid: value.trim().toLowerCase() });
  }
  if (packedText) refs.push(...parsePackedRefs(packedText));
  const uniqueRefs = [...new Map(refs.map((item) => [item.ref, item])).values()].sort((a, b) => a.ref.localeCompare(b.ref));
  return { head, config: configText ? parseGitConfig(configText) : null, reflog: logText ? parseGitLog(logText) : [], refs: uniqueRefs };
}

export function diffTextLines(leftText, rightText, options = {}) {
  const maxLines = options.maxLines ?? 2_000;
  const maxCells = options.maxCells ?? 2_000_000;
  const left = String(leftText ?? '').split(/\r\n|\n|\r/);
  const right = String(rightText ?? '').split(/\r\n|\n|\r/);
  if (left.length > maxLines || right.length > maxLines || left.length * right.length > maxCells) throw new Error(`Text diff is capped at ${maxLines.toLocaleString()} lines per side and ${maxCells.toLocaleString()} comparison cells.`);
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      rows[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
        ? rows[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(rows[leftIndex + 1][rightIndex], rows[leftIndex][rightIndex + 1]);
    }
  }
  const changes = [];
  let leftIndex = 0;
  let rightIndex = 0;
  let unchanged = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (leftIndex < left.length && rightIndex < right.length && left[leftIndex] === right[rightIndex]) {
      unchanged += 1; leftIndex += 1; rightIndex += 1; continue;
    }
    if (rightIndex < right.length && (leftIndex >= left.length || rows[leftIndex][rightIndex + 1] >= rows[leftIndex + 1][rightIndex])) {
      changes.push({ type: 'add', leftLine: null, rightLine: rightIndex + 1, text: right[rightIndex++] });
    } else {
      changes.push({ type: 'delete', leftLine: leftIndex + 1, rightLine: null, text: left[leftIndex++] });
    }
  }
  return { leftLines: left.length, rightLines: right.length, unchanged, added: changes.filter((item) => item.type === 'add').length, deleted: changes.filter((item) => item.type === 'delete').length, changes };
}

export function prepareGitCommitMetadata({ message, authorName, authorEmail, branch = 'main', parent = null, timestamp = Date.now() } = {}) {
  const cleanMessage = String(message || '').trim();
  const cleanName = String(authorName || '').trim();
  const cleanEmail = String(authorEmail || '').trim();
  const cleanBranch = String(branch || '').trim();
  if (!cleanMessage || cleanMessage.length > 16 * KiB) throw new Error('Commit message must contain 1-16,384 characters.');
  if (!cleanName || cleanName.length > 200 || /[\r\n<>]/.test(cleanName)) throw new Error('Author name is missing or invalid.');
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(cleanEmail) || cleanEmail.length > 320) throw new Error('Author email is invalid.');
  if (!/^(?!\/|.*(?:\/\.|\.\.|\/\/|@\{|\\|[~^:?*\[]))(?!.*\.$)[A-Za-z0-9._/-]{1,255}$/.test(cleanBranch)) throw new Error('Branch name is invalid.');
  if (parent != null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(String(parent))) throw new Error('Parent object ID is invalid.');
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('Commit timestamp is invalid.');
  return { message: cleanMessage, author: { name: cleanName, email: cleanEmail }, branch: cleanBranch, parent: parent ? String(parent).toLowerCase() : null, timestamp: date.toISOString(), preparedOnly: true };
}

function fsError(code, path) { const error = new Error(`${code}: ${path}`); error.code = code; return error; }

export function createGitMemoryFs(entries, options = {}) {
  const mutable = options.mutable === true;
  const files = new Map();
  const directories = new Set(['/']);
  const normalize = (value) => {
    const parts = String(value || '').replaceAll('\\', '/').split('/');
    const output = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') output.pop(); else output.push(part);
    }
    return `/${output.join('/')}`;
  };
  for (const entry of entries) {
    const path = normalize(entry.path);
    const bytes = entry.bytes != null ? asBytes(entry.bytes).slice() : textEncoder.encode(String(entry.text ?? ''));
    files.set(path, { bytes, lastModified: Number(entry.lastModified || 0) });
    const parts = path.split('/').slice(1, -1);
    let directory = '';
    for (const part of parts) { directory += `/${part}`; directories.add(directory); }
  }
  const parentOf = (path) => path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
  const requireMutable = (path) => { if (!mutable) throw fsError('EROFS', path || 'read-only Git snapshot'); };
  const valueBytes = (value, encoding = 'utf-8') => typeof value === 'string' ? new TextEncoder(encoding).encode(value) : asBytes(value).slice();
  const statFor = (path) => {
    const normalized = normalize(path);
    const file = files.get(normalized);
    if (!file && !directories.has(normalized)) throw fsError('ENOENT', normalized);
    const isFile = Boolean(file);
    const timestamp = file?.lastModified || 0;
    return {
      size: file?.bytes.length || 0, mode: isFile ? 0o100644 : 0o040755, mtimeMs: timestamp, ctimeMs: timestamp, birthtimeMs: timestamp,
      mtime: new Date(timestamp), ctime: new Date(timestamp), birthtime: new Date(timestamp), ino: 0, uid: 0, gid: 0, dev: 0,
      isFile: () => isFile, isDirectory: () => !isFile, isSymbolicLink: () => false
    };
  };
  const promises = {
    async readFile(path, options = null) {
      const normalized = normalize(path);
      const file = files.get(normalized);
      if (!file) throw fsError(directories.has(normalized) ? 'EISDIR' : 'ENOENT', normalized);
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return encoding ? new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding).decode(file.bytes) : file.bytes.slice();
    },
    async readdir(path, options = null) {
      const normalized = normalize(path);
      if (!directories.has(normalized)) throw fsError(files.has(normalized) ? 'ENOTDIR' : 'ENOENT', normalized);
      const prefix = normalized === '/' ? '/' : `${normalized}/`;
      const names = new Set();
      for (const candidate of [...directories, ...files.keys()]) {
        if (candidate.startsWith(prefix)) { const rest = candidate.slice(prefix.length); if (rest && !rest.includes('/')) names.add(rest); }
      }
      const sorted = [...names].sort();
      if (!options?.withFileTypes) return sorted;
      return sorted.map((name) => { const child = normalize(`${prefix}${name}`); return { name, isFile: () => files.has(child), isDirectory: () => directories.has(child), isSymbolicLink: () => false }; });
    },
    async stat(path) { return statFor(path); },
    async lstat(path) { return statFor(path); },
    async readlink(path) { throw fsError('EINVAL', normalize(path)); },
    async writeFile(path, value, writeOptions = null) {
      const normalized = normalize(path);
      requireMutable(normalized);
      const parent = parentOf(normalized);
      if (!directories.has(parent)) throw fsError('ENOENT', parent);
      if (directories.has(normalized)) throw fsError('EISDIR', normalized);
      const encoding = typeof writeOptions === 'string' ? writeOptions : writeOptions?.encoding;
      files.set(normalized, { bytes: valueBytes(value, encoding === 'utf8' ? 'utf-8' : encoding || 'utf-8'), lastModified: Date.now() });
    },
    async unlink(path) {
      const normalized = normalize(path);
      requireMutable(normalized);
      if (!files.delete(normalized)) throw fsError(directories.has(normalized) ? 'EISDIR' : 'ENOENT', normalized);
    },
    async mkdir(path, mkdirOptions = null) {
      const normalized = normalize(path);
      requireMutable(normalized);
      if (files.has(normalized)) throw fsError('ENOTDIR', normalized);
      if (directories.has(normalized)) {
        if (mkdirOptions?.recursive) return normalized;
        throw fsError('EEXIST', normalized);
      }
      if (mkdirOptions?.recursive) {
        const parts = normalized.split('/').filter(Boolean);
        let directory = '';
        for (const part of parts) { directory += `/${part}`; if (files.has(directory)) throw fsError('ENOTDIR', directory); directories.add(directory); }
        return normalized;
      }
      const parent = parentOf(normalized);
      if (!directories.has(parent)) throw fsError('ENOENT', parent);
      directories.add(normalized);
      return normalized;
    },
    async rmdir(path) {
      const normalized = normalize(path);
      requireMutable(normalized);
      if (!directories.has(normalized)) throw fsError(files.has(normalized) ? 'ENOTDIR' : 'ENOENT', normalized);
      if (normalized === '/') throw fsError('EBUSY', normalized);
      const prefix = `${normalized}/`;
      if ([...directories, ...files.keys()].some((candidate) => candidate.startsWith(prefix))) throw fsError('ENOTEMPTY', normalized);
      directories.delete(normalized);
    },
    async rename(oldPath, newPath) {
      const source = normalize(oldPath);
      const target = normalize(newPath);
      requireMutable(source);
      const parent = parentOf(target);
      if (!directories.has(parent)) throw fsError('ENOENT', parent);
      if (files.has(source)) {
        const file = files.get(source);
        files.delete(source); files.delete(target); directories.delete(target); files.set(target, file); return;
      }
      if (!directories.has(source)) throw fsError('ENOENT', source);
      if (target === source || target.startsWith(`${source}/`)) throw fsError('EINVAL', target);
      const directoryMoves = [...directories].filter((candidate) => candidate === source || candidate.startsWith(`${source}/`));
      const fileMoves = [...files.entries()].filter(([candidate]) => candidate.startsWith(`${source}/`));
      for (const candidate of directoryMoves) directories.delete(candidate);
      for (const [candidate] of fileMoves) files.delete(candidate);
      for (const candidate of directoryMoves) directories.add(`${target}${candidate.slice(source.length)}`);
      for (const [candidate, file] of fileMoves) files.set(`${target}${candidate.slice(source.length)}`, file);
    },
    async chmod(path) { requireMutable(normalize(path)); statFor(path); },
    async utimes(path, _atime, mtime) { const normalized = normalize(path); requireMutable(normalized); const file = files.get(normalized); if (!file) throw fsError('ENOENT', normalized); file.lastModified = new Date(mtime).getTime(); },
    async copyFile(sourcePath, targetPath) { const bytes = await promises.readFile(sourcePath); await promises.writeFile(targetPath, bytes); },
    async rm(path, rmOptions = {}) {
      const normalized = normalize(path);
      requireMutable(normalized);
      if (files.has(normalized)) { files.delete(normalized); return; }
      if (!directories.has(normalized)) { if (rmOptions.force) return; throw fsError('ENOENT', normalized); }
      const prefix = `${normalized}/`;
      if (!rmOptions.recursive && [...directories, ...files.keys()].some((candidate) => candidate.startsWith(prefix))) throw fsError('ENOTEMPTY', normalized);
      for (const candidate of [...files.keys()]) if (candidate === normalized || candidate.startsWith(prefix)) files.delete(candidate);
      for (const candidate of [...directories]) if (candidate === normalized || candidate.startsWith(prefix)) directories.delete(candidate);
    },
    async symlink(path) { requireMutable(normalize(path)); throw fsError('ENOTSUP', normalize(path)); }
  };
  return {
    promises,
    snapshot() { return [...files.entries()].map(([path, file]) => ({ path, bytes: file.bytes.slice(), lastModified: file.lastModified })); }
  };
}

function gitVirtualPath(path) {
  const parts = String(path).replaceAll('\\', '/').split('/').filter(Boolean);
  if (!parts.length) return null;
  const relative = parts[0] === '.git' ? parts.join('/') : parts.slice(1).join('/');
  return `/repo/${relative || parts.at(-1)}`;
}

function gitStatusLabel(matrix) {
  const [, head, workdir, stage] = matrix;
  if (head === 1 && workdir === 1 && stage === 1) return 'unmodified';
  if (head === 0 && workdir === 2 && stage === 0) return 'untracked';
  if (head === 0 && workdir === 2 && stage === 2) return 'added';
  if (head === 1 && workdir === 2 && stage === 1) return 'modified';
  if (head === 1 && workdir === 0 && stage === 1) return 'deleted';
  if (stage === 2 || stage === 3) return 'staged';
  return `${head}/${workdir}/${stage}`;
}

export function entropyWindows(value, windowSize = 4 * KiB, maxWindows = 16_384) {
  const bytes = asBytes(value);
  if (!Number.isInteger(windowSize) || windowSize < 256 || windowSize > MiB) throw new RangeError('Entropy window must be 256 bytes to 1 MiB.');
  const result = [];
  for (let offset = 0; offset < bytes.length && result.length < maxWindows; offset += windowSize) {
    const slice = bytes.subarray(offset, Math.min(offset + windowSize, bytes.length));
    result.push({ offset, length: slice.length, entropy: shannonEntropy(slice) });
  }
  return result;
}

export function diffBytes(leftValue, rightValue, options = {}) {
  const left = asBytes(leftValue);
  const right = asBytes(rightValue);
  const maxBytes = options.maxBytes ?? 64 * MiB;
  const maxRuns = options.maxRuns ?? 10_000;
  const length = Math.max(left.length, right.length);
  if (length > maxBytes) throw new Error(`Binary diff core is capped at ${formatBytes(maxBytes)}.`);
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100_000) throw new Error('Binary diff maxRuns must be an integer between 1 and 100,000.');
  const runs = [];
  let current = null;
  let changedBytes = 0;
  let changedOverlapBytes = 0;
  let truncated = false;
  const overlap = Math.min(left.length, right.length);
  for (let offset = 0; offset < length; offset += 1) {
    const different = left[offset] !== right[offset];
    if (different) {
      changedBytes += 1;
      if (offset < overlap) changedOverlapBytes += 1;
      if (!current && runs.length < maxRuns) current = { offset, length: 0, left: [], right: [] };
      else if (!current) truncated = true;
      if (current) {
        current.length += 1;
        if (current.left.length < 64 && offset < left.length) current.left.push(left[offset]);
        if (current.right.length < 64 && offset < right.length) current.right.push(right[offset]);
      }
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  if (current && runs.length < maxRuns) runs.push(current);
  return {
    leftSize: left.length,
    rightSize: right.length,
    comparedBytes: length,
    changedBytes,
    equalBytes: overlap - changedOverlapBytes,
    truncated,
    runs: runs.map((run) => ({ ...run, leftHex: run.left.map((byte) => byte.toString(16).padStart(2, '0')).join(' '), rightHex: run.right.map((byte) => byte.toString(16).padStart(2, '0')).join(' '), left: undefined, right: undefined }))
  };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(bytes) {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += BASE64_ALPHABET[a >> 2];
    output += BASE64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)] : '=';
    output += index + 2 < bytes.length ? BASE64_ALPHABET[c & 63] : '=';
  }
  return output;
}

function base64ToBytes(value) {
  const source = String(value || '').replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source)) throw new Error('Patch contains invalid base64.');
  const output = [];
  for (let index = 0; index < source.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(source[index]);
    const b = BASE64_ALPHABET.indexOf(source[index + 1]);
    const c = source[index + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(source[index + 2]);
    const d = source[index + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(source[index + 3]);
    output.push((a << 2) | (b >> 4));
    if (source[index + 2] !== '=') output.push(((b & 15) << 4) | (c >> 2));
    if (source[index + 3] !== '=') output.push(((c & 3) << 6) | d);
  }
  return Uint8Array.from(output);
}

export function createBinaryPatch(leftValue, rightValue) {
  const left = asBytes(leftValue);
  const right = asBytes(rightValue);
  const diff = diffBytes(left, right);
  if (diff.truncated) throw new Error('Binary patch would exceed the retained change-run limit.');
  return {
    format: 'm13-binary-patch',
    version: 1,
    baseSize: left.length,
    targetSize: right.length,
    changes: diff.runs.map((run) => ({ offset: run.offset, data: bytesToBase64(right.subarray(run.offset, Math.min(run.offset + run.length, right.length))) }))
  };
}

export function applyBinaryPatch(baseValue, patch) {
  const base = asBytes(baseValue);
  if (!patch || patch.format !== 'm13-binary-patch' || patch.version !== 1) throw new Error('Unsupported binary patch format.');
  if (patch.baseSize !== base.length || !Number.isSafeInteger(patch.targetSize) || patch.targetSize < 0 || patch.targetSize > 64 * MiB) throw new Error('Patch size metadata does not match the base file or exceeds 64 MiB.');
  if (!Array.isArray(patch.changes) || patch.changes.length > 10_000) throw new Error('Patch changes must be an array of at most 10,000 ranges.');
  const output = new Uint8Array(patch.targetSize);
  output.set(base.subarray(0, Math.min(base.length, output.length)));
  let previousEnd = 0;
  for (const change of patch.changes) {
    if (!Number.isSafeInteger(change.offset) || change.offset < previousEnd || change.offset > output.length) throw new Error('Patch change offsets are invalid or overlap.');
    const data = base64ToBytes(change.data);
    if (change.offset + data.length > output.length) throw new Error('Patch change exceeds target size.');
    output.set(data, change.offset);
    previousEnd = change.offset + data.length;
  }
  return output;
}

function readUleb(bytes, start) {
  let value = 0;
  let shift = 0;
  let cursor = start;
  while (cursor < bytes.length && shift <= 35) {
    const byte = bytes[cursor++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return { value, next: cursor };
    shift += 7;
  }
  throw new Error('Invalid WebAssembly LEB128 integer.');
}

export function parseWasmSections(value) {
  const bytes = asBytes(value);
  if (bytes.length < 8 || !matches(bytes, 0, [0x00, 0x61, 0x73, 0x6d])) throw new Error('Not a WebAssembly module.');
  const version = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (version !== 1) throw new Error(`Unsupported WebAssembly binary version ${version}.`);
  const names = ['custom', 'type', 'import', 'function', 'table', 'memory', 'global', 'export', 'start', 'element', 'code', 'data', 'data-count', 'tag'];
  const sections = [];
  let cursor = 8;
  while (cursor < bytes.length) {
    const id = bytes[cursor++];
    const decoded = readUleb(bytes, cursor);
    cursor = decoded.next;
    if (cursor + decoded.value > bytes.length) throw new Error('WebAssembly section exceeds the module length.');
    sections.push({ id, name: names[id] || `unknown-${id}`, offset: cursor, size: decoded.value });
    cursor += decoded.value;
  }
  return { version, sections };
}

export function inspectWasmModule(value, WebAssemblyProvider = globalThis.WebAssembly) {
  const bytes = asBytes(value);
  const parsed = parseWasmSections(bytes);
  if (!WebAssemblyProvider?.Module) return { ...parsed, validated: false, imports: [], exports: [], reason: 'WebAssembly.Module is unavailable.' };
  try {
    const module = new WebAssemblyProvider.Module(bytes);
    return { ...parsed, validated: true, imports: WebAssemblyProvider.Module.imports(module), exports: WebAssemblyProvider.Module.exports(module) };
  } catch (error) {
    return { ...parsed, validated: false, imports: [], exports: [], reason: error.message };
  }
}

export function buildPreviewDocument({ html = '', css = '', javascript = '' } = {}) {
  const safeScript = String(javascript).replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><meta name="viewport" content="width=device-width"><style>html{font-family:system-ui;color-scheme:light dark;padding:1rem}${String(css)}</style></head><body>${String(html)}<pre id="m13-error" role="alert"></pre><script>addEventListener('error',e=>{document.querySelector('#m13-error').textContent=e.message});addEventListener('unhandledrejection',e=>{document.querySelector('#m13-error').textContent=String(e.reason)});${safeScript}<\/script></body></html>`;
}

function ipv4(bytes, offset) { return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`; }
function ipv6(bytes, offset) {
  const parts = [];
  for (let index = 0; index < 16; index += 2) parts.push(((bytes[offset + index] << 8) | bytes[offset + index + 1]).toString(16));
  return parts.join(':');
}
function mac(bytes, offset) { return [...bytes.subarray(offset, offset + 6)].map((byte) => byte.toString(16).padStart(2, '0')).join(':'); }

function parseDnsName(bytes, start, packetStart, packetEnd) {
  const labels = [];
  let cursor = start;
  let consumed = 0;
  let jumps = 0;
  let jumped = false;
  while (cursor < packetEnd && jumps < 16) {
    const length = bytes[cursor];
    if (length === 0) { if (!jumped) consumed += 1; return { name: labels.join('.'), consumed }; }
    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= packetEnd) break;
      const pointer = packetStart + (((length & 0x3f) << 8) | bytes[cursor + 1]);
      if (!jumped) consumed += 2;
      cursor = pointer;
      jumped = true;
      jumps += 1;
      continue;
    }
    if (length > 63 || cursor + 1 + length > packetEnd) break;
    labels.push(ascii(bytes, cursor + 1, cursor + 1 + length));
    if (!jumped) consumed += length + 1;
    cursor += length + 1;
  }
  return { name: labels.join('.'), consumed: consumed || 1 };
}

export function decodeNetworkPacket(value, linkType = 1) {
  const bytes = asBytes(value);
  let cursor = 0;
  const result = { linkType, protocol: 'Unknown', source: '', destination: '', sourcePort: null, destinationPort: null, info: '' };
  if (linkType === 1) {
    if (bytes.length < 14) return { ...result, protocol: 'Truncated Ethernet', info: `${bytes.length} bytes` };
    result.source = mac(bytes, 6);
    result.destination = mac(bytes, 0);
    let etherType = (bytes[12] << 8) | bytes[13];
    cursor = 14;
    if ((etherType === 0x8100 || etherType === 0x88a8) && bytes.length >= 18) { etherType = (bytes[16] << 8) | bytes[17]; cursor = 18; }
    if (etherType === 0x0806) return { ...result, protocol: 'ARP', info: 'Address Resolution Protocol' };
    if (etherType !== 0x0800 && etherType !== 0x86dd) return { ...result, protocol: `EtherType 0x${etherType.toString(16).padStart(4, '0')}`, info: `${bytes.length} bytes` };
  } else if (linkType === 101) cursor = 0;
  else return { ...result, protocol: `Link type ${linkType}`, info: `${bytes.length} bytes` };
  const version = bytes[cursor] >> 4;
  let protocol;
  let transport;
  if (version === 4) {
    if (bytes.length < cursor + 20) return { ...result, protocol: 'Truncated IPv4', info: `${bytes.length} bytes` };
    const headerLength = (bytes[cursor] & 0x0f) * 4;
    if (headerLength < 20 || cursor + headerLength > bytes.length) return { ...result, protocol: 'Invalid IPv4', info: 'Invalid header length' };
    protocol = bytes[cursor + 9];
    result.source = ipv4(bytes, cursor + 12);
    result.destination = ipv4(bytes, cursor + 16);
    const fragmentField = (bytes[cursor + 6] << 8) | bytes[cursor + 7];
    const fragmentOffset = (fragmentField & 0x1fff) * 8;
    if (fragmentOffset) return { ...result, protocol: 'IPv4 fragment', info: `offset ${fragmentOffset} bytes; protocol ${protocol}` };
    transport = cursor + headerLength;
  } else if (version === 6) {
    if (bytes.length < cursor + 40) return { ...result, protocol: 'Truncated IPv6', info: `${bytes.length} bytes` };
    protocol = bytes[cursor + 6];
    result.source = ipv6(bytes, cursor + 8);
    result.destination = ipv6(bytes, cursor + 24);
    transport = cursor + 40;
    if ([0, 43, 44, 50, 51, 60, 135, 139, 140].includes(protocol)) return { ...result, protocol: `IPv6 extension ${protocol}`, info: 'Extension-chain dissection is outside this bounded parser.' };
  } else return { ...result, protocol: 'Unknown IP version', info: `${bytes.length} bytes` };
  if (protocol === 6 && bytes.length >= transport + 20) {
    result.sourcePort = (bytes[transport] << 8) | bytes[transport + 1];
    result.destinationPort = (bytes[transport + 2] << 8) | bytes[transport + 3];
    const tcpHeaderLength = (bytes[transport + 12] >> 4) * 4;
    if (tcpHeaderLength < 20 || transport + tcpHeaderLength > bytes.length) return { ...result, protocol: 'Invalid TCP', info: 'Invalid header length' };
    const flagByte = bytes[transport + 13];
    const flags = [[0x02, 'SYN'], [0x10, 'ACK'], [0x01, 'FIN'], [0x04, 'RST'], [0x08, 'PSH'], [0x20, 'URG']].filter(([bit]) => flagByte & bit).map(([, label]) => label);
    return { ...result, protocol: 'TCP', info: `${result.sourcePort} → ${result.destinationPort} ${flags.join(',')}`.trim() };
  }
  if (protocol === 17 && bytes.length >= transport + 8) {
    result.sourcePort = (bytes[transport] << 8) | bytes[transport + 1];
    result.destinationPort = (bytes[transport + 2] << 8) | bytes[transport + 3];
    const udpLength = (bytes[transport + 4] << 8) | bytes[transport + 5];
    if (udpLength < 8 || transport + udpLength > bytes.length) return { ...result, protocol: 'Invalid UDP', info: `declared length ${udpLength}` };
    result.protocol = result.sourcePort === 53 || result.destinationPort === 53 ? 'DNS' : 'UDP';
    result.info = `${result.sourcePort} → ${result.destinationPort}`;
    if (result.protocol === 'DNS' && bytes.length >= transport + 20) {
      const queryCount = (bytes[transport + 12] << 8) | bytes[transport + 13];
      if (queryCount) {
        const dns = parseDnsName(bytes, transport + 20, transport + 8, Math.min(bytes.length, transport + udpLength));
        if (dns.name) result.info += ` ${dns.name}`;
      }
    }
    return result;
  }
  if (protocol === 1 || protocol === 58) return { ...result, protocol: protocol === 58 ? 'ICMPv6' : 'ICMP', info: bytes.length >= transport + 2 ? `type ${bytes[transport]}, code ${bytes[transport + 1]}` : 'truncated' };
  return { ...result, protocol: `${version === 6 ? 'IPv6' : 'IPv4'} protocol ${protocol}`, info: `${bytes.length} bytes` };
}

export function parsePcap(value, options = {}) {
  const bytes = asBytes(value);
  const maxPackets = options.maxPackets ?? 20_000;
  const maxCapturedBytes = options.maxCapturedBytes ?? 256 * MiB;
  if (!Number.isInteger(maxPackets) || maxPackets < 1 || maxPackets > 1_000_000) throw new Error('PCAP maxPackets must be an integer between 1 and 1,000,000.');
  if (!Number.isSafeInteger(maxCapturedBytes) || maxCapturedBytes < 1 || maxCapturedBytes > 2 * GiB) throw new Error('PCAP maxCapturedBytes must be between 1 byte and 2 GiB.');
  if (bytes.length < 24) throw new Error('Capture is too short for a PCAP header.');
  if (matches(bytes, 0, [0x0a, 0x0d, 0x0d, 0x0a])) return parsePcapNg(bytes, { maxPackets, maxCapturedBytes });
  let littleEndian;
  let nanoseconds = false;
  if (matches(bytes, 0, [0xd4, 0xc3, 0xb2, 0xa1])) littleEndian = true;
  else if (matches(bytes, 0, [0xa1, 0xb2, 0xc3, 0xd4])) littleEndian = false;
  else if (matches(bytes, 0, [0x4d, 0x3c, 0xb2, 0xa1])) { littleEndian = true; nanoseconds = true; }
  else if (matches(bytes, 0, [0xa1, 0xb2, 0x3c, 0x4d])) { littleEndian = false; nanoseconds = true; }
  else throw new Error('Unknown PCAP magic number.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = view.getUint16(4, littleEndian);
  const minor = view.getUint16(6, littleEndian);
  const snapLength = view.getUint32(16, littleEndian);
  const linkType = view.getUint32(20, littleEndian);
  if (major !== 2 || snapLength < 1 || snapLength > 16 * MiB) throw new Error('Unsupported or invalid PCAP global header.');
  const packets = [];
  let cursor = 24;
  let capturedBytes = 0;
  let truncated = false;
  while (cursor < bytes.length) {
    if (cursor + 16 > bytes.length) throw new Error(`Truncated PCAP packet header at offset ${cursor}.`);
    const seconds = view.getUint32(cursor, littleEndian);
    const fraction = view.getUint32(cursor + 4, littleEndian);
    const includedLength = view.getUint32(cursor + 8, littleEndian);
    const originalLength = view.getUint32(cursor + 12, littleEndian);
    cursor += 16;
    if (fraction >= (nanoseconds ? 1e9 : 1e6) || includedLength > snapLength || includedLength > originalLength || cursor + includedLength > bytes.length) throw new Error(`Invalid PCAP packet length or timestamp at offset ${cursor - 16}.`);
    if (packets.length >= maxPackets || capturedBytes + includedLength > maxCapturedBytes) { truncated = true; break; }
    const decoded = decodeNetworkPacket(bytes.subarray(cursor, cursor + includedLength), linkType);
    packets.push({ index: packets.length + 1, timestampSeconds: seconds + fraction / (nanoseconds ? 1e9 : 1e6), includedLength, originalLength, ...decoded });
    capturedBytes += includedLength;
    cursor += includedLength;
  }
  return { format: 'pcap', version: `${major}.${minor}`, littleEndian, nanoseconds, snapLength, linkTypes: [linkType], packets, capturedBytes, truncated };
}

function parsePcapNg(bytes, { maxPackets, maxCapturedBytes }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 28) throw new Error('PCAPNG section header is truncated.');
  let littleEndian = null;
  let interfaces = [];
  const allInterfaces = [];
  const packets = [];
  let cursor = 0;
  let capturedBytes = 0;
  let truncated = false;
  let sections = 0;
  let blockCount = 0;
  const timestampResolution = (start, end, endian) => {
    let resolution = 1e-6;
    let option = start;
    while (option + 4 <= end) {
      const code = view.getUint16(option, endian);
      const length = view.getUint16(option + 2, endian);
      option += 4;
      if (code === 0) break;
      if (option + length > end) throw new Error(`Invalid PCAPNG option at offset ${option - 4}.`);
      if (code === 9 && length === 1) {
        const encoded = bytes[option];
        const exponent = encoded & 0x7f;
        if (exponent > 63) throw new Error('PCAPNG timestamp resolution exponent is unsupported.');
        resolution = 1 / ((encoded & 0x80) ? 2 ** exponent : 10 ** exponent);
      }
      option += Math.ceil(length / 4) * 4;
    }
    return resolution;
  };
  while (cursor + 12 <= bytes.length) {
    if (++blockCount > 1_000_000) throw new Error('PCAPNG exceeds the 1,000,000-block structural cap.');
    const sectionHeader = matches(bytes, cursor, [0x0a, 0x0d, 0x0d, 0x0a]);
    if (sectionHeader) {
      if (cursor + 28 > bytes.length) throw new Error(`Truncated PCAPNG section header at offset ${cursor}.`);
      const bomBytes = [...bytes.subarray(cursor + 8, cursor + 12)].join(',');
      if (bomBytes === '77,60,43,26') littleEndian = true;
      else if (bomBytes === '26,43,60,77') littleEndian = false;
      else throw new Error(`PCAPNG byte-order magic is invalid at offset ${cursor}.`);
    } else if (littleEndian == null) throw new Error('PCAPNG must begin with a Section Header Block.');
    const type = view.getUint32(cursor, littleEndian);
    const length = view.getUint32(cursor + 4, littleEndian);
    if (length < 12 || length % 4 || cursor + length > bytes.length || view.getUint32(cursor + length - 4, littleEndian) !== length) throw new Error(`Invalid PCAPNG block at offset ${cursor}.`);
    if (sectionHeader) {
      if (length < 28) throw new Error(`Invalid PCAPNG section length at offset ${cursor}.`);
      const major = view.getUint16(cursor + 12, littleEndian);
      if (major !== 1) throw new Error(`Unsupported PCAPNG major version ${major}.`);
      sections += 1;
      interfaces = [];
      cursor += length;
      continue;
    }
    if (type === 1) {
      if (length < 20) throw new Error(`Truncated PCAPNG interface block at offset ${cursor}.`);
      const network = {
        linkType: view.getUint16(cursor + 8, littleEndian),
        snapLength: view.getUint32(cursor + 12, littleEndian),
        timestampResolution: timestampResolution(cursor + 16, cursor + length - 4, littleEndian)
      };
      if (!network.snapLength || network.snapLength > 16 * MiB) throw new Error(`Invalid PCAPNG snap length at offset ${cursor}.`);
      interfaces.push(network); allInterfaces.push(network);
    }
    if (type === 6 && length >= 32) {
      const interfaceId = view.getUint32(cursor + 8, littleEndian);
      const high = view.getUint32(cursor + 12, littleEndian);
      const low = view.getUint32(cursor + 16, littleEndian);
      const includedLength = view.getUint32(cursor + 20, littleEndian);
      const originalLength = view.getUint32(cursor + 24, littleEndian);
      const dataStart = cursor + 28;
      const network = interfaces[interfaceId];
      if (!network) throw new Error(`PCAPNG packet references missing interface ${interfaceId}.`);
      if (includedLength > network.snapLength || includedLength > originalLength || dataStart + Math.ceil(includedLength / 4) * 4 > cursor + length - 4) throw new Error(`Truncated or invalid PCAPNG packet at offset ${cursor}.`);
      if (packets.length >= maxPackets || capturedBytes + includedLength > maxCapturedBytes) { truncated = true; break; }
      const decoded = decodeNetworkPacket(bytes.subarray(dataStart, dataStart + includedLength), network.linkType);
      packets.push({ index: packets.length + 1, timestampSeconds: (high * 2 ** 32 + low) * network.timestampResolution, includedLength, originalLength, ...decoded });
      capturedBytes += includedLength;
    }
    if (type === 3) {
      const network = interfaces[0];
      if (!network || length < 16) throw new Error(`PCAPNG simple packet has no interface or is truncated at offset ${cursor}.`);
      const originalLength = view.getUint32(cursor + 8, littleEndian);
      const includedLength = Math.min(originalLength, network.snapLength);
      const dataStart = cursor + 12;
      if (dataStart + Math.ceil(includedLength / 4) * 4 > cursor + length - 4) throw new Error(`Truncated PCAPNG simple packet at offset ${cursor}.`);
      if (packets.length >= maxPackets || capturedBytes + includedLength > maxCapturedBytes) { truncated = true; break; }
      const decoded = decodeNetworkPacket(bytes.subarray(dataStart, dataStart + includedLength), network.linkType);
      packets.push({ index: packets.length + 1, timestampSeconds: null, includedLength, originalLength, ...decoded });
      capturedBytes += includedLength;
    }
    cursor += length;
  }
  if (!truncated && cursor !== bytes.length) throw new Error(`Trailing PCAPNG bytes at offset ${cursor}.`);
  let snapLength = 0;
  for (const item of allInterfaces) if (item.snapLength > snapLength) snapLength = item.snapLength;
  return { format: 'pcapng', version: '1.x', sections, littleEndian, nanoseconds: allInterfaces.some((item) => item.timestampResolution === 1e-9), snapLength, linkTypes: [...new Set(allInterfaces.map((item) => item.linkType))], packets, capturedBytes, truncated };
}

function optionMarkup(values, selected = '') {
  return values.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
}

function setSelectOptions(select, columns, placeholder = '—') {
  const doc = select.ownerDocument;
  select.replaceChildren();
  const empty = doc.createElement('option');
  empty.value = '';
  empty.textContent = placeholder;
  select.append(empty);
  for (const column of columns) {
    const option = doc.createElement('option');
    option.value = column;
    option.textContent = column;
    select.append(option);
  }
}

function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < -8.64e12 || seconds > 8.64e12) return '—';
  try { return new Date(seconds * 1_000).toISOString(); } catch (_) { return String(seconds); }
}

function redactRemoteUrl(value) {
  const source = String(value || '');
  try {
    const url = new URL(source);
    url.username = url.username ? '[redacted]' : '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
    return url.toString();
  } catch (_) {
    return source.replace(/^(https?:\/\/)[^/@]+@/i, '$1[redacted]@').replace(/([?&])[^=&#]+=[^&#]*/g, '$1[redacted]');
  }
}

export function sanitizeGitConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const sensitiveKey = /(?:authorization|cookie|credential|email|extraheader|oauth|password|private|secret|signingkey|token)/i;
  const sections = (config.sections || []).map((section) => {
    const values = Object.fromEntries(Object.entries(section.values || {}).map(([key, value]) => {
      if (sensitiveKey.test(key)) return [key, '[redacted]'];
      if (/^(?:url|pushurl)$/i.test(key)) return [key, redactRemoteUrl(value)];
      return [key, value];
    }));
    return { name: section.name, subsection: section.subsection, values };
  });
  return {
    sections,
    remotes: (config.remotes || []).map((remote) => ({ ...remote, url: redactRemoteUrl(remote.url) })),
    identity: config.identity?.email ? { ...config.identity, email: '[redacted]' } : { ...(config.identity || {}) },
    core: { ...(config.core || {}) }
  };
}

function runSuiteWorker(kind, payload, timeoutMs, cleanup) {
  if (typeof Worker !== 'function') return Promise.reject(new Error('Module workers are unavailable in this browser.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./data-developer/worker.js', import.meta.url), { type: 'module' });
    cleanup?.add(() => worker.terminate());
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error(`Operation stopped after ${timeoutMs} ms.`)); }, timeoutMs);
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      if (event.data?.ok) resolve(event.data.result);
      else reject(new Error(event.data?.error || 'Worker operation failed.'));
    };
    worker.onerror = () => { clearTimeout(timeout); worker.terminate(); reject(new Error('The isolated worker could not run.')); };
    worker.postMessage({ kind, payload });
  });
}

function loadClassicRuntime(root, src, globalName) {
  if (globalThis[globalName]) return Promise.resolve(globalThis[globalName]);
  if (runtimePromises.has(src)) return runtimePromises.get(src);
  const promise = new Promise((resolve, reject) => {
    const doc = root.ownerDocument;
    const script = doc.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.suiteRuntime = globalName;
    script.onload = () => globalThis[globalName] ? resolve(globalThis[globalName]) : reject(new Error(`${globalName} did not initialize.`));
    script.onerror = () => reject(new Error(`Could not load the local runtime ${src}.`));
    doc.head.append(script);
  });
  runtimePromises.set(src, promise);
  promise.catch(() => runtimePromises.delete(src));
  return promise;
}

async function loadSqliteRuntime(root) {
  const initSqlJs = await loadClassicRuntime(root, '/vendor/sqlite/sql-wasm.js', 'initSqlJs');
  return initSqlJs({ locateFile: (file) => `/vendor/sqlite/${file}` });
}

function runSqliteStatement(database, sql, maximumRows = 10_000) {
  const source = String(sql || '').trim();
  if (!source || source.length > 64 * KiB) throw new Error('SQLite statement must contain 1-65,536 characters.');
  const statement = database.prepare(source);
  const rows = [];
  let truncated = false;
  try {
    while (statement.step()) {
      if (rows.length >= maximumRows) { truncated = true; break; }
      rows.push(normalizeRuntimeValue(statement.getAsObject()));
    }
    return { rows, columns: statement.getColumnNames(), rowsModified: database.getRowsModified(), truncated };
  } finally { statement.free(); }
}

export function isReadOnlySqliteStatement(sql) {
  const source = String(sql || '').replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/g, '').trim();
  const pragma = source.match(/^PRAGMA\s+(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)(?:\s*\([^;]*\))?\s*;?$/i);
  if (pragma) {
    const readOnlyPragmas = new Set(['application_id', 'collation_list', 'compile_options', 'database_list', 'encoding', 'foreign_key_check', 'foreign_key_list', 'freelist_count', 'function_list', 'index_info', 'index_list', 'index_xinfo', 'integrity_check', 'module_list', 'page_count', 'page_size', 'pragma_list', 'quick_check', 'schema_version', 'table_info', 'table_list', 'table_xinfo', 'user_version']);
    return readOnlyPragmas.has(pragma[1].toLowerCase()) && !/=/.test(source);
  }
  if (!/^(?:SELECT|WITH|EXPLAIN)\b/i.test(source)) return false;
  const lexical = source.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:""|[^"])*"/g, '""').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return !/\b(?:ALTER|ATTACH|CREATE|DELETE|DETACH|DROP|INSERT|REINDEX|REPLACE|UPDATE|VACUUM)\b/i.test(lexical);
}

function normalizeRuntimeValue(value, depth = 0) {
  if (depth > 8) return '[depth limit]';
  if (typeof value === 'bigint') return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `0x${[...value.subarray(0, 256)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}${value.length > 256 ? '…' : ''}`;
  if (Array.isArray(value)) return value.map((item) => normalizeRuntimeValue(item, depth + 1));
  if (value && typeof value.toJSON === 'function') {
    const serialized = value.toJSON();
    if (serialized !== value) {
      if (typeof serialized === 'string' && /^"(?:[^"\\]|\\.)*"$/.test(serialized)) {
        try { return JSON.parse(serialized); } catch (_) { /* retain the runtime representation */ }
      }
      return normalizeRuntimeValue(serialized, depth + 1);
    }
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeRuntimeValue(item, depth + 1)]));
  return value;
}

async function openDuckDb(cleanup) {
  const duckdb = await import('/vendor/suite/duckdb.js');
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: '/vendor/duckdb/duckdb-mvp.wasm', mainWorker: '/vendor/duckdb/duckdb-browser-mvp.worker.js' },
    eh: { mainModule: '/vendor/duckdb/duckdb-eh.wasm', mainWorker: '/vendor/duckdb/duckdb-browser-eh.worker.js' }
  });
  const worker = new Worker(bundle.mainWorker);
  const database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  let connection = null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await connection?.close(); } catch (_) { /* best effort */ }
    try { await database.terminate(); } catch (_) { /* best effort */ }
    worker.terminate();
  };
  try {
    await database.instantiate(bundle.mainModule, bundle.pthreadWorker || undefined);
    connection = await database.connect();
    cleanup.add(() => { void close(); });
    return { duckdb, database, connection, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function arrowTableRows(table, maximum = 10_001) {
  const fields = table?.schema?.fields?.map((field) => field.name) || [];
  const rows = [];
  let index = 0;
  for (const arrowRow of table || []) {
    if (index++ >= maximum) break;
    const raw = typeof arrowRow?.toJSON === 'function' ? arrowRow.toJSON() : Object.fromEntries(fields.map((field, column) => [field, arrowRow?.[column]]));
    rows.push(normalizeRuntimeValue(raw));
  }
  return rows;
}

export function buildReadOnlyDuckQuery(sql) {
  const source = String(sql || '').trim().replace(/;\s*$/, '');
  if (!source || source.length > 64 * KiB) throw new Error('DuckDB query must contain 1-65,536 characters.');
  if (!/^(?:SELECT|WITH)\b/i.test(source)) throw new Error('This local DuckDB surface accepts read-only SELECT or WITH queries.');
  const lexical = source.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:""|[^"])*"/g, '""').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\b(?:ALTER|ATTACH|CALL|COPY|CREATE|DELETE|DETACH|DROP|EXPORT|IMPORT|INSERT|INSTALL|LOAD|PRAGMA|REPLACE|SET|UPDATE|VACUUM)\b/i.test(lexical)) {
    throw new Error('This local DuckDB surface accepts read-only SELECT or WITH queries.');
  }
  if (/(?:https?|s3|file):\/\//i.test(lexical) || /\b(?:read_[a-z0-9_]*|[a-z0-9_]*_scan|glob|query_table|query_table_range)\s*\(/i.test(lexical)) {
    throw new Error('DuckDB queries may read only the prepared local data view. External paths and scan functions are disabled.');
  }
  return `SELECT * FROM (${source}) AS __m13_result LIMIT 10001`;
}

export function buildDuckDatasetSourceSql(format, registeredName = 'input.data') {
  const name = String(registeredName || '');
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(name)) throw new Error('DuckDB virtual filename is invalid.');
  if (format === 'parquet') return `read_parquet('${name}')`;
  if (format === 'json') return `read_json_auto('${name}', format='auto')`;
  if (format === 'ndjson') return `read_json_auto('${name}', format='newline_delimited')`;
  if (format === 'tsv') return `read_csv_auto('${name}', header=true, delim='\\t')`;
  if (format === 'csv') return `read_csv_auto('${name}', header=true)`;
  throw new Error(`Unsupported DuckDB dataset format: ${format}.`);
}

function createPythonRunner(cleanup) {
  let worker = null;
  let sequence = 0;
  const pending = new Map();
  const ensure = () => {
    if (worker) return worker;
    if (typeof Worker !== 'function') throw new Error('Module workers are unavailable in this browser.');
    worker = new Worker(new URL('./data-developer/python-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const request = pending.get(event.data?.id);
      if (!request) return;
      pending.delete(event.data.id); clearTimeout(request.timeout);
      if (event.data.ok) request.resolve(event.data.result); else request.reject(new Error(event.data.error || 'Python worker failed.'));
    };
    worker.onerror = () => {
      for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('The Python worker crashed.')); }
      pending.clear(); worker?.terminate(); worker = null;
    };
    return worker;
  };
  cleanup.add(() => { worker?.terminate(); worker = null; for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Notebook closed.')); } pending.clear(); });
  return (source, data, timeoutMs = 45_000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const target = ensure();
    const timeout = setTimeout(() => { target.terminate(); worker = null; pending.delete(id); reject(new Error(`Python cell stopped after ${Math.round(timeoutMs / 1_000)} seconds.`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    target.postMessage({ id, source, data });
  });
}

async function imageDifferenceHash(file, root) {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap is unavailable.');
  if (file.size > 64 * MiB) throw new Error('image exceeds 64 MiB decode cap');
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 40_000_000 / bitmap.height) throw new Error('image exceeds 40 megapixel decode cap');
    const canvas = root.ownerDocument.createElement('canvas');
    canvas.width = 9; canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas is unavailable.');
    context.drawImage(bitmap, 0, 0, 9, 8);
    return differenceHashFromRgba(context.getImageData(0, 0, 9, 8).data, 9, 8);
  } finally { bitmap.close(); }
}

function mountFileInspector(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'file-inspector', title: 'Inspect a file', titlePt: 'Inspecionar um arquivo', badge: 'Bounded byte view', badgePt: 'Visão de bytes limitada', results: 'File anatomy', resultsPt: 'Anatomia do arquivo',
    controls: `<label class="field-label" for="inspector-file">${t('Local file', 'Arquivo local')}</label><input class="file-input" id="inspector-file" type="file" required data-file>
      <label class="field-label" for="inspector-offset">${t('Hex offset (decimal)', 'Offset hexadecimal (decimal)')}</label><input class="number-input" id="inspector-offset" type="number" min="0" step="1" value="0" data-offset>
      <label class="check-row"><input type="checkbox" data-hash> ${t('Calculate SHA-256 (files up to 512 MiB)', 'Calcular SHA-256 (arquivos de até 512 MiB)')}</label>
      <button class="button button-primary" type="submit">${t('Inspect bytes', 'Inspecionar bytes')}</button><p class="field-help">${t('Signature and entropy inspect at most 8 MiB; strings at most 8 MiB; hex shows 2 KiB from the chosen offset. File contents never leave this page.', 'Assinatura e entropia inspecionam até 8 MiB; strings até 8 MiB; o hexadecimal mostra 2 KiB do offset escolhido. O conteúdo não sai desta página.')}</p>`,
    output: `<h3>${t('Recognized binary structure', 'Estrutura binária reconhecida')}</h3><pre class="code-output" data-structure></pre><h3>${t('Entropy map', 'Mapa de entropia')}</h3><div class="bar-chart" role="img" data-entropy-map></div><h3>${t('Hex view', 'Visão hexadecimal')}</h3><pre class="code-output" data-hex></pre><h3>${t('Extracted ASCII strings', 'Strings ASCII extraídas')}</h3><div class="table-scroll" role="region" tabindex="0" aria-label="${t('Extracted strings', 'Strings extraídas')}"><table class="data-table"><caption>${t('First 200 retained strings', 'Primeiras 200 strings retidas')}</caption><thead><tr><th>${t('Offset', 'Offset')}</th><th>${t('Length', 'Tamanho')}</th><th>${t('Text', 'Texto')}</th></tr></thead><tbody data-strings></tbody></table></div>`,
    empty: 'Select any local file to inspect its signature, byte distribution, printable strings, and a bounded hex window.', emptyPt: 'Selecione um arquivo local para inspecionar assinatura, distribuição de bytes, strings imprimíveis e uma janela hexadecimal limitada.', action: 'Download report', actionPt: 'Baixar relatório'
  });
  let report = null;
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = root.querySelector('[data-file]').files[0];
    if (!file) return;
    if (file.size > 8 * GiB) { status(ui.status, t('Files larger than 8 GiB are outside this inspector’s browser-safe scope.', 'Arquivos maiores que 8 GiB estão fora do limite seguro deste inspetor.'), 'error'); return; }
    const offset = Number(root.querySelector('[data-offset]').value);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) { status(ui.status, t('Enter an offset inside the file.', 'Informe um offset dentro do arquivo.'), 'error'); return; }
    status(ui.status, t('Reading bounded slices locally…', 'Lendo fatias limitadas localmente…'));
    try {
      const sample = new Uint8Array(await file.slice(0, Math.min(file.size, 8 * MiB)).arrayBuffer());
      const hexBytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 2 * KiB)).arrayBuffer());
      const type = detectFileType(sample, file.name);
      const strings = extractAsciiStrings(sample, 4, 1_000);
      const structure = inspectKnownBinaryStructure(sample, file.name);
      const entropyWindowSize = Math.max(256, Math.min(256 * KiB, Math.ceil(Math.max(1, sample.length) / 96 / 256) * 256));
      const entropyMap = entropyWindows(sample, entropyWindowSize, 96);
      let digest = null;
      if (root.querySelector('[data-hash]').checked) {
        if (file.size > 512 * MiB) throw new Error(t('SHA-256 is capped at 512 MiB to avoid a full-file memory copy.', 'SHA-256 é limitado a 512 MiB para evitar uma cópia integral em memória.'));
        digest = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
      }
      report = { name: file.name, size: file.size, lastModified: file.lastModified, type, entropy: shannonEntropy(sample), sampledBytes: sample.length, entropyWindowSize, entropyMap, structure, sha256: digest, strings };
      renderMetrics(root, [[t('Type', 'Tipo'), type.label], [t('Size', 'Tamanho'), formatBytes(file.size)], [t('Entropy', 'Entropia'), `${report.entropy.toFixed(4)} / 8`], ['SHA-256', digest ? `${digest.slice(0, 16)}…` : t('Not requested', 'Não solicitado')]]);
      root.querySelector('[data-structure]').textContent = JSON.stringify(structure, null, 2);
      const entropyRoot = root.querySelector('[data-entropy-map]');
      entropyRoot.setAttribute('aria-label', t(`Entropy across ${entropyMap.length} bounded windows; zero is uniform and eight is maximally varied.`, `Entropia em ${entropyMap.length} janelas limitadas; zero é uniforme e oito é variação máxima.`));
      const doc = root.ownerDocument;
      entropyRoot.replaceChildren(...entropyMap.map((item) => {
        const line = doc.createElement('div');
        const label = doc.createElement('span');
        const track = doc.createElement('i');
        const bar = doc.createElement('b');
        label.textContent = `0x${item.offset.toString(16)} · ${item.entropy.toFixed(3)}`;
        bar.style.width = `${Math.max(0, Math.min(100, item.entropy / 8 * 100))}%`;
        track.append(bar); line.append(label, track); return line;
      }));
      root.querySelector('[data-hex]').textContent = makeHexRows(hexBytes, 0, hexBytes.length).map((row) => `${(offset + row.offset).toString(16).padStart(8, '0')}  ${row.hex.padEnd(47)}  |${row.text}|`).join('\n');
      renderTable(root.querySelector('[data-strings]'), strings.slice(0, 200).map((item) => [`0x${item.offset.toString(16)}`, item.length, item.text]));
      ui.download.disabled = false;
      toggleResult(root, true);
      status(ui.status, t(`Inspection complete. ${formatBytes(sample.length)} sampled; ${strings.length.toLocaleString()} strings retained.`, `Inspeção concluída. ${formatBytes(sample.length)} amostrados; ${strings.length.toLocaleString()} strings retidas.`), 'success');
      root.querySelector('#file-inspector-results-title').focus();
    } catch (error) { report = null; ui.download.disabled = true; toggleResult(root, false); status(ui.status, error.message, 'error'); }
  });
  ui.download.addEventListener('click', () => report && downloadBytes(root, JSON.stringify(report, null, 2), `${safeName(report.name)}.inspection.json`, 'application/json'));
  cleanup.add(() => { report = null; });
}

function mountFileDeduplicator(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'file-deduplicator', title: 'Find duplicate files', titlePt: 'Encontrar arquivos duplicados', badge: 'SHA-256 + dHash', badgePt: 'SHA-256 + dHash', results: 'Duplicate groups', resultsPt: 'Grupos duplicados',
    controls: `<label class="field-label" for="dedupe-folder">${t('Folder', 'Pasta')}</label><input class="file-input" id="dedupe-folder" type="file" webkitdirectory multiple required data-files>
      <label class="check-row"><input type="checkbox" checked data-visual> ${t('Also compare up to 500 decodable images by 64-bit difference hash', 'Também comparar até 500 imagens decodificáveis por difference hash de 64 bits')}</label>
      <button class="button button-primary" type="submit">${t('Index and hash candidates', 'Indexar e calcular hashes')}</button><progress class="workbench-progress" max="1" value="0" hidden data-progress></progress><p class="field-help">${t('Maximum 20,000 files, 4 GiB total, and 512 MiB per SHA-256 candidate. Exact hashing reads only same-size candidates. Image decoding is capped at 64 MiB and 40 megapixels. No files are deleted.', 'Máximo de 20.000 arquivos, 4 GiB no total e 512 MiB por candidato SHA-256. O hash exato lê apenas candidatos de mesmo tamanho. A decodificação de imagem é limitada a 64 MiB e 40 megapixels. Nenhum arquivo é excluído.')}</p>`,
    output: `<div class="table-scroll" role="region" tabindex="0" aria-label="${t('Exact and visual duplicate groups', 'Grupos de duplicatas exatas e visuais')}"><table class="data-table"><caption>${t('Exact groups are byte-identical; visual groups are heuristic and require review', 'Grupos exatos são idênticos em bytes; grupos visuais são heurísticos e exigem revisão')}</caption><thead><tr><th>${t('Method', 'Método')}</th><th>${t('Size', 'Tamanho')}</th><th>${t('Copies', 'Cópias')}</th><th>${t('Paths', 'Caminhos')}</th></tr></thead><tbody data-groups></tbody></table></div>`,
    empty: 'The report separates cryptographic byte identity from heuristic visual similarity and never removes data.', emptyPt: 'O relatório separa identidade criptográfica de bytes de similaridade visual heurística e nunca remove dados.', action: 'Download manifest', actionPt: 'Baixar manifesto'
  });
  let report = null;
  const progress = root.querySelector('[data-progress]');
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const files = [...root.querySelector('[data-files]').files];
    if (!files.length) return;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length > 20_000 || total > 4 * GiB) { status(ui.status, t('Selection exceeds 20,000 files or 4 GiB.', 'A seleção excede 20.000 arquivos ou 4 GiB.'), 'error'); return; }
    const sizes = new Map();
    for (const file of files) { if (!sizes.has(file.size)) sizes.set(file.size, []); sizes.get(file.size).push(file); }
    const candidates = [...sizes.values()].filter((group) => group.length > 1).flat();
    const visualRequested = root.querySelector('[data-visual]').checked;
    const imageCandidates = visualRequested ? files.filter((file) => /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name) || /^image\//.test(file.type)).sort((left, right) => localPath(left).localeCompare(localPath(right))).slice(0, 500) : [];
    if (candidates.some((file) => file.size > 512 * MiB)) { status(ui.status, t('A same-size candidate exceeds the 512 MiB per-file hashing cap.', 'Um candidato de mesmo tamanho excede o limite de hash de 512 MiB por arquivo.'), 'error'); return; }
    progress.hidden = false; progress.max = Math.max(1, candidates.length + imageCandidates.length); progress.value = 0;
    status(ui.status, t(`Hashing ${candidates.length.toLocaleString()} exact candidates and ${imageCandidates.length.toLocaleString()} images…`, `Calculando ${candidates.length.toLocaleString()} candidatos exatos e ${imageCandidates.length.toLocaleString()} imagens…`));
    try {
      const records = [];
      for (const file of candidates) {
        const digest = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
        records.push({ path: localPath(file), size: file.size, digest, lastModified: file.lastModified });
        progress.value += 1;
        if (progress.value % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const groups = groupDuplicateRecords(records);
      const perceptualRecords = [];
      const perceptualErrors = [];
      if (visualRequested && imageCandidates.length && typeof createImageBitmap !== 'function') perceptualErrors.push(t('Visual hashing unavailable: createImageBitmap is not supported.', 'Hash visual indisponível: createImageBitmap não é compatível.'));
      else for (const file of imageCandidates) {
        try { perceptualRecords.push({ path: localPath(file), size: file.size, hash: await imageDifferenceHash(file, root) }); }
        catch (error) { if (perceptualErrors.length < 100) perceptualErrors.push(`${localPath(file)}: ${error.message}`); }
        progress.value += 1;
        if (progress.value % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const perceptualGroups = groupPerceptualHashes(perceptualRecords, 8);
      const reclaimableBytes = groups.reduce((sum, group) => sum + group.reclaimableBytes, 0);
      report = { tool: 'Local File Deduplicator', exactAlgorithm: 'SHA-256', visualAlgorithm: '64-bit dHash connected components / Hamming link distance <= 8', scannedFiles: files.length, hashedCandidates: candidates.length, visualCandidates: imageCandidates.length, visualHashed: perceptualRecords.length, totalBytes: total, reclaimableBytes, groups, perceptualGroups, perceptualErrors, visualCandidateListTruncated: visualRequested && files.filter((file) => /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name) || /^image\//.test(file.type)).length > 500 };
      renderMetrics(root, [[t('Files indexed', 'Arquivos indexados'), files.length.toLocaleString()], [t('Exact groups', 'Grupos exatos'), groups.length.toLocaleString()], [t('Visual groups', 'Grupos visuais'), perceptualGroups.length.toLocaleString()], [t('Exact reclaim', 'Recuperação exata'), formatBytes(reclaimableBytes)]]);
      renderTable(root.querySelector('[data-groups]'), [
        ...groups.map((group) => [`SHA-256 ${group.digest.slice(0, 12)}…`, formatBytes(group.size), group.files.length, group.files.map((item) => item.path).join('\n')]),
        ...perceptualGroups.map((group) => [`dHash ${t('links', 'elos')} ≤ 8 (${t('group max', 'máx. do grupo')} ${group.maximumDistance})`, `${formatBytes(Math.min(...group.files.map((item) => item.size)))}–${formatBytes(Math.max(...group.files.map((item) => item.size)))}`, group.files.length, group.files.map((item) => item.path).join('\n')])
      ]);
      ui.download.disabled = false; toggleResult(root, true);
      const found = groups.length + perceptualGroups.length;
      status(ui.status, found ? t('Duplicate candidates found. Review exact and heuristic groups before any manual deletion.', 'Candidatos duplicados encontrados. Revise grupos exatos e heurísticos antes de qualquer exclusão manual.') : perceptualErrors.length ? t('Exact scan completed; some visual candidates could not be decoded.', 'Varredura exata concluída; alguns candidatos visuais não puderam ser decodificados.') : t('No duplicate groups found within the configured methods and limits.', 'Nenhum grupo duplicado encontrado nos métodos e limites configurados.'), found || perceptualErrors.length ? 'warning' : 'success');
    } catch (error) { report = null; ui.download.disabled = true; toggleResult(root, false); status(ui.status, error.message, 'error'); }
    finally { progress.hidden = true; }
  });
  ui.download.addEventListener('click', () => report && downloadBytes(root, JSON.stringify(report, null, 2), 'duplicate-manifest.json', 'application/json'));
  cleanup.add(() => { report = null; });
}

function mountEncryptionVault(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'encryption-vault', title: 'Protect files or a folder', titlePt: 'Proteger arquivos ou uma pasta', badge: 'AES-256-GCM', badgePt: 'AES-256-GCM', results: 'Authenticated container', resultsPt: 'Contêiner autenticado',
    controls: `<fieldset class="segmented-fieldset"><legend>${t('Operation', 'Operação')}</legend><label><input type="radio" name="vault-mode" value="encrypt" checked><span>${t('Encrypt', 'Criptografar')}</span></label><label><input type="radio" name="vault-mode" value="decrypt"><span>${t('Decrypt', 'Descriptografar')}</span></label></fieldset>
      <label class="field-label" for="vault-file">${t('File(s), or one .m13vault to decrypt', 'Arquivo(s), ou um .m13vault para descriptografar')}</label><input class="file-input" id="vault-file" type="file" multiple data-file>
      <label class="field-label" for="vault-folder">${t('Or folder to encrypt', 'Ou pasta para criptografar')}</label><input class="file-input" id="vault-folder" type="file" webkitdirectory multiple data-folder>
      <label class="field-label" for="vault-passphrase">${t('Passphrase', 'Frase secreta')}</label><input class="text-input" id="vault-passphrase" type="password" minlength="8" maxlength="1024" autocomplete="new-password" required data-password>
      <button class="button button-primary" type="submit">${t('Run authenticated operation', 'Executar operação autenticada')}</button><p class="field-help">${t('One file: 512 MiB. Multi-file/folder ZIP bundle: 5,000 files and 256 MiB before compression. PBKDF2-SHA-256 uses 310,000 iterations and a random salt; AES-GCM detects wrong passwords and modifications. Keep your passphrase separately.', 'Um arquivo: 512 MiB. Pacote ZIP de vários arquivos/pasta: 5.000 arquivos e 256 MiB antes da compressão. PBKDF2-SHA-256 usa 310.000 iterações e salt aleatório; AES-GCM detecta senhas erradas e alterações. Guarde a frase secreta separadamente.')}</p>`,
    output: `<ul class="finding-list" data-details></ul>`,
    empty: 'Encryption and decryption happen with Web Crypto in this browser. There is no password recovery or server copy.', emptyPt: 'Criptografia e descriptografia ocorrem com Web Crypto neste navegador. Não há recuperação de senha nem cópia no servidor.', action: 'Download result', actionPt: 'Baixar resultado'
  });
  let result = null;
  let resultName = '';
  let resultType = 'application/octet-stream';
  const fileInput = root.querySelector('[data-file]');
  const folderInput = root.querySelector('[data-folder]');
  fileInput.addEventListener('change', () => { if (fileInput.files.length) folderInput.value = ''; });
  folderInput.addEventListener('change', () => { if (folderInput.files.length) fileInput.value = ''; });
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mode = ui.form.elements['vault-mode'].value;
    const selected = [...(folderInput.files.length ? folderInput.files : fileInput.files)];
    const passwordField = root.querySelector('[data-password]');
    const password = passwordField.value;
    if (!selected.length || !password) { status(ui.status, t('Choose an input and enter a passphrase.', 'Escolha uma entrada e informe uma frase secreta.'), 'error'); return; }
    if (mode === 'decrypt' && selected.length !== 1) { status(ui.status, t('Decryption accepts exactly one .m13vault container.', 'A descriptografia aceita exatamente um contêiner .m13vault.'), 'error'); return; }
    if (selected.length > 5_000) { status(ui.status, t('A bundle is capped at 5,000 files.', 'Um pacote é limitado a 5.000 arquivos.'), 'error'); return; }
    const selectionBytes = selected.reduce((sum, file) => sum + file.size, 0);
    const needsBundle = mode === 'encrypt' && (selected.length > 1 || Boolean(folderInput.files.length) || Boolean(selected[0]?.webkitRelativePath));
    const inputCap = needsBundle ? 256 * MiB : 512 * MiB;
    if (selectionBytes > inputCap || selected.some((file) => file.size > 512 * MiB)) { status(ui.status, needsBundle ? t('The multi-file bundle exceeds its 256 MiB input cap.', 'O pacote de vários arquivos excede o limite de entrada de 256 MiB.') : t('The vault is capped at 512 MiB per file.', 'O cofre é limitado a 512 MiB por arquivo.'), 'error'); return; }
    status(ui.status, mode === 'encrypt' ? t('Deriving key and encrypting locally…', 'Derivando chave e criptografando localmente…') : t('Authenticating and decrypting locally…', 'Autenticando e descriptografando localmente…'));
    ui.download.disabled = true;
    try {
      let sourceName = selected[0].name;
      let sourceMime = selected[0].type || 'application/octet-stream';
      let input;
      if (needsBundle) {
        status(ui.status, t('Building a bounded ZIP bundle before encryption…', 'Criando um pacote ZIP limitado antes da criptografia…'));
        const { zipSync } = await import('/vendor/suite/fflate.js');
        const records = {};
        for (const file of selected) {
          const path = normalizeVaultArchivePath(localPath(file));
          if (Object.hasOwn(records, path)) throw new Error(t(`Duplicate bundle path: ${path}`, `Caminho duplicado no pacote: ${path}`));
          records[path] = new Uint8Array(await file.arrayBuffer());
        }
        input = zipSync(records, { level: 6 });
        if (input.length > 512 * MiB) throw new Error(t('Compressed bundle exceeds the 512 MiB vault cap.', 'O pacote comprimido excede o limite de 512 MiB do cofre.'));
        const firstPath = normalizeVaultArchivePath(localPath(selected[0]));
        const rootName = firstPath.includes('/') ? firstPath.split('/')[0] : 'files';
        sourceName = `${safeName(rootName, 'files')}.zip`;
        sourceMime = 'application/zip';
      } else input = await readFileBytes(selected[0], 512 * MiB);
      let details;
      if (mode === 'encrypt') {
        result = await encryptVault(input, password, { filename: sourceName, mime: sourceMime });
        const parsed = parseVaultContainer(result);
        resultName = `${safeName(sourceName)}.m13vault`;
        resultType = 'application/octet-stream';
        details = [['FORMAT', 'M13VAULT v1'], ['PAYLOAD', needsBundle ? t(`ZIP bundle / ${selected.length.toLocaleString()} files`, `Pacote ZIP / ${selected.length.toLocaleString()} arquivos`) : sourceName], ['CIPHER', parsed.algorithm], ['KDF', `PBKDF2-SHA-256 / ${parsed.iterations.toLocaleString()}`], ['OUTPUT', formatBytes(result.length)]];
      } else {
        const decrypted = await decryptVault(input, password);
        result = decrypted.bytes;
        resultName = safeName(decrypted.metadata.filename, 'decrypted.bin');
        resultType = decrypted.metadata.mime || 'application/octet-stream';
        details = [['AUTH', t('Authentication passed', 'Autenticação aprovada')], ['NAME', decrypted.metadata.filename], ['TYPE', decrypted.metadata.mime], ['OUTPUT', formatBytes(result.length)]];
      }
      passwordField.value = '';
      const list = root.querySelector('[data-details]');
      const doc = root.ownerDocument;
      list.replaceChildren(...details.map(([label, value]) => { const li = doc.createElement('li'); const strong = doc.createElement('strong'); const span = doc.createElement('span'); strong.textContent = label; span.textContent = value; li.append(strong, span); return li; }));
      renderMetrics(root, [[t('Input', 'Entrada'), formatBytes(selectionBytes)], [t('Output', 'Saída'), formatBytes(result.length)], [t('Operation', 'Operação'), mode === 'encrypt' ? t('Encrypted', 'Criptografado') : t('Decrypted', 'Descriptografado')], [t('Server upload', 'Envio ao servidor'), t('None', 'Nenhum')]]);
      ui.download.disabled = false; toggleResult(root, true); status(ui.status, t('Authenticated result is ready. Download it before leaving.', 'O resultado autenticado está pronto. Baixe antes de sair.'), 'success');
    } catch (error) { result = null; passwordField.value = ''; toggleResult(root, false); status(ui.status, error.message, 'error'); }
  });
  ui.download.addEventListener('click', () => result && downloadBytes(root, result, resultName, resultType));
  cleanup.add(() => { result = null; root.querySelector('[data-password]')?.setAttribute('value', ''); });
}

function mountSqliteWorkbench(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'sqlite-workbench', title: 'Open a SQLite database', titlePt: 'Abrir banco SQLite', badge: 'SQLite WASM', badgePt: 'SQLite WASM', results: 'Database structure', resultsPt: 'Estrutura do banco',
    controls: `<label class="field-label" for="sqlite-file">${t('SQLite file', 'Arquivo SQLite')}</label><input class="file-input" id="sqlite-file" type="file" accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3" required data-file>
      <button class="button button-primary" type="submit">${t('Open with SQLite WASM', 'Abrir com SQLite WASM')}</button><p class="field-help">${t('Databases up to 256 MiB open in a private in-memory SQLite runtime. Larger files receive header and bounded schema inspection only. The runtime is downloaded from this site only after this action.', 'Bancos de até 256 MiB abrem em runtime SQLite privado em memória. Arquivos maiores recebem apenas inspeção de cabeçalho e esquema limitado. O runtime é baixado deste site somente após esta ação.')}</p>
      <label class="field-label" for="sqlite-query">${t('SQL statement', 'Instrução SQL')}</label><textarea class="code-input" id="sqlite-query" rows="6" spellcheck="false" data-query>SELECT name, type, sql FROM sqlite_schema ORDER BY type, name LIMIT 100;</textarea>
      <label class="check-row"><input type="checkbox" data-write> ${t('Allow this statement to change the in-memory copy', 'Permitir que esta instrução altere a cópia em memória')}</label><button class="button" type="button" disabled data-run>${t('Run SQL', 'Executar SQL')}</button>`,
    output: `<h3>${t('Header fields', 'Campos do cabeçalho')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('SQLite 3 header decoded before runtime execution', 'Cabeçalho SQLite 3 decodificado antes da execução')}</caption><thead><tr><th>${t('Field', 'Campo')}</th><th>${t('Value', 'Valor')}</th></tr></thead><tbody data-header></tbody></table></div><h3>${t('Schema records', 'Registros de esquema')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('sqlite_schema rows when WASM opens the database; printable fallback otherwise', 'Linhas de sqlite_schema quando WASM abre o banco; fallback imprimível caso contrário')}</caption><thead><tr><th>${t('Type / offset', 'Tipo / offset')}</th><th>${t('Name / SQL', 'Nome / SQL')}</th><th>SQL</th></tr></thead><tbody data-schema></tbody></table></div><h3>${t('SQL result', 'Resultado SQL')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('First 10,000 result rows', 'Primeiras 10.000 linhas do resultado')}</caption><thead data-query-head></thead><tbody data-query-body></tbody></table></div>`,
    empty: 'Open a database to validate its format, inspect the real schema, query it, optionally edit only the in-memory copy, and export a new database.', emptyPt: 'Abra um banco para validar o formato, inspecionar o esquema real, consultar, editar opcionalmente apenas a cópia em memória e exportar um novo banco.', action: 'Download result', actionPt: 'Baixar resultado'
  });
  let report = null;
  let database = null;
  let sourceName = 'database.sqlite';
  let runtimeActive = false;
  const runButton = root.querySelector('[data-run]');

  function renderQuery(result) {
    const head = root.querySelector('[data-query-head]');
    const doc = root.ownerDocument;
    head.replaceChildren();
    const row = doc.createElement('tr');
    const columns = result.columns.length ? result.columns : [t('Status', 'Status')];
    for (const column of columns) { const th = doc.createElement('th'); th.textContent = column; row.append(th); }
    head.append(row);
    renderTable(root.querySelector('[data-query-body]'), result.rows.length ? result.rows.map((item) => result.columns.map((column) => item[column])) : [[t(`${result.rowsModified} row(s) modified; no result rows.`, `${result.rowsModified} linha(s) modificadas; sem linhas de resultado.`)]]);
  }

  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = root.querySelector('[data-file]').files[0];
    if (!file) return;
    if (file.size > 8 * GiB) { status(ui.status, t('SQLite files are capped at 8 GiB for this inspector.', 'Arquivos SQLite são limitados a 8 GiB neste inspetor.'), 'error'); return; }
    status(ui.status, t('Validating the SQLite header…', 'Validando o cabeçalho SQLite…'));
    try {
      database?.close(); database = null; runtimeActive = false; runButton.disabled = true;
      const sample = new Uint8Array(await file.slice(0, Math.min(file.size, 128 * MiB)).arrayBuffer());
      const header = parseSQLiteHeader(sample);
      let schema = extractSQLiteSchemaStrings(sample).map((item) => ({ kind: `0x${item.offset.toString(16)}`, name: '', sql: item.sql }));
      const expectedBytes = header.declaredPages * header.pageSize;
      sourceName = file.name;
      let runtimeError = null;
      if (file.size <= 256 * MiB) {
        try {
          status(ui.status, t('Loading the local SQLite WASM runtime and opening an in-memory copy…', 'Carregando o runtime SQLite WASM local e abrindo uma cópia em memória…'));
          const [SQL, fullBytes] = await Promise.all([loadSqliteRuntime(root), readFileBytes(file, 256 * MiB)]);
          database = new SQL.Database(fullBytes);
          runtimeActive = true;
          const schemaResult = runSqliteStatement(database, 'SELECT type, name, sql FROM sqlite_schema ORDER BY type, name', 5_000);
          schema = schemaResult.rows.map((item) => ({ kind: item.type, name: item.name, sql: item.sql || '' }));
          runButton.disabled = false;
        } catch (error) { database?.close(); database = null; runtimeActive = false; runtimeError = error.message; }
      }
      report = { name: file.name, actualBytes: file.size, sampledBytes: sample.length, expectedBytes, sizeConsistent: header.declaredPages === 0 || file.size >= expectedBytes, header, schema, sqlRuntime: runtimeActive ? 'sql.js SQLite WASM in-memory database' : file.size > 256 * MiB ? 'structural fallback: file exceeds 256 MiB runtime cap' : `structural fallback: ${runtimeError}`, runtimeError };
      renderMetrics(root, [[t('File size', 'Tamanho'), formatBytes(file.size)], [t('Page size', 'Página'), formatBytes(header.pageSize)], [t('Declared pages', 'Páginas declaradas'), header.declaredPages.toLocaleString()], [t('Schema strings', 'Strings de esquema'), schema.length.toLocaleString()]]);
      renderTable(root.querySelector('[data-header]'), Object.entries(header).map(([key, value]) => [key, value]));
      renderTable(root.querySelector('[data-schema]'), (schema.length ? schema : [{ kind: '—', name: '', sql: t('No schema record found.', 'Nenhum registro de esquema encontrado.') }]).map((item) => [item.kind, item.name, item.sql]));
      root.querySelector('[data-query-head]').replaceChildren(); root.querySelector('[data-query-body]').replaceChildren();
      ui.download.disabled = false; toggleResult(root, true);
      status(ui.status, !report.sizeConsistent ? t('Header declares more page bytes than the file contains; it may be truncated.', 'O cabeçalho declara mais bytes de página que o arquivo contém; ele pode estar truncado.') : runtimeActive ? t('Database opened in SQLite WASM. Queries operate on the private in-memory copy.', 'Banco aberto no SQLite WASM. Consultas operam na cópia privada em memória.') : runtimeError ? t(`SQLite runtime failed; structural fallback retained: ${runtimeError}`, `O runtime SQLite falhou; fallback estrutural mantido: ${runtimeError}`) : t('Structural inspection complete; file is above the runtime cap.', 'Inspeção estrutural concluída; o arquivo está acima do limite do runtime.'), report.sizeConsistent && runtimeActive ? 'success' : 'warning');
    } catch (error) { report = null; ui.download.disabled = true; toggleResult(root, false); status(ui.status, error.message, 'error'); }
  });
  runButton.addEventListener('click', () => {
    if (!database) return;
    const sql = root.querySelector('[data-query]').value;
    const allowWrite = root.querySelector('[data-write]').checked;
    if (!allowWrite && !isReadOnlySqliteStatement(sql)) { status(ui.status, t('Enable in-memory changes before running a data-changing statement.', 'Habilite alterações em memória antes de executar uma instrução de escrita.'), 'error'); return; }
    try {
      const result = runSqliteStatement(database, sql);
      renderQuery(result);
      status(ui.status, result.truncated ? t('SQL ran; result display stopped at 10,000 rows.', 'SQL executado; a exibição parou em 10.000 linhas.') : allowWrite && result.rowsModified ? t(`SQL ran on the in-memory copy; ${result.rowsModified} row(s) changed.`, `SQL executado na cópia em memória; ${result.rowsModified} linha(s) alteradas.`) : t('SQL query complete.', 'Consulta SQL concluída.'), result.truncated || result.rowsModified ? 'warning' : 'success');
    } catch (error) { status(ui.status, error.message, 'error'); }
  });
  ui.download.addEventListener('click', () => {
    if (database) downloadBytes(root, database.export(), `${safeName(sourceName.replace(/\.(?:sqlite3?|db)$/i, ''), 'database')}.sqlite`, 'application/vnd.sqlite3');
    else if (report) downloadBytes(root, JSON.stringify(report, null, 2), `${safeName(report.name)}.sqlite-inspection.json`, 'application/json');
  });
  cleanup.add(() => { report = null; database?.close(); database = null; });
}

function fileDatasetFormat(file, requested = 'auto') {
  if (requested !== 'auto') return requested;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.parquet')) return 'parquet';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'ndjson';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.tsv')) return 'tsv';
  return 'csv';
}

function renderDatasetPreview(root, rows, columns, t) {
  const head = root.querySelector('[data-preview-head]');
  const body = root.querySelector('[data-preview-body]');
  if (!head || !body) return;
  const doc = root.ownerDocument;
  head.replaceChildren();
  const headerRow = doc.createElement('tr');
  for (const column of columns) { const th = doc.createElement('th'); th.textContent = column; headerRow.append(th); }
  head.append(headerRow);
  renderTable(body, rows.slice(0, 200).map((row) => columns.map((column) => row?.[column] ?? '')));
  const caption = body.closest('table')?.querySelector('caption');
  if (caption) caption.textContent = t(`First ${Math.min(rows.length, 200).toLocaleString()} of ${rows.length.toLocaleString()} result rows`, `Primeiras ${Math.min(rows.length, 200).toLocaleString()} de ${rows.length.toLocaleString()} linhas de resultado`);
}

function mountDuckdbStudio(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'duckdb-studio', title: 'Query a local dataset', titlePt: 'Consultar dataset local', badge: 'DuckDB WASM', badgePt: 'DuckDB WASM', results: 'Query result', resultsPt: 'Resultado da consulta',
    controls: `<label class="field-label" for="duck-file">${t('CSV, TSV, JSON, NDJSON, or Parquet', 'CSV, TSV, JSON, NDJSON ou Parquet')}</label><input class="file-input" id="duck-file" type="file" accept=".csv,.tsv,.json,.jsonl,.ndjson,.parquet" required data-file>
      <label class="field-label" for="duck-query">${t('Read-only DuckDB query', 'Consulta DuckDB somente leitura')}</label><textarea class="code-input" id="duck-query" rows="8" spellcheck="false" data-query>SELECT * FROM data LIMIT 100;</textarea>
      <button class="button button-primary" type="submit">${t('Load DuckDB and query', 'Carregar DuckDB e consultar')}</button><p class="field-help">${t('256 MiB input. A local DuckDB worker and WASM runtime load only after this action. SELECT/WITH queries are wrapped with a 10,001-row result cap. If runtime startup fails, text files retain the documented 64 MiB / 100,000-row query fallback; Parquet remains validated but not fabricated.', 'Entrada de 256 MiB. Um worker DuckDB local e runtime WASM carregam somente após esta ação. Consultas SELECT/WITH recebem limite de 10.001 linhas. Se o runtime falhar, arquivos de texto mantêm o fallback documentado de 64 MiB / 100.000 linhas; Parquet continua validado, sem dados fabricados.')}</p>`,
    output: `<div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('Bounded query result', 'Resultado limitado da consulta')}</caption><thead data-preview-head></thead><tbody data-preview-body></tbody></table></div><pre class="code-output" hidden data-parquet></pre>`,
    empty: 'Drop a dataset to query it with a real local DuckDB runtime. The bounded parser remains an explicit text-only fallback.', emptyPt: 'Solte um dataset para consultá-lo com runtime DuckDB local real. O parser limitado permanece como fallback explícito apenas para texto.', action: 'Download JSON result', actionPt: 'Baixar resultado JSON'
  });
  let report = null;
  let duckRuntime = null;
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = root.querySelector('[data-file]').files[0];
    if (!file) return;
    if (file.size > 256 * MiB) { status(ui.status, t('This studio limits each input to 256 MiB.', 'Este estúdio limita cada entrada a 256 MiB.'), 'error'); return; }
    let boundedQuery;
    try { boundedQuery = buildReadOnlyDuckQuery(root.querySelector('[data-query]').value); }
    catch (error) { status(ui.status, error.message, 'error'); return; }
    status(ui.status, t('Loading the local DuckDB worker and WASM runtime…', 'Carregando o worker DuckDB local e o runtime WASM…'));
    try {
      await duckRuntime?.close();
      duckRuntime = await openDuckDb(cleanup);
      const bytes = await readFileBytes(file, 256 * MiB);
      const format = /\.parquet$/i.test(file.name) ? 'parquet' : fileDatasetFormat(file);
      const registeredName = format === 'parquet' ? 'input.parquet' : format === 'json' ? 'input.json' : format === 'ndjson' ? 'input.ndjson' : format === 'tsv' ? 'input.tsv' : 'input.csv';
      if (format === 'parquet') inspectParquetEnvelope(bytes);
      await duckRuntime.database.registerFileBuffer(registeredName, bytes);
      const sourceSql = buildDuckDatasetSourceSql(format, registeredName);
      await duckRuntime.connection.query(`CREATE OR REPLACE VIEW data AS SELECT * FROM ${sourceSql}`);
      const arrow = await duckRuntime.connection.query(boundedQuery);
      const retained = arrowTableRows(arrow, 10_001);
      const truncated = retained.length > 10_000;
      const rows = retained.slice(0, 10_000);
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
      report = { source: file.name, inputFormat: format, columns, rows, truncated, engine: 'DuckDB-WASM', query: root.querySelector('[data-query]').value };
      renderMetrics(root, [[t('Input', 'Entrada'), format.toUpperCase()], [t('Result rows', 'Linhas resultantes'), rows.length.toLocaleString()], [t('Columns', 'Colunas'), columns.length.toLocaleString()], [t('Engine', 'Motor'), 'DuckDB-WASM']]);
      root.querySelector('[data-parquet]').hidden = true; renderDatasetPreview(root, rows, columns, t);
      ui.download.disabled = false; toggleResult(root, true); status(ui.status, truncated ? t('DuckDB query complete; result export is capped at 10,000 rows.', 'Consulta DuckDB concluída; a exportação é limitada a 10.000 linhas.') : t('DuckDB-WASM query complete.', 'Consulta DuckDB-WASM concluída.'), truncated ? 'warning' : 'success');
    } catch (runtimeError) {
      try {
        if (/\.parquet$/i.test(file.name)) {
          const envelope = inspectParquetEnvelope(await readFileBytes(file, 256 * MiB));
          report = { format: 'parquet-envelope', envelope, rows: null, runtime: `DuckDB startup/query failed: ${runtimeError.message}` };
          renderMetrics(root, [[t('Format', 'Formato'), 'Parquet'], [t('Size', 'Tamanho'), formatBytes(envelope.size)], [t('Footer', 'Rodapé'), formatBytes(envelope.footerLength)], [t('Rows', 'Linhas'), t('Not decoded', 'Não decodificadas')]]);
          root.querySelector('[data-preview-head]').replaceChildren(); root.querySelector('[data-preview-body]').replaceChildren();
          const parquet = root.querySelector('[data-parquet]'); parquet.hidden = false; parquet.textContent = `${t('Valid Parquet envelope.', 'Envelope Parquet válido.')}\n${t('DuckDB runtime error', 'Erro do runtime DuckDB')}: ${runtimeError.message}\n${t('No row data was fabricated.', 'Nenhuma linha foi fabricada.')}`;
          ui.download.disabled = false; toggleResult(root, true); status(ui.status, t('Parquet structure validated, but DuckDB could not query it.', 'Estrutura Parquet validada, mas DuckDB não conseguiu consultá-la.'), 'warning');
          return;
        }
        if (file.size > 64 * MiB) throw runtimeError;
        const parsed = parseDatasetText(await file.text(), fileDatasetFormat(file), { maxRows: 100_000 });
        const rows = executeDatasetQuery(parsed.rows, root.querySelector('[data-query]').value);
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
        report = { source: file.name, inputFormat: parsed.format, inputRows: parsed.rows.length, columns, rows, engine: 'documented SELECT subset fallback', runtimeError: runtimeError.message };
        renderMetrics(root, [[t('Input rows', 'Linhas de entrada'), parsed.rows.length.toLocaleString()], [t('Result rows', 'Linhas resultantes'), rows.length.toLocaleString()], [t('Columns', 'Colunas'), columns.length.toLocaleString()], [t('Engine', 'Motor'), t('Fallback subset', 'Subconjunto fallback')]]);
        root.querySelector('[data-parquet]').hidden = true; renderDatasetPreview(root, rows, columns, t);
        ui.download.disabled = false; toggleResult(root, true); status(ui.status, t(`DuckDB was unavailable; the documented text fallback ran instead: ${runtimeError.message}`, `DuckDB ficou indisponível; o fallback de texto documentado foi executado: ${runtimeError.message}`), 'warning');
      } catch (fallbackError) { report = null; ui.download.disabled = true; toggleResult(root, false); status(ui.status, fallbackError instanceof SyntaxError ? t('Dataset JSON is invalid.', 'O JSON do dataset é inválido.') : fallbackError.message, 'error'); }
    } finally { await duckRuntime?.close(); duckRuntime = null; }
  });
  ui.download.addEventListener('click', () => report && downloadBytes(root, JSON.stringify(report, null, 2), 'local-query-result.json', 'application/json'));
  cleanup.add(() => { report = null; duckRuntime = null; });
}

function mountDataConverter(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'data-converter', title: 'Convert structured data', titlePt: 'Converter dados estruturados', badge: 'Text + Parquet', badgePt: 'Texto + Parquet', results: 'Converted dataset', resultsPt: 'Dataset convertido',
    controls: `<label class="field-label" for="converter-file">${t('CSV, TSV, JSON, NDJSON, or Parquet', 'CSV, TSV, JSON, NDJSON ou Parquet')}</label><input class="file-input" id="converter-file" type="file" accept=".csv,.tsv,.json,.jsonl,.ndjson,.parquet" required data-file>
      <label class="field-label" for="converter-right-file">${t('Optional second dataset to join', 'Segundo dataset opcional para unir')}</label><input class="file-input" id="converter-right-file" type="file" accept=".csv,.tsv,.json,.jsonl,.ndjson,.parquet" data-right-file>
      <label class="field-label" for="converter-join-key">${t('Shared join field', 'Campo compartilhado para união')}</label><input class="text-input" id="converter-join-key" placeholder="id" data-join-key>
      <label class="field-label" for="converter-join-type">${t('Join type', 'Tipo de união')}</label><select id="converter-join-type" data-join-type>${optionMarkup([['inner', 'INNER'], ['left', 'LEFT'], ['full', 'FULL']], 'inner')}</select>
      <label class="field-label" for="converter-input">${t('Input format', 'Formato de entrada')}</label><select id="converter-input" data-input-format>${optionMarkup([['auto', t('Auto-detect', 'Detectar automaticamente')], ['csv', 'CSV'], ['tsv', 'TSV'], ['json', 'JSON'], ['ndjson', 'NDJSON'], ['parquet', 'Parquet']], 'auto')}</select>
      <label class="field-label" for="converter-output">${t('Output format', 'Formato de saída')}</label><select id="converter-output" data-output-format>${optionMarkup([['csv', 'CSV'], ['json', 'JSON'], ['ndjson', 'NDJSON'], ['parquet', 'Parquet']], 'json')}</select>
      <label class="field-label" for="converter-query">${t('Optional filter / projection query', 'Consulta opcional de filtro / projeção')}</label><textarea class="code-input" id="converter-query" rows="5" placeholder="SELECT * FROM data WHERE score >= 10 LIMIT 1000" data-query></textarea>
      <button class="button button-primary" type="submit">${t('Convert locally', 'Converter localmente')}</button><p class="field-help">${t('64 MiB per input, 96 MiB combined, and 100,000 output rows. A second file enables a bounded equi-join. CSV output neutralizes spreadsheet-formula prefixes. Reading or writing Parquet explicitly starts the site-hosted DuckDB worker; Parquet output is capped at 256 MiB.', '64 MiB por entrada, 96 MiB combinados e 100.000 linhas de saída. Um segundo arquivo habilita equi-join limitado. A saída CSV neutraliza prefixos de fórmulas de planilha. Ler ou gravar Parquet inicia explicitamente o worker DuckDB hospedado no site; a saída Parquet é limitada a 256 MiB.')}</p>`,
    output: `<pre class="code-output" data-preview></pre>`,
    empty: 'Parse, filter, project, and serialize bounded text datasets without uploading them.', emptyPt: 'Interprete, filtre, projete e serialize datasets de texto limitados sem enviá-los.', action: 'Download converted file', actionPt: 'Baixar arquivo convertido'
  });
  let output = null;
  let outputName = '';
  let outputType = '';
  let duckRuntime = null;
  const ensureDuckRuntime = async () => {
    if (!duckRuntime) duckRuntime = await openDuckDb(cleanup);
    return duckRuntime;
  };
  const parseInput = async (file, requested, virtualStem) => {
    const format = fileDatasetFormat(file, requested);
    if (format !== 'parquet') return parseDatasetText(await file.text(), format, { maxRows: 100_000 });
    const bytes = await readFileBytes(file, 64 * MiB, 'Parquet input');
    inspectParquetEnvelope(bytes);
    const runtime = await ensureDuckRuntime();
    const virtualName = `${virtualStem}.parquet`;
    await runtime.database.registerFileBuffer(virtualName, bytes);
    const arrow = await runtime.connection.query(`SELECT * FROM ${buildDuckDatasetSourceSql('parquet', virtualName)} LIMIT 100001`);
    const retained = arrowTableRows(arrow, 100_001);
    if (retained.length > 100_000) throw new Error(t('Parquet input exceeds the 100,000-row conversion cap.', 'A entrada Parquet excede o limite de 100.000 linhas da conversão.'));
    return { format: 'parquet', rows: retained, columns: [...new Set(retained.flatMap((row) => Object.keys(row || {})))] };
  };
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = root.querySelector('[data-file]').files[0];
    const rightFile = root.querySelector('[data-right-file]').files[0];
    if (!file) return;
    if (file.size > 64 * MiB || rightFile?.size > 64 * MiB || file.size + (rightFile?.size || 0) > 96 * MiB) { status(ui.status, t('Input exceeds the 64 MiB per-file or 96 MiB combined conversion cap.', 'A entrada excede o limite de 64 MiB por arquivo ou 96 MiB combinados.'), 'error'); return; }
    status(ui.status, t('Parsing and converting locally…', 'Interpretando e convertendo localmente…'));
    try {
      await duckRuntime?.close(); duckRuntime = null;
      const requested = root.querySelector('[data-input-format]').value;
      const parsed = await parseInput(file, requested, 'left-input');
      let sourceRows = parsed.rows;
      let joinedRows = null;
      if (rightFile) {
        const joinKey = root.querySelector('[data-join-key]').value.trim();
        if (!joinKey) throw new Error(t('Enter the shared join field for the second dataset.', 'Informe o campo compartilhado para unir o segundo dataset.'));
        const right = await parseInput(rightFile, 'auto', 'right-input');
        sourceRows = joinDatasets(parsed.rows, right.rows, { leftKey: joinKey, rightKey: joinKey, type: root.querySelector('[data-join-type]').value, maxRows: 100_000 });
        joinedRows = sourceRows.length;
      }
      const query = root.querySelector('[data-query]').value.trim();
      const rows = query ? executeDatasetQuery(sourceRows, query) : sourceRows;
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
      const target = root.querySelector('[data-output-format]').value;
      if (target === 'csv') { output = datasetToCSV(rows, columns); outputType = 'text/csv'; }
      else if (target === 'ndjson') { output = datasetToNDJSON(rows); outputType = 'application/x-ndjson'; }
      else if (target === 'parquet') {
        if (!rows.length) throw new Error(t('Parquet output needs at least one row so a schema can be inferred.', 'A saída Parquet precisa de ao menos uma linha para que o esquema seja inferido.'));
        status(ui.status, t('Loading DuckDB and encoding real Parquet locally…', 'Carregando DuckDB e codificando Parquet real localmente…'));
        const ndjson = datasetToNDJSON(rows);
        const ndjsonBytes = textEncoder.encode(ndjson);
        if (ndjsonBytes.length > 128 * MiB) throw new Error(t('The intermediate Parquet dataset exceeds the 128 MiB encoding cap.', 'O dataset intermediário Parquet excede o limite de codificação de 128 MiB.'));
        const runtime = await ensureDuckRuntime();
        await runtime.database.registerFileBuffer('conversion.ndjson', ndjsonBytes);
        await runtime.connection.query(`COPY (SELECT * FROM ${buildDuckDatasetSourceSql('ndjson', 'conversion.ndjson')}) TO 'converted.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)`);
        output = asBytes(await runtime.database.copyFileToBuffer('converted.parquet'));
        if (output.length > 256 * MiB) { output = null; throw new Error(t('Encoded Parquet output exceeds the 256 MiB download cap.', 'A saída Parquet codificada excede o limite de download de 256 MiB.')); }
        inspectParquetEnvelope(output);
        outputType = 'application/vnd.apache.parquet';
      } else { output = JSON.stringify(rows, null, 2); outputType = 'application/json'; }
      outputName = `${safeName(file.name.replace(/\.[^.]+$/, ''), 'dataset')}.${target === 'ndjson' ? 'ndjson' : target}`;
      renderMetrics(root, [[t('Input rows', 'Linhas de entrada'), parsed.rows.length.toLocaleString()], [joinedRows == null ? t('Output rows', 'Linhas de saída') : t('Joined rows', 'Linhas unidas'), (joinedRows ?? rows.length).toLocaleString()], [t('Columns', 'Colunas'), columns.length.toLocaleString()], [t('Output size', 'Tamanho da saída'), formatBytes(new Blob([output]).size)]]);
      if (target === 'parquet') {
        root.querySelector('[data-preview]').textContent = `${JSON.stringify(inspectParquetEnvelope(output), null, 2)}\n\n${t('Row preview before Parquet encoding', 'Prévia das linhas antes da codificação Parquet')}:\n${JSON.stringify(rows.slice(0, 20), null, 2).slice(0, 60 * KiB)}`;
      } else {
        root.querySelector('[data-preview]').textContent = output.slice(0, 64 * KiB) + (output.length > 64 * KiB ? `\n… ${t('preview truncated', 'prévia truncada')}` : '');
      }
      ui.download.disabled = false; toggleResult(root, true); status(ui.status, t('Conversion complete. Review the bounded preview before downloading.', 'Conversão concluída. Revise a prévia limitada antes de baixar.'), 'success');
    } catch (error) { output = null; ui.download.disabled = true; toggleResult(root, false); status(ui.status, error instanceof SyntaxError ? t('Dataset contains invalid JSON.', 'O dataset contém JSON inválido.') : error.message, 'error'); }
    finally { await duckRuntime?.close(); duckRuntime = null; }
  });
  ui.download.addEventListener('click', () => output != null && downloadBytes(root, output, outputName, outputType));
  cleanup.add(() => { output = null; duckRuntime = null; });
}

function mountBiDashboard(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'bi-dashboard', title: 'Build a local dashboard', titlePt: 'Criar dashboard local', badge: 'SQL + charts + pivots', badgePt: 'SQL + gráficos + pivôs', results: 'Dashboard', resultsPt: 'Dashboard',
    controls: `<label class="field-label" for="bi-file">${t('CSV, TSV, JSON, or NDJSON', 'CSV, TSV, JSON ou NDJSON')}</label><input class="file-input" id="bi-file" type="file" accept=".csv,.tsv,.json,.jsonl,.ndjson" required data-file>
      <label class="field-label" for="bi-filter-field">${t('Optional filter field', 'Campo de filtro opcional')}</label><select id="bi-filter-field" data-filter-field></select>
      <label class="field-label" for="bi-filter-operator">${t('Filter operator', 'Operador do filtro')}</label><select id="bi-filter-operator" data-filter-operator>${optionMarkup([['contains', t('Contains', 'Contém')], ['=', '='], ['!=', '!='], ['>', '>'], ['>=', '>='], ['<', '<'], ['<=', '<=']], 'contains')}</select>
      <label class="field-label" for="bi-filter-value">${t('Filter value', 'Valor do filtro')}</label><input class="text-input" id="bi-filter-value" data-filter-value>
      <label class="field-label" for="bi-query">${t('Optional safe SQL over data', 'SQL seguro opcional sobre data')}</label><textarea class="code-input" id="bi-query" rows="4" spellcheck="false" data-query placeholder="SELECT * FROM data WHERE score >= 10 LIMIT 1000;"></textarea>
      <label class="field-label" for="bi-category">${t('Category / pivot row', 'Categoria / linha do pivô')}</label><select id="bi-category" data-category></select>
      <label class="field-label" for="bi-value">${t('Numeric value (optional for count)', 'Valor numérico (opcional para contagem)')}</label><select id="bi-value" data-value></select>
      <label class="field-label" for="bi-aggregation">${t('Aggregation', 'Agregação')}</label><select id="bi-aggregation" data-aggregation>${optionMarkup([['count', t('Count', 'Contagem')], ['sum', t('Sum', 'Soma')], ['avg', t('Average', 'Média')], ['min', t('Minimum', 'Mínimo')], ['max', t('Maximum', 'Máximo')]], 'count')}</select>
      <label class="check-row"><input type="checkbox" data-pivot> ${t('Show a pivot table', 'Mostrar tabela dinâmica')}</label><label class="field-label" for="bi-pivot-column">${t('Pivot column', 'Coluna do pivô')}</label><select id="bi-pivot-column" data-pivot-column></select>
      <button class="button button-primary" type="submit">${t('Load dashboard', 'Carregar dashboard')}</button><button class="button" type="button" disabled data-refresh>${t('Apply query and filters', 'Aplicar consulta e filtros')}</button><p class="field-help">${t('32 MiB / 100,000 source rows. SQL uses the bounded SELECT/filter/group/order subset. At most 30 chart categories, 10,000 SQL result rows, and 100 pivot columns are retained.', '32 MiB / 100.000 linhas de origem. O SQL usa o subconjunto limitado de SELECT/filtro/grupo/ordenação. No máximo 30 categorias no gráfico, 10.000 linhas do resultado SQL e 100 colunas no pivô são retidas.')}</p>`,
    output: `<h3>${t('Aggregated chart', 'Gráfico agregado')}</h3><div class="bar-chart" role="list" data-chart></div><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('Values represented by the chart', 'Valores representados pelo gráfico')}</caption><thead><tr><th>${t('Category', 'Categoria')}</th><th>${t('Value', 'Valor')}</th><th>${t('Rows', 'Linhas')}</th></tr></thead><tbody data-chart-table></tbody></table></div><h3>${t('Data table', 'Tabela de dados')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('Filtered/query or pivot data, capped preview', 'Dados filtrados/consultados ou pivô, prévia limitada')}</caption><thead data-preview-head></thead><tbody data-preview-body></tbody></table></div>`,
    empty: 'Load a structured text dataset, then choose dimensions and measures. Rendering and aggregation stay local.', emptyPt: 'Carregue um dataset de texto estruturado e escolha dimensões e medidas. Renderização e agregação permanecem locais.', action: 'Download dashboard JSON', actionPt: 'Baixar JSON do dashboard'
  });
  let dataset = null;
  let report = null;
  const refresh = root.querySelector('[data-refresh]');
  const controls = ['[data-category]', '[data-value]', '[data-aggregation]', '[data-pivot]', '[data-pivot-column]', '[data-filter-field]', '[data-filter-operator]'].map((selector) => root.querySelector(selector));
  const render = () => {
    if (!dataset) return;
    try {
      const filter = { field: root.querySelector('[data-filter-field]').value, operator: root.querySelector('[data-filter-operator]').value, value: root.querySelector('[data-filter-value]').value };
      const filteredRows = filterDatasetRows(dataset.rows, filter);
      const query = root.querySelector('[data-query]').value.trim();
      const workingRows = query ? executeDatasetQuery(filteredRows, query) : filteredRows;
      const category = root.querySelector('[data-category]').value;
      const value = root.querySelector('[data-value]').value || null;
      const aggregation = root.querySelector('[data-aggregation]').value;
      if (workingRows.length && !Object.hasOwn(workingRows[0], category)) throw new Error(t(`The selected category “${category}” is not present after the SQL projection.`, `A categoria selecionada “${category}” não existe após a projeção SQL.`));
      if (aggregation !== 'count' && workingRows.length && !Object.hasOwn(workingRows[0], value)) throw new Error(t(`The selected value “${value}” is not present after the SQL projection.`, `O valor selecionado “${value}” não existe após a projeção SQL.`));
      const chart = aggregateForChart(workingRows, { category, value, aggregation, limit: 30 });
      const max = Math.max(1, ...chart.map((item) => Math.abs(Number(item.value) || 0)));
      const doc = root.ownerDocument;
      const chartRoot = root.querySelector('[data-chart]');
      chartRoot.setAttribute('aria-label', t(`${aggregation} by ${category}; ${chart.length} visible categories.`, `${aggregation} por ${category}; ${chart.length} categorias visíveis.`));
      chartRoot.replaceChildren(...chart.map((item) => {
        const line = doc.createElement('div'); const label = doc.createElement('span'); const track = doc.createElement('i'); const bar = doc.createElement('b');
        line.setAttribute('role', 'listitem');
        label.textContent = `${item.label}: ${Number(item.value ?? 0).toLocaleString()}`; bar.style.width = `${Math.max(0, Math.abs(Number(item.value) || 0) / max * 100)}%`; track.append(bar); line.append(label, track); return line;
      }));
      renderTable(root.querySelector('[data-chart-table]'), chart.map((item) => [item.label, item.value, item.rows]));
      let tableRows;
      let tableColumns;
      if (root.querySelector('[data-pivot]').checked) {
        const pivotColumn = root.querySelector('[data-pivot-column]').value;
        if (workingRows.length && !Object.hasOwn(workingRows[0], pivotColumn)) throw new Error(t(`The pivot column “${pivotColumn}” is not present after the SQL projection.`, `A coluna do pivô “${pivotColumn}” não existe após a projeção SQL.`));
        const pivot = pivotDataset(workingRows, { row: category, column: pivotColumn, value, aggregation });
        tableRows = pivot.rows; tableColumns = pivot.columns;
      } else { tableRows = workingRows; tableColumns = workingRows.length ? inferColumns(workingRows).map((column) => column.name) : dataset.columns; }
      renderDatasetPreview(root, tableRows, tableColumns, t);
      report = { source: dataset.source, sourceRows: dataset.rows.length, visibleRows: workingRows.length, configuration: { filter, query: query || null, category, value, aggregation, pivot: root.querySelector('[data-pivot]').checked, pivotColumn: root.querySelector('[data-pivot-column]').value }, chart, table: { columns: tableColumns, rows: tableRows.slice(0, 1_000), truncated: tableRows.length > 1_000 } };
      renderMetrics(root, [[t('Source rows', 'Linhas de origem'), dataset.rows.length.toLocaleString()], [t('Visible rows', 'Linhas visíveis'), workingRows.length.toLocaleString()], [t('Chart groups', 'Grupos do gráfico'), chart.length.toLocaleString()], [t('Mode', 'Modo'), report.configuration.pivot ? t('Pivot', 'Pivô') : query ? 'SQL' : t('Rows', 'Linhas')]]);
      ui.download.disabled = false; toggleResult(root, true); status(ui.status, t('Dashboard recalculated locally.', 'Dashboard recalculado localmente.'), 'success');
    } catch (error) { report = null; ui.download.disabled = true; status(ui.status, error.message, 'error'); }
  };
  for (const control of controls) control.addEventListener('change', render);
  refresh.addEventListener('click', render);
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = root.querySelector('[data-file]').files[0];
    if (!file) return;
    if (file.size > 32 * MiB) { status(ui.status, t('Dashboard input is capped at 32 MiB.', 'A entrada do dashboard é limitada a 32 MiB.'), 'error'); return; }
    status(ui.status, t('Parsing columns and types…', 'Interpretando colunas e tipos…'));
    try {
      const parsed = parseDatasetText(await file.text(), fileDatasetFormat(file), { maxRows: 100_000 });
      if (!parsed.columns.length) throw new Error(t('Dataset has no columns.', 'O dataset não possui colunas.'));
      dataset = { ...parsed, source: file.name };
      const inferred = inferColumns(parsed.rows);
      setSelectOptions(root.querySelector('[data-category]'), parsed.columns, t('Choose a category', 'Escolha uma categoria'));
      setSelectOptions(root.querySelector('[data-value]'), inferred.filter((column) => column.type === 'number').map((column) => column.name), t('Not needed for count', 'Não necessário para contagem'));
      setSelectOptions(root.querySelector('[data-pivot-column]'), parsed.columns, t('Choose a pivot column', 'Escolha uma coluna do pivô'));
      setSelectOptions(root.querySelector('[data-filter-field]'), parsed.columns, t('No filter', 'Sem filtro'));
      root.querySelector('[data-category]').value = parsed.columns[0];
      root.querySelector('[data-pivot-column]').value = parsed.columns[1] || parsed.columns[0];
      refresh.disabled = false;
      render();
    } catch (error) { dataset = null; report = null; refresh.disabled = true; ui.download.disabled = true; toggleResult(root, false); status(ui.status, error instanceof SyntaxError ? t('Dataset JSON is invalid.', 'O JSON do dataset é inválido.') : error.message, 'error'); }
  });
  ui.download.addEventListener('click', () => report && downloadBytes(root, JSON.stringify(report, null, 2), 'local-dashboard.json', 'application/json'));
  cleanup.add(() => { dataset = null; report = null; });
}

function mountDataNotebook(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'data-notebook', title: 'Run a local data cell', titlePt: 'Executar célula de dados local', badge: 'Queries + Python + notes', badgePt: 'Consultas + Python + notas', results: 'Notebook history', resultsPt: 'Histórico do notebook',
    controls: `<label class="field-label" for="notebook-title">${t('Notebook title', 'Título do notebook')}</label><input class="text-input" id="notebook-title" maxlength="200" value="${t('Local notebook', 'Notebook local')}" data-title>
      <label class="field-label" for="notebook-import">${t('Import .m13nb.json notebook', 'Importar notebook .m13nb.json')}</label><input class="file-input" id="notebook-import" type="file" accept=".json,.m13nb.json,application/json" data-import><button class="button" type="button" data-import-button>${t('Import and replace history', 'Importar e substituir histórico')}</button>
      <label class="field-label" for="notebook-language">${t('Language', 'Linguagem')}</label><select id="notebook-language" data-language>${optionMarkup([['data-query', t('Safe data query', 'Consulta segura de dados')], ['python', 'Python / Pyodide'], ['javascript', 'JavaScript / Worker'], ['markdown', 'Markdown']], 'data-query')}</select>
      <label class="field-label" for="notebook-data">${t('Optional CSV / JSON dataset as data', 'Dataset CSV / JSON opcional como data')}</label><input class="file-input" id="notebook-data" type="file" accept=".csv,.tsv,.json,.jsonl,.ndjson" data-file>
      <label class="field-label" for="notebook-source">${t('Cell source', 'Código da célula')}</label><textarea class="code-input" id="notebook-source" rows="12" spellcheck="false" data-source>SELECT * FROM data LIMIT 10;</textarea>
      <button class="button button-primary" type="submit">${t('Run or retain cell locally', 'Executar ou reter célula localmente')}</button><p class="field-help">${t('Data-query uses the documented, non-eval SELECT/filter/group/order subset. JavaScript runs in a disposable worker; Markdown is retained without execution. Dataset: 16 MiB / 100,000 rows. The first Python cell starts the site-hosted Pyodide runtime in a persistent worker; Python cells stop after 45 seconds.', 'Data-query usa o subconjunto documentado de SELECT/filtro/grupo/ordenação, sem eval. JavaScript roda em worker descartável; Markdown é retido sem execução. Dataset: 16 MiB / 100.000 linhas. A primeira célula Python inicia o Pyodide hospedado no site em worker persistente; células Python param após 45 segundos.')}</p>`,
    output: `<div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('Executed/imported cells with bounded source and output', 'Células executadas/importadas com código e saída limitados')}</caption><thead><tr><th>#</th><th>${t('Language', 'Linguagem')}</th><th>${t('State', 'Estado')}</th><th>${t('Source', 'Código')}</th><th>${t('Output', 'Saída')}</th></tr></thead><tbody data-cells></tbody></table></div>`,
    empty: 'Build a small reproducible notebook locally. Outputs are retained only in this page until exported.', emptyPt: 'Crie um pequeno notebook reproduzível localmente. As saídas ficam apenas nesta página até a exportação.', action: 'Download notebook', actionPt: 'Baixar notebook'
  });
  const cells = [];
  const runPython = createPythonRunner(cleanup);
  let cachedFile = null;
  let cachedData = null;
  async function loadData() {
    const file = root.querySelector('[data-file]').files[0];
    if (!file) return null;
    if (file === cachedFile) return cachedData;
    if (file.size > 16 * MiB) throw new Error(t('Notebook dataset exceeds 16 MiB.', 'O dataset do notebook excede 16 MiB.'));
    cachedData = parseDatasetText(await file.text(), fileDatasetFormat(file), { maxRows: 100_000 }).rows;
    cachedFile = file;
    return cachedData;
  }
  function render() {
    renderMetrics(root, [[t('Cells', 'Células'), cells.length.toLocaleString()], [t('Successful', 'Bem-sucedidas'), cells.filter((cell) => cell.state === 'success').length.toLocaleString()], [t('Errors', 'Erros'), cells.filter((cell) => cell.state === 'error').length.toLocaleString()], [t('Storage', 'Armazenamento'), t('Page memory', 'Memória da página')]]);
    renderTable(root.querySelector('[data-cells]'), cells.map((cell, index) => [index + 1, cell.language, cell.state, cell.source, cell.output]));
    ui.download.disabled = !cells.length;
    toggleResult(root, Boolean(cells.length));
  }
  root.querySelector('[data-import-button]').addEventListener('click', async () => {
    const file = root.querySelector('[data-import]').files[0];
    if (!file) { status(ui.status, t('Choose a notebook JSON file first.', 'Escolha primeiro um arquivo JSON de notebook.'), 'error'); return; }
    if (file.size > 8 * MiB) { status(ui.status, t('Notebook JSON exceeds the 8 MiB import cap.', 'O JSON do notebook excede o limite de importação de 8 MiB.'), 'error'); return; }
    try {
      const imported = parseNotebook(await file.text());
      cells.splice(0, cells.length, ...imported.cells);
      root.querySelector('[data-title]').value = imported.metadata.title;
      render();
      status(ui.status, t(`Imported ${cells.length.toLocaleString()} cells. Review them before running anything.`, `${cells.length.toLocaleString()} células importadas. Revise antes de executar qualquer conteúdo.`), 'success');
    } catch (error) { status(ui.status, error.message, 'error'); }
  });
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (cells.length >= 500) { status(ui.status, t('Notebook is capped at 500 cells.', 'O notebook é limitado a 500 células.'), 'error'); return; }
    const source = root.querySelector('[data-source]').value;
    const language = root.querySelector('[data-language]').value;
    if (!source.trim()) { status(ui.status, t('Enter cell source first.', 'Informe o código da célula.'), 'error'); return; }
    status(ui.status, t('Running the cell locally…', 'Executando a célula localmente…'));
    const cell = { id: `cell-${cells.length + 1}`, language, source, output: '', state: 'idle' };
    try {
      const data = await loadData();
      if (language === 'markdown') {
        cell.output = source.slice(0, MiB);
      } else if (language === 'python') {
        status(ui.status, t('Loading the local Pyodide runtime (first Python cell) and running in a persistent worker…', 'Carregando o runtime Pyodide local (primeira célula Python) e executando em worker persistente…'));
        const executed = await runPython(source, data, 45_000);
        cell.output = [...executed.logs, ...(executed.value === undefined ? [] : [formatNotebookValue(executed.value)])].join('\n').slice(0, MiB);
      } else if (language === 'javascript') {
        const executed = await runSuiteWorker('javascript-cell', { source, data }, 3_000, cleanup);
        cell.output = [...executed.logs, ...(executed.result === undefined ? [] : [executed.result])].join('\n').slice(0, MiB);
      } else {
        if (!data) throw new Error(t('Select a dataset before running a data-query cell.', 'Selecione um dataset antes de executar uma célula de consulta.'));
        cell.output = JSON.stringify(executeDatasetQuery(data, source), null, 2).slice(0, MiB);
      }
      cell.state = 'success'; status(ui.status, t('Cell completed locally.', 'Célula concluída localmente.'), 'success');
    } catch (error) { cell.state = 'error'; cell.output = error.message; status(ui.status, error.message, 'error'); }
    cells.push(cell); render();
  });
  ui.download.addEventListener('click', () => cells.length && downloadBytes(root, JSON.stringify(serializeNotebook(cells, { title: root.querySelector('[data-title]').value }), null, 2), `${safeName(root.querySelector('[data-title]').value, 'local-notebook')}.m13nb.json`, 'application/json'));
  cleanup.add(() => { cells.length = 0; cachedData = null; cachedFile = null; });
}

function mountRegexWorkbench(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'regex-workbench', title: 'Extract with a regular expression', titlePt: 'Extrair com expressão regular', badge: 'Timed worker', badgePt: 'Worker cronometrado', results: 'Matches', resultsPt: 'Correspondências',
    controls: `<label class="field-label" for="regex-pattern">${t('Pattern', 'Padrão')}</label><textarea class="code-input" id="regex-pattern" rows="3" spellcheck="false" data-pattern>(?&lt;word&gt;\b[A-Za-z]{4,}\b)</textarea>
      <label class="field-label" for="regex-flags">${t('Flags', 'Flags')}</label><input class="text-input" id="regex-flags" value="gi" maxlength="8" spellcheck="false" data-flags>
      <label class="field-label" for="regex-file">${t('Optional UTF-8 text file', 'Arquivo de texto UTF-8 opcional')}</label><input class="file-input" id="regex-file" type="file" data-file>
      <label class="field-label" for="regex-input">${t('Or paste input', 'Ou cole a entrada')}</label><textarea class="code-input" id="regex-input" rows="10" data-input>Local tools keep private data in your browser.</textarea>
      <button class="button button-primary" type="submit">${t('Run bounded extraction', 'Executar extração limitada')}</button><p class="field-help">${t('Pattern: 4,096 characters. Large UTF-8 files: 64 MiB. 10,000 matches. A disposable worker is terminated after 3.5 seconds to contain catastrophic backtracking; this bounded whole-text mode preserves matches that cross arbitrary chunk boundaries.', 'Padrão: 4.096 caracteres. Arquivos UTF-8 grandes: 64 MiB. 10.000 correspondências. Um worker descartável é encerrado após 3,5 segundos para conter backtracking catastrófico; este modo de texto integral limitado preserva correspondências que cruzariam limites arbitrários de blocos.')}</p>`,
    output: `<div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('First 500 retained matches', 'Primeiras 500 correspondências retidas')}</caption><thead><tr><th>#</th><th>${t('Range', 'Intervalo')}</th><th>${t('Match', 'Correspondência')}</th><th>${t('Capture groups', 'Grupos de captura')}</th></tr></thead><tbody data-matches></tbody></table></div>`,
    empty: 'The matcher runs away from the page UI and is forcibly stopped at the wall-time limit.', emptyPt: 'O matcher roda separado da interface e é interrompido forçadamente no limite de tempo.', action: 'Download matches', actionPt: 'Baixar correspondências'
  });
  let report = null;
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = root.querySelector('[data-file]').files[0];
    if (file?.size > 64 * MiB) { status(ui.status, t('Text file exceeds the 64 MiB cap.', 'O arquivo de texto excede o limite de 64 MiB.'), 'error'); return; }
    const input = file ? await file.text() : root.querySelector('[data-input]').value;
    status(ui.status, t('Matching in an isolated worker…', 'Procurando em worker isolado…'));
    try {
      report = await runSuiteWorker('regex', { pattern: root.querySelector('[data-pattern]').value, flags: root.querySelector('[data-flags]').value, input, options: { maxPatternChars: 4_096, maxInputChars: 64 * MiB, maxMatches: 10_000, timeBudgetMs: 3_000 } }, 3_500, cleanup);
      renderMetrics(root, [[t('Matches', 'Correspondências'), report.matches.length.toLocaleString()], [t('Input', 'Entrada'), formatBytes(new Blob([input]).size)], [t('Elapsed', 'Duração'), `${report.elapsedMs.toFixed(2)} ms`], [t('Truncated', 'Truncado'), report.truncated ? t('Yes', 'Sim') : t('No', 'Não')]]);
      renderTable(root.querySelector('[data-matches]'), report.matches.slice(0, 500).map((match, index) => [index + 1, `${match.index}–${match.end}`, match.match, match.namedGroups ? JSON.stringify(match.namedGroups) : JSON.stringify(match.groups)]));
      ui.download.disabled = false; toggleResult(root, true); status(ui.status, report.truncated ? t('Results reached a configured limit.', 'Os resultados atingiram um limite configurado.') : t('Regex extraction complete.', 'Extração regex concluída.'), report.truncated ? 'warning' : 'success');
    } catch (error) { report = null; ui.download.disabled = true; toggleResult(root, false); status(ui.status, error.message, 'error'); }
  });
  ui.download.addEventListener('click', () => report && downloadBytes(root, JSON.stringify(report, null, 2), 'regex-matches.json', 'application/json'));
  cleanup.add(() => { report = null; });
}

function mountGitClient(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'git-client', title: 'Inspect a local Git repository', titlePt: 'Inspecionar repositório Git local', badge: 'isomorphic-git', badgePt: 'isomorphic-git', results: 'Repository snapshot', resultsPt: 'Snapshot do repositório',
    controls: `<label class="field-label" for="git-folder">${t('Repository or .git folder', 'Repositório ou pasta .git')}</label><input class="file-input" id="git-folder" type="file" webkitdirectory multiple required data-files>
      <button class="button button-primary" type="submit">${t('Load read-only Git runtime', 'Carregar runtime Git somente leitura')}</button><p class="field-help">${t('Up to 20,000 files and 256 MiB are copied into a read-only virtual filesystem after this action. isomorphic-git resolves real loose/packed objects for branch, commit history, and a status matrix; documented text metadata parsing remains the fallback. No remote operation or repository write is exposed.', 'Até 20.000 arquivos e 256 MiB são copiados para sistema virtual somente leitura após esta ação. isomorphic-git resolve objetos reais soltos/empacotados para branch, histórico e matriz de status; a interpretação textual documentada permanece como fallback. Nenhuma operação remota ou escrita é exposta.')}</p>`,
    output: `<h3>${t('References', 'Referências')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('Branches, tags, or loose/packed fallback references', 'Branches, tags ou referências fallback soltas/empacotadas')}</caption><thead><tr><th>${t('Reference', 'Referência')}</th><th>${t('Object ID / kind', 'ID do objeto / tipo')}</th></tr></thead><tbody data-refs></tbody></table></div><h3>${t('Commit history', 'Histórico de commits')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('Last 200 commits or reflog fallback entries', 'Últimos 200 commits ou entradas fallback de reflog')}</caption><thead><tr><th>${t('Time', 'Data')}</th><th>${t('Object', 'Objeto')}</th><th>${t('Message', 'Mensagem')}</th></tr></thead><tbody data-log></tbody></table></div><h3>${t('Working-tree status', 'Status da árvore de trabalho')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('First 2,000 status-matrix paths', 'Primeiros 2.000 caminhos da matriz de status')}</caption><thead><tr><th>${t('Path', 'Caminho')}</th><th>${t('State', 'Estado')}</th><th>${t('HEAD / workdir / stage', 'HEAD / workdir / stage')}</th></tr></thead><tbody data-status-matrix></tbody></table></div><pre class="code-output" data-config></pre>`,
    empty: 'Choose a repository folder. Some browsers omit hidden .git folders; if no HEAD is available, select the .git folder directly where supported.', emptyPt: 'Escolha a pasta de um repositório. Alguns navegadores omitem pastas .git ocultas; se HEAD não aparecer, selecione diretamente a pasta .git onde houver suporte.', action: 'Download snapshot', actionPt: 'Baixar snapshot'
  });
  let report = null;
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const files = [...root.querySelector('[data-files]').files];
    if (!files.length) return;
    if (files.length > 20_000) { status(ui.status, t('Selection exceeds 20,000 files.', 'A seleção excede 20.000 arquivos.'), 'error'); return; }
    const selectionBytes = files.reduce((sum, file) => sum + file.size, 0);
    const interesting = files.filter((file) => /(?:^|\/)\.git\/(?:HEAD|config|packed-refs|logs\/HEAD|refs\/(?:heads|tags|remotes)\/[^/]+)$/i.test(localPath(file)) || /^(?:\.git\/)?(?:HEAD|config|packed-refs|logs\/HEAD|refs\/(?:heads|tags|remotes)\/[^/]+)$/i.test(localPath(file)));
    const bytes = interesting.reduce((sum, file) => sum + file.size, 0);
    if (bytes > 32 * MiB || interesting.some((file) => file.size > 16 * MiB)) { status(ui.status, t('Selected Git metadata exceeds the 32 MiB total or 16 MiB per-file cap.', 'Os metadados Git excedem o limite de 32 MiB no total ou 16 MiB por arquivo.'), 'error'); return; }
    status(ui.status, t('Copying selected files into a read-only virtual filesystem…', 'Copiando arquivos selecionados para sistema virtual somente leitura…'));
    try {
      const entries = [];
      for (const file of interesting) entries.push({ path: localPath(file), text: await file.text() });
      const snapshot = analyzeGitSnapshot(entries);
      const safeConfig = sanitizeGitConfig(snapshot.config);
      let runtimeResult = null;
      let runtimeError = null;
      if (selectionBytes <= 256 * MiB && files.every((file) => file.size <= 64 * MiB)) {
        try {
          status(ui.status, t('Loading isomorphic-git and resolving repository objects…', 'Carregando isomorphic-git e resolvendo objetos do repositório…'));
          const git = await import('/vendor/suite/isomorphic-git.js');
          const virtualEntries = [];
          for (const file of files) virtualEntries.push({ path: gitVirtualPath(localPath(file)), bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified });
          const fs = createGitMemoryFs(virtualEntries);
          const options = { fs, dir: '/repo', gitdir: '/repo/.git' };
          const [branch, branches, tags, commits, matrix] = await Promise.all([
            git.currentBranch({ ...options, fullname: false }), git.listBranches(options), git.listTags(options), git.log({ ...options, depth: 200 }), git.statusMatrix(options)
          ]);
          runtimeResult = {
            branch, branches, tags,
            commits: commits.map((item) => ({ oid: item.oid, message: item.commit.message, parent: item.commit.parent, tree: item.commit.tree, author: { name: item.commit.author.name, email: '[redacted in export]', timestamp: item.commit.author.timestamp, timezoneOffset: item.commit.author.timezoneOffset } })),
            status: matrix.slice(0, 2_000).map((item) => ({ path: item[0], state: gitStatusLabel(item), matrix: item.slice(1) })), statusTruncated: matrix.length > 2_000
          };
        } catch (error) { runtimeError = error.message; }
      } else runtimeError = t('Selection exceeds the 256 MiB runtime cap; metadata fallback used.', 'A seleção excede o limite de 256 MiB do runtime; fallback de metadados usado.');
      report = { fallback: { ...snapshot, config: safeConfig, reflog: snapshot.reflog.map((item) => ({ ...item, email: '[redacted in export]' })) }, runtime: runtimeResult, runtimeError };
      const branch = runtimeResult?.branch || snapshot.head.branch || t('Detached HEAD', 'HEAD destacado');
      const referenceRows = runtimeResult ? [...runtimeResult.branches.map((item) => [`refs/heads/${item}`, 'branch']), ...runtimeResult.tags.map((item) => [`refs/tags/${item}`, 'tag'])] : snapshot.refs.map((item) => [item.ref, item.oid]);
      const historyRows = runtimeResult ? runtimeResult.commits.map((item) => [formatTimestamp(item.author.timestamp), item.oid.slice(0, 12), item.message.trim()]) : snapshot.reflog.slice(-200).reverse().map((item) => [formatTimestamp(item.timestamp), item.newOid.slice(0, 12), item.message]);
      renderMetrics(root, [[t('Branch', 'Branch'), branch], [t('References', 'Referências'), referenceRows.length.toLocaleString()], [t('History entries', 'Entradas de histórico'), historyRows.length.toLocaleString()], [t('Engine', 'Motor'), runtimeResult ? 'isomorphic-git' : t('Metadata fallback', 'Fallback de metadados')]]);
      renderTable(root.querySelector('[data-refs]'), referenceRows);
      renderTable(root.querySelector('[data-log]'), historyRows);
      renderTable(root.querySelector('[data-status-matrix]'), runtimeResult?.status.map((item) => [item.path, item.state, item.matrix.join(' / ')]) || [[t('Unavailable in metadata fallback', 'Indisponível no fallback de metadados'), '—', '—']]);
      root.querySelector('[data-config]').textContent = snapshot.config ? `${t('Core settings', 'Configurações core')}:\n${JSON.stringify(snapshot.config.core, null, 2)}\n\n${t('Remotes (credentials redacted in this view/export)', 'Remotos (credenciais ocultadas nesta visão/exportação)')}:\n${JSON.stringify(safeConfig.remotes, null, 2)}` : t('No .git/config file was retained.', 'Nenhum arquivo .git/config foi retido.');
      ui.download.disabled = false; toggleResult(root, true); status(ui.status, runtimeResult ? t('Read-only isomorphic-git snapshot complete.', 'Snapshot isomorphic-git somente leitura concluído.') : t(`Git runtime fallback used: ${runtimeError}`, `Fallback do runtime Git usado: ${runtimeError}`), runtimeResult ? 'success' : 'warning');
    } catch (error) { report = null; ui.download.disabled = true; toggleResult(root, false); status(ui.status, error.message, 'error'); }
  });
  ui.download.addEventListener('click', () => report && downloadBytes(root, JSON.stringify(report, null, 2), 'git-metadata-snapshot.json', 'application/json'));
  cleanup.add(() => { report = null; });
}

function mountGitClientV2(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'git-client', title: 'Inspect, diff, and commit a private Git copy', titlePt: 'Inspecionar, comparar e criar commit em cópia Git privada', badge: 'isomorphic-git', badgePt: 'isomorphic-git', results: 'Repository snapshot', resultsPt: 'Snapshot do repositório',
    controls: `<label class="field-label" for="git-folder-v2">${t('Repository or .git folder', 'Repositório ou pasta .git')}</label><input class="file-input" id="git-folder-v2" type="file" webkitdirectory multiple required data-files>
      <button class="button button-primary" type="submit">${t('Load private Git runtime', 'Carregar runtime Git privado')}</button><p class="field-help">${t('Up to 20,000 files and 256 MiB are copied into a private virtual filesystem. Branches, packed/loose objects, history, status, and bounded UTF-8 diffs are resolved with isomorphic-git. Branches and commits below update only this page-memory copy; the selected folder is never written and no remote operation is available.', 'Até 20.000 arquivos e 256 MiB são copiados para um sistema virtual privado. Branches, objetos compactados/soltos, histórico, status e diffs UTF-8 limitados são resolvidos com isomorphic-git. Branches e commits abaixo alteram apenas a cópia na memória desta página; a pasta selecionada nunca é modificada e nenhuma operação remota está disponível.')}</p>
      <h3>${t('Create and switch a virtual branch', 'Criar e alternar branch virtual')}</h3><label class="field-label" for="git-branch-name">${t('New branch name', 'Nome da nova branch')}</label><input class="text-input" id="git-branch-name" maxlength="255" placeholder="feature/local" data-branch-name>
      <button class="button" type="button" disabled data-branch>${t('Create and switch virtual branch', 'Criar e alternar branch virtual')}</button>
      <h3>${t('Create a virtual commit', 'Criar commit virtual')}</h3><label class="field-label" for="git-author-name">${t('Author name', 'Nome do autor')}</label><input class="text-input" id="git-author-name" maxlength="200" data-author-name>
      <label class="field-label" for="git-author-email">${t('Author email', 'E-mail do autor')}</label><input class="text-input" id="git-author-email" type="email" maxlength="320" data-author-email>
      <label class="field-label" for="git-message">${t('Commit message', 'Mensagem do commit')}</label><textarea class="code-input" id="git-message" rows="4" maxlength="16384" data-message></textarea>
      <button class="button" type="button" disabled data-commit>${t('Stage all and commit virtual copy', 'Preparar tudo e criar commit na cópia virtual')}</button>`,
    output: `<h3>${t('References', 'Referências')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('Branches and tags resolved from the private copy', 'Branches e tags resolvidos na cópia privada')}</caption><thead><tr><th>${t('Reference', 'Referência')}</th><th>${t('Kind', 'Tipo')}</th></tr></thead><tbody data-refs></tbody></table></div>
      <h3>${t('Commit history', 'Histórico de commits')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('Last 200 commits or reflog fallback entries', 'Últimos 200 commits ou entradas fallback de reflog')}</caption><thead><tr><th>${t('Time', 'Data')}</th><th>${t('Object', 'Objeto')}</th><th>${t('Message', 'Mensagem')}</th></tr></thead><tbody data-log></tbody></table></div>
      <h3>${t('Working-tree status', 'Status da árvore de trabalho')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('First 2,000 virtual status-matrix paths', 'Primeiros 2.000 caminhos da matriz de status virtual')}</caption><thead><tr><th>${t('Path', 'Caminho')}</th><th>${t('State', 'Estado')}</th><th>${t('HEAD / workdir / stage', 'HEAD / workdir / stage')}</th></tr></thead><tbody data-status-matrix></tbody></table></div>
      <h3>${t('Bounded text diffs', 'Diffs de texto limitados')}</h3><pre class="code-output" data-diffs></pre><h3>${t('Virtual commit result', 'Resultado do commit virtual')}</h3><pre class="code-output" data-commit-result></pre><h3>${t('Sanitized configuration', 'Configuração higienizada')}</h3><pre class="code-output" data-config></pre>`,
    empty: 'Choose a repository folder. Some browsers omit hidden .git folders; if HEAD is unavailable, select the .git folder directly where supported.', emptyPt: 'Escolha a pasta de um repositório. Alguns navegadores omitem pastas .git ocultas; se HEAD não estiver disponível, selecione diretamente a pasta .git onde houver suporte.', action: 'Download snapshot', actionPt: 'Baixar snapshot'
  });
  let report = null;
  let runtime = null;
  let fallbackSnapshot = null;
  let safeConfig = null;
  let fallbackError = null;
  const commitButton = root.querySelector('[data-commit]');
  const branchButton = root.querySelector('[data-branch]');

  async function collectDiffs(matrix) {
    const output = [];
    let retainedBytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let headOid = null;
    try { headOid = await runtime.git.resolveRef({ ...runtime.options, ref: 'HEAD' }); } catch (_) { /* unborn repository */ }
    for (const item of matrix) {
      const [filepath, head, workdir, stage] = item;
      if (head === 1 && workdir === 1 && stage === 1) continue;
      if (output.length >= 30) break;
      try {
        let leftBytes = new Uint8Array();
        let rightBytes = new Uint8Array();
        if (head && headOid) leftBytes = (await runtime.git.readBlob({ ...runtime.options, oid: headOid, filepath })).blob;
        if (workdir) rightBytes = await runtime.fs.promises.readFile(`/repo/${filepath}`);
        if (leftBytes.length > 256 * KiB || rightBytes.length > 256 * KiB || retainedBytes + leftBytes.length + rightBytes.length > 4 * MiB) {
          output.push({ path: filepath, skipped: 'Text diff exceeds the 256 KiB/file or 4 MiB/session preview cap.' });
          continue;
        }
        if (leftBytes.includes(0) || rightBytes.includes(0)) throw new Error('binary content');
        const left = decoder.decode(leftBytes);
        const right = decoder.decode(rightBytes);
        retainedBytes += leftBytes.length + rightBytes.length;
        const diff = diffTextLines(left, right, { maxLines: 2_000, maxCells: 2_000_000 });
        output.push({ path: filepath, added: diff.added, deleted: diff.deleted, leftLines: diff.leftLines, rightLines: diff.rightLines, changes: diff.changes.slice(0, 400), changesTruncated: diff.changes.length > 400 });
      } catch (error) { output.push({ path: filepath, skipped: error.message }); }
    }
    return output;
  }

  async function collectRuntime() {
    const { git, options } = runtime;
    const [branch, branches, tags, matrix] = await Promise.all([
      git.currentBranch({ ...options, fullname: false }), git.listBranches(options), git.listTags(options), git.statusMatrix(options)
    ]);
    let commits = [];
    try { commits = await git.log({ ...options, depth: 200 }); } catch (_) { /* unborn repositories have no log */ }
    const diffs = await collectDiffs(matrix);
    return {
      branch, branches, tags,
      commits: commits.map((item) => ({ oid: item.oid, message: item.commit.message, parent: item.commit.parent, tree: item.commit.tree, author: { name: item.commit.author.name, email: '[redacted in export]', timestamp: item.commit.author.timestamp, timezoneOffset: item.commit.author.timezoneOffset } })),
      status: matrix.slice(0, 2_000).map((item) => ({ path: item[0], state: gitStatusLabel(item), matrix: item.slice(1) })),
      statusTruncated: matrix.length > 2_000,
      changedPaths: matrix.filter((item) => !(item[1] === 1 && item[2] === 1 && item[3] === 1)).length,
      diffs
    };
  }

  function diffText(diffs) {
    if (!diffs?.length) return t('No changed UTF-8 text file is available for a bounded diff.', 'Nenhum arquivo de texto UTF-8 alterado está disponível para diff limitado.');
    return diffs.map((item) => {
      if (item.skipped) return `--- ${item.path}\n${t('Preview skipped', 'Prévia ignorada')}: ${item.skipped}`;
      const changes = item.changes.map((change) => `${change.type === 'add' ? '+' : '-'} ${change.type === 'add' ? change.rightLine : change.leftLine}: ${change.text}`).join('\n');
      return `--- ${item.path}\n+++ ${item.added} / --- ${item.deleted}\n${changes}${item.changesTruncated ? `\n… ${t('change preview truncated', 'prévia de mudanças truncada')}` : ''}`;
    }).join('\n\n').slice(0, MiB);
  }

  function renderSnapshot(runtimeResult, message = '') {
    const referenceRows = runtimeResult ? [...runtimeResult.branches.map((item) => [`refs/heads/${item}`, 'branch']), ...runtimeResult.tags.map((item) => [`refs/tags/${item}`, 'tag'])] : fallbackSnapshot.refs.map((item) => [item.ref, item.oid]);
    const historyRows = runtimeResult ? runtimeResult.commits.map((item) => [formatTimestamp(item.author.timestamp), item.oid.slice(0, 12), item.message.trim()]) : fallbackSnapshot.reflog.slice(-200).reverse().map((item) => [formatTimestamp(item.timestamp), item.newOid.slice(0, 12), item.message]);
    const branch = runtimeResult?.branch || fallbackSnapshot.head.branch || t('Detached HEAD', 'HEAD destacado');
    renderMetrics(root, [[t('Branch', 'Branch'), branch], [t('References', 'Referências'), referenceRows.length.toLocaleString()], [t('History entries', 'Entradas de histórico'), historyRows.length.toLocaleString()], [t('Changed paths', 'Caminhos alterados'), runtimeResult ? runtimeResult.changedPaths.toLocaleString() : t('Unavailable', 'Indisponível')]]);
    renderTable(root.querySelector('[data-refs]'), referenceRows.length ? referenceRows : [[t('No references found', 'Nenhuma referência encontrada'), '—']]);
    renderTable(root.querySelector('[data-log]'), historyRows.length ? historyRows : [[t('No commits found', 'Nenhum commit encontrado'), '—', '—']]);
    renderTable(root.querySelector('[data-status-matrix]'), runtimeResult?.status.map((item) => [item.path, item.state, item.matrix.join(' / ')]) || [[t('Unavailable in metadata fallback', 'Indisponível no fallback de metadados'), '—', '—']]);
    root.querySelector('[data-diffs]').textContent = runtimeResult ? diffText(runtimeResult.diffs) : t('Text diffs require the isomorphic-git runtime and repository objects.', 'Diffs de texto exigem o runtime isomorphic-git e os objetos do repositório.');
    root.querySelector('[data-commit-result]').textContent = message || (runtime?.localCommits.length ? JSON.stringify(runtime.localCommits.at(-1), null, 2) : t('No virtual commit created in this session.', 'Nenhum commit virtual criado nesta sessão.'));
    root.querySelector('[data-config]').textContent = fallbackSnapshot.config ? `${t('Core settings', 'Configurações core')}:\n${JSON.stringify(fallbackSnapshot.config.core, null, 2)}\n\n${t('Remotes (credentials redacted)', 'Remotos (credenciais ocultadas)')}:\n${JSON.stringify(safeConfig.remotes, null, 2)}` : t('No .git/config file was retained.', 'Nenhum arquivo .git/config foi retido.');
    commitButton.disabled = !runtimeResult || runtimeResult.changedPaths === 0;
    branchButton.disabled = !runtimeResult;
    report = { fallback: { ...fallbackSnapshot, config: safeConfig, reflog: fallbackSnapshot.reflog.map((item) => ({ ...item, email: '[redacted in export]' })) }, runtime: runtimeResult, runtimeError: fallbackError, localVirtualCommits: runtime?.localCommits || [] };
    ui.download.disabled = false; toggleResult(root, true);
  }

  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const files = [...root.querySelector('[data-files]').files];
    if (!files.length) return;
    if (files.length > 20_000) { status(ui.status, t('Selection exceeds 20,000 files.', 'A seleção excede 20.000 arquivos.'), 'error'); return; }
    const selectionBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (selectionBytes > 256 * MiB || files.some((file) => file.size > 64 * MiB)) { status(ui.status, t('The private Git runtime is capped at 256 MiB total and 64 MiB per file.', 'O runtime Git privado é limitado a 256 MiB no total e 64 MiB por arquivo.'), 'error'); return; }
    const interesting = files.filter((file) => /(?:^|\/)\.git\/(?:HEAD|config|packed-refs|logs\/HEAD|refs\/(?:heads|tags|remotes)\/[^/]+)$/i.test(localPath(file)) || /^(?:\.git\/)?(?:HEAD|config|packed-refs|logs\/HEAD|refs\/(?:heads|tags|remotes)\/[^/]+)$/i.test(localPath(file)));
    if (interesting.reduce((sum, file) => sum + file.size, 0) > 32 * MiB) { status(ui.status, t('Selected Git metadata exceeds the 32 MiB parsing cap.', 'Os metadados Git selecionados excedem o limite de interpretação de 32 MiB.'), 'error'); return; }
    status(ui.status, t('Copying the repository into private page memory…', 'Copiando o repositório para a memória privada da página…'));
    commitButton.disabled = true; branchButton.disabled = true; runtime = null; report = null;
    try {
      const entries = [];
      for (const file of interesting) entries.push({ path: localPath(file), text: await file.text() });
      fallbackSnapshot = analyzeGitSnapshot(entries);
      safeConfig = sanitizeGitConfig(fallbackSnapshot.config);
      root.querySelector('[data-author-name]').value = fallbackSnapshot.config?.identity?.name || '';
      root.querySelector('[data-author-email]').value = fallbackSnapshot.config?.identity?.email || '';
      try {
        if (!globalThis.Buffer) {
          const bufferModule = await import('/vendor/suite/buffer.js');
          globalThis.Buffer = bufferModule.Buffer || bufferModule.default?.Buffer;
          if (!globalThis.Buffer) throw new Error('The browser Buffer compatibility layer did not initialize.');
        }
        const git = await import('/vendor/suite/isomorphic-git.js');
        const virtualEntries = [];
        for (const file of files) {
          const path = gitVirtualPath(localPath(file));
          if (path) virtualEntries.push({ path, bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified });
        }
        const fs = createGitMemoryFs(virtualEntries, { mutable: true });
        runtime = { git, fs, options: { fs, dir: '/repo', gitdir: '/repo/.git' }, localCommits: [] };
        const runtimeResult = await collectRuntime();
        fallbackError = null;
        renderSnapshot(runtimeResult);
        status(ui.status, t('Private Git snapshot, status matrix, and bounded text diffs are ready.', 'Snapshot Git privado, matriz de status e diffs de texto limitados estão prontos.'), 'success');
      } catch (error) {
        runtime = null; fallbackError = error.message; renderSnapshot(null);
        status(ui.status, t(`Git object runtime failed; metadata fallback retained: ${error.message}`, `O runtime de objetos Git falhou; fallback de metadados mantido: ${error.message}`), 'warning');
      }
    } catch (error) { runtime = null; report = null; commitButton.disabled = true; branchButton.disabled = true; ui.download.disabled = true; toggleResult(root, false); status(ui.status, error.message, 'error'); }
  });

  branchButton.addEventListener('click', async () => {
    if (!runtime) return;
    branchButton.disabled = true;
    status(ui.status, t('Creating and switching the branch in the virtual copy…', 'Criando e alternando a branch na cópia virtual…'));
    try {
      const name = root.querySelector('[data-branch-name]').value.trim();
      if (!name || name.length > 255) throw new Error(t('Enter a branch name with 1–255 characters.', 'Informe um nome de branch com 1–255 caracteres.'));
      await runtime.git.branch({ ...runtime.options, ref: name, checkout: true });
      root.querySelector('[data-branch-name]').value = '';
      const refreshed = await collectRuntime();
      renderSnapshot(refreshed, t(`Created and switched to virtual branch ${name}.`, `Branch virtual ${name} criada e ativada.`));
      status(ui.status, t(`Virtual branch ${name} is active. The selected folder was not changed.`, `A branch virtual ${name} está ativa. A pasta selecionada não foi alterada.`), 'success');
    } catch (error) { status(ui.status, error.message, 'error'); branchButton.disabled = !runtime; }
  });

  commitButton.addEventListener('click', async () => {
    if (!runtime) return;
    commitButton.disabled = true;
    status(ui.status, t('Staging all changes and writing a commit into the virtual copy…', 'Preparando todas as mudanças e gravando commit na cópia virtual…'));
    try {
      const current = await collectRuntime();
      const metadata = prepareGitCommitMetadata({
        message: root.querySelector('[data-message]').value,
        authorName: root.querySelector('[data-author-name]').value,
        authorEmail: root.querySelector('[data-author-email]').value,
        branch: current.branch || 'detached-head',
        parent: current.commits[0]?.oid || null
      });
      const matrix = await runtime.git.statusMatrix(runtime.options);
      const changed = matrix.filter((item) => !(item[1] === 1 && item[2] === 1 && item[3] === 1));
      if (!changed.length) throw new Error(t('There are no virtual changes to commit.', 'Não há mudanças virtuais para criar commit.'));
      for (const [filepath, head, workdir] of changed) {
        if (workdir === 0 && head !== 0) await runtime.git.remove({ ...runtime.options, filepath });
        else if (workdir !== 0) await runtime.git.add({ ...runtime.options, filepath });
      }
      const timestamp = Math.floor(Date.parse(metadata.timestamp) / 1_000);
      const oid = await runtime.git.commit({ ...runtime.options, message: metadata.message, author: { ...metadata.author, timestamp, timezoneOffset: new Date().getTimezoneOffset() } });
      const retained = { ...metadata, preparedOnly: false, oid, author: { name: metadata.author.name, email: '[redacted in export]' }, virtualOnly: true };
      runtime.localCommits.push(retained);
      root.querySelector('[data-message]').value = '';
      const refreshed = await collectRuntime();
      renderSnapshot(refreshed, JSON.stringify(retained, null, 2));
      status(ui.status, t(`Virtual commit ${oid.slice(0, 12)} created. The selected folder was not changed.`, `Commit virtual ${oid.slice(0, 12)} criado. A pasta selecionada não foi alterada.`), 'success');
    } catch (error) { status(ui.status, error.message, 'error'); commitButton.disabled = !runtime; }
  });

  ui.download.addEventListener('click', () => report && downloadBytes(root, JSON.stringify(report, null, 2), 'git-private-snapshot.json', 'application/json'));
  cleanup.add(() => { report = null; runtime = null; fallbackSnapshot = null; });
}

function mountBinaryDiff(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'binary-diff', title: 'Compare two binaries', titlePt: 'Comparar dois binários', badge: 'Byte offsets', badgePt: 'Offsets de bytes', results: 'Changed regions', resultsPt: 'Regiões alteradas',
    controls: `<fieldset class="segmented-fieldset"><legend>${t('Operation', 'Operação')}</legend><label><input type="radio" name="diff-mode" value="compare" checked><span>${t('Compare', 'Comparar')}</span></label><label><input type="radio" name="diff-mode" value="apply"><span>${t('Apply patch', 'Aplicar patch')}</span></label></fieldset>
      <label class="field-label" for="diff-left">${t('Base file', 'Arquivo base')}</label><input class="file-input" id="diff-left" type="file" required data-left>
      <label class="field-label" for="diff-right">${t('Target file or .m13patch.json', 'Arquivo alvo ou .m13patch.json')}</label><input class="file-input" id="diff-right" type="file" required data-right>
      <button class="button button-primary" type="submit">${t('Run binary operation', 'Executar operação binária')}</button><p class="field-help">${t('64 MiB per binary, 96 MiB per patch, and 10,000 retained change runs. Comparison is positional; insertions shift subsequent offsets. Patch application verifies recorded SHA-256 values at both ends. The format is local, not BSDIFF/VCDIFF.', '64 MiB por binário, 96 MiB por patch e 10.000 regiões alteradas retidas. A comparação é posicional; inserções deslocam os offsets seguintes. A aplicação verifica SHA-256 registrados nas duas pontas. O formato é local, não BSDIFF/VCDIFF.')}</p>`,
    output: `<h3>${t('Byte change map', 'Mapa de alterações')}</h3><div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('First 1,000 positional change runs; previews retain 64 bytes per side', 'Primeiras 1.000 regiões posicionais; prévias retêm 64 bytes por lado')}</caption><thead><tr><th>${t('Offset', 'Offset')}</th><th>${t('Length', 'Tamanho')}</th><th>${t('Base bytes', 'Bytes base')}</th><th>${t('Target bytes', 'Bytes alvo')}</th></tr></thead><tbody data-runs></tbody></table></div><h3>${t('Entropy windows', 'Janelas de entropia')}</h3><pre class="code-output" data-entropy></pre>`,
    empty: 'Select a base and target to compare exact byte positions, size changes, and sampled entropy.', emptyPt: 'Selecione base e alvo para comparar posições exatas de bytes, mudanças de tamanho e entropia amostrada.', action: 'Download patch', actionPt: 'Baixar patch'
  });
  let artifact = null;
  let artifactName = 'change.m13patch.json';
  let artifactType = 'application/json';
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const leftFile = root.querySelector('[data-left]').files[0];
    const rightFile = root.querySelector('[data-right]').files[0];
    if (!leftFile || !rightFile) return;
    const mode = ui.form.elements['diff-mode'].value;
    if (leftFile.size > 64 * MiB || rightFile.size > (mode === 'apply' ? 96 * MiB : 64 * MiB)) { status(ui.status, t('A selected input exceeds its 64 MiB binary or 96 MiB patch cap.', 'Uma entrada excede o limite de 64 MiB para binário ou 96 MiB para patch.'), 'error'); return; }
    status(ui.status, mode === 'apply' ? t('Verifying and applying the patch locally…', 'Verificando e aplicando o patch localmente…') : t('Comparing byte positions locally…', 'Comparando posições de bytes localmente…'));
    try {
      const left = await readFileBytes(leftFile, 64 * MiB);
      if (mode === 'apply') {
        const parsedPatch = JSON.parse(await rightFile.text());
        if (!/^[a-f0-9]{64}$/i.test(parsedPatch.baseSha256 || '') || !/^[a-f0-9]{64}$/i.test(parsedPatch.targetSha256 || '')) throw new Error(t('This patch lacks the required base and target SHA-256 digests.', 'Este patch não contém os digests SHA-256 obrigatórios da base e do alvo.'));
        const baseDigest = await sha256Hex(left);
        if (parsedPatch.baseSha256.toLowerCase() !== baseDigest) throw new Error(t('Base SHA-256 does not match this patch.', 'O SHA-256 da base não corresponde ao patch.'));
        const target = applyBinaryPatch(left, parsedPatch);
        const targetDigest = await sha256Hex(target);
        if (parsedPatch.targetSha256.toLowerCase() !== targetDigest) throw new Error(t('Applied target SHA-256 failed verification.', 'O SHA-256 do alvo aplicado falhou na verificação.'));
        artifact = target; artifactName = safeName(parsedPatch.targetName, 'patched.bin'); artifactType = 'application/octet-stream';
        const changes = parsedPatch.changes || [];
        renderMetrics(root, [[t('Base size', 'Tamanho base'), formatBytes(left.length)], [t('Target size', 'Tamanho alvo'), formatBytes(target.length)], [t('Patch ranges', 'Intervalos do patch'), changes.length.toLocaleString()], [t('SHA-256', 'SHA-256'), t('Verified', 'Verificado')]]);
        renderTable(root.querySelector('[data-runs]'), changes.slice(0, 1_000).map((change) => [`0x${Number(change.offset).toString(16)}`, t('Encoded range', 'Intervalo codificado'), t('Verified base', 'Base verificada'), t('Authenticated by target digest', 'Autenticado pelo digest alvo')]));
        root.querySelector('[data-entropy]').textContent = `${t('Patched target entropy', 'Entropia do alvo com patch')}: ${shannonEntropy(target).toFixed(4)} / 8`;
        ui.download.textContent = t('Download patched file', 'Baixar arquivo com patch');
        ui.download.disabled = false; toggleResult(root, true); status(ui.status, t('Patch applied and recorded digests verified.', 'Patch aplicado e digests registrados verificados.'), 'success');
        return;
      }
      const right = await readFileBytes(rightFile, 64 * MiB);
      const diff = diffBytes(left, right);
      let patch = null;
      if (!diff.truncated) {
        patch = createBinaryPatch(left, right);
        patch.baseName = leftFile.name;
        patch.targetName = rightFile.name;
        patch.baseSha256 = await sha256Hex(left);
        patch.targetSha256 = await sha256Hex(right);
        artifact = JSON.stringify(patch, null, 2); artifactName = `${safeName(rightFile.name)}.m13patch.json`; artifactType = 'application/json';
      } else artifact = null;
      renderMetrics(root, [[t('Base size', 'Tamanho base'), formatBytes(left.length)], [t('Target size', 'Tamanho alvo'), formatBytes(right.length)], [t('Changed offsets', 'Offsets alterados'), diff.changedBytes.toLocaleString()], [t('Change runs', 'Regiões alteradas'), diff.runs.length.toLocaleString()]]);
      renderTable(root.querySelector('[data-runs]'), diff.runs.slice(0, 1_000).map((run) => [`0x${run.offset.toString(16)}`, run.length, run.leftHex || '∅', run.rightHex || '∅']));
      const leftWindows = entropyWindows(left, Math.max(256, Math.ceil(left.length / 32 / 256) * 256)).slice(0, 32);
      const rightWindows = entropyWindows(right, Math.max(256, Math.ceil(right.length / 32 / 256) * 256)).slice(0, 32);
      root.querySelector('[data-entropy]').textContent = `${t('Base', 'Base')}:   ${leftWindows.map((item) => item.entropy.toFixed(2)).join(' ')}\n${t('Target', 'Alvo')}: ${rightWindows.map((item) => item.entropy.toFixed(2)).join(' ')}`;
      ui.download.textContent = t('Download patch', 'Baixar patch');
      ui.download.disabled = !patch; toggleResult(root, true); status(ui.status, diff.truncated ? t('Comparison reached the 10,000-run retention cap; no complete patch is available.', 'A comparação atingiu o limite de 10.000 regiões; não há patch completo.') : diff.changedBytes ? t('Binary differences found; patch is ready.', 'Diferenças binárias encontradas; o patch está pronto.') : t('Files are byte-identical; an empty verified patch is available.', 'Os arquivos são idênticos; um patch vazio verificado está disponível.'), diff.changedBytes || diff.truncated ? 'warning' : 'success');
    } catch (error) { artifact = null; ui.download.disabled = true; toggleResult(root, false); status(ui.status, error instanceof SyntaxError ? t('Patch JSON is invalid.', 'O JSON do patch é inválido.') : error.message, 'error'); }
  });
  ui.download.addEventListener('click', () => artifact != null && downloadBytes(root, artifact, artifactName, artifactType));
  cleanup.add(() => { artifact = null; });
}

function mountCodePlayground(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'code-playground', title: 'Run a browser playground', titlePt: 'Executar playground no navegador', badge: 'Local sandboxes', badgePt: 'Sandboxes locais', results: 'Preview / compiler status', resultsPt: 'Prévia / status do compilador',
    controls: `<label class="field-label" for="play-language">${t('Target', 'Alvo')}</label><select id="play-language" data-language>${optionMarkup([['web', 'HTML + CSS + JavaScript'], ['javascript', 'JavaScript worker'], ['json', 'JSON validation'], ['wasm', 'WebAssembly binary'], ['c', 'C'], ['cpp', 'C++'], ['rust', 'Rust']], 'web')}</select>
      <label class="field-label" for="play-wasm">${t('WebAssembly file (for WASM target)', 'Arquivo WebAssembly (para alvo WASM)')}</label><input class="file-input" id="play-wasm" type="file" accept=".wasm,application/wasm" data-wasm>
      <label class="field-label" for="play-html">HTML</label><textarea class="code-input" id="play-html" rows="5" data-html><h1>Local playground</h1><button id="hello">Run</button></textarea>
      <label class="field-label" for="play-css">CSS</label><textarea class="code-input" id="play-css" rows="4" data-css>button { padding: .75rem 1rem; }</textarea>
      <label class="field-label" for="play-js">JavaScript / source</label><textarea class="code-input" id="play-js" rows="7" spellcheck="false" data-js>document.querySelector('#hello').addEventListener('click', () => { document.querySelector('h1').textContent = 'It works locally'; });</textarea>
      <button class="button button-primary" type="submit">${t('Build / inspect locally', 'Construir / inspecionar localmente')}</button><button class="button" type="button" hidden data-reload>${t('Reload once for compiler isolation', 'Recarregar uma vez para isolamento do compilador')}</button><p class="field-help">${t('Web previews use an opaque-origin iframe with network-blocking CSP; JavaScript uses a timed, network-disabled worker; WASM receives real validation. C/C++ starts the site-hosted Emception/Clang toolchain (up to about 117 MiB cached assets). Rust opens a site-hosted Rubrc/rustc workspace (about 110 MiB on first use, then browser-cached) with a local WASI sysroot and no external connections. Native compilers require cross-origin isolation.', 'Prévias web usam iframe de origem opaca com CSP que bloqueia rede; JavaScript usa worker cronometrado e sem rede; WASM recebe validação real. C/C++ inicia o toolchain Emception/Clang hospedado no site (até cerca de 117 MiB em cache). Rust abre um workspace Rubrc/rustc hospedado no site (cerca de 110 MiB no primeiro uso, depois em cache) com sysroot WASI local e sem conexões externas. Compiladores nativos exigem isolamento entre origens.')}</p>`,
    output: `<iframe title="${t('Sandboxed code preview', 'Prévia de código em sandbox')}" sandbox="allow-scripts" hidden data-preview></iframe><pre class="code-output" data-report></pre>`,
    empty: 'Use the web target for a real sandboxed preview, or inspect and validate an existing WebAssembly module.', emptyPt: 'Use o alvo web para uma prévia real em sandbox ou inspecione e valide um módulo WebAssembly existente.', action: 'Download artifact', actionPt: 'Baixar artefato'
  });
  let artifact = null;
  let artifactName = '';
  let artifactType = '';
  let emception = null;
  const iframe = root.querySelector('[data-preview]');
  const reloadButton = root.querySelector('[data-reload]');
  iframe.style.width = '100%'; iframe.style.minHeight = '24rem'; iframe.style.border = '1px solid var(--line)';
  try {
    const restored = sessionStorage.getItem('m13-code-playground-source');
    const restoredLanguage = sessionStorage.getItem('m13-code-playground-language');
    if (restored && ['c', 'cpp', 'rust'].includes(restoredLanguage)) { root.querySelector('[data-js]').value = restored; root.querySelector('[data-language]').value = restoredLanguage; }
    sessionStorage.removeItem('m13-code-playground-source'); sessionStorage.removeItem('m13-code-playground-language');
  } catch (_) { /* storage can be unavailable */ }
  reloadButton.addEventListener('click', () => {
    try { sessionStorage.setItem('m13-code-playground-source', root.querySelector('[data-js]').value); sessionStorage.setItem('m13-code-playground-language', root.querySelector('[data-language]').value); } catch (_) { /* reload without restore */ }
    globalThis.location.reload();
  });
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const language = root.querySelector('[data-language]').value;
    ui.download.disabled = true;
    artifact = null;
    status(ui.status, t('Checking the selected local runtime…', 'Verificando o runtime local selecionado…'));
    try {
      if (language === 'web') {
        const fields = { html: root.querySelector('[data-html]').value, css: root.querySelector('[data-css]').value, javascript: root.querySelector('[data-js]').value };
        if (Object.values(fields).some((value) => value.length > MiB)) throw new Error(t('Each web source field is capped at 1 MiB.', 'Cada campo de código web é limitado a 1 MiB.'));
        artifact = buildPreviewDocument(fields); artifactName = 'local-playground.html'; artifactType = 'text/html';
        iframe.setAttribute('sandbox', 'allow-scripts'); iframe.style.minHeight = '24rem'; iframe.srcdoc = artifact; iframe.hidden = false;
        root.querySelector('[data-report]').textContent = t('Preview compiled from HTML/CSS/JavaScript. The iframe CSP blocks network, storage access is isolated by opaque origin, and scripts cannot reach the parent page.', 'Prévia criada de HTML/CSS/JavaScript. A CSP do iframe bloqueia rede, o armazenamento fica isolado por origem opaca e scripts não alcançam a página pai.');
        renderMetrics(root, [[t('Target', 'Alvo'), 'Web'], [t('Artifact', 'Artefato'), formatBytes(new Blob([artifact]).size)], [t('Network', 'Rede'), t('Blocked by CSP', 'Bloqueada por CSP')], [t('Execution', 'Execução'), t('Sandboxed', 'Em sandbox')]]);
        ui.download.disabled = false; toggleResult(root, true); status(ui.status, t('Sandboxed web preview is running.', 'A prévia web em sandbox está rodando.'), 'success');
        return;
      }
      iframe.hidden = true; iframe.removeAttribute('srcdoc'); iframe.removeAttribute('src'); iframe.setAttribute('sandbox', 'allow-scripts'); iframe.style.minHeight = '24rem';
      if (language === 'rust') {
        const source = root.querySelector('[data-js]').value;
        if (!source.trim() || source.length > MiB) throw new Error(t('Rust source must contain 1 byte to 1 MiB.', 'O código Rust deve conter de 1 byte a 1 MiB.'));
        if (!globalThis.crossOriginIsolated) {
          if (!navigator.serviceWorker) throw new Error(t('This browser cannot register the isolation service worker required by rustc.', 'Este navegador não pode registrar o service worker de isolamento exigido pelo rustc.'));
          await navigator.serviceWorker.register('/coi-serviceworker.js', { scope: '/' });
          await navigator.serviceWorker.ready;
          reloadButton.hidden = false;
          root.querySelector('[data-report]').textContent = t('The isolation helper is registered. Use “Reload once for compiler isolation”; your Rust source will be restored after reload.', 'O auxiliar de isolamento foi registrado. Use “Recarregar uma vez para isolamento do compilador”; seu código Rust será restaurado após recarregar.');
          renderMetrics(root, [[t('Target', 'Alvo'), 'Rust'], [t('Compiler', 'Compilador'), 'Rubrc / rustc WASM'], [t('Isolation', 'Isolamento'), t('Reload required', 'Recarregamento necessário')], [t('Output', 'Saída'), t('Not compiled yet', 'Ainda não compilado')]]);
          toggleResult(root, true); status(ui.status, t('Rust compiler isolation requires one explicit reload.', 'O compilador Rust exige um recarregamento explícito para isolamento.'), 'warning');
          return;
        }
        reloadButton.hidden = true;
        try { sessionStorage.setItem('m13-rust-source', source); } catch (_) { throw new Error(t('Session storage is required to transfer source into the isolated Rust workspace.', 'O armazenamento da sessão é necessário para transferir o código ao workspace Rust isolado.')); }
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads'); iframe.style.minHeight = '56rem'; iframe.src = `/assets/runtime/rustc/index.html?session=${Date.now()}`; iframe.hidden = false;
        root.querySelector('[data-report]').textContent = t('The Rust workspace is loading the site-hosted rustc/Cargo toolchain and local wasm32-wasip1 sysroot. Use “Compile and Run” inside the workspace; its Download button returns the generated WASI .wasm file. The first load is large and may take a minute on slower devices.', 'O workspace Rust está carregando o toolchain rustc/Cargo e o sysroot wasm32-wasip1 hospedados neste site. Use “Compile and Run” dentro do workspace; o botão Download retorna o arquivo WASI .wasm gerado. O primeiro carregamento é grande e pode levar um minuto em dispositivos mais lentos.');
        renderMetrics(root, [[t('Target', 'Alvo'), 'Rust → wasm32-wasip1'], [t('Compiler', 'Compilador'), 'Rubrc / rustc WASM'], [t('Runtime', 'Runtime'), t('Site-hosted and cached', 'Hospedado no site e em cache')], [t('External network', 'Rede externa'), t('Blocked by workspace CSP', 'Bloqueada pela CSP do workspace')]]);
        toggleResult(root, true); status(ui.status, t('Rust workspace started locally. Compilation and artifact download are available inside it.', 'Workspace Rust iniciado localmente. Compilação e download do artefato estão disponíveis dentro dele.'), 'success');
        return;
      }
      if (language === 'javascript') {
        const source = root.querySelector('[data-js]').value;
        const executed = await runSuiteWorker('javascript-cell', { source, data: null }, 2_000, cleanup);
        const transcript = [...executed.logs, ...(executed.result === undefined ? [] : [executed.result])].join('\n');
        artifact = transcript; artifactName = 'javascript-worker-output.txt'; artifactType = 'text/plain';
        root.querySelector('[data-report]').textContent = transcript || t('(completed without output)', '(concluído sem saída)');
        renderMetrics(root, [[t('Target', 'Alvo'), 'JavaScript'], [t('Execution', 'Execução'), t('Module worker', 'Worker de módulo')], [t('Time limit', 'Limite de tempo'), '2 s'], [t('Network', 'Rede'), t('Blocked in worker', 'Bloqueada no worker')]]);
        ui.download.disabled = false; toggleResult(root, true); status(ui.status, t('JavaScript worker completed and was terminated.', 'O worker JavaScript terminou e foi encerrado.'), 'success');
        return;
      }
      if (language === 'json') {
        const parsed = JSON.parse(root.querySelector('[data-js]').value);
        artifact = JSON.stringify(parsed, null, 2); artifactName = 'validated.json'; artifactType = 'application/json';
        root.querySelector('[data-report]').textContent = artifact.slice(0, MiB);
        renderMetrics(root, [[t('Target', 'Alvo'), 'JSON'], [t('Validated', 'Validado'), t('Yes', 'Sim')], [t('Top-level type', 'Tipo no topo'), Array.isArray(parsed) ? t('Array', 'Array') : parsed === null ? 'null' : typeof parsed], [t('Size', 'Tamanho'), formatBytes(new Blob([artifact]).size)]]);
        ui.download.disabled = false; toggleResult(root, true); status(ui.status, t('JSON parsed successfully.', 'JSON interpretado com sucesso.'), 'success');
        return;
      }
      if (language === 'wasm') {
        const file = root.querySelector('[data-wasm]').files[0];
        if (!file) throw new Error(t('Select a .wasm file.', 'Selecione um arquivo .wasm.'));
        const bytes = await readFileBytes(file, 16 * MiB, 'WebAssembly file');
        const inspection = inspectWasmModule(bytes);
        artifact = JSON.stringify(inspection, null, 2); artifactName = `${safeName(file.name)}.wasm-inspection.json`; artifactType = 'application/json';
        root.querySelector('[data-report]').textContent = artifact;
        renderMetrics(root, [[t('Validated', 'Validado'), inspection.validated ? t('Yes', 'Sim') : t('No', 'Não')], [t('Sections', 'Seções'), inspection.sections.length], [t('Imports', 'Imports'), inspection.imports.length], [t('Exports', 'Exports'), inspection.exports.length]]);
        ui.download.disabled = false; toggleResult(root, true); status(ui.status, inspection.validated ? t('WebAssembly module validated by the browser.', 'Módulo WebAssembly validado pelo navegador.') : inspection.reason, inspection.validated ? 'success' : 'error');
        return;
      }
      if (language === 'c' || language === 'cpp') {
        const source = root.querySelector('[data-js]').value;
        if (!source.trim() || source.length > MiB) throw new Error(t('C/C++ source must contain 1 byte to 1 MiB.', 'O código C/C++ deve conter de 1 byte a 1 MiB.'));
        if (!globalThis.crossOriginIsolated) {
          if (!navigator.serviceWorker) throw new Error(t('This browser cannot register the isolation service worker required by the compiler.', 'Este navegador não pode registrar o service worker de isolamento exigido pelo compilador.'));
          await navigator.serviceWorker.register('/coi-serviceworker.js', { scope: '/' });
          await navigator.serviceWorker.ready;
          reloadButton.hidden = false;
          root.querySelector('[data-report]').textContent = t('The isolation helper is registered. Use “Reload once for compiler isolation”; your source and selected C/C++ language will be restored after reload.', 'O auxiliar de isolamento foi registrado. Use “Recarregar uma vez para isolamento do compilador”; seu código e a linguagem C/C++ serão restaurados após recarregar.');
          renderMetrics(root, [[t('Target', 'Alvo'), language.toUpperCase()], [t('Compiler', 'Compilador'), 'Emception / Clang'], [t('Isolation', 'Isolamento'), t('Reload required', 'Recarregamento necessário')], [t('Output', 'Saída'), t('Not compiled yet', 'Ainda não compilado')]]);
          toggleResult(root, true); status(ui.status, t('Compiler isolation requires one explicit reload.', 'O isolamento do compilador exige um recarregamento explícito.'), 'warning');
          return;
        }
        reloadButton.hidden = true;
        status(ui.status, t('Loading the site-hosted Clang toolchain, compiling, and running locally…', 'Carregando o toolchain Clang hospedado no site, compilando e executando localmente…'));
        let compilerTimedOut = false;
        let compilerTimer;
        const compilerOperation = (async () => {
          if (!emception) {
            const { createEmception } = await import('/vendor/emception/browser.js');
            const created = await createEmception({ manifestUrl: '/vendor/emception/cdn/manifest.json', tty: 'none' });
            if (compilerTimedOut) { created.dispose?.(); throw new Error('Compiler stopped at the 120-second wall-time limit.'); }
            emception = created;
          }
          // Emception 4.4's headless bridge currently writes the convenience
          // source argument as a relative VFS path while compiling from this
          // workspace. Materialize the same source at the resolved path first.
          await emception.workspace.writeFile('/home/user/default/main.cpp', source);
          if (compilerTimedOut) throw new Error('Compiler stopped at the 120-second wall-time limit.');
          return emception.compileAndRun(source, { build: { toolchain: language }, cwd: '/home/user/default', stdin: 'none', stdout: 'capture', stderr: 'capture' });
        })();
        const compiled = await Promise.race([compilerOperation, new Promise((_, reject) => {
          compilerTimer = setTimeout(() => {
            compilerTimedOut = true;
            emception?.dispose?.(); emception = null;
            reject(new Error(t('Compiler stopped at the 120-second wall-time limit.', 'O compilador foi interrompido no limite total de 120 segundos.')));
          }, 120_000);
        })]).finally(() => clearTimeout(compilerTimer));
        let wasm = null;
        if (compiled.exitCode === 0) {
          try { wasm = await emception.workspace.readFile('/home/user/default/main.wasm'); } catch (_) { /* diagnostics still useful */ }
          if (wasm && !globalThis.WebAssembly?.validate?.(asBytes(wasm))) throw new Error(t('Compiler returned an invalid WebAssembly artifact.', 'O compilador retornou um artefato WebAssembly inválido.'));
        }
        artifact = wasm ? asBytes(wasm) : `${compiled.stdout || ''}${compiled.stderr ? `\n${compiled.stderr}` : ''}`;
        artifactName = wasm ? `program-${language}.wasm` : `compiler-${language}-diagnostics.txt`;
        artifactType = wasm ? 'application/wasm' : 'text/plain';
        root.querySelector('[data-report]').textContent = `${t('Exit code', 'Código de saída')}: ${compiled.exitCode}\n${t('Duration', 'Duração')}: ${Number(compiled.durationMs || 0).toFixed(1)} ms\n\nSTDOUT\n${compiled.stdout || ''}\n\nSTDERR\n${compiled.stderr || ''}`.slice(0, MiB);
        renderMetrics(root, [[t('Target', 'Alvo'), language.toUpperCase()], [t('Compiler', 'Compilador'), 'Clang / Emception'], [t('Exit code', 'Código de saída'), compiled.exitCode], [t('WASM artifact', 'Artefato WASM'), wasm ? formatBytes(wasm.length) : t('Unavailable', 'Indisponível')]]);
        ui.download.disabled = artifact == null; toggleResult(root, true); status(ui.status, compiled.exitCode === 0 ? t('Compilation and local execution completed.', 'Compilação e execução local concluídas.') : t('The compiler returned diagnostics; no success was simulated.', 'O compilador retornou diagnósticos; nenhum sucesso foi simulado.'), compiled.exitCode === 0 ? 'success' : 'error');
        return;
      }
      throw new Error(t(`Unsupported playground target: ${language}`, `Alvo de playground incompatível: ${language}`));
    } catch (error) { artifact = null; iframe.hidden = true; iframe.removeAttribute('srcdoc'); iframe.removeAttribute('src'); iframe.setAttribute('sandbox', 'allow-scripts'); toggleResult(root, false); status(ui.status, error.message, 'error'); }
  });
  ui.download.addEventListener('click', () => artifact != null && downloadBytes(root, artifact, artifactName, artifactType));
  cleanup.add(() => { artifact = null; iframe.removeAttribute('srcdoc'); iframe.removeAttribute('src'); emception?.dispose?.(); emception = null; });
}

function mountPacketAnalyzer(app, cleanup) {
  const { root, t } = app;
  const ui = shell(app, {
    key: 'packet-analyzer', title: 'Inspect an offline capture', titlePt: 'Inspecionar captura offline', badge: 'PCAP / PCAPNG', badgePt: 'PCAP / PCAPNG', results: 'Decoded packets', resultsPt: 'Pacotes decodificados',
    controls: `<label class="field-label" for="packet-file">${t('PCAP or PCAPNG file', 'Arquivo PCAP ou PCAPNG')}</label><input class="file-input" id="packet-file" type="file" accept=".pcap,.cap,.pcapng,application/vnd.tcpdump.pcap" required data-file>
      <label class="field-label" for="packet-filter">${t('Protocol filter', 'Filtro de protocolo')}</label><select id="packet-filter" data-filter><option value="">${t('All decoded protocols', 'Todos os protocolos decodificados')}</option></select>
      <button class="button button-primary" type="submit">${t('Parse capture locally', 'Interpretar captura localmente')}</button><p class="field-help">${t('256 MiB, 20,000 packets, and 256 MiB captured payload cap. Decodes Ethernet/raw IPv4 and IPv6 with TCP, UDP, DNS query names, ICMP/ICMPv6, and ARP summaries; IPv6 extension chains are labeled but not traversed. It never contacts captured hosts.', 'Limite de 256 MiB, 20.000 pacotes e 256 MiB de payload capturado. Decodifica Ethernet/IPv4 e IPv6 crus com resumos TCP, UDP, nomes de consulta DNS, ICMP/ICMPv6 e ARP; cadeias de extensões IPv6 são identificadas, mas não percorridas. Nunca contata os hosts capturados.')}</p>`,
    output: `<div class="table-scroll" role="region" tabindex="0"><table class="data-table"><caption>${t('First 2,000 packets matching the local filter', 'Primeiros 2.000 pacotes correspondentes ao filtro local')}</caption><thead><tr><th>#</th><th>${t('Timestamp', 'Data/hora')}</th><th>${t('Protocol', 'Protocolo')}</th><th>${t('Source', 'Origem')}</th><th>${t('Destination', 'Destino')}</th><th>${t('Length', 'Tamanho')}</th><th>${t('Info', 'Info')}</th></tr></thead><tbody data-packets></tbody></table></div>`,
    empty: 'Open a saved capture for bounded protocol summaries. Payload bodies are not rendered or transmitted.', emptyPt: 'Abra uma captura salva para resumos limitados de protocolos. Corpos de payload não são renderizados nem transmitidos.', action: 'Download packet JSON', actionPt: 'Baixar JSON dos pacotes'
  });
  let capture = null;
  const filter = root.querySelector('[data-filter]');
  function render() {
    if (!capture) return;
    const selected = filter.value;
    const packets = selected ? capture.packets.filter((packet) => packet.protocol === selected) : capture.packets;
    const protocols = new Map();
    for (const packet of capture.packets) protocols.set(packet.protocol, (protocols.get(packet.protocol) || 0) + 1);
    renderMetrics(root, [[t('Format', 'Formato'), capture.format.toUpperCase()], [t('Packets', 'Pacotes'), capture.packets.length.toLocaleString()], [t('Captured bytes', 'Bytes capturados'), formatBytes(capture.capturedBytes)], [t('Protocols', 'Protocolos'), protocols.size.toLocaleString()]]);
    renderTable(root.querySelector('[data-packets]'), packets.slice(0, 2_000).map((packet) => [packet.index, formatTimestamp(packet.timestampSeconds), packet.protocol, packet.source, packet.destination, packet.includedLength, packet.info]));
    toggleResult(root, true);
  }
  filter.addEventListener('change', render);
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = root.querySelector('[data-file]').files[0];
    if (!file) return;
    if (file.size > 256 * MiB) { status(ui.status, t('Capture exceeds the 256 MiB cap.', 'A captura excede o limite de 256 MiB.'), 'error'); return; }
    status(ui.status, t('Parsing packet blocks and protocol headers locally…', 'Interpretando blocos de pacotes e cabeçalhos de protocolos localmente…'));
    try {
      capture = parsePcap(await readFileBytes(file, 256 * MiB), { maxPackets: 20_000, maxCapturedBytes: 256 * MiB });
      const protocols = [...new Set(capture.packets.map((packet) => packet.protocol))].sort();
      const doc = root.ownerDocument;
      filter.replaceChildren();
      const all = doc.createElement('option'); all.value = ''; all.textContent = t('All decoded protocols', 'Todos os protocolos decodificados'); filter.append(all);
      for (const protocol of protocols) { const option = doc.createElement('option'); option.value = protocol; option.textContent = protocol; filter.append(option); }
      render(); ui.download.disabled = false;
      status(ui.status, capture.truncated ? t('Capture parsed up to the configured packet/payload limit.', 'Captura interpretada até o limite configurado de pacotes/payload.') : t('Offline capture parsing complete.', 'Interpretação offline da captura concluída.'), capture.truncated ? 'warning' : 'success');
    } catch (error) { capture = null; ui.download.disabled = true; toggleResult(root, false); status(ui.status, error.message, 'error'); }
  });
  ui.download.addEventListener('click', () => capture && downloadBytes(root, JSON.stringify(capture, null, 2), 'packet-summary.json', 'application/json'));
  cleanup.add(() => { capture = null; });
}

const MOUNTERS = Object.freeze({
  'file-inspector': mountFileInspector,
  'file-deduplicator': mountFileDeduplicator,
  'encryption-vault': mountEncryptionVault,
  'sqlite-workbench': mountSqliteWorkbench,
  'duckdb-studio': mountDuckdbStudio,
  'data-converter': mountDataConverter,
  'bi-dashboard': mountBiDashboard,
  'data-notebook': mountDataNotebook,
  'regex-workbench': mountRegexWorkbench,
  'git-client': mountGitClientV2,
  'binary-diff': mountBinaryDiff,
  'code-playground': mountCodePlayground,
  'packet-analyzer': mountPacketAnalyzer
});

export function mountTool(key, app) {
  if (!toolKeys.includes(key)) throw new Error(`Unknown data/developer tool key: ${key}.`);
  if (!app?.root || typeof app.t !== 'function') throw new TypeError('mountTool requires app={root,t,pt}.');
  mountedCleanups.get(app.root)?.();
  const cleanup = makeCleanup(app.root);
  MOUNTERS[key](app, cleanup);
  const run = () => { cleanup.run(); mountedCleanups.delete(app.root); };
  const view = app.root.ownerDocument?.defaultView;
  if (view) {
    view.addEventListener('pagehide', run, { once: true });
    cleanup.add(() => view.removeEventListener('pagehide', run));
  }
  mountedCleanups.set(app.root, run);
  return run;
}
