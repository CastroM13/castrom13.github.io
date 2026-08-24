import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import encodeAvif, { init as initAvifEncoder } from '@jsquash/avif/encode.js';
import decodeAvif, { init as initAvifDecoder } from '@jsquash/avif/decode.js';
import {
  analyzeSvgMarkup,
  blendHorizontalImages,
  buildFfmpegTranscodePlan,
  buildSearchablePdf,
  calculateContainedSize,
  computeTileRegions,
  detectImageFormat,
  detectMediaContainer,
  deriveProbeDuration,
  encodeBmpRgba,
  estimateVideoOutputSize,
  extractEmbeddedJpeg,
  findHorizontalOverlap,
  flattenTesseractBlocks,
  insertJpegComment,
  inspectImageBytes,
  imageQualityMetrics,
  mergeExposureStack,
  normalizeMetadataForJson,
  optimizeSvgMarkup,
  otsuThreshold,
  parseJpegSegments,
  parseSrt,
  processPngMetadata,
  rawRgbToRgba,
  rewriteJpegDescription,
  selectSupportedRecorderMime,
  srtToVtt,
  stripJpegMetadata,
  thresholdRgba,
  toolKeys,
  transformSvgMarkup,
  warpQuadrilateralRgba
} from '../assets/tools/suite/media-foundation.js';

const text = new TextEncoder();
const decode = (input) => new TextDecoder('latin1').decode(input);

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function segment(marker, payload) {
  const length = payload.length + 2;
  return concat(Uint8Array.of(0xff, marker, length >>> 8, length & 0xff), payload);
}

function sampleJpeg() {
  const app1 = segment(0xe1, concat(text.encode('Exif\0\0'), Uint8Array.of(1, 2, 3, 4)));
  const comment = segment(0xfe, text.encode('old comment'));
  const sof = segment(0xc0, Uint8Array.of(8, 0, 2, 0, 3, 3, 1, 0x11, 0));
  const scanHeader = segment(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0));
  return concat(Uint8Array.of(0xff, 0xd8), app1, comment, sof, scanHeader, Uint8Array.of(12, 34, 56, 0xff, 0xd9));
}

function pngChunk(type, payload) {
  const output = new Uint8Array(payload.length + 12);
  new DataView(output.buffer).setUint32(0, payload.length);
  output.set(text.encode(type), 4);
  output.set(payload, 8);
  return output;
}

function samplePng() {
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer); view.setUint32(0, 2); view.setUint32(4, 3); ihdr.set([8, 6, 0, 0, 0], 8);
  return concat(signature, pngChunk('IHDR', ihdr), pngChunk('tEXt', text.encode('Author\0Private')), pngChunk('IEND', new Uint8Array()));
}

function grayRow(values) {
  const output = new Uint8Array(values.length * 4);
  values.forEach((value, index) => output.set([value, value, value, 255], index * 4));
  return output;
}

test('exports all thirteen canonical media keys in order', () => {
  assert.deepEqual(toolKeys, [
    'universal-image-converter', 'image-compressor', 'raw-photo-processor', 'svg-studio',
    'image-metadata-workbench', 'ocr-studio', 'document-scanner', 'panorama-stitcher',
    'hdr-merger', 'pixel-texture-editor', 'offline-video-player', 'video-converter', 'video-compressor'
  ]);
  assert.equal(Object.isFrozen(toolKeys), true);
});

test('contained sizes preserve aspect ratio and do not upscale by default', () => {
  assert.deepEqual(calculateContainedSize(4000, 2000, 1000), { width: 1000, height: 500, scale: 0.25 });
  assert.deepEqual(calculateContainedSize(320, 200, 1000), { width: 320, height: 200, scale: 1 });
  assert.throws(() => calculateContainedSize(0, 20, 10), /positive/);
});

