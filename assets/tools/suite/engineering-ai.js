import { downloadBlob, downloadJson, formatBytes, sanitizeFilename, setStatus } from '../../toolkit.js';
import {
  applyTranscriptReview, buildSearchIndex, computeVertexNormals, createExtrusion, decodeSegmentationMask, estimateModelMemory, exportBinaryStl, exportGltf, exportObj, exportPly,
  exportSearchIndex, generateGcode, generatePlanarUvs, hashEmbedding, meshBounds, meshSurfaceArea, normalizeTranscript,
  parseGerber, parseGgufMetadata, parseIndexList, parseMesh, rankEmbeddingRecords, sculptMesh, searchEmbeddings, searchIndex, sliceMesh,
  smoothMesh, subdivideMesh, topK, transcriptToSrt, transcriptToVtt, transformMesh, transformMeshSelection,
  voxelBooleanExtrusions, weldMesh
} from './engineering-ai-core.js';

export const toolKeys = Object.freeze([
  'local-search', 'model-viewer', 'model-converter', 'cad-lite', 'mesh-editor', 'slicer',
  'gerber-viewer', 'llm-playground', 'speech-to-text', 'vision-lab', 'ai-media-studio'
]);

const MiB = 1024 * 1024;
const MAX_TEXT_FILES = 500;
const MAX_TEXT_BYTES = 128 * MiB;
const MAX_MESH_BYTES = 128 * MiB;
const MAX_MESH_VERTICES = 1_000_000;
const MAX_MESH_FACES = 2_000_000;
const MAX_MESH_SELECTION_EDGES = 1_000_000;
const MAX_MESH_HISTORY_STEPS = 12;
const MAX_MESH_HISTORY_BYTES = 64 * MiB;
const MAX_GERBER_BYTES = 64 * MiB;
const MAX_GERBER_COMMANDS = 500_000;
const MAX_MODEL_BYTES = 4 * 1024 * MiB;
const MAX_MEDIA_BYTES = 96 * MiB;
const MAX_VISION_OUTPUT_VALUES = 16_777_216;
const MAX_CLASSIFICATION_VALUES = 250_000;
const MAX_DETECTION_ROWS = 20_000;
const cleanups = new WeakMap();

export function mountTool(key, app) {
  if (!toolKeys.includes(key)) throw new Error(`Unknown engineering/AI tool: ${key}`);
  if (!app?.root || typeof app.t !== 'function') throw new TypeError('mountTool needs { root, t, pt }.');
  dispose(app.root);
  const mounts = {
    'local-search': mountLocalSearch,
    'model-viewer': mountModelViewer,
    'model-converter': mountModelConverter,
    'cad-lite': mountCad,
    'mesh-editor': mountMeshEditor,
    slicer: mountSlicer,
    'gerber-viewer': mountGerber,
    'llm-playground': mountLlm,
    'speech-to-text': mountSpeech,
    'vision-lab': mountVision,
    'ai-media-studio': mountAiStudio
  };
  mounts[key](app);
  return true;
}

function registerCleanup(root, callback) {
  const list = cleanups.get(root) || [];
  list.push(callback);
  cleanups.set(root, list);
}

function dispose(root) {
  for (const callback of cleanups.get(root) || []) try { callback(); } catch (_) { /* best effort */ }
  cleanups.delete(root);
}

function commonLayout(root, t, { title, titlePt, badge, badgePt, controls, resultTitle, resultTitlePt, empty, emptyPt }) {
  root.innerHTML = `<div class="workbench-layout">
    <form class="workbench-controls" data-form>
      <div class="workbench-section-heading"><h2>${t(title, titlePt)}</h2><span>${t(badge, badgePt)}</span></div>
      ${controls}
      <progress class="workbench-progress" max="1" value="0" aria-label="${t('Task progress', 'Progresso da tarefa')}" hidden data-progress></progress>
      <p class="workbench-status" role="status" aria-live="polite" data-status></p>
    </form>
    <section class="workbench-results" aria-labelledby="suite-result-title">
      <div class="workbench-section-heading"><h2 id="suite-result-title" tabindex="-1">${t(resultTitle, resultTitlePt)}</h2><div data-result-actions></div></div>
      <div class="metric-grid" data-metrics></div>
      <div class="result-stack" hidden data-output></div>
      <div class="empty-result" data-empty><p>${t(empty, emptyPt)}</p></div>
    </section>
  </div>`;
  return {
    form: root.querySelector('[data-form]'), status: root.querySelector('[data-status]'),
    progress: root.querySelector('[data-progress]'), output: root.querySelector('[data-output]'),
    empty: root.querySelector('[data-empty]'), actions: root.querySelector('[data-result-actions]')
  };
}

function showResult(root) {
  root.querySelector('[data-output]').hidden = false;
  root.querySelector('[data-empty]').hidden = true;
  root.querySelector('#suite-result-title').focus();
}

function metrics(root, values) {
  const grid = root.querySelector('[data-metrics]');
  grid.replaceChildren(...values.map(([label, value]) => {
    const item = document.createElement('div');
    const span = document.createElement('span'); span.textContent = label;
    const strong = document.createElement('strong'); strong.textContent = String(value ?? '—');
    item.append(span, strong); return item;
  }));
}

function actionButton(label, callback) {
  const button = document.createElement('button');
  button.className = 'text-button'; button.type = 'button'; button.textContent = label;
  button.addEventListener('click', callback);
  return button;
}

function checkedFile(file, maximum, t, label = 'file') {
  if (!file) throw new Error(t(`Choose a ${label} first.`, `Escolha um ${label} primeiro.`));
  if (!file.size) throw new Error(t('Empty files are not supported.', 'Arquivos vazios não são compatíveis.'));
  if (file.size > maximum) throw new Error(t(`The ${label} exceeds the ${formatBytes(maximum)} limit.`, `O ${label} excede o limite de ${formatBytes(maximum)}.`));
  return file;
}

function textSection(title, value, className = 'code-output') {
  const section = document.createElement('section');
  const heading = document.createElement('h3'); heading.textContent = title;
  const pre = document.createElement('pre'); pre.className = className; pre.textContent = value;
  section.append(heading, pre); return section;
}

function meshReport(mesh, name) {
  const bounds = meshBounds(mesh);
  const surfaceSampleLimit = 200_000; const surfaceStride = Math.max(1, Math.ceil(mesh.faces.length / surfaceSampleLimit)); let sampledSurfaceArea = 0;
  for (let index = 0; index < mesh.faces.length; index += surfaceStride) {
    const face = mesh.faces[index]; const a = mesh.vertices[face[0]]; const b = mesh.vertices[face[1]]; const c = mesh.vertices[face[2]];
    const ab = b.map((value, axis) => value - a[axis]); const ac = c.map((value, axis) => value - a[axis]);
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    sampledSurfaceArea += Math.hypot(...cross) / 2;
  }
  return {
    name, format: mesh.format, vertices: mesh.vertices.length, triangles: mesh.faces.length,
    bounds, surfaceArea: sampledSurfaceArea * surfaceStride, surfaceAreaEstimated: surfaceStride > 1, surfaceSampleStride: surfaceStride
  };
}

function assertMeshBudget(mesh) {
  if (mesh.vertices.length > MAX_MESH_VERTICES) throw new RangeError(`Mesh exceeds ${MAX_MESH_VERTICES.toLocaleString()} vertices.`);
  if (mesh.faces.length > MAX_MESH_FACES) throw new RangeError(`Mesh exceeds ${MAX_MESH_FACES.toLocaleString()} triangles.`);
}

function estimateMeshSnapshotBytes(mesh) {
  const values = mesh.vertices.length * 3 + mesh.faces.length * 3
    + (mesh.vertexNormals?.length || 0) * 3 + (mesh.textureVertices?.length || 0) * 2
    + (mesh.faceUvs?.length || 0) * 3;
  const arrays = mesh.vertices.length + mesh.faces.length + (mesh.vertexNormals?.length || 0)
    + (mesh.textureVertices?.length || 0) + (mesh.faceUvs?.length || 0);
  return values * 8 + arrays * 24;
}

function meshEdges(mesh, t) {
  const edges = [];
  const seen = new Set();
  const base = Math.max(1, mesh.vertices.length);
  for (const face of mesh.faces) {
    for (const [left, right] of [[face[0], face[1]], [face[1], face[2]], [face[2], face[0]]]) {
      const a = Math.min(left, right); const b = Math.max(left, right); const key = a * base + b;
      if (seen.has(key)) continue;
      if (edges.length >= MAX_MESH_SELECTION_EDGES) throw new RangeError(t(`Edge selection exceeds the ${MAX_MESH_SELECTION_EDGES.toLocaleString()}-edge workspace cap.`, `A seleção de arestas excede o limite de ${MAX_MESH_SELECTION_EDGES.toLocaleString()} arestas.`));
      seen.add(key); edges.push([a, b]);
    }
  }
  return edges;
}

function drawMesh(canvas, mesh, { yaw = -30, pitch = 20, section = 100, wireframe = true } = {}) {
  const width = 900; const height = 560;
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  const style = getComputedStyle(canvas);
  context.fillStyle = style.getPropertyValue('--canvas').trim() || '#0a0b0d'; context.fillRect(0, 0, width, height);
  const bounds = meshBounds(mesh); const center = bounds.center; const radius = Math.max(...bounds.size, 1);
  const ry = yaw * Math.PI / 180; const rx = pitch * Math.PI / 180;
  const scale = Math.min(width, height) * 0.72 / radius; const projected = new Map();
  const project = (index) => {
    if (projected.has(index)) return projected.get(index);
    const vertex = mesh.vertices[index];
    let x = vertex[0] - center[0]; let y = vertex[1] - center[1]; let z = vertex[2] - center[2];
    const x1 = x * Math.cos(ry) + z * Math.sin(ry); const z1 = -x * Math.sin(ry) + z * Math.cos(ry);
    const y1 = y * Math.cos(rx) - z1 * Math.sin(rx); const z2 = y * Math.sin(rx) + z1 * Math.cos(rx);
    const point = [width / 2 + x1 * scale, height / 2 - y1 * scale, z2]; projected.set(index, point); return point;
  };
  const cutoff = bounds.min[2] + bounds.size[2] * Math.max(0, Math.min(100, section)) / 100;
  const faceStride = Math.max(1, Math.ceil(mesh.faces.length / 50_000)); const faces = [];
  for (let index = 0; index < mesh.faces.length; index += faceStride) {
    const face = mesh.faces[index]; if (face.reduce((sum, vertexIndex) => sum + mesh.vertices[vertexIndex][2], 0) / 3 > cutoff + 1e-9) continue;
    const polygon = face.map(project); faces.push({ polygon, depth: polygon.reduce((sum, point) => sum + point[2], 0) / 3 });
  }
  faces.sort((a, b) => a.depth - b.depth); canvas.dataset.previewStride = String(faceStride);
  const ink = style.getPropertyValue('--ink').trim() || '#f4f2ec';
  const acid = style.getPropertyValue('--acid').trim() || '#bbff52';
  for (const item of faces) {
    const polygon = item.polygon;
    context.beginPath(); context.moveTo(polygon[0][0], polygon[0][1]); context.lineTo(polygon[1][0], polygon[1][1]); context.lineTo(polygon[2][0], polygon[2][1]); context.closePath();
    context.fillStyle = `${acid}28`; context.fill();
    if (wireframe) { context.strokeStyle = `${ink}99`; context.lineWidth = 0.8; context.stroke(); }
  }
}

function meshCanvasSection(t) {
  const section = document.createElement('section');
  const heading = document.createElement('h3'); heading.textContent = t('Local preview', 'Prévia local');
  const canvas = document.createElement('canvas'); canvas.className = 'suite-canvas'; canvas.setAttribute('aria-label', t('Projected three-dimensional mesh preview', 'Prévia projetada da malha tridimensional'));
  section.append(heading, canvas); return { section, canvas };
}

function mountLocalSearch({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Build an index', titlePt: 'Criar um índice', badge: 'Text stays local', badgePt: 'Texto permanece local',
    controls: `<label class="field-label" for="search-files">${t('Text files', 'Arquivos de texto')}</label><input class="file-input" id="search-files" type="file" accept=".txt,.md,.csv,.json,.jsonl,.html,.htm,.srt,.vtt,text/*" multiple data-files><label class="field-label" for="search-folder">${t('Or a folder', 'Ou uma pasta')}</label><input class="file-input" id="search-folder" type="file" accept=".txt,.md,.csv,.json,.jsonl,.html,.htm,.srt,.vtt,text/*" multiple webkitdirectory data-folder><p class="field-help">${t('Up to 500 files and 128 MiB total across both selectors. Binary files are skipped.', 'Até 500 arquivos e 128 MiB no total entre os dois seletores. Binários são ignorados.')}</p><button class="button button-primary" type="submit">${t('Index selected files', 'Indexar arquivos')}</button><label class="field-label" for="search-query">${t('Search terms or phrase', 'Termos ou frase')}</label><input class="text-input" id="search-query" type="search" data-query><div class="button-row"><button class="button button-secondary" type="button" disabled data-search>${t('Search index', 'Pesquisar no índice')}</button><button class="button button-secondary" type="button" disabled data-clear>${t('Release index', 'Liberar índice')}</button></div>`,
    resultTitle: 'Ranked local results', resultTitlePt: 'Resultados locais ordenados',
    empty: 'Select readable local files to create an in-memory inverted index.', emptyPt: 'Selecione arquivos legíveis para criar um índice invertido em memória.'
  });
  let index = null;
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const candidates = [...root.querySelector('[data-files]').files, ...root.querySelector('[data-folder]').files];
      const files = [...new Map(candidates.map((file) => [`${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`, file])).values()];
      if (!files.length) throw new Error(t('Choose one or more text files.', 'Escolha um ou mais arquivos de texto.'));
      if (files.length > MAX_TEXT_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_TEXT_BYTES) throw new Error(t('The selection exceeds the documented index limits.', 'A seleção excede os limites documentados do índice.'));
      ui.progress.hidden = false; ui.progress.max = files.length; ui.progress.value = 0;
      const documents = [];
      for (const file of files) {
        const sample = new Uint8Array(await file.slice(0, Math.min(file.size, 4096)).arrayBuffer());
        if (!sample.includes(0)) documents.push({ name: file.webkitRelativePath || file.name, text: await file.text() });
        ui.progress.value += 1;
      }
      if (!documents.length) throw new Error(t('No readable text file remained after binary detection.', 'Nenhum arquivo de texto legível restou após detectar binários.'));
      index = buildSearchIndex(documents);
      root.querySelector('[data-search]').disabled = false; root.querySelector('[data-clear]').disabled = false;
      metrics(root, [[t('Documents', 'Documentos'), index.docs.length], [t('Unique terms', 'Termos únicos'), index.postings.size], [t('Indexed characters', 'Caracteres indexados'), documents.reduce((sum, item) => sum + item.text.length, 0).toLocaleString()], [t('Uploads', 'Uploads'), '0 B']]);
      ui.actions.replaceChildren(actionButton(t('Export index manifest', 'Exportar manifesto do índice'), () => downloadJson(exportSearchIndex(index), 'local-search-index.json')));
      setStatus(ui.status, t('Index ready. Enter terms or a phrase to search.', 'Índice pronto. Digite termos ou uma frase.'), 'success');
      ui.progress.hidden = true;
    } catch (error) { ui.progress.hidden = true; setStatus(ui.status, error.message, 'error'); }
  });
  root.querySelector('[data-search]').addEventListener('click', () => {
    if (!index) return;
    const results = searchIndex(index, root.querySelector('[data-query]').value);
    ui.output.replaceChildren();
    const list = document.createElement('ol'); list.className = 'finding-list';
    for (const result of results) {
      const item = document.createElement('li');
      const score = document.createElement('strong'); score.textContent = result.score.toFixed(3);
      const body = document.createElement('span');
      const name = document.createElement('b'); name.textContent = result.name;
      body.append(name, document.createElement('br'), document.createTextNode(result.excerpt)); item.append(score, body); list.append(item);
    }
    if (!results.length) { const message = document.createElement('p'); message.textContent = t('No indexed document matched every useful term.', 'Nenhum documento indexado correspondeu aos termos úteis.'); ui.output.append(message); }
    else ui.output.append(list);
    showResult(root); setStatus(ui.status, t(`${results.length} ranked result(s).`, `${results.length} resultado(s) ordenado(s).`), 'success');
  });
  root.querySelector('[data-query]').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); root.querySelector('[data-search]').click(); } });
  root.querySelector('[data-clear]').addEventListener('click', () => {
    index = null; ui.output.replaceChildren(); ui.output.hidden = true; ui.empty.hidden = false; root.querySelector('[data-search]').disabled = true; root.querySelector('[data-clear]').disabled = true; metrics(root, []); ui.actions.replaceChildren(); setStatus(ui.status, t('Index released.', 'Índice liberado.'), 'success');
  });
}

