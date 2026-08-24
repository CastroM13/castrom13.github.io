import { access, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { suiteTools } from './suite-tool-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineeringFixtures = path.join(root, 'tests', 'fixtures', 'suite-engineering-ai');
const engineeringSearchFixtures = path.join(engineeringFixtures, 'search-files');
const dataDeveloperFixtures = path.join(root, 'tests', 'fixtures', 'suite-data-developer');
const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
let executablePath = null;
for (const candidate of candidates) try { await access(candidate); executablePath = candidate; break; } catch (_) { /* keep looking */ }
if (!executablePath) { console.log('Browser smoke skipped: set CHROME_PATH to a Chromium executable.'); process.exit(0); }

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Unsafe path');
    const info = await stat(target); if (!info.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'content-type': mime[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'cross-origin'
    });
    response.end(await readFile(target));
  } catch (_) { response.writeHead(404); response.end('Not found'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const browser = await chromium.launch({ executablePath, headless: true });
const failures = [];
const selectedStages = new Set(String(process.env.BROWSER_CHECK_ONLY || '').split(',').map((value) => value.trim()).filter(Boolean));
const shouldRun = (stage) => !selectedStages.size || selectedStages.has(stage);

async function check(tool, language) {
  const page = await browser.newPage({ locale: language === 'pt' ? 'pt-BR' : 'en-US', colorScheme: 'dark', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') { const location = message.location(); errors.push(`${message.text()}${location.url ? ` (${location.url}:${location.lineNumber || 0})` : ''}`); } });
  try {
    const route = tool.paths[language];
    const response = await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    if (!response?.ok()) throw new Error(`HTTP ${response?.status()}`);
    await page.waitForSelector(`[data-tool-root="${tool.key}"] .workbench-layout`, { timeout: 10_000 });
    const loading = await page.locator(`[data-tool-root="${tool.key}"] .tool-loading`).count();
    if (loading) throw new Error('loading placeholder was not replaced');
    const heading = await page.locator('h1').textContent();
    if (!heading?.trim()) throw new Error('missing visible heading');
    if (errors.length) throw new Error(errors.join(' | '));
  } catch (error) { failures.push(`${tool.key} (${language}): ${error.message}`); }
  finally { await page.close(); }
}

async function checkDirectory(language) {
  const page = await browser.newPage({
    locale: language === 'pt' ? 'pt-BR' : 'en-US',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 }
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') { const location = message.location(); errors.push(`${message.text()}${location.url ? ` (${location.url}:${location.lineNumber || 0})` : ''}`); } });
  try {
    const route = language === 'pt' ? '/pt-br/ferramentas/' : '/tools/';
    const response = await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    if (!response?.ok()) throw new Error(`HTTP ${response?.status()}`);
    await page.waitForSelector('[data-tool-filter]', { timeout: 10_000 });
    const hero = (await page.locator('.page-hero h1').textContent() || '').trim();
    const expectedHero = language === 'pt' ? 'Ferramentas pequenas. Problemas reais. Dados respeitados.' : 'Small tools. Real problems. Data respected.';
    if (hero !== expectedHero) throw new Error(`localized directory hero was ${JSON.stringify(hero)}`);
    if (await page.locator('[data-tool-card]').count() !== 63) throw new Error('directory does not contain 63 tool cards');
    await page.locator('[data-tool-search]').fill('Gerber');
    if (await page.locator('[data-tool-card]:visible').count() !== 1) throw new Error('text filter did not isolate the Gerber tool');
    await page.locator('[data-tool-filter] button[type="reset"]').click();
    await page.waitForTimeout(50);
    await page.locator('[data-tool-category]').selectOption('DesignApplication');
    const designCount = await page.locator('[data-tool-card]:visible').count();
    if (designCount < 5 || designCount >= 63) throw new Error(`category filter returned ${designCount} cards`);
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    if (overflows) throw new Error('directory overflows the mobile viewport');
    const mobileBorders = await page.locator('[data-tool-card]:visible').evaluateAll((cards) => cards.map((card) => getComputedStyle(card).borderBottomWidth));
    if (mobileBorders.slice(0, -1).some((width) => width === '0px') || mobileBorders.at(-1) !== '0px') throw new Error('mobile card separators do not follow visible-card order');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-tool-category]').selectOption('UtilitiesApplication');
    const desktopBorders = await page.locator('[data-tool-card]:visible').evaluateAll((cards) => cards.map((card, index) => {
      const style = getComputedStyle(card); const lastRowSize = cards.length % 3 || Math.min(3, cards.length); const lastRowStart = cards.length - lastRowSize;
      return { index, right: style.borderRightWidth, bottom: style.borderBottomWidth, expectRightZero: (index + 1) % 3 === 0, expectBottomZero: index >= lastRowStart };
    }));
    if (!desktopBorders.length || desktopBorders.some((item) => (item.right === '0px') !== item.expectRightZero || (item.bottom === '0px') !== item.expectBottomZero)) throw new Error('desktop filtered-card borders do not follow visible grid positions');
    if (errors.length) throw new Error(errors.join(' | '));
  } catch (error) { failures.push(`directory (${language}): ${error.message}`); }
  finally { await page.close(); }
}

async function openWorkflowTool(page, route, key) {
  const response = await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  if (!response?.ok()) throw new Error(`${key} returned HTTP ${response?.status()}`);
  await page.waitForSelector(`[data-tool-root="${key}"] .workbench-layout`, { timeout: 10_000 });
}

async function assertWorkflowText(page, selector, pattern, label) {
  const value = await page.locator(selector).textContent();
  if (!pattern.test(value || '')) throw new Error(`${label}: ${JSON.stringify(value)}`);
}

async function checkWorkflow(label, action) {
  const page = await browser.newPage({ locale: 'en-US', colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') { const location = message.location(); errors.push(`${message.text()}${location.url ? ` (${location.url}:${location.lineNumber || 0})` : ''}`); } });
  try {
    await action(page);
    if (errors.length) throw new Error(errors.join(' | '));
  } catch (error) { failures.push(`${label}: ${error.message}`); }
  finally { await page.close(); }
}

async function checkStandaloneFixture(label, route, timeout = 15_000) {
  await checkWorkflow(label, async (page) => {
    const response = await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'domcontentloaded', timeout });
    if (!response?.ok()) throw new Error(`HTTP ${response?.status()}`);
    await page.waitForFunction(() => ['pass', 'fail'].includes(document.body.dataset.result), null, { timeout });
    const result = await page.locator('body').getAttribute('data-result');
    const detail = await page.locator('#result').count() ? await page.locator('#result').textContent() : await page.locator('body').textContent();
    if (result !== 'pass') throw new Error(detail || 'fixture failed without a result');
  });
}

async function readDownloadedBytes(page, locator) {
  const [download] = await Promise.all([page.waitForEvent('download'), locator.click()]);
  const stream = await download.createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function pdfFixtures() {
  const first = await PDFDocument.create(); const font = await first.embedFont(StandardFonts.Helvetica);
  first.setTitle('Metadata to strip');
  const pageOne = first.addPage([300, 200]); pageOne.drawText('Page one', { x: 30, y: 150, size: 18, font, color: rgb(0.1, 0.2, 0.3) });
  const pageTwo = first.addPage([400, 250]); pageTwo.drawText('Page two', { x: 30, y: 190, size: 18, font });
  const field = first.getForm().createTextField('Name'); field.setText('Original'); field.addToPage(pageOne, { x: 30, y: 70, width: 160, height: 24, font });
  const second = await PDFDocument.create(); const secondFont = await second.embedFont(StandardFonts.Helvetica);
  second.addPage([500, 300]).drawText('Third page', { x: 40, y: 240, size: 20, font: secondFont });
  return {
    first: Buffer.from(await first.save({ useObjectStreams: false })),
    second: Buffer.from(await second.save({ useObjectStreams: false })),
    signature: await readFile(path.join(root, 'assets', 'thumbnail-fallback.png'))
  };
}

async function checkRepresentativeWorkflows() {
  await Promise.all([
    checkWorkflow('media-foundation / SVG Studio workflow', async (page) => {
      await openWorkflowTool(page, '/tools/svg-studio/', 'svg-studio');
      await page.locator('[data-source]').fill('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><script>alert(1)</script><a href="https://example.test/tracker" onclick="alert(2)"><path d="M2 2h36v36H2z"/></a></svg>');
      await page.locator('[data-scale]').fill('2');
      await page.locator('[data-rotate]').fill('30');
      await page.locator('[data-form] button[type="submit"]').click();
      await page.waitForSelector('[data-status][data-kind="success"]', { timeout: 10_000 });
      const markup = await page.locator('[data-code]').textContent() || '';
      if (!/translate\(0 0\) rotate\(30\) scale\(2\)/.test(markup)) throw new Error('sanitized SVG omitted the requested transform');
      if (/<script|\bonclick\b|example\.test/i.test(markup)) throw new Error(`unsafe SVG content survived sanitization: ${markup}`);
      const preview = await page.locator('[data-preview]').getAttribute('src');
      if (!preview?.startsWith('blob:')) throw new Error(`sanitized SVG preview was not a Blob URL: ${preview}`);
      await assertWorkflowText(page, '[data-metrics]', /Paths\s*1/i, 'SVG metrics did not report the retained path');
    }),

    checkWorkflow('media-foundation / Pixel editor workflow', async (page) => {
      await openWorkflowTool(page, '/tools/pixel-texture-editor/', 'pixel-texture-editor');
      await page.locator('[data-new]').click();
      await page.waitForSelector('[data-status][data-kind="success"]', { timeout: 10_000 });
      const canvas = page.locator('[data-canvas]');
      const dimensions = await canvas.evaluate((element) => [element.width, element.height]);
      if (dimensions[0] !== 1024 || dimensions[1] !== 1024) throw new Error(`blank paint canvas was ${dimensions.join('x')} instead of 1024x1024`);
      if (await page.locator('[data-layers] li').count() !== 1) throw new Error('blank paint layer was not added');
      if (!await page.locator('[data-apply-filter]').isEnabled() || !await page.locator('[data-export]').isEnabled()) throw new Error('pixel editor actions remained disabled after adding a layer');
      await canvas.scrollIntoViewIfNeeded();
      const box = await canvas.boundingBox();
      if (!box || box.width < 10 || box.height < 10) throw new Error('pixel editor canvas has no drawable bounds');
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.42, { steps: 8 });
      await page.mouse.up();
      const painted = await canvas.evaluate((element) => {
        const context = element.getContext('2d');
        const pixels = context.getImageData(250, 250, 220, 220).data;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] === 255) return { x: 250 + index / 4 % 220, y: 250 + Math.floor(index / 4 / 220), rgba: [...pixels.slice(index, index + 4)] };
        }
        return null;
      });
      if (!painted) throw new Error('pointer drawing did not create an opaque brush stroke');
      await page.locator('[data-filter]').selectOption('invert');
      await page.locator('[data-apply-filter]').click();
      await assertWorkflowText(page, '[data-status][data-kind="success"]', /Applied invert/i, 'pixel filter did not report completion');
      const filtered = await canvas.evaluate((element, point) => [...element.getContext('2d').getImageData(point.x, point.y, 1, 1).data], painted);
      if (filtered[3] !== painted.rgba[3] || filtered.slice(0, 3).some((value, index) => Math.abs(value + painted.rgba[index] - 255) > 1)) throw new Error(`invert output did not complement the painted pixel: ${painted.rgba} -> ${filtered}`);
    }),

    checkWorkflow('media-documents / Subtitle editor workflow', async (page) => {
      await openWorkflowTool(page, '/tools/subtitle-editor/', 'subtitle-editor');
      await page.locator('[data-source]').fill('1\n00:00:01,000 --> 00:00:02,500\nHello local\n\n2\n00:00:03,000 --> 00:00:04,000\nPrivate files stay here.\n');
      await page.locator('[data-offset]').fill('0.5');
      await page.locator('[data-find]').fill('Hello');
      await page.locator('[data-replacement]').fill('Olá');
      await page.locator('[data-apply]').click();
      await page.waitForSelector('[data-status][data-kind="success"]', { timeout: 10_000 });
      if (await page.locator('[data-cues] tr').count() !== 2) throw new Error('subtitle parser did not retain both cues');
      await assertWorkflowText(page, '[data-cues] tr:first-child', /00:00:01\.500[\s\S]*Olá/, 'subtitle timing/text transform was not rendered');
      await assertWorkflowText(page, '[data-metrics]', /Cues\s*2[\s\S]*Validation issues\s*0/i, 'subtitle metrics did not confirm two valid cues');
      if (!await page.locator('[data-download]').isEnabled()) throw new Error('subtitle export remained disabled after parsing');
    }),

    checkWorkflow('media-documents / Publishing Studio workflow', async (page) => {
      await openWorkflowTool(page, '/tools/publishing-studio/', 'publishing-studio');
      await page.locator('[data-title]').fill('Coverage publication');
      await page.locator('[data-source]').fill('# Coverage\n\nA **local** document with a [safe link](https://example.test).\n\n<script>alert("unsafe")</script>');
      await page.locator('[data-render]').click();
      await page.waitForSelector('[data-status][data-kind="success"]', { timeout: 10_000 });
      const publication = await page.locator('[data-preview]').getAttribute('srcdoc') || '';
      if (!publication.includes('<h1>Coverage</h1>') || !publication.includes('<strong>local</strong>') || !publication.includes('href="https://example.test"')) throw new Error('rendered publication omitted expected Markdown output');
      if (/<script\b/i.test(publication) || !publication.includes('&lt;script&gt;')) throw new Error('publishing preview did not escape source HTML');
      if (!await page.locator('[data-download]').isEnabled() || !await page.locator('[data-print]').isEnabled()) throw new Error('publication export actions remained disabled');
      await assertWorkflowText(page, '[data-metrics]', /Direct PDF\s*Available[\s\S]*Uploads\s*0/i, 'publication metrics did not confirm direct local PDF export and zero uploads');
    }),

    checkWorkflow('data-developer / Data converter workflow', async (page) => {
      await openWorkflowTool(page, '/tools/data-converter/', 'data-converter');
      await page.locator('[data-file]').setInputFiles(path.join(dataDeveloperFixtures, 'runtime.csv'));
      await page.locator('[data-output-format]').selectOption('json');
      await page.locator('[data-query]').fill('SELECT name, score FROM data WHERE score >= 10 ORDER BY score DESC');
      await page.locator('[data-form] button[type="submit"]').click();
      await page.waitForSelector('[data-status][data-kind="success"]', { timeout: 15_000 });
      const preview = await page.locator('[data-preview]').textContent() || '';
      const grace = preview.indexOf('Grace');
      const ada = preview.indexOf('Ada');
      if (grace < 0 || ada < 0 || grace >= ada || /Linus/.test(preview)) throw new Error(`filtered/sorted conversion preview was incorrect: ${preview}`);
      await assertWorkflowText(page, '[data-metrics]', /Input rows\s*3[\s\S]*Output rows\s*2[\s\S]*Columns\s*2/i, 'data converter metrics were incorrect');
      if (!await page.locator('[data-download]').isEnabled()) throw new Error('converted JSON download remained disabled');
    }),

    checkWorkflow('data-developer / Regex Workbench workflow', async (page) => {
      await openWorkflowTool(page, '/tools/regex-workbench/', 'regex-workbench');
      await page.locator('[data-pattern]').fill('(?<word>private|local)');
      await page.locator('[data-flags]').fill('gi');
      await page.locator('[data-input]').fill('Private local tools keep private files local.');
      await page.locator('[data-form] button[type="submit"]').click();
      await page.waitForSelector('[data-status][data-kind="success"]', { timeout: 10_000 });
      if (await page.locator('[data-matches] tr').count() !== 4) throw new Error('regex worker did not render four matches');
      await assertWorkflowText(page, '[data-matches]', /Private[\s\S]*\{"word":"Private"\}[\s\S]*local/i, 'regex match/capture output was incomplete');
      await assertWorkflowText(page, '[data-metrics]', /Matches\s*4[\s\S]*Truncated\s*No/i, 'regex metrics did not confirm the bounded result');
      if (!await page.locator('[data-download]').isEnabled()) throw new Error('regex report download remained disabled');
    })
  ]);
}

async function checkPdfWorkflows() {
  const fixtures = await pdfFixtures();
  await checkWorkflow('media-documents / PDF Toolbox complete workflow', async (page) => {
    await openWorkflowTool(page, '/tools/pdf-toolbox/', 'pdf-toolbox');
    await page.locator('[data-files]').setInputFiles([
      { name: 'first.pdf', mimeType: 'application/pdf', buffer: fixtures.first },
      { name: 'second.pdf', mimeType: 'application/pdf', buffer: fixtures.second }
    ]);
    await page.locator('[data-analyze]').click();
    await page.waitForFunction(() => !document.querySelector('[data-create]')?.disabled, null, { timeout: 15_000 });

    await page.locator('[data-operation]').selectOption('merge');
    await page.locator('[data-rotation]').selectOption('90');
    await page.locator('[data-strip]').check();
    await page.locator('[data-create]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-outputs] li').length === 1, null, { timeout: 15_000 });
    const merged = await PDFDocument.load(await readDownloadedBytes(page, page.locator('[data-output-index="0"]')));
    if (merged.getPageCount() !== 3 || merged.getPages().some((item) => item.getRotation().angle !== 90)) throw new Error('PDF merge/rotation output was invalid');

    await page.locator('[data-operation]').selectOption('extract');
    await page.locator('[data-rotation]').selectOption('0');
    await page.locator('[data-range]').fill('1;2');
    await page.locator('[data-create]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-outputs] li').length === 2, null, { timeout: 15_000 });

    await page.locator('[data-operation]').selectOption('reorder');
    await page.locator('[data-range]').fill('2,1');
    await page.locator('[data-create]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-outputs] li').length === 1, null, { timeout: 15_000 });
    const reorderedBytes = await readDownloadedBytes(page, page.locator('[data-output-index="0"]'));
    const reordered = await PDFDocument.load(reorderedBytes);
    if (reordered.getPageCount() !== 2 || reordered.getPage(0).getWidth() !== 400 || reordered.getPage(1).getWidth() !== 300) throw new Error('PDF page reordering did not preserve the requested order');

    await page.locator('[data-operation]').selectOption('optimize');
    await page.locator('[data-create]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-outputs] li').length === 1, null, { timeout: 15_000 });
    const optimizedBytes = await readDownloadedBytes(page, page.locator('[data-output-index="0"]'));
    const optimized = await PDFDocument.load(optimizedBytes);
    if (optimized.getPageCount() !== 2 || optimized.getTitle()) throw new Error('PDF optimized rewrite did not preserve pages and strip metadata');
    if (!optimizedBytes.toString('latin1').includes('/ObjStm')) throw new Error('PDF optimized rewrite did not use compressed object streams');
  });

  await checkWorkflow('media-documents / PDF Editor complete workflow', async (page) => {
    await openWorkflowTool(page, '/tools/pdf-editor/', 'pdf-editor');
    await page.locator('[data-file]').setInputFiles({ name: 'editable.pdf', mimeType: 'application/pdf', buffer: fixtures.first });
    await page.locator('[data-open]').click();
    await page.waitForFunction(() => !document.querySelector('[data-save]')?.disabled, null, { timeout: 15_000 });
    if (await page.locator('[data-fields] tr').count() !== 1) throw new Error('PDF form field was not inspected');
    await page.locator('[data-rotation]').selectOption('90');
    await page.locator('[data-text]').fill('Visible local annotation');
    await page.locator('[data-signature]').setInputFiles({ name: 'signature.png', mimeType: 'image/png', buffer: fixtures.signature });
    await page.locator('[data-remove]').fill('2');
    await page.locator('[data-assignments]').fill('Name=Matheus');
    await page.locator('[data-flatten]').check();
    await page.locator('[data-save]').click();
    await page.waitForFunction(() => {
      const status = document.querySelector('[data-status]'); const download = document.querySelector('[data-download]');
      return !download?.hidden || status?.dataset.kind === 'error';
    }, null, { timeout: 15_000 });
    if (await page.locator('[data-download]').getAttribute('hidden') !== null) throw new Error(`PDF editor failed: ${await page.locator('[data-status]').textContent()}`);
    const edited = await PDFDocument.load(await readDownloadedBytes(page, page.locator('[data-download]')));
    if (edited.getPageCount() !== 1 || edited.getPage(0).getRotation().angle !== 90) throw new Error('PDF page manipulation output was invalid');
    if (edited.getForm().getFields().length !== 0) throw new Error('PDF form was not filled and flattened');
  });
}

