import { downloadBlob, formatBytes, sanitizeFilename, setStatus } from '../../toolkit.js';

export const toolKeys = Object.freeze([
  'universal-image-converter',
  'image-compressor',
  'raw-photo-processor',
  'svg-studio',
  'image-metadata-workbench',
  'ocr-studio',
  'document-scanner',
  'panorama-stitcher',
  'hdr-merger',
  'pixel-texture-editor',
  'offline-video-player',
  'video-converter',
  'video-compressor'
]);

const IMAGE_INPUT_LIMIT = 64 * 1024 * 1024;
const IMAGE_PIXEL_LIMIT = 80_000_000;
const IMAGE_DECODE_BUDGET = 512 * 1024 * 1024;
const RAW_INPUT_LIMIT = 128 * 1024 * 1024;
const RAW_PIXEL_LIMIT = 40_000_000;
const VIDEO_INPUT_LIMIT = 1024 * 1024 * 1024;
const VIDEO_TRANSCODE_LIMIT_SECONDS = 120;
const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');

export function mountTool(key, app) {
  if (!toolKeys.includes(key)) throw new Error(`Unknown media tool: ${key}`);
  if (!app?.root || typeof app.t !== 'function') throw new TypeError('mountTool needs { root, t, pt }.');
  const mounts = {
    'universal-image-converter': mountImageConverter,
    'image-compressor': mountImageCompressor,
    'raw-photo-processor': mountRawProcessor,
    'svg-studio': mountSvgStudio,
    'image-metadata-workbench': mountMetadataWorkbench,
    'ocr-studio': mountOcrStudio,
    'document-scanner': mountDocumentScanner,
    'panorama-stitcher': mountPanorama,
    'hdr-merger': mountHdr,
    'pixel-texture-editor': mountPixelEditor,
    'offline-video-player': mountVideoPlayer,
    'video-converter': (value) => mountVideoRecorder(value, false),
    'video-compressor': (value) => mountVideoRecorder(value, true)
  };
  const cleanup = mounts[key](app) || (() => {});
  const pageCleanup = () => cleanup();
  globalThis.addEventListener?.('pagehide', pageCleanup, { once: true });
  return () => { globalThis.removeEventListener?.('pagehide', pageCleanup); cleanup(); };
}

export function calculateContainedSize(width, height, maxWidth, maxHeight = maxWidth, allowUpscale = false) {
  for (const value of [width, height, maxWidth, maxHeight]) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('Dimensions must be positive finite numbers.');
  }
  const scale = Math.min(maxWidth / width, maxHeight / height, allowUpscale ? Infinity : 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

export function detectImageFormat(input) {
  const bytes = asBytes(input);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 2 && ascii(bytes, 0, 2) === 'BM') return 'bmp';
  if (bytes.length >= 4 && (ascii(bytes, 0, 4) === 'II*\0' || ascii(bytes, 0, 4) === 'MM\0*')) return 'tiff';
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, Math.min(bytes.length, 32));
    if (/(?:avif|avis)/.test(brand)) return 'avif';
    if (/(?:heic|heix|hevc|hevx|mif1)/.test(brand)) return 'heic';
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'gif';
  return 'unknown';
}

export function inspectImageBytes(input) {
  const bytes = asBytes(input);
  const format = detectImageFormat(bytes);
  const result = { format, width: null, height: null, metadata: [], chunks: [] };
  if (format === 'png' && bytes.length >= 24) {
    result.width = readU32(bytes, 16);
    result.height = readU32(bytes, 20);
    for (const chunk of parsePngChunks(bytes)) {
      result.chunks.push(chunk.type);
      const labels = { tEXt: 'Text', zTXt: 'Compressed text', iTXt: 'International text', eXIf: 'EXIF', iCCP: 'ICC profile', pHYs: 'Physical resolution', tIME: 'Modified time' };
      if (labels[chunk.type]) result.metadata.push(labels[chunk.type]);
    }
  } else if (format === 'jpeg') {
    for (const segment of parseJpegSegments(bytes)) {
      if (segment.sof && segment.end - segment.start >= 9) {
        result.height = (bytes[segment.start + 5] << 8) | bytes[segment.start + 6];
        result.width = (bytes[segment.start + 7] << 8) | bytes[segment.start + 8];
      }
      if (segment.marker === 0xe1) {
        const label = ascii(bytes, segment.start + 4, Math.min(segment.end, segment.start + 80));
        result.metadata.push(label.startsWith('Exif\0\0') ? 'EXIF' : label.includes('xap') ? 'XMP' : 'APP1');
      } else if (segment.marker === 0xe2) result.metadata.push('ICC profile');
      else if (segment.marker === 0xed) result.metadata.push('IPTC / Photoshop');
      else if (segment.marker === 0xfe) result.metadata.push('Comment');
    }
  } else if (format === 'bmp' && bytes.length >= 26) {
    result.width = Math.abs(readI32LE(bytes, 18));
    result.height = Math.abs(readI32LE(bytes, 22));
  } else if (format === 'webp') {
    const dimensions = parseWebpDimensions(bytes);
    Object.assign(result, dimensions);
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = ascii(bytes, offset, offset + 4);
      const length = readU32LE(bytes, offset + 4);
      result.chunks.push(type);
      if (['EXIF', 'XMP ', 'ICCP'].includes(type)) result.metadata.push(type.trim());
      if (length > bytes.length - offset - 8) break;
      offset += 8 + length + (length & 1);
    }
  }
  result.metadata = [...new Set(result.metadata)];
  return result;
}

export function optimizeSvgMarkup(source) {
  let markup = String(source ?? '').replace(/^\uFEFF/, '');
  if (!/<svg(?:\s|>)/i.test(markup)) throw new Error('Input does not contain an SVG root element.');
  markup = markup
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!doctype[\s\S]*?>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/<(?:script|foreignObject|iframe|object|embed)\b[\s\S]*?<\/(?:script|foreignObject|iframe|object|embed)\s*>/gi, '')
    .replace(/<(?:script|foreignObject|iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|xlink:href)\s*=\s*(["'])(?!#|data:image\/(?:png|jpeg|webp);base64,)[\s\S]*?\1/gi, '')
    .replace(/\s+(?:style)\s*=\s*(["'])[^"']*url\s*\([^"']*\)[^"']*\1/gi, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!/^<svg(?:\s|>)/i.test(markup)) {
    const root = markup.match(/<svg\b[\s\S]*<\/svg\s*>/i);
    if (!root) throw new Error('SVG root is incomplete.');
    markup = root[0];
  }
  return markup;
}

export function analyzeSvgMarkup(source) {
  const markup = String(source ?? '');
  const count = (expression) => (markup.match(expression) || []).length;
  const viewBox = markup.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1] || null;
  return {
    elements: count(/<(?!\/|!|\?)[a-z][\w:-]*(?:\s|\/?>)/gi),
    paths: count(/<path(?:\s|\/?>)/gi),
    groups: count(/<g(?:\s|\/?>)/gi),
    gradients: count(/<(?:linearGradient|radialGradient)(?:\s|\/?>)/gi),
    viewBox,
    bytes: encoder.encode(markup).length
  };
}

export function transformSvgMarkup(source, { scale = 1, rotate = 0 } = {}) {
  const markup = optimizeSvgMarkup(source);
  const openEnd = markup.indexOf('>');
  const closeStart = markup.toLowerCase().lastIndexOf('</svg');
  if (openEnd < 0 || closeStart <= openEnd) throw new Error('SVG root is incomplete.');
  const safeScale = clamp(Number(scale) || 1, 0.05, 20);
  const safeRotate = clamp(Number(rotate) || 0, -360, 360);
  if (safeScale === 1 && safeRotate === 0) return markup;
  const transform = `translate(0 0) rotate(${round(safeRotate, 3)}) scale(${round(safeScale, 4)})`;
  return `${markup.slice(0, openEnd + 1)}<g transform="${transform}">${markup.slice(openEnd + 1, closeStart)}</g>${markup.slice(closeStart)}`;
}

export function parseJpegSegments(input) {
  const bytes = asBytes(input);
  if (detectImageFormat(bytes) !== 'jpeg') throw new Error('Not a JPEG byte stream.');
  const segments = [{ marker: 0xd8, start: 0, end: 2 }];
  const sizeMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    const start = offset - 1;
    if (marker === 0xd9) { segments.push({ marker, start, end: offset + 1 }); break; }
    if (marker === 0xda) {
      if (offset + 2 >= bytes.length) break;
      const headerLength = (bytes[offset + 1] << 8) | bytes[offset + 2];
      segments.push({ marker, start, end: bytes.length, headerEnd: offset + 1 + headerLength, scan: true });
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) {
      segments.push({ marker, start, end: offset + 1 });
      offset += 1;
      continue;
    }
    if (offset + 2 >= bytes.length) break;
    const length = (bytes[offset + 1] << 8) | bytes[offset + 2];
    if (length < 2 || start + length + 2 > bytes.length) break;
    const end = start + length + 2;
    segments.push({ marker, start, end, sof: sizeMarkers.has(marker) });
    offset = end;
  }
  return segments;
}

export function stripJpegMetadata(input) {
  const bytes = asBytes(input);
  const removable = new Set([0xe1, 0xe2, 0xed, 0xfe]);
  const pieces = [];
  for (const segment of parseJpegSegments(bytes)) {
    if (!removable.has(segment.marker)) pieces.push(bytes.subarray(segment.start, segment.end));
  }
  return concatBytes(pieces);
}

function makeJpegSegment(marker, payloadInput) {
  const payload = asBytes(payloadInput);
  if (payload.length > 65_533) throw new RangeError('JPEG metadata segments are limited to 65,533 bytes.');
  const segment = new Uint8Array(payload.length + 4);
  segment.set([0xff, marker, ((payload.length + 2) >>> 8) & 0xff, (payload.length + 2) & 0xff]);
  segment.set(payload, 4);
  return segment;
}

function replaceJpegMetadataSegment(input, predicate, segment) {
  const bytes = asBytes(input); const pieces = [bytes.subarray(0, 2), segment];
  for (const candidate of parseJpegSegments(bytes).slice(1)) if (!predicate(candidate, bytes.subarray(candidate.start + 4, candidate.end))) pieces.push(bytes.subarray(candidate.start, candidate.end));
  return concatBytes(pieces);
}

export function insertJpegComment(input, comment) {
  const payload = encoder.encode(String(comment ?? ''));
  if (!payload.length) return replaceJpegMetadataSegment(input, (segment) => segment.marker === 0xfe, new Uint8Array());
  return replaceJpegMetadataSegment(input, (segment) => segment.marker === 0xfe, makeJpegSegment(0xfe, payload));
}

function exifDescriptionPayload(description) {
  const value = concatBytes([encoder.encode(description), Uint8Array.of(0)]); const inline = value.length <= 4;
  const tiff = new Uint8Array(inline ? 26 : 26 + value.length); const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49], 0); view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, 1, true);
  view.setUint16(10, 0x010e, true); view.setUint16(12, 2, true); view.setUint32(14, value.length, true);
  if (inline) tiff.set(value, 18); else { view.setUint32(18, 26, true); tiff.set(value, 26); }
  view.setUint32(22, 0, true);
  return concatBytes([encoder.encode('Exif\0\0'), tiff]);
}

function xmpDescriptionPayload(description) {
  const escaped = description.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const packet = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escaped}</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`;
  return concatBytes([encoder.encode('http://ns.adobe.com/xap/1.0/\0'), encoder.encode(packet)]);
}

function iptcDescriptionPayload(description) {
  const value = encoder.encode(description);
  if (value.length > 0xffff) throw new RangeError('IPTC Caption-Abstract is limited to 65,535 UTF-8 bytes.');
  const charset = Uint8Array.of(0x1c, 0x01, 0x5a, 0x00, 0x03, 0x1b, 0x25, 0x47);
  const caption = new Uint8Array(5 + value.length); caption.set([0x1c, 0x02, 0x78, value.length >>> 8, value.length & 0xff]); caption.set(value, 5);
  const data = concatBytes([charset, caption]); const block = new Uint8Array(12 + data.length + (data.length & 1)); const view = new DataView(block.buffer);
  block.set(encoder.encode('8BIM'), 0); view.setUint16(4, 0x0404); block.set([0, 0], 6); view.setUint32(8, data.length); block.set(data, 12);
  return concatBytes([encoder.encode('Photoshop 3.0\0'), block]);
}

export function rewriteJpegDescription(input, namespace, description) {
  const clean = String(description ?? '').replaceAll('\0', '').trim();
  if (!clean) throw new Error('Enter a non-empty metadata description.');
  if (clean.length > 2_000) throw new RangeError('Metadata descriptions are limited to 2,000 characters.');
  const bytes = asBytes(input);
  if (detectImageFormat(bytes) !== 'jpeg') throw new Error('Structured EXIF, IPTC, and XMP description editing requires a JPEG file.');
  if (namespace === 'exif') return replaceJpegMetadataSegment(bytes, (segment, payload) => segment.marker === 0xe1 && ascii(payload, 0, 6) === 'Exif\0\0', makeJpegSegment(0xe1, exifDescriptionPayload(clean)));
  if (namespace === 'xmp') return replaceJpegMetadataSegment(bytes, (segment, payload) => segment.marker === 0xe1 && ascii(payload, 0, 29).startsWith('http://ns.adobe.com/xap/1.0/'), makeJpegSegment(0xe1, xmpDescriptionPayload(clean)));
  if (namespace === 'iptc') return replaceJpegMetadataSegment(bytes, (segment) => segment.marker === 0xed, makeJpegSegment(0xed, iptcDescriptionPayload(clean)));
  if (namespace === 'comment') return insertJpegComment(bytes, clean);
  throw new Error(`Unsupported JPEG metadata namespace: ${namespace}`);
}

export function processPngMetadata(input, { description = '' } = {}) {
  const bytes = asBytes(input);
  if (detectImageFormat(bytes) !== 'png') throw new Error('Not a PNG byte stream.');
  const removable = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'iCCP', 'pHYs', 'tIME']);
  const parts = [bytes.subarray(0, 8)];
  for (const chunk of parsePngChunks(bytes)) {
    if (chunk.type === 'IEND' && description) {
      const value = concatBytes([bytesOf('Description'), Uint8Array.of(0, 0, 0, 0, 0), encoder.encode(String(description).replaceAll('\0', ''))]);
      parts.push(makePngChunk('iTXt', value));
    }
    if (!removable.has(chunk.type)) parts.push(bytes.subarray(chunk.start, chunk.end));
  }
  return concatBytes(parts);
}

export function extractEmbeddedJpeg(input, maxCandidates = 64) {
  const bytes = asBytes(input);
  let best = null; let start = -1; let candidates = 0;
  for (let index = 0; index + 2 < bytes.length && candidates < maxCandidates; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xd8 && bytes[index + 2] === 0xff) { start = index; candidates += 1; index += 1; continue; }
    if (start >= 0 && bytes[index] === 0xff && bytes[index + 1] === 0xd9) {
      const candidate = bytes.subarray(start, index + 2);
      if ((!best || candidate.length > best.length) && candidate.length >= 256) best = candidate;
      start = -1; index += 1;
    }
  }
  return best ? new Uint8Array(best) : null;
}

export function otsuThreshold(histogram) {
  if (!histogram || histogram.length !== 256) throw new TypeError('Otsu needs a 256-bin histogram.');
  let total = 0; let weightedTotal = 0;
  for (let index = 0; index < 256; index += 1) { const count = Number(histogram[index]) || 0; total += count; weightedTotal += index * count; }
  if (!total) return 127;
  let backgroundWeight = 0; let backgroundSum = 0; let bestVariance = -1; let threshold = 127;
  for (let index = 0; index < 256; index += 1) {
    const count = Number(histogram[index]) || 0;
    backgroundWeight += count; if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight; if (!foregroundWeight) break;
    backgroundSum += index * count;
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (weightedTotal - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) { bestVariance = variance; threshold = index; }
  }
  return threshold;
}

export function thresholdRgba(input, threshold = null) {
  const source = asBytes(input);
  if (source.length % 4) throw new RangeError('RGBA data length must be divisible by four.');
  const histogram = new Uint32Array(256);
  for (let index = 0; index < source.length; index += 4) histogram[luma(source[index], source[index + 1], source[index + 2])] += 1;
  const cutoff = threshold == null ? otsuThreshold(histogram) : clamp(Math.round(Number(threshold)), 0, 255);
  const output = new Uint8ClampedArray(source.length);
  for (let index = 0; index < source.length; index += 4) {
    const value = luma(source[index], source[index + 1], source[index + 2]) >= cutoff ? 255 : 0;
    output[index] = value; output[index + 1] = value; output[index + 2] = value; output[index + 3] = source[index + 3];
  }
  return { data: output, threshold: cutoff };
}

export function warpQuadrilateralRgba(input, sourceWidth, sourceHeight, corners, outputWidth, outputHeight) {
  const source = asBytes(input);
  if (source.length !== sourceWidth * sourceHeight * 4) throw new RangeError('Source dimensions do not match RGBA data.');
  if (!Array.isArray(corners) || corners.length !== 4) throw new TypeError('Corners must be [top-left, top-right, bottom-right, bottom-left].');
  const width = Math.max(1, Math.round(outputWidth)); const height = Math.max(1, Math.round(outputHeight));
  const output = new Uint8ClampedArray(width * height * 4);
  const [tl, tr, br, bl] = corners;
  for (let y = 0; y < height; y += 1) {
    const v = height === 1 ? 0 : y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = width === 1 ? 0 : x / (width - 1);
      const sx = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x;
      const sy = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y;
      sampleBilinear(source, sourceWidth, sourceHeight, sx, sy, output, (y * width + x) * 4);
    }
  }
  return output;
}

export function findHorizontalOverlap(leftInput, leftWidth, rightInput, rightWidth, height, options = {}) {
  const left = asBytes(leftInput); const right = asBytes(rightInput);
  if (left.length !== leftWidth * height * 4 || right.length !== rightWidth * height * 4) throw new RangeError('Image dimensions do not match RGBA data.');
  const minWidth = Math.min(leftWidth, rightWidth);
  const minimum = Math.max(1, Math.floor(minWidth * (options.minFraction ?? 0.08)));
  const maximum = Math.max(minimum, Math.floor(minWidth * (options.maxFraction ?? 0.65)));
  const sampleStep = Math.max(1, Math.round(options.sampleStep ?? Math.max(1, height / 80)));
  let best = { overlap: minimum, score: Infinity };
  for (let overlap = minimum; overlap <= maximum; overlap += Math.max(1, Math.floor((maximum - minimum) / 100))) {
    let error = 0; let count = 0;
    const xStep = Math.max(1, Math.round(overlap / 80));
    for (let y = 0; y < height; y += sampleStep) {
      for (let x = 0; x < overlap; x += xStep) {
        const li = (y * leftWidth + leftWidth - overlap + x) * 4;
        const ri = (y * rightWidth + x) * 4;
        error += Math.abs(luma(left[li], left[li + 1], left[li + 2]) - luma(right[ri], right[ri + 1], right[ri + 2]));
        count += 1;
      }
    }
    const score = count ? error / count : Infinity;
    if (score < best.score) best = { overlap, score };
  }
  return best;
}

export function blendHorizontalImages(leftInput, leftWidth, rightInput, rightWidth, height, overlap) {
  const left = asBytes(leftInput); const right = asBytes(rightInput);
  const safeOverlap = clamp(Math.round(overlap), 0, Math.min(leftWidth, rightWidth));
  const width = leftWidth + rightWidth - safeOverlap;
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    output.set(left.subarray(y * leftWidth * 4, (y + 1) * leftWidth * 4), y * width * 4);
    for (let x = 0; x < rightWidth; x += 1) {
      const destinationX = leftWidth - safeOverlap + x;
      const di = (y * width + destinationX) * 4; const ri = (y * rightWidth + x) * 4;
      if (x < safeOverlap && safeOverlap > 0) {
        const alpha = (x + 1) / (safeOverlap + 1);
        for (let channel = 0; channel < 4; channel += 1) output[di + channel] = Math.round(output[di + channel] * (1 - alpha) + right[ri + channel] * alpha);
      } else output.set(right.subarray(ri, ri + 4), di);
    }
  }
  return { data: output, width, height };
}

export function mergeExposureStack(frames, exposureValues = null) {
  if (!Array.isArray(frames) || frames.length < 2) throw new RangeError('HDR merging needs at least two frames.');
  const normalized = frames.map(asBytes); const length = normalized[0].length;
  if (length % 4 || normalized.some((frame) => frame.length !== length)) throw new RangeError('HDR frames must be equal-size RGBA arrays.');
  const evs = exposureValues || frames.map((_, index) => index - (frames.length - 1) / 2);
  if (evs.length !== frames.length) throw new RangeError('Exposure values must match the frame count.');
  const output = new Uint8ClampedArray(length);
  for (let pixel = 0; pixel < length; pixel += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      let radiance = 0; let weights = 0;
      for (let frame = 0; frame < normalized.length; frame += 1) {
        const value = normalized[frame][pixel + channel] / 255;
        const weight = Math.max(0.02, 1 - Math.abs(value - 0.5) * 2);
        radiance += (value / (2 ** Number(evs[frame]))) * weight;
        weights += weight;
      }
      const linear = radiance / weights;
      const mapped = linear / (1 + linear);
      output[pixel + channel] = Math.round(255 * (mapped ** (1 / 2.2)));
    }
    output[pixel + 3] = 255;
  }
  return output;
}

export function encodeBmpRgba(input, width, height, options = {}) {
  const rgba = asBytes(input);
  const w = Number(width); const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) throw new RangeError('BMP dimensions must be positive integers.');
  if (w * h > IMAGE_PIXEL_LIMIT || rgba.length !== w * h * 4) throw new RangeError('RGBA data does not match the bounded BMP dimensions.');
  const background = Array.isArray(options.background) ? options.background : [255, 255, 255];
  if (background.length !== 3 || background.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) throw new RangeError('BMP background must contain three byte values.');
  const rowStride = (w * 3 + 3) & ~3; const pixelBytes = rowStride * h; const fileBytes = 54 + pixelBytes;
  if (!Number.isSafeInteger(fileBytes) || fileBytes > 256 * 1024 * 1024) throw new RangeError('BMP output exceeds the 256 MiB limit.');
  const output = new Uint8Array(fileBytes); const view = new DataView(output.buffer);
  output[0] = 0x42; output[1] = 0x4d; view.setUint32(2, fileBytes, true); view.setUint32(10, 54, true);
  view.setUint32(14, 40, true); view.setInt32(18, w, true); view.setInt32(22, h, true); view.setUint16(26, 1, true); view.setUint16(28, 24, true); view.setUint32(34, pixelBytes, true); view.setInt32(38, 2835, true); view.setInt32(42, 2835, true);
  for (let y = 0; y < h; y += 1) {
    const sourceRow = y * w * 4; const targetRow = 54 + (h - 1 - y) * rowStride;
    for (let x = 0; x < w; x += 1) {
      const source = sourceRow + x * 4; const target = targetRow + x * 3; const alpha = rgba[source + 3] / 255; const inverse = 1 - alpha;
      output[target] = Math.round(rgba[source + 2] * alpha + background[2] * inverse);
      output[target + 1] = Math.round(rgba[source + 1] * alpha + background[1] * inverse);
      output[target + 2] = Math.round(rgba[source] * alpha + background[0] * inverse);
    }
  }
  return output;
}

export function imageQualityMetrics(referenceInput, candidateInput) {
  const reference = asBytes(referenceInput); const candidate = asBytes(candidateInput);
  if (reference.length !== candidate.length || reference.length % 4) throw new RangeError('Image quality inputs must be equally sized RGBA buffers.');
  if (!reference.length) throw new RangeError('Image quality inputs cannot be empty.');
  let squared = 0; let absolute = 0; let maximumError = 0;
  for (let index = 0; index < reference.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Number(reference[index + channel]) - Number(candidate[index + channel]);
      squared += difference * difference; absolute += Math.abs(difference); maximumError = Math.max(maximumError, Math.abs(difference));
    }
  }
  const samples = reference.length / 4 * 3; const mse = squared / samples; const rmse = Math.sqrt(mse);
  return { mse, rmse, mae: absolute / samples, psnr: rmse === 0 ? Infinity : 20 * Math.log10(255 / rmse), maximumError };
}

export function parseSrt(source) {
  const normalized = String(source ?? '').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (!normalized) return [];
  const cues = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]?.trim())) lines.shift();
    const match = lines.shift()?.match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!match || !lines.length) continue;
    const stamp = (offset) => Number(match[offset]) * 3600 + Number(match[offset + 1]) * 60 + Number(match[offset + 2]) + Number(match[offset + 3]) / 1000;
    cues.push({ start: stamp(1), end: stamp(5), text: lines.join('\n') });
  }
  return cues;
}

export function srtToVtt(source) {
  const cues = parseSrt(source);
  const stamp = (seconds) => {
    const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60); const value = seconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${value.toFixed(3).padStart(6, '0')}`;
  };
  return `WEBVTT\n\n${cues.map((cue) => `${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}

