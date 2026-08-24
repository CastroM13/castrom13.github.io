import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  VAULT_DEFAULT_ITERATIONS,
  aggregateForChart,
  analyzeGitSnapshot,
  applyBinaryPatch,
  buildDuckDatasetSourceSql,
  buildPreviewDocument,
  buildReadOnlyDuckQuery,
  buildVaultHeader,
  createBinaryPatch,
  createGitMemoryFs,
  datasetToCSV,
  datasetToNDJSON,
  decodeNetworkPacket,
  decryptVault,
  detectFileType,
  differenceHashFromRgba,
  diffBytes,
  encryptVault,
  entropyWindows,
  evaluateJavaScriptCell,
  executeDatasetQuery,
  extractAsciiStrings,
  extractSQLiteSchemaStrings,
  filterDatasetRows,
  groupDuplicateRecords,
  groupPerceptualHashes,
  hammingDistanceHex,
  inferColumns,
  inspectKnownBinaryStructure,
  inspectParquetEnvelope,
  inspectWasmModule,
  joinDatasets,
  isReadOnlySqliteStatement,
  makeHexRows,
  normalizeVaultArchivePath,
  parseDatasetText,
  parseDelimited,
  parseGitConfig,
  parseGitHead,
  parseGitLog,
  parsePackedRefs,
  parseNotebook,
  parsePcap,
  parseSQLiteHeader,
  parseSimpleSelect,
  parseVaultContainer,
  parseWasmSections,
  pivotDataset,
  prepareGitCommitMetadata,
  runRegex,
  sanitizeGitConfig,
  serializeNotebook,
  shannonEntropy,
  toolKeys
} from '../assets/tools/suite/data-developer.js';

assert.equal(toolKeys.length, 13);
assert.deepEqual(toolKeys, [
  'file-inspector', 'file-deduplicator', 'encryption-vault', 'sqlite-workbench', 'duckdb-studio', 'data-converter', 'bi-dashboard',
  'data-notebook', 'regex-workbench', 'git-client', 'binary-diff', 'code-playground', 'packet-analyzer'
]);

// Universal file inspector: signatures, entropy, strings, and offset formatting.
assert.equal(detectFileType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), 'wrong.bin').id, 'png');
assert.equal(detectFileType(new TextEncoder().encode('{"ok":true}'), 'payload.txt').id, 'json');
assert.equal(detectFileType(Uint8Array.from([0, 1, 2, 3]), 'unknown').id, 'binary');
assert.equal(shannonEntropy(Uint8Array.from([0, 0, 1, 1])), 1);
assert.equal(shannonEntropy(new Uint8Array()), 0);
const strings = extractAsciiStrings(Uint8Array.from([0, ...new TextEncoder().encode('hello'), 1, ...new TextEncoder().encode('tool')]), 4);
assert.deepEqual(strings.map((item) => [item.offset, item.text]), [[1, 'hello'], [7, 'tool']]);
assert.deepEqual(makeHexRows(Uint8Array.from([0x41, 0, 0xff, 0x7e]), 0, 4, 4)[0], { offset: 0, offsetHex: '00000000', hex: '41 00 ff 7e', text: 'A..~' });
const pngStructureBytes = new Uint8Array(45);
pngStructureBytes.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10], 0);
const pngStructureView = new DataView(pngStructureBytes.buffer);
pngStructureView.setUint32(8, 13); pngStructureBytes.set(new TextEncoder().encode('IHDR'), 12);
pngStructureView.setUint32(16, 32); pngStructureView.setUint32(20, 16); pngStructureBytes[24] = 8; pngStructureBytes[25] = 6;
pngStructureView.setUint32(33, 0); pngStructureBytes.set(new TextEncoder().encode('IEND'), 37);
const pngStructure = inspectKnownBinaryStructure(pngStructureBytes, 'fixture.png');
assert.equal(pngStructure.width, 32);
assert.equal(pngStructure.height, 16);
assert.deepEqual(pngStructure.chunks.map((chunk) => chunk.type), ['IHDR', 'IEND']);
const truncatedSqliteStructure = inspectKnownBinaryStructure(new TextEncoder().encode('SQLite format 3\0'), 'truncated.sqlite');
assert.equal(truncatedSqliteStructure.type, 'sqlite');
assert.equal(truncatedSqliteStructure.complete, false);
assert.match(truncatedSqliteStructure.reason, /header|bytes|truncated/i);