function mountModelViewer({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Inspect a model', titlePt: 'Inspecionar um modelo', badge: 'STL · OBJ · PLY · glTF', badgePt: 'STL · OBJ · PLY · glTF',
    controls: `<label class="field-label" for="viewer-file">${t('Mesh file', 'Arquivo de malha')}</label><input class="file-input" id="viewer-file" type="file" accept=".stl,.obj,.ply,.gltf" required data-file><div class="field-grid"><label><span class="field-label">${t('Yaw', 'Rotação horizontal')}</span><input type="range" min="-180" max="180" value="-30" data-yaw></label><label><span class="field-label">${t('Pitch', 'Inclinação')}</span><input type="range" min="-90" max="90" value="20" data-pitch></label><label><span class="field-label">${t('Section height', 'Altura da seção')}</span><input type="range" min="1" max="100" value="100" data-section></label><label><span class="field-label">${t('Measure vertex A / B', 'Medir vértices A / B')}</span><span class="suite-inline"><input class="number-input" type="number" min="0" value="0" aria-label="${t('Measurement vertex A', 'Vértice A da medição')}" data-a><input class="number-input" type="number" min="0" value="1" aria-label="${t('Measurement vertex B', 'Vértice B da medição')}" data-b></span></label></div><fieldset class="option-fieldset"><legend>${t('Preview style', 'Estilo da prévia')}</legend><label><input type="checkbox" checked data-wireframe> ${t('Draw triangle wireframe', 'Desenhar estrutura de triângulos')}</label></fieldset><button class="button button-primary" type="submit">${t('Load local preview', 'Carregar prévia local')}</button>`,
    resultTitle: 'Geometry inspection', resultTitlePt: 'Inspeção da geometria',
    empty: 'The preview renders normalized triangle geometry without uploading the model.', emptyPt: 'A prévia renderiza triângulos normalizados sem enviar o modelo.'
  });
  let mesh = null; let report = null; let preview = null;
  const redraw = () => { if (mesh && preview) drawMesh(preview.canvas, mesh, { yaw: Number(root.querySelector('[data-yaw]').value), pitch: Number(root.querySelector('[data-pitch]').value), section: Number(root.querySelector('[data-section]').value), wireframe: root.querySelector('[data-wireframe]').checked }); };
  root.querySelectorAll('[data-yaw],[data-pitch],[data-section],[data-wireframe]').forEach((input) => input.addEventListener('input', redraw));
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const file = checkedFile(root.querySelector('[data-file]').files[0], MAX_MESH_BYTES, t, t('mesh file', 'arquivo de malha'));
      mesh = parseMesh(await file.arrayBuffer(), file.name); assertMeshBudget(mesh); report = meshReport(mesh, file.name);
      const a = Math.max(0, Math.min(mesh.vertices.length - 1, Number(root.querySelector('[data-a]').value) || 0));
      const b = Math.max(0, Math.min(mesh.vertices.length - 1, Number(root.querySelector('[data-b]').value) || 1));
      report.measurement = { a, b, distance: Math.hypot(...mesh.vertices[a].map((value, axis) => value - mesh.vertices[b][axis])) };
      metrics(root, [[t('Vertices', 'Vértices'), report.vertices.toLocaleString()], [t('Triangles', 'Triângulos'), report.triangles.toLocaleString()], [t('Bounds', 'Limites'), report.bounds.size.map((value) => value.toFixed(2)).join(' × ')], [t('A–B distance', 'Distância A–B'), report.measurement.distance.toFixed(4)]]);
      ui.output.replaceChildren(); preview = meshCanvasSection(t); ui.output.append(preview.section, textSection(t('Inspection report', 'Relatório de inspeção'), JSON.stringify(report, null, 2))); redraw();
      ui.actions.replaceChildren(actionButton(t('Export report', 'Exportar relatório'), () => downloadJson(report, `${sanitizeFilename(file.name)}.mesh-report.json`)));
      showResult(root); setStatus(ui.status, t('Model parsed and rendered locally.', 'Modelo interpretado e renderizado localmente.'), 'success');
    } catch (error) { setStatus(ui.status, error.message, 'error'); }
  });
}

function mountModelConverter({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Convert a mesh', titlePt: 'Converter uma malha', badge: 'Explicit losses', badgePt: 'Perdas explícitas',
    controls: `<label class="field-label" for="converter-mesh">${t('Source mesh', 'Malha de origem')}</label><input class="file-input" id="converter-mesh" type="file" accept=".stl,.obj,.ply,.gltf" required data-file><div class="field-grid"><label><span class="field-label">${t('Target format', 'Formato de destino')}</span><select data-target><option value="stl">STL binary</option><option value="obj">OBJ + planar UV</option><option value="ply">PLY ASCII</option><option value="gltf">glTF 2.0 embedded</option></select></label><label><span class="field-label">${t('Scale multiplier', 'Multiplicador de escala')}</span><input class="number-input" type="number" min="0.000001" max="1000000" step="any" value="1" data-scale></label></div><fieldset class="option-fieldset"><legend>${t('Geometry cleanup', 'Limpeza da geometria')}</legend><label><input type="checkbox" checked data-center> ${t('Center at origin', 'Centralizar na origem')}</label><label><input type="checkbox" checked data-weld> ${t('Weld duplicate vertices', 'Unir vértices duplicados')}</label></fieldset><button class="button button-primary" type="submit">${t('Convert locally', 'Converter localmente')}</button>`,
    resultTitle: 'Converted geometry', resultTitlePt: 'Geometria convertida',
    empty: 'Conversion preserves triangle geometry and reports attributes the target cannot represent.', emptyPt: 'A conversão preserva triângulos e informa atributos incompatíveis com o destino.'
  });
  let output = null; let outputName = '';
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const file = checkedFile(root.querySelector('[data-file]').files[0], MAX_MESH_BYTES, t, t('mesh file', 'arquivo de malha'));
      const source = parseMesh(await file.arrayBuffer(), file.name); assertMeshBudget(source);
      let converted = transformMesh(source, { scale: Number(root.querySelector('[data-scale]').value), center: root.querySelector('[data-center]').checked });
      if (root.querySelector('[data-weld]').checked) converted = weldMesh(converted); assertMeshBudget(converted);
      const target = root.querySelector('[data-target]').value;
      output = target === 'stl' ? exportBinaryStl(converted) : target === 'obj' ? exportObj(converted) : target === 'ply' ? exportPly(converted) : exportGltf(converted);
      outputName = `${sanitizeFilename(file.name.replace(/\.[^.]+$/, ''), 'model')}.converted.${target}`;
      const report = { source: meshReport(source, file.name), output: meshReport(converted, outputName), target, losses: target === 'gltf' ? ['source materials', 'source textures', 'animation', 'hierarchy'] : target === 'obj' ? ['materials', 'animation', 'hierarchy'] : ['materials', 'textures', 'UVs', 'animation', 'hierarchy'] };
      metrics(root, [[t('Input vertices', 'Vértices de entrada'), source.vertices.length], [t('Output vertices', 'Vértices de saída'), converted.vertices.length], [t('Triangles', 'Triângulos'), converted.faces.length], [t('Output size', 'Tamanho da saída'), formatBytes(typeof output === 'string' ? new Blob([output]).size : output.byteLength)]]);
      ui.output.replaceChildren(); const preview = meshCanvasSection(t); ui.output.append(preview.section, textSection(t('Conversion report', 'Relatório da conversão'), JSON.stringify(report, null, 2))); drawMesh(preview.canvas, converted);
      ui.actions.replaceChildren(actionButton(t('Download converted mesh', 'Baixar malha convertida'), () => downloadBlob(new Blob([output], { type: target === 'gltf' ? 'model/gltf+json' : 'application/octet-stream' }), outputName)));
      showResult(root); setStatus(ui.status, t('Conversion complete. Review the reported attribute losses.', 'Conversão concluída. Revise as perdas de atributos informadas.'), 'success');
    } catch (error) { setStatus(ui.status, error.message, 'error'); }
  });
}

function mountCad({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Build a parametric solid', titlePt: 'Criar um sólido paramétrico', badge: 'Regenerable design', badgePt: 'Design regenerável',
    controls: `<fieldset class="option-fieldset"><legend>${t('Primary extrusion', 'Extrusão primária')}</legend><div class="field-grid"><label><span class="field-label">${t('Profile', 'Perfil')}</span><select data-shape><option value="rectangle">${t('Rectangle', 'Retângulo')}</option><option value="circle">${t('Circle / ellipse', 'Círculo / elipse')}</option><option value="polygon">${t('Regular polygon', 'Polígono regular')}</option></select></label><label><span class="field-label">${t('Sides', 'Lados')}</span><input class="number-input" type="number" min="3" max="256" value="32" data-sides></label><label><span class="field-label">${t('Width / diameter (mm)', 'Largura / diâmetro (mm)')}</span><input class="number-input" type="number" min="0.01" max="10000" step="0.1" value="40" data-width></label><label><span class="field-label">${t('Depth / diameter (mm)', 'Profundidade / diâmetro (mm)')}</span><input class="number-input" type="number" min="0.01" max="10000" step="0.1" value="30" data-depth></label><label><span class="field-label">${t('Extrusion height (mm)', 'Altura da extrusão (mm)')}</span><input class="number-input" type="number" min="0.01" max="10000" step="0.1" value="10" data-height></label><label><span class="field-label">${t('Constraint', 'Restrição')}</span><select data-constraint><option value="free">${t('Independent dimensions', 'Dimensões independentes')}</option><option value="square">${t('Equal width and depth', 'Largura igual à profundidade')}</option></select></label></div></fieldset><fieldset class="option-fieldset"><legend>${t('Optional voxel boolean', 'Booleana voxel opcional')}</legend><div class="field-grid"><label><span class="field-label">${t('Operation', 'Operação')}</span><select data-boolean><option value="single">${t('Primary only', 'Somente primária')}</option><option value="union">${t('Union', 'União')}</option><option value="difference">${t('Primary minus secondary', 'Primária menos secundária')}</option><option value="intersection">${t('Intersection', 'Interseção')}</option></select></label><label><span class="field-label">${t('Secondary profile', 'Perfil secundário')}</span><select data-second-shape><option value="circle">${t('Circle / ellipse', 'Círculo / elipse')}</option><option value="rectangle">${t('Rectangle', 'Retângulo')}</option><option value="polygon">${t('Regular polygon', 'Polígono regular')}</option></select></label><label><span class="field-label">${t('Secondary width (mm)', 'Largura secundária (mm)')}</span><input class="number-input" type="number" min="0.01" max="10000" step="0.1" value="18" data-second-width></label><label><span class="field-label">${t('Secondary depth (mm)', 'Profundidade secundária (mm)')}</span><input class="number-input" type="number" min="0.01" max="10000" step="0.1" value="18" data-second-depth></label><label><span class="field-label">${t('Secondary height (mm)', 'Altura secundária (mm)')}</span><input class="number-input" type="number" min="0.01" max="10000" step="0.1" value="10" data-second-height></label><label><span class="field-label">${t('Secondary X / Y offset (mm)', 'Deslocamento X / Y (mm)')}</span><span class="suite-inline"><input class="number-input" type="number" step="0.1" value="8" aria-label="X" data-second-x><input class="number-input" type="number" step="0.1" value="0" aria-label="Y" data-second-y></span></label><label><span class="field-label">${t('Boolean resolution', 'Resolução booleana')}</span><input class="number-input" type="number" min="12" max="96" value="40" data-resolution></label></div><p class="field-help">${t('Boolean output uses a bounded voxel surface: useful for prototypes, not a precision B-rep.', 'A saída booleana usa superfície voxel limitada: útil para protótipos, não é B-rep de precisão.')}</p></fieldset><button class="button button-primary" type="submit">${t('Regenerate solid', 'Regenerar sólido')}</button>`,
    resultTitle: 'Parametric model', resultTitlePt: 'Modelo paramétrico',
    empty: 'Dimensions regenerate a closed triangle mesh and an exportable JSON design.', emptyPt: 'As dimensões regeneram uma malha fechada e um design JSON exportável.'
  });
  // These controls intentionally accept arbitrary positive decimal dimensions.
  // A fractional min combined with step=.1 makes integer defaults fail native
  // constraint validation because the step base is the min value.
  root.querySelectorAll('[data-width],[data-depth],[data-height],[data-second-width],[data-second-depth],[data-second-height]').forEach((input) => { input.step = 'any'; });
  let mesh = null; let design = null;
  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const shape = root.querySelector('[data-shape]').value; let width = Number(root.querySelector('[data-width]').value); let depth = Number(root.querySelector('[data-depth]').value);
      if (root.querySelector('[data-constraint]').value === 'square') { depth = width; root.querySelector('[data-depth]').value = String(depth); }
      const primary = { shape, width, depth, height: Number(root.querySelector('[data-height]').value), sides: Number(root.querySelector('[data-sides]').value), offsetX: 0, offsetY: 0, offsetZ: 0 };
      const operation = root.querySelector('[data-boolean]').value;
      const secondary = { shape: root.querySelector('[data-second-shape]').value, width: Number(root.querySelector('[data-second-width]').value), depth: Number(root.querySelector('[data-second-depth]').value), height: Number(root.querySelector('[data-second-height]').value), sides: Number(root.querySelector('[data-sides]').value), offsetX: Number(root.querySelector('[data-second-x]').value), offsetY: Number(root.querySelector('[data-second-y]').value), offsetZ: 0 };
      design = { version: 2, operation, primary, ...(operation === 'single' ? {} : { secondary, voxelResolution: Number(root.querySelector('[data-resolution]').value) }), constraint: root.querySelector('[data-constraint]').value, units: 'mm' };
      mesh = operation === 'single' ? createExtrusion(primary) : voxelBooleanExtrusions(primary, secondary, operation, design.voxelResolution); const bounds = meshBounds(mesh);
      metrics(root, [[t('Vertices', 'Vértices'), mesh.vertices.length.toLocaleString()], [t('Triangles', 'Triângulos'), mesh.faces.length.toLocaleString()], [t('Size (mm)', 'Tamanho (mm)'), bounds.size.map((value) => value.toFixed(2)).join(' × ')], [t('Surface area', 'Área superficial'), `${meshSurfaceArea(mesh).toFixed(2)} mm²`]]);
      ui.output.replaceChildren(); const preview = meshCanvasSection(t); ui.output.append(preview.section, textSection(t('Exportable design tree', 'Árvore exportável do design'), JSON.stringify(design, null, 2))); drawMesh(preview.canvas, mesh);
      ui.actions.replaceChildren(actionButton('STL', () => downloadBlob(new Blob([exportBinaryStl(mesh)], { type: 'model/stl' }), 'cad-lite.stl')), actionButton('JSON', () => downloadJson(design, 'cad-lite.design.json')));
      showResult(root); setStatus(ui.status, operation === 'single' ? t('Solid regenerated from the current constraints.', 'Sólido regenerado a partir das restrições atuais.') : t('Approximate boolean regenerated. Verify voxel tolerance before fabrication.', 'Booleana aproximada regenerada. Verifique a tolerância voxel antes de fabricar.'), operation === 'single' ? 'success' : 'warning');
    } catch (error) { setStatus(ui.status, error.message, 'error'); }
  });
  queueMicrotask(() => ui.form.requestSubmit());
}

