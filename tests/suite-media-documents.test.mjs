import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ArchiveReader, libarchiveWasm } from 'libarchive-wasm';
import * as PDFLib from 'pdf-lib';
import SevenZip from '7z-wasm';
import { fixtureBytes, libarchiveFixtures } from './fixtures/suite-media-documents/libarchive-fixtures.mjs';

import {
  analyzePcm,
  buildPublicationPdf,
  buildAnimationFfmpegPlan,
  buildVideoFilter,
  computeSpectrogram,
  crc32,
  createTar,
  createSevenZipArchive,
  createZip,
  detectSilenceRegions,
  detectOnsets,
  encodeWav,
  estimateBpm,
  estimateMusicalKey,
  frameIndexAtElapsed,
  extractOfficeDocument,
  extractZipEntry,
  formatTimestamp,
  makeArchiveRelativeHref,
  mixPcmTracks,
  normalizeArchivePath,
  parseEpubNavigation,
  parseEpubPackage,
  parseFfmpegInspection,
  parseFieldAssignments,
  pdfFieldKind,
  parsePageRanges,
  parseSubtitles,
  parseTar,
  parseTimestamp,
  parseZipDirectory,
  publicationPdfBlocks,
  renderPublication,
  resolveArchiveRelative,
  resampleLinear,
  restoreAudio,
  selfContainedPublication,
  serializeSubtitles,
  toolKeys,
  transformCues,
  updateEpubMetadata,
  updateEpubNavigation,
  updateEpubReadingOrder,
  validateCues,
  validateLibarchiveEntries,
  videoTransitionOpacity
} from '../assets/tools/suite/media-documents.js';

const utf8 = new TextEncoder();

test('suite exposes exactly tools 14 through 26', () => {
  assert.deepEqual(toolKeys, [
    'video-editor', 'animation-studio', 'subtitle-editor', 'audio-converter', 'daw-lite',
    'audio-restoration', 'music-analyzer', 'pdf-toolbox', 'pdf-editor', 'office-viewer',
    'epub-studio', 'publishing-studio', 'archive-manager'
  ]);
});

test('subtitle parsers round-trip SRT and VTT timing', () => {
  const source = '1\n00:00:01,250 --> 00:00:03,500\nHello\nworld\n\n2\n00:00:04,000 --> 00:00:05,000\nBye\n';
  const parsed = parseSubtitles(source, '.srt');
  assert.equal(parsed.format, 'srt');
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].start, 1.25);
  assert.equal(parsed.cues[0].text, 'Hello\nworld');
  const shifted = transformCues(parsed.cues, { offset: 0.5, speed: 2, find: 'Bye', replacement: 'Até' });
  assert.equal(shifted[0].start, 1.125);
  assert.equal(shifted[1].text, 'Até');
  assert.equal(validateCues(shifted).length, 0);
  const vtt = serializeSubtitles(shifted, 'vtt');
  assert.match(vtt, /^WEBVTT/);
  assert.equal(parseSubtitles(vtt, 'vtt').cues.length, 2);
  assert.equal(formatTimestamp(parseTimestamp('1:02:03.004'), '.'), '01:02:03.004');
});

test('ASS parser preserves dialogue commas and removes style overrides', () => {
  const ass = `[Script Info]\nTitle: fixture\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.25,Default,,0,0,0,,{\\i1}Hello, world\\NNext`;
  const parsed = parseSubtitles(ass, 'ass');
  assert.equal(parsed.cues.length, 1);
  assert.equal(parsed.cues[0].text, 'Hello, world\nNext');
  assert.match(serializeSubtitles(parsed.cues, 'ass'), /Dialogue: 0,0:00:01\.00,0:00:02\.25/);
});

test('WAV encoder writes valid PCM headers and interleaved samples', () => {
  const left = new Float32Array([-1, 0, 1]);
  const right = new Float32Array([1, 0.5, -1]);
  const wav = encodeWav([left, right], 48_000, { bitDepth: 16 });
  const view = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint32(40, true), 12);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 32767);
});

