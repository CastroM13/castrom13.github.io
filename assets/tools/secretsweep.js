import { context, downloadJson, entropy, setStatus } from '../toolkit.js';

const app = context('secretsweep');
if (app) initialize(app);

const PROVIDER_RULES = [
  ['Private key', 'high', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, 'Revoke or rotate every credential derived from this key and remove it from repository history.'],
  ['AWS access key ID', 'high', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'Disable and rotate the key in AWS IAM, then investigate its access history.'],
  ['GitHub token', 'high', /\b(?:gh[pousr]_[A-Za-z0-9._-]{20,}|github_pat_[A-Za-z0-9_]{20,}|ghs_[A-Za-z0-9._-]{20,})\b/g, 'Revoke the token in GitHub, create a least-privilege replacement, and clean repository history if committed.'],
  ['Slack token', 'high', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'Revoke the token in Slack and review application and workspace audit logs.'],
  ['Google API key', 'high', /\bAIza[0-9A-Za-z_-]{35}\b/g, 'Restrict or rotate the key in Google Cloud and review its API usage.'],
  ['Stripe live key', 'high', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, 'Roll the key in Stripe immediately and review recent API activity.'],
  ['npm token', 'high', /\bnpm_[A-Za-z0-9]{30,}\b/g, 'Revoke the token in npm, rotate it, and review package publication activity.'],
  ['Bearer credential', 'medium', /\b(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}/gi, 'Rotate the credential at its issuer and replace it with a scoped, short-lived token.'],
  ['JWT-shaped value', 'medium', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\b/g, 'Treat the token as exposed, revoke its session where possible, and rotate the signing or client credential if warranted.'],
  ['Basic-auth URL', 'high', /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi, 'Rotate the embedded credential and remove it from URLs, logs, and repository history.'],
  ['Sensitive assignment', 'medium', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|password|passwd|pwd|secret)\b\s*[:=]\s*["']?([^\s,"'`;]{8,})/gi, 'Rotate the value at its issuer and load the replacement from a managed secret store.']
];

const FINDING_PT = {
  'Private key': ['Chave privada', 'Revogue ou rotacione toda credencial derivada desta chave e remova-a do histórico do repositório.'],
  'AWS access key ID': ['ID de chave de acesso AWS', 'Desative e rotacione a chave no AWS IAM e investigue o histórico de acesso.'],
  'GitHub token': ['Token do GitHub', 'Revogue o token no GitHub, crie outro com privilégio mínimo e limpe o histórico do repositório se ele tiver sido versionado.'],
  'Slack token': ['Token do Slack', 'Revogue o token no Slack e revise os logs de auditoria do aplicativo e do workspace.'],
  'Google API key': ['Chave de API do Google', 'Restrinja ou rotacione a chave no Google Cloud e revise o uso das APIs.'],
  'Stripe live key': ['Chave ativa do Stripe', 'Substitua imediatamente a chave no Stripe e revise a atividade recente da API.'],
  'npm token': ['Token do npm', 'Revogue e rotacione o token no npm e revise a atividade de publicação de pacotes.'],
  'Bearer credential': ['Credencial Bearer', 'Rotacione a credencial no emissor e substitua-a por um token de escopo restrito e curta duração.'],
  'JWT-shaped value': ['Valor em formato JWT', 'Trate o token como exposto, revogue a sessão quando possível e rotacione a credencial de assinatura ou do cliente se necessário.'],
  'Basic-auth URL': ['URL com autenticação básica', 'Rotacione a credencial incorporada e remova-a de URLs, logs e do histórico do repositório.'],
  'Sensitive assignment': ['Atribuição sensível', 'Rotacione o valor no emissor e carregue o substituto a partir de um gerenciador de segredos.'],
  'High-entropy value': ['Valor de alta entropia', 'Identifique o responsável pelo valor. Se ele autenticar acesso, rotacione-o no emissor e remova-o do histórico versionado.']
};

function initialize({ root, t }) {
  root.innerHTML = `<div class="workbench-layout">
    <form class="workbench-controls" data-form>
      <div class="workbench-section-heading"><h2>${t('Scan locally', 'Examinar localmente')}</h2><span>${t('Nothing retained', 'Nada retido')}</span></div>
      <label class="field-label" for="secret-text">${t('Paste text (optional)', 'Cole texto (opcional)')}</label>
      <textarea class="code-input" id="secret-text" rows="10" spellcheck="false" autocomplete="off" placeholder="${t('Configuration, logs, environment variables…', 'Configuração, logs, variáveis de ambiente…')}" data-text></textarea>
      <label class="field-label" for="secret-files">${t('Or select text files', 'Ou selecione arquivos de texto')}</label>
      <input class="file-input" id="secret-files" type="file" multiple data-files>
      <fieldset class="option-fieldset">
        <legend>${t('Review policy', 'Política de revisão')}</legend>
        <label><input type="checkbox" checked data-entropy> ${t('Include high-entropy candidates (review confidence)', 'Incluir candidatos de alta entropia (revisão)')}</label>
        <label><input type="checkbox" checked data-anonymize> ${t('Anonymize file names in exported report', 'Anonimizar nomes de arquivos no relatório exportado')}</label>
      </fieldset>
      <div class="button-row"><button class="button button-primary" type="submit">${t('Run SecretSweep', 'Executar SecretSweep')}</button><button class="button button-secondary" type="reset">${t('Clear', 'Limpar')}</button></div>
      <progress class="workbench-progress" max="1" value="0" hidden aria-label="${t('Scan progress', 'Progresso da varredura')}" data-progress></progress>
      <p class="workbench-status" role="status" aria-live="polite" data-status></p>
    </form>
    <section class="workbench-results" aria-labelledby="secret-results-title">
      <div class="workbench-section-heading"><h2 id="secret-results-title" tabindex="-1">${t('Redacted findings', 'Achados sanitizados')}</h2><button class="text-button" type="button" disabled data-export>${t('Export report', 'Exportar relatório')}</button></div>
      <div class="metric-grid" data-metrics></div>
      <div class="table-scroll" role="region" tabindex="0" aria-label="${t('SecretSweep findings table', 'Tabela de achados do SecretSweep')}" hidden data-table-wrap><table class="data-table"><caption>${t('Potential exposures; raw values are never shown', 'Possíveis exposições; valores originais nunca são exibidos')}</caption><thead><tr><th>${t('Confidence', 'Confiança')}</th><th>${t('Type', 'Tipo')}</th><th>${t('Location', 'Local')}</th><th>${t('Masked match', 'Correspondência oculta')}</th><th>${t('Action', 'Ação')}</th></tr></thead><tbody data-findings></tbody></table></div>
      <div class="empty-result" data-empty><p>${t('Provider-specific patterns are reported separately from entropy-only candidates. A clean scan cannot prove that no secret exists.', 'Padrões específicos de provedores aparecem separados de candidatos por entropia. Uma varredura limpa não prova que nenhum segredo existe.')}</p></div>
    </section>
  </div>`;

  const form = root.querySelector('[data-form]');
  const status = root.querySelector('[data-status]');
  const progress = root.querySelector('[data-progress]');
  const exportButton = root.querySelector('[data-export]');
  let report = null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = root.querySelector('[data-text]').value;
    const files = [...root.querySelector('[data-files]').files];
    if (!text.trim() && !files.length) {
      setStatus(status, t('Paste text or select at least one file.', 'Cole texto ou selecione ao menos um arquivo.'), 'error');
      return;
    }
    const includeEntropy = root.querySelector('[data-entropy]').checked;
    const findings = [];
    let totalLines = 0;
    let skippedBinary = 0;
    let omitted = 0;
    progress.hidden = false;
    progress.max = Math.max(1, files.length + (text.trim() ? 1 : 0));
    progress.value = 0;
    setStatus(status, t('Scanning without persisting raw matches…', 'Examinando sem persistir correspondências brutas…'));
    try {
      const processLine = (line, location, lineNumber) => {
        totalLines += 1;
        const detected = scanLine(line, includeEntropy, t);
        for (const item of detected) {
          if (findings.length >= 2_000) { omitted += 1; continue; }
          findings.push({ ...item, file: location, line: lineNumber });
        }
      };
      if (text.trim()) {
        text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).forEach((line, index) => processLine(line, t('Pasted text', 'Texto colado'), index + 1));
        progress.value += 1;
      }
      for (const file of files) {
        if (await looksBinary(file)) { skippedBinary += 1; progress.value += 1; continue; }
        let fileLines = 0;
        for await (const segment of streamSegments(file)) {
          const detected = scanLine(segment.text, includeEntropy, t)
            .filter((item) => item.column - 1 < segment.acceptBefore);
          fileLines = Math.max(fileLines, segment.lineNumber);
          for (const item of detected) {
            if (findings.length >= 2_000) { omitted += 1; continue; }
            findings.push({ ...item, file: file.name, line: segment.lineNumber, column: item.column + segment.columnOffset });
          }
        }
        totalLines += fileLines;
        progress.value += 1;
      }
      report = {
        tool: 'SecretSweep', generatedAt: new Date().toISOString(),
        summary: { files: files.length, lines: totalLines, findings: findings.length + omitted, retainedFindings: findings.length, omitted, skippedBinary },
        findings
      };
      render(root, report, t);
      exportButton.disabled = false;
      setStatus(status, findings.length || omitted
        ? t(`Scan complete: ${findings.length + omitted} potential exposure${findings.length + omitted === 1 ? '' : 's'}. Rotate confirmed credentials; do not only delete the file.`, `Varredura concluída: ${findings.length + omitted} possível(is) exposição(ões). Revogue credenciais confirmadas; não apenas apague o arquivo.`)
        : t('No configured pattern matched. This does not prove the absence of secrets.', 'Nenhum padrão configurado correspondeu. Isso não prova a ausência de segredos.'), findings.length ? 'warning' : 'success');
      root.querySelector('#secret-results-title').focus();
    } catch (error) {
      report = null;
      exportButton.disabled = true;
      setStatus(status, error.message, 'error');
    } finally {
      progress.hidden = true;
    }
  });

  form.addEventListener('reset', () => {
    setTimeout(() => {
      report = null;
      exportButton.disabled = true;
      root.querySelector('[data-findings]').replaceChildren();
      root.querySelector('[data-table-wrap]').hidden = true;
      root.querySelector('[data-empty]').hidden = false;
      root.querySelector('[data-metrics]').replaceChildren();
      setStatus(status, '');
    });
  });
  exportButton.addEventListener('click', () => {
    if (!report) return;
    const anonymize = root.querySelector('[data-anonymize]').checked;
    const aliases = new Map(); let sequence = 0;
    const fileName = (value) => {
      if (!anonymize || value === t('Pasted text', 'Texto colado')) return value;
      if (!aliases.has(value)) aliases.set(value, `file-${String(++sequence).padStart(3, '0')}`);
      return aliases.get(value);
    };
    downloadJson({ ...report, findings: report.findings.map((finding) => ({ ...finding, file: fileName(finding.file) })) }, 'secretsweep-redacted-report.json');
  });
  addEventListener('pagehide', () => { report = null; root.querySelector('[data-text]').value = ''; }, { once: true });
}

