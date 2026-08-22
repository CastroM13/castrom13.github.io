import { base64UrlBytes, base64UrlJson, context, deepRedact, downloadJson, mask, setStatus } from '../toolkit.js';

const app = context('tokendesk');
if (app) initialize(app);

function initialize({ root, pt, t }) {
  root.innerHTML = `<div class="workbench-layout">
    <form class="workbench-controls" data-form>
      <div class="workbench-section-heading"><h2>${t('Inspect a token', 'Inspecionar um token')}</h2><span>${t('Input stays local', 'Entrada local')}</span></div>
      <label class="field-label" for="jwt-input">JWT</label>
      <textarea class="code-input" id="jwt-input" rows="8" spellcheck="false" autocomplete="off" placeholder="eyJhbGciOi…" required data-token></textarea>
      <label class="field-label" for="jwk-input">${t('JWK or JWKS (optional)', 'JWK ou JWKS (opcional)')}</label>
      <textarea class="code-input" id="jwk-input" rows="6" spellcheck="false" autocomplete="off" placeholder='{"kty":"RSA",…}' data-jwk></textarea>
      <div class="field-grid">
        <label><span class="field-label">${t('Clock skew (seconds)', 'Tolerância de relógio (segundos)')}</span><input class="number-input" type="number" min="0" max="600" value="0" data-skew></label>
        <label class="check-row"><input type="checkbox" checked data-redact> ${t('Mask identity and secret-like claims', 'Ocultar identidade e claims sensíveis')}</label>
      </div>
      <button class="button button-primary" type="submit">${t('Decode and inspect', 'Decodificar e inspecionar')}</button>
      <p class="workbench-status" role="status" aria-live="polite" data-status></p>
    </form>
    <section class="workbench-results" aria-labelledby="token-results-title">
      <div class="workbench-section-heading"><h2 id="token-results-title">${t('Inspection result', 'Resultado da inspeção')}</h2><span data-verification>${t('Not inspected', 'Não inspecionado')}</span></div>
      <div class="metric-grid" data-metrics></div>
      <div class="result-stack" hidden data-output>
        <section><div class="result-subheading"><h3>${t('Header', 'Cabeçalho')}</h3><button class="text-button" type="button" data-export>${t('Export minimal report', 'Exportar relatório mínimo')}</button></div><pre class="code-output" tabindex="0" data-header></pre></section>
        <section><h3>${t('Claims', 'Claims')}</h3><pre class="code-output" tabindex="0" data-payload></pre></section>
        <section><h3>${t('Time and policy checks', 'Verificações de tempo e política')}</h3><ul class="finding-list" data-findings></ul></section>
      </div>
      <div class="empty-result" data-empty><p>${t('Paste a compact JWT to inspect its structure. Add a JWK only when you also need local signature verification.', 'Cole um JWT compacto para inspecionar sua estrutura. Adicione uma JWK somente quando também quiser verificar a assinatura localmente.')}</p></div>
    </section>
  </div>`;

  const form = root.querySelector('[data-form]');
  const status = root.querySelector('[data-status]');
  const output = root.querySelector('[data-output]');
  const empty = root.querySelector('[data-empty]');
  const exportButton = root.querySelector('[data-export]');
  let lastExport = null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus(status, t('Inspecting locally…', 'Inspecionando localmente…'));
    try {
      const compact = root.querySelector('[data-token]').value.trim();
      const parts = compact.split('.');
      if (parts.length === 5) throw new Error(t('This looks like an encrypted JWE. TokenDesk currently inspects three-part signed or unsecured JWTs.', 'Isto parece um JWE criptografado. O TokenDesk inspeciona JWTs assinados ou sem assinatura com três partes.'));
      if (parts.length !== 3 || parts.some((part, index) => index < 2 && !part)) throw new Error(t('A compact JWT must contain three dot-separated segments.', 'Um JWT compacto precisa ter três segmentos separados por pontos.'));
      for (const part of parts) if (part && (!/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1)) throw new Error(t('JWT segments must use unpadded base64url without whitespace.', 'Os segmentos do JWT precisam usar base64url sem padding e sem espaços.'));
      const header = base64UrlJson(parts[0]);
      const payload = base64UrlJson(parts[1]);
      if (!header || typeof header !== 'object' || Array.isArray(header) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(t('Header and payload must be JSON objects, not arrays.', 'Cabeçalho e payload precisam ser objetos JSON, não arrays.'));
      const skew = Math.max(0, Math.min(600, Number(root.querySelector('[data-skew]').value) || 0));
      const findings = inspectClaims(header, payload, skew, t);
      let verification = { state: 'unverified', label: t('Decoded, not verified', 'Decodificado, não verificado') };
      const jwkText = root.querySelector('[data-jwk]').value.trim();
      if (jwkText) verification = await verifyJwt(parts, header, JSON.parse(jwkText), t);
      else if (header.alg === 'none') verification = { state: 'danger', label: t('Unsigned token', 'Token sem assinatura') };

      const shouldRedact = root.querySelector('[data-redact]').checked;
      const visiblePayload = shouldRedact ? redactClaims(payload) : payload;
      const exported = createExportReport(header, payload, verification, findings);
      lastExport = exported;
      root.querySelector('[data-header]').textContent = JSON.stringify(header, null, 2);
      root.querySelector('[data-payload]').textContent = JSON.stringify(visiblePayload, null, 2);
      renderFindings(root.querySelector('[data-findings]'), findings, verification, t);
      renderMetrics(root.querySelector('[data-metrics]'), header, payload, verification, t);
      const badge = root.querySelector('[data-verification]');
      badge.textContent = verification.label;
      badge.dataset.state = verification.state;
      output.hidden = false;
      empty.hidden = true;
      setStatus(status, t('Inspection complete. Nothing was uploaded or stored.', 'Inspeção concluída. Nada foi enviado ou armazenado.'), 'success');
    } catch (error) {
      output.hidden = true;
      empty.hidden = false;
      lastExport = null;
      const message = error instanceof SyntaxError ? t('The token or JWK contains invalid JSON.', 'O token ou a JWK contém JSON inválido.') : error instanceof Error ? error.message : String(error);
      setStatus(status, message, 'error');
    }
  });

  exportButton.addEventListener('click', () => {
    if (lastExport) downloadJson(lastExport, 'tokendesk-minimal-report.json');
  });
}