test('resampling, restoration, and stereo mixing are deterministic', () => {
  assert.deepEqual([...resampleLinear(new Float32Array([0, 1, 0]), 3, 6)].map((value) => Number(value.toFixed(2))), [0, 0.5, 1, 0.5, 0, 0]);
  const restored = restoreAudio(new Float32Array([0.001, 0.5, -0.5, 0.001]), 1000, { gateDb: -40, normalize: true, targetPeakDb: -6, fadeMs: 0 });
  assert.equal(restored[0], 0);
  assert.ok(Math.abs(Math.max(...restored)) <= 10 ** (-6 / 20) + 1e-6);
  const source = new Float32Array([1, 0]);
  const mix = mixPcmTracks([{ channels: [source], offset: 0, gain: 1, pan: -1 }, { channels: [source], offset: 0.001, gain: 1, pan: 1 }], 1000);
  assert.equal(mix.channels[0][0], 1);
  assert.ok(Math.abs(mix.channels[1][0]) < 1e-6);
  assert.equal(mix.channels[1][1], 1);
  assert.throws(() => mixPcmTracks([{ channels: [source], gain: Number.NaN }], 1000), /finite/);
});

test('windowed silence detection reports bounded merged intervals', () => {
  const signal = new Float32Array(1_000); signal.fill(0); signal.fill(0.5, 200, 400); signal.fill(0.25, 700, 800);
  const report = detectSilenceRegions(signal, 1_000, { thresholdDb: -40, minDurationMs: 100, windowMs: 20, maximumRegions: 2 });
  assert.equal(report.regionCount, 3); assert.equal(report.regions.length, 2); assert.equal(report.truncated, true);
  assert.deepEqual(report.regions.map(({ start, end, duration }) => [start, end, duration]), [[0, 0.2, 0.2], [0.4, 0.7, 0.3]]);
  assert.ok(Math.abs(report.totalSilentSeconds - 0.7) < 1e-12); assert.ok(Math.abs(report.coverage - 0.7) < 1e-12);
  assert.throws(() => detectSilenceRegions([], 1_000), /Invalid/);
});

test('bounded spectrogram locates a sustained tone across time', () => {
  const sampleRate = 8_000; const signal = new Float32Array(sampleRate);
  for (let index = 0; index < signal.length; index += 1) signal[index] = Math.sin(2 * Math.PI * 440 * index / sampleRate);
  const spectrogram = computeSpectrogram(signal, sampleRate, { timeBins: 5, frequencyBins: 32, windowSize: 512, minFrequency: 80, maxFrequency: 2_000 });
  assert.deepEqual([spectrogram.timeBins, spectrogram.frequencyBins, spectrogram.values.length, spectrogram.values[0].length], [5, 32, 5, 32]);
  for (const row of spectrogram.values) { const strongest = row.indexOf(Math.max(...row)); assert.ok(Math.abs(Math.log2(spectrogram.frequencies[strongest] / 440)) < 0.12, `dominant ${spectrogram.frequencies[strongest]}`); }
  assert.ok(spectrogram.floorDb < spectrogram.ceilingDb); assert.throws(() => computeSpectrogram(new Float32Array(4), sampleRate), /Invalid/);
});

test('DAW track edits trim, fade, filter, and retain multitrack mixing', () => {
  const constant = new Float32Array(8).fill(1);
  const edited = mixPcmTracks([{ channels: [constant], trimStart: 0.25, trimEnd: 1.75, fadeIn: 0.5, fadeOut: 0.5, lowPassHz: 0, offset: 0, gain: 1, pan: -1 }], 4);
  assert.deepEqual([...edited.channels[0]], [0, 0.5, 1, 1, 0.5, 0]);
  assert.ok([...edited.channels[1]].every((sample) => Math.abs(sample) < 1e-6));
  const filtered = mixPcmTracks([{ channels: [new Float32Array(10).fill(1)], lowPassHz: 1, pan: -1 }], 10);
  assert.ok(filtered.channels[0][0] > 0 && filtered.channels[0][0] < 1);
  assert.ok(filtered.channels[0][4] > filtered.channels[0][0]);
  assert.throws(() => mixPcmTracks([{ channels: [constant], trimStart: 1, trimEnd: 0.5 }], 4), /trim/);
  assert.throws(() => mixPcmTracks([{ channels: [constant], fadeIn: 1.5, fadeOut: 1 }], 4), /fades/);
  assert.throws(() => mixPcmTracks([{ channels: [constant], lowPassHz: 2 }], 4), /Nyquist/);
});

