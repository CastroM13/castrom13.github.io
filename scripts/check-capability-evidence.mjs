import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suiteTools } from './suite-tool-data.mjs';
import { capabilityEvidence } from './tool-capability-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(capabilityEvidence.length, 50, 'The original request must have exactly 50 evidence rows.');
assert.deepEqual(capabilityEvidence.map((item) => item.index), Array.from({ length: 50 }, (_, index) => index + 1));
assert.deepEqual(capabilityEvidence.map((item) => item.key), suiteTools.map((item) => item.key), 'Evidence order must match the 50 generated tools.');
assert.equal(new Set(capabilityEvidence.map((item) => item.key)).size, 50, 'Evidence keys must be unique.');

const cache = new Map();
async function source(file) {
  if (!cache.has(file)) cache.set(file, await readFile(path.join(root, file), 'utf8'));
  return cache.get(file);
}

let anchors = 0; let runtimeRows = 0;
for (const item of capabilityEvidence) {
  assert.ok(item.original.length >= 12, `${item.key} needs the original capability statement.`);
  assert.ok(item.implementation.length, `${item.key} needs implementation evidence.`);
  assert.ok(item.automated.length, `${item.key} needs automated evidence.`);
  if (item.runtime.length) runtimeRows += 1;
  for (const [kind, groups] of Object.entries({ implementation: item.implementation, automated: item.automated, runtime: item.runtime })) {
    for (const group of groups) {
      assert.ok(Array.isArray(group.markers) && group.markers.length, `${item.key} ${kind} anchor has no markers.`);
      const text = await source(group.file);
      for (const marker of group.markers) {
        assert.ok(marker.length >= 6, `${item.key} ${kind} marker is too vague: ${marker}`);
        assert.ok(text.includes(marker), `${item.key} ${kind} evidence missing in ${group.file}: ${marker}`);
        anchors += 1;
      }
    }
  }
}

const browserCheck = await source('scripts/check-tools-browser.mjs');
assert.match(browserCheck, /suiteTools\.slice/);
assert.match(browserCheck, /check\(tool, 'en'\)/);
assert.match(browserCheck, /check\(tool, 'pt'\)/);
console.log(`Verified capability evidence: 50/50 original tool rows, ${anchors} checked anchors, ${runtimeRows} deep browser/runtime rows, plus EN/PT route smoke coverage for every tool.`);
