import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allTools, newTools } from './tool-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteUrl = 'https://castrom13.dev';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function localeScript(language, alternatePath) {
  const destination = JSON.stringify(alternatePath).replaceAll('<', '\\u003c');
  if (language === 'pt') {
    return `<script>document.documentElement.classList.add('js'); try { if (localStorage.getItem('castrom13-language') === 'en') location.replace(${destination}); } catch (_) {}</script>`;
  }
  return `<script>document.documentElement.classList.add('js'); try { const savedLanguage = localStorage.getItem('castrom13-language'); const speaksPortuguese = navigator.languages?.some((language) => /^pt(?:-|$)/i.test(language)); if (savedLanguage === 'pt-BR' || (!savedLanguage && speaksPortuguese)) location.replace(${destination}); } catch (_) {}</script>`;
}

function head({ language, title, description, canonicalPath, alternatePath, script }) {
  const portuguese = language === 'pt';
  const englishPath = portuguese ? alternatePath : canonicalPath;
  const portuguesePath = portuguese ? canonicalPath : alternatePath;
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0a0b0d">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${siteUrl}${canonicalPath}">
  <link rel="alternate" hreflang="en" href="${siteUrl}${englishPath}">
  <link rel="alternate" hreflang="pt-BR" href="${siteUrl}${portuguesePath}">
  <link rel="alternate" hreflang="x-default" href="${siteUrl}${englishPath}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="${portuguese ? 'pt_BR' : 'en_US'}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${siteUrl}${canonicalPath}">
  <meta property="og:image" content="${siteUrl}/assets/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${siteUrl}/assets/og.png">
  ${localeScript(language, alternatePath)}
  <link rel="stylesheet" href="/assets/site.css">
  <script src="/assets/site.js" type="module"></script>${script ? `\n  <script src="${script}" type="module"></script>` : ''}`;
}

function header(language, alternatePath) {
  const pt = language === 'pt';
  return `<a class="skip-link" href="#main">${pt ? 'Pular para o conteúdo' : 'Skip to content'}</a>
  <header class="site-header">
    <a class="wordmark" href="${pt ? '/pt-br/' : '/'}" aria-label="Matheus Castro, ${pt ? 'início' : 'home'}"><span aria-hidden="true">MC</span><span class="wordmark-name">Matheus Castro</span></a>
    <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-navigation" data-menu-toggle data-open-label="${pt ? 'Abrir navegação' : 'Open navigation'}" data-close-label="${pt ? 'Fechar navegação' : 'Close navigation'}"><span class="sr-only">${pt ? 'Abrir navegação' : 'Open navigation'}</span><span aria-hidden="true"></span><span aria-hidden="true"></span></button>
    <nav class="site-navigation" id="site-navigation" aria-label="${pt ? 'Principal' : 'Primary'}" data-navigation><a href="${pt ? '/pt-br/#work' : '/#work'}">${pt ? 'Trabalho' : 'Work'}</a><a href="${pt ? '/pt-br/#capabilities' : '/#capabilities'}">${pt ? 'Competências' : 'Capabilities'}</a><a href="${pt ? '/pt-br/ferramentas/' : '/tools/'}" aria-current="page">Lab</a><a href="${pt ? '/pt-br/blog/' : '/blog/'}">${pt ? 'Notas' : 'Notes'}</a><a href="${pt ? '/pt-br/#about' : '/#about'}">${pt ? 'Sobre' : 'About'}</a></nav>
    <div class="header-actions">
      <a class="language-link" href="${alternatePath}" lang="${pt ? 'en' : 'pt-BR'}" hreflang="${pt ? 'en' : 'pt-BR'}" aria-label="${pt ? 'View in English' : 'Ver em português'}" data-language="${pt ? 'en' : 'pt-BR'}">${pt ? 'EN' : 'PT'}</a>
      <button class="icon-button" type="button" aria-label="${pt ? 'Usar tema claro' : 'Use light theme'}" data-theme-toggle data-light-label="${pt ? 'Usar tema claro' : 'Use light theme'}" data-dark-label="${pt ? 'Usar tema escuro' : 'Use dark theme'}"><span aria-hidden="true" data-theme-icon>◐</span></button>
    </div>
  </header>`;
}

function footer(language) {
  const pt = language === 'pt';
  return `<footer class="site-footer"><p>Matheus Castro · ${pt ? 'Laboratório comunitário' : 'Community Lab'}</p><nav aria-label="${pt ? 'Rodapé' : 'Footer'}"><a href="${pt ? '/pt-br/ferramentas/' : '/tools/'}">${pt ? 'Todas as ferramentas' : 'Every tool'}</a><a href="${pt ? '/pt-br/' : '/'}">${pt ? 'Portfólio' : 'Portfolio'}</a><a href="mailto:contact@castrom13.dev">${pt ? 'E-mail' : 'Email'}</a></nav></footer>`;
}

function schema(tool, language, canonicalPath) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: tool.title[language],
    description: tool.description[language],
    applicationCategory: tool.schemaCategory || 'UtilitiesApplication',
    operatingSystem: 'Any modern web browser',
    inLanguage: language === 'pt' ? 'pt-BR' : 'en',
    url: siteUrl + canonicalPath,
    offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' }
  }).replaceAll('<', '\\u003c');
}

function toolPage(tool, language) {
  const pt = language === 'pt';
  const canonicalPath = tool.paths[language];
  const alternatePath = tool.paths[pt ? 'en' : 'pt'];
  const lang = pt ? 'pt-BR' : 'en';
  const title = tool.title[language];
  return `<!doctype html>
<html lang="${lang}" data-theme="dark">
<head>
  ${head({ language, title: `${title} — ${pt ? 'Laboratório comunitário' : 'Community Lab'}`, description: tool.description[language], canonicalPath, alternatePath, script: `/assets/tools/${tool.key}.js` })}
  <script type="application/ld+json">${schema(tool, language, canonicalPath)}</script>
</head>
<body>
  ${header(language, alternatePath)}
  <main id="main" class="section-shell tool-page">
    <nav class="breadcrumbs" aria-label="${pt ? 'Caminho' : 'Breadcrumb'}"><a href="${pt ? '/pt-br/ferramentas/' : '/tools/'}">${pt ? 'Laboratório comunitário' : 'Community Lab'}</a><span aria-hidden="true">/</span><span aria-current="page">${escapeHtml(title)}</span></nav>
    <header class="tool-heading" data-reveal>
      <p class="section-kicker">${pt ? 'Ferramenta' : 'Tool'} / ${tool.index} · ${escapeHtml(tool.subtitle[language])}</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(tool.description[language])}</p>
      <div class="privacy-line"><span aria-hidden="true"></span>${escapeHtml(tool.privacy[language])}</div>
    </header>
    <noscript><p class="noscript-message">${pt ? 'Esta ferramenta precisa de JavaScript porque todo o processamento acontece no seu navegador.' : 'This tool requires JavaScript because all processing happens in your browser.'}</p></noscript>
    <section class="tool-workbench" aria-label="${escapeHtml(tool.subtitle[language])}" data-tool-root="${tool.key}" data-language="${lang}">
      <div class="tool-loading" role="status">${pt ? 'Preparando a ferramenta local…' : 'Preparing the local tool…'}</div>
    </section>
    <aside class="tool-explainer" aria-labelledby="about-${tool.key}">
      <h2 id="about-${tool.key}">${pt ? 'Como funciona' : 'How it works'}</h2>
      <p>${escapeHtml(tool.note[language])}</p>
      <p>${escapeHtml(tool.limits[language])}</p>
    </aside>
  </main>
  ${footer(language)}
