import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { toolRoutes } from './tool-data.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const postsDirectory = path.join(projectRoot, 'content', 'posts');
const siteUrl = 'https://castrom13.dev';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeXml(value = '') {
  return escapeHtml(value);
}

function slugify(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

function parseFrontMatter(source, fileName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`${fileName}: missing front matter`);

  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error(`${fileName}: invalid front matter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (raw === 'true' || raw === 'false') metadata[key] = raw === 'true';
    else if (key === 'tags') metadata[key] = raw.split(',').map((item) => item.trim()).filter(Boolean);
    else metadata[key] = raw.replace(/^['"]|['"]$/g, '');
  }

  return { metadata, body: match[2].trim() };
}

function validatePost(post) {
  const required = ['title', 'description', 'date', 'lang', 'slug'];
  for (const key of required) if (!post[key]) throw new Error(`${post.fileName}: missing “${key}”`);
  if (!['en', 'pt-BR'].includes(post.lang)) throw new Error(`${post.fileName}: lang must be en or pt-BR`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(post.date)) throw new Error(`${post.fileName}: date must use YYYY-MM-DD`);
  const parsedDate = new Date(`${post.date}T00:00:00Z`);
  if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== post.date) throw new Error(`${post.fileName}: date is not a real calendar day`);
  if (!post.slug.match(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)) throw new Error(`${post.fileName}: slug must use lowercase ASCII words and hyphens`);
  if (/^#\s/m.test(post.body)) throw new Error(`${post.fileName}: the title is generated; begin body headings at ##`);
}

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });
markdown.renderer.rules.heading_open = (tokens, index, options, environment, self) => {
  const inline = tokens[index + 1];
  const base = slugify(inline?.content || 'section') || 'section';
  environment.headingIds ??= new Map();
  const count = environment.headingIds.get(base) || 0;
  environment.headingIds.set(base, count + 1);
  tokens[index].attrSet('id', count ? `${base}-${count + 1}` : base);
  return self.renderToken(tokens, index, options);
};

markdown.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  const href = tokens[index].attrGet('href') || '';
  if (/^https?:\/\//.test(href)) tokens[index].attrSet('rel', 'external noopener');
  return self.renderToken(tokens, index, options);
};

for (const rule of ['fence', 'code_block']) {
  const renderCode = markdown.renderer.rules[rule];
  markdown.renderer.rules[rule] = (tokens, index, options, environment, self) => {
    const label = environment.lang === 'pt-BR' ? 'Bloco de código com rolagem horizontal' : 'Horizontally scrollable code block';
    return `<div class="code-scroll" role="region" tabindex="0" aria-label="${label}">${renderCode(tokens, index, options, environment, self)}</div>`;
  };
}

