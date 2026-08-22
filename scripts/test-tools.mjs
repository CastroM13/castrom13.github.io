import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.document = { querySelector: () => null };

const { sanitizeHar } = await import('../assets/tools/harsafe.js');
const { normalize, safeReport } = await import('../assets/tools/statescope.js');
const { scanLine } = await import('../assets/tools/secretsweep.js');
const { createExportReport } = await import('../assets/tools/tokendesk.js');
const { datasetExportReport } = await import('../assets/tools/dataset-clinic.js');
const { redactLogLine } = await import('../assets/tools/logglass-redaction.js');

const harSource = JSON.parse(await readFile(path.join(root, 'tests/fixtures/sample.har'), 'utf8'));
const harResult = sanitizeHar(harSource, { removeBodies: true, maskNetwork: true, allQuery: false });
const safeHar = JSON.stringify(harResult.har);
for (const secret of ['fixture-user', 'fixture-pass', 'fixture-query-secret', 'fixture-bearer-secret', 'fixture-cookie-secret', 'fixture-body-secret', 'fixture-response-token', '10.0.0.7']) {
  assert.equal(safeHar.includes(secret), false, `sanitized HAR leaked ${secret}`);
}
assert.match(safeHar, /ok=1/);
assert.equal(harResult.har.log.entries[0].time, 125.5);
assert.equal(harSource.log.entries[0].request.headers[0].value, 'Bearer fixture-bearer-secret', 'source HAR was mutated');

const formHar = structuredClone(harSource);
formHar.log.entries[0].request.postData.params = [
  { name: 'email', value: 'person@example.com' },
  { name: 'code', value: '123456' }
];
const sanitizedFormHar = JSON.stringify(sanitizeHar(formHar, { removeBodies: true, maskNetwork: true, allQuery: false }).har);
assert.equal(sanitizedFormHar.includes('person@example.com'), false, 'sanitized HAR leaked a regular form value');
assert.equal(sanitizedFormHar.includes('123456'), false, 'sanitized HAR leaked a non-secret-named form value');

const extendedHar = structuredClone(harSource);
const extendedEntry = extendedHar.log.entries[0];
extendedEntry.request.url = 'https://example.test/path?sig=fixture-url-signature';
extendedEntry.request.queryString = [{ name: 'signature', value: 'fixture-query-signature' }];
extendedEntry.request.headers.push({ name: 'X-Signature', value: 'fixture-header-signature' });
extendedEntry.request.postData.params = [{ name: 'upload', value: 'fixture-upload-value', fileName: 'fixture-private-filename.txt' }];
extendedEntry.response.headers.push({ name: 'Location', value: '/next?code=fixture-location-code' });
extendedEntry.response.redirectURL = '//fixture-redirect-user:fixture-redirect-pass@example.test/next?sig=fixture-redirect-code';
const extendedSanitizedHar = JSON.stringify(sanitizeHar(extendedHar, { removeBodies: true, maskNetwork: true, allQuery: false }).har);
for (const secret of ['fixture-url-signature', 'fixture-query-signature', 'fixture-header-signature', 'fixture-upload-value', 'fixture-private-filename.txt', 'fixture-location-code', 'fixture-redirect-code', 'fixture-redirect-user', 'fixture-redirect-pass']) {
  assert.equal(extendedSanitizedHar.includes(secret), false, `sanitized HAR leaked ${secret}`);
}

const stateSource = JSON.parse(await readFile(path.join(root, 'tests/fixtures/sample.tfstate'), 'utf8'));
const inventory = normalize(stateSource, (english) => english);
const report = JSON.stringify(safeReport(inventory, true));
for (const secret of ['fixture-lineage-secret', 'fixture-db-secret', 'fixture-resource-secret', 'fixture-private-blob']) {
  assert.equal(report.includes(secret), false, `StateScope report leaked ${secret}`);
}
assert.equal(inventory.resources.length, 2);
assert.equal(report.includes('resource-001'), true);
for (const resource of inventory.resources) {
  assert.equal(report.includes(resource.address), false, `StateScope pseudonymized report leaked address ${resource.address}`);
  for (const dependency of resource.dependencies) assert.equal(report.includes(dependency), false, `StateScope pseudonymized report leaked dependency ${dependency}`);
}

const secretFindings = scanLine('token=ghp_abcdefghijklmnopqrstuvwxyz1234567890 checksum=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', true);
assert.equal(secretFindings.some((finding) => finding.type === 'GitHub token'), true);
assert.equal(secretFindings.some((finding) => finding.preview.includes('abcdefghijklmnopqrstuvwxyz')), false);
assert.equal(secretFindings.filter((finding) => finding.type === 'High-entropy value').length, 0, 'checksum should be suppressed');

const tokenReport = JSON.stringify(createExportReport(
  { alg: 'HS256', typ: 'JWT', kid: 'fixture-sensitive-key-id', privateHeader: 'fixture-private-header' },
  { sub: 'fixture-subject', user: { email: 'fixture@example.com' }, custom: 'fixture-custom-claim', exp: 2_000_000_000 },
  { state: 'unverified', label: 'fixture-verification-detail' },
  [{ state: 'warning', label: 'fixture-finding-detail' }]
));
for (const secret of ['fixture-sensitive-key-id', 'fixture-private-header', 'fixture-subject', 'fixture@example.com', 'fixture-custom-claim', 'fixture-verification-detail', 'fixture-finding-detail']) {
  assert.equal(tokenReport.includes(secret), false, `TokenDesk minimal report leaked ${secret}`);
}

const datasetReport = JSON.stringify(datasetExportReport({
  tool: 'Dataset Clinic',
  issues: [{ severity: 'error', item: 'train/private/a.jpg', relatedItem: 'validation/private/a.jpg', rule: 'split-leakage', remedy: 'Byte-identical file detected.' }]
}, true));
for (const privatePath of ['train/private/a.jpg', 'validation/private/a.jpg']) assert.equal(datasetReport.includes(privatePath), false, `Dataset report leaked ${privatePath}`);
assert.match(datasetReport, /item-00001/);
assert.match(datasetReport, /item-00002/);

const redactedLog = redactLogLine('token=fixture-query-secret password="fixture-password" url=https://example.test/?code=fixture-code user=person@example.com', { email: true, ip: false });
for (const secret of ['fixture-query-secret', 'fixture-password', 'fixture-code', 'person@example.com']) assert.equal(redactedLog.includes(secret), false, `LogGlass redaction leaked ${secret}`);
assert.match(redactedLog, /\[REDACTED\]/);

console.log('Tool privacy fixtures passed: HAR/LogGlass redaction, StateScope/Dataset pseudonymization, SecretSweep masking, and TokenDesk minimal export.');