</body>
</html>`;
}

function directoryCard(tool, language) {
  const label = language === 'pt' ? 'Abrir' : 'Open';
  return `<a class="directory-card" href="${tool.paths[language]}" data-reveal>
          <span class="directory-index">${tool.index}</span><span class="tool-status">${escapeHtml(tool.status[language])}</span>
          <h3>${escapeHtml(tool.title[language])}</h3><p>${escapeHtml(tool.description[language])}</p><span class="text-link">${label} <span aria-hidden="true">↗</span></span>
        </a>`;
}

function directoryPage(language) {
  const pt = language === 'pt';
  const canonicalPath = pt ? '/pt-br/ferramentas/' : '/tools/';
  const alternatePath = pt ? '/tools/' : '/pt-br/ferramentas/';
  const title = pt ? 'Laboratório comunitário — Matheus Castro' : 'Community Lab — Matheus Castro';
  const description = pt
    ? `${allTools.length} utilitários rápidos, acessíveis e processados localmente, sem contas ou uploads desnecessários.`
    : `${allTools.length} fast, accessible, local-first utilities that work without accounts or unnecessary uploads.`;
  return `<!doctype html>
<html lang="${pt ? 'pt-BR' : 'en'}" data-theme="dark">
<head>
  ${head({ language, title, description, canonicalPath, alternatePath })}