export function estimateVideoOutputSize(durationSeconds, videoBitsPerSecond, audioBitsPerSecond = 128_000) {
  for (const value of [durationSeconds, videoBitsPerSecond, audioBitsPerSecond]) if (!Number.isFinite(value) || value < 0) throw new RangeError('Duration and bitrates must be non-negative finite numbers.');
  return Math.ceil(durationSeconds * (videoBitsPerSecond + audioBitsPerSecond) / 8);
}

export function selectSupportedRecorderMime(isSupported) {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((mime) => isSupported(mime)) || '';
}

export function detectMediaContainer(input) {
  const bytes = asBytes(input);
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') return 'ISO BMFF / MP4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'Matroska / WebM';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'AVI ') return 'AVI';
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS') return 'Ogg';
  return 'Unknown';
}

export function rawRgbToRgba(input, width, height, colors = 3, bits = 8) {
  const pixelCount = Math.trunc(Number(width)) * Math.trunc(Number(height));
  if (!Number.isSafeInteger(pixelCount) || width <= 0 || height <= 0 || pixelCount > IMAGE_PIXEL_LIMIT) throw new RangeError('RAW dimensions exceed the bounded pixel budget.');
  if (!Number.isInteger(colors) || colors < 3 || colors > 4) throw new RangeError('RAW output must contain three or four color channels.');
  if (![8, 16].includes(bits)) throw new RangeError('RAW output must use 8-bit or 16-bit samples.');
  const source = bits === 16
    ? input instanceof Uint16Array ? input : input instanceof ArrayBuffer ? new Uint16Array(input) : ArrayBuffer.isView(input) ? new Uint16Array(input.buffer, input.byteOffset, Math.floor(input.byteLength / 2)) : null
    : input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!source || source.length < pixelCount * colors) throw new RangeError('RAW pixel data is shorter than its declared dimensions.');
  const output = new Uint8ClampedArray(pixelCount * 4); const divisor = bits === 16 ? 257 : 1;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const sourceOffset = pixel * colors; const targetOffset = pixel * 4;
    output[targetOffset] = Math.round(source[sourceOffset] / divisor); output[targetOffset + 1] = Math.round(source[sourceOffset + 1] / divisor); output[targetOffset + 2] = Math.round(source[sourceOffset + 2] / divisor); output[targetOffset + 3] = 255;
  }
  return output;
}

export function computeTileRegions(width, height, bounds, tileSize = 256) {
  const canvasWidth = Math.trunc(Number(width)); const canvasHeight = Math.trunc(Number(height)); const size = Math.trunc(Number(tileSize));
  if (canvasWidth <= 0 || canvasHeight <= 0 || size <= 0) throw new RangeError('Tile dimensions must be positive integers.');
  const x0 = clamp(Math.floor(Number(bounds?.x0) || 0), 0, canvasWidth); const y0 = clamp(Math.floor(Number(bounds?.y0) || 0), 0, canvasHeight); const x1 = clamp(Math.ceil(Number(bounds?.x1) || 0), 0, canvasWidth); const y1 = clamp(Math.ceil(Number(bounds?.y1) || 0), 0, canvasHeight);
  if (x1 <= x0 || y1 <= y0) return [];
  const regions = [];
  for (let y = Math.floor(y0 / size) * size; y < y1; y += size) for (let x = Math.floor(x0 / size) * size; x < x1; x += size) regions.push({ x, y, width: Math.min(size, canvasWidth - x), height: Math.min(size, canvasHeight - y), key: `${x}:${y}` });
  return regions;
}

export function normalizeMetadataForJson(value, options = {}) {
  const maximumDepth = options.maximumDepth ?? 7; const maximumArray = options.maximumArray ?? 100; const maximumKeys = options.maximumKeys ?? 300; const maximumString = options.maximumString ?? 4_000; const seen = new WeakSet();
  const visit = (item, depth) => {
    if (typeof item === 'bigint') return `${item}n`;
    if (typeof item === 'string') return item.length > maximumString ? `${item.slice(0, maximumString)}… [${item.length - maximumString} more characters]` : item;
    if (item == null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (item instanceof Date) return Number.isNaN(item.getTime()) ? 'Invalid date' : item.toISOString();
    if (ArrayBuffer.isView(item)) return { type: item.constructor.name, byteLength: item.byteLength, preview: Array.from(new Uint8Array(item.buffer, item.byteOffset, Math.min(item.byteLength, 32))) };
    if (item instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: item.byteLength, preview: Array.from(new Uint8Array(item, 0, Math.min(item.byteLength, 32))) };
    if (typeof item !== 'object') return String(item);
    if (seen.has(item)) return '[Circular]';
    if (depth >= maximumDepth) return '[Maximum depth reached]';
    seen.add(item);
    if (Array.isArray(item)) { const output = item.slice(0, maximumArray).map((entry) => visit(entry, depth + 1)); if (item.length > maximumArray) output.push(`[${item.length - maximumArray} more items]`); return output; }
    const entries = item instanceof Map ? [...item.entries()] : Object.entries(item); const output = {};
    for (const [key, entry] of entries.slice(0, maximumKeys)) output[String(key)] = visit(entry, depth + 1);
    if (entries.length > maximumKeys) output['…'] = `${entries.length - maximumKeys} more keys`;
    return output;
  };
  return visit(value, 0);
}

export function countMetadataLeaves(value) {
  if (value == null) return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countMetadataLeaves(item), 0);
  if (typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof Date)) return Object.values(value).reduce((sum, item) => sum + countMetadataLeaves(item), 0);
  return 1;
}

export function flattenTesseractBlocks(blocks) {
  const words = [];
  for (const block of Array.isArray(blocks) ? blocks : []) for (const paragraph of block?.paragraphs || []) for (const line of paragraph?.lines || []) for (const word of line?.words || []) {
    const box = word?.bbox; const value = String(word?.text || '').trim();
    if (!value || !box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) continue;
    words.push({ text: value, confidence: Number(word.confidence) || 0, boundingBox: { x: box.x0, y: box.y0, width: Math.max(0, box.x1 - box.x0), height: Math.max(0, box.y1 - box.y0) } });
  }
  return words;
}

