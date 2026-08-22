import { context, downloadBlob, formatBytes, sanitizeFilename, setStatus } from '../toolkit.js';

const app = context('harsafe');
if (app) initialize(app);

const SENSITIVE_NAME = /pass(?:word)?|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret|authorization|auth|cookie|session|jwt|credential|signature|(?:^|[-_])sig(?:$|[-_])|(?:^|[-_])code(?:$|[-_])/i;

function initialize({ root, t }) {
  root.innerHTML = `<div class="workbench-layout">
    <form class="workbench-controls" data-form>
      <div class="workbench-section-heading"><h2>${t('Sanitize a trace', 'Sanitizar uma captura')}</h2><span>${t('Conservative defaults', 'Padrões conservadores')}</span></div>
      <label class="field-label" for="har-file">${t('HAR file', 'Arquivo HAR')}</label>
      <input class="file-input" id="har-file" type="file" accept=".har,.json,application/json" required data-file>
      <fieldset class="option-fieldset">
        <legend>${t('Redaction policy', 'Política de ocultação')}</legend>
        <label><input type="checkbox" checked disabled> ${t('Credentials, cookies, sensitive headers, and URL secrets', 'Credenciais, cookies, cabeçalhos sensíveis e segredos em URLs')}</label>
        <label><input type="checkbox" checked data-bodies> ${t('Remove request and response bodies', 'Remover corpos de requisição e resposta')}</label>
        <label><input type="checkbox" checked data-network> ${t('Mask server IPs and connection identifiers', 'Ocultar IPs de servidor e identificadores de conexão')}</label>
        <label><input type="checkbox" data-all-query> ${t('Redact every query value, not only sensitive names', 'Ocultar todos os valores de consulta, não apenas nomes sensíveis')}</label>
      </fieldset>
      <button class="button button-primary" type="submit">${t('Analyze and build sanitized copy', 'Analisar e criar cópia sanitizada')}</button>
      <p class="workbench-status" role="status" aria-live="polite" data-status></p>
    </form>
    <section class="workbench-results" aria-labelledby="har-results-title">
      <div class="workbench-section-heading"><h2 id="har-results-title" tabindex="-1">${t('Sanitized trace', 'Captura sanitizada')}</h2><button class="text-button" type="button" disabled data-download>${t('Download sanitized HAR', 'Baixar HAR sanitizado')}</button></div>
      <div class="metric-grid" data-metrics></div>
      <section hidden data-output>
        <h3>${t('Applied redactions', 'Ocultações aplicadas')}</h3><ul class="finding-list" data-redactions></ul>
        <h3>${t('Lightweight waterfall', 'Waterfall leve')}</h3>
        <p class="field-help">${t('Bars are normalized to this capture. The table is the canonical numerical view.', 'As barras são normalizadas para esta captura. A tabela é a visão numérica canônica.')}</p>
        <div class="waterfall" aria-hidden="true" data-waterfall></div>
        <div class="table-scroll" role="region" tabindex="0" aria-label="${t('Sanitized request timing table', 'Tabela sanitizada de tempo das requisições')}"><table class="data-table"><caption>${t('Sanitized request timing summary', 'Resumo sanitizado de tempo das requisições')}</caption><thead><tr><th>#</th><th>${t('Request', 'Requisição')}</th><th>${t('Status', 'Status')}</th><th>${t('Duration', 'Duração')}</th><th>${t('Transfer', 'Transferência')}</th></tr></thead><tbody data-entries></tbody></table></div>
      </section>
      <div class="empty-result" data-empty><p>${t('The export is built from a clone. Timing and byte fields describe the original capture even when content is removed.', 'A exportação é criada a partir de uma cópia. Tempos e bytes descrevem a captura original mesmo quando conteúdo é removido.')}</p></div>
    </section>
  </div>`;

  const form = root.querySelector('[data-form]');
  const status = root.querySelector('[data-status]');
  const download = root.querySelector('[data-download]');
  let sanitizedHar = null;
  let sourceName = 'trace';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = root.querySelector('[data-file]').files[0];
    if (!file) return;
    if (file.size > 250 * 1024 * 1024) {
      setStatus(status, t('This browser tool limits HAR input to 250 MiB.', 'Esta ferramenta limita a entrada HAR a 250 MiB.'), 'error');
      return;
    }
    setStatus(status, t('Parsing and sanitizing locally…', 'Interpretando e sanitizando localmente…'));
    try {
      const parsed = JSON.parse(await file.text());
      validateHar(parsed, t);
      const policy = {
        removeBodies: root.querySelector('[data-bodies]').checked,
        maskNetwork: root.querySelector('[data-network]').checked,
        allQuery: root.querySelector('[data-all-query]').checked
      };
      const result = sanitizeHar(parsed, policy);
      sanitizedHar = result.har;
      sourceName = sanitizeFilename(file.name.replace(/\.(?:har|json)$/i, ''), 'trace');
      render(root, result, t);
      download.disabled = false;
      root.querySelector('[data-output]').hidden = false;
      root.querySelector('[data-empty]').hidden = true;
      setStatus(status, t(`Sanitized copy ready with ${result.totalRedactions} applied redactions. Review it before sharing.`, `Cópia sanitizada pronta com ${result.totalRedactions} ocultações. Revise antes de compartilhar.`), 'success');
      root.querySelector('#har-results-title').focus();
    } catch (error) {
      sanitizedHar = null;
      download.disabled = true;
      root.querySelector('[data-output]').hidden = true;
      root.querySelector('[data-empty]').hidden = false;
      setStatus(status, error instanceof SyntaxError ? t('The HAR is not valid JSON.', 'O HAR não contém JSON válido.') : error.message, 'error');
    }
  });

  download.addEventListener('click', () => {
    if (!sanitizedHar) return;
    const serialized = JSON.stringify(sanitizedHar, null, 2);
    downloadBlob(new Blob([serialized], { type: 'application/json' }), `${sourceName}.sanitized.har`);
  });
  addEventListener('pagehide', () => { sanitizedHar = null; }, { once: true });
}