</head>
<body>
  ${header(language, alternatePath)}
  <main id="main">
    <header class="section-shell page-hero" data-reveal>
      <p class="section-kicker">${pt ? 'Laboratório comunitário / processamento local' : 'Community lab / local-first'}</p>
      <h1>${pt ? 'Ferramentas pequenas. Problemas reais. Dados respeitados.' : 'Small tools. Real problems. Data respected.'}</h1>
      <p>${pt ? 'Tarefas técnicas úteis não deveriam exigir conta, assinatura ou upload. Estas ferramentas rodam no navegador e são construídas para teclado, toque e tecnologias assistivas.' : 'Useful technical tasks should not require an account, subscription, or upload. These tools run in the browser and are built for keyboard, touch, and assistive technology.'}</p>
      <div class="privacy-line"><span aria-hidden="true"></span>${pt ? 'Sem contas · Sem rastreamento · Processamento local explicado em cada ferramenta' : 'No accounts · No analytics · Local processing disclosed per tool'}</div>
    </header>
    <section class="section-shell tool-directory" aria-labelledby="available-tools">
      <h2 id="available-tools" class="sr-only">${pt ? 'Ferramentas disponíveis' : 'Available tools'}</h2>
      <div class="tool-directory-grid">${allTools.map((tool) => directoryCard(tool, language)).join('\n')}</div>
    </section>
    <section class="section-shell lab-principles" aria-labelledby="principles-title">
      <h2 id="principles-title">${pt ? 'As regras do laboratório.' : 'The rules of the lab.'}</h2>
      <ol>
        <li><strong>${pt ? 'Local por padrão.' : 'Local by default.'}</strong><span>${pt ? 'Seu conteúdo permanece no dispositivo. Downloads externos necessários são informados antes de começar.' : 'Your content stays on the device. Required external downloads are disclosed before work begins.'}</span></li>
        <li><strong>${pt ? 'Acessível desde o início.' : 'Accessible from the start.'}</strong><span>${pt ? 'Teclado, foco visível, movimento reduzido, estados claros e layouts resilientes são requisitos.' : 'Keyboard support, visible focus, reduced motion, clear states, and resilient layouts are requirements.'}</span></li>
        <li><strong>${pt ? 'Limites explícitos.' : 'Explicit limits.'}</strong><span>${pt ? 'Cada ferramenta explica o que consegue verificar, o que não consegue e o que você deve revisar.' : 'Every tool explains what it can verify, what it cannot, and what you should review.'}</span></li>
      </ol>
    </section>
  </main>
  ${footer(language)}
</body>
</html>`;
}

async function write(relativePath, content) {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, 'utf8');
}

await write('tools/index.html', directoryPage('en'));
await write('pt-br/ferramentas/index.html', directoryPage('pt'));
for (const tool of newTools) {
  await write(path.join(tool.paths.en.slice(1), 'index.html'), toolPage(tool, 'en'));
  await write(path.join(tool.paths.pt.slice(1), 'index.html'), toolPage(tool, 'pt'));
}

console.log(`Built ${newTools.length * 2} bilingual tool pages and both Lab directories.`);
