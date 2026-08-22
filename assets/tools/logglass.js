import { context, downloadBlob, downloadJson, formatBytes, sanitizeFilename, setStatus } from '../toolkit.js';

const app = context('logglass');
if (app) initialize(app);

function initialize({ root, t }) {
  root.innerHTML = `<div class="workbench-layout">
    <form class="workbench-controls" data-form>
      <div class="workbench-section-heading"><h2>${t('Stream a log', 'Processar um log')}</h2><span>${t('Worker isolated', 'Worker isolado')}</span></div>
      <label class="field-label" for="log-file">${t('Text or JSONL file', 'Arquivo de texto ou JSONL')}</label><input class="file-input" id="log-file" type="file" required data-file>
      <label class="field-label" for="log-query">${t('Filter (optional)', 'Filtro (opcional)')}</label><input class="text-input" id="log-query" type="text" data-query>
      <div class="field-grid">
        <label><span class="field-label">${t('Level', 'Nível')}</span><select data-level><option>ALL</option><option>TRACE</option><option>DEBUG</option><option>INFO</option><option>NOTICE</option><option>WARN</option><option>ERROR</option><option>FATAL</option><option>OTHER</option></select></label>
        <label class="check-row"><input type="checkbox" data-regex> ${t('Treat filter as regular expression', 'Tratar filtro como expressão regular')}</label>
        <label class="check-row"><input type="checkbox" data-case> ${t('Case sensitive', 'Diferenciar maiúsculas')}</label>
      </div>
      <fieldset class="option-fieldset"><legend>${t('Additional redaction', 'Ocultação adicional')}</legend><label><input type="checkbox" checked data-email> ${t('Email addresses', 'Endereços de e-mail')}</label><label><input type="checkbox" data-ip> ${t('IPv4 addresses', 'Endereços IPv4')}</label></fieldset>
      <div class="button-row"><button class="button button-primary" type="submit">${t('Scan log', 'Examinar log')}</button><button class="button button-secondary" type="button" disabled data-cancel>${t('Cancel', 'Cancelar')}</button></div>
      <progress class="workbench-progress" max="1" value="0" hidden aria-label="${t('Scan progress', 'Progresso da varredura')}" data-progress></progress><p class="workbench-status" role="status" aria-live="polite" data-status></p>
    </form>
    <section class="workbench-results" aria-labelledby="log-results-title">
      <div class="workbench-section-heading"><h2 id="log-results-title" tabindex="-1">${t('Filtered, redacted view', 'Visão filtrada e sanitizada')}</h2><div><button class="text-button" type="button" disabled data-export-log>${t('Export filtered log', 'Exportar log filtrado')}</button><button class="text-button" type="button" disabled data-export-json>${t('Export summary', 'Exportar resumo')}</button></div></div>
      <div class="metric-grid" data-metrics></div><div hidden data-output><h3>${t('Level distribution', 'Distribuição de níveis')}</h3><div class="bar-chart" data-chart></div><div class="table-scroll" role="region" tabindex="0" aria-label="${t('Filtered log lines table', 'Tabela de linhas filtradas do log')}"><table class="data-table"><caption>${t('Retained matching lines (maximum 5,000)', 'Linhas correspondentes retidas (máximo 5.000)')}</caption><thead><tr><th>${t('Line', 'Linha')}</th><th>${t('Level', 'Nível')}</th><th>${t('Redacted content', 'Conteúdo sanitizado')}</th></tr></thead><tbody data-lines></tbody></table></div></div>
      <div class="empty-result" data-empty><p>${t('Preview memory is capped. Export is disabled above 100 MiB or when any line exceeds the 1 MiB inspection limit. Pattern-based redaction cannot prove a file safe; review before sharing.', 'A memória da prévia é limitada. A exportação é desativada acima de 100 MiB ou se alguma linha exceder o limite de inspeção de 1 MiB. A ocultação por padrões não prova que um arquivo é seguro; revise antes de compartilhar.')}</p></div>
    </section>
  </div>`;
  const form = root.querySelector('[data-form]'); const status = root.querySelector('[data-status]'); const progress = root.querySelector('[data-progress]'); const cancel = root.querySelector('[data-cancel]');
  const exportLog = root.querySelector('[data-export-log]'); const exportJson = root.querySelector('[data-export-json]');
  let worker = null; let result = null; let fileStem = 'log';
  function stop() { if (worker) { worker.terminate(); worker = null; } cancel.disabled = true; progress.hidden = true; }
  form.addEventListener('submit', (event) => {
    event.preventDefault(); stop(); result = null; exportLog.disabled = true; exportJson.disabled = true;
    const file = root.querySelector('[data-file]').files[0]; if (!file) return; fileStem = sanitizeFilename(file.name.replace(/\.[^.]+$/, ''), 'log');
    worker = new Worker('/assets/tools/logglass-worker.js', { type: 'module' }); cancel.disabled = false; progress.hidden = false; progress.max = file.size || 1; progress.value = 0;
    setStatus(status, t('Streaming file in a dedicated worker…', 'Processando o arquivo em um worker dedicado…'));
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') progress.value = data.bytes;
      if (data.type === 'error') { stop(); setStatus(status, localizeError(data.message, t), 'error'); }
      if (data.type === 'cancelled') { stop(); setStatus(status, t('Scan cancelled.', 'Varredura cancelada.'), 'warning'); }
      if (data.type === 'complete') {
        result = data; stop(); render(root, data, t); exportJson.disabled = false; exportLog.disabled = data.summary.exportTooLarge || data.summary.oversized > 0;
        root.querySelector('[data-output]').hidden = false; root.querySelector('[data-empty]').hidden = true;
        const message = data.summary.oversized
          ? t(`Scan complete with ${data.summary.oversized} oversized line(s). Those lines were truncated for inspection, so filtered export is disabled.`, `Varredura concluída com ${data.summary.oversized} linha(s) acima do limite. Elas foram truncadas para inspeção; por isso, a exportação filtrada foi desativada.`)
          : data.summary.exportTooLarge
            ? t('Scan complete. Filtered output exceeds the 100 MiB browser export cap; summary remains available.', 'Varredura concluída. A saída excede o limite de 100 MiB; o resumo continua disponível.')
            : t('Scan complete. Preview and full filtered export were pattern-redacted; review before sharing.', 'Varredura concluída. A prévia e a exportação filtrada foram ocultadas por padrões; revise antes de compartilhar.');
        setStatus(status, message, data.summary.exportTooLarge || data.summary.oversized ? 'warning' : 'success');
        root.querySelector('#log-results-title').focus();
      }
    };
    worker.postMessage({ type: 'scan', file, options: { query: root.querySelector('[data-query]').value, regex: root.querySelector('[data-regex]').checked, caseSensitive: root.querySelector('[data-case]').checked, level: root.querySelector('[data-level]').value, email: root.querySelector('[data-email]').checked, ip: root.querySelector('[data-ip]').checked } });
  });
  cancel.addEventListener('click', () => {
    if (worker) worker.postMessage({ type: 'cancel' });
    form.querySelector('button[type="submit"]').focus();
  });
  exportLog.addEventListener('click', () => result?.exportText != null && downloadBlob(new Blob([result.exportText], { type: 'text/plain' }), `${fileStem}.filtered.redacted.log`));
  exportJson.addEventListener('click', () => result && downloadJson({ tool: 'LogGlass', generatedAt: new Date().toISOString(), summary: result.summary }, `${fileStem}.logglass-summary.json`));
  addEventListener('pagehide', stop, { once: true });
}