export function buildFfmpegTranscodePlan({ inputName = 'input.bin', format = 'webm', maxEdge = 1920, fps = 30, videoBitsPerSecond = 2_500_000, audioStreamIndex = 0 } = {}) {
  if (!['webm', 'mp4'].includes(format)) throw new RangeError('FFmpeg output format must be webm or mp4.');
  if (!Number.isInteger(Number(audioStreamIndex)) || Number(audioStreamIndex) < 0 || Number(audioStreamIndex) > 31) throw new RangeError('Audio stream index must be an integer from 0 through 31.');
  const audioIndex = Number(audioStreamIndex); const edge = clamp(Math.round(Number(maxEdge)), 160, 2560); const frameRate = clamp(Math.round(Number(fps)), 10, 60); const bitrate = clamp(Math.round(Number(videoBitsPerSecond)), 200_000, 12_000_000); const outputName = `output.${format}`;
  const scale = `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${frameRate}`;
  const common = ['-i', inputName, '-map', '0:v:0', '-map', `0:a:${audioIndex}?`, '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-t', '600', '-vf', scale, '-threads', '1', '-max_muxing_queue_size', '1024'];
  const codec = format === 'webm'
    ? ['-c:v', 'libvpx-vp9', '-b:v', String(bitrate), '-deadline', 'good', '-cpu-used', '5', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k']
    : ['-c:v', 'libx264', '-b:v', String(bitrate), '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
  return { args: [...common, ...codec, outputName], outputName, extension: format, mime: format === 'webm' ? 'video/webm' : 'video/mp4', maxEdge: edge, fps: frameRate, videoBitsPerSecond: bitrate, audioStreamIndex: audioIndex };
}

export function deriveProbeDuration(probe) {
  const values = [Number(probe?.format?.duration)];
  for (const stream of Array.isArray(probe?.streams) ? probe.streams : []) {
    values.push(Number(stream?.duration));
    const ticks = Number(stream?.duration_ts); const match = String(stream?.time_base || '').match(/^(\d+)\/(\d+)$/);
    if (Number.isFinite(ticks) && match && Number(match[2])) values.push(ticks * Number(match[1]) / Number(match[2]));
  }
  const finite = values.filter((value) => Number.isFinite(value) && value > 0);
  return finite.length ? Math.max(...finite) : null;
}

export function buildSearchablePdf(jpegInput, width, height, blocks = []) {
  const jpeg = asBytes(jpegInput);
  if (detectImageFormat(jpeg) !== 'jpeg') throw new Error('Searchable PDF image must be JPEG.');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new RangeError('PDF dimensions must be positive.');
  const safeText = blocks.map((block) => {
    const text = String(block.text ?? block.rawValue ?? '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
    const box = block.boundingBox || block.box || {};
    const x = clamp(Number(box.x) || 0, 0, width); const y = clamp(Number(box.y) || 0, 0, height);
    const size = clamp(Number(box.height) || 10, 4, 72);
    return `BT /F1 ${round(size, 2)} Tf 3 Tr 1 0 0 1 ${round(x, 2)} ${round(height - y - size, 2)} Tm (${text}) Tj ET`;
  }).join('\n');
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n${safeText}\n`;
  const objects = [
    bytesOf('<< /Type /Catalog /Pages 2 0 R >>'),
    bytesOf('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bytesOf(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>`),
    concatBytes([bytesOf(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, bytesOf('\nendstream')]),
    bytesOf(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`),
    bytesOf('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  ];
  const header = bytesOf('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const pieces = [header]; const offsets = [0]; let position = header.length;
  objects.forEach((object, index) => { offsets.push(position); const wrapped = concatBytes([bytesOf(`${index + 1} 0 obj\n`), object, bytesOf('\nendobj\n')]); pieces.push(wrapped); position += wrapped.length; });
  const xrefAt = position;
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  pieces.push(bytesOf(xref));
  return concatBytes(pieces);
}

function asBytes(input) {
  if (input instanceof Uint8Array || input instanceof Uint8ClampedArray) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Expected bytes.');
}

function ascii(bytes, start, end) { return latin1.decode(bytes.subarray(start, end)); }
function readU32(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0); }
function readU32LE(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true); }
function readI32LE(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, true); }
function bytesOf(value) { return encoder.encode(value); }
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
function round(value, places) { const factor = 10 ** places; return Math.round(value * factor) / factor; }
function luma(red, green, blue) { return clamp(Math.round(red * 0.299 + green * 0.587 + blue * 0.114), 0, 255); }
function concatBytes(parts) { const size = parts.reduce((sum, part) => sum + part.length, 0); const output = new Uint8Array(size); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output; }

function parsePngChunks(bytes) {
  if (detectImageFormat(bytes) !== 'png') throw new Error('Not a PNG byte stream.');
  const chunks = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = readU32(bytes, offset); const type = ascii(bytes, offset + 4, offset + 8); const end = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end > bytes.length) throw new Error('PNG contains a truncated or invalid chunk.');
    chunks.push({ type, start: offset, dataStart: offset + 8, dataEnd: offset + 8 + length, end });
    offset = end; if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR' || chunks.at(-1)?.type !== 'IEND') throw new Error('PNG is missing a complete IHDR/IEND structure.');
  return chunks;
}

function makePngChunk(type, payload) {
  const name = bytesOf(type); const body = asBytes(payload); const output = new Uint8Array(body.length + 12); const view = new DataView(output.buffer);
  view.setUint32(0, body.length); output.set(name, 4); output.set(body, 8); view.setUint32(body.length + 8, crc32(concatBytes([name, body]))); return output;
}

function crc32(input) {
  const bytes = asBytes(input); let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseWebpDimensions(bytes) {
  if (ascii(bytes, 12, 16) === 'VP8X' && bytes.length >= 30) return { width: readU24LE(bytes, 24) + 1, height: readU24LE(bytes, 27) + 1 };
  if (ascii(bytes, 12, 16) === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return { width: ((bytes[27] << 8) | bytes[26]) & 0x3fff, height: ((bytes[29] << 8) | bytes[28]) & 0x3fff };
  if (ascii(bytes, 12, 16) === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) { const bits = readU32LE(bytes, 21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
  return { width: null, height: null };
}
function readU24LE(bytes, offset) { return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16; }

function sampleBilinear(source, width, height, x, y, output, destination) {
  const safeX = clamp(x, 0, width - 1); const safeY = clamp(y, 0, height - 1);
  const x0 = Math.floor(safeX); const y0 = Math.floor(safeY); const x1 = Math.min(width - 1, x0 + 1); const y1 = Math.min(height - 1, y0 + 1);
  const fx = safeX - x0; const fy = safeY - y0;
  for (let channel = 0; channel < 4; channel += 1) {
    const top = source[(y0 * width + x0) * 4 + channel] * (1 - fx) + source[(y0 * width + x1) * 4 + channel] * fx;
    const bottom = source[(y1 * width + x0) * 4 + channel] * (1 - fx) + source[(y1 * width + x1) * 4 + channel] * fx;
    output[destination + channel] = Math.round(top * (1 - fy) + bottom * fy);
  }
}

function shell(root, t, config) {
  root.innerHTML = `<div class="workbench-layout">
    <form class="workbench-controls" data-form>
      <div class="workbench-section-heading"><h2>${t(config.controls.en, config.controls.pt)}</h2><span>${t(config.badge.en, config.badge.pt)}</span></div>
      ${config.fields}
      <div class="button-row">${config.buttons}</div>
      <progress class="workbench-progress" max="1" value="0" hidden aria-label="${t('Processing progress', 'Progresso do processamento')}" data-progress></progress>
      <p class="workbench-status" role="status" aria-live="polite" data-status></p>
    </form>
    <section class="workbench-results" aria-labelledby="${config.id}-results-title">
      <div class="workbench-section-heading"><h2 id="${config.id}-results-title" tabindex="-1">${t(config.results.en, config.results.pt)}</h2><button class="text-button" type="button" disabled data-release>${t('Release output', 'Liberar saída')}</button></div>
      <div class="metric-grid" data-metrics></div>
      <div hidden data-output>${config.output || ''}</div>
      <div class="empty-result" data-empty><p>${t(config.empty.en, config.empty.pt)}</p></div>
    </section>
  </div>`;
}

function renderMetrics(root, values) {
  root.querySelector('[data-metrics]').replaceChildren(...values.map(([label, value]) => {
    const item = document.createElement('div'); const span = document.createElement('span'); const strong = document.createElement('strong');
    span.textContent = label; strong.textContent = String(value); item.append(span, strong); return item;
  }));
}

function showOutput(root) {
  root.querySelector('[data-output]').hidden = false; root.querySelector('[data-empty]').hidden = true; root.querySelector('[data-release]').disabled = false;
}

function clearGenericOutput(root) {
  root.querySelector('[data-output]').hidden = true; root.querySelector('[data-empty]').hidden = false; root.querySelector('[data-release]').disabled = true; root.querySelector('[data-metrics]').replaceChildren();
}

function field(id, label, input) { return `<label class="field-label" for="${id}">${label}</label>${input.replace('%%ID%%', id)}`; }
function safeStem(name, fallback) { return sanitizeFilename(String(name || '').replace(/\.[^.]+$/, ''), fallback); }

async function readLimited(file, limit, message) {
  if (!file) throw new Error(message || 'Select a file.');
  if (file.size > limit) throw new Error(message || `File exceeds ${formatBytes(limit)}.`);
  return new Uint8Array(await file.arrayBuffer());
}

async function decodeBitmap(source, t) {
  if (typeof createImageBitmap !== 'function') throw new Error(t('This browser does not expose createImageBitmap, so local image decoding is unavailable.', 'Este navegador não expõe createImageBitmap; a decodificação local de imagens não está disponível.'));
  let bitmap;
  try { bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' }); }
  catch (_) { throw new Error(t('The browser has no decoder for this image/codec. TIFF and RAW sensor mosaics usually need a native/WASM decoder that is not bundled.', 'O navegador não possui decodificador para esta imagem/codec. TIFF e mosaicos RAW normalmente precisam de um decodificador nativo/WASM que não está incluído.')); }
  const pixels = bitmap.width * bitmap.height;
  if (!bitmap.width || !bitmap.height || pixels > IMAGE_PIXEL_LIMIT || pixels * 8 > IMAGE_DECODE_BUDGET) { bitmap.close(); throw new Error(t('Decoded image exceeds the 80-megapixel or 512 MiB working-memory safety limit.', 'A imagem decodificada excede o limite de segurança de 80 megapixels ou 512 MiB de memória de trabalho.')); }
  return bitmap;
}

async function decodeTiffWithUtif(bytes, t) {
  if (typeof createImageBitmap !== 'function') throw new Error(t('TIFF pixels can be decoded, but this browser lacks createImageBitmap for the bounded conversion pipeline.', 'Os pixels TIFF podem ser decodificados, mas este navegador não possui createImageBitmap para o fluxo de conversão limitado.'));
  let module;
  try { module = await import('/vendor/suite/utif.js'); }
  catch (_) { throw new Error(t('The browser cannot decode TIFF and the optional local UTIF runtime could not be loaded.', 'O navegador não decodifica TIFF e o runtime local opcional UTIF não pôde ser carregado.')); }
  const UTIF = module.default || module.UTIF || module;
  if (typeof UTIF.decode !== 'function' || typeof UTIF.decodeImage !== 'function' || typeof UTIF.toRGBA8 !== 'function') throw new Error(t('The loaded UTIF bundle has an unexpected API.', 'O pacote UTIF carregado possui uma API inesperada.'));
  let pages;
  try { pages = UTIF.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
  catch (_) { throw new Error(t('UTIF could not parse this TIFF structure or compression.', 'O UTIF não conseguiu interpretar esta estrutura ou compressão TIFF.')); }
  if (!pages?.length) throw new Error(t('TIFF contains no decodable image directories.', 'O TIFF não contém diretórios de imagem decodificáveis.'));
  const page = pages[0];
  try { UTIF.decodeImage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), page, pages); }
  catch (_) { throw new Error(t('UTIF recognized the TIFF but does not support this page compression or pixel layout.', 'O UTIF reconheceu o TIFF, mas não suporta a compressão ou o layout de pixels desta página.')); }
  const width = Number(page.width); const height = Number(page.height); const pixels = width * height;
  if (!Number.isFinite(pixels) || width <= 0 || height <= 0 || pixels > IMAGE_PIXEL_LIMIT || pixels * 8 > IMAGE_DECODE_BUDGET) throw new Error(t('Decoded TIFF exceeds the 80-megapixel or 512 MiB safety limit.', 'O TIFF decodificado excede o limite de segurança de 80 megapixels ou 512 MiB.'));
  const rgba = UTIF.toRGBA8(page); if (!rgba || rgba.length !== pixels * 4) throw new Error(t('UTIF returned incomplete RGBA pixels.', 'O UTIF retornou pixels RGBA incompletos.'));
  const canvas = makeCanvas(width, height); canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
  const bitmap = await createImageBitmap(canvas); return { bitmap, pages: pages.length, decoder: 'UTIF WASM/JS' };
}

async function decodeAvifWithWasm(bytes, t) {
  if (typeof createImageBitmap !== 'function') throw new Error(t('AVIF pixels can be decoded, but this browser lacks createImageBitmap for the bounded conversion pipeline.', 'Os pixels AVIF podem ser decodificados, mas este navegador não possui createImageBitmap para o fluxo de conversão limitado.'));
  let decode;
  try { ({ default: decode } = await import('/vendor/avif/decode.js')); }
  catch (_) { throw new Error(t('The site-hosted AVIF decoder could not be loaded.', 'O decodificador AVIF hospedado no site não pôde ser carregado.')); }
  let image;
  try { image = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
  catch (_) { throw new Error(t('The AVIF WASM runtime could not decode this image.', 'O runtime AVIF WASM não conseguiu decodificar esta imagem.')); }
  const width = Number(image?.width); const height = Number(image?.height); const pixels = width * height;
  if (!image?.data || !Number.isFinite(pixels) || width <= 0 || height <= 0 || pixels > IMAGE_PIXEL_LIMIT || pixels * 8 > IMAGE_DECODE_BUDGET) throw new Error(t('Decoded AVIF exceeds the 80-megapixel or 512 MiB safety limit.', 'O AVIF decodificado excede o limite de segurança de 80 megapixels ou 512 MiB.'));
  const rgba = image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  if (rgba.length !== pixels * 4) throw new Error(t('The AVIF decoder returned incomplete RGBA pixels.', 'O decodificador AVIF retornou pixels RGBA incompletos.'));
  const canvas = makeCanvas(width, height); canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return { bitmap: await createImageBitmap(canvas), pages: 1, decoder: 'libavif WASM' };
}

async function decodeImageWithOptionalTiff(file, bytes, t) {
  const format = detectImageFormat(bytes);
  if (format === 'tiff') return decodeTiffWithUtif(bytes, t);
  if (format === 'avif') return decodeAvifWithWasm(bytes, t);
  return { bitmap: await decodeBitmap(file, t), pages: 1, decoder: t('browser-native decoder', 'decodificador nativo do navegador') };
}

async function developRawWithLibRaw(bytes, settings, { signal, t }) {
  let module;
  try { module = await import('/vendor/libraw/index.js'); }
  catch (_) { throw new Error(t('The local LibRaw module could not be loaded. Rebuild the vendored runtime.', 'O módulo local LibRaw não pôde ser carregado. Reconstrua o runtime incluído.')); }
  const LibRaw = module.default;
  if (typeof LibRaw !== 'function') throw new Error(t('The loaded LibRaw bundle has an unexpected API.', 'O pacote LibRaw carregado possui uma API inesperada.'));
  const decoder = new LibRaw(); const abort = () => decoder.dispose(); signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await decoder.open(bytes, settings);
    const metadata = await decoder.metadata(false) || {};
    const divisor = settings.halfSize ? 2 : 1; const estimatedWidth = Math.ceil(Number(metadata.width) / divisor); const estimatedHeight = Math.ceil(Number(metadata.height) / divisor); const estimatedPixels = estimatedWidth * estimatedHeight;
    if (!Number.isFinite(estimatedPixels) || estimatedWidth <= 0 || estimatedHeight <= 0 || estimatedPixels > RAW_PIXEL_LIMIT || estimatedPixels * 8 > IMAGE_DECODE_BUDGET) throw new Error(t('The requested RAW development exceeds the 40-megapixel / 512 MiB safety budget. Choose half resolution.', 'A revelação RAW solicitada excede o limite de segurança de 40 megapixels / 512 MiB. Escolha meia resolução.'));
    const image = await decoder.imageData();
    if (!image?.data || !image.width || !image.height) throw new Error(t('LibRaw returned no developed RGB pixels for this file.', 'O LibRaw não retornou pixels RGB revelados para este arquivo.'));
    const pixels = Number(image.width) * Number(image.height); if (!Number.isFinite(pixels) || pixels <= 0 || pixels > RAW_PIXEL_LIMIT) throw new Error(t('LibRaw output exceeds the 40-megapixel retained-pixel limit.', 'A saída do LibRaw excede o limite retido de 40 megapixels.'));
    return { width: Number(image.width), height: Number(image.height), rgba: rawRgbToRgba(image.data, Number(image.width), Number(image.height), Number(image.colors) || 3, Number(image.bits) || 8), metadata: normalizeMetadataForJson(metadata, { maximumDepth: 4, maximumArray: 32, maximumKeys: 120, maximumString: 1_000 }), colors: Number(image.colors) || 3, bits: Number(image.bits) || 8 };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error(t(`LibRaw could not develop this RAW file: ${error.message}`, `O LibRaw não conseguiu revelar este arquivo RAW: ${error.message}`));
  } finally { signal?.removeEventListener('abort', abort); decoder.dispose(); }
}

async function encodeCanvasTiff(canvas, t) {
  let module;
  try { module = await import('/vendor/suite/utif.js'); }
  catch (_) { throw new Error(t('The local UTIF encoder could not be loaded.', 'O codificador local UTIF não pôde ser carregado.')); }
  const UTIF = module.default || module.UTIF || module;
  if (typeof UTIF.encodeImage !== 'function') throw new Error(t('The loaded UTIF bundle has no TIFF encoder.', 'O pacote UTIF carregado não possui codificador TIFF.'));
  const image = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height); const encoded = UTIF.encodeImage(image.data.buffer, canvas.width, canvas.height); const bytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
  if (detectImageFormat(bytes) !== 'tiff') throw new Error(t('UTIF returned bytes without a valid TIFF signature.', 'O UTIF retornou bytes sem uma assinatura TIFF válida.'));
  if (bytes.byteLength > 256 * 1024 * 1024) throw new Error(t('TIFF output exceeds the 256 MiB retained-output limit.', 'A saída TIFF excede o limite retido de 256 MiB.'));
  return new Blob([bytes], { type: 'image/tiff' });
}

async function encodeCanvasAvif(canvas, quality, t) {
  let encode;
  try { ({ default: encode } = await import('/vendor/avif/encode.js')); }
  catch (_) { throw new Error(t('The site-hosted AVIF encoder could not be loaded.', 'O codificador AVIF hospedado no site não pôde ser carregado.')); }
  const image = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  let encoded;
  try { encoded = new Uint8Array(await encode(image, { quality: Math.round(clamp(Number(quality) || 0.88, 0.35, 1) * 100), qualityAlpha: -1, speed: 8, bitDepth: 8 })); }
  catch (error) { throw new Error(t(`The local AVIF encoder failed: ${error.message}`, `Falha no codificador AVIF local: ${error.message}`)); }
  if (detectImageFormat(encoded) !== 'avif') throw new Error(t('The AVIF runtime returned bytes without a valid AVIF signature.', 'O runtime AVIF retornou bytes sem uma assinatura AVIF válida.'));
  if (encoded.byteLength > 256 * 1024 * 1024) throw new Error(t('AVIF output exceeds the 256 MiB retained-output limit.', 'A saída AVIF excede o limite retido de 256 MiB.'));
  return new Blob([encoded], { type: 'image/avif' });
}

function encodeCanvasBmp(canvas) {
  const image = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  return new Blob([encodeBmpRgba(image.data, canvas.width, canvas.height)], { type: 'image/bmp' });
}

async function inspectWithExifr(blob, t) {
  let module;
  try { module = await import('/vendor/suite/exifr.js'); }
  catch (_) { throw new Error(t('The optional local exifr metadata runtime could not be loaded.', 'O runtime local opcional de metadados exifr não pôde ser carregado.')); }
  if (typeof module.parse !== 'function') throw new Error(t('The loaded exifr bundle has an unexpected API.', 'O pacote exifr carregado possui uma API inesperada.'));
  const value = await module.parse(blob, {
    tiff: true, ifd0: true, ifd1: true, exif: true, gps: true, interop: true,
    xmp: true, icc: true, iptc: true, jfif: true, ihdr: true,
    makerNote: false, userComment: true, translateKeys: true, translateValues: true,
    reviveValues: true, sanitize: true, mergeOutput: false, silentErrors: true,
    chunked: true, chunkLimit: 16
  });
  return normalizeMetadataForJson(value || {});
}

function assertAggregateBitmapBudget(bitmaps, maximumBytes, t) {
  const estimated = bitmaps.reduce((sum, item) => { const bitmap = item.bitmap || item; return sum + bitmap.width * bitmap.height * 4; }, 0);
  if (!Number.isFinite(estimated) || estimated > maximumBytes) throw new Error(t(`Decoded image set exceeds the ${formatBytes(maximumBytes)} aggregate bitmap limit. Use fewer or smaller images.`, `O conjunto decodificado excede o limite agregado de bitmaps de ${formatBytes(maximumBytes)}. Use menos imagens ou imagens menores.`));
}

function fitPixelBudget(width, height, maxEdge, pixelLimit) {
  let size = calculateContainedSize(width, height, maxEdge);
  if (size.width * size.height > pixelLimit) size = calculateContainedSize(size.width, size.height, Math.max(1, size.width * Math.sqrt(pixelLimit / (size.width * size.height))), Math.max(1, size.height * Math.sqrt(pixelLimit / (size.width * size.height))));
  return size;
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob) reject(new Error(`The browser could not encode ${mime}.`));
    else if (blob.type !== mime && mime !== 'image/jpeg') reject(new Error(`The browser returned ${blob.type || 'an unknown type'} instead of ${mime}; that encoder is unavailable.`));
    else resolve(blob);
  }, mime, quality));
}

function drawBitmap(bitmap, { maxEdge, background = null, filter = 'none' } = {}) {
  const size = calculateContainedSize(bitmap.width, bitmap.height, maxEdge || Math.max(bitmap.width, bitmap.height));
  const canvas = makeCanvas(size.width, size.height); const context = canvas.getContext('2d', { alpha: !background });
  if (background) { context.fillStyle = background; context.fillRect(0, 0, size.width, size.height); }
  context.filter = filter; context.drawImage(bitmap, 0, 0, size.width, size.height); context.filter = 'none'; return canvas;
}

async function measureCanvasEncoding(canvas, blob, t) {
  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch (_) { throw new Error(t('The newly encoded image could not be decoded for the quality comparison.', 'A imagem recém-codificada não pôde ser decodificada para a comparação de qualidade.')); }
  try {
    const size = calculateContainedSize(canvas.width, canvas.height, 512); const reference = makeCanvas(size.width, size.height); const candidate = makeCanvas(size.width, size.height);
    reference.getContext('2d', { willReadFrequently: true }).drawImage(canvas, 0, 0, size.width, size.height);
    candidate.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, size.width, size.height);
    return { ...imageQualityMetrics(reference.getContext('2d').getImageData(0, 0, size.width, size.height).data, candidate.getContext('2d').getImageData(0, 0, size.width, size.height).data), width: size.width, height: size.height };
  } finally { bitmap.close(); }
}

function setPreview(root, blob, urls, selector = '[data-preview]') {
  for (const url of urls) URL.revokeObjectURL(url); urls.clear();
  const url = URL.createObjectURL(blob); urls.add(url); const preview = root.querySelector(selector); preview.src = url; preview.hidden = false;
}

function bindRelease(root, release, focusTarget) {
  const handler = () => { release(); clearGenericOutput(root); setStatus(root.querySelector('[data-status]'), root.dataset.language === 'pt-BR' ? 'Saída e URLs locais liberadas.' : 'Output and local URLs released.', 'success'); focusTarget?.focus(); };
  root.querySelector('[data-release]').addEventListener('click', handler); return handler;
}

function mountImageConverter({ root, t }) {
  const id = 'universal-image-converter';
  shell(root, t, {
    id, controls: { en: 'Convert an image', pt: 'Converter uma imagem' }, badge: { en: 'Fresh local encoding', pt: 'Nova codificação local' }, results: { en: 'Converted image', pt: 'Imagem convertida' },
    fields: `${field(`${id}-file`, t('Source image', 'Imagem de origem'), '<input class="file-input" id="%%ID%%" type="file" accept="image/png,image/jpeg,image/webp,image/avif,image/tiff,image/bmp" required data-file>')}
      <div class="field-grid"><label><span class="field-label">${t('Output format', 'Formato de saída')}</span><select data-mime><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option><option value="image/webp">WebP</option><option value="image/avif">AVIF</option><option value="image/tiff">TIFF</option><option value="image/bmp">BMP</option></select></label>
      <label><span class="field-label">${t('Maximum edge', 'Maior lado')}</span><input class="number-input" type="number" min="16" max="12000" value="2400" data-edge></label>
      <label><span class="field-label">${t('Lossy quality', 'Qualidade com perda')}</span><input type="range" min="0.35" max="1" step="0.01" value="0.88" data-quality><output data-quality-out>88%</output></label>
      <label><span class="field-label">${t('Transparent-pixel background', 'Fundo para pixels transparentes')}</span><input type="color" value="#ffffff" data-background></label></div>
      <p class="field-help">${t('Input: 64 MiB, 80 MP. Site-hosted UTIF and libavif WASM provide TIFF and AVIF decoding; PNG/JPEG/WebP/BMP use browser decoders. TIFF, BMP, and AVIF outputs use bundled local encoders, while PNG/JPEG/WebP are feature-detected browser encodings.', 'Entrada: 64 MiB, 80 MP. UTIF e libavif WASM hospedados no site fornecem decodificação TIFF e AVIF; PNG/JPEG/WebP/BMP usam decodificadores do navegador. Saídas TIFF, BMP e AVIF usam codificadores locais incluídos, enquanto PNG/JPEG/WebP são codificações do navegador detectadas por recurso.')}</p>`,
    buttons: `<button class="button button-primary" type="submit">${t('Convert locally', 'Converter localmente')}</button><button class="button button-secondary" type="button" disabled data-download>${t('Download', 'Baixar')}</button>`,
    output: `<img hidden data-preview alt="${t('Converted image preview', 'Prévia da imagem convertida')}" style="display:block;max-width:100%;height:auto"><div class="notice-card"><strong>${t('A real browser encoding', 'Uma codificação real do navegador')}</strong><p data-detail></p></div>`,
    empty: { en: 'PNG, JPEG, WebP, AVIF, TIFF, and BMP use genuine output encoders. Optional WASM codecs load from this site only after conversion starts.', pt: 'PNG, JPEG, WebP, AVIF, TIFF e BMP usam codificadores de saída reais. Codecs WASM opcionais carregam deste site apenas após iniciar a conversão.' }
  });
  const form = root.querySelector('[data-form]'); const status = root.querySelector('[data-status]'); const urls = new Set(); let output = null; let filename = '';
  root.querySelector('[data-quality]').addEventListener('input', (event) => { root.querySelector('[data-quality-out]').value = `${Math.round(event.target.value * 100)}%`; });
  const updateEncodingControls = () => { const mime = root.querySelector('[data-mime]').value; root.querySelector('[data-quality]').disabled = !['image/jpeg', 'image/webp', 'image/avif'].includes(mime); root.querySelector('[data-background]').disabled = !['image/jpeg', 'image/bmp'].includes(mime); };
  root.querySelector('[data-mime]').addEventListener('change', updateEncodingControls); updateEncodingControls();
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); output = null; root.querySelector('[data-download]').disabled = true;
    const file = root.querySelector('[data-file]').files[0];
    try {
      const sourceBytes = await readLimited(file, IMAGE_INPUT_LIMIT, t('Select an image no larger than 64 MiB.', 'Selecione uma imagem de no máximo 64 MiB.'));
      setStatus(status, t('Decoding and creating a new local encoding…', 'Decodificando e criando uma nova codificação local…'));
      const decoded = await decodeImageWithOptionalTiff(file, sourceBytes, t); const { bitmap } = decoded;
      try {
        const mime = root.querySelector('[data-mime]').value; const edge = clamp(Number(root.querySelector('[data-edge]').value) || 2400, 16, 12000);
        const canvas = drawBitmap(bitmap, { maxEdge: edge, background: ['image/jpeg', 'image/bmp'].includes(mime) ? root.querySelector('[data-background]').value : null });
        output = mime === 'image/tiff' ? await encodeCanvasTiff(canvas, t) : mime === 'image/bmp' ? encodeCanvasBmp(canvas) : mime === 'image/avif' ? await encodeCanvasAvif(canvas, root.querySelector('[data-quality]').value, t) : await canvasBlob(canvas, mime, Number(root.querySelector('[data-quality]').value));
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/tiff': 'tiff', 'image/bmp': 'bmp' }[mime]; filename = `${safeStem(file.name, 'image')}.${extension}`;
        const previewBlob = ['image/tiff', 'image/bmp', 'image/avif'].includes(mime) ? await canvasBlob(canvas, 'image/png') : output;
        setPreview(root, previewBlob, urls); renderMetrics(root, [[t('Source', 'Origem'), formatBytes(file.size)], [t('Output', 'Saída'), formatBytes(output.size)], [t('Dimensions', 'Dimensões'), `${canvas.width} × ${canvas.height}`], [t('Uploaded', 'Enviado'), '0 B']]);
        root.querySelector('[data-detail]').textContent = t(`${detectImageFormat(sourceBytes).toUpperCase()} via ${decoded.decoder}${decoded.pages > 1 ? ` · first of ${decoded.pages} TIFF pages` : ''} → ${output.type}; pixel dimensions and metadata are reset by canvas encoding.`, `${detectImageFormat(sourceBytes).toUpperCase()} via ${decoded.decoder}${decoded.pages > 1 ? ` · primeira de ${decoded.pages} páginas TIFF` : ''} → ${output.type}; dimensões de pixel e metadados são redefinidos pela codificação em canvas.`);
        root.querySelector('[data-download]').disabled = false; showOutput(root); setStatus(status, t('Conversion complete in this tab.', 'Conversão concluída nesta aba.'), 'success'); root.querySelector(`#${id}-results-title`).focus();
      } finally { bitmap.close(); }
    } catch (error) { setStatus(status, error.message, 'error'); }
  });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, filename); });
  const release = () => { output = null; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); root.querySelector('[data-preview]').removeAttribute('src'); root.querySelector('[data-download]').disabled = true; };
  bindRelease(root, release, root.querySelector('[data-file]')); return release;
}

function mountImageCompressor({ root, t }) {
  const id = 'image-compressor';
  shell(root, t, {
    id, controls: { en: 'Compress a batch', pt: 'Comprimir um lote' }, badge: { en: 'Sequential / bounded', pt: 'Sequencial / limitado' }, results: { en: 'Compression report', pt: 'Relatório de compressão' },
    fields: `${field(`${id}-files`, t('Images', 'Imagens'), '<input class="file-input" id="%%ID%%" type="file" accept="image/png,image/jpeg,image/webp,image/avif" multiple required data-files>')}
      <div class="field-grid"><label><span class="field-label">${t('Encoding', 'Codificação')}</span><select data-mime><option value="image/webp">WebP</option><option value="image/jpeg">JPEG</option><option value="image/png">PNG</option></select></label><label><span class="field-label">${t('Maximum edge', 'Maior lado')}</span><input class="number-input" type="number" min="64" max="10000" value="2560" data-edge></label><label><span class="field-label">${t('Quality', 'Qualidade')}</span><input type="range" min="0.3" max="1" step="0.01" value="0.82" data-quality><output data-quality-out>82%</output></label></div>
      <p class="field-help">${t('Up to 30 files / 200 MiB total. Every output is decoded and re-encoded, which strips ordinary container metadata; it does not remove identifying content visible in pixels.', 'Até 30 arquivos / 200 MiB no total. Toda saída é decodificada e recodificada, removendo metadados comuns do contêiner; isso não remove conteúdo identificável visível nos pixels.')}</p>`,
    buttons: `<button class="button button-primary" type="submit">${t('Compress and compare', 'Comprimir e comparar')}</button>`,
    output: `<ul class="download-list" data-list></ul><div class="notice-card"><strong>${t('First-file comparison', 'Comparação do primeiro arquivo')}</strong><p data-comparison></p><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:1rem"><figure style="margin:0"><figcaption>${t('Resized source', 'Origem redimensionada')}</figcaption><img hidden data-original-preview alt="${t('First resized source preview', 'Prévia da primeira origem redimensionada')}" style="display:block;max-width:100%;height:auto"></figure><figure style="margin:0"><figcaption>${t('New encoding', 'Nova codificação')}</figcaption><img hidden data-preview alt="${t('First compressed output preview', 'Prévia da primeira saída comprimida')}" style="display:block;max-width:100%;height:auto"></figure></div></div>`,
    empty: { en: 'Outputs remain separate so each size result can be reviewed. “Compressed” may be larger when the source was already optimized.', pt: 'As saídas permanecem separadas para que cada tamanho possa ser revisado. A “comprimida” pode ficar maior se a origem já estava otimizada.' }
  });
  const status = root.querySelector('[data-status]'); const urls = new Set(); let outputs = [];
  root.querySelector('[data-quality]').addEventListener('input', (event) => { root.querySelector('[data-quality-out]').value = `${Math.round(event.target.value * 100)}%`; });
  root.querySelector('[data-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); release(); const files = [...root.querySelector('[data-files]').files]; const total = files.reduce((sum, file) => sum + file.size, 0);
    if (!files.length || files.length > 30 || total > 200 * 1024 * 1024) { setStatus(status, t('Choose 1–30 images totaling no more than 200 MiB.', 'Escolha de 1 a 30 imagens totalizando no máximo 200 MiB.'), 'error'); return; }
    const progress = root.querySelector('[data-progress]'); progress.hidden = false; progress.max = files.length; progress.value = 0; setStatus(status, t('Encoding one image at a time…', 'Codificando uma imagem por vez…'));
    const mime = root.querySelector('[data-mime]').value; const quality = Number(root.querySelector('[data-quality]').value); const edge = clamp(Number(root.querySelector('[data-edge]').value) || 2560, 64, 10000); const failures = [];
    for (const file of files) {
      try { const bitmap = await decodeBitmap(file, t); try { const canvas = drawBitmap(bitmap, { maxEdge: edge, background: mime === 'image/jpeg' ? '#ffffff' : null }); const blob = await canvasBlob(canvas, mime, quality); const measured = await measureCanvasEncoding(canvas, blob, t); const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime]; const sourcePreview = outputs.length ? null : await canvasBlob(canvas, 'image/png'); outputs.push({ blob, sourcePreview, measured, filename: `${safeStem(file.name, 'image')}.compressed.${extension}`, original: file.size, width: canvas.width, height: canvas.height }); } finally { bitmap.close(); } }
      catch (error) { failures.push(`${file.name}: ${error.message}`); }
      progress.value += 1; await new Promise((resolve) => setTimeout(resolve, 0));
    }
    progress.hidden = true; const list = root.querySelector('[data-list]'); list.replaceChildren();
    outputs.forEach((item, index) => { const row = document.createElement('li'); const text = document.createElement('span'); const button = document.createElement('button'); const psnr = Number.isFinite(item.measured.psnr) ? `${item.measured.psnr.toFixed(2)} dB` : '∞ dB'; text.textContent = `${item.filename} · ${formatBytes(item.original)} → ${formatBytes(item.blob.size)} · ${item.blob.size <= item.original ? `${Math.round((1 - item.blob.size / item.original) * 100)}% ${t('smaller', 'menor')}` : t('larger output', 'saída maior')} · PSNR ${psnr} · RMSE ${item.measured.rmse.toFixed(2)}`; button.type = 'button'; button.className = 'button button-secondary compact-button'; button.dataset.downloadIndex = String(index); button.textContent = t('Download', 'Baixar'); row.append(text, button); list.append(row); });
    if (outputs[0]) { const originalUrl = URL.createObjectURL(outputs[0].sourcePreview); const encodedUrl = URL.createObjectURL(outputs[0].blob); urls.add(originalUrl); urls.add(encodedUrl); const originalPreview = root.querySelector('[data-original-preview]'); const encodedPreview = root.querySelector('[data-preview]'); originalPreview.src = originalUrl; encodedPreview.src = encodedUrl; originalPreview.hidden = false; encodedPreview.hidden = false; const metric = outputs[0].measured; root.querySelector('[data-comparison]').textContent = t(`A bounded ${metric.width} × ${metric.height} RGB comparison measured PSNR ${Number.isFinite(metric.psnr) ? `${metric.psnr.toFixed(2)} dB` : '∞ dB'}, RMSE ${metric.rmse.toFixed(2)}, and mean absolute error ${metric.mae.toFixed(2)}. Inspect both previews at 100% before deleting a source.`, `Uma comparação RGB limitada a ${metric.width} × ${metric.height} mediu PSNR ${Number.isFinite(metric.psnr) ? `${metric.psnr.toFixed(2)} dB` : '∞ dB'}, RMSE ${metric.rmse.toFixed(2)} e erro absoluto médio ${metric.mae.toFixed(2)}. Inspecione ambas as prévias em 100% antes de excluir uma origem.`); }
    renderMetrics(root, [[t('Completed', 'Concluídas'), outputs.length], [t('Failures', 'Falhas'), failures.length], [t('Source bytes', 'Bytes de origem'), formatBytes(total)], [t('Output bytes', 'Bytes de saída'), formatBytes(outputs.reduce((sum, item) => sum + item.blob.size, 0))], [t('First quality', 'Qualidade da primeira'), outputs[0] ? `PSNR ${Number.isFinite(outputs[0].measured.psnr) ? outputs[0].measured.psnr.toFixed(2) : '∞'} dB` : '—']]); if (outputs.length) showOutput(root);
    setStatus(status, failures.length ? t(`${outputs.length} complete. ${failures.join(' | ')}`, `${outputs.length} concluída(s). ${failures.join(' | ')}`) : t('Batch encoding complete.', 'Codificação do lote concluída.'), failures.length ? 'warning' : 'success');
  });
  root.querySelector('[data-list]').addEventListener('click', (event) => { const index = event.target.closest('[data-download-index]')?.dataset.downloadIndex; if (index != null && outputs[index]) downloadBlob(outputs[index].blob, outputs[index].filename); });
  function release() { outputs = []; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); root.querySelector('[data-list]').replaceChildren(); for (const selector of ['[data-original-preview]', '[data-preview]']) { const preview = root.querySelector(selector); preview.removeAttribute('src'); preview.hidden = true; } }
  bindRelease(root, release, root.querySelector('[data-files]')); return release;
}