test('tempo and tonal estimators measure synthetic signals', () => {
  const rate = 2000;
  const pulse = new Float32Array(rate * 16);
  for (let frame = 0; frame < pulse.length; frame += rate / 2) for (let index = 0; index < 10; index += 1) pulse[frame + index] = 1 - index / 10;
  const tempo = estimateBpm(pulse, rate);
  assert.ok(Math.abs(tempo.bpm - 120) < 2, `estimated ${tempo.bpm}`);
  const musicRate = 8000; const chord = new Float32Array(musicRate * 6); const frequencies = [261.6256, 329.6276, 391.9954];
  for (let index = 0; index < chord.length; index += 1) chord[index] = frequencies.reduce((sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * index / musicRate), 0) / frequencies.length;
  const key = estimateMusicalKey(chord, musicRate);
  assert.match(key.key, /^C /);
  const report = analyzePcm(chord, musicRate);
  assert.ok(report.rms > 0.1);
  assert.equal(report.spectrum.length, 48);
  assert.ok(Array.isArray(report.onsets)); assert.equal(report.onsetCount >= report.onsets.length, true);
});

test('onset detector finds separated synthetic attacks and enforces its cap', () => {
  const rate = 2_000; const signal = new Float32Array(rate * 2); for (const time of [0.25, 0.75, 1.4]) { const start = Math.round(time * rate); for (let index = 0; index < 30; index += 1) signal[start + index] = 1 - index / 30; }
  const report = detectOnsets(signal, rate, { sensitivity: 0.5, maximumOnsets: 2, minimumIntervalMs: 100 }); assert.ok(report.count >= 3, `count ${report.count}`); assert.equal(report.onsets.length, 2); assert.equal(report.truncated, true); assert.ok(Math.abs(report.onsets[0].time - 0.25) < 0.05); assert.ok(Math.abs(report.onsets[1].time - 0.75) < 0.05); assert.throws(() => detectOnsets(new Float32Array(2), rate), /Invalid/);
});

test('PDF page expressions preserve order, groups, and reject overlap', () => {
  assert.deepEqual(parsePageRanges('3,1-2', 4), [[2, 0, 1]]);
  assert.deepEqual(parsePageRanges('1-2;4', 4, { allowGroups: true }), [[0, 1], [3]]);
  assert.throws(() => parsePageRanges('1-3,2', 4), /selected more than once/);
  assert.throws(() => parsePageRanges('5', 4), /outside/);
});

test('PDF field classification is stable across minified and unminified runtimes', async () => {
  const document = await PDFLib.PDFDocument.create(); document.addPage();
  const form = document.getForm();
  assert.equal(pdfFieldKind(form.createTextField('Name'), PDFLib), 'TextField');
  assert.equal(pdfFieldKind(form.createCheckBox('Approved'), PDFLib), 'CheckBox');
  assert.equal(pdfFieldKind(form.createDropdown('Choice'), PDFLib), 'Dropdown');
});

test('field assignment parser handles values containing equals', () => {
  const values = parseFieldAssignments('# form\nName=Matheus\nURL=https://example.test/?a=b\n');
  assert.equal(values.get('Name'), 'Matheus');
  assert.equal(values.get('URL'), 'https://example.test/?a=b');
  assert.throws(() => parseFieldAssignments('Name=a\nName=b'), /more than once/);
});

test('ZIP store writer, directory parser, CRC, and extraction round-trip', async () => {
  assert.equal(crc32(utf8.encode('123456789')), 0xcbf43926);
  const zip = createZip([{ name: 'folder/hello.txt', data: utf8.encode('hello') }, { name: 'empty.bin', data: new Uint8Array() }]);
  const entries = parseZipDirectory(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'folder/hello.txt');
  assert.equal(new TextDecoder().decode(await extractZipEntry(zip, entries[0])), 'hello');
  const corrupt = zip.slice(); corrupt[entries[0].localOffset + 30 + utf8.encode(entries[0].name).length] ^= 0xff;
  await assert.rejects(() => extractZipEntry(corrupt, entries[0]), /integrity/);
  assert.throws(() => createZip([{ name: 'same.txt', data: utf8.encode('a') }, { name: './same.txt', data: utf8.encode('b') }]), /Duplicate normalized/);
});

