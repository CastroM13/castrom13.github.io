import { context, downloadBlob, formatBytes, sanitizeFilename, setStatus } from '../toolkit.js';

const app = context('media-cleaner');
if (app) initialize(app);

const MAX_BATCH_FILES = 100;
const MAX_TOTAL_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_DECODE_MEMORY_BYTES = 512 * 1024 * 1024;
const JPEG_SIZE_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function initialize({ root, t }) {
  root.innerHTML = `<div class="workbench-layout">
    <form class="workbench-controls" data-form>
      <div class="workbench-section-heading"><h2>${t('Prepare images', 'Preparar imagens')}</h2><span>${t('Sequential batch', 'Lote sequencial')}</span></div>
      <label class="field-label" for="media-files">${t('Image files', 'Arquivos de imagem')}</label>
      <input class="file-input" id="media-files" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple required data-files>
      <div class="field-grid">
        <label><span class="field-label">${t('Output format', 'Formato de saída')}</span><select data-format><option value="image/jpeg">JPEG</option><option value="image/png">PNG</option><option value="image/webp">WebP</option></select></label>
        <label><span class="field-label">${t('Maximum edge (px)', 'Maior lado (px)')}</span><input class="number-input" type="number" min="64" max="12000" value="2400" data-edge></label>
        <label><span class="field-label">${t('Quality (lossy formats)', 'Qualidade (formatos com perda)')}</span><input type="range" min="0.4" max="1" step="0.01" value="0.86" data-quality><output data-quality-output>86%</output></label>
        <label><span class="field-label">${t('JPEG background', 'Fundo do JPEG')}</span><input type="color" value="#ffffff" data-background></label>
      </div>
      <button class="button button-primary" type="submit">${t('Inspect and re-encode', 'Inspecionar e recodificar')}</button>
      <progress class="workbench-progress" max="1" value="0" hidden aria-label="${t('Processing progress', 'Progresso do processamento')}" data-progress></progress>
      <p class="workbench-status" role="status" aria-live="polite" data-status></p>
    </form>
    <section class="workbench-results" aria-labelledby="media-results-title">
      <div class="workbench-section-heading"><h2 id="media-results-title" tabindex="-1">${t('Re-encoded outputs', 'Saídas recodificadas')}</h2><button class="text-button" type="button" disabled data-release>${t('Release outputs', 'Liberar saídas')}</button></div>
      <div class="metric-grid" data-metrics></div>
      <div class="table-scroll" role="region" tabindex="0" aria-label="${t('Image processing results table', 'Tabela de resultados do processamento de imagens')}" hidden data-table-wrap><table class="data-table"><caption>${t('Before and after metadata and size', 'Metadados e tamanho antes e depois')}</caption><thead><tr><th>${t('File', 'Arquivo')}</th><th>${t('Recognized metadata: source → output', 'Metadados reconhecidos: origem → saída')}</th><th>${t('Dimensions', 'Dimensões')}</th><th>${t('Size', 'Tamanho')}</th><th>${t('Result', 'Resultado')}</th></tr></thead><tbody data-results></tbody></table></div>
      <div class="empty-result" data-empty><p>${t('The exported file is a new canvas encoding. This removes metadata types recognized here, but not identifying details visible in the pixels or hidden through steganography.', 'O arquivo exportado é uma nova codificação via canvas. Isso remove os metadados reconhecidos aqui, mas não detalhes identificáveis nos pixels ou por esteganografia.')}</p></div>
    </section>
  </div>`;

  const form = root.querySelector('[data-form]');
  const quality = root.querySelector('[data-quality]');
  const status = root.querySelector('[data-status]');
  const progress = root.querySelector('[data-progress]');
  const release = root.querySelector('[data-release]');
  let outputs = [];
  quality.addEventListener('input', () => { root.querySelector('[data-quality-output]').value = `${Math.round(Number(quality.value) * 100)}%`; });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearOutputs();
    const files = [...root.querySelector('[data-files]').files];
    if (!files.length) return;
    const totalInputBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length > MAX_BATCH_FILES || totalInputBytes > MAX_TOTAL_INPUT_BYTES) {
      setStatus(status, t(`Batches are limited to ${MAX_BATCH_FILES} images and ${formatBytes(MAX_TOTAL_INPUT_BYTES)} of input.`, `Lotes são limitados a ${MAX_BATCH_FILES} imagens e ${formatBytes(MAX_TOTAL_INPUT_BYTES)} de entrada.`), 'error');
      return;
    }
    const mime = root.querySelector('[data-format]').value;
    const maxEdge = Math.max(64, Math.min(12000, Number(root.querySelector('[data-edge]').value) || 2400));
    const qualityValue = Number(quality.value);
    const background = root.querySelector('[data-background]').value;
    progress.hidden = false; progress.max = files.length; progress.value = 0;
    setStatus(status, t('Inspecting and processing one file at a time…', 'Inspecionando e processando um arquivo por vez…'));
    const rows = [];
    let sourceBytes = totalInputBytes; let outputBytes = 0; let cleanCount = 0; let outputLimitReached = false;
    for (const file of files) {
      try {
        const sourceMeta = await inspectMetadata(file);
        assertSafeDimensions(sourceMeta.width, sourceMeta.height, t);
        const result = await reencode(file, { mime, maxEdge, quality: qualityValue, background, t });
        if (outputBytes + result.blob.size > MAX_TOTAL_OUTPUT_BYTES) {
          rows.push({ file, error: t(`Retaining this file would exceed the ${formatBytes(MAX_TOTAL_OUTPUT_BYTES)} output limit. Processing stopped.`, `Reter este arquivo excederia o limite de saída de ${formatBytes(MAX_TOTAL_OUTPUT_BYTES)}. O processamento foi interrompido.`) });
          outputLimitReached = true; progress.value += 1; break;
        }
        const outputMeta = await inspectMetadata(result.blob);
        const recognizedClean = outputMeta.labels.every((label) => ['ICC', 'Physical resolution'].includes(label));
        if (recognizedClean) cleanCount += 1;
        outputBytes += result.blob.size;
        const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' })[result.blob.type] || 'img';
        const filename = `${sanitizeFilename(file.name.replace(/\.[^.]+$/, ''), 'image')}.reencoded.${extension}`;
        const record = { file, filename, sourceMeta, outputMeta, ...result, recognizedClean };
        outputs.push(record); rows.push(record);
      } catch (error) {
        rows.push({ file, error: error instanceof DOMException ? t('The browser could not decode this image.', 'O navegador não conseguiu decodificar esta imagem.') : error.message });
      }
      progress.value += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    render(root, rows, { sourceBytes, outputBytes, cleanCount }, t);
    release.disabled = !outputs.length;
    progress.hidden = true;
    setStatus(status, outputLimitReached
      ? t(`Processing stopped at the ${formatBytes(MAX_TOTAL_OUTPUT_BYTES)} retained-output limit. Completed files remain available.`, `O processamento parou no limite de ${formatBytes(MAX_TOTAL_OUTPUT_BYTES)} de saídas retidas. Os arquivos concluídos continuam disponíveis.`)
      : t(`Finished ${files.length} file${files.length === 1 ? '' : 's'}. Download each re-encoded copy after reviewing its row.`, `${files.length} arquivo(s) concluído(s). Baixe cada cópia recodificada após revisar a linha.`), outputLimitReached ? 'warning' : outputs.length ? 'success' : 'error');
    root.querySelector('#media-results-title').focus();
  });

  function clearOutputs() {
    outputs = [];
    release.disabled = true;
  }
  release.addEventListener('click', () => {
    clearOutputs();
    root.querySelector('[data-results]').replaceChildren();
    root.querySelector('[data-table-wrap]').hidden = true;
    root.querySelector('[data-empty]').hidden = false;
    root.querySelector('[data-metrics]').replaceChildren();
    setStatus(status, t('Output blobs released from this tab.', 'Blobs de saída liberados desta aba.'), 'success');
    form.querySelector('button[type="submit"]').focus();
  });
  root.querySelector('[data-results]').addEventListener('click', (event) => {
    const button = event.target.closest('[data-download-index]');
    if (!button) return;
    const item = outputs[Number(button.dataset.downloadIndex)];
    if (item) downloadBlob(item.blob, item.filename);
  });
  addEventListener('pagehide', clearOutputs, { once: true });
}