function mountRawProcessor({ root, t }) {
  const id = 'raw-photo-processor';
  shell(root, t, {
    id, controls: { en: 'Develop RAW sensor data', pt: 'Revelar dados RAW do sensor' }, badge: { en: 'LibRaw worker / local', pt: 'Worker LibRaw / local' }, results: { en: 'Developed photograph', pt: 'Fotografia revelada' },
    fields: `${field(`${id}-file`, t('RAW photo', 'Foto RAW'), '<input class="file-input" id="%%ID%%" type="file" accept=".cr2,.cr3,.nef,.arw,.dng,.orf,.rw2,.raf,image/x-adobe-dng,image/tiff" required data-file>')}
      <div class="field-grid"><label><span class="field-label">${t('Exposure', 'Exposição')}</span><input type="range" min="-3" max="3" step="0.1" value="0" data-exposure><output data-exposure-out>0 EV</output></label><label><span class="field-label">${t('White balance', 'Balanço de branco')}</span><select data-white-balance><option value="camera">${t('Camera', 'Câmera')}</option><option value="auto">${t('Automatic', 'Automático')}</option><option value="custom">${t('Custom multipliers', 'Multiplicadores personalizados')}</option></select></label><label><span class="field-label">${t('Temperature shift', 'Ajuste de temperatura')}</span><input type="range" min="-1" max="1" step="0.05" value="0" disabled data-temperature><output data-temperature-out>0</output></label><label><span class="field-label">${t('Green–magenta tint', 'Matiz verde–magenta')}</span><input type="range" min="-1" max="1" step="0.05" value="0" disabled data-tint><output data-tint-out>0</output></label><label><span class="field-label">${t('Resolution', 'Resolução')}</span><select data-resolution><option value="half">${t('Half-size demosaic', 'Demosaico em meia resolução')}</option><option value="full">${t('Full resolution', 'Resolução completa')}</option></select></label><label><span class="field-label">${t('Output format', 'Formato de saída')}</span><select data-format><option value="jpeg">JPEG</option><option value="tiff">TIFF</option></select></label><label><span class="field-label">${t('JPEG quality', 'Qualidade JPEG')}</span><input type="range" min="0.5" max="1" step="0.01" value="0.92" data-quality><output data-quality-out>92%</output></label></div>
      <div class="notice-card"><strong>${t('Real sensor development in a disposable worker', 'Revelação real do sensor em worker descartável')}</strong><p>${t('LibRaw demosaics CR2, NEF, ARW, DNG and other supported RAW variants with camera/auto/custom white balance and exposure correction. Output is genuine 8-bit sRGB JPEG or baseline TIFF; lens correction profiles and editing of the original RAW remain outside this local developer. Input is capped at 128 MiB and developed output at 40 MP. Threaded WebAssembly requires cross-origin isolation; GitHub Pages needs the one-time isolation helper reload below.', 'O LibRaw faz o demosaico de CR2, NEF, ARW, DNG e outras variantes RAW compatíveis, com balanço de branco da câmera/automático/personalizado e correção de exposição. A saída é JPEG sRGB de 8 bits ou TIFF baseline genuíno; perfis de correção de lente e edição do RAW original ficam fora deste revelador local. A entrada é limitada a 128 MiB e a saída revelada a 40 MP. WebAssembly com threads exige isolamento de origem; no GitHub Pages é necessário recarregar uma vez com o auxiliar abaixo.')}</p></div>`,
    buttons: `<button class="button button-primary" type="submit">${t('Develop with LibRaw', 'Revelar com LibRaw')}</button><button class="button button-secondary" type="button" disabled data-cancel>${t('Cancel', 'Cancelar')}</button><button class="button button-secondary" type="button" disabled data-download>${t('Download output', 'Baixar saída')}</button><button class="button button-secondary" type="button" data-enable-isolation>${t('Enable worker isolation and reload', 'Ativar isolamento do worker e recarregar')}</button>`,
    output: `<img hidden data-preview alt="${t('Developed RAW preview', 'Prévia RAW revelada')}" style="display:block;max-width:100%;height:auto"><pre class="code-output" data-detail></pre>`,
    empty: { en: 'The selected RAW bytes stay in this tab, are transferred once to LibRaw, and are released when the worker terminates after each development.', pt: 'Os bytes RAW selecionados permanecem nesta aba, são transferidos uma vez ao LibRaw e liberados quando o worker é encerrado após cada revelação.' }
  });
  const status = root.querySelector('[data-status]'); const urls = new Set(); const submit = root.querySelector('[data-form] button[type="submit"]'); const isolation = root.querySelector('[data-enable-isolation]'); let output = null; let filename = ''; let controller = null;
  isolation.hidden = Boolean(globalThis.crossOriginIsolated);
  for (const name of ['exposure', 'temperature', 'tint']) root.querySelector(`[data-${name}]`).addEventListener('input', (event) => { root.querySelector(`[data-${name}-out]`).value = `${event.target.value}${name === 'exposure' ? ' EV' : ''}`; });
  root.querySelector('[data-quality]').addEventListener('input', (event) => { root.querySelector('[data-quality-out]').value = `${Math.round(Number(event.target.value) * 100)}%`; });
  root.querySelector('[data-white-balance]').addEventListener('change', (event) => { const custom = event.target.value === 'custom'; root.querySelector('[data-temperature]').disabled = !custom; root.querySelector('[data-tint]').disabled = !custom; });
  root.querySelector('[data-format]').addEventListener('change', (event) => { root.querySelector('[data-quality]').disabled = event.target.value !== 'jpeg'; });
  isolation.addEventListener('click', async () => {
    if (!navigator.serviceWorker) { setStatus(status, t('This browser cannot register the required isolation helper.', 'Este navegador não pode registrar o auxiliar de isolamento necessário.'), 'error'); return; }
    isolation.disabled = true; setStatus(status, t('Registering the local isolation helper…', 'Registrando o auxiliar local de isolamento…'));
    try { await navigator.serviceWorker.register('/coi-serviceworker.js', { scope: '/' }); await navigator.serviceWorker.ready; globalThis.location.reload(); }
    catch (error) { isolation.disabled = false; setStatus(status, t(`Isolation helper failed: ${error.message}`, `Falha no auxiliar de isolamento: ${error.message}`), 'error'); }
  });
  root.querySelector('[data-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); if (controller) return; output = null; root.querySelector('[data-download]').disabled = true; const file = root.querySelector('[data-file]').files[0];
    if (!globalThis.crossOriginIsolated) { setStatus(status, t('LibRaw needs cross-origin isolation. Use “Enable worker isolation and reload”, then reselect the RAW file.', 'O LibRaw exige isolamento de origem. Use “Ativar isolamento do worker e recarregar” e selecione o RAW novamente.'), 'error'); return; }
    try {
      const bytes = await readLimited(file, RAW_INPUT_LIMIT, t('Select one RAW file no larger than 128 MiB.', 'Selecione um arquivo RAW de no máximo 128 MiB.')); const ev = Number(root.querySelector('[data-exposure]').value); const temperature = Number(root.querySelector('[data-temperature]').value); const tint = Number(root.querySelector('[data-tint]').value); const whiteBalance = root.querySelector('[data-white-balance]').value; const format = root.querySelector('[data-format]').value;
      const settings = { outputBps: 8, outputColor: 1, useCameraMatrix: 3, userQual: 3, highlight: 2, halfSize: root.querySelector('[data-resolution]').value === 'half', expCorrec: Math.abs(ev) > 0.001, expShift: 2 ** ev, expPreser: 0.5, useCameraWb: whiteBalance === 'camera', useAutoWb: whiteBalance === 'auto', userMul: whiteBalance === 'custom' ? [2 ** (temperature * 0.75), 2 ** (-tint * 0.4), 2 ** (-temperature * 0.75), 2 ** (-tint * 0.4)] : null };
      controller = new AbortController(); submit.disabled = true; root.querySelector('[data-cancel]').disabled = false; setStatus(status, t('Loading LibRaw, demosaicing sensor pixels, and applying development settings…', 'Carregando o LibRaw, fazendo o demosaico dos pixels do sensor e aplicando os ajustes…'));
      const developed = await developRawWithLibRaw(bytes, settings, { signal: controller.signal, t }); const canvas = makeCanvas(developed.width, developed.height); canvas.getContext('2d').putImageData(new ImageData(developed.rgba, developed.width, developed.height), 0, 0); const preview = await canvasBlob(canvas, 'image/jpeg', 0.86);
      if (format === 'tiff') { output = await encodeCanvasTiff(canvas, t); filename = `${safeStem(file.name, 'raw-photo')}.developed.tiff`; }
      else { output = await canvasBlob(canvas, 'image/jpeg', Number(root.querySelector('[data-quality]').value)); filename = `${safeStem(file.name, 'raw-photo')}.developed.jpg`; }
      setPreview(root, preview, urls); root.querySelector('[data-detail]').textContent = JSON.stringify({ decoder: 'LibRaw WASM worker', source: file.name, settings: { exposureEV: ev, whiteBalance, temperature: whiteBalance === 'custom' ? temperature : null, tint: whiteBalance === 'custom' ? tint : null, halfSize: settings.halfSize }, output: { format: output.type, width: developed.width, height: developed.height, bytes: output.size, bitsPerSample: 8 }, camera: developed.metadata }, null, 2); renderMetrics(root, [[t('Developed', 'Revelada'), `${developed.width} × ${developed.height}`], [t('Input', 'Entrada'), formatBytes(file.size)], [t('Output', 'Saída'), formatBytes(output.size)], [t('Uploads', 'Uploads'), '0 B']]); root.querySelector('[data-download]').disabled = false; showOutput(root); setStatus(status, t(`LibRaw sensor development complete; genuine ${format.toUpperCase()} output is ready.`, `Revelação do sensor com LibRaw concluída; a saída ${format.toUpperCase()} genuína está pronta.`), 'success');
    } catch (error) { const canceled = error.name === 'AbortError'; setStatus(status, canceled ? t('RAW development canceled and worker memory released.', 'Revelação RAW cancelada e memória do worker liberada.') : error.message, canceled ? 'warning' : 'error'); }
    finally { controller = null; submit.disabled = false; root.querySelector('[data-cancel]').disabled = true; }
  });
  root.querySelector('[data-cancel]').addEventListener('click', () => controller?.abort());
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, filename); });
  function release() { controller?.abort(); controller = null; output = null; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); root.querySelector('[data-preview]').removeAttribute('src'); root.querySelector('[data-download]').disabled = true; }
  bindRelease(root, release, root.querySelector('[data-file]')); return release;
}

function mountSvgStudio({ root, t }) {
  const id = 'svg-studio';
  shell(root, t, {
    id, controls: { en: 'Edit and sanitize SVG', pt: 'Editar e sanitizar SVG' }, badge: { en: 'Inspectable text', pt: 'Texto inspecionável' }, results: { en: 'Safe local preview', pt: 'Prévia local segura' },
    fields: `${field(`${id}-file`, t('Optional SVG file', 'Arquivo SVG opcional'), '<input class="file-input" id="%%ID%%" type="file" accept="image/svg+xml,.svg" data-file>')}${field(`${id}-source`, t('SVG markup', 'Markup SVG'), '<textarea class="code-input" id="%%ID%%" rows="13" spellcheck="false" required data-source><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#111"/><circle cx="160" cy="90" r="54" fill="#b7ff39"/></svg></textarea>')}
      <div class="field-grid"><label><span class="field-label">${t('Scale transform', 'Transformação de escala')}</span><input class="number-input" type="number" min="0.05" max="20" step="0.05" value="1" data-scale></label><label><span class="field-label">${t('Rotate', 'Rotacionar')}</span><input class="number-input" type="number" min="-360" max="360" step="1" value="0" data-rotate></label></div>
      <p class="field-help">${t('Removes scripts, foreignObject, event handlers, external links, doctypes, comments, and unsafe style URLs. It is a conservative sanitizer/minifier, not SVGO path-geometry rewriting.', 'Remove scripts, foreignObject, manipuladores de eventos, links externos, doctypes, comentários e URLs de estilo inseguras. É um sanitizador/minificador conservador, não uma reescrita geométrica de caminhos como o SVGO.')}</p>`,
    buttons: `<button class="button button-primary" type="submit">${t('Sanitize and preview', 'Sanitizar e visualizar')}</button><button class="button button-secondary" type="button" disabled data-download>${t('Download SVG', 'Baixar SVG')}</button>`,
    output: `<img hidden data-preview alt="${t('Sanitized SVG preview', 'Prévia do SVG sanitizado')}" style="display:block;max-width:100%;height:auto"><h3>${t('Sanitized markup', 'Markup sanitizado')}</h3><pre class="code-output" data-code></pre>`,
    empty: { en: 'The preview is loaded through an image Blob URL, not inserted as live page markup. Review transformed geometry before export.', pt: 'A prévia é carregada por uma URL Blob de imagem, não inserida como markup ativo na página. Revise a geometria transformada antes de exportar.' }
  });
  const status = root.querySelector('[data-status]'); const urls = new Set(); let output = null;
  root.querySelector('[data-file]').addEventListener('change', async (event) => { const file = event.target.files[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) { setStatus(status, t('SVG input is limited to 2 MiB.', 'A entrada SVG é limitada a 2 MiB.'), 'error'); return; } root.querySelector('[data-source]').value = await file.text(); });
  root.querySelector('[data-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    try { const original = root.querySelector('[data-source]').value; const transformed = transformSvgMarkup(original, { scale: root.querySelector('[data-scale]').value, rotate: root.querySelector('[data-rotate]').value }); output = new Blob([transformed], { type: 'image/svg+xml;charset=utf-8' }); setPreview(root, output, urls); root.querySelector('[data-code]').textContent = transformed; const stats = analyzeSvgMarkup(transformed); renderMetrics(root, [[t('Elements', 'Elementos'), stats.elements], [t('Paths', 'Caminhos'), stats.paths], [t('ViewBox', 'ViewBox'), stats.viewBox || t('missing', 'ausente')], [t('Size change', 'Mudança de tamanho'), `${formatBytes(encoder.encode(original).length)} → ${formatBytes(stats.bytes)}`]]); root.querySelector('[data-download]').disabled = false; showOutput(root); setStatus(status, t('SVG sanitized and transformed. Inspect the preview before download.', 'SVG sanitizado e transformado. Inspecione a prévia antes de baixar.'), 'success'); }
    catch (error) { setStatus(status, error.message, 'error'); }
  });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, 'optimized.svg'); });
  function release() { output = null; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); root.querySelector('[data-preview]').removeAttribute('src'); root.querySelector('[data-download]').disabled = true; root.querySelector('[data-code]').textContent = ''; }
  bindRelease(root, release, root.querySelector('[data-source]')); return release;
}

function mountMetadataWorkbench({ root, t }) {
  const id = 'image-metadata-workbench';
  shell(root, t, {
    id, controls: { en: 'Inspect or rewrite metadata', pt: 'Inspecionar ou reescrever metadados' }, badge: { en: 'exifr + byte rewrite', pt: 'exifr + reescrita em bytes' }, results: { en: 'Metadata inventory', pt: 'Inventário de metadados' },
    fields: `${field(`${id}-file`, t('Image file', 'Arquivo de imagem'), '<input class="file-input" id="%%ID%%" type="file" accept="image/jpeg,image/png,image/tiff,image/webp,image/avif,image/heic,.jpg,.jpeg,.png,.tif,.tiff,.webp,.avif,.heic,.heif" required data-file>')}
      <fieldset class="segmented-fieldset"><legend>${t('Operation', 'Operação')}</legend><label><input type="radio" name="metadata-operation" value="inspect" checked><span>${t('Inspect', 'Inspecionar')}</span></label><label><input type="radio" name="metadata-operation" value="strip"><span>${t('Remove recognized metadata', 'Remover metadados reconhecidos')}</span></label><label><input type="radio" name="metadata-operation" value="comment"><span>${t('Replace description', 'Substituir descrição')}</span></label></fieldset>
      ${field(`${id}-comment`, t('Description text', 'Texto da descrição'), '<input class="text-input" id="%%ID%%" type="text" maxlength="2000" data-comment>')}
      <label><span class="field-label">${t('Description namespace', 'Namespace da descrição')}</span><select data-description-kind><option value="comment">${t('JPEG comment / PNG description', 'Comentário JPEG / descrição PNG')}</option><option value="exif">EXIF ImageDescription (JPEG)</option><option value="iptc">IPTC Caption-Abstract (JPEG)</option><option value="xmp">XMP dc:description (JPEG)</option></select></label>
      <p class="field-help">${t('Inspection lazily loads the vendored exifr parser for EXIF, GPS, IPTC, XMP, ICC, JFIF, TIFF/HEIF, and PNG headers; MakerNote is deliberately skipped and large/binary values are bounded in the report. JPEG edits write a genuine EXIF ImageDescription, IPTC Caption-Abstract, XMP dc:description, or COM segment while preserving unrelated segments. Full removal targets APP1/APP2/APP13/COM. PNG supports description replacement and recognized-chunk removal. Pixel bytes are never decoded.', 'A inspeção carrega sob demanda o parser exifr incluído para EXIF, GPS, IPTC, XMP, ICC, JFIF, TIFF/HEIF e cabeçalhos PNG; MakerNote é ignorado deliberadamente e valores grandes/binários são limitados no relatório. Edições JPEG gravam EXIF ImageDescription, IPTC Caption-Abstract, XMP dc:description ou segmento COM reais, preservando segmentos não relacionados. A remoção completa atinge APP1/APP2/APP13/COM. PNG aceita substituição de descrição e remoção de chunks reconhecidos. Os pixels nunca são decodificados.')}</p>`,
    buttons: `<button class="button button-primary" type="submit">${t('Run byte-level operation', 'Executar operação em bytes')}</button><button class="button button-secondary" type="button" disabled data-download>${t('Download rewritten file', 'Baixar arquivo reescrito')}</button>`,
    output: `<pre class="code-output" data-report></pre>`,
    empty: { en: 'Rich inspection is read-only. Rewrites are intentionally conservative; unknown proprietary metadata can remain, so verify sensitive files with a specialist tool.', pt: 'A inspeção detalhada é somente leitura. Reescritas são conservadoras; metadados proprietários desconhecidos podem permanecer, portanto verifique arquivos sensíveis com uma ferramenta especializada.' }
  });
  const status = root.querySelector('[data-status]'); let output = null; let filename = '';
  root.querySelector('[data-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); output = null; root.querySelector('[data-download]').disabled = true;
    try {
      const file = root.querySelector('[data-file]').files[0]; const bytes = await readLimited(file, 64 * 1024 * 1024, t('Select an image no larger than 64 MiB.', 'Selecione uma imagem de no máximo 64 MiB.')); const operation = root.querySelector('input[name="metadata-operation"]:checked').value; const before = inspectImageBytes(bytes); let richBefore = {}; let richWarning = null;
      setStatus(status, t('Loading the local metadata parser and inspecting blocks…', 'Carregando o parser local de metadados e inspecionando blocos…'));
      try { richBefore = await inspectWithExifr(file, t); } catch (error) { richWarning = error.message; }
      if (operation !== 'inspect' && !['jpeg', 'png'].includes(before.format)) throw new Error(t('Rich inspection supports this format, but lossless editing/removal is limited to structurally recognized JPEG and PNG files.', 'A inspeção detalhada suporta este formato, mas edição/remoção sem perda é limitada a arquivos JPEG e PNG reconhecidos estruturalmente.'));
      let resultBytes = bytes;
      if (operation === 'strip') resultBytes = before.format === 'jpeg' ? stripJpegMetadata(bytes) : processPngMetadata(bytes);
      else if (operation === 'comment') { const comment = root.querySelector('[data-comment]').value.trim(); const namespace = root.querySelector('[data-description-kind]').value; if (!comment) throw new Error(t('Enter a description to write.', 'Digite uma descrição para gravar.')); if (before.format === 'png' && namespace !== 'comment') throw new Error(t('Structured EXIF, IPTC, and XMP description editing is available for JPEG; choose the PNG description option for this file.', 'A edição estruturada de descrições EXIF, IPTC e XMP está disponível para JPEG; escolha a opção de descrição PNG para este arquivo.')); resultBytes = before.format === 'jpeg' ? rewriteJpegDescription(bytes, namespace, comment) : processPngMetadata(bytes, { description: comment }); }
      const after = inspectImageBytes(resultBytes); let richAfter = null;
      if (operation !== 'inspect') { try { richAfter = await inspectWithExifr(new Blob([resultBytes], { type: before.format === 'jpeg' ? 'image/jpeg' : 'image/png' }), t); } catch (error) { richWarning ||= error.message; } }
      const report = { file: file.name, operation, byteLevel: { before, after, byteChange: resultBytes.length - bytes.length }, richMetadata: { before: richBefore, after: richAfter }, parserWarning: richWarning };
      root.querySelector('[data-report]').textContent = JSON.stringify(report, null, 2); const leaves = countMetadataLeaves(richBefore); renderMetrics(root, [[t('Format', 'Formato'), before.format.toUpperCase()], [t('Dimensions', 'Dimensões'), before.width && before.height ? `${before.width} × ${before.height}` : '—'], [t('Rich values', 'Valores detalhados'), leaves], [t('Bytes', 'Bytes'), `${formatBytes(bytes.length)} → ${formatBytes(resultBytes.length)}`]]); showOutput(root);
      if (operation !== 'inspect') { output = new Blob([resultBytes], { type: before.format === 'jpeg' ? 'image/jpeg' : 'image/png' }); filename = `${safeStem(file.name, 'image')}.${operation === 'strip' ? 'metadata-removed' : 'description-edited'}.${before.format === 'jpeg' ? 'jpg' : 'png'}`; root.querySelector('[data-download]').disabled = false; }
      setStatus(status, richWarning ? t(`Byte-level operation completed, but rich parser warning: ${richWarning}`, `Operação em bytes concluída, mas o parser detalhado informou: ${richWarning}`) : operation === 'inspect' ? t(`Rich metadata inspection complete (${leaves} bounded values); no output file was created.`, `Inspeção detalhada concluída (${leaves} valores limitados); nenhum arquivo de saída foi criado.`) : t('Byte-level rewrite and rich before/after inspection complete.', 'Reescrita em bytes e inspeção detalhada antes/depois concluídas.'), richWarning ? 'warning' : operation === 'inspect' ? 'neutral' : 'success');
    } catch (error) { setStatus(status, error.message, 'error'); }
  });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, filename); });
  function release() { output = null; root.querySelector('[data-download]').disabled = true; root.querySelector('[data-report]').textContent = ''; }
  bindRelease(root, release, root.querySelector('[data-file]')); return release;
}