test('archive paths reject traversal and absolute roots', () => {
  assert.equal(normalizeArchivePath('folder\\safe.txt'), 'folder/safe.txt');
  assert.equal(resolveArchiveRelative('OEBPS/package.opf', '../text/chapter%201.xhtml#start'), 'text/chapter 1.xhtml');
  assert.throws(() => normalizeArchivePath('../secret'), /Unsafe/);
  assert.throws(() => resolveArchiveRelative('package.opf', '../secret'), /Unsafe/);
  assert.throws(() => normalizeArchivePath('/absolute'), /Unsafe/);
  assert.throws(() => normalizeArchivePath('C:\\secret'), /Unsafe/);
  assert.equal(makeArchiveRelativeHref('OEBPS/nav/toc.xhtml', 'OEBPS/text/chapter 1.xhtml'), '../text/chapter%201.xhtml');
  assert.equal(resolveArchiveRelative('OEBPS/nav/toc.xhtml', makeArchiveRelativeHref('OEBPS/nav/toc.xhtml', 'OEBPS/text/chapter 1.xhtml')), 'OEBPS/text/chapter 1.xhtml');
});

test('libarchive descriptors enforce traversal, type, duplicate, entry, and aggregate caps', () => {
  assert.deepEqual(validateLibarchiveEntries([{ pathname: 'folder/safe.txt', size: 3, filetype: 'File' }]), [{ name: 'folder/safe.txt', size: 3, directory: false, type: 'File', runtimeIndex: 0 }]);
  assert.throws(() => validateLibarchiveEntries([{ pathname: '../secret', size: 1, filetype: 'File' }]), /Unsafe/);
  assert.throws(() => validateLibarchiveEntries([{ pathname: 'link', size: 0, filetype: 'SymbolicLink' }]), /Unsupported archive entry type/);
  assert.throws(() => validateLibarchiveEntries([{ pathname: 'secret', size: 1, filetype: 'File', encrypted: true }]), /Encrypted/);
  assert.throws(() => validateLibarchiveEntries([{ pathname: 'same', size: 1, filetype: 'File' }, { pathname: './same', size: 1, filetype: 'File' }]), /Duplicate normalized/);
  assert.throws(() => validateLibarchiveEntries([{ pathname: 'large', size: 5, filetype: 'File' }], { maximumEntry: 4 }), /exceeds/);
  assert.throws(() => validateLibarchiveEntries([{ pathname: 'a', size: 3, filetype: 'File' }, { pathname: 'b', size: 3, filetype: 'File' }], { maximumExpanded: 5 }), /Expanded archive data exceeds/);
  assert.throws(() => validateLibarchiveEntries([{ pathname: 'a', size: 1, filetype: 'File' }, { pathname: 'b', size: 1, filetype: 'File' }], { maximumFiles: 1 }), /more than 1/);
});

test('real libarchive WASM extracts 7z and XZ/LZMA-compressed TAR fixtures', async () => {
  const wasmPath = fileURLToPath(new URL('../node_modules/libarchive-wasm/dist/libarchive.wasm', import.meta.url));
  for (const fixture of libarchiveFixtures) {
    const runtime = await libarchiveWasm({ locateFile: () => wasmPath });
    const bytes = fixtureBytes(fixture); const reader = new ArchiveReader(runtime, new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)); let actual = null;
    try {
      for (const entry of reader.entries()) if (entry.getPathname() === fixture.entryName) actual = new Uint8Array(entry.readData() || 0).slice();
      assert.notEqual(reader.hasEncryptedData(), true, `${fixture.format} unexpectedly encrypted`);
      assert.ok(runtime.version_string().startsWith('libarchive '));
    } finally { reader.free(); }
    assert.ok(actual, `${fixture.entryName} absent from ${fixture.format}`);
    assert.equal(new TextDecoder().decode(actual), fixture.text);
  }
});

