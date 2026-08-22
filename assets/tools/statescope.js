import { context, downloadJson, setStatus } from '../toolkit.js';

const app = context('statescope');
if (app) initialize(app);

const COST_GROUPS = [
  ['Compute', /(?:instance|virtual_machine|compute_instance|droplet|server|autoscaling|launch_template)/i],
  ['Database', /(?:db_instance|sql_database|database_instance|rds|redis|elasticache|cosmosdb)/i],
  ['Storage', /(?:bucket|storage_account|disk|volume|filesystem|file_system)/i],
  ['Network', /(?:nat_gateway|load_balancer|lb|cdn|cloudfront|ip_address|vpn)/i],
  ['Kubernetes', /(?:kubernetes|eks|gke|aks|container_cluster|node_group)/i],
  ['Serverless', /(?:lambda|cloud_function|function_app|cloud_run)/i]
];

function initialize({ root, t }) {
  root.innerHTML = `<div class="workbench-layout">
    <form class="workbench-controls" data-form>
      <div class="workbench-section-heading"><h2>${t('Open a state snapshot', 'Abrir um snapshot de state')}</h2><span>${t('Inventory only', 'Somente inventário')}</span></div>
      <label class="field-label" for="state-file">${t('Terraform JSON file', 'Arquivo JSON do Terraform')}</label>
      <input class="file-input" id="state-file" type="file" accept=".tfstate,.json,application/json" required data-file>
      <label class="check-row"><input type="checkbox" checked data-anonymize> ${t('Pseudonymize identifiers in the exported report', 'Usar pseudônimos para identificadores no relatório exportado')}</label>
      <button class="button button-primary" type="submit">${t('Build local inventory', 'Criar inventário local')}</button>
      <p class="workbench-status" role="status" aria-live="polite" data-status></p>
    </form>
    <section class="workbench-results" aria-labelledby="state-results-title">
      <div class="workbench-section-heading"><h2 id="state-results-title" tabindex="-1">${t('Infrastructure inventory', 'Inventário de infraestrutura')}</h2><button class="text-button" type="button" disabled data-export>${t('Export normalized report', 'Exportar relatório normalizado')}</button></div>
      <div class="metric-grid" data-metrics></div>
      <div hidden data-output>
        <div class="notice-card"><strong>${t('Cost signals, not a price estimate.', 'Sinais de custo, não uma estimativa de preço.')}</strong><p>${t('Region, usage, discounts, and pricing are not available from resource types alone.', 'Região, uso, descontos e preços não podem ser determinados apenas pelos tipos de recurso.')}</p></div>
        <h3>${t('Cost-relevant groups', 'Grupos relevantes a custo')}</h3><div class="chip-list" data-costs></div>
        <h3>${t('Resources and dependencies', 'Recursos e dependências')}</h3>
        <div class="table-scroll" role="region" tabindex="0" aria-label="${t('Terraform resource inventory table', 'Tabela do inventário de recursos Terraform')}"><table class="data-table"><caption>${t('Normalized Terraform resource inventory', 'Inventário normalizado de recursos Terraform')}</caption><thead><tr><th>${t('Address', 'Endereço')}</th><th>${t('Type', 'Tipo')}</th><th>${t('Provider', 'Provider')}</th><th>${t('Module', 'Módulo')}</th><th>${t('Dependencies', 'Dependências')}</th></tr></thead><tbody data-resources></tbody></table></div>
        <h3>${t('Warnings', 'Avisos')}</h3><ul class="finding-list" data-warnings></ul>
      </div>
      <div class="empty-result" data-empty><p>${t('Supports raw state snapshot v4 and stable terraform show -json values. The export is a normalized report—not a replacement .tfstate.', 'Suporta snapshot bruto v4 e valores estáveis de terraform show -json. A exportação é um relatório normalizado — não um .tfstate substituto.')}</p></div>
    </section>
  </div>`;

  const form = root.querySelector('[data-form]');
  const status = root.querySelector('[data-status]');
  const exportButton = root.querySelector('[data-export]');
  let inventory = null;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = root.querySelector('[data-file]').files[0];
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) { setStatus(status, t('State files are limited to 200 MiB in this browser tool.', 'Arquivos de state são limitados a 200 MiB nesta ferramenta.'), 'error'); return; }
    setStatus(status, t('Normalizing resources without displaying attribute values…', 'Normalizando recursos sem exibir valores de atributos…'));
    try {
      const source = JSON.parse(await file.text());
      inventory = normalize(source, t);
      render(root, inventory, t);
      exportButton.disabled = false;
      root.querySelector('[data-output]').hidden = false;
      root.querySelector('[data-empty]').hidden = true;
      setStatus(status, t(`Inventory ready: ${inventory.resources.length} resources. Attribute values remain hidden.`, `Inventário pronto: ${inventory.resources.length} recursos. Valores de atributos continuam ocultos.`), 'success');
      root.querySelector('#state-results-title').focus();
    } catch (error) {
      inventory = null;
      exportButton.disabled = true;
      root.querySelector('[data-output]').hidden = true;
      root.querySelector('[data-empty]').hidden = false;
      setStatus(status, error instanceof SyntaxError ? t('The Terraform file is not valid JSON.', 'O arquivo Terraform não contém JSON válido.') : error.message, 'error');
    }
  });

  exportButton.addEventListener('click', () => {
    if (!inventory) return;
    const anonymize = root.querySelector('[data-anonymize]').checked;
    downloadJson(safeReport(inventory, anonymize), 'statescope-inventory-report.json');
  });
  addEventListener('pagehide', () => { inventory = null; }, { once: true });
}