export function scanLine(line, includeEntropy, t = (english) => english) {
  const findings = [];
  const occupied = [];
  for (const [type, confidence, pattern, remediation] of PROVIDER_RULES) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      const raw = match[0];
      if (looksPlaceholder(raw)) continue;
      const start = match.index || 0;
      const localized = FINDING_PT[type] || [type, remediation];
      findings.push({ type: t(type, localized[0]), confidence, column: start + 1, preview: prefixOnly(raw, type), remediation: t(remediation, localized[1]) });
      occupied.push([start, start + raw.length]);
    }
  }
  if (includeEntropy) {
    const candidates = line.match(/[A-Za-z0-9_+./=-]{20,200}/g) || [];
    let searchFrom = 0;
    for (const candidate of candidates) {
      const index = line.indexOf(candidate, searchFrom);
      searchFrom = index + candidate.length;
      if (occupied.some(([start, end]) => index < end && index + candidate.length > start)) continue;
      if (!entropyCandidate(candidate)) continue;
      const type = 'High-entropy value';
      const remediation = 'Identify the value’s owner. If it authenticates access, rotate it at the issuer and remove committed history.';
      findings.push({ type: t(type, FINDING_PT[type][0]), confidence: 'review', column: index + 1, preview: '[HIGH_ENTROPY_VALUE]', remediation: t(remediation, FINDING_PT[type][1]) });
    }
  }
  return findings;
}