async function checkArchiveCreationWorkflow() {
  await checkWorkflow('media-documents / 7z and TAR.XZ creation workflow', async (page) => {
    const externalRequests = [];
    page.on('request', (request) => { const url = new URL(request.url()); if (/^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1') externalRequests.push(request.url()); });
    await openWorkflowTool(page, '/tools/archive-manager/', 'archive-manager');
    await page.locator('[data-files]').setInputFiles([
      { name: 'nested/hello.txt', mimeType: 'text/plain', buffer: Buffer.from('browser 7z roundtrip') },
      { name: '-leading.txt', mimeType: 'text/plain', buffer: Buffer.from('safe leading dash') }
    ]);
    await page.locator('[data-format]').selectOption('7z');
    await page.locator('[data-create]').click();
    await page.waitForSelector('[data-download-created]:not([hidden])', { timeout: 30_000 });
    const sevenZip = await readDownloadedBytes(page, page.locator('[data-download-created]'));
    if (!sevenZip.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) throw new Error('Archive UI did not create a genuine 7z file');

    await page.locator('[data-archive]').setInputFiles({ name: 'created.7z', mimeType: 'application/x-7z-compressed', buffer: sevenZip });
    await page.locator('[data-open]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-entries] tr')].some((row) => row.textContent.includes('nested/hello.txt')), null, { timeout: 30_000 });
    const helloRow = page.locator('[data-entries] tr').filter({ hasText: 'nested/hello.txt' });
    const extracted = await readDownloadedBytes(page, helloRow.getByRole('button', { name: 'Extract' }));
    if (extracted.toString() !== 'browser 7z roundtrip') throw new Error('Archive UI 7z extraction did not round-trip the file');

    await page.locator('[data-format]').selectOption('txz');
    await page.locator('[data-create]').click();
    await page.waitForSelector('[data-download-created]:not([hidden])', { timeout: 30_000 });
    const tarXz = await readDownloadedBytes(page, page.locator('[data-download-created]'));
    if (!tarXz.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) throw new Error('Archive UI did not create a genuine TAR.XZ file');
    if (externalRequests.length) throw new Error(`Archive workflow made external requests: ${externalRequests.join(', ')}`);
  });
}

async function checkAvifConversionWorkflow() {
  await checkWorkflow('media-foundation / AVIF encode and decode workflow', async (page) => {
    const externalRequests = [];
    page.on('request', (request) => { const url = new URL(request.url()); if (/^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1') externalRequests.push(request.url()); });
    const png = await readFile(path.join(root, 'assets', 'runtime', 'rustc', 'favicon.png'));
    await openWorkflowTool(page, '/tools/universal-image-converter/', 'universal-image-converter');
    await page.locator('[data-file]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
    await page.locator('[data-mime]').selectOption('image/avif');
    await page.locator('[data-form] button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-download]')?.disabled, null, { timeout: 120_000 });
    const avif = await readDownloadedBytes(page, page.locator('[data-download]'));
    if (!avif.subarray(4, 20).toString('latin1').includes('ftypavif')) throw new Error('AVIF encoder did not return a genuine AVIF container');

    await page.locator('[data-file]').setInputFiles({ name: 'roundtrip.avif', mimeType: 'image/avif', buffer: avif });
    await page.locator('[data-mime]').selectOption('image/bmp');
    await page.locator('[data-form] button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-download]')?.disabled && document.querySelector('[data-status]')?.dataset.kind === 'success', null, { timeout: 120_000 });
    const bmp = await readDownloadedBytes(page, page.locator('[data-download]'));
    if (bmp.subarray(0, 2).toString('latin1') !== 'BM') throw new Error('Site-hosted AVIF decoder did not complete the AVIF-to-BMP round trip');
    if (externalRequests.length) throw new Error(`AVIF workflow made external requests: ${externalRequests.join(', ')}`);
  });
}

async function checkDataDeveloperRuntimes() {
  await checkWorkflow('data-developer / local runtime harness', async (page) => {
    const response = await page.goto(`http://127.0.0.1:${port}/tests/fixtures/suite-data-developer/runtime-harness.html?compiler=1`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    if (!response?.ok()) throw new Error(`HTTP ${response?.status()}`);
    await page.waitForFunction(() => globalThis.__runtimeHarness?.done === true, null, { timeout: 300_000 });
    const result = await page.evaluate(() => globalThis.__runtimeHarness);
    if (!result?.ok) throw new Error(JSON.stringify(result));
    const required = ['Parquet converter UI', 'SQLite WASM', 'DuckDB WASM + Parquet', 'Pyodide worker', 'JavaScript sandbox', 'isomorphic-git', 'Emception C'];
    for (const name of required) if (!result.outcomes.some((item) => item.name === name && item.ok)) throw new Error(`Runtime evidence missing: ${name}`);
  });
}

async function checkRustCompilerWorkflow() {
  await checkWorkflow('data-developer / Rust compiler workflow', async (page) => {
    const externalRequests = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (/^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1') externalRequests.push(request.url());
    });
    await openWorkflowTool(page, '/tools/code-playground/', 'code-playground');
    await page.locator('#play-language').selectOption('rust');
    await page.locator('[data-js]').fill('fn main() { println!("portfolio rust browser smoke"); }');
    await page.locator('[data-form] button[type="submit"]').click();
    await page.waitForSelector('[data-status][data-kind="success"]', { timeout: 15_000 });
    await page.waitForSelector('[data-preview]:not([hidden])', { timeout: 15_000 });

    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-preview]');
      const text = frame?.contentDocument?.querySelector('.xterm-rows')?.textContent || '';
      return text.includes("Sysroot 'wasm32-wasip1' loaded successfully");
    }, null, { timeout: 240_000 });

    const frame = page.frameLocator('[data-preview]');
    const source = await frame.locator('.view-lines').textContent();
    if (!source?.replaceAll('\u00a0', ' ').includes('portfolio rust browser smoke')) throw new Error(`Rust source handoff failed: ${JSON.stringify(source)}`);
    await frame.getByRole('button', { name: 'Compile and Run' }).click();
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-preview]');
      const text = frame?.contentDocument?.querySelector('.xterm-rows')?.textContent || '';
      return text.includes('portfolio rust browser smoke') && text.includes('Finished');
    }, null, { timeout: 240_000 });
    await frame.getByRole('button', { name: 'Download' }).click();
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-preview]');
      return (frame?.contentDocument?.querySelector('.xterm-rows')?.textContent || '').includes('Download successful');
    }, null, { timeout: 30_000 });
    if (externalRequests.length) throw new Error(`Rust workspace made external requests: ${externalRequests.join(', ')}`);
  });
}