// Exact duplicate grouping never merges size mismatches or invalid digests.
const duplicateGroups = groupDuplicateRecords([
  { path: 'a.bin', size: 4, digest: 'a'.repeat(64) },
  { path: 'b.bin', size: 4, digest: 'A'.repeat(64) },
  { path: 'different-size.bin', size: 5, digest: 'a'.repeat(64) },
  { path: 'single.bin', size: 4, digest: 'b'.repeat(64) },
  { path: 'invalid.bin', size: 4, digest: 'nope' }
]);
assert.equal(duplicateGroups.length, 1);
assert.equal(duplicateGroups[0].files.length, 2);
assert.equal(duplicateGroups[0].reclaimableBytes, 4);
const gradient = new Uint8Array(9 * 8 * 4);
for (let y = 0; y < 8; y += 1) for (let x = 0; x < 9; x += 1) {
  const offset = (y * 9 + x) * 4;
  gradient.set([255 - x * 20, 255 - x * 20, 255 - x * 20, 255], offset);
}
const gradientHash = differenceHashFromRgba(gradient, 9, 8);
assert.equal(gradientHash, 'ffffffffffffffff');
assert.equal(hammingDistanceHex(gradientHash, 'fffffffffffffffe'), 1);
assert.deepEqual(groupPerceptualHashes([
  { path: 'one.png', hash: gradientHash }, { path: 'two.jpg', hash: 'fffffffffffffffe' }, { path: 'different.png', hash: '0000000000000000' }
], 2).map((group) => group.files.map((file) => file.path)), [['one.png', 'two.jpg']]);

// Authenticated vault metadata and actual Web Crypto roundtrip.
const fixedSalt = Uint8Array.from({ length: 16 }, (_, index) => index);
const fixedIv = Uint8Array.from({ length: 12 }, (_, index) => 20 + index);
const vaultHeader = buildVaultHeader({ filename: 'relatório.txt', mime: 'text/plain', originalSize: 5, iterations: 400_000, salt: fixedSalt, iv: fixedIv });
const parsedHeaderContainer = parseVaultContainer(new Uint8Array([...vaultHeader, ...new Uint8Array(16)]));
assert.equal(parsedHeaderContainer.filename, 'relatório.txt');
assert.equal(parsedHeaderContainer.mime, 'text/plain');
assert.equal(parsedHeaderContainer.originalSize, 5);
assert.equal(parsedHeaderContainer.iterations, 400_000);
assert.deepEqual(parsedHeaderContainer.salt, fixedSalt);
assert.throws(() => buildVaultHeader({ originalSize: 1, iterations: 99_999, salt: fixedSalt, iv: fixedIv }), /iterations/);
const secret = new TextEncoder().encode('local-only secret payload');
const encrypted = await encryptVault(secret, 'correct horse battery staple', { filename: 'secret.txt', mime: 'text/plain' });
const encryptedMetadata = parseVaultContainer(encrypted);
assert.equal(encryptedMetadata.algorithm, 'AES-256-GCM/PBKDF2-SHA-256');
assert.equal(encryptedMetadata.iterations, VAULT_DEFAULT_ITERATIONS);
assert.equal(encryptedMetadata.originalSize, secret.length);
assert.notDeepEqual(encrypted.subarray(-secret.length), secret);
const decrypted = await decryptVault(encrypted, 'correct horse battery staple');
assert.deepEqual(decrypted.bytes, secret);
assert.equal(decrypted.metadata.filename, 'secret.txt');
await assert.rejects(() => decryptVault(encrypted, 'wrong password'), /wrong|modified/);
const tampered = encrypted.slice(); tampered[tampered.length - 1] ^= 1;
await assert.rejects(() => decryptVault(tampered, 'correct horse battery staple'), /wrong|modified/);
assert.equal(normalizeVaultArchivePath('folder\\nested/./file.txt'), 'folder/nested/file.txt');
assert.throws(() => normalizeVaultArchivePath('../secret.txt'), /Unsafe/);

