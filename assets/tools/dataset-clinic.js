import { context, downloadJson, sha256, setStatus } from '../toolkit.js';

const app = context('dataset-clinic');
if (app) initialize(app);

const IMAGE_EXTENSIONS = /\.(?:jpe?g|png|webp|bmp|gif|avif)$/i;
const MAX_IMAGE_FILE_BYTES = 64 * 1024 ** 2;
const MAX_IMAGE_PIXELS = 40_000_000;
const IMAGE_HEADER_BYTES = 512 * 1024;
const JPEG_DIMENSION_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function initialize({ root, t }) {
  root.innerHTML = `<div class="workbench-layout">
    <form class="workbench-controls" data-form>
      <div class="workbench-section-heading"><h2>${t('Select dataset files', 'Selecionar arquivos do dataset')}</h2><span>${t('Local audit', 'Auditoria local')}</span></div>
      <label class="field-label" for="dataset-directory">${t('Dataset folder (recommended)', 'Pasta do dataset (recomendado)')}</label><input class="file-input" id="dataset-directory" type="file" webkitdirectory multiple data-directory>
      <label class="field-label" for="dataset-files">${t('Or select files', 'Ou selecione arquivos')}</label><input class="file-input" id="dataset-files" type="file" multiple data-files>
      <fieldset class="segmented-fieldset"><legend>${t('Format', 'Formato')}</legend><label><input type="radio" name="dataset-format" value="auto" checked><span>Auto</span></label><label><input type="radio" name="dataset-format" value="yolo"><span>YOLO</span></label><label><input type="radio" name="dataset-format" value="coco"><span>COCO</span></label></fieldset>
      <fieldset class="option-fieldset"><legend>${t('Checks', 'Verificações')}</legend><label><input type="checkbox" checked data-decode> ${t('Decode images to find corrupt files and dimension mismatches', 'Decodificar imagens para encontrar corrupção e divergências de dimensão')}</label><label><input type="checkbox" checked data-hash> ${t('Hash images for exact duplicates and split leakage', 'Calcular hash para duplicatas exatas e vazamento entre splits')}</label><label><input type="checkbox" checked data-anonymize> ${t('Anonymize paths in exported report', 'Anonimizar caminhos no relatório exportado')}</label></fieldset>
      <button class="button button-primary" type="submit">${t('Run dataset clinic', 'Executar clínica do dataset')}</button><progress class="workbench-progress" max="1" value="0" hidden aria-label="${t('Audit progress', 'Progresso da auditoria')}" data-progress></progress><p class="workbench-status" role="status" aria-live="polite" data-status></p>
    </form>
    <section class="workbench-results" aria-labelledby="dataset-results-title"><div class="workbench-section-heading"><h2 id="dataset-results-title" tabindex="-1">${t('Dataset diagnosis', 'Diagnóstico do dataset')}</h2><button class="text-button" type="button" disabled data-export>${t('Export report', 'Exportar relatório')}</button></div><div class="metric-grid" data-metrics></div>
      <div hidden data-output><h3>${t('Class balance', 'Equilíbrio de classes')}</h3><div class="table-scroll" role="region" tabindex="0" aria-label="${t('Class distribution table', 'Tabela de distribuição de classes')}"><table class="data-table"><caption>${t('Annotations and distinct images by class', 'Anotações e imagens distintas por classe')}</caption><thead><tr><th>${t('Class', 'Classe')}</th><th>${t('Annotations', 'Anotações')}</th><th>${t('Images', 'Imagens')}</th><th>${t('Share', 'Participação')}</th></tr></thead><tbody data-classes></tbody></table></div><h3>${t('Issues and warnings', 'Problemas e avisos')}</h3><div class="table-scroll" role="region" tabindex="0" aria-label="${t('Dataset findings table', 'Tabela de achados do dataset')}"><table class="data-table"><caption>${t('Retained dataset findings', 'Achados retidos do dataset')}</caption><thead><tr><th>${t('Severity', 'Severidade')}</th><th>${t('File / item', 'Arquivo / item')}</th><th>${t('Rule', 'Regra')}</th><th>${t('Remedy', 'Correção')}</th></tr></thead><tbody data-issues></tbody></table></div></div>
      <div class="empty-result" data-empty><p>${t('Duplicate detection finds byte-identical files, not visual similarity. Structural checks cannot determine whether an annotation is semantically correct.', 'A detecção de duplicatas encontra arquivos idênticos em bytes, não similaridade visual. Verificações estruturais não determinam se uma anotação está semanticamente correta.')}</p></div>
    </section>
  </div>`;
  const form = root.querySelector('[data-form]'); const status = root.querySelector('[data-status]'); const progress = root.querySelector('[data-progress]'); const exportButton = root.querySelector('[data-export]'); let report = null;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const directory = [...root.querySelector('[data-directory]').files]; const loose = [...root.querySelector('[data-files]').files]; const files = directory.length ? directory : loose;
    if (!files.length) { setStatus(status, t('Select a folder or files first.', 'Selecione uma pasta ou arquivos primeiro.'), 'error'); return; }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length > 50_000 || totalBytes > 40 * 1024 ** 3) { setStatus(status, t('This browser audit is capped at 50,000 files or 40 GiB.', 'Esta auditoria é limitada a 50.000 arquivos ou 40 GiB.'), 'error'); return; }
    progress.hidden = false; progress.max = Math.max(1, files.length); progress.value = 0; exportButton.disabled = true;
    setStatus(status, t(`Indexing ${files.length.toLocaleString()} files…`, `Indexando ${files.length.toLocaleString()} arquivos…`));
    try {
      const requested = form.elements['dataset-format'].value;
      const cocoFile = files.find((file) => /\.json$/i.test(file.name));
      let format = requested;
      if (format === 'auto') format = cocoFile ? 'coco' : 'yolo';
      const options = { decode: root.querySelector('[data-decode]').checked, hash: root.querySelector('[data-hash]').checked, progress, t };
      report = format === 'coco' ? await analyzeCoco(files, cocoFile, options) : await analyzeYolo(files, options);
      render(root, report, t); exportButton.disabled = false; root.querySelector('[data-output]').hidden = false; root.querySelector('[data-empty]').hidden = true;
      setStatus(status, t(`Audit complete: ${report.summary.errors} errors and ${report.summary.warnings} warnings.`, `Auditoria concluída: ${report.summary.errors} erros e ${report.summary.warnings} avisos.`), report.summary.errors ? 'warning' : 'success');
      root.querySelector('#dataset-results-title').focus();
    } catch (error) { report = null; setStatus(status, error instanceof SyntaxError ? t('The dataset JSON is invalid.', 'O JSON do dataset é inválido.') : error.message, 'error'); root.querySelector('[data-output]').hidden = true; root.querySelector('[data-empty]').hidden = false; }
    finally { progress.hidden = true; }
  });
  exportButton.addEventListener('click', () => {
    if (!report) return;
    downloadJson(datasetExportReport(report, root.querySelector('[data-anonymize]').checked), 'dataset-clinic-report.json');
  });
  addEventListener('pagehide', () => { report = null; }, { once: true });
}