function mountMeshEditor({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Edit a triangle mesh', titlePt: 'Editar uma malha triangular', badge: 'Undoable session', badgePt: 'Sessão com desfazer',
    controls: `<label class="field-label" for="editor-mesh">${t('Mesh file', 'Arquivo de malha')}</label><input class="file-input" id="editor-mesh" type="file" accept=".stl,.obj,.ply,.gltf" required data-file><button class="button button-primary" type="submit">${t('Open mesh', 'Abrir malha')}</button><div class="field-grid"><label><span class="field-label">${t('Transform scale', 'Escala da transformação')}</span><input class="number-input" type="number" min="0.001" max="1000" step="0.05" value="1" data-scale></label><label><span class="field-label">${t('Sculpt strength', 'Força da escultura')}</span><input class="number-input" type="number" min="-100" max="100" step="0.1" value="1" data-sculpt></label><label><span class="field-label">${t('Selection kind', 'Tipo de seleção')}</span><select data-selection-kind><option value="vertices">${t('Vertex indices', 'Índices de vértices')}</option><option value="edges">${t('Edge indices', 'Índices de arestas')}</option><option value="faces">${t('Face indices', 'Índices de faces')}</option></select></label><label><span class="field-label">${t('Indices / ranges', 'Índices / intervalos')}</span><input class="text-input" type="text" value="0" placeholder="0, 2, 4-8" data-selection></label><label><span class="field-label">${t('Selection translation X / Y / Z', 'Translação X / Y / Z')}</span><span class="suite-inline"><input class="number-input" type="number" step="0.1" value="0" aria-label="X" data-move-x><input class="number-input" type="number" step="0.1" value="0" aria-label="Y" data-move-y><input class="number-input" type="number" step="0.1" value="0" aria-label="Z" data-move-z></span></label><label><span class="field-label">${t('UV projection', 'Projeção UV')}</span><select data-uv-projection><option value="xy">XY</option><option value="xz">XZ</option><option value="yz">YZ</option></select></label></div><p class="field-help">${t('Undo keeps at most 12 local snapshots within a 64 MiB memory budget.', 'O desfazer mantém no máximo 12 cópias locais dentro de 64 MiB de memória.')}</p><div class="button-row"><button class="button button-secondary" type="button" disabled data-operation="selection">${t('Transform selection', 'Transformar seleção')}</button><button class="button button-secondary" type="button" disabled data-operation="scale">${t('Apply whole-mesh scale', 'Escalar malha inteira')}</button><button class="button button-secondary" type="button" disabled data-operation="mirror">${t('Mirror X', 'Espelhar X')}</button><button class="button button-secondary" type="button" disabled data-operation="smooth">${t('Smooth', 'Suavizar')}</button><button class="button button-secondary" type="button" disabled data-operation="subdivide">${t('Subdivide', 'Subdividir')}</button><button class="button button-secondary" type="button" disabled data-operation="sculpt">${t('Sculpt center', 'Esculpir centro')}</button><button class="button button-secondary" type="button" disabled data-operation="normals">${t('Recalculate normals', 'Recalcular normais')}</button><button class="button button-secondary" type="button" disabled data-operation="uv">${t('Project UVs', 'Projetar UVs')}</button><button class="button button-secondary" type="button" disabled data-undo>${t('Undo', 'Desfazer')}</button></div>`,
    resultTitle: 'Editable mesh', resultTitlePt: 'Malha editável',
    empty: 'Open a mesh to apply bounded geometry commands and export a new file.', emptyPt: 'Abra uma malha para aplicar comandos limitados e exportar um novo arquivo.'
  });
  root.querySelector('[data-scale]').step = 'any';
  let mesh = null; let history = []; let historyBytes = 0; let preview = null; let sourceName = 'mesh';
  const popHistory = () => {
    const entry = history.pop();
    if (entry) historyBytes = Math.max(0, historyBytes - entry.bytes);
    return entry;
  };
  const pushHistory = (label) => {
    const bytes = estimateMeshSnapshotBytes(mesh);
    if (bytes > MAX_MESH_HISTORY_BYTES) { history = []; historyBytes = 0; return false; }
    while (history.length && (history.length >= MAX_MESH_HISTORY_STEPS || historyBytes + bytes > MAX_MESH_HISTORY_BYTES)) popHistoryFromStart();
    history.push({ mesh, label, bytes }); historyBytes += bytes; return true;
  };
  const popHistoryFromStart = () => {
    const entry = history.shift();
    if (entry) historyBytes = Math.max(0, historyBytes - entry.bytes);
    return entry;
  };
  const render = () => {
    const bounds = meshBounds(mesh); metrics(root, [[t('Vertices', 'Vértices'), mesh.vertices.length.toLocaleString()], [t('Triangles', 'Triângulos'), mesh.faces.length.toLocaleString()], [t('Bounds', 'Limites'), bounds.size.map((value) => value.toFixed(2)).join(' × ')], [t('Undo steps', 'Passos para desfazer'), history.length]]);
    ui.output.replaceChildren(); preview = meshCanvasSection(t); ui.output.append(preview.section, textSection(t('Session log', 'Log da sessão'), history.map((item, index) => `${index + 1}. ${item.label}`).join('\n') || t('Original mesh', 'Malha original'))); drawMesh(preview.canvas, mesh);
    ui.actions.replaceChildren(actionButton('OBJ', () => downloadBlob(new Blob([exportObj(mesh)], { type: 'text/plain' }), `${sanitizeFilename(sourceName)}.edited.obj`)), actionButton('STL', () => downloadBlob(new Blob([exportBinaryStl(mesh)], { type: 'model/stl' }), `${sanitizeFilename(sourceName)}.edited.stl`)));
    showResult(root);
  };
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { const file = checkedFile(root.querySelector('[data-file]').files[0], MAX_MESH_BYTES, t, t('mesh file', 'arquivo de malha')); mesh = parseMesh(await file.arrayBuffer(), file.name); assertMeshBudget(mesh); sourceName = file.name.replace(/\.[^.]+$/, ''); history = []; historyBytes = 0; root.querySelectorAll('[data-operation]').forEach((button) => { button.disabled = false; }); root.querySelector('[data-undo]').disabled = true; render(); setStatus(ui.status, t('Mesh ready for local edits.', 'Malha pronta para edições locais.'), 'success'); } catch (error) { setStatus(ui.status, error.message, 'error'); }
  });
  root.addEventListener('click', (event) => {
    const operation = event.target.closest('[data-operation]')?.dataset.operation;
    if (!operation || !mesh) return;
    const before = mesh; let historySaved = false;
    try {
      historySaved = pushHistory(operation);
      if (operation === 'selection') {
        const kind = root.querySelector('[data-selection-kind]').value; const edges = kind === 'edges' ? meshEdges(mesh, t) : null; const maximum = kind === 'faces' ? mesh.faces.length : kind === 'edges' ? edges.length : mesh.vertices.length; const indices = parseIndexList(root.querySelector('[data-selection]').value, maximum);
        const vertexIndices = kind === 'edges' ? [...new Set(indices.flatMap((index) => edges[index]))] : indices;
        mesh = transformMeshSelection(mesh, { [kind === 'faces' ? 'faceIndices' : 'vertexIndices']: vertexIndices, scale: Number(root.querySelector('[data-scale]').value), translate: [Number(root.querySelector('[data-move-x]').value), Number(root.querySelector('[data-move-y]').value), Number(root.querySelector('[data-move-z]').value)] });
      }
      if (operation === 'scale') mesh = transformMesh(mesh, { scale: Number(root.querySelector('[data-scale]').value) });
      if (operation === 'mirror') mesh = transformMesh(mesh, { mirrorX: true });
      if (operation === 'smooth') mesh = smoothMesh(mesh);
      if (operation === 'subdivide') { if (mesh.faces.length * 4 > MAX_MESH_FACES) throw new RangeError(t('Subdivision would exceed the triangle cap.', 'A subdivisão excederia o limite de triângulos.')); mesh = subdivideMesh(mesh); }
      if (operation === 'sculpt') { const bounds = meshBounds(mesh); mesh = sculptMesh(mesh, { radius: Math.max(bounds.size[0], bounds.size[1]) / 3, strength: Number(root.querySelector('[data-sculpt]').value), center: [bounds.center[0], bounds.center[1]] }); }
      if (operation === 'normals') mesh = { ...mesh, vertexNormals: computeVertexNormals(mesh) };
      if (operation === 'uv') { const textureVertices = generatePlanarUvs(mesh, root.querySelector('[data-uv-projection]').value); mesh = { ...mesh, textureVertices, faceUvs: mesh.faces.map((face) => [...face]) }; }
      assertMeshBudget(mesh); root.querySelector('[data-undo]').disabled = !history.length; render(); setStatus(ui.status, historySaved ? t(`Applied ${operation}.`, `Operação ${operation} aplicada.`) : t(`Applied ${operation}; this mesh is too large for the undo budget.`, `Operação ${operation} aplicada; esta malha é grande demais para o limite de desfazer.`), historySaved ? 'success' : 'warning');
    } catch (error) { if (historySaved) popHistory(); mesh = before; setStatus(ui.status, error.message, 'error'); }
  });
  root.querySelector('[data-undo]').addEventListener('click', () => { const previous = popHistory(); if (!previous) return; mesh = previous.mesh; root.querySelector('[data-undo]').disabled = !history.length; render(); setStatus(ui.status, t('Last command undone.', 'Último comando desfeito.'), 'success'); });
}

function drawLayer(canvas, layer, bounds) {
  canvas.width = 900; canvas.height = 560; const context = canvas.getContext('2d'); const style = getComputedStyle(canvas);
  context.fillStyle = style.getPropertyValue('--canvas').trim() || '#0a0b0d'; context.fillRect(0, 0, canvas.width, canvas.height);
  const width = Math.max(1e-6, bounds.size[0]); const height = Math.max(1e-6, bounds.size[1]); const scale = Math.min((canvas.width - 60) / width, (canvas.height - 60) / height);
  context.strokeStyle = style.getPropertyValue('--acid').trim() || '#bbff52'; context.lineWidth = 1.3;
  const stride = Math.max(1, Math.ceil(layer.segments.length / 100_000)); canvas.dataset.previewStride = String(stride);
  context.beginPath();
  for (let index = 0; index < layer.segments.length; index += stride) { const segment = layer.segments[index]; context.moveTo(30 + (segment[0][0] - bounds.min[0]) * scale, canvas.height - 30 - (segment[0][1] - bounds.min[1]) * scale); context.lineTo(30 + (segment[1][0] - bounds.min[0]) * scale, canvas.height - 30 - (segment[1][1] - bounds.min[1]) * scale); }
  context.stroke();
}