// SQLite header decoding and honest printable-schema recovery.
const sqlite = new Uint8Array(4_096);
sqlite.set(new TextEncoder().encode('SQLite format 3\0'), 0);
const sqliteView = new DataView(sqlite.buffer);
sqliteView.setUint16(16, 4_096);
sqlite[18] = 2; sqlite[19] = 2;
sqliteView.setUint32(24, 7);
sqliteView.setUint32(28, 1);
sqliteView.setUint32(40, 3);
sqliteView.setUint32(44, 4);
sqliteView.setUint32(56, 1);
sqliteView.setUint32(60, 42);
sqliteView.setUint32(68, 0x4d313354);
sqliteView.setUint32(96, 3_046_000);
sqlite.set(new TextEncoder().encode('CREATE TABLE widgets(id INTEGER PRIMARY KEY, name TEXT)\0'), 200);
const sqliteHeader = parseSQLiteHeader(sqlite);
assert.equal(sqliteHeader.pageSize, 4_096);
assert.equal(sqliteHeader.writeVersion, 'WAL');
assert.equal(sqliteHeader.textEncoding, 'UTF-8');
assert.equal(sqliteHeader.userVersion, 42);
assert.match(extractSQLiteSchemaStrings(sqlite)[0].sql, /^CREATE TABLE widgets/);
assert.throws(() => parseSQLiteHeader(new Uint8Array(100)), /Not a SQLite/);
assert.equal(isReadOnlySqliteStatement('-- bounded\nSELECT * FROM widgets'), true);
assert.equal(isReadOnlySqliteStatement('PRAGMA table_info(widgets)'), true);
assert.equal(isReadOnlySqliteStatement('PRAGMA user_version = 2'), false);
assert.equal(isReadOnlySqliteStatement("WITH changed AS (DELETE FROM widgets RETURNING *) SELECT * FROM changed"), false);

// Parquet envelope inspection validates both magic values and footer bounds.
const parquet = new Uint8Array(4 + 6 + 5 + 8);
parquet.set(new TextEncoder().encode('PAR1'), 0);
parquet.set([1, 2, 3, 4, 5, 6], 4);
parquet.set([9, 8, 7, 6, 5], 10);
new DataView(parquet.buffer).setUint32(parquet.length - 8, 5, true);
parquet.set(new TextEncoder().encode('PAR1'), parquet.length - 4);
assert.deepEqual(inspectParquetEnvelope(parquet), { size: parquet.length, footerLength: 5, footerOffset: 10, dataBytes: 6, magic: 'PAR1' });
const badParquet = parquet.slice(); badParquet[badParquet.length - 1] = 0;
assert.throws(() => inspectParquetEnvelope(badParquet), /Parquet/);
assert.equal(buildDuckDatasetSourceSql('parquet', 'input.parquet'), "read_parquet('input.parquet')");
assert.equal(buildDuckDatasetSourceSql('ndjson', 'rows.ndjson'), "read_json_auto('rows.ndjson', format='newline_delimited')");
assert.throws(() => buildDuckDatasetSourceSql('csv', "bad'name.csv"), /filename/);
assert.equal(buildReadOnlyDuckQuery('SELECT * FROM data;'), 'SELECT * FROM (SELECT * FROM data) AS __m13_result LIMIT 10001');
assert.throws(() => buildReadOnlyDuckQuery('COPY data TO \'x.csv\''), /read-only/);
assert.throws(() => buildReadOnlyDuckQuery("SELECT * FROM read_parquet('https://example.test/a.parquet')"), /prepared local data view/);