function looksPlaceholder(value) {
  return /(?:\$\{|<[^>]+>|redacted|example|dummy|changeme|your[_-]|replace[_-]?me|test[_-]?(?:key|token|secret))/i.test(value);
}

function entropyCandidate(value) {
  if (looksPlaceholder(value) || /(?:checksum|integrity|sha(?:sum)?)[=:]/i.test(value) || /^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) || /^sha\d+-/i.test(value)) return false;
  if (new Set(value).size < 8) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((expression) => expression.test(value)).length;
  return classes >= 3 && entropy(value) >= 4 && entropy(value) * value.length >= 100;
}

function prefixOnly(value, type) {
  if (/GitHub/.test(type)) return `${value.slice(0, value.indexOf('_') + 1)}…`;
  if (/AWS/.test(type)) return `${value.slice(0, 4)}…`;
  if (/Slack/.test(type)) return `${value.slice(0, 5)}…`;
  if (/Stripe/.test(type)) return `${value.slice(0, 8)}…`;
  if (/npm/.test(type)) return 'npm_…';
  if (/Google/.test(type)) return 'AIza…';
  if (/Private/.test(type)) return '[PRIVATE_KEY_BLOCK]';
  return '[REDACTED_CREDENTIAL]';
}

async function looksBinary(file) {
  const bytes = new Uint8Array(await file.slice(0, 8_192).arrayBuffer());
  return bytes.includes(0);
}