async function inspectMetadata(blob) {
  const bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 2 * 1024 * 1024)).arrayBuffer());
  const labels = [];
  let detected = blob.type || 'unknown';
  let width = null; let height = null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    detected = 'image/jpeg';
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2 || offset + 2 + length > bytes.length) break;
      const segment = bytes.subarray(offset + 4, offset + 2 + length);
      const prefix = new TextDecoder('latin1').decode(segment.subarray(0, Math.min(segment.length, 64)));
      if (JPEG_SIZE_MARKERS.has(marker) && segment.length >= 5) { height = (segment[1] << 8) | segment[2]; width = (segment[3] << 8) | segment[4]; }
      if (marker === 0xe1 && prefix.startsWith('Exif\0\0')) { labels.push('EXIF'); if (new TextDecoder('latin1').decode(segment).includes('GPS')) labels.push('GPS'); }
      else if (marker === 0xe1 && prefix.includes('xap')) labels.push('XMP');
      else if (marker === 0xe2 && prefix.startsWith('ICC_PROFILE')) labels.push('ICC');
      else if (marker === 0xfe) labels.push('Comment');
      offset += 2 + length;
    }
  } else if (new TextDecoder('latin1').decode(bytes.subarray(1, 4)) === 'PNG') {
    detected = 'image/png';
    if (bytes.length >= 24) { const view = new DataView(bytes.buffer, bytes.byteOffset + 16, 8); width = view.getUint32(0); height = view.getUint32(4); }
    const chunks = new Set();
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      const type = new TextDecoder('latin1').decode(bytes.subarray(offset + 4, offset + 8));
      if (!/^[A-Za-z]{4}$/.test(type) || offset + 12 + length > bytes.length) break;
      chunks.add(type); offset += 12 + length;
      if (type === 'IEND') break;
    }
    for (const [chunk, label] of [['eXIf', 'EXIF'], ['tEXt', 'Text'], ['zTXt', 'Compressed text'], ['iTXt', 'International text'], ['iCCP', 'ICC'], ['pHYs', 'Physical resolution'], ['acTL', 'Animation']]) if (chunks.has(chunk)) labels.push(label);
  } else if (new TextDecoder('latin1').decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder('latin1').decode(bytes.subarray(8, 12)) === 'WEBP') {
    detected = 'image/webp';
    const chunks = new Set();
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = new TextDecoder('latin1').decode(bytes.subarray(offset, offset + 4));
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
      if (!/^[A-Z0-9 ]{4}$/.test(type)) break;
      const dataOffset = offset + 8;
      if (type === 'VP8X' && length >= 10 && dataOffset + 10 <= bytes.length) { width = readUint24LE(bytes, dataOffset + 4) + 1; height = readUint24LE(bytes, dataOffset + 7) + 1; }
      else if (type === 'VP8 ' && length >= 10 && dataOffset + 10 <= bytes.length && bytes[dataOffset + 3] === 0x9d && bytes[dataOffset + 4] === 0x01 && bytes[dataOffset + 5] === 0x2a) { width = ((bytes[dataOffset + 7] << 8) | bytes[dataOffset + 6]) & 0x3fff; height = ((bytes[dataOffset + 9] << 8) | bytes[dataOffset + 8]) & 0x3fff; }
      else if (type === 'VP8L' && length >= 5 && dataOffset + 5 <= bytes.length && bytes[dataOffset] === 0x2f) { const bits = (bytes[dataOffset + 1] | (bytes[dataOffset + 2] << 8) | (bytes[dataOffset + 3] << 16) | (bytes[dataOffset + 4] << 24)) >>> 0; width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
      if (offset + 8 + length > bytes.length) break;
      chunks.add(type); offset += 8 + length + (length % 2);
    }
    for (const [chunk, label] of [['EXIF', 'EXIF'], ['XMP ', 'XMP'], ['ICCP', 'ICC'], ['ANIM', 'Animation']]) if (chunks.has(chunk)) labels.push(label);
  } else if (new TextDecoder('latin1').decode(bytes.subarray(4, 12)).includes('ftyp')) {
    detected = 'image/avif'; labels.push('Limited AVIF inspection');
  }
  return { detected, labels: [...new Set(labels)], width, height };
}