// CSV/JSON/NDJSON parsing, safe serialization, bounded SELECT, charts, and pivots.
const csv = 'name,name,score,note\r\n"Ada","A",10,"line 1\nline 2"\r\n"Bob","B",20,"say ""hi"""\r\n';
const parsedCsv = parseDelimited(csv);
assert.deepEqual(parsedCsv.columns, ['name', 'name_2', 'score', 'note']);
assert.equal(parsedCsv.rows[0].note, 'line 1\nline 2');
assert.equal(parsedCsv.rows[1].note, 'say "hi"');
assert.throws(() => parseDelimited('a,b\n"unterminated,2'), /quoted field/);
assert.deepEqual(parseDatasetText('[{"a":1},{"a":2}]', 'auto').rows, [{ a: 1 }, { a: 2 }]);
assert.deepEqual(parseDatasetText('{"a":1}\n{"a":2}\n', 'ndjson').rows, [{ a: 1 }, { a: 2 }]);
assert.equal(datasetToNDJSON([{ a: 1 }, { a: 2 }]), '{"a":1}\n{"a":2}');
const safeCsv = datasetToCSV([{ cell: '=HYPERLINK("https://bad")', plain: 'ok' }]);
assert.match(safeCsv, /'=/);
assert.doesNotMatch(safeCsv, /\r\n=/);

const rows = [
  { team: 'blue', score: '10', active: true },
  { team: 'red', score: '8', active: false },
  { team: 'blue', score: '15', active: true },
  { team: 'red', score: '20', active: true }
];
const plan = parseSimpleSelect("SELECT team, SUM(score) AS total, COUNT(*) AS n FROM data WHERE score >= 10 GROUP BY team ORDER BY total DESC LIMIT 5;");
assert.equal(plan.groupBy, 'team');
assert.deepEqual(executeDatasetQuery(rows, plan), [{ team: 'blue', total: 25, n: 2 }, { team: 'red', total: 20, n: 1 }]);
assert.deepEqual(executeDatasetQuery(rows, "SELECT team AS label FROM data WHERE team CONTAINS 'lu' LIMIT 2"), [{ label: 'blue' }, { label: 'blue' }]);
assert.deepEqual(filterDatasetRows(rows, { field: 'team', operator: 'contains', value: 'blu' }), [rows[0], rows[2]]);
assert.deepEqual(filterDatasetRows(rows, { field: 'score', operator: '>=', value: '15' }), [rows[2], rows[3]]);
assert.throws(() => parseSimpleSelect('DELETE FROM data'), /SELECT/);
assert.throws(() => parseSimpleSelect('SELECT * FROM data LIMIT 10001'), /LIMIT/);
assert.deepEqual(inferColumns(rows).map((item) => [item.name, item.type]), [['team', 'string'], ['score', 'number'], ['active', 'boolean']]);
assert.deepEqual(aggregateForChart(rows, { category: 'team', value: 'score', aggregation: 'avg' }), [
  { label: 'blue', value: 12.5, rows: 2 },
  { label: 'red', value: 14, rows: 2 }
].sort((a, b) => b.value - a.value));
const pivot = pivotDataset(rows, { row: 'team', column: 'active', value: 'score', aggregation: 'sum' });
assert.deepEqual(pivot.columns, ['team', 'false', 'true']);
assert.deepEqual(pivot.rows, [{ team: 'blue', false: null, true: 25 }, { team: 'red', false: 8, true: 20 }]);
assert.deepEqual(joinDatasets([{ id: 1, name: 'A' }, { id: 2, name: 'B' }], [{ id: '1', name: 'Right A', extra: true }, { id: 3, extra: false }], { leftKey: 'id', type: 'full' }), [
  { id: 1, name: 'A', 'right.name': 'Right A', extra: true },
  { id: 2, name: 'B' },
  { id: 3, extra: false }
]);
assert.throws(() => joinDatasets([{ id: 1 }, { id: 1 }], [{ id: 1 }, { id: 1 }], { leftKey: 'id', maxRows: 3 }), /exceeds/);

// Notebook model and local JavaScript evaluation.
const notebook = serializeNotebook([{ language: 'javascript', source: 'return 4;', output: '4', state: 'success' }], { title: 'Fixture' });
assert.equal(notebook.format, 'm13-local-notebook');
assert.equal(notebook.cells[0].id, 'cell-1');
const importedNotebook = parseNotebook(JSON.stringify(serializeNotebook([{ language: 'markdown', source: '# Local', state: 'success' }], { title: 'Imported' })));
assert.equal(importedNotebook.metadata.title, 'Imported');
assert.equal(importedNotebook.cells[0].language, 'markdown');
const evaluated = await evaluateJavaScriptCell('console.log("rows", data.length); return data.reduce((a, b) => a + b, 0);', { data: [1, 2, 3] });
assert.deepEqual(evaluated, { logs: ['rows 3'], result: 6 });

// Regex extraction keeps offsets, captures, named groups, and validates flags.
const regex = runRegex('(?<word>[a-z]+)-(\\d+)', 'gi', 'One-12 two-345');
assert.equal(regex.matches.length, 2);
assert.deepEqual(regex.matches[1].groups, ['two', '345']);
assert.deepEqual(regex.matches[1].namedGroups, { word: 'two' });
assert.deepEqual([regex.matches[1].index, regex.matches[1].end], [7, 14]);
assert.throws(() => runRegex('x', 'gg', 'x'), /duplicated/);

// Git HEAD/config/reflog/packed and snapshot parsing.
assert.deepEqual(parseGitHead('ref: refs/heads/main\n'), { type: 'symbolic', ref: 'refs/heads/main', branch: 'main' });
assert.deepEqual(parseGitHead('a'.repeat(40)), { type: 'detached', oid: 'a'.repeat(40), branch: null });
const gitConfig = parseGitConfig('[core]\n\tbare = false\n[user]\n\tname = Local User\n\temail = local@example.test\n[remote "origin"]\n\turl = https://token@example.test/repo.git?access=secret\n');
assert.equal(gitConfig.core.bare, 'false');
assert.equal(gitConfig.remotes[0].name, 'origin');
const safeGitConfig = sanitizeGitConfig(gitConfig);
assert.equal(safeGitConfig.identity.email, '[redacted]');
assert.doesNotMatch(JSON.stringify(safeGitConfig), /token|access=secret|local@example\.test/);
const logLine = `${'0'.repeat(40)} ${'1'.repeat(40)} Local User <local@example.test> 1700000000 -0300\tcommit: fixture`;
assert.equal(parseGitLog(logLine)[0].message, 'commit: fixture');
assert.deepEqual(parsePackedRefs(`# pack-refs\n${'2'.repeat(40)} refs/heads/main\n${'3'.repeat(40)} refs/tags/v1\n^${'4'.repeat(40)}\n`), [
  { oid: '2'.repeat(40), ref: 'refs/heads/main' },
  { oid: '3'.repeat(40), ref: 'refs/tags/v1', peeled: '4'.repeat(40) }
]);
const gitSnapshot = analyzeGitSnapshot([
  { path: 'repo/.git/HEAD', text: 'ref: refs/heads/main\n' },
  { path: 'repo/.git/config', text: '[core]\n bare = false\n' },
  { path: 'repo/.git/refs/heads/main', text: `${'1'.repeat(40)}\n` },
  { path: 'repo/.git/logs/HEAD', text: logLine }
]);
assert.equal(gitSnapshot.head.branch, 'main');
assert.deepEqual(gitSnapshot.refs, [{ ref: 'refs/heads/main', oid: '1'.repeat(40) }]);
assert.equal(gitSnapshot.reflog.length, 1);
const gitFs = createGitMemoryFs([
  { path: '/repo/.git/HEAD', text: 'ref: refs/heads/main\n', lastModified: 1_700_000_000_000 },
  { path: '/repo/README.md', bytes: new TextEncoder().encode('fixture') }
]);
assert.equal(await gitFs.promises.readFile('/repo/.git/HEAD', 'utf8'), 'ref: refs/heads/main\n');
assert.deepEqual(await gitFs.promises.readdir('/repo'), ['.git', 'README.md']);
assert.equal((await gitFs.promises.stat('/repo/README.md')).isFile(), true);
await assert.rejects(() => gitFs.promises.writeFile('/repo/new', 'x'), (error) => error.code === 'EROFS');
const gitRuntime = await import('../vendor/suite/isomorphic-git.js');
const mutableGitFs = createGitMemoryFs([], { mutable: true });
await gitRuntime.init({ fs: mutableGitFs, dir: '/repo', defaultBranch: 'main' });
await mutableGitFs.promises.writeFile('/repo/README.md', 'virtual fixture\n');
await gitRuntime.add({ fs: mutableGitFs, dir: '/repo', filepath: 'README.md' });
const virtualCommitMetadata = prepareGitCommitMetadata({ message: 'virtual fixture', authorName: 'Test', authorEmail: 'test@example.test', branch: 'main', timestamp: 1_700_000_000_000 });
const virtualOid = await gitRuntime.commit({ fs: mutableGitFs, dir: '/repo', message: virtualCommitMetadata.message, author: { ...virtualCommitMetadata.author, timestamp: 1_700_000_000, timezoneOffset: 0 } });
assert.match(virtualOid, /^[a-f0-9]{40}$/);
assert.equal(await gitRuntime.currentBranch({ fs: mutableGitFs, dir: '/repo' }), 'main');
assert.deepEqual((await gitRuntime.statusMatrix({ fs: mutableGitFs, dir: '/repo' }))[0], ['README.md', 1, 1, 1]);
await gitRuntime.branch({ fs: mutableGitFs, dir: '/repo', ref: 'feature/local', checkout: true });
assert.equal(await gitRuntime.currentBranch({ fs: mutableGitFs, dir: '/repo' }), 'feature/local');
assert.deepEqual(await gitRuntime.listBranches({ fs: mutableGitFs, dir: '/repo' }), ['feature/local', 'main']);
const gitRuntimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'm13-isomorphic-git-'));
try {
  await gitRuntime.init({ fs, dir: gitRuntimeDirectory, defaultBranch: 'main' });
  await writeFile(path.join(gitRuntimeDirectory, 'README.md'), 'fixture\n');
  await gitRuntime.add({ fs, dir: gitRuntimeDirectory, filepath: 'README.md' });
  const oid = await gitRuntime.commit({
    fs, dir: gitRuntimeDirectory, message: 'fixture',
    author: { name: 'Test', email: 'test@example.test', timestamp: 1_700_000_000, timezoneOffset: 0 }
  });
  assert.equal(oid, 'ffcf30ab56b1a4fc7564900d1714cbaefe8a025d');
  assert.equal(await gitRuntime.currentBranch({ fs, dir: gitRuntimeDirectory }), 'main');
  assert.equal((await gitRuntime.log({ fs, dir: gitRuntimeDirectory }))[0].commit.message.trim(), 'fixture');
} finally { await rm(gitRuntimeDirectory, { recursive: true, force: true }); }

