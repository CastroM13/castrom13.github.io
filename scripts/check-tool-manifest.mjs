import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allTools, newTools, toolRoutes } from './tool-data.mjs';
import { suiteTools } from './suite-tool-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredLocalized = ['status', 'title', 'description', 'paths'];
const requiredGeneratedLocalized = ['subtitle', 'privacy', 'note', 'limits'];

assert.equal(allTools.length, 63, 'manifest must contain the original 13 plus 50 requested tools');
assert.equal(newTools.length, 60, 'generated manifest must contain the previous 10 plus 50 requested tools');
assert.equal(suiteTools.length, 50, 'requested suite must contain exactly 50 entries');
assert.equal(toolRoutes.length, 126, 'every tool must have two localized routes');

for (const field of ['key', 'index']) {
  const values = field === 'key' ? allTools.map((tool) => tool.key).filter(Boolean) : allTools.map((tool) => tool.index);
  if (field === 'key') assert.equal(values.length, newTools.length, 'every generated tool must have a key');
  assert.equal(new Set(values).size, values.length, `${field} values must be unique`);
}

assert.deepEqual(allTools.map((tool) => Number(tool.index)), Array.from({ length: 63 }, (_, index) => index + 1), 'tool indices must remain contiguous from 01 through 63');
assert.equal(new Set(toolRoutes).size, toolRoutes.length, 'localized tool routes must be unique');

for (const tool of allTools) {
  for (const field of requiredLocalized) {
    assert.ok(tool[field]?.en && tool[field]?.pt, `${tool.index} ${field} must contain en and pt`);
  }
  if (tool.key) for (const field of requiredGeneratedLocalized) assert.ok(tool[field]?.en && tool[field]?.pt, `${tool.key} ${field} must contain en and pt`);
  assert.match(tool.paths.en, /^\/[^?#]+\/$/, `${tool.index} English route must be root-relative and trailing-slash`);
  assert.match(tool.paths.pt, /^\/pt-br\/[^?#]+\/$/, `${tool.index} Portuguese route must be under /pt-br/`);
  if (!tool.key) continue;
  const script = tool.script || `/assets/tools/${tool.key}.js`;
  await access(path.join(root, script.slice(1)));
  await access(path.join(root, tool.paths.en.slice(1), 'index.html'));
  await access(path.join(root, tool.paths.pt.slice(1), 'index.html'));
  const english = await readFile(path.join(root, tool.paths.en.slice(1), 'index.html'), 'utf8');
  const portuguese = await readFile(path.join(root, tool.paths.pt.slice(1), 'index.html'), 'utf8');
  assert.match(english, new RegExp(`data-tool-root="${tool.key}"`));
  assert.match(portuguese, new RegExp(`data-tool-root="${tool.key}"`));
  assert.ok(english.includes(`src="${script}"`), `${tool.key} English page must load its declared script`);
  assert.ok(portuguese.includes(`src="${script}"`), `${tool.key} Portuguese page must load its declared script`);
}

const englishDirectory = await readFile(path.join(root, 'tools/index.html'), 'utf8');
const portugueseDirectory = await readFile(path.join(root, 'pt-br/ferramentas/index.html'), 'utf8');
assert.equal([...englishDirectory.matchAll(/class="directory-card"/g)].length, 63, 'English directory must list every tool exactly once');
assert.equal([...portugueseDirectory.matchAll(/class="directory-card"/g)].length, 63, 'Portuguese directory must list every tool exactly once');

const sitemap = await readFile(path.join(root, 'sitemap.xml'), 'utf8');
for (const route of toolRoutes) assert.ok(sitemap.includes(`https://castrom13.dev${route}`), `sitemap is missing ${route}`);

console.log('Validated 63 tools, 126 localized routes, contiguous metadata, generated pages, scripts, directories, and sitemap coverage.');