async function checkEngineeringWorkflows() {
  const page = await browser.newPage({ locale: 'en-US', colorScheme: 'dark', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') { const location = message.location(); errors.push(`${message.text()}${location.url ? ` (${location.url}:${location.lineNumber || 0})` : ''}`); } });
  let currentTool = 'engineering workflow';
  const openTool = async (route, key) => {
    currentTool = key;
    const response = await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    if (!response?.ok()) throw new Error(`${key} returned HTTP ${response?.status()}`);
    await page.waitForSelector(`[data-tool-root="${key}"] .workbench-layout`, { timeout: 10_000 });
  };
  const submit = async (kind = 'success') => {
    await page.locator('[data-form] button[type="submit"]').click();
    try { await page.waitForSelector(`[data-status][data-kind="${kind}"]`, { timeout: 15_000 }); }
    catch (error) {
      const status = await page.locator('[data-status]').textContent().catch(() => 'unavailable');
      throw new Error(`${currentTool} did not reach ${kind}; status=${JSON.stringify(status)}; ${error.message}`);
    }
  };
  const assertText = async (selector, pattern, label) => {
    const value = await page.locator(selector).textContent();
    if (!pattern.test(value || '')) throw new Error(`${label}: ${JSON.stringify(value)}`);
  };
  try {
    await openTool('/tools/local-search/', 'local-search');
    await page.locator('[data-folder]').setInputFiles(engineeringSearchFixtures);
    await submit();
    await page.locator('[data-query]').fill('private source files');
    await page.locator('[data-search]').click();
    await assertText('[data-output]', /privacy-notes\.txt/i, 'local search did not rank the matching document');

    await openTool('/tools/model-viewer/', 'model-viewer');
    await page.locator('[data-file]').setInputFiles(path.join(engineeringFixtures, 'cube.obj'));
    await submit();
    const previewSize = await page.locator('.suite-canvas').evaluate((canvas) => [canvas.width, canvas.height]);
    if (previewSize[0] < 800 || previewSize[1] < 500) throw new Error(`model preview was not rendered: ${previewSize.join('x')}`);
    const wireframePreview = await page.locator('.suite-canvas').evaluate((canvas) => canvas.toDataURL());
    await page.locator('[data-wireframe]').uncheck();
    const filledPreview = await page.locator('.suite-canvas').evaluate((canvas) => canvas.toDataURL());
    if (wireframePreview === filledPreview) throw new Error('wireframe control did not redraw the model preview');

    await openTool('/tools/model-converter/', 'model-converter');
    await page.locator('[data-file]').setInputFiles(path.join(engineeringFixtures, 'cube.obj'));
    await page.locator('[data-target]').selectOption('gltf');
    await submit();
    await assertText('[data-output]', /"target": "gltf"/, 'glTF conversion report was not produced');

    await openTool('/tools/cad-lite/', 'cad-lite');
    await page.waitForSelector('[data-status][data-kind="success"]', { timeout: 10_000 });
    await page.locator('[data-boolean]').selectOption('difference');
    await page.locator('[data-resolution]').fill('16');
    await submit('warning');
    await assertText('[data-output]', /"operation": "difference"/, 'voxel difference design was not regenerated');

    await openTool('/tools/mesh-editor/', 'mesh-editor');
    await page.locator('[data-file]').setInputFiles(path.join(engineeringFixtures, 'cube.obj'));
    await submit();
    await page.locator('[data-selection-kind]').selectOption('edges');
    await page.locator('[data-move-x]').fill('2');
    await page.locator('[data-operation="selection"]').click();
    await page.locator('[data-operation="normals"]').click();
    await page.locator('[data-operation="uv"]').click();
    await assertText('[data-output]', /selection[\s\S]*normals[\s\S]*uv/i, 'mesh edit history was not updated');

    await openTool('/tools/slicer/', 'slicer');
    await page.locator('[data-file]').setInputFiles(path.join(engineeringFixtures, 'cube.stl'));
    await page.locator('[data-confirm]').check();
    await submit('warning');
    await assertText('[data-output]', /G21[\s\S]*G90/, 'slicer did not emit reviewable G-code');

    await openTool('/tools/gerber-viewer/', 'gerber-viewer');
    await page.locator('[data-files]').setInputFiles(path.join(engineeringFixtures, 'board.gtl'));
    await page.locator('[data-form] button[type="submit"]').click();
    await page.waitForSelector('[data-status][data-kind="success"], [data-status][data-kind="warning"]', { timeout: 10_000 });
    await assertText('[data-output]', /copper-top[\s\S]*RS-274X/i, 'Gerber layer assignment/report was not produced');

    await openTool('/tools/ai-media-studio/', 'ai-media-studio');
    await page.locator('[data-files]').setInputFiles([
      path.join(engineeringFixtures, 'privacy-notes.txt'),
      path.join(engineeringFixtures, 'portfolio-notes.txt')
    ]);
    await submit();
    await page.locator('[data-query]').fill('private files stay local');
    await page.locator('[data-search]').click();
    await page.waitForSelector('[data-status][data-kind="warning"]', { timeout: 10_000 });
    await assertText('[data-output]', /privacy-notes\.txt/i, 'AI studio token-hash search did not rank the matching record');

    if (errors.length) throw new Error(errors.join(' | '));
  } catch (error) { failures.push(`engineering workflows (${currentTool}): ${error.message}`); }
  finally { await page.close(); }
}

try {
  if (shouldRun('routes')) {
    await Promise.all([checkDirectory('en'), checkDirectory('pt')]);
    for (let offset = 0; offset < suiteTools.length; offset += 5) {
      const batch = suiteTools.slice(offset, offset + 5);
      await Promise.all(batch.flatMap((tool) => [check(tool, 'en'), check(tool, 'pt')]));
    }
  }
  if (shouldRun('representative')) await checkRepresentativeWorkflows();
  if (shouldRun('avif')) await checkAvifConversionWorkflow();
  if (shouldRun('pdf')) await checkPdfWorkflows();
  if (shouldRun('archive')) await checkArchiveCreationWorkflow();
  if (shouldRun('ffmpeg')) await checkStandaloneFixture('media-documents / FFmpeg codec and fade workflow', '/tests/fixtures/suite-media-documents/ffmpeg-smoke.html', 240_000);
  if (shouldRun('libarchive')) await checkStandaloneFixture('media-documents / libarchive extraction workflow', '/tests/fixtures/suite-media-documents/libarchive-smoke.html', 60_000);
  if (shouldRun('epub')) await checkStandaloneFixture('media-documents / EPUB Studio repack workflow', '/tests/fixtures/suite-media-documents/epub-smoke.html');
  if (shouldRun('runtimes')) await checkDataDeveloperRuntimes();
  if (shouldRun('rust')) await checkRustCompilerWorkflow();
  if (shouldRun('engineering')) await checkEngineeringWorkflows();
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else if (selectedStages.size) console.log(`Browser check stage(s) passed: ${[...selectedStages].join(', ')}.`);
else console.log('Browser-smoked all 50 requested tools in English and Portuguese; catalog responsive behavior; real AVIF, PDF, 7z/TAR.XZ, FFmpeg, libarchive, EPUB, SQLite, DuckDB/Parquet, Pyodide, Git, C, and Rust workflows; and eight engineering/AI workflows.');