function validateHar(value, t) {
  if (!value || typeof value !== 'object' || !value.log || !Array.isArray(value.log.entries)) {
    throw new Error(t('Expected a HAR object with log.entries[].', 'Era esperado um objeto HAR com log.entries[].'));
  }
}

export function sanitizeHar(source, policy) {
  const har = structuredClone(source);
  const counts = new Map();
  const bump = (key, amount = 1) => counts.set(key, (counts.get(key) || 0) + amount);
  const entries = har.log.entries;
  for (const entry of entries) {
    const request = entry.request || {};
    const response = entry.response || {};
    request.url = sanitizeUrl(String(request.url || ''), policy.allQuery, bump);
    sanitizeNamedValues(request.headers, 'header', bump);
    sanitizeNamedValues(response.headers, 'header', bump);
    sanitizeNamedValues(request.cookies, 'cookie', bump, true);
    sanitizeNamedValues(response.cookies, 'cookie', bump, true);
    sanitizeNamedValues(request.queryString, 'query value', bump, policy.allQuery);
    if (policy.removeBodies) {
      if (Array.isArray(request.postData?.params) && request.postData.params.length) { bump('request body parameters', request.postData.params.length); request.postData.params = []; }
      if (request.postData && 'text' in request.postData) { request.postData.text = '[REMOVED_BY_HARSAFE]'; bump('request bodies'); }
      if (response.content && 'text' in response.content) { response.content.text = '[REMOVED_BY_HARSAFE]'; delete response.content.encoding; bump('response bodies'); }
    } else {
      sanitizeNamedValues(request.postData?.params, 'body field', bump);
      if (Array.isArray(request.postData?.params)) for (const parameter of request.postData.params) if (parameter?.fileName) { parameter.fileName = '[REDACTED_FILENAME]'; bump('body filenames'); }
      sanitizeBody(request.postData, bump);
      sanitizeBody(response.content, bump);
    }
    if (response.redirectURL) response.redirectURL = sanitizeUrl(String(response.redirectURL), policy.allQuery, bump);
    if (policy.maskNetwork) {
      if (entry.serverIPAddress) { entry.serverIPAddress = '[REDACTED_IP]'; bump('network identifiers'); }
      if (entry.connection) { entry.connection = '[REDACTED_CONNECTION]'; bump('network identifiers'); }
    }
    recursiveFallback(entry, [], bump);
  }
  if (Array.isArray(har.log.pages)) {
    for (const page of har.log.pages) if (page.title) { page.title = '[REDACTED_PAGE_TITLE]'; bump('page titles'); }
  }
  har.log._harsafe = {
    sanitized: true,
    generatedAt: new Date().toISOString(),
    notice: 'Headers, cookies, URL values, bodies, and extension fields may have been redacted. Numeric size and timing fields describe the original capture. Review before sharing.',
    redactions: Object.fromEntries(counts)
  };
  return { har, counts, totalRedactions: [...counts.values()].reduce((sum, value) => sum + value, 0), entries: summarizeEntries(entries) };
}