// Binary differences, reversible local patch, and entropy windows.
const base = Uint8Array.from([0, 1, 2, 3, 4, 5]);
const target = Uint8Array.from([0, 1, 9, 8, 4, 5, 6]);
const binaryDiff = diffBytes(base, target);
assert.equal(binaryDiff.changedBytes, 3);
assert.deepEqual(binaryDiff.runs.map((run) => [run.offset, run.length]), [[2, 2], [6, 1]]);
const binaryPatch = createBinaryPatch(base, target);
assert.deepEqual(applyBinaryPatch(base, binaryPatch), target);
assert.throws(() => applyBinaryPatch(Uint8Array.from([1]), binaryPatch), /base file/);
assert.throws(() => applyBinaryPatch(base, { ...binaryPatch, targetSize: 64 * 1024 * 1024 + 1 }), /64 MiB/);
assert.throws(() => applyBinaryPatch(base, { ...binaryPatch, changes: Array.from({ length: 10_001 }, () => ({ offset: 0, data: '' })) }), /10,000/);
assert.equal(entropyWindows(new Uint8Array(512), 256).length, 2);
assert.equal(entropyWindows(new Uint8Array(512), 256)[0].entropy, 0);

// Web playground generation and real WebAssembly structural/browser validation.
const minimalWasm = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
assert.deepEqual(parseWasmSections(minimalWasm), { version: 1, sections: [] });
assert.equal(inspectWasmModule(minimalWasm).validated, true);
assert.throws(() => parseWasmSections(Uint8Array.from([0, 97, 115, 109, 2, 0, 0, 0])), /version 2/);
const preview = buildPreviewDocument({ html: '<h1>Test</h1>', css: 'h1{color:red}', javascript: "document.body.dataset.ok='1';</script><img src=x>" });
assert.match(preview, /default-src 'none'/);
assert.equal(preview.includes("</script><img src=x>"), false);