export function normalize(source, t) {
  if (!source || typeof source !== 'object') throw new Error(t('The file is not a JSON object.', 'O arquivo não é um objeto JSON.'));
  if ('planned_values' in source || 'resource_changes' in source) throw new Error(t('This appears to be plan JSON. StateScope currently accepts state snapshots or terraform show -json state output.', 'Este arquivo parece ser um plano JSON. O StateScope aceita snapshots de state ou saída de state de terraform show -json.'));
  let result;
  if (Number(source.version) === 4 && Array.isArray(source.resources)) result = normalizeRaw(source);
  else if (source.format_version && source.values?.root_module) {
    const major = Number(String(source.format_version).split('.')[0]);
    if (!Number.isFinite(major) || major > 1) throw new Error(t(`Unsupported Terraform JSON format major version: ${source.format_version}.`, `Versão principal não suportada do formato JSON Terraform: ${source.format_version}.`));
    result = normalizeShow(source, t);
  } else throw new Error(t('Unsupported JSON shape. Expected raw state version 4 or terraform show -json values.', 'Formato JSON não suportado. Era esperado state bruto versão 4 ou valores de terraform show -json.'));
  result.costSignals = costSignals(result.resources);
  result.providerCount = new Set(result.resources.map((resource) => resource.provider).filter(Boolean)).size;
  result.moduleCount = new Set(result.resources.map((resource) => resource.module).filter(Boolean)).size;
  const addresses = new Set(result.resources.map((resource) => resource.address));
  const unresolved = [];
  for (const resource of result.resources) for (const dependency of resource.dependencies) if (!addresses.has(dependency)) unresolved.push(`${resource.address} → ${dependency}`);
  if (unresolved.length) result.warnings.push(t(`${unresolved.length} dependencies point outside this snapshot.`, `${unresolved.length} dependências apontam para fora deste snapshot.`));
  if (detectCycle(result.resources)) result.warnings.push(t('An anomalous dependency cycle was detected.', 'Um ciclo de dependência anômalo foi detectado.'));
  return result;
}