const renderTableOpen = markdown.renderer.rules.table_open || ((tokens, index, options, environment, self) => self.renderToken(tokens, index, options));
const renderTableClose = markdown.renderer.rules.table_close || ((tokens, index, options, environment, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.table_open = (tokens, index, options, environment, self) => {
  const label = environment.lang === 'pt-BR' ? 'Tabela com rolagem horizontal' : 'Horizontally scrollable table';
  return `<div class="table-scroll" role="region" tabindex="0" aria-label="${label}">${renderTableOpen(tokens, index, options, environment, self)}`;
};
markdown.renderer.rules.table_close = (tokens, index, options, environment, self) => `${renderTableClose(tokens, index, options, environment, self)}</div>`;

function pageHeader(lang, active, alternatePath, alternateAvailable = true) {
  const portuguese = lang === 'pt-BR';
  const home = portuguese ? '/pt-br/' : '/';
  const lab = portuguese ? '/pt-br/ferramentas/' : '/tools/';
  const blog = portuguese ? '/pt-br/blog/' : '/blog/';
  const labels = portuguese
    ? { work: 'Trabalho', capabilities: 'Competências', lab: 'Lab', notes: 'Notas', about: 'Sobre', nav: 'Principal', home: 'Matheus Castro, início', open: 'Abrir navegação', close: 'Fechar navegação', light: 'Usar tema claro', dark: 'Usar tema escuro', alt: 'EN' }
    : { work: 'Work', capabilities: 'Capabilities', lab: 'Lab', notes: 'Notes', about: 'About', nav: 'Primary', home: 'Matheus Castro, home', open: 'Open navigation', close: 'Close navigation', light: 'Use light theme', dark: 'Use dark theme', alt: 'PT' };
  const alternateLang = portuguese ? 'en' : 'pt-BR';
  const alternateLabel = alternateAvailable
    ? (portuguese ? 'View in English' : 'Ver em português')
    : (portuguese ? 'No English translation; open English notes' : 'Sem tradução em português; abrir notas em português');

  return `<a class="skip-link" href="#main">${portuguese ? 'Pular para o conteúdo' : 'Skip to content'}</a>
  <header class="site-header">
    <a class="wordmark" href="${home}" aria-label="${labels.home}"><span class="wordmark-icon" aria-hidden="true"><img src="/assets/favicon.svg" alt="" width="100" height="100" data-theme-asset></span><span class="wordmark-name">Matheus Castro</span></a>
    <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-navigation" data-menu-toggle data-open-label="${labels.open}" data-close-label="${labels.close}"><span class="sr-only">${labels.open}</span><span aria-hidden="true"></span><span aria-hidden="true"></span></button>
    <nav class="site-navigation" id="site-navigation" aria-label="${labels.nav}" data-navigation>
      <a href="${home}#work">${labels.work}</a><a href="${home}#capabilities">${labels.capabilities}</a><a href="${lab}">${labels.lab}</a><a href="${blog}"${active === 'blog' ? ' aria-current="page"' : ''}>${labels.notes}</a><a href="${home}#about">${labels.about}</a>
    </nav>
    <div class="header-actions">
      <a class="language-link" href="${alternatePath}" lang="${alternateLang}" hreflang="${alternateLang}" aria-label="${alternateLabel}" data-language="${alternateLang}">${labels.alt}</a>
      <button class="icon-button" type="button" aria-label="${labels.light}" data-theme-toggle data-light-label="${labels.light}" data-dark-label="${labels.dark}"><span aria-hidden="true" data-theme-icon>◐</span></button>
    </div>
  </header>`;
}

function pageFooter(lang) {
  const portuguese = lang === 'pt-BR';
  return `<footer class="site-footer"><p>Matheus Castro · ${portuguese ? 'Notas' : 'Notes'}</p><nav aria-label="${portuguese ? 'Rodapé' : 'Footer'}"><a href="${portuguese ? '/pt-br/' : '/'}">${portuguese ? 'Portfólio' : 'Portfolio'}</a><a href="${portuguese ? '/pt-br/ferramentas/' : '/tools/'}">Lab</a><a href="mailto:contact@castrom13.dev">${portuguese ? 'E-mail' : 'Email'}</a></nav></footer>`;
}

function localeBootstrap(lang, redirectPath) {
  if (!redirectPath) return `<script>document.documentElement.classList.add('js');</script>`;
  const destination = JSON.stringify(redirectPath).replaceAll('<', '\\u003c');
  if (lang === 'pt-BR') {
    return `<script>document.documentElement.classList.add('js'); try { if (localStorage.getItem('castrom13-language') === 'en') location.replace(${destination}); } catch (_) {}</script>`;
  }
  return `<script>document.documentElement.classList.add('js'); try { const savedLanguage = localStorage.getItem('castrom13-language'); const speaksPortuguese = navigator.languages?.some((language) => /^pt(?:-|$)/i.test(language)); if (savedLanguage === 'pt-BR' || (!savedLanguage && speaksPortuguese)) location.replace(${destination}); } catch (_) {}</script>`;
}

function head({ lang, title, description, canonical, alternateEn, alternatePt, type = 'website', published, localeRedirect }) {
  const locale = lang === 'pt-BR' ? 'pt_BR' : 'en_US';
  const alternateLinks = [
    alternateEn ? `<link rel="alternate" hreflang="en" href="${alternateEn}">` : '',
    alternatePt ? `<link rel="alternate" hreflang="pt-BR" href="${alternatePt}">` : ''
  ].filter(Boolean).join('\n  ');
  const articleMeta = published ? `<meta property="article:published_time" content="${published}">\n  ` : '';
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0a0b0d">
  <link rel="icon" type="image/svg+xml" sizes="any" href="/assets/favicon.svg" data-theme-asset>
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${canonical}">
  ${alternateLinks}
  <link rel="alternate" hreflang="x-default" href="${alternateEn || canonical}">
  <meta property="og:type" content="${type}">
  <meta property="og:locale" content="${locale}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="https://castrom13.dev/assets/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="https://castrom13.dev/assets/og.png">
  ${articleMeta}${localeBootstrap(lang, localeRedirect)}
  <link rel="stylesheet" href="/assets/site.css">
  <script src="/assets/site.js" type="module"></script>`;
}

function postPath(post) {
  return post.lang === 'pt-BR' ? `/pt-br/blog/${post.slug}/` : `/blog/${post.slug}/`;
}

function formatDate(value, lang) {
  return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
}

function postCard(post) {
  const tags = (post.tags || []).map((tag) => `<li>${escapeHtml(tag)}</li>`).join('');
  return `<article class="post-card">
    <p class="post-date"><time datetime="${post.date}">${escapeHtml(formatDate(post.date, post.lang))}</time></p>
    <h2><a href="${postPath(post)}">${escapeHtml(post.title)}</a></h2>
    <p>${escapeHtml(post.description)}</p>
    ${tags ? `<ul class="post-tags" aria-label="${post.lang === 'pt-BR' ? 'Tópicos' : 'Topics'}">${tags}</ul>` : ''}
  </article>`;
}

function blogIndex(posts, lang) {
  const portuguese = lang === 'pt-BR';
  const canonicalPath = portuguese ? '/pt-br/blog/' : '/blog/';
  const alternatePath = portuguese ? '/blog/' : '/pt-br/blog/';
  const cards = posts.length
    ? posts.map(postCard).join('\n')
    : `<div class="empty-notes"><p class="section-kicker">${portuguese ? 'Primeira nota em preparo' : 'First note in progress'}</p><h2>${portuguese ? 'Nada publicado ainda.' : 'Nothing published yet.'}</h2><p>${portuguese ? 'Os textos em Markdown aparecerão aqui após o próximo deploy.' : 'Markdown posts will appear here after the next deployment.'}</p></div>`;
  const title = portuguese ? 'Notas — Matheus Castro' : 'Notes — Matheus Castro';
  const description = portuguese ? 'Textos sobre software de produto, IA aplicada, infraestrutura e acessibilidade.' : 'Writing about product software, applied AI, infrastructure, and accessibility.';
  return `<!doctype html>
<html lang="${lang}" data-theme="dark">
<head>
  ${head({ lang, title, description, canonical: siteUrl + canonicalPath, alternateEn: siteUrl + (portuguese ? alternatePath : canonicalPath), alternatePt: siteUrl + (portuguese ? canonicalPath : alternatePath), localeRedirect: alternatePath })}
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(title)}" href="${canonicalPath}feed.xml">
</head>
<body>
  ${pageHeader(lang, 'blog', alternatePath)}
  <main id="main">
    <header class="section-shell page-hero"><p class="section-kicker">${portuguese ? 'Notas de campo / Markdown' : 'Field notes / Markdown'}</p><h1>${portuguese ? 'O que aprendi fazendo o sistema funcionar.' : 'What I learned making the system work.'}</h1><p>${description}</p></header>
    <section class="section-shell posts-list" aria-label="${portuguese ? 'Notas publicadas' : 'Published notes'}">${cards}</section>
  </main>
  ${pageFooter(lang)}
</body>
</html>`;
}

function postPage(post, translation) {
  const portuguese = post.lang === 'pt-BR';
  const canonicalPath = postPath(post);
  const fallback = portuguese ? '/blog/' : '/pt-br/blog/';
  const alternatePath = translation ? postPath(translation) : fallback;
  const alternateEn = post.lang === 'en' ? siteUrl + canonicalPath : (translation ? siteUrl + alternatePath : undefined);
  const alternatePt = post.lang === 'pt-BR' ? siteUrl + canonicalPath : (translation ? siteUrl + alternatePath : undefined);
  const tags = (post.tags || []).map((tag) => `<li>${escapeHtml(tag)}</li>`).join('');
  const body = markdown.render(post.body, { headingIds: new Map(), lang: post.lang });
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    inLanguage: post.lang,
    author: { '@type': 'Person', name: 'Matheus Castro', url: siteUrl },
    mainEntityOfPage: siteUrl + canonicalPath
  };
  return `<!doctype html>
<html lang="${post.lang}" data-theme="dark">
<head>
  ${head({ lang: post.lang, title: `${post.title} — Matheus Castro`, description: post.description, canonical: siteUrl + canonicalPath, alternateEn, alternatePt, type: 'article', published: post.date, localeRedirect: translation ? alternatePath : undefined })}
  <script type="application/ld+json">${JSON.stringify(structuredData).replaceAll('<', '\\u003c')}</script>
</head>
<body>
  ${pageHeader(post.lang, 'blog', alternatePath, Boolean(translation))}
  <main id="main" class="section-shell post-shell">
    <nav class="breadcrumbs" aria-label="${portuguese ? 'Caminho' : 'Breadcrumb'}"><a href="${portuguese ? '/pt-br/blog/' : '/blog/'}">${portuguese ? 'Notas' : 'Notes'}</a><span aria-hidden="true">/</span><span aria-current="page">${escapeHtml(post.title)}</span></nav>
    <article class="post-article">
      <header class="post-header"><p class="section-kicker">${portuguese ? 'Nota de campo' : 'Field note'}</p><h1>${escapeHtml(post.title)}</h1><p>${escapeHtml(post.description)}</p><div class="post-byline"><time datetime="${post.date}">${escapeHtml(formatDate(post.date, post.lang))}</time><span>Matheus Castro</span></div>${tags ? `<ul class="post-tags" aria-label="${portuguese ? 'Tópicos' : 'Topics'}">${tags}</ul>` : ''}</header>
      <div class="prose">${body}</div>
    </article>
  </main>
  ${pageFooter(post.lang)}
</body>
</html>`;
}

function rss(posts, lang) {
  const portuguese = lang === 'pt-BR';
  const pathName = portuguese ? '/pt-br/blog/' : '/blog/';
  const title = portuguese ? 'Notas de Matheus Castro' : 'Matheus Castro’s Notes';
  const items = posts.map((post) => `<item><title>${escapeXml(post.title)}</title><link>${siteUrl}${postPath(post)}</link><guid>${siteUrl}${postPath(post)}</guid><pubDate>${new Date(`${post.date}T12:00:00Z`).toUTCString()}</pubDate><description>${escapeXml(post.description)}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(title)}</title><link>${siteUrl}${pathName}</link><description>${escapeXml(title)}</description><language>${lang}</language>${items}</channel></rss>`;
}

async function write(relativePath, content) {
  const destination = path.join(projectRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, 'utf8');
}

async function loadPosts() {
  const fileNames = (await readdir(postsDirectory)).filter((name) => !name.startsWith('_') && /\.(?:en|pt-BR)\.md$/.test(name));
  const posts = [];
  for (const fileName of fileNames) {
    const source = await readFile(path.join(postsDirectory, fileName), 'utf8');
    const { metadata, body } = parseFrontMatter(source, fileName);
    const post = { ...metadata, body, fileName };
    validatePost(post);
    if (post.draft && process.env.INCLUDE_DRAFTS !== '1') continue;
    posts.push(post);
  }
  const duplicate = posts.find((post, index) => posts.findIndex((candidate) => candidate.lang === post.lang && candidate.slug === post.slug) !== index);
  if (duplicate) throw new Error(`Duplicate ${duplicate.lang} slug: ${duplicate.slug}`);
  const duplicateTranslation = posts.find((post, index) => post.translationKey && posts.findIndex((candidate) => candidate.lang === post.lang && candidate.translationKey === post.translationKey) !== index);
  if (duplicateTranslation) throw new Error(`Duplicate ${duplicateTranslation.lang} translationKey: ${duplicateTranslation.translationKey}`);
  return posts.sort((first, second) => second.date.localeCompare(first.date));
}

const posts = await loadPosts();
const English = posts.filter((post) => post.lang === 'en');
const Portuguese = posts.filter((post) => post.lang === 'pt-BR');

await rm(path.join(projectRoot, 'blog'), { recursive: true, force: true });
await rm(path.join(projectRoot, 'pt-br', 'blog'), { recursive: true, force: true });

await write('blog/index.html', blogIndex(English, 'en'));
await write('pt-br/blog/index.html', blogIndex(Portuguese, 'pt-BR'));
await write('blog/feed.xml', rss(English, 'en'));
await write('pt-br/blog/feed.xml', rss(Portuguese, 'pt-BR'));

for (const post of posts) {
  const translation = posts.find((candidate) => candidate.lang !== post.lang && candidate.translationKey && candidate.translationKey === post.translationKey);
  await write(path.join(postPath(post).slice(1), 'index.html'), postPage(post, translation));
}

const staticPaths = ['/', '/pt-br/', '/tools/', '/pt-br/ferramentas/', '/blog/', '/pt-br/blog/', ...toolRoutes];
const sitemapPaths = [...new Set([...staticPaths, ...posts.map(postPath)])];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapPaths.map((entry) => `<url><loc>${siteUrl}${entry}</loc></url>`).join('')}</urlset>`;
await write('sitemap.xml', sitemap);
await write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`);

console.log(`Built ${posts.length} published post${posts.length === 1 ? '' : 's'} across English and Portuguese.`);