function redactClaims(payload) {
  const identityKeys = new Set(['sub', 'name', 'given_name', 'family_name', 'preferred_username', 'email', 'phone_number', 'address', 'jti', 'sid']);
  const copy = deepRedact(payload);
  const visit = (value, key = '') => {
    if (identityKeys.has(key)) return value && typeof value === 'object' ? '[REDACTED_IDENTITY]' : mask(value);
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  };
  return visit(copy);
}

export function createExportReport(header, payload, verification, findings) {
  const registeredClaims = ['exp', 'nbf', 'iat', 'iss', 'aud', 'sub', 'jti'];
  const knownAlgorithms = new Set(['none', 'HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']);
  const findingsByState = {};
  for (const finding of findings) findingsByState[finding.state] = (findingsByState[finding.state] || 0) + 1;
  const algorithm = typeof header.alg !== 'string' ? 'missing' : knownAlgorithms.has(header.alg) ? header.alg : 'unsupported';
  const type = typeof header.typ !== 'string' ? 'missing' : header.typ.toUpperCase() === 'JWT' ? 'JWT' : 'other';
  return {
    tool: 'TokenDesk',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    tokenMetadata: {
      algorithm,
      type,
      keyIdPresent: Object.hasOwn(header, 'kid'),
      claimCount: Object.keys(payload).length,
      registeredClaimsPresent: Object.fromEntries(registeredClaims.map((claim) => [claim, Object.hasOwn(payload, claim)]))
    },
    inspection: {
      signatureState: verification.state,
      findingsByState
    }
  };
}