function sanitizeNamedValues(items, category, bump, redactAll = false) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('value' in item)) continue;
    if (category === 'header' && /^(?:location|content-location)$/i.test(String(item.name || ''))) {
      item.value = sanitizeUrl(String(item.value || ''), false, bump);
      continue;
    }
    if (redactAll || SENSITIVE_NAME.test(String(item.name || ''))) {
      item.value = `[REDACTED_${category.toUpperCase().replace(' ', '_')}]`;
      bump(`${category}s`);
    }
  }
}

function sanitizeUrl(value, allQuery, bump) {
  try {
    const url = new URL(value);
    if (url.username || url.password) { url.username = ''; url.password = ''; bump('URL credentials'); }
    for (const key of [...url.searchParams.keys()]) {
      if (allQuery || SENSITIVE_NAME.test(key)) { url.searchParams.set(key, '[REDACTED]'); bump('URL query values'); }
    }
    if (url.hash) { url.hash = ''; bump('URL fragments'); }
    return url.toString();
  } catch (_) {
    let sanitized = value.replace(/((?:https?:)?\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
    sanitized = sanitized.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator, rawName) => {
      let name = rawName;
      try { name = decodeURIComponent(rawName.replace(/\+/g, ' ')); } catch (_) { /* inspect the raw name */ }
      return allQuery || SENSITIVE_NAME.test(name) ? `${separator}${rawName}=[REDACTED]` : match;
    });
    sanitized = sanitized.replace(/#.*$/, '');
    if (sanitized !== value) bump('invalid URL fields');
    return sanitized;
  }
}

function sanitizeBody(container, bump) {
  if (!container || typeof container.text !== 'string' || !container.text) return;
  if (container.encoding === 'base64') { container.text = '[REMOVED_BASE64_BODY]'; delete container.encoding; bump('opaque bodies'); return; }
  const mime = String(container.mimeType || '').toLowerCase();
  if (mime.includes('json')) {
    try {
      const parsed = JSON.parse(container.text);
      container.text = JSON.stringify(redactObject(parsed, bump));
      return;
    } catch (_) { /* remove below */ }
  }
  if (mime.includes('x-www-form-urlencoded')) {
    const params = new URLSearchParams(container.text);
    for (const key of params.keys()) if (SENSITIVE_NAME.test(key)) { params.set(key, '[REDACTED]'); bump('body fields'); }
    container.text = params.toString();
    return;
  }
  container.text = '[REMOVED_UNPARSEABLE_BODY]';
  bump('opaque bodies');
}

function redactObject(value, bump, key = '') {
  if (key && SENSITIVE_NAME.test(key)) { bump('body fields'); return '[REDACTED]'; }
  if (Array.isArray(value)) return value.map((item) => redactObject(item, bump));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactObject(item, bump, name)]));
  return value;
}

function recursiveFallback(value, path, bump) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['request', 'response', 'timings', 'cache'].includes(key) && path.length === 0) { recursiveFallback(item, [...path, key], bump); continue; }
    if (SENSITIVE_NAME.test(key) && !['headers', 'cookies', 'queryString', 'postData'].includes(key)) {
      if (!(typeof item === 'string' && (item.startsWith('[REDACTED') || item.startsWith('[REMOVED')))) { value[key] = '[REDACTED_EXTENSION_FIELD]'; bump('extension fields'); }
    } else if (typeof item === 'string') {
      const sanitized = sanitizeKnownPatterns(item);
      if (sanitized !== item) { value[key] = sanitized; bump('credential-shaped values'); }
    } else if (typeof item === 'object') recursiveFallback(item, [...path, key], bump);
  }
}

function sanitizeKnownPatterns(value) {
  const credentialsRemoved = value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, '[REDACTED_AUTH]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\b(?:gh[pousr]_|github_pat_|ghs_)[A-Za-z0-9._-]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  return credentialsRemoved.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrl(url, false, () => {}));
}