test('format and container sniffers use signatures rather than extensions', () => {
  assert.equal(detectImageFormat(sampleJpeg()), 'jpeg');
  assert.equal(detectImageFormat(samplePng()), 'png');
  assert.equal(detectImageFormat(text.encode('BMnot really decoded')), 'bmp');
  assert.equal(detectImageFormat(concat(new Uint8Array(4), text.encode('ftypavif'), new Uint8Array(8))), 'avif');
  assert.equal(detectMediaContainer(concat(new Uint8Array(4), text.encode('ftypisom'))), 'ISO BMFF / MP4');
  assert.equal(detectMediaContainer(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3)), 'Matroska / WebM');
});

test('site-hosted libavif WASM genuinely encodes and decodes AVIF pixels', async () => {
  const encoderWasm = await WebAssembly.compile(await readFile(fileURLToPath(new URL('../node_modules/@jsquash/avif/codec/enc/avif_enc.wasm', import.meta.url))));
  const decoderWasm = await WebAssembly.compile(await readFile(fileURLToPath(new URL('../node_modules/@jsquash/avif/codec/dec/avif_dec.wasm', import.meta.url))));
  await initAvifEncoder(encoderWasm); await initAvifDecoder(decoderWasm);
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const encoded = new Uint8Array(await encodeAvif({ data: rgba, width: 2, height: 2 }, { quality: 80, speed: 8 }));
  assert.equal(detectImageFormat(encoded), 'avif');
  assert.match(decode(encoded.subarray(4, 20)), /^ftypavif/);
  const decoded = await decodeAvif(encoded.buffer);
  assert.deepEqual([decoded.width, decoded.height, decoded.data.length], [2, 2, 16]);
});

test('baseline BMP encoder writes bottom-up BGR pixels and composites alpha', () => {
  const rgba = Uint8Array.of(255, 0, 0, 255, 0, 0, 255, 128, 0, 255, 0, 255, 255, 255, 255, 0);
  const bmp = encodeBmpRgba(rgba, 2, 2, { background: [255, 255, 255] });
  assert.equal(new TextDecoder('latin1').decode(bmp.subarray(0, 2)), 'BM');
  const view = new DataView(bmp.buffer); assert.equal(view.getUint32(2, true), 70); assert.equal(view.getUint32(10, true), 54); assert.equal(view.getInt32(18, true), 2); assert.equal(view.getInt32(22, true), 2); assert.equal(view.getUint16(28, true), 24);
  assert.deepEqual([...bmp.subarray(54, 60)], [0, 255, 0, 255, 255, 255]);
  assert.deepEqual([...bmp.subarray(62, 68)], [0, 0, 255, 255, 127, 127]);
  assert.equal(detectImageFormat(bmp), 'bmp');
  assert.throws(() => encodeBmpRgba(new Uint8Array(3), 1, 1), /does not match/);
});

test('image quality metrics report exact and known RGB error', () => {
  const reference = Uint8Array.of(10, 20, 30, 0, 40, 50, 60, 255);
  const exact = imageQualityMetrics(reference, reference);
  assert.equal(exact.rmse, 0); assert.equal(exact.psnr, Infinity); assert.equal(exact.mae, 0);
  const candidate = Uint8Array.of(20, 20, 30, 255, 40, 40, 60, 0);
  const changed = imageQualityMetrics(reference, candidate);
  assert.ok(Math.abs(changed.rmse - Math.sqrt(200 / 6)) < 1e-12); assert.equal(changed.mae, 20 / 6); assert.equal(changed.maximumError, 10);
  assert.throws(() => imageQualityMetrics(reference, new Uint8Array(4)), /equally sized/);
});

test('SVG optimizer removes executable surfaces and reports structure', () => {
  const unsafe = `<?xml version="1.0"?><svg viewBox="0 0 10 10" onclick="steal()"><!--x--><script>alert(1)</script><a href="https://bad.invalid"><path d="M0 0L1 1"/></a><circle cx="2" cy="2" r="1"/></svg>`;
  const safe = optimizeSvgMarkup(unsafe);
  assert.doesNotMatch(safe, /script|onclick|bad\.invalid|<!--/i);
  assert.match(safe, /^<svg/);
  assert.deepEqual(analyzeSvgMarkup(safe), { elements: 4, paths: 1, groups: 0, gradients: 0, viewBox: '0 0 10 10', bytes: text.encode(safe).length });
  const transformed = transformSvgMarkup(safe, { scale: 2, rotate: 30 });
  assert.match(transformed, /<g transform="translate\(0 0\) rotate\(30\) scale\(2\)">/);
});