// Deterministic classic PCAP with one Ethernet/IPv4/UDP/DNS query packet.
function makeDnsPcap() {
  const dnsName = Uint8Array.from([7, ...new TextEncoder().encode('example'), 3, ...new TextEncoder().encode('com'), 0]);
  const dns = new Uint8Array(12 + dnsName.length + 4);
  const dnsView = new DataView(dns.buffer);
  dnsView.setUint16(0, 0x1234); dnsView.setUint16(2, 0x0100); dnsView.setUint16(4, 1);
  dns.set(dnsName, 12); dnsView.setUint16(12 + dnsName.length, 1); dnsView.setUint16(14 + dnsName.length, 1);
  const udp = new Uint8Array(8 + dns.length);
  const udpView = new DataView(udp.buffer);
  udpView.setUint16(0, 53_000); udpView.setUint16(2, 53); udpView.setUint16(4, udp.length); udp.set(dns, 8);
  const ip = new Uint8Array(20 + udp.length);
  const ipView = new DataView(ip.buffer);
  ip[0] = 0x45; ipView.setUint16(2, ip.length); ip[8] = 64; ip[9] = 17;
  ip.set([192, 0, 2, 10], 12); ip.set([8, 8, 8, 8], 16); ip.set(udp, 20);
  const ethernet = new Uint8Array(14 + ip.length);
  ethernet.set([0, 1, 2, 3, 4, 5], 0); ethernet.set([6, 7, 8, 9, 10, 11], 6); ethernet.set([0x08, 0x00], 12); ethernet.set(ip, 14);
  const pcap = new Uint8Array(24 + 16 + ethernet.length);
  pcap.set([0xd4, 0xc3, 0xb2, 0xa1], 0);
  const view = new DataView(pcap.buffer);
  view.setUint16(4, 2, true); view.setUint16(6, 4, true); view.setUint32(16, 65_535, true); view.setUint32(20, 1, true);
  view.setUint32(24, 1_700_000_000, true); view.setUint32(28, 500_000, true); view.setUint32(32, ethernet.length, true); view.setUint32(36, ethernet.length, true);
  pcap.set(ethernet, 40);
  return { pcap, ethernet };
}
const fixtureCapture = makeDnsPcap();
assert.equal(detectFileType(fixtureCapture.pcap, 'capture.bin').id, 'pcap');
const decodedPacket = decodeNetworkPacket(fixtureCapture.ethernet, 1);
assert.equal(decodedPacket.protocol, 'DNS');
assert.equal(decodedPacket.source, '192.0.2.10');
assert.equal(decodedPacket.destination, '8.8.8.8');
assert.match(decodedPacket.info, /example\.com/);
const ipv6Udp = new Uint8Array(48);
ipv6Udp[0] = 0x60; new DataView(ipv6Udp.buffer).setUint16(4, 8); ipv6Udp[6] = 17; ipv6Udp[7] = 64;
ipv6Udp.set([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 8);
ipv6Udp.set([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], 24);
const ipv6View = new DataView(ipv6Udp.buffer); ipv6View.setUint16(40, 1_234); ipv6View.setUint16(42, 53); ipv6View.setUint16(44, 8);
const decodedIpv6 = decodeNetworkPacket(ipv6Udp, 101);
assert.equal(decodedIpv6.protocol, 'DNS');
assert.equal(decodedIpv6.source, '2001:db8:0:0:0:0:0:1');
assert.equal(decodedIpv6.destinationPort, 53);
const capture = parsePcap(fixtureCapture.pcap);
assert.equal(capture.format, 'pcap');
assert.equal(capture.version, '2.4');
assert.equal(capture.packets.length, 1);
assert.equal(capture.packets[0].timestampSeconds, 1_700_000_000.5);
assert.equal(capture.packets[0].protocol, 'DNS');
function makePcapNg(packet) {
  const section = new Uint8Array(28);
  const sectionView = new DataView(section.buffer);
  section.set([0x0a, 0x0d, 0x0d, 0x0a]); sectionView.setUint32(4, 28, true); sectionView.setUint32(8, 0x1a2b3c4d, true);
  sectionView.setUint16(12, 1, true); sectionView.setUint16(14, 0, true); section.fill(0xff, 16, 24); sectionView.setUint32(24, 28, true);
  const interfaceBlock = new Uint8Array(20);
  const interfaceView = new DataView(interfaceBlock.buffer);
  interfaceView.setUint32(0, 1, true); interfaceView.setUint32(4, 20, true); interfaceView.setUint16(8, 1, true); interfaceView.setUint32(12, 65_535, true); interfaceView.setUint32(16, 20, true);
  const paddedLength = Math.ceil(packet.length / 4) * 4;
  const enhanced = new Uint8Array(32 + paddedLength);
  const enhancedView = new DataView(enhanced.buffer);
  enhancedView.setUint32(0, 6, true); enhancedView.setUint32(4, enhanced.length, true); enhancedView.setUint32(8, 0, true);
  enhancedView.setUint32(12, 0, true); enhancedView.setUint32(16, 2_000_000, true); enhancedView.setUint32(20, packet.length, true); enhancedView.setUint32(24, packet.length, true);
  enhanced.set(packet, 28); enhancedView.setUint32(enhanced.length - 4, enhanced.length, true);
  const output = new Uint8Array(section.length + interfaceBlock.length + enhanced.length);
  output.set(section); output.set(interfaceBlock, section.length); output.set(enhanced, section.length + interfaceBlock.length);
  return output;
}
const pcapNg = parsePcap(makePcapNg(fixtureCapture.ethernet));
assert.equal(pcapNg.format, 'pcapng');
assert.deepEqual(pcapNg.linkTypes, [1]);
assert.equal(pcapNg.packets[0].timestampSeconds, 2);
assert.equal(pcapNg.packets[0].protocol, 'DNS');
const truncatedCapture = fixtureCapture.pcap.slice(0, -1);
assert.throws(() => parsePcap(truncatedCapture), /packet length/);

console.log('Data/developer suite tests passed: 13 keys; byte formats, AES-GCM vault, SQLite/Parquet inspection, datasets/SQL/charts, notebook/regex, Git/diff/WASM, and PCAP decoding.');