export function datasetExportReport(report, anonymize) {
  let sequence = 0; const aliases = new Map();
  const path = (value) => { if (!anonymize) return value; if (!aliases.has(value)) aliases.set(value, `item-${String(++sequence).padStart(5, '0')}`); return aliases.get(value); };
  return {
    ...report,
    generatedAt: new Date().toISOString(),
    issues: report.issues.map((finding) => ({
      ...finding,
      item: path(finding.item),
      ...(finding.relatedItem ? { relatedItem: path(finding.relatedItem) } : {})
    }))
  };
}

function filePath(file) { return (file.webkitRelativePath || file.name).replaceAll('\\', '/'); }
function splitOf(path) { return path.split('/').map((part) => part.toLowerCase()).find((part) => ['train', 'training', 'val', 'valid', 'validation', 'test'].includes(part)) || 'unspecified'; }
function issue(list, severity, item, rule, remedy, relatedItem = null) { if (list.length < 50_000) list.push({ severity, item, rule, remedy, ...(relatedItem ? { relatedItem } : {}) }); }
function uniqueFileIndex(items, keyOf) {
  const index = new Map();
  for (const item of items) {
    const key = keyOf(item);
    index.set(key, index.has(key) ? null : item);
  }
  return index;
}

function matchesBytes(bytes, offset, expected) { return expected.every((value, index) => bytes[offset + index] === value); }
function uint24LittleEndian(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }
function validDimensions(width, height) { return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0; }
function exceedsPixelLimit(dimensions) { return dimensions && validDimensions(dimensions.width, dimensions.height) && dimensions.width > MAX_IMAGE_PIXELS / dimensions.height; }