function mountOcrStudio({ root, t }) {
  const id = 'ocr-studio';
  shell(root, t, {
    id, controls: { en: 'Prepare and recognize a page', pt: 'Preparar e reconhecer uma página' }, badge: { en: 'Tesseract WASM', pt: 'Tesseract WASM' }, results: { en: 'Recognized page', pt: 'Página reconhecida' },
    fields: `${field(`${id}-file`, t('Page image', 'Imagem da página'), '<input class="file-input" id="%%ID%%" type="file" accept="image/*" required data-file>')}
      <div class="field-grid"><label><span class="field-label">${t('OCR engine', 'Motor OCR')}</span><select data-engine><option value="tesseract">Tesseract WASM</option><option value="native">${t('Browser TextDetector', 'TextDetector do navegador')}</option></select></label><label><span class="field-label">${t('Language', 'Idioma')}</span><select data-language><option value="eng">English</option><option value="por">Português</option><option value="spa">Español</option></select></label></div>
      <fieldset class="segmented-fieldset"><legend>${t('Preprocessing', 'Pré-processamento')}</legend><label><input type="radio" name="ocr-preprocess" value="color"><span>${t('Color', 'Cor')}</span></label><label><input type="radio" name="ocr-preprocess" value="grayscale" checked><span>${t('Grayscale', 'Cinza')}</span></label><label><input type="radio" name="ocr-preprocess" value="threshold"><span>${t('Otsu threshold', 'Limiar Otsu')}</span></label></fieldset>
      <div class="notice-card"><strong>${t('Runtime local; selected language data is downloaded on demand.', 'Runtime local; dados do idioma selecionado são baixados sob demanda.')}</strong><p>${t('Tesseract code/core loads from this site only after you start. Its traineddata is fetched from tessdata.projectnaptha.com and normally cached in IndexedDB; that host receives ordinary network metadata, never your image. TextDetector performs no model download when the browser exposes it.', 'O código/core do Tesseract é carregado deste site somente após iniciar. O traineddata vem de tessdata.projectnaptha.com e normalmente é armazenado no IndexedDB; esse host recebe metadados comuns de rede, nunca sua imagem. TextDetector não baixa modelo quando exposto pelo navegador.')}</p></div>`,
    buttons: `<button class="button button-primary" type="submit">${t('Preprocess and run OCR', 'Pré-processar e executar OCR')}</button><button class="button button-secondary" type="button" disabled data-release-model>${t('Release OCR worker', 'Liberar worker OCR')}</button><button class="button button-secondary" type="button" disabled data-download-image>${t('Download cleaned PNG', 'Baixar PNG limpo')}</button><button class="button button-secondary" type="button" disabled data-download-pdf>${t('Download searchable PDF', 'Baixar PDF pesquisável')}</button>`,
    output: `<canvas data-canvas role="img" aria-label="${t('Cleaned page with OCR bounding boxes', 'Página limpa com caixas do OCR')}" style="display:block;max-width:100%;height:auto"></canvas><h3>${t('Detected text', 'Texto detectado')}</h3><pre class="code-output" data-text></pre>`,
    empty: { en: 'The cleaned page is always a real local image output. Searchable PDF is offered only after an actual OCR engine returns text.', pt: 'A página limpa é sempre uma saída de imagem local real. O PDF pesquisável só é oferecido após um motor OCR real retornar texto.' }
  });
  const status = root.querySelector('[data-status]'); const progress = root.querySelector('[data-progress]'); let cleaned = null; let pdf = null; let filename = ''; let worker = null; let workerLanguage = '';
  async function terminateWorker() { const current = worker; worker = null; workerLanguage = ''; root.querySelector('[data-release-model]').disabled = true; if (current) await current.terminate().catch(() => {}); }
  async function ensureTesseract(language) {
    if (worker && workerLanguage === language) return worker;
    await terminateWorker(); let module;
    try { module = await import('/vendor/tesseract/tesseract.esm.min.js'); }
    catch (_) { throw new Error(t('The local Tesseract module could not be loaded. Rebuild vendor assets or choose TextDetector when available.', 'O módulo local Tesseract não pôde ser carregado. Reconstrua os assets de vendor ou escolha TextDetector quando disponível.')); }
    setStatus(status, t('Loading Tesseract core and selected language data…', 'Carregando o core do Tesseract e os dados do idioma selecionado…'));
    const runtime = module.default || module;
    if (typeof runtime.createWorker !== 'function') throw new Error(t('The loaded Tesseract bundle has an unexpected API.', 'O pacote Tesseract carregado possui uma API inesperada.'));
    worker = await runtime.createWorker(language, 1, { workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract/core', langPath: 'https://tessdata.projectnaptha.com/4.0.0', logger: (message) => { if (Number.isFinite(message.progress)) { progress.hidden = false; progress.max = 1; progress.value = message.progress; setStatus(status, `OCR · ${message.status || t('working', 'processando')} · ${Math.round(message.progress * 100)}%`); } } });
    workerLanguage = language; root.querySelector('[data-release-model]').disabled = false; return worker;
  }
  root.querySelector('[data-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); cleaned = null; pdf = null; root.querySelector('[data-download-image]').disabled = true; root.querySelector('[data-download-pdf]').disabled = true;
    const file = root.querySelector('[data-file]').files[0];
    try {
      await readLimited(file, IMAGE_INPUT_LIMIT, t('Select a page image no larger than 64 MiB.', 'Selecione uma imagem de página de no máximo 64 MiB.')); const bitmap = await decodeBitmap(file, t);
      try {
        const size = calculateContainedSize(bitmap.width, bitmap.height, 3200); const canvas = root.querySelector('[data-canvas]'); canvas.width = size.width; canvas.height = size.height; const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(bitmap, 0, 0, size.width, size.height);
        const mode = root.querySelector('input[name="ocr-preprocess"]:checked').value; let threshold = null;
        if (mode !== 'color') { const image = context.getImageData(0, 0, size.width, size.height); if (mode === 'threshold') { const result = thresholdRgba(image.data); image.data.set(result.data); threshold = result.threshold; } else { for (let index = 0; index < image.data.length; index += 4) { const value = luma(image.data[index], image.data[index + 1], image.data[index + 2]); image.data[index] = value; image.data[index + 1] = value; image.data[index + 2] = value; } } context.putImageData(image, 0, 0); }
        cleaned = await canvasBlob(canvas, 'image/png'); filename = safeStem(file.name, 'scanned-page'); let blocks = []; let recognizedText = ''; let confidence = null; const engine = root.querySelector('[data-engine]').value;
        if (engine === 'tesseract') {
          const activeWorker = await ensureTesseract(root.querySelector('[data-language]').value); const result = await activeWorker.recognize(canvas, {}, { text: true, blocks: true, tsv: true, pdf: true }); recognizedText = String(result.data.text || '').trim(); confidence = Number(result.data.confidence); blocks = flattenTesseractBlocks(result.data.blocks); if (result.data.pdf?.length && recognizedText) { pdf = new Blob([new Uint8Array(result.data.pdf)], { type: 'application/pdf' }); root.querySelector('[data-download-pdf]').disabled = false; }
        } else if (typeof globalThis.TextDetector === 'function') {
          setStatus(status, t('Running the browser text detector locally…', 'Executando o detector de texto do navegador localmente…'));
          const detector = new globalThis.TextDetector(); const detectionBitmap = await createImageBitmap(canvas);
          try { blocks = await detector.detect(detectionBitmap); } finally { detectionBitmap.close(); }
          recognizedText = blocks.map((block) => block.rawValue || block.text || '').filter(Boolean).join('\n'); if (blocks.length) { const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.92); pdf = new Blob([buildSearchablePdf(new Uint8Array(await jpeg.arrayBuffer()), canvas.width, canvas.height, blocks)], { type: 'application/pdf' }); root.querySelector('[data-download-pdf]').disabled = false; }
        } else throw new Error(t('TextDetector was selected, but this browser does not expose it. Choose Tesseract WASM.', 'TextDetector foi selecionado, mas este navegador não o expõe. Escolha Tesseract WASM.'));
        context.lineWidth = Math.max(2, Math.round(size.width / 800)); context.strokeStyle = '#b7ff39'; for (const block of blocks) { const box = block.boundingBox; if (box) context.strokeRect(box.x, box.y, box.width, box.height); }
        root.querySelector('[data-text]').textContent = recognizedText || t('No text returned.', 'Nenhum texto retornado.'); root.querySelector('[data-download-image]').disabled = false; renderMetrics(root, [[t('Page', 'Página'), `${canvas.width} × ${canvas.height}`], [t('Engine', 'Motor'), engine === 'tesseract' ? 'Tesseract WASM' : 'TextDetector'], [t('Words / boxes', 'Palavras / caixas'), blocks.length], [t('Confidence', 'Confiança'), Number.isFinite(confidence) ? `${round(confidence, 1)}%` : '—']]); showOutput(root); progress.hidden = true;
        setStatus(status, recognizedText ? t('OCR complete. Review every word and bounding box before relying on the result.', 'OCR concluído. Revise cada palavra e caixa antes de confiar no resultado.') : t('The OCR engine ran but returned no text. Cleaned PNG remains available.', 'O motor OCR foi executado, mas não retornou texto. O PNG limpo continua disponível.'), recognizedText ? 'success' : 'warning');
      } finally { bitmap.close(); }
    } catch (error) { progress.hidden = true; setStatus(status, error.message, 'error'); }
  });
  root.querySelector('[data-release-model]').addEventListener('click', async () => { await terminateWorker(); setStatus(status, t('OCR worker and model memory released. Downloadable outputs remain.', 'Worker OCR e memória do modelo liberados. As saídas para download permanecem.'), 'success'); });
  root.querySelector('[data-download-image]').addEventListener('click', () => { if (cleaned) downloadBlob(cleaned, `${filename}.cleaned.png`); });
  root.querySelector('[data-download-pdf]').addEventListener('click', () => { if (pdf) downloadBlob(pdf, `${filename}.searchable.pdf`); });
  function releaseOutput() { cleaned = null; pdf = null; root.querySelector('[data-download-image]').disabled = true; root.querySelector('[data-download-pdf]').disabled = true; root.querySelector('[data-text]').textContent = ''; const canvas = root.querySelector('[data-canvas]'); canvas.width = 1; canvas.height = 1; }
  bindRelease(root, releaseOutput, root.querySelector('[data-file]')); return async () => { releaseOutput(); await terminateWorker(); };
}

function mountDocumentScanner({ root, t }) {
  const id = 'document-scanner';
  const corner = (name, label, x, y) => `<fieldset><legend>${label}</legend><div class="field-grid"><label><span class="field-label">X %</span><input class="number-input" type="number" min="0" max="100" step="0.5" value="${x}" data-${name}-x></label><label><span class="field-label">Y %</span><input class="number-input" type="number" min="0" max="100" step="0.5" value="${y}" data-${name}-y></label></div></fieldset>`;
  shell(root, t, {
    id, controls: { en: 'Correct a photographed page', pt: 'Corrigir uma página fotografada' }, badge: { en: 'Four-corner warp', pt: 'Distorção por quatro cantos' }, results: { en: 'Scanned page', pt: 'Página digitalizada' },
    fields: `${field(`${id}-file`, t('Document photo', 'Foto do documento'), '<input class="file-input" id="%%ID%%" type="file" accept="image/*" required data-file>')}<details><summary>${t('Source corners as percentages', 'Cantos da origem em porcentagens')}</summary>${corner('tl', t('Top left', 'Superior esquerdo'), 3, 3)}${corner('tr', t('Top right', 'Superior direito'), 97, 3)}${corner('br', t('Bottom right', 'Inferior direito'), 97, 97)}${corner('bl', t('Bottom left', 'Inferior esquerdo'), 3, 97)}</details>
      <fieldset class="segmented-fieldset"><legend>${t('Cleanup', 'Limpeza')}</legend><label><input type="radio" name="scanner-mode" value="color"><span>${t('Color', 'Cor')}</span></label><label><input type="radio" name="scanner-mode" value="grayscale" checked><span>${t('Grayscale', 'Cinza')}</span></label><label><input type="radio" name="scanner-mode" value="threshold"><span>${t('Black & white (Otsu)', 'Preto e branco (Otsu)')}</span></label></fieldset>
      <p class="field-help">${t('The crop is a deterministic bilinear four-corner correction. It does not guess page edges; set the percentages to the visible corners. Output is capped at 24 MP.', 'O recorte é uma correção bilinear determinística de quatro cantos. Ele não adivinha as bordas; ajuste as porcentagens aos cantos visíveis. A saída é limitada a 24 MP.')}</p>`,
    buttons: `<button class="button button-primary" type="submit">${t('Correct and clean', 'Corrigir e limpar')}</button><button class="button button-secondary" type="button" disabled data-download>${t('Download scan', 'Baixar digitalização')}</button>`,
    output: `<canvas data-canvas role="img" aria-label="${t('Perspective-corrected document', 'Documento com perspectiva corrigida')}" style="display:block;max-width:100%;height:auto"></canvas>`,
    empty: { en: 'Coordinates are explicit, so the same image and settings always produce the same crop. Automatic edge detection is not claimed.', pt: 'As coordenadas são explícitas; a mesma imagem e configurações sempre produzem o mesmo recorte. Detecção automática de bordas não é alegada.' }
  });
  const status = root.querySelector('[data-status]'); let output = null; let filename = '';
  root.querySelector('[data-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); output = null; const file = root.querySelector('[data-file]').files[0];
    try { await readLimited(file, IMAGE_INPUT_LIMIT, t('Select a document image no larger than 64 MiB.', 'Selecione uma imagem de documento de no máximo 64 MiB.')); const bitmap = await decodeBitmap(file, t); try { const sourceSize = calculateContainedSize(bitmap.width, bitmap.height, 4200); const sourceCanvas = makeCanvas(sourceSize.width, sourceSize.height); const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true }); sourceContext.drawImage(bitmap, 0, 0, sourceSize.width, sourceSize.height); const points = ['tl', 'tr', 'br', 'bl'].map((name) => ({ x: clamp(Number(root.querySelector(`[data-${name}-x]`).value), 0, 100) / 100 * (sourceSize.width - 1), y: clamp(Number(root.querySelector(`[data-${name}-y]`).value), 0, 100) / 100 * (sourceSize.height - 1) }));
        const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y); let width = Math.round(Math.max(distance(points[0], points[1]), distance(points[3], points[2]))); let height = Math.round(Math.max(distance(points[0], points[3]), distance(points[1], points[2]))); if (width < 32 || height < 32) throw new Error(t('The selected corner quadrilateral is too small.', 'O quadrilátero selecionado é pequeno demais.')); const resize = calculateContainedSize(width, height, Math.sqrt(24_000_000), Math.sqrt(24_000_000)); width = resize.width; height = resize.height;
        const source = sourceContext.getImageData(0, 0, sourceSize.width, sourceSize.height); const warped = warpQuadrilateralRgba(source.data, sourceSize.width, sourceSize.height, points, width, height); const canvas = root.querySelector('[data-canvas]'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); let finalData = warped; const mode = root.querySelector('input[name="scanner-mode"]:checked').value; if (mode === 'threshold') finalData = thresholdRgba(warped).data; else if (mode === 'grayscale') { finalData = new Uint8ClampedArray(warped); for (let index = 0; index < finalData.length; index += 4) { const value = luma(finalData[index], finalData[index + 1], finalData[index + 2]); finalData[index] = value; finalData[index + 1] = value; finalData[index + 2] = value; } } context.putImageData(new ImageData(finalData, width, height), 0, 0); output = await canvasBlob(canvas, 'image/png'); filename = `${safeStem(file.name, 'document')}.scan.png`; root.querySelector('[data-download]').disabled = false; renderMetrics(root, [[t('Source', 'Origem'), `${bitmap.width} × ${bitmap.height}`], [t('Output', 'Saída'), `${width} × ${height}`], [t('Mode', 'Modo'), mode], [t('PNG', 'PNG'), formatBytes(output.size)]]); showOutput(root); setStatus(status, t('Perspective correction and cleanup complete.', 'Correção de perspectiva e limpeza concluídas.'), 'success');
      } finally { bitmap.close(); } } catch (error) { setStatus(status, error.message, 'error'); }
  });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, filename); });
  function release() { output = null; root.querySelector('[data-download]').disabled = true; const canvas = root.querySelector('[data-canvas]'); canvas.width = 1; canvas.height = 1; }
  bindRelease(root, release, root.querySelector('[data-file]')); return release;
}