test('site-hosted 7-Zip WASM creates genuine 7z and TAR.XZ archives that libarchive round-trips', async () => {
  const wasmPath = fileURLToPath(new URL('../node_modules/libarchive-wasm/dist/libarchive.wasm', import.meta.url));
  const records = [
    { name: 'nested/hello.txt', data: utf8.encode('hello from a generated archive') },
    { name: '-leading-option.txt', data: utf8.encode('a leading dash remains a safe filename') }
  ];
  for (const format of ['7z', 'txz']) {
    const created = await createSevenZipArchive(records, format, { factory: SevenZip });
    const expectedSignature = format === '7z' ? [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] : [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
    assert.deepEqual([...created.bytes.subarray(0, 6)], expectedSignature);
    const runtime = await libarchiveWasm({ locateFile: () => wasmPath });
    const signed = new Int8Array(created.bytes.buffer, created.bytes.byteOffset, created.bytes.byteLength);
    const reader = new ArchiveReader(runtime, signed); const extracted = new Map();
    try {
      for (const entry of reader.entries()) if (entry.getFiletype() === 'File') extracted.set(entry.getPathname().replace(/^\.\//, ''), new Uint8Array(entry.readData() || 0).slice());
      assert.notEqual(reader.hasEncryptedData(), true);
    } finally { reader.free(); }
    for (const record of records) assert.deepEqual(extracted.get(record.name), record.data, `${format} did not round-trip ${record.name}`);
  }
});

test('vendored gifenc creates a genuine multi-frame GIF', async () => {
  const { GIFEncoder, quantize, applyPalette } = await import('../vendor/suite/gifenc.js');
  const first = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
  const second = new Uint8ClampedArray([0, 255, 0, 255, 0, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255]);
  const gif = GIFEncoder();
  for (const [index, rgba] of [first, second].entries()) {
    const palette = quantize(rgba, 256, { format: 'rgb444' });
    gif.writeFrame(applyPalette(rgba, palette, 'rgb444'), 2, 2, { palette, delay: 100, repeat: index ? 0 : -1 });
  }
  gif.finish();
  const bytes = gif.bytes();
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 6)), 'GIF89a');
  assert.equal(bytes.at(-1), 0x3b);
  assert.equal([...bytes].filter((byte) => byte === 0x2c).length >= 2, true, 'expected two image descriptors');
});

test('vendored fflate creates Deflate ZIP data accepted by integrity parser', async () => {
  const { zipSync } = await import('../vendor/suite/fflate.js');
  const payload = utf8.encode('compressible fixture '.repeat(100));
  const zip = zipSync({ 'folder/data.txt': payload }, { level: 6 });
  const entries = parseZipDirectory(zip);
  assert.equal(entries[0].method, 8);
  assert.deepEqual(await extractZipEntry(zip, entries[0]), payload);
  await assert.rejects(() => extractZipEntry(zip, { ...entries[0], size: payload.length - 1 }), /size|integrity/);
});

test('vendored FFmpeg wrapper and codec-enabled WASM core are present locally', async () => {
  const { FFmpeg } = await import('../vendor/ffmpeg/ffmpeg/index.js');
  const instance = new FFmpeg();
  assert.equal(typeof instance.load, 'function');
  assert.equal(typeof instance.exec, 'function');
  assert.equal(typeof instance.writeFile, 'function');
  const wasm = await readFile(new URL('../vendor/ffmpeg/core/ffmpeg-core.wasm', import.meta.url));
  assert.deepEqual([...wasm.subarray(0, 4)], [0, 97, 115, 109]);
  assert.ok(wasm.length > 30_000_000);
  for (const codec of ['libx264', 'libvpx-vp9', 'libmp3lame', 'libopus', 'libwebp']) assert.equal(wasm.includes(codec), true, `${codec} missing from local core`);
});

test('FFmpeg inspection logs expose deterministic duration and dimensions', () => {
  const result = parseFfmpegInspection([
    '  Duration: 01:02:03.45, start: 0.000000, bitrate: 512 kb/s',
    '  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps'
  ]);
  assert.deepEqual(result, { duration: 3723.45, width: 1920, height: 1080 });
  assert.throws(() => parseFfmpegInspection('Duration: N/A\nStream #0:0: Audio: aac'), /timed video/);
});

test('video edge transition envelope and FFmpeg filters are bounded and deterministic', () => {
  assert.deepEqual([0, 0.25, 1, 1.75, 2].map((time) => videoTransitionOpacity(time, 2, 0.5)), [1, 0.5, 0, 0.5, 1]);
  assert.equal(buildVideoFilter(320, 2, { transition: 'none' }), 'scale=320:-2:force_original_aspect_ratio=decrease');
  assert.equal(buildVideoFilter(320, 2, { transition: 'fade', fadeDuration: 0.5, color: '#123abc' }), 'scale=320:-2:force_original_aspect_ratio=decrease,fade=t=in:st=0:d=0.5:color=0x123abc,fade=t=out:st=1.5:d=0.5:color=0x123abc');
  assert.throws(() => buildVideoFilter(320, 1, { transition: 'fade', fadeDuration: 0.75 }), /half/);
  assert.throws(() => videoTransitionOpacity(0, 1, 0.75), /invalid/);
});