async function imageHeaderDimensions(file) {
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, IMAGE_HEADER_BYTES)).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && matchesBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && matchesBytes(bytes, 12, [0x49, 0x48, 0x44, 0x52])) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 10 && (matchesBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || matchesBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length >= 26 && matchesBytes(bytes, 0, [0x42, 0x4d])) {
    const dibSize = view.getUint32(14, true);
    if (dibSize === 12) return { width: view.getUint16(18, true), height: view.getUint16(20, true) };
    if (dibSize >= 40) return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  if (bytes.length >= 30 && matchesBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && matchesBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    if (matchesBytes(bytes, 12, [0x56, 0x50, 0x38, 0x58])) return { width: uint24LittleEndian(bytes, 24) + 1, height: uint24LittleEndian(bytes, 27) + 1 };
    if (matchesBytes(bytes, 12, [0x56, 0x50, 0x38, 0x4c]) && bytes[20] === 0x2f) return { width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8), height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10) };
    if (matchesBytes(bytes, 12, [0x56, 0x50, 0x38, 0x20]) && matchesBytes(bytes, 23, [0x9d, 0x01, 0x2a])) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 1 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = view.getUint16(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (JPEG_DIMENSION_MARKERS.has(marker) && segmentLength >= 7) return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      offset += segmentLength;
    }
  }
  if (bytes.length >= 20 && matchesBytes(bytes, 4, [0x66, 0x74, 0x79, 0x70])) {
    for (let offset = 4; offset + 16 <= bytes.length; offset += 1) {
      if (!matchesBytes(bytes, offset, [0x69, 0x73, 0x70, 0x65]) || offset < 4) continue;
      const boxSize = view.getUint32(offset - 4);
      if (boxSize >= 20) return { width: view.getUint32(offset + 8), height: view.getUint32(offset + 12) };
    }
  }
  return null;
}

async function imageCheckSafety(file, decode, hash, declaredDimensions = null) {
  if ((decode || hash) && file.size > MAX_IMAGE_FILE_BYTES) return { fileTooLarge: true, pixelsTooLarge: false, dimensionsUnknown: false };
  if (!decode) return { fileTooLarge: false, pixelsTooLarge: false, dimensionsUnknown: false };
  let headerDimensions = null;
  try { headerDimensions = await imageHeaderDimensions(file); } catch (_) { /* Treat unreadable headers as unsafe to decode. */ }
  const fallbackDimensions = declaredDimensions && validDimensions(declaredDimensions.width, declaredDimensions.height) ? declaredDimensions : null;
  return {
    fileTooLarge: false,
    pixelsTooLarge: exceedsPixelLimit(headerDimensions || fallbackDimensions),
    dimensionsUnknown: !validDimensions(headerDimensions?.width, headerDimensions?.height)
  };
}

function reportSafetySkip(issues, path, safety, t) {
  if (safety.fileTooLarge) issue(issues, 'warning', path, 'image-over-file-safety-limit', t('The selected image-content checks were skipped because this file exceeds the 64 MiB per-image safety cap. Resize it or inspect it separately.', 'As verificações de conteúdo selecionadas foram ignoradas porque este arquivo excede o limite de segurança de 64 MiB por imagem. Redimensione-o ou inspecione-o separadamente.'));
  else if (safety.pixelsTooLarge) issue(issues, 'warning', path, 'image-over-pixel-safety-limit', t('Image decoding was skipped because header or declared dimensions exceed the 40-megapixel safety cap. Resize it or inspect it separately.', 'A decodificação da imagem foi ignorada porque as dimensões do cabeçalho ou declaradas excedem o limite de segurança de 40 megapixels. Redimensione-a ou inspecione-a separadamente.'));
  else if (safety.dimensionsUnknown) issue(issues, 'warning', path, 'image-dimensions-unverified', t('Image decoding was skipped because safe dimensions could not be read from the file header. Re-encode it or inspect it separately.', 'A decodificação da imagem foi ignorada porque não foi possível ler dimensões seguras no cabeçalho do arquivo. Recodifique-a ou inspecione-a separadamente.'));
}