function mountSlicer({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Prepare a print', titlePt: 'Preparar uma impressão', badge: 'Review required', badgePt: 'Revisão obrigatória',
    controls: `<label class="field-label" for="slicer-file">STL</label><input class="file-input" id="slicer-file" type="file" accept=".stl" required data-file><div class="field-grid"><label><span class="field-label">${t('Layer height (mm)', 'Altura de camada (mm)')}</span><input class="number-input" type="number" min="0.05" max="1" step="0.01" value="0.2" data-layer-height></label><label><span class="field-label">${t('Nozzle (mm)', 'Bico (mm)')}</span><input class="number-input" type="number" min="0.1" max="2" step="0.05" value="0.4" data-nozzle></label><label><span class="field-label">${t('Wall count', 'Número de paredes')}</span><input class="number-input" type="number" min="1" max="8" value="2" data-walls></label><label><span class="field-label">${t('Bed width (mm)', 'Largura da mesa (mm)')}</span><input class="number-input" type="number" min="1" max="2000" value="220" data-bed-width></label><label><span class="field-label">${t('Bed depth (mm)', 'Profundidade da mesa (mm)')}</span><input class="number-input" type="number" min="1" max="2000" value="220" data-bed-depth></label><label><span class="field-label">${t('Build height (mm)', 'Altura de construção (mm)')}</span><input class="number-input" type="number" min="1" max="2000" value="250" data-build-height></label><label><span class="field-label">${t('Hotend °C', 'Hotend °C')}</span><input class="number-input" type="number" min="0" max="400" value="200" data-hotend></label><label><span class="field-label">${t('Bed °C', 'Mesa °C')}</span><input class="number-input" type="number" min="0" max="150" value="60" data-bed></label><label><span class="field-label">${t('Print speed (mm/s)', 'Velocidade (mm/s)')}</span><input class="number-input" type="number" min="1" max="500" value="40" data-speed></label><label><span class="field-label">${t('Grid infill (%)', 'Infill em grade (%)')}</span><input class="number-input" type="number" min="0" max="100" value="20" data-infill></label><label><span class="field-label">${t('Support density (%)', 'Densidade de suporte (%)')}</span><input class="number-input" type="number" min="1" max="100" value="12" data-support-density></label></div><fieldset class="option-fieldset"><legend>${t('Experimental supports', 'Suportes experimentais')}</legend><label><input type="checkbox" data-supports> ${t('Generate bounded grid supports below detected overhang samples', 'Gerar suportes em grade sob amostras de balanço detectadas')}</label></fieldset><label class="notice-card"><input type="checkbox" required data-confirm> <strong>${t('I will simulate and review the G-code for my exact printer before use.', 'Vou simular e revisar o G-code para minha impressora antes de usar.')}</strong></label><button class="button button-primary" type="submit">${t('Slice locally', 'Fatiar localmente')}</button>`,
    resultTitle: 'Layers and toolpath', resultTitlePt: 'Camadas e trajetórias',
    empty: 'Generated G-code is experimental and profile-generic; machine review is mandatory.', emptyPt: 'O G-code é experimental e genérico; a revisão para a máquina é obrigatória.'
  });
  let slicing = null; let gcode = null; let canvas = null; let slider = null;
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const file = checkedFile(root.querySelector('[data-file]').files[0], MAX_MESH_BYTES, t, 'STL'); const mesh = parseStlCompat(await file.arrayBuffer()); assertMeshBudget(mesh);
      slicing = sliceMesh(mesh, Number(root.querySelector('[data-layer-height]').value));
      gcode = generateGcode(slicing, { nozzle: Number(root.querySelector('[data-nozzle]').value), hotend: Number(root.querySelector('[data-hotend]').value), bed: Number(root.querySelector('[data-bed]').value), printSpeed: Number(root.querySelector('[data-speed]').value), infill: Number(root.querySelector('[data-infill]').value), walls: Number(root.querySelector('[data-walls]').value), supports: root.querySelector('[data-supports]').checked, supportDensity: Number(root.querySelector('[data-support-density]').value), bedWidth: Number(root.querySelector('[data-bed-width]').value), bedDepth: Number(root.querySelector('[data-bed-depth]').value), buildHeight: Number(root.querySelector('[data-build-height]').value) });
      metrics(root, [[t('Layers', 'Camadas'), slicing.layers.length], [t('Contour segments', 'Segmentos de contorno'), slicing.totalSegments.toLocaleString()], [t('G-code', 'G-code'), formatBytes(new Blob([gcode]).size)], [t('Model size', 'Tamanho do modelo'), slicing.bounds.size.map((value) => value.toFixed(2)).join(' × ')]]);
      ui.output.replaceChildren(); const section = document.createElement('section'); const heading = document.createElement('h3'); heading.textContent = t('Layer preview', 'Prévia da camada'); slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = String(Math.max(0, slicing.layers.length - 1)); slider.value = '0'; slider.setAttribute('aria-label', t('Preview layer', 'Camada da prévia')); canvas = document.createElement('canvas'); canvas.className = 'suite-canvas'; canvas.setAttribute('aria-label', t('Selected sliced layer toolpath preview', 'Prévia da trajetória da camada fatiada selecionada')); section.append(heading, slider, canvas); ui.output.append(section, textSection(t('First G-code commands', 'Primeiros comandos G-code'), gcode.split('\n').slice(0, 80).join('\n'))); const update = () => drawLayer(canvas, slicing.layers[Number(slider.value)], slicing.bounds); slider.addEventListener('input', update); update();
      ui.actions.replaceChildren(actionButton(t('Download reviewed G-code', 'Baixar G-code revisado'), () => downloadBlob(new Blob([gcode], { type: 'text/x.gcode' }), `${sanitizeFilename(file.name.replace(/\.stl$/i, ''), 'print')}.gcode`)));
      showResult(root); setStatus(ui.status, t('Slicing complete. Simulate the exported commands before machine use.', 'Fatiamento concluído. Simule os comandos antes de usar na máquina.'), 'warning');
    } catch (error) { setStatus(ui.status, error.message, 'error'); }
  });
}

function parseStlCompat(bytes) { return parseMesh(bytes, 'model.stl'); }

function inferGerberRole(name, data) {
  const lower = String(name).toLocaleLowerCase();
  if (data.format === 'Excellon' || /\.(?:drl|xln)$/.test(lower)) return 'drill';
  if (/\.gtl$/.test(lower)) return 'copper-top'; if (/\.gbl$/.test(lower)) return 'copper-bottom';
  if (/\.gts$/.test(lower)) return 'mask-top'; if (/\.gbs$/.test(lower)) return 'mask-bottom';
  if (/\.gto$/.test(lower)) return 'silk-top'; if (/\.gbo$/.test(lower)) return 'silk-bottom';
  if (/\.(?:gko|gm1|edge\.cuts)$/.test(lower)) return 'mechanical'; return 'other';
}

function drawGerber(canvas, layers) {
  canvas.width = 900; canvas.height = 600; const context = canvas.getContext('2d'); const style = getComputedStyle(canvas); context.fillStyle = style.getPropertyValue('--canvas').trim() || '#0a0b0d'; context.fillRect(0, 0, canvas.width, canvas.height);
  const populated = layers.filter((layer) => layer.data.commands.length); if (!populated.length) return;
  const normalizedBounds = populated.map((layer) => { const factor = layer.data.units === 'inch' ? 25.4 : 1; return { min: layer.data.bounds.min.map((value) => value * factor), max: layer.data.bounds.max.map((value) => value * factor) }; });
  const minX = normalizedBounds.reduce((value, bounds) => Math.min(value, bounds.min[0]), Infinity); const maxX = normalizedBounds.reduce((value, bounds) => Math.max(value, bounds.max[0]), -Infinity); const minY = normalizedBounds.reduce((value, bounds) => Math.min(value, bounds.min[1]), Infinity); const maxY = normalizedBounds.reduce((value, bounds) => Math.max(value, bounds.max[1]), -Infinity); const scale = Math.min((canvas.width - 60) / Math.max(1e-6, maxX - minX), (canvas.height - 60) / Math.max(1e-6, maxY - minY));
  const colors = { 'copper-top': '#bbff52', 'copper-bottom': '#9d7cff', 'mask-top': '#26c281', 'mask-bottom': '#147d64', 'silk-top': '#ffffff', 'silk-bottom': '#c8c8c8', drill: '#ff7ca8', mechanical: '#56d8ff', other: '#ffd166' };
  const totalCommands = layers.reduce((sum, layer) => sum + layer.data.commands.length, 0); const previewStride = Math.max(1, Math.ceil(totalCommands / 100_000)); canvas.dataset.previewStride = String(previewStride);
  layers.forEach((layer) => { const unitScale = layer.data.units === 'inch' ? 25.4 : 1; context.strokeStyle = colors[layer.role] || colors.other; context.fillStyle = colors[layer.role] || colors.other; for (let index = 0; index < layer.data.commands.length; index += previewStride) { const command = layer.data.commands[index]; const x1 = 30 + (command.x1 * unitScale - minX) * scale; const y1 = canvas.height - 30 - (command.y1 * unitScale - minY) * scale; const x2 = 30 + (command.x2 * unitScale - minX) * scale; const y2 = canvas.height - 30 - (command.y2 * unitScale - minY) * scale; const aperture = command.aperture; const width = Math.max(1, Number(aperture?.parameters?.[0] || 0) * unitScale * scale); if (command.operation === 'draw') { context.lineWidth = width; context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke(); } else if (command.operation === 'flash' || command.operation === 'drill') { if (aperture?.shape === 'R' && aperture.parameters.length > 1) { const height = Math.max(1, Number(aperture.parameters[1]) * unitScale * scale); context.fillRect(x2 - width / 2, y2 - height / 2, width, height); } else { context.beginPath(); context.arc(x2, y2, Math.max(1.5, width / 2), 0, Math.PI * 2); context.fill(); } } } });
}

function mountGerber({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Inspect fabrication layers', titlePt: 'Inspecionar camadas de fabricação', badge: 'RS-274X · Excellon', badgePt: 'RS-274X · Excellon',
    controls: `<label class="field-label" for="gerber-files">${t('Gerber and drill files', 'Arquivos Gerber e de furação')}</label><input class="file-input" id="gerber-files" type="file" accept=".gbr,.ger,.gtl,.gbl,.gts,.gbs,.gto,.gbo,.drl,.xln,text/plain" multiple required data-files><p class="field-help">${t('Load up to 24 layers, 64 MiB, and 500,000 parsed commands total. Inch layers are normalized to millimeters for overlay.', 'Carregue até 24 camadas, 64 MiB e 500.000 comandos interpretados no total. Camadas em polegadas são normalizadas para milímetros na sobreposição.')}</p><button class="button button-primary" type="submit">${t('Render layers locally', 'Renderizar camadas localmente')}</button>`,
    resultTitle: 'Board layer preview', resultTitlePt: 'Prévia das camadas da placa',
    empty: 'Coordinates, apertures, traces, flashes, and drill hits are parsed without upload.', emptyPt: 'Coordenadas, aberturas, trilhas, flashes e furos são interpretados sem upload.'
  });
  const measurementFields = document.createElement('fieldset'); measurementFields.className = 'option-fieldset';
  measurementFields.innerHTML = `<legend>${t('Point-to-point measurement', 'Medição ponto a ponto')}</legend><div class="field-grid"><label><span class="field-label">A · X / Y</span><span class="suite-inline"><input class="number-input" type="number" step="any" value="0" aria-label="A X" data-measure-ax><input class="number-input" type="number" step="any" value="0" aria-label="A Y" data-measure-ay></span></label><label><span class="field-label">B · X / Y</span><span class="suite-inline"><input class="number-input" type="number" step="any" value="10" aria-label="B X" data-measure-bx><input class="number-input" type="number" step="any" value="0" aria-label="B Y" data-measure-by></span></label></div>`;
  ui.form.querySelector('button[type="submit"]').before(measurementFields);
  let report = null;
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const files = [...root.querySelector('[data-files]').files]; if (!files.length || files.length > 24 || files.reduce((sum, file) => sum + file.size, 0) > MAX_GERBER_BYTES) throw new Error(t('Choose 1–24 files within the 64 MiB aggregate limit.', 'Escolha de 1 a 24 arquivos dentro do limite total de 64 MiB.'));
      const layers = []; let commandCount = 0; for (const file of files) { const data = parseGerber(await file.text(), file.name); commandCount += data.commands.length; if (commandCount > MAX_GERBER_COMMANDS) throw new RangeError(t('The selected layers exceed the 500,000-command aggregate safety cap.', 'As camadas selecionadas excedem o limite total de 500.000 comandos.')); layers.push({ name: file.name, data, role: inferGerberRole(file.name, data) }); }
      const assignmentSection = document.createElement('section'); const assignmentHeading = document.createElement('h3'); assignmentHeading.textContent = t('Layer assignments', 'Atribuições de camada'); const tableWrap = document.createElement('div'); tableWrap.className = 'result-table-wrap'; const table = document.createElement('table'); table.innerHTML = `<thead><tr><th>${t('File', 'Arquivo')}</th><th>${t('Assigned role', 'Função atribuída')}</th><th>${t('Format', 'Formato')}</th></tr></thead><tbody></tbody>`; tableWrap.append(table); assignmentSection.append(assignmentHeading, tableWrap);
      const roles = [['copper-top', t('Top copper', 'Cobre superior')], ['copper-bottom', t('Bottom copper', 'Cobre inferior')], ['mask-top', t('Top solder mask', 'Máscara superior')], ['mask-bottom', t('Bottom solder mask', 'Máscara inferior')], ['silk-top', t('Top silkscreen', 'Serigrafia superior')], ['silk-bottom', t('Bottom silkscreen', 'Serigrafia inferior')], ['drill', t('Drill', 'Furação')], ['mechanical', t('Mechanical / outline', 'Mecânica / contorno')], ['other', t('Other', 'Outra')]];
      for (const layer of layers) { const row = table.tBodies[0].insertRow(); row.insertCell().textContent = layer.name; const roleCell = row.insertCell(); const select = document.createElement('select'); select.setAttribute('aria-label', t(`Role for ${layer.name}`, `Função para ${layer.name}`)); roles.forEach(([value, label]) => select.add(new Option(label, value))); select.value = layer.role; select.addEventListener('change', () => { layer.role = select.value; updateReport(); }); roleCell.append(select); row.insertCell().textContent = layer.data.format; }
      const previewSection = document.createElement('section'); const heading = document.createElement('h3'); heading.textContent = t('Layer rendering', 'Renderização das camadas'); const canvas = document.createElement('canvas'); canvas.className = 'suite-canvas'; canvas.setAttribute('aria-label', t('Normalized fabrication layer preview in millimeters', 'Prévia normalizada das camadas de fabricação em milímetros')); previewSection.append(heading, canvas); const reportSection = textSection(t('Layer report', 'Relatório das camadas'), ''); const reportPre = reportSection.querySelector('pre'); ui.output.replaceChildren(assignmentSection, previewSection, reportSection);
      function updateReport() {
        const populated = layers.filter((layer) => layer.data.commands.length); const normalized = populated.map((layer) => { const factor = layer.data.units === 'inch' ? 25.4 : 1; return { min: layer.data.bounds.min.map((value) => value * factor), max: layer.data.bounds.max.map((value) => value * factor) }; }); const boardBounds = normalized.length ? { min: [normalized.reduce((value, bounds) => Math.min(value, bounds.min[0]), Infinity), normalized.reduce((value, bounds) => Math.min(value, bounds.min[1]), Infinity)], max: [normalized.reduce((value, bounds) => Math.max(value, bounds.max[0]), -Infinity), normalized.reduce((value, bounds) => Math.max(value, bounds.max[1]), -Infinity)] } : { min: [0, 0], max: [0, 0] }; const boardSize = boardBounds.min.map((value, axis) => boardBounds.max[axis] - value); const measurement = { a: [Number(root.querySelector('[data-measure-ax]').value), Number(root.querySelector('[data-measure-ay]').value)], b: [Number(root.querySelector('[data-measure-bx]').value), Number(root.querySelector('[data-measure-by]').value)] }; measurement.distance = Math.hypot(measurement.b[0] - measurement.a[0], measurement.b[1] - measurement.a[1]); measurement.units = 'mm';
        drawGerber(canvas, layers); report = { tool: 'PCB / Gerber Viewer', normalizedUnits: 'mm', boardBounds, boardSize, measurement, previewStride: Number(canvas.dataset.previewStride || 1), layers: layers.map((layer) => ({ name: layer.name, role: layer.role, format: layer.data.format, sourceUnits: layer.data.units, coordinateFormat: `${layer.data.zeroSuppression}${layer.data.notation} X${layer.data.xFormat.join('.')} Y${layer.data.yFormat.join('.')}`, commands: layer.data.commands.length, apertures: layer.data.apertures.size, bounds: layer.data.bounds, warnings: layer.data.warnings })) }; reportPre.textContent = JSON.stringify(report, null, 2); metrics(root, [[t('Layers', 'Camadas'), layers.length], [t('Board size', 'Tamanho da placa'), `${boardSize[0].toFixed(3)} × ${boardSize[1].toFixed(3)} mm`], [t('A–B distance', 'Distância A–B'), `${measurement.distance.toFixed(4)} mm`], [t('Warnings', 'Avisos'), report.layers.reduce((sum, layer) => sum + layer.warnings.length, 0)]]);
      }
      updateReport(); root.querySelectorAll('[data-measure-ax],[data-measure-ay],[data-measure-bx],[data-measure-by]').forEach((input) => input.addEventListener('input', updateReport));
      ui.actions.replaceChildren(actionButton(t('Export fabrication report', 'Exportar relatório de fabricação'), () => downloadJson(report, 'gerber-inspection.json')));
      showResult(root); setStatus(ui.status, t('Fabrication layers parsed. Review every warning against the source CAM export.', 'Camadas interpretadas. Revise cada aviso com a exportação CAM original.'), report.layers.some((layer) => layer.warnings.length) ? 'warning' : 'success');
    } catch (error) { setStatus(ui.status, error.message, 'error'); }
  });
}