test('animation timing and FFmpeg plans cover GIF, WebP, and APNG', () => {
  assert.deepEqual([0, 99, 100, 299, 300, 649].map((elapsed) => frameIndexAtElapsed([100, 200, 350], elapsed)), [0, 0, 1, 1, 2, 2]);
  assert.equal(frameIndexAtElapsed([100, 200, 350], 650), 0); assert.equal(frameIndexAtElapsed([100, 200, 350], -1), 2);
  assert.throws(() => frameIndexAtElapsed([10], 0), /20 and 10,000/);
  const base = { width: 640, height: 360, fps: 12, loops: 2, start: 1.5, duration: 3, fit: 'contain', background: '#123456', quality: 77 };
  const gif = buildAnimationFfmpegPlan({ ...base, format: 'gif' }); assert.equal(gif.mime, 'image/gif'); assert.equal(gif.extension, 'gif'); assert.ok(gif.args.includes('-filter_complex')); assert.match(gif.args[gif.args.indexOf('-filter_complex') + 1], /palettegen.*paletteuse/);
  const webp = buildAnimationFfmpegPlan({ ...base, format: 'webp' }); assert.equal(webp.mime, 'image/webp'); assert.ok(webp.args.includes('libwebp_anim')); assert.equal(webp.args[webp.args.indexOf('-quality') + 1], '77'); assert.match(webp.args[webp.args.indexOf('-vf') + 1], /pad=640:360.*0x123456/);
  const apng = buildAnimationFfmpegPlan({ ...base, format: 'apng', fit: 'cover' }); assert.equal(apng.mime, 'image/apng'); assert.equal(apng.args.at(-1), 'apng'); assert.match(apng.args[apng.args.indexOf('-vf') + 1], /crop=640:360/);
  assert.throws(() => buildAnimationFfmpegPlan({ ...base, format: 'avi' }), /GIF, WebP, or APNG/); assert.throws(() => buildAnimationFfmpegPlan({ ...base, duration: 121 }), /120/);
});

test('TAR writer and parser round-trip data offsets and checksums', () => {
  const tar = createTar([{ name: 'one.txt', data: utf8.encode('one') }, { name: 'folder/two.txt', data: utf8.encode('two') }]);
  const entries = parseTar(tar);
  assert.deepEqual(entries.map((entry) => entry.name), ['one.txt', 'folder/two.txt']);
  assert.equal(new TextDecoder().decode(tar.subarray(entries[1].dataOffset, entries[1].dataOffset + entries[1].size)), 'two');
  const corrupt = tar.slice(); corrupt[0] ^= 1;
  assert.throws(() => parseTar(corrupt), /checksum/);
});

test('OOXML semantic extractors cover DOCX, XLSX, and PPTX', () => {
  const docx = extractOfficeDocument('docx', new Map([['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:body></w:document>']]));
  assert.match(docx.sections[0].text, /Hello/);
  assert.match(docx.sections[0].text, /A \| B/);
  const xlsx = extractOfficeDocument('xlsx', new Map([
    ['xl/sharedStrings.xml', '<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>'],
    ['xl/workbook.xml', '<workbook><sheets><sheet name="People" sheetId="1"/></sheets></workbook>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>']
  ]));
  assert.equal(xlsx.sections[0].title, 'People');
  assert.equal(xlsx.sections[0].text, 'Name\t42\nAlice');
  const pptx = extractOfficeDocument('pptx', new Map([['ppt/slides/slide1.xml', '<p:sld><a:t>Title</a:t><a:t>Body</a:t></p:sld>']]));
  assert.equal(pptx.sections[0].text, 'Title\nBody');
});