function mountPanorama({ root, t }) {
  const id = 'panorama-stitcher';
  shell(root, t, {
    id, controls: { en: 'Stitch a horizontal sequence', pt: 'Unir uma sequência horizontal' }, badge: { en: 'Overlap matching', pt: 'Correspondência de sobreposição' }, results: { en: 'Stitched panorama', pt: 'Panorama unido' },
    fields: `${field(`${id}-files`, t('Photos, left to right', 'Fotos, da esquerda para a direita'), '<input class="file-input" id="%%ID%%" type="file" accept="image/*" multiple required data-files>')}<div class="field-grid"><label><span class="field-label">${t('Minimum overlap', 'Sobreposição mínima')}</span><input type="range" min="5" max="35" step="1" value="10" data-min><output data-min-out>10%</output></label><label><span class="field-label">${t('Maximum overlap', 'Sobreposição máxima')}</span><input type="range" min="25" max="80" step="1" value="65" data-max><output data-max-out>65%</output></label></div>
      <p class="field-help">${t('2–8 photos, listed left-to-right. This local matcher searches horizontal translation after normalizing height and feathers the seam. It does not correct rotation, parallax, lens distortion, or moving subjects.', '2–8 fotos, listadas da esquerda para a direita. Este comparador local procura translação horizontal após normalizar a altura e suaviza a emenda. Não corrige rotação, paralaxe, distorção de lente nem assuntos em movimento.')}</p>`,
    buttons: `<button class="button button-primary" type="submit">${t('Match and stitch', 'Comparar e unir')}</button><button class="button button-secondary" type="button" disabled data-download>${t('Download panorama', 'Baixar panorama')}</button>`,
    output: `<canvas data-canvas role="img" aria-label="${t('Stitched horizontal panorama', 'Panorama horizontal unido')}" style="display:block;max-width:100%;height:auto"></canvas><pre class="code-output" data-report></pre>`,
    empty: { en: 'The output is only marked complete after real overlap scoring and pixel blending. Inspect every seam at full size.', pt: 'A saída só é marcada como concluída após pontuação real de sobreposição e mistura de pixels. Inspecione cada emenda em tamanho real.' }
  });
  for (const name of ['min', 'max']) root.querySelector(`[data-${name}]`).addEventListener('input', (event) => { root.querySelector(`[data-${name}-out]`).value = `${event.target.value}%`; });
  const status = root.querySelector('[data-status]'); let output = null;
  root.querySelector('[data-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); output = null; const files = [...root.querySelector('[data-files]').files]; if (files.length < 2 || files.length > 8 || files.some((file) => file.size > IMAGE_INPUT_LIMIT)) { setStatus(status, t('Choose 2–8 images, each no larger than 64 MiB.', 'Escolha de 2 a 8 imagens, cada uma com no máximo 64 MiB.'), 'error'); return; }
    const bitmaps = []; const progress = root.querySelector('[data-progress]'); progress.hidden = false; progress.max = files.length + 1; progress.value = 0;
    try { for (const file of files) { bitmaps.push(await decodeBitmap(file, t)); assertAggregateBitmapBudget(bitmaps, 256 * 1024 * 1024, t); progress.value += 1; } const targetHeight = Math.min(1800, ...bitmaps.map((bitmap) => bitmap.height)); const predictedRasterBytes = bitmaps.reduce((sum, bitmap) => sum + Math.max(1, Math.round(bitmap.width * targetHeight / bitmap.height)) * targetHeight * 4, 0); if (predictedRasterBytes > 384 * 1024 * 1024) throw new Error(t('Normalized panorama rasters would exceed the 384 MiB working-memory limit.', 'Os rasters normalizados do panorama excederiam o limite de 384 MiB de memória.')); const rasters = bitmaps.map((bitmap) => { const width = Math.max(1, Math.round(bitmap.width * targetHeight / bitmap.height)); const canvas = makeCanvas(width, targetHeight); const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(bitmap, 0, 0, width, targetHeight); return { data: context.getImageData(0, 0, width, targetHeight).data, width }; }); let combined = { data: rasters[0].data, width: rasters[0].width, height: targetHeight }; const matches = []; const minimum = Number(root.querySelector('[data-min]').value) / 100; const maximum = Number(root.querySelector('[data-max]').value) / 100; if (minimum >= maximum) throw new Error(t('Minimum overlap must be below maximum overlap.', 'A sobreposição mínima deve ser menor que a máxima.'));
      for (let index = 1; index < rasters.length; index += 1) { const match = findHorizontalOverlap(combined.data, combined.width, rasters[index].data, rasters[index].width, targetHeight, { minFraction: minimum, maxFraction: maximum }); matches.push({ pair: `${index}→${index + 1}`, overlap: match.overlap, score: round(match.score, 2) }); combined = blendHorizontalImages(combined.data, combined.width, rasters[index].data, rasters[index].width, targetHeight, match.overlap); if (combined.width * combined.height > 40_000_000) throw new Error(t('The stitched panorama would exceed the 40-megapixel output limit.', 'O panorama unido excederia o limite de saída de 40 megapixels.')); }
      const canvas = root.querySelector('[data-canvas]'); canvas.width = combined.width; canvas.height = targetHeight; canvas.getContext('2d').putImageData(new ImageData(combined.data, combined.width, targetHeight), 0, 0); output = await canvasBlob(canvas, 'image/jpeg', 0.92); root.querySelector('[data-report]').textContent = JSON.stringify(matches, null, 2); renderMetrics(root, [[t('Photos', 'Fotos'), files.length], [t('Seams', 'Emendas'), matches.length], [t('Output', 'Saída'), `${canvas.width} × ${canvas.height}`], [t('JPEG', 'JPEG'), formatBytes(output.size)]]); root.querySelector('[data-download]').disabled = false; showOutput(root); progress.value += 1; setStatus(status, t('Horizontal matching and feathered stitching complete. Review seams for parallax errors.', 'Correspondência horizontal e união suavizada concluídas. Revise as emendas para erros de paralaxe.'), 'success');
    } catch (error) { setStatus(status, error.message, 'error'); } finally { progress.hidden = true; bitmaps.forEach((bitmap) => bitmap.close()); }
  });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, 'stitched-panorama.jpg'); });
  function release() { output = null; root.querySelector('[data-download]').disabled = true; root.querySelector('[data-report]').textContent = ''; const canvas = root.querySelector('[data-canvas]'); canvas.width = 1; canvas.height = 1; }
  bindRelease(root, release, root.querySelector('[data-files]')); return release;
}

function mountHdr({ root, t }) {
  const id = 'hdr-merger';
  shell(root, t, {
    id, controls: { en: 'Merge an exposure bracket', pt: 'Mesclar uma sequência de exposição' }, badge: { en: 'Weighted tone map', pt: 'Mapeamento tonal ponderado' }, results: { en: 'Tone-mapped image', pt: 'Imagem com tons mapeados' },
    fields: `${field(`${id}-files`, t('Exposure stack, dark to bright', 'Pilha de exposição, escura para clara'), '<input class="file-input" id="%%ID%%" type="file" accept="image/*" multiple required data-files>')}<label class="field-label" for="${id}-spacing">${t('EV spacing between files', 'Intervalo EV entre arquivos')}</label><input class="number-input" id="${id}-spacing" type="number" min="0.1" max="4" step="0.1" value="1" data-spacing>
      <p class="field-help">${t('2–7 pre-aligned images. Frames are normalized to the first image, merged using midtone weights and exposure compensation, then Reinhard tone-mapped. No ghost removal or automatic alignment is performed.', '2–7 imagens pré-alinhadas. Os quadros são normalizados para a primeira imagem, mesclados com pesos de meios-tons e compensação de exposição e mapeados por Reinhard. Não há remoção de fantasmas nem alinhamento automático.')}</p>`,
    buttons: `<button class="button button-primary" type="submit">${t('Merge and tone-map', 'Mesclar e mapear tons')}</button><button class="button button-secondary" type="button" disabled data-download>${t('Download HDR result', 'Baixar resultado HDR')}</button>`,
    output: `<canvas data-canvas role="img" aria-label="${t('Tone-mapped HDR result', 'Resultado HDR com tons mapeados')}" style="display:block;max-width:100%;height:auto"></canvas>`,
    empty: { en: 'The result is a display-referred PNG, not a radiance-map OpenEXR. Use a tripod and a stationary scene for useful output.', pt: 'O resultado é um PNG para exibição, não um mapa de radiância OpenEXR. Use tripé e uma cena estática para um resultado útil.' }
  });
  const status = root.querySelector('[data-status]'); let output = null;
  root.querySelector('[data-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); output = null; const files = [...root.querySelector('[data-files]').files]; if (files.length < 2 || files.length > 7) { setStatus(status, t('Choose 2–7 exposure images.', 'Escolha de 2 a 7 imagens de exposição.'), 'error'); return; } const bitmaps = [];
    try { for (const file of files) { if (file.size > IMAGE_INPUT_LIMIT) throw new Error(t('Every exposure must be 64 MiB or smaller.', 'Cada exposição deve ter no máximo 64 MiB.')); bitmaps.push(await decodeBitmap(file, t)); assertAggregateBitmapBudget(bitmaps, 256 * 1024 * 1024, t); } const first = bitmaps[0]; const size = calculateContainedSize(first.width, first.height, 3000); if (size.width * size.height * files.length * 4 > 256 * 1024 * 1024) throw new Error(t('Normalized exposure frames exceed the 256 MiB working-memory limit.', 'Os quadros de exposição normalizados excedem o limite de 256 MiB de memória.')); const frames = bitmaps.map((bitmap) => { const canvas = makeCanvas(size.width, size.height); const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(bitmap, 0, 0, size.width, size.height); return context.getImageData(0, 0, size.width, size.height).data; }); const spacing = Number(root.querySelector('[data-spacing]').value); const midpoint = (frames.length - 1) / 2; const evs = frames.map((_, index) => (index - midpoint) * spacing); const merged = mergeExposureStack(frames, evs); const canvas = root.querySelector('[data-canvas]'); canvas.width = size.width; canvas.height = size.height; canvas.getContext('2d').putImageData(new ImageData(merged, size.width, size.height), 0, 0); output = await canvasBlob(canvas, 'image/png'); root.querySelector('[data-download]').disabled = false; renderMetrics(root, [[t('Exposures', 'Exposições'), files.length], [t('EV range', 'Faixa EV'), `${round(evs[0], 1)} → +${round(evs.at(-1), 1)}`], [t('Output', 'Saída'), `${size.width} × ${size.height}`], [t('PNG', 'PNG'), formatBytes(output.size)]]); showOutput(root); setStatus(status, t('Exposure-weighted tone map complete. Inspect for movement/registration artifacts.', 'Mapeamento tonal ponderado por exposição concluído. Inspecione artefatos de movimento/alinhamento.'), 'success'); } catch (error) { setStatus(status, error.message, 'error'); } finally { bitmaps.forEach((bitmap) => bitmap.close()); }
  });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, 'tone-mapped-hdr.png'); });
  function release() { output = null; root.querySelector('[data-download]').disabled = true; const canvas = root.querySelector('[data-canvas]'); canvas.width = 1; canvas.height = 1; }
  bindRelease(root, release, root.querySelector('[data-files]')); return release;
}

function mountPixelEditor({ root, t }) {
  const id = 'pixel-texture-editor';
  shell(root, t, {
    id, controls: { en: 'Build a layered raster', pt: 'Criar um raster em camadas' }, badge: { en: 'Canvas editor', pt: 'Editor em canvas' }, results: { en: 'Editable canvas', pt: 'Canvas editável' },
    fields: `${field(`${id}-files`, t('Initial image layers', 'Camadas de imagem iniciais'), '<input class="file-input" id="%%ID%%" type="file" accept="image/*" multiple data-files>')}
      <div class="field-grid"><label><span class="field-label">${t('Edit target', 'Alvo da edição')}</span><select data-target><option value="pixels">${t('Layer pixels', 'Pixels da camada')}</option><option value="mask">${t('Layer mask', 'Máscara da camada')}</option></select></label><label><span class="field-label">${t('Mask brush', 'Pincel da máscara')}</span><select disabled data-mask-action><option value="hide">${t('Hide pixels', 'Ocultar pixels')}</option><option value="reveal">${t('Reveal pixels', 'Revelar pixels')}</option></select></label><label><span class="field-label">${t('Brush color', 'Cor do pincel')}</span><input type="color" value="#b7ff39" data-color></label><label><span class="field-label">${t('Brush size', 'Tamanho do pincel')}</span><input type="range" min="1" max="120" value="16" data-size><output data-size-out>16 px</output></label><label><span class="field-label">${t('Layer opacity', 'Opacidade da camada')}</span><input type="range" min="0" max="1" step="0.01" value="1" data-opacity><output data-opacity-out>100%</output></label><label><span class="field-label">${t('Blend mode', 'Modo de mistura')}</span><select data-blend><option value="source-over">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="overlay">Overlay</option><option value="difference">Difference</option></select></label><label><span class="field-label">${t('Destructive filter', 'Filtro destrutivo')}</span><select data-filter><option value="grayscale">${t('Grayscale', 'Cinza')}</option><option value="invert">${t('Invert', 'Inverter')}</option><option value="blur">${t('Soft blur', 'Desfoque suave')}</option></select></label></div>
      <p class="field-help">${t('Up to 12 raster layers on a canvas no larger than 4096 px / 24 MP. Each layer can allocate an editable reveal/hide mask. Brush, mask, reset-mask, and filter changes use a 24-step, 64 MiB tile history; an operation larger than that explicit history budget still runs but clears history and reports it. Layer pixels/masks remain under a separate 256 MiB canvas budget. Vector shapes, PSD, and GPU effects remain unsupported.', 'Até 12 camadas raster em um canvas de no máximo 4096 px / 24 MP. Cada camada pode alocar uma máscara editável de revelar/ocultar. Alterações de pincel, máscara, redefinição de máscara e filtro usam histórico em blocos de 24 etapas / 64 MiB; uma operação maior que esse limite explícito ainda é executada, mas limpa o histórico e informa isso. Pixels/máscaras das camadas usam um limite separado de 256 MiB para canvases. Formas vetoriais, PSD e efeitos GPU continuam sem suporte.')}</p>`,
    buttons: `<button class="button button-primary" type="submit">${t('Load layers', 'Carregar camadas')}</button><button class="button button-secondary" type="button" data-new>${t('New paint layer', 'Nova camada de pintura')}</button><button class="button button-secondary" type="button" disabled data-undo>${t('Undo', 'Desfazer')}</button><button class="button button-secondary" type="button" disabled data-redo>${t('Redo', 'Refazer')}</button><button class="button button-secondary" type="button" disabled data-reset-mask>${t('Create / reset selected mask', 'Criar / redefinir máscara selecionada')}</button><button class="button button-secondary" type="button" disabled data-apply-filter>${t('Apply filter', 'Aplicar filtro')}</button><button class="button button-secondary" type="button" disabled data-export>${t('Export PNG', 'Exportar PNG')}</button>`,
    output: `<canvas data-canvas role="img" aria-label="${t('Layered pixel editor canvas', 'Canvas do editor de pixels em camadas')}" style="display:block;max-width:100%;height:auto;touch-action:none;border:1px solid currentColor"></canvas><h3>${t('Layers (top first)', 'Camadas (superior primeiro)')}</h3><ul class="download-list" data-layers></ul>`,
    empty: { en: 'Load images or create a blank paint layer. Draw on pixels or switch to the selected layer mask; export composites visible, masked layers into a fresh PNG.', pt: 'Carregue imagens ou crie uma camada de pintura vazia. Desenhe nos pixels ou alterne para a máscara da camada selecionada; a exportação combina as camadas visíveis e mascaradas em um novo PNG.' }
  });
  const HISTORY_LIMIT = 24; const HISTORY_BYTES = 64 * 1024 * 1024; const RASTER_BYTES = 256 * 1024 * 1024; const status = root.querySelector('[data-status]'); const canvas = root.querySelector('[data-canvas]'); const display = canvas.getContext('2d'); const scratch = makeCanvas(1, 1); let layers = []; let active = -1; let output = null; let drawing = false; let previous = null; let strokeEntry = null; let layerSerial = 0; let undoStack = []; let redoStack = []; let historyBytes = 0;
  root.querySelector('[data-size]').addEventListener('input', (event) => { root.querySelector('[data-size-out]').value = `${event.target.value} px`; });
  root.querySelector('[data-opacity]').addEventListener('input', (event) => { root.querySelector('[data-opacity-out]').value = `${Math.round(event.target.value * 100)}%`; if (layers[active]) { layers[active].opacity = Number(event.target.value); composite(); renderLayerList(); } });
  root.querySelector('[data-blend]').addEventListener('change', (event) => { if (layers[active]) { layers[active].blend = event.target.value; composite(); renderLayerList(); } });
  root.querySelector('[data-target]').addEventListener('change', updateTargetControls);
  root.querySelector('[data-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); const files = [...root.querySelector('[data-files]').files]; if (!files.length) { addBlankLayer(); return; } if (files.length > 12 || files.some((file) => file.size > IMAGE_INPUT_LIMIT)) { setStatus(status, t('Choose at most 12 images, each no larger than 64 MiB.', 'Escolha no máximo 12 imagens, cada uma com até 64 MiB.'), 'error'); return; }
    release(); const bitmaps = [];
    try { for (const file of files) { bitmaps.push({ file, bitmap: await decodeBitmap(file, t) }); assertAggregateBitmapBudget(bitmaps, 256 * 1024 * 1024, t); } const first = bitmaps[0].bitmap; const pixelsPerCanvas = Math.min(24_000_000, Math.floor(256 * 1024 * 1024 / (4 * (files.length + 2)))); const size = fitPixelBudget(first.width, first.height, 4096, pixelsPerCanvas); canvas.width = size.width; canvas.height = size.height;
      scratch.width = size.width; scratch.height = size.height; for (const { file, bitmap } of bitmaps) { const layerCanvas = makeCanvas(size.width, size.height); const dimensions = calculateContainedSize(bitmap.width, bitmap.height, size.width, size.height); layerCanvas.getContext('2d').drawImage(bitmap, Math.round((size.width - dimensions.width) / 2), Math.round((size.height - dimensions.height) / 2), dimensions.width, dimensions.height); layers.push({ id: ++layerSerial, name: file.name, canvas: layerCanvas, mask: null, visible: true, opacity: 1, blend: 'source-over' }); }
      active = layers.length - 1; composite(); renderLayerList(); enableEditor(); renderMetrics(root, [[t('Canvas', 'Canvas'), `${size.width} × ${size.height}`], [t('Layers', 'Camadas'), layers.length], [t('Selected', 'Selecionada'), layers[active].name], [t('Uploads', 'Uploads'), '0 B']]); showOutput(root); setStatus(status, t('Layers loaded. Draw directly on the selected layer.', 'Camadas carregadas. Desenhe diretamente na camada selecionada.'), 'success');
    } catch (error) { release(); setStatus(status, error.message, 'error'); } finally { bitmaps.forEach(({ bitmap }) => bitmap.close()); }
  });
  function enableEditor() { root.querySelector('[data-apply-filter]').disabled = !layers.length; root.querySelector('[data-export]').disabled = !layers.length; updateTargetControls(); updateHistoryButtons(); }
  function rasterAllocation(extraLayers = 0, extraMasks = 0) { if (!canvas.width || !canvas.height) return 0; return canvas.width * canvas.height * 4 * (layers.length + extraLayers + layers.filter((layer) => layer.mask).length + extraMasks + 2); }
  function addBlankLayer() { if (layers.length >= 12) { setStatus(status, t('The 12-layer limit has been reached.', 'O limite de 12 camadas foi atingido.'), 'error'); return; } if (!canvas.width || canvas.width === 300 && canvas.height === 150 && !layers.length) { canvas.width = 1024; canvas.height = 1024; scratch.width = 1024; scratch.height = 1024; } if (rasterAllocation(1) > RASTER_BYTES) { setStatus(status, t('Another full-size layer would exceed the 256 MiB editor canvas limit.', 'Outra camada em tamanho integral excederia o limite de 256 MiB dos canvases do editor.'), 'error'); return; } layers.push({ id: ++layerSerial, name: `${t('Paint layer', 'Camada de pintura')} ${layers.length + 1}`, canvas: makeCanvas(canvas.width, canvas.height), mask: null, visible: true, opacity: 1, blend: 'source-over' }); active = layers.length - 1; composite(); renderLayerList(); enableEditor(); renderMetrics(root, [[t('Canvas', 'Canvas'), `${canvas.width} × ${canvas.height}`], [t('Layers', 'Camadas'), layers.length], [t('Selected', 'Selecionada'), layers[active].name], [t('Uploads', 'Uploads'), '0 B']]); showOutput(root); setStatus(status, t('Blank paint layer added.', 'Camada de pintura vazia adicionada.'), 'success'); }
  root.querySelector('[data-new]').addEventListener('click', addBlankLayer);
  function ensureMask(layer) { if (layer.mask) return layer.mask; if (rasterAllocation(0, 1) > RASTER_BYTES) throw new Error(t('A full-size mask would exceed the 256 MiB editor canvas limit.', 'Uma máscara em tamanho integral excederia o limite de 256 MiB dos canvases do editor.')); layer.mask = makeCanvas(canvas.width, canvas.height); const context = layer.mask.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); renderLayerList(); updateTargetControls(); return layer.mask; }
  function composite() { display.clearRect(0, 0, canvas.width, canvas.height); const scratchContext = scratch.getContext('2d'); for (const layer of layers) { if (!layer.visible) continue; let source = layer.canvas; if (layer.mask) { scratchContext.globalCompositeOperation = 'source-over'; scratchContext.globalAlpha = 1; scratchContext.clearRect(0, 0, scratch.width, scratch.height); scratchContext.drawImage(layer.canvas, 0, 0); scratchContext.globalCompositeOperation = 'destination-in'; scratchContext.drawImage(layer.mask, 0, 0); scratchContext.globalCompositeOperation = 'source-over'; source = scratch; } display.save(); display.globalAlpha = layer.opacity; display.globalCompositeOperation = layer.blend; display.drawImage(source, 0, 0); display.restore(); } }
  function selectLayer(index) { active = clamp(index, 0, layers.length - 1); const layer = layers[active]; root.querySelector('[data-opacity]').value = layer.opacity; root.querySelector('[data-opacity-out]').value = `${Math.round(layer.opacity * 100)}%`; root.querySelector('[data-blend]').value = layer.blend; renderLayerList(); }
  function renderLayerList() { const list = root.querySelector('[data-layers]'); list.replaceChildren(); [...layers].reverse().forEach((layer, reverseIndex) => { const index = layers.length - 1 - reverseIndex; const row = document.createElement('li'); const text = document.createElement('span'); text.textContent = `${index === active ? '● ' : ''}${layer.name} · ${Math.round(layer.opacity * 100)}% · ${layer.blend}${layer.mask ? ` · ${t('mask', 'máscara')}` : ''}`; const actions = document.createElement('div'); const select = document.createElement('button'); select.type = 'button'; select.className = 'text-button'; select.dataset.selectLayer = String(index); select.textContent = t('Select', 'Selecionar'); select.setAttribute('aria-pressed', String(index === active)); const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'text-button'; toggle.dataset.toggleLayer = String(index); toggle.textContent = layer.visible ? t('Hide', 'Ocultar') : t('Show', 'Mostrar'); const up = document.createElement('button'); up.type = 'button'; up.className = 'text-button'; up.dataset.moveLayer = String(index); up.dataset.direction = 'up'; up.textContent = t('Raise', 'Subir'); up.disabled = index === layers.length - 1; const down = document.createElement('button'); down.type = 'button'; down.className = 'text-button'; down.dataset.moveLayer = String(index); down.dataset.direction = 'down'; down.textContent = t('Lower', 'Descer'); down.disabled = index === 0; actions.append(select, toggle, up, down); row.append(text, actions); list.append(row); }); updateTargetControls(); }
  root.querySelector('[data-layers]').addEventListener('click', (event) => { const select = event.target.closest('[data-select-layer]'); const toggle = event.target.closest('[data-toggle-layer]'); const move = event.target.closest('[data-move-layer]'); if (select) selectLayer(Number(select.dataset.selectLayer)); if (toggle) { const layer = layers[Number(toggle.dataset.toggleLayer)]; layer.visible = !layer.visible; composite(); renderLayerList(); } if (move) { const from = Number(move.dataset.moveLayer); const to = from + (move.dataset.direction === 'up' ? 1 : -1); if (to >= 0 && to < layers.length) { [layers[from], layers[to]] = [layers[to], layers[from]]; if (active === from) active = to; else if (active === to) active = from; composite(); renderLayerList(); } } });
  function updateTargetControls() { const maskTarget = root.querySelector('[data-target]').value === 'mask'; root.querySelector('[data-mask-action]').disabled = !maskTarget || !layers[active]; root.querySelector('[data-color]').disabled = maskTarget; root.querySelector('[data-reset-mask]').disabled = !maskTarget || !layers[active]; }
  function updateHistoryButtons() { root.querySelector('[data-undo]').disabled = !undoStack.length; root.querySelector('[data-redo]').disabled = !redoStack.length; }
  function resetHistory() { undoStack = []; redoStack = []; historyBytes = 0; updateHistoryButtons(); }
  function startTileEntry(layer, target, label) { return { layerId: layer.id, target, label, before: new Map(), after: [], bytes: 0, overflow: false }; }
  function targetCanvas(layer, target) { return target === 'mask' ? ensureMask(layer) : layer.canvas; }
  function captureBefore(entry, target, bounds) { if (entry.overflow) return; const context = target.getContext('2d', { willReadFrequently: true }); for (const region of computeTileRegions(canvas.width, canvas.height, bounds)) { if (entry.before.has(region.key)) continue; const bytes = region.width * region.height * 4; if (entry.bytes + bytes * 2 > HISTORY_BYTES) { entry.overflow = true; entry.before.clear(); entry.bytes = 0; return; } entry.before.set(region.key, { ...region, data: context.getImageData(region.x, region.y, region.width, region.height) }); entry.bytes += bytes * 2; } }
  function finishTileEntry(entry) { if (!entry) return false; if (entry.overflow) { resetHistory(); return false; } const layer = layers.find((item) => item.id === entry.layerId); if (!layer || !entry.before.size) return false; const target = targetCanvas(layer, entry.target); const context = target.getContext('2d', { willReadFrequently: true }); entry.after = [...entry.before.values()].map((patch) => ({ x: patch.x, y: patch.y, width: patch.width, height: patch.height, key: patch.key, data: context.getImageData(patch.x, patch.y, patch.width, patch.height) })); const discarded = redoStack.reduce((sum, item) => sum + item.bytes, 0); historyBytes -= discarded; redoStack = []; undoStack.push(entry); historyBytes += entry.bytes; while (undoStack.length > HISTORY_LIMIT || historyBytes > HISTORY_BYTES) { const removed = undoStack.shift(); historyBytes -= removed.bytes; } updateHistoryButtons(); return true; }
  function applyHistory(entry, direction) { const layer = layers.find((item) => item.id === entry.layerId); if (!layer) return false; const target = targetCanvas(layer, entry.target); const context = target.getContext('2d'); for (const patch of entry[direction]) context.putImageData(patch.data, patch.x, patch.y); composite(); renderLayerList(); return true; }
  function undo() { const entry = undoStack.pop(); if (!entry) return; if (applyHistory(entry, 'before')) { redoStack.push(entry); setStatus(status, t(`Undid ${entry.label}.`, `Desfeito: ${entry.label}.`), 'success'); } updateHistoryButtons(); }
  function redo() { const entry = redoStack.pop(); if (!entry) return; if (applyHistory(entry, 'after')) { undoStack.push(entry); setStatus(status, t(`Redid ${entry.label}.`, `Refeito: ${entry.label}.`), 'success'); } updateHistoryButtons(); }
  root.querySelector('[data-undo]').addEventListener('click', undo); root.querySelector('[data-redo]').addEventListener('click', redo);
  function point(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }; }
  canvas.addEventListener('pointerdown', (event) => { const layer = layers[active]; if (!layer) return; const target = root.querySelector('[data-target]').value; try { targetCanvas(layer, target); } catch (error) { setStatus(status, error.message, 'error'); return; } drawing = true; previous = point(event); strokeEntry = startTileEntry(layer, target, target === 'mask' ? t('mask stroke', 'traço de máscara') : t('brush stroke', 'traço de pincel')); canvas.setPointerCapture(event.pointerId); event.preventDefault(); });
  canvas.addEventListener('pointermove', (event) => { if (!drawing || !strokeEntry) return; const layer = layers.find((item) => item.id === strokeEntry.layerId); if (!layer) return; const current = point(event); const target = targetCanvas(layer, strokeEntry.target); const context = target.getContext('2d'); const lineWidth = Number(root.querySelector('[data-size]').value) * (event.pressure > 0 ? 0.35 + event.pressure * 0.65 : 1); const radius = lineWidth / 2 + 2; captureBefore(strokeEntry, target, { x0: Math.min(previous.x, current.x) - radius, y0: Math.min(previous.y, current.y) - radius, x1: Math.max(previous.x, current.x) + radius, y1: Math.max(previous.y, current.y) + radius }); context.save(); context.lineWidth = lineWidth; context.lineCap = 'round'; context.lineJoin = 'round'; if (strokeEntry.target === 'mask') { const reveal = root.querySelector('[data-mask-action]').value === 'reveal'; context.globalCompositeOperation = reveal ? 'source-over' : 'destination-out'; context.strokeStyle = '#fff'; } else { context.globalCompositeOperation = 'source-over'; context.strokeStyle = root.querySelector('[data-color]').value; } context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(current.x, current.y); context.stroke(); context.restore(); previous = current; composite(); event.preventDefault(); });
  const stopDrawing = () => { if (!drawing) return; const recorded = finishTileEntry(strokeEntry); const overflow = strokeEntry?.overflow; drawing = false; previous = null; strokeEntry = null; if (overflow) setStatus(status, t('Stroke exceeded the 64 MiB history budget; it was applied, and earlier history was cleared.', 'O traço excedeu o limite de 64 MiB do histórico; ele foi aplicado e o histórico anterior foi limpo.'), 'warning'); else if (recorded) setStatus(status, t('Stroke recorded in bounded history.', 'Traço registrado no histórico limitado.'), 'success'); }; canvas.addEventListener('pointerup', stopDrawing); canvas.addEventListener('pointercancel', stopDrawing);
  root.querySelector('[data-reset-mask]').addEventListener('click', () => { const layer = layers[active]; if (!layer) return; const existed = Boolean(layer.mask); let mask; try { mask = ensureMask(layer); } catch (error) { setStatus(status, error.message, 'error'); return; } if (!existed) { composite(); setStatus(status, t('A full-size white mask was created for the selected layer. Paint with Hide or Reveal to edit it.', 'Uma máscara branca em tamanho integral foi criada para a camada selecionada. Pinte com Ocultar ou Revelar para editá-la.'), 'success'); return; } const entry = startTileEntry(layer, 'mask', t('mask reset', 'redefinição de máscara')); captureBefore(entry, mask, { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height }); const context = mask.getContext('2d'); context.globalCompositeOperation = 'source-over'; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); const recorded = finishTileEntry(entry); composite(); setStatus(status, recorded ? t('Selected layer mask reset; undo is available.', 'Máscara da camada selecionada redefinida; é possível desfazer.') : t('Mask reset exceeded the history budget; the reset was applied and history cleared.', 'A redefinição da máscara excedeu o limite do histórico; ela foi aplicada e o histórico foi limpo.'), recorded ? 'success' : 'warning'); });
  root.querySelector('[data-apply-filter]').addEventListener('click', () => { const layer = layers[active]; if (!layer) return; const context = layer.canvas.getContext('2d', { willReadFrequently: true }); const filter = root.querySelector('[data-filter]').value; const entry = startTileEntry(layer, 'pixels', `${filter} ${t('filter', 'filtro')}`); captureBefore(entry, layer.canvas, { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height }); if (filter === 'blur') { const scratchContext = scratch.getContext('2d'); scratchContext.globalCompositeOperation = 'source-over'; scratchContext.clearRect(0, 0, scratch.width, scratch.height); scratchContext.drawImage(layer.canvas, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height); context.filter = 'blur(3px)'; context.drawImage(scratch, 0, 0); context.filter = 'none'; } else { const image = context.getImageData(0, 0, canvas.width, canvas.height); for (let index = 0; index < image.data.length; index += 4) { if (filter === 'grayscale') { const value = luma(image.data[index], image.data[index + 1], image.data[index + 2]); image.data[index] = value; image.data[index + 1] = value; image.data[index + 2] = value; } else { image.data[index] = 255 - image.data[index]; image.data[index + 1] = 255 - image.data[index + 1]; image.data[index + 2] = 255 - image.data[index + 2]; } } context.putImageData(image, 0, 0); } const recorded = finishTileEntry(entry); composite(); setStatus(status, recorded ? t(`Applied ${filter}; undo is available.`, `${filter} aplicado; é possível desfazer.`) : t(`Applied ${filter}, but the full-canvas change exceeded the history budget and cleared history.`, `${filter} aplicado, mas a alteração de canvas completo excedeu o limite do histórico e limpou o histórico.`), recorded ? 'success' : 'warning'); });
  root.querySelector('[data-export]').addEventListener('click', async () => { composite(); output = await canvasBlob(canvas, 'image/png'); downloadBlob(output, 'layered-pixel-art.png'); setStatus(status, t('Fresh composite PNG created and downloaded.', 'Novo PNG composto criado e baixado.'), 'success'); });
  function release() { layers = []; active = -1; output = null; drawing = false; previous = null; strokeEntry = null; canvas.width = 1; canvas.height = 1; scratch.width = 1; scratch.height = 1; root.querySelector('[data-layers]').replaceChildren(); root.querySelector('[data-apply-filter]').disabled = true; root.querySelector('[data-export]').disabled = true; resetHistory(); updateTargetControls(); }
  bindRelease(root, release, root.querySelector('[data-files]')); return release;
}