async function* streamSegments(file) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  const limit = 262_144;
  const overlap = 512;
  let carry = '';
  let lineNumber = 1;
  let columnOffset = 0;
  const segment = function* (line, finalPart) {
    while (line.length > limit + overlap) {
      yield { text: line.slice(0, limit + overlap), lineNumber, columnOffset, acceptBefore: limit };
      line = line.slice(limit);
      columnOffset += limit;
    }
    if (finalPart) {
      yield { text: line, lineNumber, columnOffset, acceptBefore: Infinity };
      columnOffset = 0;
      lineNumber += 1;
    } else carry = line;
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    while (true) {
      const match = carry.match(/[\r\n]/);
      if (match && match.index === carry.length - 1 && match[0] === '\r') break;
      if (match) {
        const index = match.index;
        const separatorLength = match[0] === '\r' && carry[index + 1] === '\n' ? 2 : 1;
        const line = carry.slice(0, index);
        carry = carry.slice(index + separatorLength);
        yield* segment(line, true);
        continue;
      }
      if (carry.length > limit + overlap) {
        yield { text: carry.slice(0, limit + overlap), lineNumber, columnOffset, acceptBefore: limit };
        carry = carry.slice(limit);
        columnOffset += limit;
      }
      break;
    }
  }
  carry += decoder.decode();
  while (true) {
    const match = carry.match(/[\r\n]/);
    if (!match) break;
    const index = match.index;
    const separatorLength = match[0] === '\r' && carry[index + 1] === '\n' ? 2 : 1;
    const line = carry.slice(0, index);
    carry = carry.slice(index + separatorLength);
    yield* segment(line, true);
  }
  if (carry || lineNumber === 1) yield* segment(carry, true);
}

function render(root, report, t) {
  const metrics = [
    [t('Lines scanned', 'Linhas examinadas'), report.summary.lines.toLocaleString()],
    [t('Potential exposures', 'Possíveis exposições'), report.summary.findings.toLocaleString()],
    [t('Binary files skipped', 'Arquivos binários ignorados'), report.summary.skippedBinary.toLocaleString()],
    [t('Raw values exported', 'Valores brutos exportados'), '0']
  ];
  const metricContainer = root.querySelector('[data-metrics]');
  metricContainer.replaceChildren(...metrics.map(([label, value]) => {
    const item = document.createElement('div');
    const span = document.createElement('span'); span.textContent = label;
    const strong = document.createElement('strong'); strong.textContent = value;
    item.append(span, strong); return item;
  }));
  const body = root.querySelector('[data-findings]');
  body.replaceChildren();
  for (const finding of report.findings) {
    const row = document.createElement('tr');
    const confidence = { high: t('HIGH', 'ALTA'), medium: t('MEDIUM', 'MÉDIA'), review: t('REVIEW', 'REVISAR') }[finding.confidence] || finding.confidence.toUpperCase();
    for (const value of [confidence, finding.type, `${finding.file}:${finding.line}:${finding.column}`, finding.preview, finding.remediation]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    body.append(row);
  }
  root.querySelector('[data-table-wrap]').hidden = !report.findings.length;
  root.querySelector('[data-empty]').hidden = Boolean(report.findings.length);
}