test('JPEG parsing strips targeted metadata without touching scan bytes', () => {
  const jpeg = sampleJpeg();
  const before = inspectImageBytes(jpeg);
  assert.deepEqual([before.width, before.height], [3, 2]);
  assert.deepEqual(before.metadata.sort(), ['Comment', 'EXIF']);
  assert.ok(parseJpegSegments(jpeg).some((entry) => entry.scan));
  const stripped = stripJpegMetadata(jpeg);
  const after = inspectImageBytes(stripped);
  assert.deepEqual(after.metadata, []);
  assert.deepEqual([...stripped.slice(-5)], [12, 34, 56, 255, 217]);
  const edited = insertJpegComment(jpeg, 'new description');
  assert.deepEqual(inspectImageBytes(edited).metadata.sort(), ['Comment', 'EXIF']);
  assert.match(decode(edited), /new description/);
});

test('JPEG description editor writes genuine EXIF, IPTC, and XMP structures while preserving unrelated segments', () => {
  const jpeg = sampleJpeg();
  const exif = rewriteJpegDescription(jpeg, 'exif', 'EXIF description');
  assert.deepEqual(inspectImageBytes(exif).metadata.sort(), ['Comment', 'EXIF']);
  assert.ok(exif.some((byte, index) => byte === 0x0e && exif[index + 1] === 0x01 && exif[index + 2] === 0x02 && exif[index + 3] === 0x00));
  assert.match(decode(exif), /EXIF description/);

  const iptc = rewriteJpegDescription(jpeg, 'iptc', 'IPTC caption');
  assert.deepEqual(inspectImageBytes(iptc).metadata.sort(), ['Comment', 'EXIF', 'IPTC / Photoshop']);
  assert.ok(iptc.some((byte, index) => byte === 0x1c && iptc[index + 1] === 0x02 && iptc[index + 2] === 0x78));
  assert.match(decode(iptc), /Photoshop 3\.0[\s\S]*IPTC caption/);

  const xmp = rewriteJpegDescription(jpeg, 'xmp', 'XMP <private> & public');
  assert.deepEqual(inspectImageBytes(xmp).metadata.sort(), ['Comment', 'EXIF', 'XMP']);
  assert.match(decode(xmp), /dc:description[\s\S]*XMP &lt;private&gt; &amp; public/);
  const replaced = rewriteJpegDescription(xmp, 'xmp', 'replacement');
  assert.equal((decode(replaced).match(/http:\/\/ns\.adobe\.com\/xap\/1\.0\//g) || []).length, 1);
  assert.doesNotMatch(decode(replaced), /private/);
});

test('PNG metadata rewrite removes text and can add a fresh description', () => {
  const png = samplePng();
  assert.deepEqual(inspectImageBytes(png).metadata, ['Text']);
  const stripped = processPngMetadata(png);
  assert.deepEqual(inspectImageBytes(stripped).metadata, []);
  const edited = processPngMetadata(png, { description: 'public caption' });
  assert.deepEqual(inspectImageBytes(edited).metadata, ['International text']);
  assert.match(decode(edited), /public caption/);
});

test('embedded JPEG extraction chooses a complete substantial preview', () => {
  const jpeg = concat(sampleJpeg().slice(0, -2), new Uint8Array(300), Uint8Array.of(0xff, 0xd9));
  const raw = concat(text.encode('II*\0RAWHEADER'), jpeg, text.encode('TAIL'));
  assert.deepEqual(extractEmbeddedJpeg(raw), jpeg);
  assert.equal(extractEmbeddedJpeg(text.encode('no preview here')), null);
});

test('RAW RGB conversion handles 8-bit and 16-bit developed pixels', () => {
  assert.deepEqual(
    [...rawRgbToRgba(Uint8Array.of(10, 20, 30, 40, 50, 60), 2, 1, 3, 8)],
    [10, 20, 30, 255, 40, 50, 60, 255]
  );
  assert.deepEqual(
    [...rawRgbToRgba(new Uint16Array([0, 32_768, 65_535]), 1, 1, 3, 16)],
    [0, 128, 255, 255]
  );
  assert.throws(() => rawRgbToRgba(Uint8Array.of(1, 2), 1, 1), /shorter/);
});

test('tile regions clip bounds and divide edits into deterministic patches', () => {
  assert.deepEqual(computeTileRegions(600, 400, { x0: 250, y0: 250, x1: 300, y1: 300 }, 256), [
    { x: 0, y: 0, width: 256, height: 256, key: '0:0' },
    { x: 256, y: 0, width: 256, height: 256, key: '256:0' },
    { x: 0, y: 256, width: 256, height: 144, key: '0:256' },
    { x: 256, y: 256, width: 256, height: 144, key: '256:256' }
  ]);
  assert.deepEqual(computeTileRegions(600, 400, { x0: 590, y0: 390, x1: 700, y1: 700 }, 256), [
    { x: 512, y: 256, width: 88, height: 144, key: '512:256' }
  ]);
});

test('Otsu and threshold core create deterministic two-level pixels', () => {
  const histogram = new Uint32Array(256); histogram[10] = 5; histogram[240] = 5;
  assert.equal(otsuThreshold(histogram), 10);
  const result = thresholdRgba(grayRow([0, 100, 200, 255]), 127);
  assert.deepEqual([...result.data], [...grayRow([0, 0, 255, 255])]);
  assert.equal(result.threshold, 127);
});

test('identity quadrilateral warp preserves a 2 by 2 RGBA image', () => {
  const source = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255
  ]);
  const warped = warpQuadrilateralRgba(source, 2, 2, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], 2, 2);
  assert.deepEqual([...warped], [...source]);
});