// AI workbenches are implemented below so their optional runtimes remain lazy.

function mountLlm({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Inspect and load a GGUF model', titlePt: 'Inspecionar e carregar um modelo GGUF', badge: 'llama.cpp · Local', badgePt: 'llama.cpp · Local',
    controls: `<label class="field-label" for="gguf-file">GGUF</label><input class="file-input" id="gguf-file" type="file" accept=".gguf,application/octet-stream" required data-file><div class="field-grid"><label><span class="field-label">${t('Context tokens', 'Tokens de contexto')}</span><input class="number-input" type="number" min="128" max="32768" step="128" value="2048" data-context></label><label><span class="field-label">${t('CPU threads', 'Threads de CPU')}</span><input class="number-input" type="number" min="1" max="16" value="4" data-threads></label><label><span class="field-label">${t('Maximum new tokens', 'Máximo de novos tokens')}</span><input class="number-input" type="number" min="1" max="2048" value="128" data-max-tokens></label><label><span class="field-label">${t('Temperature', 'Temperatura')}</span><input class="number-input" type="number" min="0" max="2" step="0.05" value="0.7" data-temperature></label></div><button class="button button-primary" type="submit">${t('Inspect model metadata', 'Inspecionar metadados')}</button><button class="button button-secondary" type="button" disabled data-load>${t('Load model into local runtime', 'Carregar no runtime local')}</button><label class="field-label" for="llm-prompt">Prompt</label><textarea class="code-input" id="llm-prompt" rows="8" data-prompt>${t('Write a concise explanation of why local-first tools protect privacy.', 'Escreva uma explicação concisa sobre por que ferramentas local-first protegem a privacidade.')}</textarea><div class="button-row"><button class="button button-primary" type="button" disabled data-generate>${t('Generate locally', 'Gerar localmente')}</button><button class="button button-secondary" type="button" disabled data-release>${t('Stop and release model', 'Parar e liberar modelo')}</button></div>`,
    resultTitle: 'Model and generation', resultTitlePt: 'Modelo e geração',
    empty: 'Metadata inspection is immediate. Inference loads this site’s ~19 MiB llama.cpp WASM runtime only after you ask.', emptyPt: 'A inspeção é imediata. A inferência carrega o runtime llama.cpp WASM de ~19 MiB deste site somente após sua ação.'
  });
  let metadata = null; let runtime = null; let file = null; let generated = '';
  async function release() {
    root.querySelector('[data-generate]').disabled = true;
    if (runtime) { try { await runtime.exit(); } catch (_) { /* best effort */ } runtime = null; }
    root.querySelector('[data-release]').disabled = true; root.querySelector('[data-load]').disabled = !metadata;
  }
  registerCleanup(root, () => { if (runtime) runtime.exit().catch(() => {}); });
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await release(); file = checkedFile(root.querySelector('[data-file]').files[0], MAX_MODEL_BYTES, t, 'GGUF');
      const windowBytes = new Uint8Array(await file.slice(0, Math.min(file.size, 32 * MiB)).arrayBuffer());
      metadata = parseGgufMetadata(windowBytes);
      const architecture = metadata.metadata['general.architecture'] || 'unknown';
      const layers = Number(metadata.metadata[`${architecture}.block_count`] || 24); const embedding = Number(metadata.metadata[`${architecture}.embedding_length`] || 2048);
      const memory = estimateModelMemory(file.size, Number(root.querySelector('[data-context]').value), layers, embedding);
      metrics(root, [['GGUF', `v${metadata.version}`], [t('Tensors', 'Tensores'), metadata.tensorCount.toLocaleString()], [t('Architecture', 'Arquitetura'), architecture], [t('Estimated memory', 'Memória estimada'), formatBytes(memory.total)]]);
      const safeMetadata = Object.fromEntries(Object.entries(metadata.metadata).slice(0, 500).map(([key, value]) => [key, Array.isArray(value) && value.length > 100 ? [...value.slice(0, 100), `… ${value.length - 100} more`] : value]));
      ui.output.replaceChildren(textSection(t('GGUF metadata', 'Metadados GGUF'), JSON.stringify({ ...metadata, metadata: safeMetadata, fileBytes: file.size, estimatedMemory: memory }, null, 2)));
      root.querySelector('[data-load]').disabled = false; ui.actions.replaceChildren(actionButton(t('Export metadata report', 'Exportar relatório de metadados'), () => downloadJson({ file: file.name, bytes: file.size, ...metadata, estimatedMemory: memory }, `${sanitizeFilename(file.name)}.metadata.json`)));
      showResult(root); setStatus(ui.status, t('GGUF metadata parsed. Review the memory estimate before loading.', 'Metadados GGUF interpretados. Revise a estimativa de memória antes de carregar.'), 'success');
    } catch (error) { setStatus(ui.status, error.message, 'error'); }
  });
  root.querySelector('[data-load]').addEventListener('click', async () => {
    if (!file || !metadata) return;
    try {
      await release(); ui.progress.hidden = false; ui.progress.removeAttribute('value');
      setStatus(ui.status, t('Loading the local llama.cpp runtime and model…', 'Carregando o runtime llama.cpp local e o modelo…'));
      const module = await import('/vendor/wllama/index.min.js');
      runtime = new module.Wllama({ default: '/vendor/wllama/wllama.wasm' }, { suppressNativeLog: true, allowOffline: true });
      const useWebGpu = runtime.isSupportWebGPU?.() === true;
      await runtime.loadModel([file], {
        n_ctx: Math.max(128, Math.min(32768, Number(root.querySelector('[data-context]').value) || 2048)),
        n_threads: Math.max(1, Math.min(16, Number(root.querySelector('[data-threads]').value) || 4)),
        n_gpu_layers: useWebGpu ? 999 : 0
      });
      ui.progress.hidden = true; root.querySelector('[data-generate]').disabled = false; root.querySelector('[data-release]').disabled = false; root.querySelector('[data-load]').disabled = true;
      const info = runtime.getLoadedContextInfo?.(); setStatus(ui.status, t(`Model ready${useWebGpu ? ' with WebGPU' : ' on CPU/WASM'}.`, `Modelo pronto${useWebGpu ? ' com WebGPU' : ' em CPU/WASM'}.`), 'success');
      if (info) ui.output.append(textSection(t('Loaded context', 'Contexto carregado'), JSON.stringify(info, null, 2)));
    } catch (error) { ui.progress.hidden = true; await release(); setStatus(ui.status, t(`Local inference could not load this model: ${error.message}`, `A inferência local não conseguiu carregar este modelo: ${error.message}`), 'error'); }
  });
  root.querySelector('[data-generate]').addEventListener('click', async () => {
    if (!runtime) return;
    const button = root.querySelector('[data-generate]'); button.disabled = true; root.querySelector('[data-release]').disabled = false; generated = '';
    const section = textSection(t('Generated text', 'Texto gerado'), ''); ui.output.append(section); const pre = section.querySelector('pre');
    try {
      setStatus(ui.status, t('Generating tokens entirely on this device…', 'Gerando tokens inteiramente neste dispositivo…'));
      const stream = await runtime.createCompletion({ prompt: root.querySelector('[data-prompt]').value, max_tokens: Math.max(1, Math.min(2048, Number(root.querySelector('[data-max-tokens]').value) || 128)), temperature: Math.max(0, Math.min(2, Number(root.querySelector('[data-temperature]').value) || 0.7)), top_p: 0.9, top_k: 40, stream: true });
      for await (const chunk of stream) { generated += chunk.choices?.[0]?.text || ''; pre.textContent = generated; }
      ui.actions.append(actionButton(t('Download generation', 'Baixar geração'), () => downloadBlob(new Blob([generated], { type: 'text/plain;charset=utf-8' }), 'local-llm-generation.txt')));
      setStatus(ui.status, t('Generation complete. No prompt or model bytes left this device.', 'Geração concluída. Prompt e modelo não saíram do dispositivo.'), 'success');
    } catch (error) { setStatus(ui.status, error.message, 'error'); }
    finally { button.disabled = !runtime; }
  });
  root.querySelector('[data-release]').addEventListener('click', async () => { await release(); setStatus(ui.status, t('Model memory and worker released.', 'Memória do modelo e worker liberados.'), 'success'); });
}

const WHISPER_MODELS = {
  english: { model: 'onnx-community/whisper-tiny.en_timestamped', revision: 'aeaa13760958b03fac5062f457d317d3319c3168' },
  multilingual: { model: 'onnx-community/whisper-tiny_timestamped', revision: '517244293732ee2d58139af5814231b7e6830a0d' }
};

async function decodeSpeechMedia(file, t, maxSeconds = 10 * 60) {
  const context = new AudioContext({ sampleRate: 16_000 });
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > maxSeconds) throw new Error(t(`Decoded media must be between 0 and ${Math.round(maxSeconds / 60)} minutes.`, `A mídia decodificada deve ter entre 0 e ${Math.round(maxSeconds / 60)} minutos.`));
    const length = Math.ceil(buffer.duration * 16_000); if (length * 4 > 40 * MiB) throw new Error(t('Decoded PCM exceeds the 40 MiB processing cap.', 'O PCM decodificado excede o limite de 40 MiB.'));
    const samples = new Float32Array(length); const ratio = buffer.sampleRate / 16_000;
    for (let index = 0; index < length; index += 1) {
      const at = index * ratio; const left = Math.floor(at); const right = Math.min(buffer.length - 1, left + 1); const fraction = at - left; let mixed = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) { const data = buffer.getChannelData(channel); mixed += data[left] * (1 - fraction) + data[right] * fraction; }
      samples[index] = mixed / buffer.numberOfChannels;
    }
    return { samples, duration: buffer.duration, sourceRate: buffer.sampleRate, channels: buffer.numberOfChannels };
  } finally { await context.close(); }
}

class WhisperSession {
  constructor(t, onEvent = () => {}) { this.t = t; this.onEvent = onEvent; this.worker = null; this.readyKey = ''; this.sequence = 0; this.pending = null; }
  async load(choice, device) {
    await this.release();
    if (device === 'webgpu' && !navigator.gpu) throw new Error(this.t('WebGPU is unavailable; choose WASM.', 'WebGPU indisponível; escolha WASM.'));
    const config = WHISPER_MODELS[choice]; const key = `${choice}:${device}`; const requestId = ++this.sequence;
    this.worker = new Worker('/assets/tools/private-transcriber-worker.js', { type: 'module' });
    this.worker.onmessage = ({ data }) => this.handle(data);
    this.pending = promisePair(); this.worker.postMessage({ type: 'load', ...config, choice, device, key, requestId }); this.onEvent({ type: 'loading', value: 0 });
    await this.pending.promise; this.readyKey = key; return key;
  }
  async transcribe(file, language = 'auto') {
    if (!this.worker || !this.readyKey) throw new Error(this.t('Load the Whisper model first.', 'Carregue o modelo Whisper primeiro.'));
    if (this.readyKey.startsWith('english:')) language = 'english';
    const decoded = await decodeSpeechMedia(file, this.t); this.pending = promisePair(); this.worker.postMessage({ type: 'transcribe', key: this.readyKey, audio: decoded.samples.buffer, language }, [decoded.samples.buffer]); const result = await this.pending.promise; return { transcript: normalizeTranscript(result), decoded };
  }
  handle(data) {
    if (data.type === 'model-progress') this.onEvent({ type: 'progress', value: Number(data.progress?.progress) || 0 });
    if (data.type === 'status') this.onEvent({ type: 'status', message: data.message });
    if (data.type === 'ready') this.pending?.resolve(data);
    if (data.type === 'complete') this.pending?.resolve(data.result);
    if (data.type === 'error') this.pending?.reject(new Error(data.message || 'Whisper runtime failed.'));
  }
  async release() { if (this.worker) { this.worker.postMessage({ type: 'release', key: this.readyKey, requestId: ++this.sequence }); this.worker.terminate(); } this.worker = null; this.readyKey = ''; if (this.pending) this.pending.reject(new DOMException('Released', 'AbortError')); this.pending = null; }
}

function promisePair() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function renderTranscript(root, transcript, decoded, t) {
  metrics(root, [[t('Duration', 'Duração'), `${decoded.duration.toFixed(1)} s`], [t('Cues', 'Trechos'), transcript.cues.length], [t('Characters', 'Caracteres'), transcript.text.length], [t('Uploads', 'Uploads'), '0 B']]);
  const output = root.querySelector('[data-output]'); output.replaceChildren();
  const label = document.createElement('label'); label.className = 'field-label'; label.textContent = t('Reviewed transcript', 'Transcrição revisada');
  const textarea = document.createElement('textarea'); textarea.className = 'code-input'; textarea.rows = 14; textarea.value = transcript.text; textarea.dataset.reviewedTranscript = '';
  const list = document.createElement('ol'); list.className = 'cue-list';
  for (const cue of transcript.cues) { const item = document.createElement('li'); const time = document.createElement('time'); time.textContent = `${cue.start.toFixed(3)} → ${cue.end.toFixed(3)}`; const text = document.createElement('span'); text.textContent = cue.text; item.append(time, text); list.append(item); }
  output.append(label, textarea, list); showResult(root);
}