function summarizeEntries(entries) {
  const starts = entries.map((entry) => Date.parse(entry.startedDateTime)).filter(Number.isFinite);
  const origin = starts.reduce((earliest, value) => Math.min(earliest, value), Infinity);
  return entries.map((entry, index) => {
    const parsedStart = Date.parse(entry.startedDateTime);
    const start = Number.isFinite(parsedStart) ? Math.max(0, parsedStart - (Number.isFinite(origin) ? origin : 0)) : index;
    const duration = Math.max(0, Number(entry.time) || 0);
    let label = String(entry.request?.url || 'unknown');
    try { const url = new URL(label); label = `${url.host}${url.pathname}`; } catch (_) { label = label.slice(0, 120); }
    return { index: index + 1, method: entry.request?.method || '—', label, status: entry.response?.status ?? '—', duration, start, size: Math.max(0, Number(entry.response?.bodySize ?? entry.response?.content?.size) || 0) };
  });
}

function render(root, result, t) {
  const domains = new Set();
  for (const entry of result.har.log.entries) try { domains.add(new URL(entry.request?.url).host); } catch (_) {}
  const totalBytes = result.entries.reduce((sum, entry) => sum + entry.size, 0);
  renderMetrics(root.querySelector('[data-metrics]'), [
    [t('Requests', 'Requisições'), result.entries.length.toLocaleString()],
    [t('Domains', 'Domínios'), domains.size.toLocaleString()],
    [t('Original transfer', 'Transferência original'), formatBytes(totalBytes)],
    [t('Redactions', 'Ocultações'), result.totalRedactions.toLocaleString()]
  ]);
  const list = root.querySelector('[data-redactions]');
  list.replaceChildren();
  const categoryLabels = {
    headers: t('headers', 'cabeçalhos'), cookies: t('cookies', 'cookies'), 'query values': t('query values', 'valores de consulta'),
    'body fields': t('body fields', 'campos de corpo'), 'request bodies': t('request bodies', 'corpos de requisição'),
    'request body parameters': t('request body parameters', 'parâmetros do corpo da requisição'), 'body filenames': t('body filenames', 'nomes de arquivos no corpo'),
    'response bodies': t('response bodies', 'corpos de resposta'), 'network identifiers': t('network identifiers', 'identificadores de rede'),
    'URL credentials': t('URL credentials', 'credenciais em URL'), 'URL query values': t('URL query values', 'valores de consulta em URL'),
    'URL fragments': t('URL fragments', 'fragmentos de URL'), 'invalid URL fields': t('invalid URL fields', 'campos de URL inválida'),
    'opaque bodies': t('opaque bodies', 'corpos opacos'), 'extension fields': t('extension fields', 'campos de extensão'),
    'credential-shaped values': t('credential-shaped values', 'valores em formato de credencial'), 'page titles': t('page titles', 'títulos de página')
  };
  for (const [name, count] of result.counts) {
    const item = document.createElement('li'); item.dataset.state = 'pass';
    const strong = document.createElement('strong'); strong.textContent = count;
    const span = document.createElement('span'); span.textContent = categoryLabels[name] || name;
    item.append(strong, span); list.append(item);
  }
  const maxEnd = result.entries.reduce((maximum, entry) => Math.max(maximum, entry.start + entry.duration), 1);
  const waterfall = root.querySelector('[data-waterfall]'); waterfall.replaceChildren();
  const body = root.querySelector('[data-entries]'); body.replaceChildren();
  for (const entry of result.entries.slice(0, 500)) {
    const barRow = document.createElement('div'); barRow.className = 'waterfall-row';
    const label = document.createElement('span'); label.textContent = String(entry.index);
    const track = document.createElement('div'); const bar = document.createElement('i');
    bar.style.setProperty('--offset', `${Math.min(100, entry.start / maxEnd * 100)}%`);
    bar.style.setProperty('--width', `${Math.max(0.4, Math.min(100, entry.duration / maxEnd * 100))}%`);
    track.append(bar); barRow.append(label, track); waterfall.append(barRow);
    const row = document.createElement('tr');
    for (const value of [entry.index, `${entry.method} ${entry.label}`, entry.status, `${entry.duration.toFixed(1)} ms`, formatBytes(entry.size)]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    body.append(row);
  }
}

function renderMetrics(container, values) {
  container.replaceChildren(...values.map(([label, value]) => {
    const item = document.createElement('div'); const span = document.createElement('span'); const strong = document.createElement('strong');
    span.textContent = label; strong.textContent = value; item.append(span, strong); return item;
  }));
}