test('panorama core finds an exact overlap and feathers it', () => {
  const left = grayRow([10, 20, 30, 40]); const right = grayRow([30, 40, 50, 60]);
  const match = findHorizontalOverlap(left, 4, right, 4, 1, { minFraction: 0.25, maxFraction: 0.75, sampleStep: 1 });
  assert.deepEqual(match, { overlap: 2, score: 0 });
  const combined = blendHorizontalImages(left, 4, right, 4, 1, match.overlap);
  assert.equal(combined.width, 6);
  assert.deepEqual([...combined.data.filter((_, index) => index % 4 === 0)], [10, 20, 30, 40, 50, 60]);
});

test('HDR merger validates frame shape and returns opaque bounded pixels', () => {
  const dark = grayRow([32, 64]); const light = grayRow([128, 240]);
  const merged = mergeExposureStack([dark, light], [-1, 1]);
  assert.equal(merged.length, dark.length);
  assert.equal(merged[3], 255); assert.equal(merged[7], 255);
  assert.ok(merged[0] > 0 && merged[0] < 255);
  assert.throws(() => mergeExposureStack([dark]), /at least two/);
});

test('subtitle parser converts valid SRT cues to WebVTT', () => {
  const srt = `1\n00:00:01,250 --> 00:00:03,000\nHello\nworld\n\n2\n00:01:00,000 --> 00:01:02,500\nNext`;
  assert.deepEqual(parseSrt(srt), [
    { start: 1.25, end: 3, text: 'Hello\nworld' },
    { start: 60, end: 62.5, text: 'Next' }
  ]);
  assert.match(srtToVtt(srt), /^WEBVTT\n\n00:00:01\.250 --> 00:00:03\.000/m);
});

test('video estimates and codec preference are deterministic', () => {
  assert.equal(estimateVideoOutputSize(10, 1_000_000, 128_000), 1_410_000);
  assert.equal(selectSupportedRecorderMime((mime) => mime.includes('vp8,opus')), 'video/webm;codecs=vp8,opus');
  assert.equal(selectSupportedRecorderMime(() => false), '');
});