test('EPUB package parsing and metadata replacement preserve manifest and spine', () => {
  const opf = `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Old &amp; Title</dc:title><dc:creator>Alice</dc:creator><dc:identifier>id-1</dc:identifier></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
  const parsed = parseEpubPackage(opf);
  assert.equal(parsed.metadata.title, 'Old & Title');
  assert.equal(parsed.manifest.get('c1').href, 'chapter.xhtml');
  assert.deepEqual(parsed.spine, ['c1']);
  const updated = updateEpubMetadata(opf, { title: 'New <Title>', language: 'pt-BR' });
  assert.match(updated, /<dc:title>New &lt;Title&gt;<\/dc:title>/);
  assert.match(updated, /<dc:language>pt-BR<\/dc:language>/);
});

test('EPUB reading order and EPUB3/NCX navigation are editable', () => {
  const opf = `<package><metadata></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine page-progression-direction="ltr"><itemref idref="a" linear="yes"/><itemref idref="b"/></spine></package>`;
  const reordered = updateEpubReadingOrder(opf, ['b', 'a']); assert.ok(reordered.indexOf('idref="b"') < reordered.indexOf('idref="a"')); assert.match(reordered, /page-progression-direction="ltr"/); assert.match(reordered, /idref="a" linear="yes"/); assert.throws(() => updateEpubReadingOrder(opf, ['missing']), /absent/);
  const nav = `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="a.xhtml">Alpha</a></li><li><a href="b.xhtml">Beta</a></li></ol></nav><nav epub:type="landmarks"><a href="cover.xhtml">Cover</a></nav></body></html>`;
  assert.deepEqual(parseEpubNavigation(nav), { kind: 'nav', entries: [{ title: 'Alpha', href: 'a.xhtml' }, { title: 'Beta', href: 'b.xhtml' }] }); const navUpdated = updateEpubNavigation(nav, [{ title: 'New & Beta', href: 'b.xhtml' }, { title: 'Alpha', href: 'a.xhtml' }]); assert.ok(navUpdated.indexOf('b.xhtml') < navUpdated.indexOf('a.xhtml')); assert.match(navUpdated, /New &amp; Beta/); assert.match(navUpdated, /epub:type="landmarks"/);
  const ncx = `<ncx><navMap><navPoint id="one" playOrder="1"><navLabel><text>One</text></navLabel><content src="one.xhtml"/></navPoint><navPoint id="two" playOrder="2"><navLabel><text>Two</text></navLabel><content src="two.xhtml"/></navPoint></navMap></ncx>`; assert.deepEqual(parseEpubNavigation(ncx), { kind: 'ncx', entries: [{ title: 'One', href: 'one.xhtml' }, { title: 'Two', href: 'two.xhtml' }] }); const ncxUpdated = updateEpubNavigation(ncx, [{ title: 'Second', href: 'two.xhtml' }], 'ncx'); assert.match(ncxUpdated, /playOrder="1"/); assert.match(ncxUpdated, /Second/); assert.doesNotMatch(ncxUpdated, /one\.xhtml/);
  assert.throws(() => updateEpubNavigation(nav, [{ title: 'Unsafe', href: 'https://example.test' }]), /Invalid/);
});

test('publication renderer escapes active HTML and rejects script URLs', () => {
  const html = renderPublication('# Hello\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [good](https://example.test)\n\n```js\nconst x = 1 < 2;\n```', 'markdown');
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /href="https:\/\/example\.test"/);
  assert.match(html, /&lt; 2/);
  const latex = renderPublication('\\section{Title}\n\n\\textbf{Bold} and $x^2$', 'latex');
  assert.match(latex, /<h1>Title<\/h1>/);
  assert.match(latex, /role="math">x\^2/);
  const page = selfContainedPublication('A & B', html, 'en');
  assert.match(page, /<title>A &amp; B<\/title>/);
  assert.doesNotMatch(page, /<script/);
});

test('publishing studio creates a real multi-format local PDF', async () => {
  const source = '# Local PDF\n\nA **formatted** paragraph with português.\n\n- First\n- Second\n\n```js\nconst answer = 42;\n```';
  assert.deepEqual(publicationPdfBlocks(source).map((block) => block.kind), ['heading', 'paragraph', 'list', 'list', 'code']);
  const bytes = await buildPublicationPdf(source, { title: 'Fixture publication', language: 'pt-BR', PDFLib });
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), '%PDF-');
  const document = await PDFLib.PDFDocument.load(bytes);
  assert.equal(document.getTitle(), 'Fixture publication');
  assert.ok(document.getPageCount() >= 1);
  const latexBytes = await buildPublicationPdf('\\section{TeX title}\n\nValue $x^2$', { mode: 'latex', PDFLib });
  assert.equal(new TextDecoder().decode(latexBytes.subarray(0, 5)), '%PDF-');
});