function render(root, result, t) {
  renderMetrics(root.querySelector('[data-metrics]'), [[t('Lines', 'Linhas'), result.summary.lines.toLocaleString()], [t('Matches', 'Correspondências'), result.summary.matches.toLocaleString()], [t('Oversized lines', 'Linhas acima do limite'), result.summary.oversized.toLocaleString()], [t('Bytes read', 'Bytes lidos'), formatBytes(result.summary.bytes)]]);
  const chart = root.querySelector('[data-chart]'); chart.replaceChildren(); const max = Math.max(1, ...Object.values(result.summary.levels));
  for (const [level, count] of Object.entries(result.summary.levels).sort((a, b) => b[1] - a[1])) { const item = document.createElement('div'); const label = document.createElement('span'); label.textContent = `${level} · ${count}`; const track = document.createElement('i'); const bar = document.createElement('b'); bar.style.width = `${count / max * 100}%`; track.append(bar); item.append(label, track); chart.append(item); }
  const body = root.querySelector('[data-lines]'); body.replaceChildren();
  for (const line of result.preview) { const row = document.createElement('tr'); for (const value of [line.line, line.level, line.text]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } body.append(row); }
}
function renderMetrics(container, values) { container.replaceChildren(...values.map(([label, value]) => { const item = document.createElement('div'); const span = document.createElement('span'); span.textContent = label; const strong = document.createElement('strong'); strong.textContent = value; item.append(span, strong); return item; })); }
function localizeError(message, t) {
  if (message === 'Regular expressions are limited to 256 characters.') return t(message, 'Expressões regulares são limitadas a 256 caracteres.');
  return t(message, 'Não foi possível processar o log. Verifique o arquivo e o filtro informado.');
}