test('FFmpeg plans select real codecs, bounded settings, and metadata removal', () => {
  const webm = buildFfmpegTranscodePlan({ inputName: 'clip.mkv', format: 'webm', maxEdge: 1280, fps: 24, videoBitsPerSecond: 1_000_000 });
  assert.equal(webm.outputName, 'output.webm');
  assert.equal(webm.mime, 'video/webm');
  assert.deepEqual(webm.args.slice(0, 6), ['-i', 'clip.mkv', '-map', '0:v:0', '-map', '0:a:0?']);
  assert.ok(webm.args.includes('libvpx-vp9'));
  assert.ok(webm.args.includes('-map_metadata'));
  assert.deepEqual(webm.args.slice(webm.args.indexOf('-t'), webm.args.indexOf('-t') + 2), ['-t', '600']);
  assert.match(webm.args[webm.args.indexOf('-vf') + 1], /min\(1280,iw\).*fps=24/);
  const mp4 = buildFfmpegTranscodePlan({ format: 'mp4', maxEdge: 99, fps: 100, videoBitsPerSecond: 1, audioStreamIndex: 2 });
  assert.ok(mp4.args.includes('libx264'));
  assert.equal(mp4.args[mp4.args.indexOf('-map', 4) + 1], '0:a:2?');
  assert.equal(mp4.audioStreamIndex, 2);
  assert.equal(mp4.maxEdge, 160);
  assert.equal(mp4.fps, 60);
  assert.equal(mp4.videoBitsPerSecond, 200_000);
  assert.throws(() => buildFfmpegTranscodePlan({ format: 'avi' }), /webm or mp4/);
  assert.throws(() => buildFfmpegTranscodePlan({ audioStreamIndex: 32 }), /0 through 31/);
});

test('FFprobe duration derivation accepts format, stream, and time-base values', () => {
  assert.equal(deriveProbeDuration({ format: { duration: '2.5' }, streams: [{ duration: '2.4' }] }), 2.5);
  assert.equal(deriveProbeDuration({ streams: [{ duration_ts: 75, time_base: '1/25' }] }), 3);
  assert.equal(deriveProbeDuration({ format: { duration: 'N/A' }, streams: [] }), null);
});

test('rich metadata normalization bounds binary, circular, and oversized values', () => {
  const source = { make: 'Camera', binary: new Uint8Array([1, 2, 3]), long: 'abcdef' };
  source.self = source;
  const normalized = normalizeMetadataForJson(source, { maximumString: 3 });
  assert.equal(normalized.make, 'Cam… [3 more characters]');
  assert.deepEqual(normalized.binary, { type: 'Uint8Array', byteLength: 3, preview: [1, 2, 3] });
  assert.equal(normalized.long, 'abc… [3 more characters]');
  assert.equal(normalized.self, '[Circular]');
});

test('Tesseract block flattener preserves real word boxes and confidence', () => {
  const words = flattenTesseractBlocks([{ paragraphs: [{ lines: [{ words: [
    { text: 'Local', confidence: 97.5, bbox: { x0: 10, y0: 20, x1: 50, y1: 36 } },
    { text: ' ', confidence: 12, bbox: { x0: 50, y0: 20, x1: 55, y1: 36 } }
  ] }] }] }]);
  assert.deepEqual(words, [{ text: 'Local', confidence: 97.5, boundingBox: { x: 10, y: 20, width: 40, height: 16 } }]);
});

test('searchable PDF builder embeds JPEG bytes and invisible text', () => {
  const jpeg = sampleJpeg();
  const pdf = buildSearchablePdf(jpeg, 3, 2, [{ text: 'Hello (page)', boundingBox: { x: 0, y: 0, height: 8 } }]);
  const source = decode(pdf);
  assert.match(source, /^%PDF-1\.4/);
  assert.match(source, /\/Subtype \/Image/);
  assert.match(source, /3 Tr/);
  assert.equal(source.includes(String.raw`Hello \(page\)`), true);
  assert.match(source, /startxref\n\d+\n%%EOF/);
});