function mountSpeech({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Transcribe local media', titlePt: 'Transcrever mídia local', badge: 'Whisper on device', badgePt: 'Whisper no dispositivo',
    controls: `<label class="field-label" for="speech-file">${t('Audio or video file', 'Arquivo de áudio ou vídeo')}</label><input class="file-input" id="speech-file" type="file" accept="audio/*,video/*" required data-file><div class="field-grid"><label><span class="field-label">${t('Model', 'Modelo')}</span><select data-model><option value="english">Whisper Tiny · English</option><option value="multilingual">Whisper Tiny · Multilingual</option></select></label><label><span class="field-label">${t('Language', 'Idioma')}</span><select data-language><option value="auto">${t('Auto-detect', 'Detectar')}</option><option value="english">English</option><option value="portuguese">Português</option><option value="spanish">Español</option><option value="french">Français</option></select></label></div><fieldset class="segmented-fieldset"><legend>Backend</legend><label><input type="radio" name="speech-backend" value="webgpu" checked><span>WebGPU</span></label><label><input type="radio" name="speech-backend" value="wasm"><span>WASM</span></label></fieldset><div class="notice-card"><strong>${t('First use downloads model weights.', 'O primeiro uso baixa os pesos do modelo.')}</strong><p>${t('The download goes to the browser cache; selected media is decoded and inferred locally.', 'O download vai para o cache; a mídia selecionada é decodificada e processada localmente.')}</p></div><div class="button-row"><button class="button button-secondary" type="button" data-load>${t('Load model', 'Carregar modelo')}</button><button class="button button-primary" type="submit" disabled data-transcribe>${t('Transcribe locally', 'Transcrever localmente')}</button><button class="button button-secondary" type="button" disabled data-release>${t('Release model', 'Liberar modelo')}</button></div>`,
    resultTitle: 'Reviewed transcript', resultTitlePt: 'Transcrição revisada',
    empty: 'Audio/video is limited to 96 MiB and ten decoded minutes per run.', emptyPt: 'Áudio/vídeo é limitado a 96 MiB e dez minutos decodificados por execução.'
  });
  const session = new WhisperSession(t, (event) => { if (event.type === 'progress') { ui.progress.hidden = false; ui.progress.max = 100; ui.progress.value = event.value; } if (event.type === 'status') setStatus(ui.status, t('Loading or running local Whisper…', 'Carregando ou executando Whisper local…')); });
  let result = null;
  const modelSelect = root.querySelector('[data-model]'); const languageSelect = root.querySelector('[data-language]'); let multilingualLanguage = 'auto';
  const syncSpeechLanguage = () => {
    const englishOnly = modelSelect.value === 'english';
    if (englishOnly) { if (!languageSelect.disabled) multilingualLanguage = languageSelect.value; languageSelect.value = 'english'; languageSelect.disabled = true; }
    else { languageSelect.disabled = false; languageSelect.value = multilingualLanguage; }
  };
  languageSelect.addEventListener('change', () => { if (!languageSelect.disabled) multilingualLanguage = languageSelect.value; });
  modelSelect.addEventListener('change', syncSpeechLanguage); syncSpeechLanguage();
  registerCleanup(root, () => session.release());
  root.querySelector('[data-load]').addEventListener('click', async () => {
    try { root.querySelector('[data-load]').disabled = true; await session.load(root.querySelector('[data-model]').value, ui.form.elements['speech-backend'].value); ui.progress.hidden = true; root.querySelector('[data-load]').disabled = false; root.querySelector('[data-transcribe]').disabled = false; root.querySelector('[data-release]').disabled = false; setStatus(ui.status, t('Whisper model ready.', 'Modelo Whisper pronto.'), 'success'); } catch (error) { root.querySelector('[data-load]').disabled = false; setStatus(ui.status, error.message, 'error'); }
  });
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const file = checkedFile(root.querySelector('[data-file]').files[0], MAX_MEDIA_BYTES, t, t('media file', 'arquivo de mídia')); root.querySelector('[data-transcribe]').disabled = true; setStatus(ui.status, t('Decoding and transcribing locally…', 'Decodificando e transcrevendo localmente…'));
      result = await session.transcribe(file, modelSelect.value === 'english' ? 'english' : languageSelect.value); renderTranscript(root, result.transcript, result.decoded, t);
      const reviewed = () => applyTranscriptReview(result.transcript, root.querySelector('[data-reviewed-transcript]').value, result.decoded.duration);
      ui.actions.replaceChildren(actionButton('TXT', () => downloadBlob(new Blob([reviewed().text], { type: 'text/plain' }), 'local-transcript.txt')), actionButton('VTT', () => downloadBlob(new Blob([transcriptToVtt(reviewed().cues)], { type: 'text/vtt' }), 'local-transcript.vtt')), actionButton('SRT', () => downloadBlob(new Blob([transcriptToSrt(reviewed().cues)], { type: 'text/plain' }), 'local-transcript.srt')), actionButton('JSON', () => downloadJson(reviewed(), 'local-transcript.json')));
      setStatus(ui.status, t('Transcription complete. Timed exports use the reviewed text; whole-text edits become one full-duration cue.', 'Transcrição concluída. Exportações temporizadas usam o texto revisado; edições integrais viram uma única legenda com a duração total.'), 'success');
    } catch (error) { setStatus(ui.status, error.message, 'error'); } finally { root.querySelector('[data-transcribe]').disabled = !session.readyKey; }
  });
  root.querySelector('[data-release]').addEventListener('click', async () => { await session.release(); root.querySelector('[data-transcribe]').disabled = true; root.querySelector('[data-release]').disabled = true; setStatus(ui.status, t('Model and worker released.', 'Modelo e worker liberados.'), 'success'); });
  root.querySelectorAll('[data-model], input[name="speech-backend"]').forEach((control) => control.addEventListener('change', async () => { if (session.readyKey) { await session.release(); root.querySelector('[data-transcribe]').disabled = true; root.querySelector('[data-release]').disabled = true; setStatus(ui.status, t('Model setting changed. Load it again.', 'Configuração alterada. Carregue novamente.'), 'warning'); } }));
}

async function preprocessVisionImage(file, width, height, layout, mean, std, inputType = 'float32', colorOrder = 'rgb') {
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 80_000_000) throw new RangeError('Image dimensions exceed the 80-megapixel cap.');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(bitmap, 0, 0, width, height); const rgba = context.getImageData(0, 0, width, height).data;
    const count = width * height * 3; const data = inputType === 'uint8' ? new Uint8Array(count) : new Float32Array(count);
    for (let pixel = 0; pixel < width * height; pixel += 1) for (let channel = 0; channel < 3; channel += 1) { const sourceChannel = colorOrder === 'bgr' ? 2 - channel : channel; const value = rgba[pixel * 4 + sourceChannel]; const normalized = inputType === 'uint8' ? value : (value / 255 - mean[channel]) / std[channel]; data[layout === 'nchw' ? channel * width * height + pixel : pixel * 3 + channel] = normalized; }
    return { data, dims: layout === 'nchw' ? [1, 3, height, width] : [1, height, width, 3], bitmapSize: [bitmap.width, bitmap.height], previewCanvas: canvas };
  } finally { bitmap.close(); }
}

function parseVisionTriplet(value, fallback, label, { nonzero = false } = {}) {
  const parts = String(value || '').split(/[\s,;]+/).filter(Boolean).map(Number);
  const result = parts.length ? parts : fallback;
  if (result.length !== 3 || result.some((item) => !Number.isFinite(item) || (nonzero && item === 0))) throw new Error(`${label} must contain three ${nonzero ? 'non-zero ' : ''}numbers.`);
  return result;
}

function normalizeVisionInputType(value) {
  const type = String(value || '').toLocaleLowerCase();
  if (type === 'float32' || type === 'tensor(float)') return 'float32';
  if (type === 'uint8' || type === 'tensor(uint8)') return 'uint8';
  return type;
}

function fixedTensorDimension(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function visionInputMetadata(session, name) {
  const names = Array.from(session?.inputNames || []);
  const index = names.indexOf(name);
  return Array.isArray(session?.inputMetadata)
    ? session.inputMetadata[index]
    : session?.inputMetadata?.[name];
}

function visionInputDescriptor(session, layout, t) {
  const names = Array.from(session?.inputNames || []);
  if (names.length !== 1) throw new Error(t('This workbench supports ONNX image models with exactly one input tensor.', 'Este ambiente aceita modelos ONNX de imagem com exatamente um tensor de entrada.'));
  const name = names[0];
  const metadata = visionInputMetadata(session, name);
  const type = normalizeVisionInputType(metadata?.type);
  if (!['float32', 'uint8'].includes(type)) throw new Error(t(`Unsupported ONNX input type “${metadata?.type || 'unknown'}”; use a float32 or uint8 image model.`, `Tipo de entrada ONNX “${metadata?.type || 'desconhecido'}” incompatível; use um modelo de imagem float32 ou uint8.`));
  const shape = Array.from(metadata?.shape || metadata?.dims || metadata?.dimensions || []);
  if (shape.length !== 4) throw new Error(t('The ONNX input must be a four-dimensional image tensor.', 'A entrada ONNX deve ser um tensor de imagem com quatro dimensões.'));
  const batch = fixedTensorDimension(shape[0]);
  if (batch != null && batch !== 1) throw new Error(t('Only batch-size 1 ONNX image models are supported.', 'Somente modelos ONNX de imagem com lote 1 são compatíveis.'));
  const channelAxis = layout === 'nchw' ? 1 : 3; const channels = fixedTensorDimension(shape[channelAxis]);
  if (channels != null && channels !== 3) throw new Error(t('The selected layout requires exactly three image channels.', 'O layout selecionado exige exatamente três canais de imagem.'));
  return { name, metadata, type, shape };
}

function assertVisionInputSize(descriptor, layout, width, height, t) {
  const fixedWidth = fixedTensorDimension(descriptor.shape[layout === 'nchw' ? 3 : 2]);
  const fixedHeight = fixedTensorDimension(descriptor.shape[layout === 'nchw' ? 2 : 1]);
  if ((fixedWidth != null && fixedWidth !== width) || (fixedHeight != null && fixedHeight !== height)) throw new Error(t(`The model requires ${fixedWidth || 'dynamic'} × ${fixedHeight || 'dynamic'} input; update the configured width and height.`, `O modelo exige entrada ${fixedWidth || 'dinâmica'} × ${fixedHeight || 'dinâmica'}; ajuste a largura e a altura.`));
}

function assertVisionOutput(tensor, values, adapter, t) {
  if (!tensor || !values || !Number.isSafeInteger(values.length) || !values.length) throw new Error(t('The selected ONNX output is empty or invalid.', 'A saída ONNX selecionada está vazia ou é inválida.'));
  if (values.length > MAX_VISION_OUTPUT_VALUES) throw new RangeError(t(`ONNX output exceeds the ${MAX_VISION_OUTPUT_VALUES.toLocaleString()}-value safety cap.`, `A saída ONNX excede o limite de segurança de ${MAX_VISION_OUTPUT_VALUES.toLocaleString()} valores.`));
  if (adapter === 'classification' && values.length > MAX_CLASSIFICATION_VALUES) throw new RangeError(t(`Classification output exceeds the ${MAX_CLASSIFICATION_VALUES.toLocaleString()}-value cap.`, `A saída de classificação excede o limite de ${MAX_CLASSIFICATION_VALUES.toLocaleString()} valores.`));
  const dims = Array.from(tensor.dims || []);
  if (!dims.length || dims.some((value) => !Number.isSafeInteger(Number(value)) || Number(value) < 1)) throw new Error(t('The selected ONNX output has invalid dimensions.', 'A saída ONNX selecionada possui dimensões inválidas.'));
  if (adapter === 'detection') {
    const width = Number(dims.at(-1)); const rows = values.length / width;
    if (!Number.isSafeInteger(width) || width < 6 || !Number.isSafeInteger(rows)) throw new Error(t('Detection output must contain complete rows with at least six values.', 'A saída de detecção deve conter linhas completas com pelo menos seis valores.'));
    if (rows > MAX_DETECTION_ROWS) throw new RangeError(t(`Detection output exceeds the ${MAX_DETECTION_ROWS.toLocaleString()}-row cap.`, `A saída de detecção excede o limite de ${MAX_DETECTION_ROWS.toLocaleString()} linhas.`));
  }
  return dims;
}

function disposeOrtValues(values) {
  for (const value of Object.values(values || {})) try { value?.dispose?.(); } catch (_) { /* best effort */ }
}

function renderSegmentationMask(mask, t) {
  const canvas = document.createElement('canvas'); canvas.className = 'suite-canvas'; canvas.width = mask.width; canvas.height = mask.height; canvas.setAttribute('aria-label', t('Decoded segmentation class mask', 'Máscara de classes de segmentação decodificada'));
  const context = canvas.getContext('2d'); const image = context.createImageData(mask.width, mask.height);
  for (let pixel = 0; pixel < mask.labels.length; pixel += 1) {
    const label = mask.labels[pixel]; const hash = Math.imul(label + 1, 2654435761) >>> 0;
    image.data[pixel * 4] = 48 + (hash & 0x9f); image.data[pixel * 4 + 1] = 48 + ((hash >>> 8) & 0x9f); image.data[pixel * 4 + 2] = 48 + ((hash >>> 16) & 0x9f); image.data[pixel * 4 + 3] = label === 0 ? 72 : 220;
  }
  context.putImageData(image, 0, 0); return canvas;
}

function mountVision({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Run a vision model', titlePt: 'Executar um modelo de visão', badge: 'ONNX · WebGPU/WASM', badgePt: 'ONNX · WebGPU/WASM',
    controls: `<label class="field-label" for="vision-model">ONNX</label><input class="file-input" id="vision-model" type="file" accept=".onnx,application/octet-stream" required data-model><label class="field-label" for="vision-image">${t('Input image', 'Imagem de entrada')}</label><input class="file-input" id="vision-image" type="file" accept="image/*" required data-image><div class="field-grid"><label><span class="field-label">Backend</span><select data-backend><option value="webgpu">WebGPU</option><option value="wasm">WASM</option></select></label><label><span class="field-label">${t('Output adapter', 'Adaptador de saída')}</span><select data-adapter><option value="classification">${t('Classification / top values', 'Classificação / maiores valores')}</option><option value="detection">${t('Detection rows [x,y,w,h,score,class]', 'Detecção [x,y,w,h,score,class]')}</option><option value="segmentation">${t('Segmentation mask [N,C,H,W] / [N,H,W,C]', 'Máscara [N,C,H,W] / [N,H,W,C]')}</option><option value="tensor">${t('Raw tensor summary', 'Resumo de tensor')}</option></select></label><label><span class="field-label">${t('Input width', 'Largura')}</span><input class="number-input" type="number" min="16" max="4096" value="224" data-width></label><label><span class="field-label">${t('Input height', 'Altura')}</span><input class="number-input" type="number" min="16" max="4096" value="224" data-height></label><label><span class="field-label">Layout</span><select data-layout><option value="nchw">NCHW</option><option value="nhwc">NHWC</option></select></label><label><span class="field-label">${t('Color order', 'Ordem de cor')}</span><select data-color-order><option value="rgb">RGB</option><option value="bgr">BGR</option></select></label><label><span class="field-label">${t('Channel mean', 'Média dos canais')}</span><input class="text-input" type="text" value="0.485, 0.456, 0.406" data-mean></label><label><span class="field-label">${t('Channel standard deviation', 'Desvio padrão dos canais')}</span><input class="text-input" type="text" value="0.229, 0.224, 0.225" data-std></label><label><span class="field-label">${t('Labels (one per line)', 'Rótulos (um por linha)')}</span><textarea class="code-input" rows="3" data-labels></textarea></label></div><button class="button button-primary" type="submit">${t('Run locally', 'Executar localmente')}</button><button class="button button-secondary" type="button" disabled data-release>${t('Release session', 'Liberar sessão')}</button>`,
    resultTitle: 'Model output', resultTitlePt: 'Saída do modelo',
    empty: 'Preprocessing settings are explicit; arbitrary outputs are never guessed.', emptyPt: 'O pré-processamento é explícito; saídas arbitrárias nunca são adivinhadas.'
  });
  const segmentationLayoutLabel = document.createElement('label');
  segmentationLayoutLabel.innerHTML = `<span class="field-label">${t('Segmentation output layout', 'Layout da saída de segmentação')}</span><select data-segmentation-layout><option value="nchw">NCHW</option><option value="nhwc">NHWC</option></select>`;
  root.querySelector('[data-adapter]').closest('label').after(segmentationLayoutLabel);
  let ort = null; let session = null; let report = null; let running = false;
  const submitButton = ui.form.querySelector('button[type="submit"]');
  async function release() { const current = session; session = null; root.querySelector('[data-release]').disabled = true; try { await current?.release?.(); } catch (_) { /* best effort */ } }
  registerCleanup(root, () => release()); root.querySelector('[data-release]').addEventListener('click', async () => { await release(); setStatus(ui.status, t('ONNX session released.', 'Sessão ONNX liberada.'), 'success'); });
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (running) return;
    running = true; submitButton.disabled = true;
    let inputTensor = null; let outputs = null;
    try {
      const model = checkedFile(root.querySelector('[data-model]').files[0], 512 * MiB, t, 'ONNX'); const image = checkedFile(root.querySelector('[data-image]').files[0], 64 * MiB, t, t('image', 'imagem')); const backend = root.querySelector('[data-backend]').value;
      if (backend === 'webgpu' && !navigator.gpu) throw new Error(t('WebGPU is unavailable. Choose WASM.', 'WebGPU indisponível. Escolha WASM.'));
      await release(); ui.progress.hidden = false; ui.progress.removeAttribute('value'); setStatus(ui.status, t('Loading the local ONNX runtime…', 'Carregando o runtime ONNX local…'));
      ort ||= await import('/vendor/onnxruntime/ort.webgpu.bundle.min.mjs'); ort.env.wasm.wasmPaths = '/vendor/onnxruntime/'; ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      session = await ort.InferenceSession.create(new Uint8Array(await model.arrayBuffer()), { executionProviders: [backend], graphOptimizationLevel: 'all' });
      const layout = root.querySelector('[data-layout]').value; const descriptor = visionInputDescriptor(session, layout, t); const { name: inputName, type } = descriptor;
      const width = Math.max(16, Math.min(4096, Number(root.querySelector('[data-width]').value) || 224)); const height = Math.max(16, Math.min(4096, Number(root.querySelector('[data-height]').value) || 224)); if (width * height > 8_388_608) throw new RangeError(t('Input tensor exceeds the 8-megapixel cap.', 'O tensor de entrada excede 8 megapixels.'));
      assertVisionInputSize(descriptor, layout, width, height, t);
      const colorOrder = root.querySelector('[data-color-order]').value; const mean = parseVisionTriplet(root.querySelector('[data-mean]').value, [0.485, 0.456, 0.406], 'Mean'); const std = parseVisionTriplet(root.querySelector('[data-std]').value, [0.229, 0.224, 0.225], 'Standard deviation', { nonzero: true });
      const prepared = await preprocessVisionImage(image, width, height, layout, mean, std, type, colorOrder);
      inputTensor = new ort.Tensor(type, prepared.data, prepared.dims);
      const started = performance.now(); outputs = await session.run({ [inputName]: inputTensor }); const elapsed = performance.now() - started; const entry = Object.entries(outputs)[0]; if (!entry) throw new Error(t('The ONNX model returned no outputs.', 'O modelo ONNX não retornou saídas.'));
      const [outputName, tensor] = entry; const values = tensor.getData ? await tensor.getData() : tensor.data; const adapter = root.querySelector('[data-adapter]').value; const outputDims = assertVisionOutput(tensor, values, adapter, t); const labels = root.querySelector('[data-labels]').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      report = { tool: 'Local Computer Vision Lab', backend, preprocessing: { resize: [width, height], layout, colorOrder, mean, std }, input: { name: inputName, type, dims: prepared.dims, source: prepared.bitmapSize }, output: { name: outputName, availableNames: Object.keys(outputs), type: tensor.type, dims: outputDims, elements: values.length }, adapter, elapsedMs: elapsed };
      let segmentation = null;
      if (adapter === 'classification') report.predictions = topK(values, 10, labels);
      if (adapter === 'detection') { const widthOfRow = Number(outputDims.at(-1)); const detections = []; for (let row = 0; row < values.length / widthOfRow; row += 1) { const score = Number(values[row * widthOfRow + 4]); if (Number.isFinite(score) && score >= 0.25) detections.push({ x: values[row * widthOfRow], y: values[row * widthOfRow + 1], width: values[row * widthOfRow + 2], height: values[row * widthOfRow + 3], score, class: values[row * widthOfRow + 5] }); } report.detections = detections.sort((a, b) => b.score - a.score).slice(0, 500); }
      if (adapter === 'segmentation') { segmentation = decodeSegmentationMask(values, tensor.dims, { layout: root.querySelector('[data-segmentation-layout]').value }); const counts = new Map(); segmentation.labels.forEach((label) => counts.set(label, (counts.get(label) || 0) + 1)); report.segmentation = { width: segmentation.width, height: segmentation.height, classes: segmentation.classes, layout: root.querySelector('[data-segmentation-layout]').value, classPixels: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256)) }; }
      if (adapter === 'tensor') report.sample = Array.from(values.slice(0, 1_000));
      metrics(root, [[t('Backend', 'Backend'), backend], [t('Inference', 'Inferência'), `${elapsed.toFixed(1)} ms`], [t('Output shape', 'Dimensão da saída'), outputDims.join(' × ')], [t('Output elements', 'Elementos de saída'), values.length.toLocaleString()]]);
      const previewSection = document.createElement('section'); const previewHeading = document.createElement('h3'); previewHeading.textContent = t('Preprocessed image', 'Imagem pré-processada'); prepared.previewCanvas.className = 'suite-canvas'; prepared.previewCanvas.setAttribute('aria-label', t('Preprocessed image supplied to the ONNX model', 'Imagem pré-processada fornecida ao modelo ONNX')); previewSection.append(previewHeading, prepared.previewCanvas);
      ui.output.replaceChildren(previewSection); if (segmentation) { const maskSection = document.createElement('section'); const maskHeading = document.createElement('h3'); maskHeading.textContent = t('Segmentation mask', 'Máscara de segmentação'); maskSection.append(maskHeading, renderSegmentationMask(segmentation, t)); ui.output.append(maskSection); } ui.output.append(textSection(t('Adapter result', 'Resultado do adaptador'), JSON.stringify(report, null, 2))); ui.actions.replaceChildren(actionButton(t('Export inference report', 'Exportar relatório da inferência'), () => downloadJson(report, 'vision-result.json'))); showResult(root); setStatus(ui.status, t('Inference complete. Review the preprocessing and selected output adapter.', 'Inferência concluída. Revise o pré-processamento e o adaptador escolhido.'), 'success');
    } catch (error) { disposeOrtValues(outputs); outputs = null; try { inputTensor?.dispose?.(); } catch (_) { /* best effort */ } inputTensor = null; await release(); setStatus(ui.status, error.message, 'error'); }
    finally { disposeOrtValues(outputs); try { inputTensor?.dispose?.(); } catch (_) { /* best effort */ } ui.progress.hidden = true; running = false; submitButton.disabled = false; root.querySelector('[data-release]').disabled = !session; }
  });
}