function readUint24LE(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }
function assertSafeDimensions(width, height, t) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  if (width <= 0 || height <= 0 || width > MAX_IMAGE_PIXELS / height) throw new Error(t('Image dimensions are empty or exceed the 100-megapixel safety limit.', 'As dimensões estão vazias ou excedem o limite de 100 megapixels.'));
}

async function reencode(file, { mime, maxEdge, quality, background, t }) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const pixels = bitmap.width * bitmap.height;
    if (!bitmap.width || !bitmap.height) throw new Error(t('Image dimensions are empty or exceed the 100-megapixel safety limit.', 'As dimensões estão vazias ou excedem o limite de 100 megapixels.'));
    assertSafeDimensions(bitmap.width, bitmap.height, t);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    if ((pixels + width * height) * 4 > MAX_DECODE_MEMORY_BYTES) throw new Error(t('Estimated decode memory exceeds 512 MiB.', 'A memória estimada de decodificação excede 512 MiB.'));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context2d = canvas.getContext('2d', { alpha: mime !== 'image/jpeg' });
    if (!context2d) throw new Error(t('Canvas is unavailable.', 'Canvas não está disponível.'));
    if (mime === 'image/jpeg') { context2d.fillStyle = background; context2d.fillRect(0, 0, width, height); }
    context2d.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
    if (!blob) throw new Error(t('The browser could not encode the selected output format.', 'O navegador não conseguiu codificar o formato selecionado.'));
    if (blob.type !== mime) throw new Error(t(`This browser returned ${blob.type || 'an unknown type'} instead of ${mime}. Choose another format.`, `O navegador retornou ${blob.type || 'um tipo desconhecido'} em vez de ${mime}. Escolha outro formato.`));
    return { blob, width, height, originalWidth: bitmap.width, originalHeight: bitmap.height };
  } finally { bitmap.close(); }
}