function normalizeRaw(source) {
  const resources = [];
  for (const resource of source.resources) {
    for (const instance of resource.instances || []) {
      const prefix = resource.module ? `${resource.module}.` : '';
      const mode = resource.mode === 'data' ? 'data.' : '';
      const index = typeof instance.index_key === 'number' ? `[${instance.index_key}]` : typeof instance.index_key === 'string' ? `[${JSON.stringify(instance.index_key)}]` : '';
      resources.push({
        address: `${prefix}${mode}${resource.type}.${resource.name}${index}`,
        module: resource.module || 'root', mode: resource.mode || 'managed', type: resource.type || 'unknown', name: resource.name || '',
        provider: normalizeProvider(resource.provider), dependencies: [...new Set((instance.dependencies || []).filter((value) => typeof value === 'string'))],
        sensitive: Boolean(instance.sensitive_attributes?.length) || containsSensitiveKey(instance.attributes)
      });
    }
  }
  const outputs = Object.entries(source.outputs || {}).map(([name, output]) => ({ name, sensitive: Boolean(output?.sensitive), type: typeof output?.value }));
  return { sourceFormat: 'raw-state-v4', terraformVersion: source.terraform_version || null, resources, outputs, warnings: [] };
}

function normalizeShow(source, t) {
  const resources = [];
  function visit(module) {
    for (const resource of module.resources || []) resources.push({
      address: String(resource.address || `${resource.type}.${resource.name}`), module: module.address || 'root', mode: resource.mode || 'managed',
      type: resource.type || 'unknown', name: resource.name || '', provider: normalizeProvider(resource.provider_name), dependencies: [],
      sensitive: sensitiveMaskHasValue(resource.sensitive_values) || containsSensitiveKey(resource.values)
    });
    for (const child of module.child_modules || []) visit(child);
  }
  visit(source.values.root_module);
  const outputs = Object.entries(source.values.outputs || {}).map(([name, output]) => ({ name, sensitive: Boolean(output?.sensitive), type: output?.type ? JSON.stringify(output.type) : typeof output?.value }));
  return { sourceFormat: 'terraform-show-json', terraformVersion: source.terraform_version || null, resources, outputs, warnings: [t('Dependency data is unavailable in this representation; no edges were inferred from strings.', 'Os dados de dependências não estão disponíveis nesta representação; nenhuma ligação foi inferida a partir de texto.')] };
}

