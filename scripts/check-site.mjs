import { readFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = [
  'index.html', 'pt-br/index.html', 'tools/index.html', 'tools/password/index.html', 'tools/contrast/index.html',
  'pt-br/ferramentas/index.html', 'pt-br/ferramentas/senhas/index.html', 'pt-br/ferramentas/contraste/index.html',
  'qrcode/index.html', 'pt-br/ferramentas/qrcode/index.html', 'blog/index.html', 'pt-br/blog/index.html', '404.html'
];

for (const blogRoot of ['blog', 'pt-br/blog']) {
  const entries = await readdir(path.join(root, blogRoot), { withFileTypes: true });
  for (const entry of entries) if (entry.isDirectory()) pages.push(path.join(blogRoot, entry.name, 'index.html'));
}
const errors = [];

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

async function targetExists(reference, sourcePage) {
  const clean = reference.split(/[?#]/)[0];
  if (!clean || /^[a-z][a-z\d+.-]*:|^\/\//i.test(clean)) return true;
  const decoded = decodeURIComponent(clean);
  const relative = decoded.startsWith('/') ? decoded.slice(1) : path.normalize(path.join(path.dirname(sourcePage), decoded));
  const candidate = path.resolve(root, relative, decoded.endsWith('/') ? 'index.html' : '');
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return false;
  try { await access(candidate); return true; } catch (_) { return false; }
}

for (const page of pages) {
  const filePath = path.join(root, page);
  let html;
  try { html = await readFile(filePath, 'utf8'); }
  catch (_) { errors.push(`${page}: file is missing`); continue; }

  if (!/<html\s[^>]*lang="(?:en|pt-BR)"/i.test(html)) errors.push(`${page}: missing supported html lang`);
  if (count(html, /<main\b/gi) !== 1) errors.push(`${page}: expected exactly one main landmark`);
  if (count(html, /<h1\b/gi) !== 1) errors.push(`${page}: expected exactly one h1`);
  if (!/<meta\s+name="viewport"/i.test(html)) errors.push(`${page}: missing viewport metadata`);
  if (page !== '404.html') {
    if (!/<meta\s+name="description"/i.test(html)) errors.push(`${page}: missing description`);
    if (!/<link\s+rel="canonical"/i.test(html)) errors.push(`${page}: missing canonical`);
    for (const property of ['type', 'title', 'description', 'url', 'image']) if (!new RegExp(`<meta\\s+property="og:${property}"`, 'i').test(html)) errors.push(`${page}: missing og:${property}`);
    if (!/<meta\s+name="twitter:card"/i.test(html) || !/<meta\s+name="twitter:image"/i.test(html)) errors.push(`${page}: incomplete Twitter card metadata`);
    const generatedPost = /^(?:blog|pt-br\/blog)\/[^/]+\/index\.html$/.test(page);
    if (!generatedPost && (!/hreflang="en"/i.test(html) || !/hreflang="pt-BR"/i.test(html))) errors.push(`${page}: incomplete hreflang pair`);
    if (!/class="[^"]*(?:skip-link|qr-skip-link)[^"]*"/i.test(html)) errors.push(`${page}: missing skip link`);
  }

  const ids = [...html.matchAll(/\sid="([^"]+)"/gi)].map((match) => match[1]);
  for (const id of ids) if (ids.indexOf(id) !== ids.lastIndexOf(id)) errors.push(`${page}: duplicate id “${id}”`);

  const localAnchors = [...html.matchAll(/href="#([^"]+)"/gi)].map((match) => match[1]);
  for (const anchor of localAnchors) if (!ids.includes(anchor)) errors.push(`${page}: missing local anchor target #${anchor}`);

  const localReferences = [...html.matchAll(/\s(?:href|src)="([^"]+)"/gi)].map((match) => match[1]);
  for (const reference of localReferences) if (!(await targetExists(reference, page))) errors.push(`${page}: broken local reference ${reference}`);

  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  for (const image of images) if (!/\salt="[^"]*"/i.test(image)) errors.push(`${page}: image without alt attribute`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${pages.length} primary pages: structural HTML, metadata, anchors, links, and image alternatives passed.`);
}