function render(root, rows, summary, t) {
  const metrics = root.querySelector('[data-metrics]');
  const values = [[t('Input size', 'Tamanho de entrada'), formatBytes(summary.sourceBytes)], [t('Output size', 'Tamanho de saída'), formatBytes(summary.outputBytes)], [t('No recognized privacy metadata', 'Sem metadados de privacidade reconhecidos'), summary.cleanCount], [t('Uploads', 'Uploads'), '0']];
  metrics.replaceChildren(...values.map(([label, value]) => { const item = document.createElement('div'); const span = document.createElement('span'); span.textContent = label; const strong = document.createElement('strong'); strong.textContent = value; item.append(span, strong); return item; }));
  const body = root.querySelector('[data-results]'); body.replaceChildren();
  rows.forEach((record) => {
    const row = document.createElement('tr');
    const cells = record.error
      ? [record.file.name, '—', '—', formatBytes(record.file.size)]
      : [record.file.name, `${record.sourceMeta.labels.length ? localizeMetadata(record.sourceMeta.labels, t) : t('None recognized', 'Nenhum reconhecido')} → ${record.outputMeta.labels.length ? localizeMetadata(record.outputMeta.labels, t) : t('none recognized', 'nenhum reconhecido')}`, `${record.originalWidth}×${record.originalHeight} → ${record.width}×${record.height}`, `${formatBytes(record.file.size)} → ${formatBytes(record.blob.size)}`];
    for (const value of cells) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    const action = document.createElement('td');
    if (record.error) action.textContent = record.error;
    else { const button = document.createElement('button'); button.className = 'text-button'; button.type = 'button'; button.dataset.downloadIndex = String(outputsIndex(root, record)); button.textContent = record.recognizedClean ? t('Download re-encoded copy', 'Baixar cópia recodificada') : t('Download; inspect warning', 'Baixar; revisar aviso'); action.append(button); }
    row.append(action); body.append(row);
  });
  root.querySelector('[data-table-wrap]').hidden = false;
  root.querySelector('[data-empty]').hidden = true;
}

function localizeMetadata(labels, t) {
  const translated = {
    Text: t('Text', 'Texto'), 'Compressed text': t('Compressed text', 'Texto comprimido'),
    'International text': t('International text', 'Texto internacional'),
    'Physical resolution': t('Physical resolution', 'Resolução física'), Animation: t('Animation', 'Animação'),
    Comment: t('Comment', 'Comentário'), 'Limited AVIF inspection': t('Limited AVIF inspection', 'Inspeção AVIF limitada')
  };
  return labels.map((label) => translated[label] || label).join(', ');
}

function outputsIndex(root, record) {
  const buttons = root.querySelectorAll('[data-download-index]').length;
  return record.error ? -1 : buttons;
}