function inspectClaims(header, payload, skew, t) {
  const now = Math.floor(Date.now() / 1000);
  const findings = [];
  if (!header.alg) findings.push({ state: 'danger', label: t('No alg value is declared in the header.', 'Nenhum valor alg foi declarado no cabeçalho.') });
  else if (header.alg === 'none') findings.push({ state: 'danger', label: t('alg=none means the token has no cryptographic signature.', 'alg=none significa que o token não possui assinatura criptográfica.') });
  else if (/^HS(?:256|384|512)$/.test(header.alg)) findings.push({ state: 'warning', label: t('HMAC uses a shared secret; confirm the verifier is not accepting a public key as that secret.', 'HMAC usa segredo compartilhado; confirme que o verificador não aceita uma chave pública como segredo.') });
  else if (!/^(?:RS|PS|ES)(?:256|384|512)$|^EdDSA$/.test(header.alg)) findings.push({ state: 'warning', label: t(`Algorithm ${header.alg} is not in this tool’s verification allowlist.`, `O algoritmo ${header.alg} não está na lista de verificação desta ferramenta.`) });
  else findings.push({ state: 'pass', label: t(`Declared algorithm: ${header.alg}.`, `Algoritmo declarado: ${header.alg}.`) });

  if (header.typ && String(header.typ).toUpperCase() !== 'JWT') findings.push({ state: 'warning', label: t(`Unexpected typ value: ${header.typ}.`, `Valor typ incomum: ${header.typ}.`) });
  if (Array.isArray(header.crit) && header.crit.length) findings.push({ state: 'warning', label: t(`Critical extensions are declared (${header.crit.join(', ')}); this inspector does not evaluate their application semantics.`, `Extensões críticas foram declaradas (${header.crit.join(', ')}); este inspetor não avalia sua semântica na aplicação.`) });
  if (header.b64 === false) findings.push({ state: 'danger', label: t('Unencoded payload semantics (b64=false) are unsupported.', 'A semântica de payload não codificado (b64=false) não é suportada.') });
  for (const [claim, relation, message] of [
    ['exp', 'past', t('The token is expired.', 'O token está expirado.')],
    ['nbf', 'future', t('The token is not active yet.', 'O token ainda não está ativo.')]
  ]) {
    if (!(claim in payload)) {
      findings.push({ state: 'warning', label: t(`No ${claim} claim is present.`, `O claim ${claim} não está presente.`) });
      continue;
    }
    if (typeof payload[claim] !== 'number' || !Number.isFinite(payload[claim])) {
      findings.push({ state: 'danger', label: t(`${claim} is not a numeric date.`, `${claim} não é uma data numérica.`) });
      continue;
    }
    const value = payload[claim];
    const failing = relation === 'past' ? value <= now - skew : value > now + skew;
    findings.push({ state: failing ? 'danger' : 'pass', label: failing ? message : t(`${claim} passes with ${skew}s clock skew.`, `${claim} passa com tolerância de ${skew}s.`) });
  }
  if ('iat' in payload) {
    if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) findings.push({ state: 'warning', label: t('iat is not a numeric date.', 'iat não é uma data numérica.') });
    else if (payload.iat > now + skew) findings.push({ state: 'warning', label: t('iat is in the future beyond the allowed clock skew.', 'iat está no futuro além da tolerância de relógio.') });
  }
  for (const claim of ['iss', 'aud', 'sub']) if (!(claim in payload)) findings.push({ state: 'neutral', label: t(`No ${claim} claim is present; whether it is required depends on the application.`, `O claim ${claim} não está presente; a obrigatoriedade depende da aplicação.`) });
  return findings;
}

function selectJwk(input, header) {
  if (input && Array.isArray(input.keys)) {
    if (header.kid) return input.keys.find((key) => key.kid === header.kid) || null;
    return input.keys.length === 1 ? input.keys[0] : null;
  }
  return input;
}