function mountVideoPlayer({ root, t }) {
  const id = 'offline-video-player';
  shell(root, t, {
    id, controls: { en: 'Open video without upload', pt: 'Abrir vídeo sem upload' }, badge: { en: 'Blob fast path + FFmpeg fallback', pt: 'Blob rápido + fallback FFmpeg' }, results: { en: 'Local playback', pt: 'Reprodução local' },
    fields: `${field(`${id}-file`, t('Video file', 'Arquivo de vídeo'), '<input class="file-input" id="%%ID%%" type="file" accept="video/*,.mkv,.m4v,.avi,.mov,.mts,.m2ts" required data-file>')}${field(`${id}-subtitles`, t('Optional WebVTT or SRT subtitles', 'Legendas WebVTT ou SRT opcionais'), '<input class="file-input" id="%%ID%%" type="file" accept="text/vtt,.vtt,.srt,application/x-subrip" data-subtitles>')}<div class="field-grid"><label><span class="field-label">${t('Playback path', 'Caminho de reprodução')}</span><select data-engine><option value="auto">${t('Auto · native then FFmpeg', 'Automático · nativo e depois FFmpeg')}</option><option value="native">${t('Native Blob only', 'Somente Blob nativo')}</option><option value="ffmpeg">${t('Force FFmpeg compatibility', 'Forçar compatibilidade FFmpeg')}</option></select></label><label><span class="field-label">${t('FFmpeg compatibility format', 'Formato de compatibilidade FFmpeg')}</span><select data-format><option value="mp4">MP4 · H.264 / AAC</option><option value="webm">WebM · VP9 / Opus</option></select></label><label><span class="field-label">${t('Audio stream index', 'Índice da faixa de áudio')}</span><input class="number-input" type="number" min="0" max="31" step="1" value="0" data-audio-index></label><label><span class="field-label">${t('Playback speed', 'Velocidade de reprodução')}</span><select data-speed><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label></div>
      <p class="field-help">${t('Auto first uses a zero-copy Blob URL, preserving the fast path for browser-supported media up to 1 GiB. If decoding fails—or a non-default audio index cannot be selected through the browser audioTracks API—it lazily loads local FFmpeg, accepts at most 192 MiB / 10 minutes, maps the requested audio stream, and creates browser-compatible MP4 or WebM with a 256 MiB output cap. That fallback discards container metadata, chapters, embedded subtitles, attachments, extra tracks, and HDR signaling; an optional external VTT/SRT track is reapplied. Nothing is uploaded.', 'O modo automático primeiro usa uma URL Blob sem cópia, preservando o caminho rápido para mídia aceita pelo navegador de até 1 GiB. Se a decodificação falhar — ou se um índice de áudio não padrão não puder ser selecionado pela API audioTracks — ele carrega localmente o FFmpeg sob demanda, aceita no máximo 192 MiB / 10 minutos, mapeia a faixa de áudio solicitada e cria MP4 ou WebM compatível com limite de saída de 256 MiB. Esse fallback descarta metadados do contêiner, capítulos, legendas incorporadas, anexos, faixas extras e sinalização HDR; uma faixa VTT/SRT externa opcional é reaplicada. Nada é enviado.')}</p>`,
    buttons: `<button class="button button-primary" type="submit">${t('Open locally', 'Abrir localmente')}</button><button class="button button-secondary" type="button" disabled data-cancel>${t('Cancel fallback', 'Cancelar fallback')}</button><button class="button button-secondary" type="button" disabled data-frame>${t('Capture current frame', 'Capturar quadro atual')}</button>`,
    output: `<video controls playsinline preload="metadata" data-video style="display:block;width:100%;max-height:70vh;background:#000"></video><pre class="code-output" data-info></pre>`,
    empty: { en: 'Native playback retains the original file. FFmpeg compatibility is used only when selected or when Auto encounters a real decoder/audio-selection failure.', pt: 'A reprodução nativa mantém o arquivo original. A compatibilidade FFmpeg só é usada quando selecionada ou quando o modo Automático encontra uma falha real de decodificação/seleção de áudio.' }
  });
  const video = root.querySelector('[data-video]'); const status = root.querySelector('[data-status]'); const submit = root.querySelector('[data-form] button[type="submit"]'); const urls = new Set(); const ffmpegLog = []; let frame = null; let frameName = ''; let controller = null; let ffmpeg = null; let userCanceled = false;
  root.querySelector('[data-speed]').addEventListener('change', (event) => { video.playbackRate = Number(event.target.value); });
  function clearMedia() { video.pause(); video.removeAttribute('src'); video.querySelectorAll('track').forEach((track) => track.remove()); video.load(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); frame = null; root.querySelector('[data-frame]').disabled = true; root.querySelector('[data-info]').textContent = ''; }
  async function addSubtitles() { try { const subtitles = root.querySelector('[data-subtitles]').files[0]; if (!subtitles) return 0; if (subtitles.size > 4 * 1024 * 1024) throw new Error(t('Subtitle files are limited to 4 MiB.', 'Arquivos de legenda são limitados a 4 MiB.')); const text = await subtitles.text(); const vtt = /^WEBVTT/.test(text.trimStart()) ? text : srtToVtt(text); const cueCount = /^WEBVTT/.test(text.trimStart()) ? (text.match(/-->/g) || []).length : parseSrt(text).length; if (!cueCount) throw new Error(t('No valid WebVTT/SRT cues were found.', 'Nenhuma legenda WebVTT/SRT válida foi encontrada.')); const trackUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })); urls.add(trackUrl); const track = document.createElement('track'); track.kind = 'subtitles'; track.label = subtitles.name; track.srclang = root.dataset.language === 'pt-BR' ? 'pt' : 'en'; track.default = true; track.src = trackUrl; video.append(track); return cueCount; } catch (error) { error.code = 'SUBTITLE_INVALID'; throw error; } }
  async function openPlaybackBlob(blob, audioIndex, requireSelection) { const url = URL.createObjectURL(blob); urls.add(url); video.src = url; await waitForVideoMetadata(video, t); video.playbackRate = Number(root.querySelector('[data-speed]').value); const tracks = video.audioTracks; if (tracks) { if (audioIndex >= tracks.length && audioIndex > 0) throw new Error(t(`Native playback exposes only ${tracks.length} audio tracks.`, `A reprodução nativa expõe apenas ${tracks.length} faixas de áudio.`)); for (let index = 0; index < tracks.length; index += 1) tracks[index].enabled = index === Math.min(audioIndex, tracks.length - 1); } else if (requireSelection && audioIndex > 0) { const error = new Error(t('This browser does not expose audioTracks, so it cannot select a non-default stream natively.', 'Este navegador não expõe audioTracks e não pode selecionar nativamente uma faixa não padrão.')); error.code = 'AUDIO_SELECTION_UNAVAILABLE'; throw error; } return tracks?.length ?? null; }
  root.querySelector('[data-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); if (controller) return; clearMedia(); const file = root.querySelector('[data-file]').files[0]; if (!file || file.size > VIDEO_INPUT_LIMIT) { setStatus(status, t('Select one video no larger than 1 GiB.', 'Selecione um vídeo de no máximo 1 GiB.'), 'error'); return; } const header = new Uint8Array(await file.slice(0, 64).arrayBuffer()); const sourceContainer = detectMediaContainer(header); const requestedEngine = root.querySelector('[data-engine]').value; const audioIndex = Number(root.querySelector('[data-audio-index]').value); if (!Number.isInteger(audioIndex) || audioIndex < 0 || audioIndex > 31) { setStatus(status, t('Audio stream index must be an integer from 0 through 31.', 'O índice da faixa de áudio deve ser um inteiro de 0 a 31.'), 'error'); return; } submit.disabled = true; let nativeFailure = null; let result = null;
    try {
      if (requestedEngine !== 'ffmpeg') {
        try { const audioTracks = await openPlaybackBlob(file, audioIndex, true); const cueCount = await addSubtitles(); root.querySelector('[data-info]').textContent = JSON.stringify({ file: file.name, container: sourceContainer, declaredType: file.type || null, playbackEngine: 'Native Blob URL', durationSeconds: round(video.duration, 3), dimensions: `${video.videoWidth} × ${video.videoHeight}`, subtitleCues: cueCount, requestedAudioStream: audioIndex, audioTracks: audioTracks ?? t('API unavailable; default stream retained', 'API indisponível; faixa padrão mantida') }, null, 2); renderMetrics(root, [[t('Container', 'Contêiner'), sourceContainer], [t('Duration', 'Duração'), `${round(video.duration, 2)} s`], [t('Video', 'Vídeo'), `${video.videoWidth} × ${video.videoHeight}`], [t('Path', 'Caminho'), 'Blob URL']]); root.querySelector('[data-frame]').disabled = false; showOutput(root); setStatus(status, t('Video opened through the zero-copy native Blob path.', 'Vídeo aberto pelo caminho Blob nativo sem cópia.'), 'success'); return; }
        catch (error) { if (error.code === 'SUBTITLE_INVALID') throw error; nativeFailure = error; clearMedia(); if (requestedEngine === 'native') throw error; }
      }
      if (file.size > 192 * 1024 * 1024) throw new Error(t(`Native playback failed (${nativeFailure?.message || 'forced fallback'}), and FFmpeg fallback is limited to 192 MiB.`, `A reprodução nativa falhou (${nativeFailure?.message || 'fallback forçado'}) e o fallback FFmpeg é limitado a 192 MiB.`));
      controller = new AbortController(); userCanceled = false; root.querySelector('[data-cancel]').disabled = false; const progress = root.querySelector('[data-progress]'); progress.hidden = false; progress.max = 1; progress.value = 0; setStatus(status, t('Loading local FFmpeg and creating a compatibility stream…', 'Carregando o FFmpeg local e criando uma mídia compatível…'));
      let module; try { module = await import('/vendor/ffmpeg/ffmpeg/index.js'); } catch (_) { throw new Error(t('The local FFmpeg wrapper could not be loaded.', 'O wrapper local do FFmpeg não pôde ser carregado.')); } ffmpegLog.length = 0; ffmpeg = new module.FFmpeg(); ffmpeg.on('progress', ({ progress: value }) => { if (Number.isFinite(value)) progress.value = clamp(value, 0, 1); }); ffmpeg.on('log', ({ message }) => { if (message) { ffmpegLog.push(String(message)); if (ffmpegLog.length > 40) ffmpegLog.shift(); } }); await ffmpeg.load({ coreURL: '/vendor/ffmpeg/core/ffmpeg-core.js', wasmURL: '/vendor/ffmpeg/core/ffmpeg-core.wasm' }, { signal: controller.signal }); result = await transcodeVideoWithFfmpeg(ffmpeg, file, { maxEdge: 1920, fps: 30, videoBitsPerSecond: 4_000_000, format: root.querySelector('[data-format]').value, audioStreamIndex: audioIndex, signal: controller.signal, t, diagnostics: () => ffmpegLog.slice(-8), onProgress: (value) => { progress.value = value; } }); ffmpeg.terminate(); ffmpeg = null; controller = null; root.querySelector('[data-cancel]').disabled = true; progress.hidden = true;
      const audioTracks = await openPlaybackBlob(result.blob, 0, false); const cueCount = await addSubtitles(); root.querySelector('[data-info]').textContent = JSON.stringify({ file: file.name, container: sourceContainer, declaredType: file.type || null, playbackEngine: 'FFmpeg WASM compatibility', nativeFailure: nativeFailure?.message || null, sourceCodecs: result.sourceCodecs, compatibilityMime: result.mime, compatibilityBytes: result.blob.size, durationSeconds: round(video.duration, 3), dimensions: `${video.videoWidth} × ${video.videoHeight}`, subtitleCues: cueCount, requestedAudioStream: audioIndex, audioIncluded: result.audioIncluded, exposedOutputAudioTracks: audioTracks }, null, 2); renderMetrics(root, [[t('Source', 'Origem'), sourceContainer], [t('Compatibility', 'Compatibilidade'), result.mime], [t('Video', 'Vídeo'), `${video.videoWidth} × ${video.videoHeight}`], [t('Output', 'Saída'), formatBytes(result.blob.size)]]); root.querySelector('[data-frame]').disabled = false; showOutput(root); setStatus(status, result.audioIncluded ? t(`FFmpeg compatibility playback is ready with audio stream ${audioIndex}.`, `A reprodução compatível por FFmpeg está pronta com a faixa de áudio ${audioIndex}.`) : t('FFmpeg compatibility playback is ready without an audio stream.', 'A reprodução compatível por FFmpeg está pronta sem faixa de áudio.'), result.audioIncluded ? 'success' : 'warning');
    } catch (error) { const canceled = userCanceled || error.name === 'AbortError'; clearMedia(); setStatus(status, canceled ? t('FFmpeg fallback canceled; partial media discarded.', 'Fallback FFmpeg cancelado; mídia parcial descartada.') : error.message, canceled ? 'warning' : 'error'); }
    finally { controller = null; userCanceled = false; ffmpeg?.terminate(); ffmpeg = null; submit.disabled = false; root.querySelector('[data-cancel]').disabled = true; const progress = root.querySelector('[data-progress]'); progress.hidden = true; }
  });
  root.querySelector('[data-cancel]').addEventListener('click', () => { if (!controller) return; userCanceled = true; controller.abort(); ffmpeg?.terminate(); ffmpeg = null; });
  root.querySelector('[data-frame]').addEventListener('click', async () => { if (!video.videoWidth) return; const canvas = makeCanvas(video.videoWidth, video.videoHeight); canvas.getContext('2d').drawImage(video, 0, 0); frame = await canvasBlob(canvas, 'image/png'); frameName = `video-frame-${Math.round(video.currentTime * 1000)}ms.png`; downloadBlob(frame, frameName); setStatus(status, t('Current decoded frame captured as PNG.', 'Quadro decodificado atual capturado como PNG.'), 'success'); });
  function release() { controller?.abort(); controller = null; ffmpeg?.terminate(); ffmpeg = null; clearMedia(); }
  bindRelease(root, release, root.querySelector('[data-file]')); return release;
}