async function analyzeYolo(files, { decode, hash, progress, t }) {
  const issues = []; const images = files.filter((file) => IMAGE_EXTENSIONS.test(file.name)); const labels = files.filter((file) => /\.txt$/i.test(file.name));
  const imageMap = new Map(); const labelMap = new Map();
  for (const file of images) {
    const path = filePath(file); const key = path.replace(/\/images\//i, '/labels/').replace(IMAGE_EXTENSIONS, '.txt').toLowerCase();
    if (imageMap.has(key)) issue(issues, 'error', path, 'ambiguous-image-stem', t('Keep one image extension for each annotation stem.', 'Mantenha uma extensão de imagem para cada stem de anotação.'));
    imageMap.set(key, file);
  }
  for (const file of labels) labelMap.set(filePath(file).toLowerCase(), file);
  const labelsByStem = uniqueFileIndex(labels, (file) => file.name.replace(/\.txt$/i, '').toLowerCase());
  const imagePathsWithoutExtensions = new Set(images.map((image) => filePath(image).replace(IMAGE_EXTENSIONS, '').toLowerCase()));
  const classStats = new Map(); const hashes = new Map(); let decoded = 0; let annotations = 0;
  for (const image of images) {
    const path = filePath(image); const expected = path.replace(/\/images\//i, '/labels/').replace(IMAGE_EXTENSIONS, '.txt').toLowerCase(); const label = labelMap.get(expected) || labelsByStem.get(image.name.replace(IMAGE_EXTENSIONS, '').toLowerCase()) || null;
    if (!label) issue(issues, 'warning', path, 'missing-label', t('Add a label file, or document this image as a valid background sample.', 'Adicione um rótulo ou documente a imagem como amostra de fundo válida.'));
    const safety = await imageCheckSafety(image, decode, hash); reportSafetySkip(issues, path, safety, t);
    if (decode && !safety.fileTooLarge && !safety.pixelsTooLarge && !safety.dimensionsUnknown) {
      try { const bitmap = await createImageBitmap(image); decoded += 1; bitmap.close(); } catch (_) { issue(issues, 'error', path, 'corrupt-image', t('Replace or regenerate the image.', 'Substitua ou gere novamente a imagem.')); }
    }
    if (hash && !safety.fileTooLarge) {
      const digest = await sha256(image); const previous = hashes.get(digest);
      if (previous) issue(issues, splitOf(previous) !== splitOf(path) ? 'error' : 'warning', path, splitOf(previous) !== splitOf(path) ? 'split-leakage' : 'exact-duplicate', t('Byte-identical file detected.', 'Arquivo idêntico em bytes detectado.'), previous); else hashes.set(digest, path);
    }
    if (label) {
      if (label.size > 2 * 1024 * 1024) issue(issues, 'error', filePath(label), 'oversized-label', t('Split or repair the label file.', 'Divida ou corrija o arquivo de rótulo.'));
      else {
        const lines = (await label.text()).replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).filter((line) => line.trim()); const seen = new Set();
        for (let index = 0; index < lines.length; index += 1) {
          const tokens = lines[index].trim().split(/\s+/); const where = `${filePath(label)}:${index + 1}`;
          if (tokens.length !== 5) { issue(issues, 'error', where, tokens.length > 5 ? 'unsupported-shape' : 'invalid-column-count', t('Detection labels require class, center-x, center-y, width, height.', 'Rótulos de detecção exigem classe, centro-x, centro-y, largura e altura.')); continue; }
          const values = tokens.map(Number); const [classId, cx, cy, width, height] = values;
          if (!values.every(Number.isFinite) || !Number.isInteger(classId) || classId < 0) { issue(issues, 'error', where, 'invalid-number', t('Use finite numbers and a nonnegative integer class.', 'Use números finitos e uma classe inteira não negativa.')); continue; }
          if (cx < 0 || cx > 1 || cy < 0 || cy > 1 || width <= 0 || width > 1 || height <= 0 || height > 1 || cx - width / 2 < -1e-6 || cx + width / 2 > 1 + 1e-6 || cy - height / 2 < -1e-6 || cy + height / 2 > 1 + 1e-6) issue(issues, 'error', where, 'invalid-box', t('Keep normalized boxes finite, positive, and within image bounds.', 'Mantenha caixas normalizadas, positivas e dentro da imagem.'));
          const canonical = values.join(','); if (seen.has(canonical)) issue(issues, 'warning', where, 'duplicate-annotation', t('Remove the duplicate line.', 'Remova a linha duplicada.')); seen.add(canonical);
          annotations += 1; if (!classStats.has(classId)) classStats.set(classId, { annotations: 0, images: new Set() }); const stat = classStats.get(classId); stat.annotations += 1; stat.images.add(path);
        }
      }
    }
    progress.value += 1; if (progress.value % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (const label of labels) {
    const corresponding = filePath(label).replace(/\/labels\//i, '/images/').replace(/\.txt$/i, '');
    if (!imagePathsWithoutExtensions.has(corresponding.toLowerCase())) issue(issues, 'warning', filePath(label), 'label-without-image', t('Add the referenced image or remove the orphan label.', 'Adicione a imagem ou remova o rótulo órfão.'));
  }
  return finalize('YOLO detection', images.length, annotations, decoded, classStats, issues, t);
}

async function analyzeCoco(files, cocoFile, { decode, hash, progress, t }) {
  if (!cocoFile) throw new Error(t('Select a COCO JSON file.', 'Selecione um arquivo JSON COCO.'));
  if (cocoFile.size > 100 * 1024 * 1024) throw new Error(t('COCO JSON is limited to 100 MiB because it is parsed as one document.', 'JSON COCO é limitado a 100 MiB porque é interpretado como um documento único.'));
  const source = JSON.parse(await cocoFile.text()); if (!source || !Array.isArray(source.images) || !Array.isArray(source.annotations) || !Array.isArray(source.categories)) throw new Error(t('Expected COCO images, annotations, and categories arrays.', 'Eram esperados arrays images, annotations e categories do COCO.'));
  const issues = []; const unique = (items, name) => { const seen = new Set(); for (const item of items) { if (seen.has(item.id)) issue(issues, 'error', `${name}:${item.id}`, 'duplicate-id', t('Use unique IDs.', 'Use IDs únicos.')); seen.add(item.id); } return seen; };
  const imageIds = unique(source.images, 'image'); const categoryIds = unique(source.categories, 'category'); unique(source.annotations, 'annotation');
  const imagesById = new Map(); for (const image of source.images) if (!imagesById.has(image.id)) imagesById.set(image.id, image);
  const classStats = new Map(source.categories.map((category) => [category.id, { name: String(category.name ?? category.id), annotations: 0, images: new Set() }])); let annotations = 0;
  const seenAnnotations = new Set();
  for (const annotation of source.annotations) {
    const where = `annotation:${annotation.id}`;
    if (!imageIds.has(annotation.image_id)) issue(issues, 'error', where, 'missing-image-reference', t('Reference an existing image ID.', 'Referencie um ID de imagem existente.'));
    if (!categoryIds.has(annotation.category_id)) issue(issues, 'error', where, 'missing-category-reference', t('Reference an existing category ID.', 'Referencie um ID de categoria existente.'));
    const box = annotation.bbox; if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) issue(issues, 'error', where, 'invalid-bbox', t('Use [x,y,width,height] with positive finite dimensions.', 'Use [x,y,largura,altura] com dimensões positivas e finitas.'));
    else {
      const image = imagesById.get(annotation.image_id); const toleranceX = Math.max(1, Number(image?.width || 0) * 0.005); const toleranceY = Math.max(1, Number(image?.height || 0) * 0.005);
      if (image && (box[0] < -toleranceX || box[1] < -toleranceY || box[0] + box[2] > Number(image.width) + toleranceX || box[1] + box[3] > Number(image.height) + toleranceY)) issue(issues, 'error', where, 'out-of-bounds-bbox', t('Clamp or correct the box against declared image dimensions.', 'Corrija a caixa em relação às dimensões declaradas.'));
      const key = `${annotation.image_id}:${annotation.category_id}:${box.join(',')}`; if (seenAnnotations.has(key)) issue(issues, 'warning', where, 'duplicate-annotation', t('Remove the duplicate annotation.', 'Remova a anotação duplicada.')); seenAnnotations.add(key);
    }
    annotations += 1; const stat = classStats.get(annotation.category_id); if (stat) { stat.annotations += 1; stat.images.add(annotation.image_id); }
  }
  const localImages = files.filter((file) => IMAGE_EXTENSIONS.test(file.name)); const byPath = new Map(localImages.map((file) => [filePath(file).toLowerCase(), file])); const byBasename = uniqueFileIndex(localImages, (file) => file.name.toLowerCase()); const hashes = new Map(); let decoded = 0;
  for (const image of source.images) {
    if (!Number.isFinite(Number(image.width)) || Number(image.width) <= 0 || !Number.isFinite(Number(image.height)) || Number(image.height) <= 0) issue(issues, 'error', String(image.file_name), 'invalid-declared-dimensions', t('Declare positive finite dimensions.', 'Declare dimensões positivas e finitas.'));
    const file = byPath.get(String(image.file_name).toLowerCase()) || byBasename.get(String(image.file_name).split('/').at(-1).toLowerCase()) || null;
    if (!file && localImages.length) issue(issues, 'warning', String(image.file_name), 'image-file-missing', t('Include the referenced image file.', 'Inclua o arquivo de imagem referenciado.'));
    const safety = file ? await imageCheckSafety(file, decode, hash, { width: Number(image.width), height: Number(image.height) }) : { fileTooLarge: false, pixelsTooLarge: false, dimensionsUnknown: false };
    if (file) reportSafetySkip(issues, filePath(file), safety, t);
    if (file && decode && !safety.fileTooLarge && !safety.pixelsTooLarge && !safety.dimensionsUnknown) try { const bitmap = await createImageBitmap(file); decoded += 1; if (bitmap.width !== Number(image.width) || bitmap.height !== Number(image.height)) issue(issues, 'warning', filePath(file), 'dimension-mismatch', t('Update COCO dimensions or replace the image.', 'Atualize as dimensões COCO ou substitua a imagem.')); bitmap.close(); } catch (_) { issue(issues, 'error', filePath(file), 'corrupt-image', t('Replace or regenerate the image.', 'Substitua ou gere novamente a imagem.')); }
    if (file && hash && !safety.fileTooLarge) { const digest = await sha256(file); const previous = hashes.get(digest); const path = filePath(file); if (previous) issue(issues, splitOf(previous) !== splitOf(path) ? 'error' : 'warning', path, splitOf(previous) !== splitOf(path) ? 'split-leakage' : 'exact-duplicate', t('Byte-identical file detected.', 'Arquivo idêntico em bytes detectado.'), previous); else hashes.set(digest, path); }
    progress.value += 1; if (progress.value % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return finalize('COCO', source.images.length, annotations, decoded, classStats, issues, t);
}

function finalize(format, images, annotations, decoded, classStats, issues, t) {
  const classes = [...classStats].map(([id, stat]) => ({ id, name: stat.name || String(id), annotations: stat.annotations, images: stat.images.size })).sort((a, b) => b.annotations - a.annotations);
  const total = Math.max(1, annotations); for (const item of classes) if (item.annotations / total < 0.01 && annotations >= 100) issue(issues, 'warning', `class:${item.name}`, 'class-under-1-percent', t('Review this heuristic against the product objective.', 'Revise esta heurística de desequilíbrio conforme o objetivo do produto.'));
  return { tool: 'Dataset Clinic', format, summary: { images, annotations, classes: classes.length, decoded, errors: issues.filter((item) => item.severity === 'error').length, warnings: issues.filter((item) => item.severity === 'warning').length, retainedIssues: issues.length }, classes, issues };
}

function render(root, report, t) {
  const metrics = root.querySelector('[data-metrics]'); const values = [[t('Images', 'Imagens'), report.summary.images], [t('Annotations', 'Anotações'), report.summary.annotations], [t('Errors', 'Erros'), report.summary.errors], [t('Warnings', 'Avisos'), report.summary.warnings]];
  metrics.replaceChildren(...values.map(([label, value]) => { const item = document.createElement('div'); const span = document.createElement('span'); span.textContent = label; const strong = document.createElement('strong'); strong.textContent = Number(value).toLocaleString(); item.append(span, strong); return item; }));
  const classBody = root.querySelector('[data-classes]'); classBody.replaceChildren(); const total = Math.max(1, report.summary.annotations);
  for (const item of report.classes) { const row = document.createElement('tr'); for (const value of [item.name, item.annotations, item.images, `${(item.annotations / total * 100).toFixed(2)}%`]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } classBody.append(row); }
  const issueBody = root.querySelector('[data-issues]'); issueBody.replaceChildren();
  const shown = report.issues.length ? report.issues : [{ severity: 'pass', item: 'dataset', rule: t('No retained structural issue', 'Nenhum problema estrutural retido'), remedy: t('Continue with semantic and sampling review.', 'Continue com revisão semântica e amostral.') }];
  const severity = { error: t('ERROR', 'ERRO'), warning: t('WARNING', 'AVISO'), pass: t('PASS', 'OK') };
  for (const item of shown) { const row = document.createElement('tr'); const remedy = item.relatedItem ? `${item.remedy} ${t('Related:', 'Relacionado:')} ${item.relatedItem}` : item.remedy; for (const value of [severity[item.severity] || item.severity.toUpperCase(), item.item, item.rule, remedy]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } issueBody.append(row); }
}