async function verifyJwt(parts, header, jwkInput, t) {
  if (!globalThis.crypto?.subtle) throw new Error(t('Web Crypto is unavailable in this browser context.', 'Web Crypto não está disponível neste contexto.'));
  const jwk = selectJwk(jwkInput, header);
  if (!jwk) throw new Error(t('No unambiguous JWK matches the token kid.', 'Nenhuma JWK inequívoca corresponde ao kid do token.'));
  const alg = header.alg;
  if (alg === 'none') return { state: 'danger', label: t('Unsigned token', 'Token sem assinatura') };
  const expectedKty = alg?.startsWith('HS') ? 'oct' : alg?.startsWith('ES') ? 'EC' : alg === 'EdDSA' ? 'OKP' : alg?.startsWith('RS') || alg?.startsWith('PS') ? 'RSA' : null;
  if (expectedKty && jwk.kty !== expectedKty) return { state: 'danger', label: t(`JWK type ${jwk.kty || 'missing'} does not match ${alg}.`, `O tipo JWK ${jwk.kty || 'ausente'} não corresponde a ${alg}.`) };
  if (jwk.alg && jwk.alg !== alg) return { state: 'danger', label: t(`JWK alg ${jwk.alg} does not match the token alg ${alg}.`, `O alg ${jwk.alg} da JWK não corresponde ao alg ${alg} do token.`) };
  if (jwk.use && jwk.use !== 'sig') return { state: 'danger', label: t('The JWK use is not sig.', 'O uso da JWK não é sig.') };
  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify')) return { state: 'danger', label: t('The JWK key_ops does not allow verification.', 'O key_ops da JWK não permite verificação.') };
  if (jwk.kty === 'oct' && base64UrlBytes(String(jwk.k || '')).byteLength < Number(String(alg).slice(-3)) / 8) return { state: 'warning', label: t('The HMAC key is shorter than the algorithm output size.', 'A chave HMAC é menor que o tamanho de saída do algoritmo.') };
  const hashes = { '256': 'SHA-256', '384': 'SHA-384', '512': 'SHA-512' };
  const suffix = String(alg).slice(-3);
  let importAlgorithm;
  let verifyAlgorithm;
  if (/^HS(?:256|384|512)$/.test(alg)) importAlgorithm = verifyAlgorithm = { name: 'HMAC', hash: hashes[suffix] };
  else if (/^RS(?:256|384|512)$/.test(alg)) importAlgorithm = verifyAlgorithm = { name: 'RSASSA-PKCS1-v1_5', hash: hashes[suffix] };
  else if (/^PS(?:256|384|512)$/.test(alg)) {
    importAlgorithm = { name: 'RSA-PSS', hash: hashes[suffix] };
    verifyAlgorithm = { name: 'RSA-PSS', saltLength: Number(suffix) / 8 };
  } else if (/^ES(?:256|384|512)$/.test(alg)) {
    const curves = { '256': 'P-256', '384': 'P-384', '512': 'P-521' };
    importAlgorithm = { name: 'ECDSA', namedCurve: curves[suffix] };
    verifyAlgorithm = { name: 'ECDSA', hash: hashes[suffix] };
  } else if (alg === 'EdDSA') importAlgorithm = verifyAlgorithm = { name: 'Ed25519' };
  else return { state: 'warning', label: t(`Unsupported verification algorithm: ${alg || 'missing'}`, `Algoritmo de verificação não suportado: ${alg || 'ausente'}`) };

  try {
    const key = await crypto.subtle.importKey('jwk', jwk, importAlgorithm, false, ['verify']);
    const valid = await crypto.subtle.verify(verifyAlgorithm, key, base64UrlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return valid
      ? { state: 'pass', label: t('Signature verified', 'Assinatura verificada') }
      : { state: 'danger', label: t('Invalid signature', 'Assinatura inválida') };
  } catch (error) {
    return { state: 'warning', label: t(`Verification unavailable: ${error.message}`, `Verificação indisponível: ${error.message}`) };
  }
}

function renderMetrics(container, header, payload, verification, t) {
  const exp = payload.exp;
  const expires = typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp * 1000).toLocaleString() : t('Not declared', 'Não declarado');
  const values = [
    [t('Algorithm', 'Algoritmo'), header.alg || '—'],
    [t('Key ID', 'ID da chave'), header.kid || t('Not declared', 'Não declarado')],
    [t('Expires', 'Expira'), expires],
    [t('Signature', 'Assinatura'), verification.label]
  ];
  container.replaceChildren(...values.map(([label, value]) => {
    const item = document.createElement('div');
    const span = document.createElement('span');
    const strong = document.createElement('strong');
    span.textContent = label;
    strong.textContent = value;
    item.append(span, strong);
    return item;
  }));
}

function renderFindings(container, findings, verification, t) {
  container.replaceChildren();
  const combined = [{ state: verification.state, label: verification.label }, ...findings];
  for (const finding of combined) {
    const item = document.createElement('li');
    item.dataset.state = finding.state;
    const state = document.createElement('strong');
    state.textContent = ({ pass: 'PASS', danger: t('RISK', 'RISCO'), warning: t('CHECK', 'REVISAR'), neutral: 'INFO', unverified: 'INFO' })[finding.state] || 'INFO';
    const text = document.createElement('span');
    text.textContent = finding.label;
    item.append(state, text);
    container.append(item);
  }
}