async function createOcrWorker(language, onProgress) {
  const tesseract = await import('/vendor/tesseract/tesseract.esm.min.js');
  return tesseract.createWorker(language, 1, {
    workerPath: '/vendor/tesseract/worker.min.js',
    corePath: '/vendor/tesseract/core',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    logger: (message) => onProgress(message)
  });
}

class EmbeddingSession {
  constructor(onProgress = () => {}) { this.worker = null; this.pending = new Map(); this.sequence = 0; this.ready = false; this.loadPromise = null; this.queue = Promise.resolve(); this.onProgress = onProgress; }
  get active() { return Boolean(this.worker); }
  ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker('/assets/tools/suite/ai-embedding-worker.js', { type: 'module' });
    this.worker.onmessage = ({ data }) => this.handle(data);
    this.worker.onerror = (event) => this.rejectPending(new Error(event.message || 'Embedding worker failed.'));
    this.worker.onmessageerror = () => this.rejectPending(new Error('Embedding worker returned an unreadable message.'));
  }
  async request(type, payload = {}) {
    if (!this.worker) throw new Error('Embedding worker is not available.');
    const requestId = ++this.sequence; const pair = promisePair(); this.pending.set(requestId, pair);
    try { this.worker.postMessage({ type, requestId, ...payload }); }
    catch (error) { this.pending.delete(requestId); throw error; }
    try { return await pair.promise; } finally { this.pending.delete(requestId); }
  }
  async load() {
    if (this.ready) return;
    if (this.loadPromise) return this.loadPromise;
    this.ensureWorker(); const worker = this.worker;
    const operation = this.request('load').then(() => { if (this.worker !== worker) throw new DOMException('Released', 'AbortError'); this.ready = true; });
    this.loadPromise = operation;
    try { await operation; } finally { if (this.loadPromise === operation) this.loadPromise = null; }
  }
  async embed(texts) {
    const operation = async () => {
      if (!this.ready || !this.worker) throw new Error('Load the semantic embedding model first.');
      if (!Array.isArray(texts) || !texts.length) throw new Error('Embed at least one record.');
      const output = [];
      for (let offset = 0; offset < texts.length; offset += 32) {
        const result = await this.request('embed', { texts: texts.slice(offset, offset + 32) });
        output.push(...result.embeddings.map((values) => Float32Array.from(values)));
      }
      return output;
    };
    const job = this.queue.then(operation, operation); this.queue = job.then(() => undefined, () => undefined); return job;
  }
  handle(data) {
    const requestId = Number(data?.requestId); const pending = this.pending.get(requestId);
    if (data.type === 'progress') { if (pending) this.onProgress(data); return; }
    if (!pending) return;
    if (data.type === 'ready' || data.type === 'complete') pending.resolve(data);
    if (data.type === 'error') pending.reject(new Error(data.message || 'Embedding runtime failed.'));
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.ready = false;
  }
  async release() {
    const worker = this.worker; this.worker = null; this.ready = false; this.loadPromise = null; this.queue = Promise.resolve();
    this.rejectPending(new DOMException('Released', 'AbortError'));
    if (worker) { try { worker.postMessage({ type: 'release', requestId: ++this.sequence }); } catch (_) { /* worker is already gone */ } worker.terminate(); }
  }
}

function renderStudioRecords(root, records, t) {
  const output = root.querySelector('[data-output]'); output.replaceChildren();
  const list = document.createElement('ol'); list.className = 'finding-list';
  for (const record of records) { const item = document.createElement('li'); const kind = document.createElement('strong'); kind.textContent = record.kind.toUpperCase(); const text = document.createElement('span'); const name = document.createElement('b'); name.textContent = record.name; text.append(name, document.createElement('br'), document.createTextNode(record.text.slice(0, 500) || t('No text recognized.', 'Nenhum texto reconhecido.'))); item.append(kind, text); list.append(item); }
  output.append(list); showResult(root);
}