function mountVideoRecorder({ root, t }, compressor) {
  const id = compressor ? 'video-compressor' : 'video-converter';
  shell(root, t, {
    id, controls: { en: compressor ? 'Compress a video locally' : 'Convert a video locally', pt: compressor ? 'Comprimir um vídeo localmente' : 'Converter um vídeo localmente' }, badge: { en: 'FFmpeg WASM / native fallback', pt: 'FFmpeg WASM / fallback nativo' }, results: { en: compressor ? 'Compressed video' : 'Converted video', pt: compressor ? 'Vídeo comprimido' : 'Vídeo convertido' },
    fields: `${field(`${id}-file`, t('Source video', 'Vídeo de origem'), '<input class="file-input" id="%%ID%%" type="file" accept="video/*,.mkv,.avi,.mov" required data-file>')}${compressor ? `<label class="field-label" for="${id}-preset">${t('Preset', 'Predefinição')}</label><select id="${id}-preset" data-preset><option value="small">${t('Small · 720p · 1 Mbps', 'Pequeno · 720p · 1 Mbps')}</option><option value="balanced" selected>${t('Balanced · 1080p · 2.5 Mbps', 'Equilibrado · 1080p · 2,5 Mbps')}</option><option value="quality">${t('Quality · 1440p · 6 Mbps', 'Qualidade · 1440p · 6 Mbps')}</option></select>` : ''}
      <div class="field-grid"><label><span class="field-label">${t('Engine', 'Motor')}</span><select data-engine><option value="ffmpeg">FFmpeg WASM</option><option value="recorder">${t('MediaRecorder streaming fallback', 'Fallback MediaRecorder em streaming')}</option></select></label><label><span class="field-label">${t('Output', 'Saída')}</span><select data-format><option value="webm">WebM · VP9 / Opus</option><option value="mp4">MP4 · H.264 / AAC</option></select></label><label><span class="field-label">${t('Maximum edge', 'Maior lado')}</span><input class="number-input" type="number" min="160" max="2560" step="16" value="1920" data-edge></label><label><span class="field-label">${t('Video bitrate', 'Bitrate de vídeo')}</span><input class="number-input" type="number" min="200" max="12000" step="100" value="${compressor ? 2500 : 5000}" data-bitrate><output>kbps</output></label><label><span class="field-label">FPS</span><input class="number-input" type="number" min="10" max="60" value="30" data-fps></label></div>
      <div class="notice-card"><strong>${t('Two honest local paths', 'Dois caminhos locais transparentes')}</strong><p>${t('FFmpeg lazily loads a ~31 MiB core from this site, copies at most 192 MiB into WASM memory, accepts many containers/codecs, processes up to 10 minutes, and writes WebM VP9/Opus or MP4 H.264/AAC (first video/audio tracks only; 256 MiB output cap). MediaRecorder streams browser-decodable video for up to 2 minutes / 1 GiB without a large in-memory copy, but can only output supported WebM and may omit audio when captureStream exposes none. Neither path preserves metadata, chapters, extra tracks, subtitles, HDR signaling, or attachments.', 'O FFmpeg carrega sob demanda um core de ~31 MiB deste site, copia no máximo 192 MiB para a memória WASM, aceita diversos contêineres/codecs, processa até 10 minutos e grava WebM VP9/Opus ou MP4 H.264/AAC (apenas primeiras faixas de vídeo/áudio; saída limitada a 256 MiB). MediaRecorder transmite vídeos decodificáveis pelo navegador por até 2 minutos / 1 GiB sem grande cópia em memória, mas só gera WebM compatível e pode omitir áudio quando captureStream não o expõe. Nenhum caminho preserva metadados, capítulos, faixas extras, legendas, sinalização HDR ou anexos.')}</p></div>`,
    buttons: `<button class="button button-primary" type="submit">${compressor ? t('Compress locally', 'Comprimir localmente') : t('Convert locally', 'Converter localmente')}</button><button class="button button-secondary" type="button" disabled data-cancel>${t('Cancel', 'Cancelar')}</button><button class="button button-secondary" type="button" disabled data-download>${t('Download output', 'Baixar saída')}</button>`,
    output: `<video controls playsinline data-preview-video style="display:block;width:100%;max-height:70vh;background:#000"></video><pre class="code-output" data-report></pre>`,
    empty: { en: 'The output button appears only after the selected engine produces and reads back a non-empty media file. FFmpeg exit codes and missing codecs are treated as errors.', pt: 'O botão de saída só aparece após o motor selecionado produzir e reler um arquivo de mídia não vazio. Códigos de saída e codecs ausentes no FFmpeg são tratados como erros.' }
  });
  const status = root.querySelector('[data-status]'); const preview = root.querySelector('[data-preview-video]'); const submit = root.querySelector('[data-form] button[type="submit"]'); const urls = new Set(); const ffmpegLog = []; let output = null; let controller = null; let filename = ''; let ffmpeg = null; let activeEngine = ''; let userCanceled = false;
  if (compressor) root.querySelector('[data-preset]').addEventListener('change', (event) => { const presets = { small: [1280, 1000, 24], balanced: [1920, 2500, 30], quality: [2560, 6000, 30] }; const [edge, bitrate, fps] = presets[event.target.value]; root.querySelector('[data-edge]').value = edge; root.querySelector('[data-bitrate]').value = bitrate; root.querySelector('[data-fps]').value = fps; });
  root.querySelector('[data-engine]').addEventListener('change', (event) => { const recorder = event.target.value === 'recorder'; if (recorder) root.querySelector('[data-format]').value = 'webm'; root.querySelector('[data-format]').disabled = recorder; });
  root.querySelector('[data-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); if (controller) return; releaseOutput(); const file = root.querySelector('[data-file]').files[0]; activeEngine = root.querySelector('[data-engine]').value; const maximumInput = activeEngine === 'ffmpeg' ? 192 * 1024 * 1024 : VIDEO_INPUT_LIMIT; if (!file || file.size > maximumInput) { setStatus(status, t(`Select one source video no larger than ${formatBytes(maximumInput)} for the selected engine.`, `Selecione um vídeo de origem de no máximo ${formatBytes(maximumInput)} para o motor selecionado.`), 'error'); return; }
    const maxEdge = clamp(Number(root.querySelector('[data-edge]').value), 160, 2560); const fps = clamp(Number(root.querySelector('[data-fps]').value), 10, 60); const videoBitsPerSecond = clamp(Number(root.querySelector('[data-bitrate]').value), 200, 12000) * 1000; const format = root.querySelector('[data-format]').value; let mime = '';
    if (activeEngine === 'recorder') { if (typeof MediaRecorder !== 'function' || typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream || typeof MediaStream !== 'function') { setStatus(status, t('This browser lacks MediaRecorder, MediaStream, or canvas.captureStream.', 'Este navegador não possui MediaRecorder, MediaStream ou canvas.captureStream.'), 'error'); return; } mime = selectSupportedRecorderMime((value) => MediaRecorder.isTypeSupported(value)); if (!mime) { setStatus(status, t('MediaRecorder exposes no supported WebM video encoder.', 'O MediaRecorder não expõe nenhum codificador WebM compatível.'), 'error'); return; } }
    controller = new AbortController(); userCanceled = false; submit.disabled = true; root.querySelector('[data-cancel]').disabled = false; const progress = root.querySelector('[data-progress]'); progress.hidden = false; progress.max = 1; progress.value = 0; setStatus(status, activeEngine === 'ffmpeg' ? t('Loading FFmpeg and preparing the in-memory filesystem…', 'Carregando o FFmpeg e preparando o sistema de arquivos em memória…') : t('Decoding and recording in real time. Keep this tab active…', 'Decodificando e gravando em tempo real. Mantenha esta aba ativa…'));
    try { let result;
      if (activeEngine === 'ffmpeg') { ffmpegLog.length = 0; if (!ffmpeg?.loaded) { let module; try { module = await import('/vendor/ffmpeg/ffmpeg/index.js'); } catch (_) { throw new Error(t('The local FFmpeg wrapper could not be loaded. Rebuild vendor assets or choose MediaRecorder.', 'O wrapper local do FFmpeg não pôde ser carregado. Reconstrua os assets de vendor ou escolha MediaRecorder.')); } ffmpeg = new module.FFmpeg(); ffmpeg.on('progress', ({ progress: value }) => { if (Number.isFinite(value)) progress.value = clamp(value, 0, 1); }); ffmpeg.on('log', ({ message }) => { if (message) { ffmpegLog.push(String(message)); if (ffmpegLog.length > 40) ffmpegLog.shift(); } }); await ffmpeg.load({ coreURL: '/vendor/ffmpeg/core/ffmpeg-core.js', wasmURL: '/vendor/ffmpeg/core/ffmpeg-core.wasm' }, { signal: controller.signal }); }
        result = await transcodeVideoWithFfmpeg(ffmpeg, file, { maxEdge, fps, videoBitsPerSecond, format, signal: controller.signal, t, diagnostics: () => ffmpegLog.slice(-8), onProgress: (value) => { progress.value = value; } });
      } else result = await recordVideoLocally(file, { maxEdge, fps, videoBitsPerSecond, mime, signal: controller.signal, t, onProgress: (value) => { progress.value = value; } });
      output = result.blob; filename = `${safeStem(file.name, 'video')}.${compressor ? 'compressed' : 'converted'}.${result.extension || 'webm'}`; const url = URL.createObjectURL(output); urls.add(url); preview.src = url; const estimate = Number.isFinite(result.duration) ? estimateVideoOutputSize(result.duration, videoBitsPerSecond, result.audioIncluded ? 128_000 : 0) : null; root.querySelector('[data-report]').textContent = JSON.stringify({ engine: result.engine, mime: result.mime, sourceContainer: result.sourceContainer || null, sourceCodecs: result.sourceCodecs || null, durationSeconds: Number.isFinite(result.duration) ? round(result.duration, 3) : null, durationKnown: result.durationKnown !== false, dimensions: `${result.width} × ${result.height}`, audioIncluded: result.audioIncluded, actualBytes: output.size, bitrateEstimateBytes: estimate }, null, 2); renderMetrics(root, [[t('Output', 'Saída'), `${result.width} × ${result.height}`], [t('Engine', 'Motor'), result.engine], [t('Size', 'Tamanho'), formatBytes(output.size)], [t('Source ratio', 'Proporção da origem'), `${round(output.size / file.size, 3)}×`]]); root.querySelector('[data-download]').disabled = false; showOutput(root); const unknownDuration = result.durationKnown === false; setStatus(status, unknownDuration ? t(`${result.engine} encoding complete, but the source omitted a finite duration. FFmpeg hard-capped output at 10 minutes; verify that it was not truncated.`, `Codificação por ${result.engine} concluída, mas a origem não informou duração finita. O FFmpeg limitou a saída a 10 minutos; verifique se ela não foi truncada.`) : result.audioIncluded ? t(`${result.engine} encoding complete with the first audio track.`, `Codificação por ${result.engine} concluída com a primeira faixa de áudio.`) : t(`${result.engine} encoding complete without an audio track.`, `Codificação por ${result.engine} concluída sem faixa de áudio.`), unknownDuration || !result.audioIncluded ? 'warning' : 'success'); }
    catch (error) { const canceled = userCanceled || error.name === 'AbortError'; setStatus(status, canceled ? t('Conversion canceled; partial output discarded.', 'Conversão cancelada; saída parcial descartada.') : error.message, canceled ? 'warning' : 'error'); } finally { controller = null; userCanceled = false; submit.disabled = false; root.querySelector('[data-cancel]').disabled = true; progress.hidden = true; }
  });
  root.querySelector('[data-cancel]').addEventListener('click', () => { if (!controller) return; userCanceled = true; controller.abort(); if (activeEngine === 'ffmpeg') { ffmpeg?.terminate(); ffmpeg = null; } });
  root.querySelector('[data-download]').addEventListener('click', () => { if (output) downloadBlob(output, filename); });
  function releaseOutput() { output = null; controller?.abort(); controller = null; preview.pause(); preview.removeAttribute('src'); preview.load(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); root.querySelector('[data-report]').textContent = ''; root.querySelector('[data-download]').disabled = true; }
  bindRelease(root, releaseOutput, root.querySelector('[data-file]')); return () => { releaseOutput(); ffmpeg?.terminate(); ffmpeg = null; };
}

function waitForVideoMetadata(video, t) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && Number.isFinite(video.duration)) { resolve(); return; }
    let settled = false; const finish = (error) => { if (settled) return; settled = true; clearTimeout(timeout); video.removeEventListener('loadedmetadata', ready); video.removeEventListener('error', failed); error ? reject(error) : resolve(); }; const ready = () => Number.isFinite(video.duration) && video.duration > 0 ? finish() : finish(new Error(t('The browser reported an invalid or streaming-only duration.', 'O navegador informou uma duração inválida ou somente de streaming.'))); const failed = () => finish(new Error(t('The browser cannot decode this container/codec combination.', 'O navegador não consegue decodificar esta combinação de contêiner/codec.'))); const timeout = setTimeout(() => finish(new Error(t('Reading local video metadata timed out.', 'A leitura dos metadados locais do vídeo excedeu o tempo.'))), 12_000); video.addEventListener('loadedmetadata', ready); video.addEventListener('error', failed);
  });
}

async function transcodeVideoWithFfmpeg(ffmpeg, file, options) {
  const { maxEdge, fps, videoBitsPerSecond, format, signal, t, onProgress, diagnostics, audioStreamIndex = 0 } = options; const sourceExtension = file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1].toLowerCase() || 'bin'; const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`; const inputName = `input-${token}.${sourceExtension}`; const probeName = `probe-${token}.json`; const plan = buildFfmpegTranscodePlan({ inputName, format, maxEdge, fps, videoBitsPerSecond, audioStreamIndex }); const outputName = `${token}-${plan.outputName}`; plan.args[plan.args.length - 1] = outputName; const cleanup = async () => { for (const name of [inputName, probeName, outputName]) await ffmpeg.deleteFile(name).catch(() => {}); }; const diagnosticSuffix = () => { const lines = diagnostics?.().filter(Boolean) || []; return lines.length ? ` ${t('FFmpeg log', 'Log do FFmpeg')}: ${lines.join(' | ')}` : ''; };
  try {
    onProgress(0); const input = new Uint8Array(await file.arrayBuffer()); if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); await ffmpeg.writeFile(inputName, input, { signal });
    const probeExit = await ffmpeg.ffprobe(['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_name,codec_type,width,height,duration,duration_ts,time_base', '-of', 'json', inputName, '-o', probeName], 60_000, { signal });
    let probe;
    try { probe = JSON.parse(await ffmpeg.readFile(probeName, 'utf8', { signal })); }
    catch (_) { throw new Error(t(`FFprobe returned no readable JSON metadata (reported exit ${probeExit}).`, `O FFprobe não retornou metadados JSON legíveis (código informado ${probeExit}).`) + diagnosticSuffix()); }
    const duration = deriveProbeDuration(probe); const durationKnown = Number.isFinite(duration); if (durationKnown && duration > 600) throw new Error(t('FFmpeg WASM runs are limited to 10 minutes.', 'Execuções do FFmpeg WASM são limitadas a 10 minutos.'));
    const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video'); if (!videoStream?.width || !videoStream?.height) throw new Error(t('FFprobe found no decodable video stream.', 'O FFprobe não encontrou uma faixa de vídeo decodificável.')); const audioStreams = probe.streams.filter((stream) => stream.codec_type === 'audio'); if (audioStreamIndex > 0 && audioStreamIndex >= audioStreams.length) throw new Error(t(`Requested audio stream ${audioStreamIndex}, but the source exposes ${audioStreams.length}.`, `A faixa de áudio ${audioStreamIndex} foi solicitada, mas a origem expõe ${audioStreams.length}.`)); const audioIncluded = audioStreams.length > audioStreamIndex; const size = calculateContainedSize(videoStream.width, videoStream.height, plan.maxEdge); if (size.width % 2) size.width -= 1; if (size.height % 2) size.height -= 1;
    const exitCode = await ffmpeg.exec(plan.args, 15 * 60_000, { signal }); if (exitCode !== 0) throw new Error(t(`FFmpeg could not decode or encode this codec combination (exit ${exitCode}). Try the other output format; MediaRecorder only helps when the browser itself can decode the input.`, `O FFmpeg não conseguiu decodificar ou codificar esta combinação de codecs (código ${exitCode}). Tente o outro formato; MediaRecorder só ajuda quando o próprio navegador decodifica a entrada.`) + diagnosticSuffix());
    const bytes = await ffmpeg.readFile(outputName, 'binary', { signal }); if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error(t('FFmpeg produced an empty output.', 'O FFmpeg produziu uma saída vazia.')); if (bytes.byteLength > 256 * 1024 * 1024) throw new Error(t('FFmpeg output exceeds the 256 MiB retained-output limit and was discarded.', 'A saída do FFmpeg excede o limite retido de 256 MiB e foi descartada.')); onProgress(1);
    return { blob: new Blob([bytes], { type: plan.mime }), mime: plan.mime, extension: plan.extension, width: size.width, height: size.height, duration, durationKnown, audioIncluded, audioStreamIndex, engine: 'FFmpeg WASM', sourceContainer: probe.format.format_name, sourceCodecs: probe.streams.map((stream) => `${stream.codec_type}:${stream.codec_name}`).join(', ') };
  } finally { await cleanup(); }
}

async function recordVideoLocally(file, options) {
  const { maxEdge, fps, videoBitsPerSecond, mime, signal, t, onProgress } = options; const sourceUrl = URL.createObjectURL(file); const video = document.createElement('video'); video.playsInline = true; video.muted = true; video.preload = 'metadata'; video.src = sourceUrl; let recorder = null; let frameRequest = 0; let canvasStream = null; let sourceStream = null;
  const cleanup = () => { if (frameRequest) { if (typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameRequest); else cancelAnimationFrame(frameRequest); } video.pause(); video.removeAttribute('src'); video.load(); canvasStream?.getTracks().forEach((track) => track.stop()); sourceStream?.getTracks().forEach((track) => track.stop()); URL.revokeObjectURL(sourceUrl); };
  try {
    await waitForVideoMetadata(video, t); if (video.duration > VIDEO_TRANSCODE_LIMIT_SECONDS) throw new Error(t('Real-time conversion is limited to 2 minutes per run.', 'A conversão em tempo real é limitada a 2 minutos por execução.')); if (!video.videoWidth || !video.videoHeight) throw new Error(t('No decodable video track was found.', 'Nenhuma faixa de vídeo decodificável foi encontrada.')); const dimensions = calculateContainedSize(video.videoWidth, video.videoHeight, maxEdge); if (dimensions.width % 2) dimensions.width -= 1; if (dimensions.height % 2) dimensions.height -= 1; const canvas = makeCanvas(dimensions.width, dimensions.height); const context = canvas.getContext('2d'); canvasStream = canvas.captureStream(fps); sourceStream = typeof video.captureStream === 'function' ? video.captureStream() : null; const audioTracks = sourceStream ? sourceStream.getAudioTracks() : []; const stream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]); const chunks = []; recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond, audioBitsPerSecond: 128_000 }); recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); }); const stopped = new Promise((resolve, reject) => { recorder.addEventListener('stop', resolve, { once: true }); recorder.addEventListener('error', () => reject(recorder.error || new Error('MediaRecorder failed.')), { once: true }); }); let endedResolve; let endedReject; const ended = new Promise((resolve, reject) => { endedResolve = resolve; endedReject = reject; }); const abort = () => { const error = new DOMException('Aborted', 'AbortError'); endedReject(error); if (recorder?.state !== 'inactive') recorder.stop(); }; if (signal.aborted) abort(); signal.addEventListener('abort', abort, { once: true }); video.addEventListener('ended', endedResolve, { once: true }); video.addEventListener('error', () => endedReject(new Error(t('Video decoding failed during conversion.', 'A decodificação do vídeo falhou durante a conversão.'))), { once: true });
    const draw = () => { if (video.ended || signal.aborted) return; context.drawImage(video, 0, 0, dimensions.width, dimensions.height); onProgress(clamp(video.currentTime / video.duration, 0, 1)); frameRequest = typeof video.requestVideoFrameCallback === 'function' ? video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw); };
    context.drawImage(video, 0, 0, dimensions.width, dimensions.height); recorder.start(1000); try { await video.play(); } catch (_) { throw new Error(t('Playback permission was denied, so real-time conversion could not start.', 'A permissão de reprodução foi negada; a conversão em tempo real não pôde começar.')); } draw(); await ended; if (recorder.state !== 'inactive') recorder.stop(); await stopped; signal.removeEventListener('abort', abort); const blob = new Blob(chunks, { type: recorder.mimeType || mime }); if (!blob.size) throw new Error(t('MediaRecorder produced an empty output.', 'O MediaRecorder produziu uma saída vazia.')); return { blob, mime: blob.type, extension: 'webm', width: dimensions.width, height: dimensions.height, duration: video.duration, audioIncluded: audioTracks.length > 0, engine: 'MediaRecorder' };
  } finally { if (recorder?.state !== 'inactive') recorder.stop(); cleanup(); }
}