function normalizeProvider(value) {
  const text = String(value || 'unknown');
  const match = text.match(/registry\.terraform\.io\/([^/]+\/[^"/]+)/);
  return match ? match[1] : text.replace(/^provider\["|"\]$/g, '');
}

function containsSensitiveKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  return Object.entries(value).some(([key, item]) => /(?:secret|pass(?:word)?|token|private|credential|api[_-]?key|access[_-]?key)/i.test(key) || containsSensitiveKey(item, depth + 1));
}

function sensitiveMaskHasValue(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(sensitiveMaskHasValue);
}

function costSignals(resources) {
  return COST_GROUPS.map(([group, pattern]) => ({ group, count: resources.filter((resource) => pattern.test(resource.type)).length })).filter((item) => item.count);
}

function detectCycle(resources) {
  const graph = new Map(resources.map((resource) => [resource.address, resource.dependencies]));
  const visiting = new Set(); const visited = new Set();
  function walk(node) {
    if (visiting.has(node)) return true;
    if (visited.has(node) || !graph.has(node)) return false;
    visiting.add(node);
    for (const dependency of graph.get(node)) if (walk(dependency)) return true;
    visiting.delete(node); visited.add(node); return false;
  }
  return [...graph.keys()].some(walk);
}

export function safeReport(inventory, anonymize) {
  const aliases = new Map(inventory.resources.map((resource, index) => [resource.address, `resource-${String(index + 1).padStart(3, '0')}`]));
  let externalIndex = 0;
  for (const resource of inventory.resources) {
    for (const dependency of resource.dependencies) {
      if (!aliases.has(dependency)) aliases.set(dependency, `external-resource-${String(++externalIndex).padStart(3, '0')}`);
    }
  }
  const address = (value) => anonymize ? aliases.get(value) || 'external-resource' : value;
  const warning = (value) => {
    if (!anonymize) return value;
    let result = String(value);
    for (const [source, pseudonym] of [...aliases].filter(([source]) => source).sort((a, b) => b[0].length - a[0].length)) result = result.replaceAll(source, pseudonym);
    return result;
  };
  return {
    tool: 'StateScope', sourceFormat: inventory.sourceFormat, terraformVersion: inventory.terraformVersion, generatedAt: new Date().toISOString(),
    summary: { resources: inventory.resources.length, providers: inventory.providerCount, modules: inventory.moduleCount, costSignals: inventory.costSignals },
    resources: inventory.resources.map((resource) => ({ address: address(resource.address), module: anonymize ? (resource.module === 'root' ? 'root' : 'module-redacted') : resource.module, mode: resource.mode, type: resource.type, provider: resource.provider, dependencies: resource.dependencies.map(address), hasSensitiveSignals: resource.sensitive, costSignals: COST_GROUPS.filter(([, pattern]) => pattern.test(resource.type)).map(([name]) => name) })),
    outputs: inventory.outputs.map((output) => ({ name: anonymize ? 'output-redacted' : output.name, sensitive: output.sensitive, type: output.type })), warnings: inventory.warnings.map(warning)
  };
}

function render(root, inventory, t) {
  renderMetrics(root.querySelector('[data-metrics]'), [
    [t('Resources', 'Recursos'), inventory.resources.length.toLocaleString()],
    [t('Providers', 'Providers'), inventory.providerCount.toLocaleString()],
    [t('Modules', 'Módulos'), inventory.moduleCount.toLocaleString()],
    [t('Sensitive signals', 'Sinais sensíveis'), inventory.resources.filter((resource) => resource.sensitive).length.toLocaleString()]
  ]);
  const costs = root.querySelector('[data-costs]'); costs.replaceChildren();
  const groupLabels = { Compute: t('Compute', 'Computação'), Database: t('Database', 'Banco de dados'), Storage: t('Storage', 'Armazenamento'), Network: t('Network', 'Rede'), Kubernetes: 'Kubernetes', Serverless: 'Serverless' };
  for (const item of inventory.costSignals) { const chip = document.createElement('span'); chip.textContent = `${groupLabels[item.group] || item.group}: ${item.count}`; costs.append(chip); }
  if (!inventory.costSignals.length) { const chip = document.createElement('span'); chip.textContent = t('No configured cost signal matched', 'Nenhum sinal configurado correspondeu'); costs.append(chip); }
  const body = root.querySelector('[data-resources]'); body.replaceChildren();
  for (const resource of inventory.resources.slice(0, 5_000)) {
    const row = document.createElement('tr');
    for (const value of [resource.address, resource.type, resource.provider, resource.module, resource.dependencies.length ? resource.dependencies.join(', ') : t('None declared', 'Nenhuma declarada')]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    body.append(row);
  }
  const warnings = root.querySelector('[data-warnings]'); warnings.replaceChildren();
  const values = inventory.warnings.length ? inventory.warnings : [t('No structural warning detected.', 'Nenhum aviso estrutural detectado.')];
  for (const value of values) { const item = document.createElement('li'); item.dataset.state = inventory.warnings.length ? 'warning' : 'pass'; const strong = document.createElement('strong'); strong.textContent = inventory.warnings.length ? t('CHECK', 'REVISAR') : 'PASS'; const span = document.createElement('span'); span.textContent = value; item.append(strong, span); warnings.append(item); }
}

function renderMetrics(container, values) {
  container.replaceChildren(...values.map(([label, value]) => { const item = document.createElement('div'); const span = document.createElement('span'); span.textContent = label; const strong = document.createElement('strong'); strong.textContent = value; item.append(span, strong); return item; }));
}