function mountAiStudio({ root, t }) {
  const ui = commonLayout(root, t, {
    title: 'Build a private media index', titlePt: 'Criar um índice privado de mídia', badge: 'OCR · Vision · Speech · Embeddings', badgePt: 'OCR · Visão · Fala · Embeddings',
    controls: `<label class="field-label" for="studio-files">${t('Images, audio/video, or text', 'Imagens, áudio/vídeo ou texto')}</label><input class="file-input" id="studio-files" type="file" accept="image/*,audio/*,video/*,text/*,.md,.json,.srt,.vtt" multiple required data-files><label class="field-label" for="studio-vision-model">${t('Optional ONNX image model', 'Modelo ONNX de imagem opcional')}</label><input class="file-input" id="studio-vision-model" type="file" accept=".onnx,application/octet-stream" data-vision-model><div class="field-grid"><label><span class="field-label">${t('OCR language', 'Idioma do OCR')}</span><select data-ocr-language><option value="eng">English</option><option value="por">Português</option><option value="spa">Español</option></select></label><label><span class="field-label">${t('Speech model', 'Modelo de fala')}</span><select data-speech-model><option value="multilingual">Whisper Tiny · Multilingual</option><option value="english">Whisper Tiny · English</option></select></label><label><span class="field-label">${t('Vision backend', 'Backend de visão')}</span><select data-vision-backend><option value="wasm">WASM</option><option value="webgpu">WebGPU</option></select></label><label><span class="field-label">${t('Vision input width / height', 'Largura / altura da visão')}</span><span class="suite-inline"><input class="number-input" type="number" min="16" max="2048" value="224" aria-label="${t('Vision input width', 'Largura da entrada de visão')}" data-vision-width><input class="number-input" type="number" min="16" max="2048" value="224" aria-label="${t('Vision input height', 'Altura da entrada de visão')}" data-vision-height></span></label><label><span class="field-label">${t('Vision layout', 'Layout de visão')}</span><select data-vision-layout><option value="auto">${t('Detect from model', 'Detectar pelo modelo')}</option><option value="nchw">NCHW</option><option value="nhwc">NHWC</option></select></label><label><span class="field-label">${t('Vision color order', 'Ordem de cor da visão')}</span><select data-vision-color-order><option value="rgb">RGB</option><option value="bgr">BGR</option></select></label><label><span class="field-label">${t('Vision channel mean', 'Média dos canais de visão')}</span><input class="text-input" type="text" value="0.485, 0.456, 0.406" data-vision-mean></label><label><span class="field-label">${t('Vision channel standard deviation', 'Desvio padrão dos canais de visão')}</span><input class="text-input" type="text" value="0.229, 0.224, 0.225" data-vision-std></label><label><span class="field-label">${t('Vision labels (one per line)', 'Rótulos de visão (um por linha)')}</span><textarea class="code-input" rows="3" data-vision-labels></textarea></label></div><div class="notice-card"><strong>${t('Model downloads are explicit.', 'Downloads de modelos são explícitos.')}</strong><p>${t('OCR language data, Whisper weights, and the MiniLM semantic model download only after their buttons are pressed. Your ONNX model and selected media never leave the device.', 'Dados de idioma OCR, pesos Whisper e o modelo semântico MiniLM baixam somente após seus botões. Seu ONNX e as mídias selecionadas nunca saem do dispositivo.')}</p></div><button class="button button-primary" type="submit">${t('Import project files', 'Importar arquivos do projeto')}</button><div class="button-row"><button class="button button-secondary" type="button" disabled data-ocr>${t('Run OCR', 'Executar OCR')}</button><button class="button button-secondary" type="button" disabled data-vision>${t('Run ONNX image model', 'Executar modelo ONNX')}</button><button class="button button-secondary" type="button" disabled data-speech>${t('Transcribe media', 'Transcrever mídia')}</button><button class="button button-secondary" type="button" disabled data-embeddings>${t('Load MiniLM semantic embeddings', 'Carregar embeddings MiniLM')}</button><button class="button button-secondary" type="button" disabled data-release>${t('Release models', 'Liberar modelos')}</button></div><label class="field-label" for="studio-query">${t('Search project', 'Pesquisar no projeto')}</label><input class="text-input" id="studio-query" type="search" data-query><button class="button button-secondary" type="button" disabled data-search>${t('Search local embeddings', 'Pesquisar embeddings locais')}</button>`,
    resultTitle: 'Private project', resultTitlePt: 'Projeto privado',
    empty: 'Derived text and vectors stay in this tab until you explicitly export the project.', emptyPt: 'Texto e vetores derivados ficam nesta aba até você exportar o projeto.'
  });
  let files = []; let records = []; let ocrWorker = null; let ocrLanguage = ''; let ort = null; let visionSession = null; let visionKey = ''; let embeddingMode = 'hash'; let busy = false;
  const whisper = new WhisperSession(t, (event) => { if (event.type === 'progress') { ui.progress.hidden = false; ui.progress.max = 100; ui.progress.value = event.value; } });
  const embeddings = new EmbeddingSession((event) => { ui.progress.hidden = false; ui.progress.max = 100; ui.progress.value = Number(event.progress) || 0; });
  const hasImages = () => files.some((file) => file.type.startsWith('image/'));
  const hasMedia = () => files.some((file) => /^(?:audio|video)\//.test(file.type));
  const hasRuntime = () => Boolean(ocrWorker || whisper.worker || embeddings.active || visionSession);
  const syncStudioControls = () => {
    ui.form.querySelector('button[type="submit"]').disabled = busy;
    root.querySelector('[data-ocr]').disabled = busy || !hasImages();
    root.querySelector('[data-vision]').disabled = busy || !hasImages() || !root.querySelector('[data-vision-model]').files[0];
    root.querySelector('[data-speech]').disabled = busy || !hasMedia();
    root.querySelector('[data-embeddings]').disabled = busy || !records.length;
    root.querySelector('[data-search]').disabled = busy || !records.length;
    root.querySelector('[data-release]').disabled = busy || !hasRuntime();
  };
  const beginStudioAction = () => { if (busy) return false; busy = true; syncStudioControls(); return true; };
  const finishStudioAction = () => { busy = false; syncStudioControls(); };
  async function release() {
    const currentOcr = ocrWorker; const currentVision = visionSession;
    ocrWorker = null; ocrLanguage = ''; visionSession = null; visionKey = '';
    await Promise.allSettled([currentOcr?.terminate?.(), currentVision?.release?.(), whisper.release(), embeddings.release()]);
    syncStudioControls();
  }
  registerCleanup(root, () => release());
  const embedNewRecords = async (items) => {
    if (!items.length) return;
    if (embeddingMode === 'minilm') { await embeddings.load(); const vectors = await embeddings.embed(items.map((record) => record.text)); items.forEach((record, index) => { record.embedding = vectors[index]; record.embeddingModel = 'Xenova/all-MiniLM-L6-v2'; }); }
    else items.forEach((record) => { record.embedding = hashEmbedding(record.text); record.embeddingModel = 'deterministic-token-hash'; });
  };
  const replaceRecord = (record) => { records = records.filter((item) => !(item.kind === record.kind && item.name === record.name)); records.push(record); };
  const refresh = () => {
    metrics(root, [[t('Sources', 'Fontes'), files.length], [t('Indexed records', 'Registros indexados'), records.length], [t('Recognized characters', 'Caracteres reconhecidos'), records.reduce((sum, record) => sum + record.text.length, 0).toLocaleString()], [t('Embedding engine', 'Motor de embedding'), embeddingMode === 'minilm' ? `MiniLM · ${records[0]?.embedding?.length || 384}D` : `token hash · ${records[0]?.embedding?.length || 256}D`]]);
    if (records.length) renderStudioRecords(root, records, t); else { ui.output.replaceChildren(); ui.output.hidden = true; ui.empty.hidden = false; }
    syncStudioControls();
    ui.actions.replaceChildren(actionButton(t('Export private project', 'Exportar projeto privado'), () => downloadJson({ version: 2, embeddingMode, records: records.map(({ embedding, ...record }) => ({ ...record, embedding: Array.from(embedding || []) })) }, 'ai-media-project.json')));
  };
  root.querySelector('[data-vision-model]').addEventListener('change', syncStudioControls); syncStudioControls();
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!beginStudioAction()) return;
    try {
      await release(); files = [...root.querySelector('[data-files]').files];
      if (!files.length || files.length > 100 || files.reduce((sum, file) => sum + file.size, 0) > 256 * MiB) throw new Error(t('Choose up to 100 files and 256 MiB total.', 'Escolha até 100 arquivos e 256 MiB no total.'));
      embeddingMode = 'hash'; records = [];
      const textRecords = [];
      for (const file of files.filter((item) => item.type.startsWith('text/') || /\.(?:md|json|srt|vtt)$/i.test(item.name))) textRecords.push({ id: crypto.randomUUID(), name: file.name, kind: 'text', text: (await file.text()).slice(0, 4_000_000) });
      await embedNewRecords(textRecords); records.push(...textRecords);
      refresh(); setStatus(ui.status, t('Project imported. Run the disclosed local models you need.', 'Projeto importado. Execute os modelos locais informados de que precisar.'), 'success');
    } catch (error) { await release(); setStatus(ui.status, error.message, 'error'); }
    finally { finishStudioAction(); }
  });
  root.querySelector('[data-ocr]').addEventListener('click', async () => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (!beginStudioAction()) return;
    try {
      ui.progress.hidden = false; ui.progress.max = images.length; ui.progress.value = 0;
      const language = root.querySelector('[data-ocr-language]').value;
      if (ocrWorker && ocrLanguage !== language) { await ocrWorker.terminate(); ocrWorker = null; }
      if (!ocrWorker) { ocrWorker = await createOcrWorker(language, (message) => { if (Number.isFinite(message.progress)) setStatus(ui.status, t(`OCR ${Math.round(message.progress * 100)}%`, `OCR ${Math.round(message.progress * 100)}%`)); }); ocrLanguage = language; }
      const added = [];
      for (const file of images) { const result = await ocrWorker.recognize(file); added.push({ id: crypto.randomUUID(), name: file.name, kind: 'ocr', text: String(result.data.text || '').trim(), confidence: result.data.confidence }); ui.progress.value += 1; }
      await embedNewRecords(added); added.forEach(replaceRecord); refresh(); setStatus(ui.status, t('OCR complete. Review low-confidence text before relying on search.', 'OCR concluído. Revise textos de baixa confiança.'), 'success');
    } catch (error) { await release(); setStatus(ui.status, error.message, 'error'); }
    finally { ui.progress.hidden = true; finishStudioAction(); }
  });
  root.querySelector('[data-vision]').addEventListener('click', async () => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (!beginStudioAction()) return;
    let inputTensor = null; let outputs = null;
    try {
      const model = checkedFile(root.querySelector('[data-vision-model]').files[0], 512 * MiB, t, 'ONNX'); const backend = root.querySelector('[data-vision-backend]').value;
      if (backend === 'webgpu' && !navigator.gpu) throw new Error(t('WebGPU is unavailable. Choose WASM.', 'WebGPU indisponível. Escolha WASM.'));
      const key = `${model.name}:${model.size}:${model.lastModified}:${backend}`;
      if (!visionSession || visionKey !== key) {
        const previous = visionSession; visionSession = null; visionKey = ''; await previous?.release?.();
        ort ||= await import('/vendor/onnxruntime/ort.webgpu.bundle.min.mjs'); ort.env.wasm.wasmPaths = '/vendor/onnxruntime/'; ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        setStatus(ui.status, t('Loading the selected ONNX image model locally…', 'Carregando o modelo ONNX de imagem localmente…'));
        visionSession = await ort.InferenceSession.create(new Uint8Array(await model.arrayBuffer()), { executionProviders: [backend], graphOptimizationLevel: 'all' }); visionKey = key;
      }
      const names = Array.from(visionSession.inputNames || []); const rawMeta = visionInputMetadata(visionSession, names[0]); const rawShape = Array.from(rawMeta?.shape || rawMeta?.dims || rawMeta?.dimensions || []); const configuredLayout = root.querySelector('[data-vision-layout]').value;
      const layout = configuredLayout === 'auto' ? fixedTensorDimension(rawShape[1]) === 3 ? 'nchw' : fixedTensorDimension(rawShape[3]) === 3 ? 'nhwc' : null : configuredLayout;
      if (!layout) throw new Error(t('Studio vision requires a one-input, three-channel NCHW or NHWC image model with a declared channel axis.', 'A visão do estúdio exige um modelo de imagem com uma entrada, três canais NCHW ou NHWC e eixo de canais declarado.'));
      const descriptor = visionInputDescriptor(visionSession, layout, t); const { name: inputName, type: inputType, shape } = descriptor;
      const configuredWidth = Math.max(16, Math.min(2048, Number(root.querySelector('[data-vision-width]').value) || 224)); const configuredHeight = Math.max(16, Math.min(2048, Number(root.querySelector('[data-vision-height]').value) || 224));
      const width = fixedTensorDimension(shape[layout === 'nchw' ? 3 : 2]) || configuredWidth; const height = fixedTensorDimension(shape[layout === 'nchw' ? 2 : 1]) || configuredHeight;
      if (width * height > 4_194_304) throw new RangeError(t('Vision tensor exceeds the 4-megapixel studio cap.', 'O tensor de visão excede o limite de 4 megapixels.'));
      const colorOrder = root.querySelector('[data-vision-color-order]').value; const mean = parseVisionTriplet(root.querySelector('[data-vision-mean]').value, [0.485, 0.456, 0.406], 'Mean'); const std = parseVisionTriplet(root.querySelector('[data-vision-std]').value, [0.229, 0.224, 0.225], 'Standard deviation', { nonzero: true });
      const labels = root.querySelector('[data-vision-labels]').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); const added = [];
      ui.progress.hidden = false; ui.progress.max = images.length; ui.progress.value = 0;
      for (const file of images) {
        try {
          const prepared = await preprocessVisionImage(file, width, height, layout, mean, std, inputType, colorOrder); inputTensor = new ort.Tensor(inputType, prepared.data, prepared.dims); outputs = await visionSession.run({ [inputName]: inputTensor }); const entry = Object.entries(outputs)[0]; if (!entry) throw new Error(t('The ONNX model returned no outputs.', 'O modelo ONNX não retornou saídas.'));
          const [outputName, output] = entry; const values = output.getData ? await output.getData() : output.data; const outputShape = assertVisionOutput(output, values, 'classification', t);
          const predictions = topK(values, 8, labels); added.push({ id: crypto.randomUUID(), name: file.name, kind: 'vision', text: predictions.map((item) => `${item.label}: ${item.value.toFixed(5)}`).join('\n'), predictions, model: model.name, backend, preprocessing: { resize: [width, height], layout, colorOrder, mean, std }, outputName, outputShape }); ui.progress.value += 1;
        } finally { disposeOrtValues(outputs); outputs = null; try { inputTensor?.dispose?.(); } catch (_) { /* best effort */ } inputTensor = null; }
      }
      await embedNewRecords(added); added.forEach(replaceRecord); refresh(); setStatus(ui.status, t('Image model inference complete. Confirm the labels and preprocessing before use.', 'Inferência de imagem concluída. Confirme rótulos e pré-processamento antes de usar.'), 'warning');
    } catch (error) { disposeOrtValues(outputs); try { inputTensor?.dispose?.(); } catch (_) { /* best effort */ } await release(); setStatus(ui.status, error.message, 'error'); }
    finally { ui.progress.hidden = true; finishStudioAction(); }
  });
  root.querySelector('[data-speech]').addEventListener('click', async () => {
    const media = files.filter((file) => /^(?:audio|video)\//.test(file.type));
    if (!beginStudioAction()) return;
    try {
      setStatus(ui.status, t('Loading Whisper; the first run downloads model weights…', 'Carregando Whisper; a primeira execução baixa pesos…'));
      await whisper.load(root.querySelector('[data-speech-model]').value, navigator.gpu ? 'webgpu' : 'wasm'); ui.progress.hidden = false; ui.progress.max = media.length; ui.progress.value = 0;
      const added = [];
      for (const file of media) { checkedFile(file, MAX_MEDIA_BYTES, t, t('media file', 'arquivo de mídia')); const result = await whisper.transcribe(file, 'auto'); added.push({ id: crypto.randomUUID(), name: file.name, kind: 'transcript', text: result.transcript.text, cues: result.transcript.cues }); ui.progress.value += 1; }
      await embedNewRecords(added); added.forEach(replaceRecord); refresh(); setStatus(ui.status, t('Transcription complete. Review every transcript.', 'Transcrição concluída. Revise cada texto.'), 'success');
    } catch (error) { await release(); setStatus(ui.status, error.message, 'error'); }
    finally { ui.progress.hidden = true; finishStudioAction(); }
  });
  root.querySelector('[data-embeddings]').addEventListener('click', async () => {
    if (!beginStudioAction()) return;
    try {
      setStatus(ui.status, t('Loading MiniLM and rebuilding semantic vectors locally…', 'Carregando MiniLM e reconstruindo vetores semânticos localmente…')); ui.progress.hidden = false; ui.progress.max = 100; ui.progress.value = 0;
      await embeddings.load(); const vectors = await embeddings.embed(records.map((record) => record.text)); records.forEach((record, index) => { record.embedding = vectors[index]; record.embeddingModel = 'Xenova/all-MiniLM-L6-v2'; }); embeddingMode = 'minilm'; refresh(); setStatus(ui.status, t('MiniLM semantic embeddings are ready for local cosine search.', 'Embeddings semânticos MiniLM prontos para busca cosseno local.'), 'success');
    } catch (error) { await release(); setStatus(ui.status, error.message, 'error'); }
    finally { ui.progress.hidden = true; finishStudioAction(); }
  });
  root.querySelector('[data-search]').addEventListener('click', async () => {
    if (!beginStudioAction()) return;
    try {
      const query = root.querySelector('[data-query]').value.trim(); if (!query) throw new Error(t('Enter a search query.', 'Digite uma consulta.'));
      let results;
      if (embeddingMode === 'minilm') { await embeddings.load(); const [queryVector] = await embeddings.embed([query]); results = rankEmbeddingRecords(records, queryVector); }
      else results = searchEmbeddings(records, query);
      const output = ui.output; output.replaceChildren(); const list = document.createElement('ol'); list.className = 'finding-list';
      for (const result of results) { const item = document.createElement('li'); const score = document.createElement('strong'); score.textContent = result.score.toFixed(3); const text = document.createElement('span'); const name = document.createElement('b'); name.textContent = result.name; text.append(name, document.createElement('br'), document.createTextNode(result.text.slice(0, 600))); item.append(score, text); list.append(item); }
      output.append(list); showResult(root); setStatus(ui.status, embeddingMode === 'minilm' ? t('MiniLM semantic search complete on this device.', 'Busca semântica MiniLM concluída neste dispositivo.') : t('Token-hash similarity search complete. Load MiniLM for semantic embeddings.', 'Busca por similaridade de hash concluída. Carregue MiniLM para embeddings semânticos.'), embeddingMode === 'minilm' ? 'success' : 'warning');
    } catch (error) { await release(); setStatus(ui.status, error.message, 'error'); }
    finally { finishStudioAction(); }
  });
  root.querySelector('[data-release]').addEventListener('click', async () => { if (!beginStudioAction()) return; try { await release(); setStatus(ui.status, t('OCR, vision, speech, and embedding models released; project vectors remain.', 'Modelos OCR, visão, fala e embeddings liberados; os vetores do projeto permanecem.'), 'success'); } finally { finishStudioAction(); } });
}
