import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTranscriptReview, buildSearchIndex, computeVertexNormals, cosineSimilarity, createExtrusion, decodeSegmentationMask, estimateModelMemory, exportBinaryStl,
  exportGltf, exportObj, exportPly, exportSearchIndex, generateGcode, generatePlanarUvs, hashEmbedding,
  joinLayerSegments, layerInfillSegments, meshBounds, normalizeTranscript, parseGerber, parseGgufMetadata,
  parseGltf, parseIndexList, parseMesh, parseObj, parsePly, parseStl, rankEmbeddingRecords, sculptMesh, searchEmbeddings,
  searchIndex, sliceMesh, smoothMesh, subdivideMesh, topK, transcriptToSrt, transcriptToVtt,
  transformMesh, transformMeshSelection, voxelBooleanExtrusions, weldMesh
} from '../assets/tools/suite/engineering-ai-core.js';

const cube = createExtrusion({ shape: 'rectangle', width: 20, depth: 10, height: 5 });

function multiPrimitiveGltf() {
  const chunks = []; const bufferViews = []; const accessors = []; let byteLength = 0;
  const addAccessor = (typed, type, componentType, count, extra = {}) => {
    const padding = (4 - byteLength % 4) % 4;
    if (padding) { chunks.push(new Uint8Array(padding)); byteLength += padding; }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const bufferView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength });
    chunks.push(bytes); byteLength += bytes.byteLength;
    const index = accessors.length;
    accessors.push({ bufferView, componentType, count, type, ...extra });
    return index;
  };
  const triangle = (offset, { normalizedUv = false, attributes = true, indexed = true } = {}) => {
    const position = addAccessor(new Float32Array([
      offset, 0, 0, offset + 1, 0, 0, offset, 1, 0
    ]), 'VEC3', 5126, 3);
    const primitiveAttributes = { POSITION: position };
    if (attributes) {
      primitiveAttributes.NORMAL = addAccessor(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3', 5126, 3);
      primitiveAttributes.TEXCOORD_0 = normalizedUv
        ? addAccessor(new Uint16Array([0, 0, 65535, 0, 0, 65535]), 'VEC2', 5123, 3, { normalized: true })
        : addAccessor(new Float32Array([0, 0, 1, 0, 0, 1]), 'VEC2', 5126, 3);
    }
    return { attributes: primitiveAttributes, ...(indexed ? { indices: addAccessor(new Uint16Array([0, 1, 2]), 'SCALAR', 5123, 3) } : {}), mode: 4 };
  };
  const meshes = [
    { primitives: [triangle(0), triangle(10, { normalizedUv: true, indexed: false })] },
    { primitives: [triangle(20, { attributes: false })] }
  ];
  const bytes = new Uint8Array(byteLength); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return {
    asset: { version: '2.0' }, meshes, bufferViews, accessors,
    buffers: [{ byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }]
  };
}

test('Local Search builds deterministic ranked full-text results and an export manifest', () => {
  const index = buildSearchIndex([
    { name: 'alpha.md', text: 'local private browser tools local data' },
    { name: 'beta.md', text: 'remote server tool' }
  ]);
  const results = searchIndex(index, 'local browser');
  assert.equal(results[0].name, 'alpha.md');
  assert.ok(results[0].score > 0);
  const exported = exportSearchIndex(index);
  assert.equal(exported.documents.length, 2);
  assert.ok(exported.postings.local);
  assert.deepEqual(searchIndex(index, ''), []);
});

test('Local Search rejects inputs that exceed character, token, term, or posting budgets', () => {
  assert.throws(() => buildSearchIndex([{ name: 'large.txt', text: '12345' }], { maxCharacters: 4 }), /character cap/);
  assert.throws(() => buildSearchIndex([{ name: 'tokens.txt', text: 'one two three' }], { maxTokens: 2 }), /token cap/);
  assert.throws(() => buildSearchIndex([{ name: 'terms.txt', text: 'one two three' }], { maxTerms: 2 }), /term cap/);
  assert.throws(() => buildSearchIndex([
    { name: 'one.txt', text: 'alpha beta' }, { name: 'two.txt', text: 'alpha beta' }
  ], { maxPostings: 3 }), /posting cap/);
});

test('3D Model Viewer parsers normalize OBJ, binary STL, and ASCII PLY', () => {
  const obj = exportObj(cube);
  const fromObj = parseObj(obj);
  const stl = exportBinaryStl(cube);
  const fromStl = parseStl(stl);
  const ply = exportPly(cube);
  const fromPly = parsePly(ply);
  assert.equal(fromObj.faces.length, cube.faces.length);
  assert.equal(fromStl.faces.length, cube.faces.length);
  assert.equal(fromPly.faces.length, cube.faces.length);
  assert.deepEqual(meshBounds(fromObj).size.map((value) => Math.round(value)), [20, 10, 5]);
  assert.throws(() => parseMesh(new Uint8Array([1, 2, 3]), 'bad.bin'), /identify/);
});

test('3D Model Converter centers, scales, welds, and emits parseable formats', () => {
  const moved = transformMesh(cube, { scale: 2, center: true, translate: [1, 2, 3] });
  assert.deepEqual(meshBounds(moved).center.map((value) => Math.round(value)), [1, 2, 3]);
  const duplicated = { ...cube, vertices: [...cube.vertices, ...cube.vertices], faces: cube.faces };
  assert.equal(weldMesh(duplicated).vertices.length, cube.vertices.length);
  assert.doesNotThrow(() => parseObj(exportObj(moved)));
  assert.doesNotThrow(() => parsePly(exportPly(moved)));
  const gltf = exportGltf(moved);
  assert.doesNotThrow(() => parseGltf(gltf));
  assert.equal(parseGltf(gltf).faces.length, moved.faces.length);
  const linePrimitive = JSON.parse(gltf); linePrimitive.meshes[0].primitives[0].mode = 1;
  assert.throws(() => parseGltf(linePrimitive), /TRIANGLES/);
  const oversized = JSON.parse(gltf); oversized.accessors[0].count = 1_000_001;
  assert.throws(() => parseGltf(oversized), /count|cap/);
});

test('glTF parser merges every triangle primitive with aligned UVs and normals', () => {
  const fixture = multiPrimitiveGltf();
  const mesh = parseGltf(fixture);
  assert.equal(mesh.vertices.length, 9);
  assert.deepEqual(mesh.faces, [[0, 1, 2], [3, 4, 5], [6, 7, 8]]);
  assert.equal(mesh.textureVertices.length, mesh.vertices.length);
  assert.equal(mesh.vertexNormals.length, mesh.vertices.length);
  assert.deepEqual(mesh.faceUvs, mesh.faces);
  assert.deepEqual(mesh.textureVertices[1], [1, 0]);
  assert.deepEqual(mesh.textureVertices[4], [1, 0]);
  assert.deepEqual(mesh.textureVertices[8], [0, 0]);
  assert.deepEqual(mesh.vertexNormals[8], [0, 0, 1]);
  assert.deepEqual(mesh.attributeCoverage, { primitives: 3, texcoord0: 2, normals: 2 });
  assert.throws(() => parseGltf(fixture, { maxVertices: 8 }), /POSITION.*cap/);
  assert.throws(() => parseGltf(fixture, { maxFaces: 2 }), /indices.*cap|triangles/);
  const unsupportedMode = structuredClone(fixture); unsupportedMode.meshes[1].primitives[0].mode = 1;
  assert.throws(() => parseGltf(unsupportedMode), /TRIANGLES/);
  const external = structuredClone(fixture); external.buffers[0].uri = 'geometry.bin';
  assert.throws(() => parseGltf(external), /External glTF buffers/);
  const sparse = structuredClone(fixture); sparse.accessors[0].sparse = { count: 1 };
  assert.throws(() => parseGltf(sparse), /Sparse glTF POSITION/);
});

test('CAD-lite regenerates a closed parametric extrusion with exact dimensions', () => {
  const model = createExtrusion({ shape: 'polygon', width: 12, depth: 12, height: 7, sides: 6 });
  assert.equal(model.vertices.length, 12);
  assert.equal(model.faces.length, 20);
  const bounds = meshBounds(model);
  assert.equal(bounds.size[2], 7);
  assert.throws(() => createExtrusion({ width: 0 }), /positive/);
  const primary = { shape: 'rectangle', width: 12, depth: 10, height: 6 };
  const secondary = { shape: 'circle', width: 6, depth: 6, height: 6, offsetX: 4 };
  const union = voxelBooleanExtrusions(primary, secondary, 'union', 24);
  const difference = voxelBooleanExtrusions(primary, secondary, 'difference', 24);
  const intersection = voxelBooleanExtrusions(primary, secondary, 'intersection', 24);
  assert.ok(union.design.occupiedCells > difference.design.occupiedCells);
  assert.ok(intersection.faces.length > 0);
  assert.equal(union.format, 'voxel-csg');
});

test('Mesh Editor operations produce bounded editable geometry', () => {
  const divided = subdivideMesh(cube);
  assert.equal(divided.faces.length, cube.faces.length * 4);
  assert.ok(divided.vertices.length > cube.vertices.length);
  const smoothed = smoothMesh(divided, 0.2);
  const sculpted = sculptMesh(smoothed, { radius: 20, strength: 2, center: [0, 0] });
  assert.equal(sculpted.vertices.length, smoothed.vertices.length);
  assert.ok(sculpted.vertices.some((vertex, index) => vertex[2] !== smoothed.vertices[index][2]));
  assert.deepEqual(parseIndexList('0, 2, 4-6', 10), [0, 2, 4, 5, 6]);
  const selected = transformMeshSelection(cube, { vertexIndices: [0], translate: [1, 0, 0] });
  assert.equal(selected.vertices[0][0], cube.vertices[0][0] + 1);
  assert.deepEqual(selected.vertices[1], cube.vertices[1]);
  assert.equal(computeVertexNormals(cube).length, cube.vertices.length);
  assert.ok(generatePlanarUvs(cube, 'xz').every((uv) => uv.every((value) => value >= 0 && value <= 1)));
  assert.throws(() => parseIndexList('2-1', 5), /outside/);
  assert.throws(() => subdivideMesh(cube, { maxFaces: cube.faces.length * 4 - 1 }), /safety cap/);
  assert.throws(() => subdivideMesh(cube, { maxVertices: cube.vertices.length }), /vertex cap/);
  assert.throws(() => smoothMesh(cube, 0.2, { maxAdjacencyEntries: 10 }), /adjacency-work cap/);
});

test('3D Printing Slicer intersects a closed mesh and emits bounded reviewable G-code', () => {
  const slicing = sliceMesh(cube, 1);
  assert.equal(slicing.layers.length, 5);
  assert.ok(slicing.totalSegments > 0);
  assert.ok(slicing.triangleTests < slicing.layers.length * cube.faces.length);
  const paths = joinLayerSegments(slicing.layers[0].segments);
  assert.ok(paths.length > 0);
  assert.ok(layerInfillSegments(paths, 25, 0.4).length > 0);
  const gcode = generateGcode(slicing, { hotend: 205, bed: 55, printSpeed: 35, walls: 2, infill: 25, supports: true });
  assert.match(gcode, /M104 S205/);
  assert.match(gcode, /;LAYER:4/);
  assert.match(gcode, /;TYPE:WALL-OUTER/);
  assert.match(gcode, /;TYPE:INFILL/);
  assert.match(gcode, /G1 X/);
  assert.doesNotMatch(gcode, /G[01] X-/);
  const belowBed = sliceMesh(transformMesh(cube, { translate: [0, 0, -100] }), 1);
  assert.doesNotMatch(generateGcode(belowBed), /G0 Z-/);
  assert.throws(() => generateGcode(slicing, { bedWidth: 5, bedDepth: 5 }), /build volume/);
  assert.throws(() => sliceMesh(cube, 0.0001, { maxLayers: 10 }), /layers/);
  assert.throws(() => sliceMesh(cube, 1, { maxTriangleTests: 1 }), /triangle-intersection work cap/);
  assert.throws(() => joinLayerSegments(slicing.layers[0].segments, 1e-5, { maxSegments: 1 }), /segment cap/);
  assert.throws(() => layerInfillSegments(paths, 100, 0.01, false, 1_000_000, { maxIntersectionTests: 10 }), /intersection-work cap/);
  assert.throws(() => generateGcode(slicing, { maxToolpathSegments: 1 }), /G-code expansion/);
  assert.throws(() => generateGcode(slicing, { supports: true, supportDensity: 100, maxSupportProjectionTests: 10 }), /edge-test cap/);
});

test('PCB/Gerber Viewer parses apertures, trace commands, flashes, and drill hits', () => {
  const gerber = parseGerber('%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.200*%\nD10*\nX000000Y000000D02*\nX010000Y000000D01*\nX010000Y010000D03*\nM02*', 'top.gtl');
  assert.equal(gerber.format, 'RS-274X');
  assert.equal(gerber.commands.filter((item) => item.operation === 'draw').length, 1);
  assert.equal(gerber.commands.filter((item) => item.operation === 'flash').length, 1);
  assert.equal(gerber.bounds.max[0], 1);
  const modal = parseGerber('%FSLAX24Y24*%\nX000000Y000000D02*\nX010000Y000000D01*\nX010000Y010000*\nM02*', 'top.gtl');
  assert.deepEqual(modal.commands.map((item) => item.operation), ['move', 'draw', 'draw']);
  const drill = parseGerber('M48*\nMETRIC*\nT01*\nX0100Y0200*\nM30*', 'board.drl');
  assert.equal(drill.format, 'Excellon');
  assert.equal(drill.commands[0].operation, 'drill');
  const newlineDrill = parseGerber('M48\nMETRIC\nT01C0.8\nX1.25Y2.50\nX3.00Y4.00\nM30', 'board.drl');
  assert.equal(newlineDrill.commands.length, 2);
  assert.equal(newlineDrill.commands[0].tool, 1);
  assert.equal(newlineDrill.apertures.get(1).parameters[0], 0.8);
  assert.equal(newlineDrill.commands[1].x2, 3);
  const trailing = parseGerber('%FSTAX24Y24*%\nX1234Y5D02*', 'trailing.gtl');
  assert.equal(trailing.commands[0].x2, 12.34);
  assert.equal(trailing.commands[0].y2, 50);
  const incremental = parseGerber('%FSLIX24Y24*%\nX010000Y000000D02*\nX010000Y010000D01*', 'incremental.gtl');
  assert.equal(incremental.commands[1].x2, 2);
  assert.equal(incremental.commands[1].y2, 1);
  const switched = parseGerber('%FSLAX24Y24*%\nX010000Y000000D02*\nG91*\nX010000Y010000D01*', 'switched.gtl');
  assert.equal(switched.commands[1].x2, 2);
  assert.equal(switched.commands[1].y2, 1);
  const unsupported = parseGerber('%FSLAX24Y24*%\n%LPC*%\n%SRX2Y2I1J1*%\nG36*\nX0Y0D02*\nG37*', 'features.gtl');
  assert.match(unsupported.warnings.join(' '), /Region/);
  assert.match(unsupported.warnings.join(' '), /polarity/);
  assert.match(unsupported.warnings.join(' '), /Step-and-repeat/);
  assert.throws(() => parseGerber('%FSLAX24Y24*%\nX0Y0D02*\nX1Y1D01*\nX2Y2D01*', 'bounded.gtl', { commandLimit: 2 }), /safety cap/);
  const manyCommands = Array.from({ length: 70_000 }, (_, index) => `X${String(index % 1_000_000).padStart(6, '0')}Y000000D01*`).join('\n');
  const large = parseGerber(`%FSLAX24Y24*%\n${manyCommands}`, 'large.gtl');
  assert.equal(large.commands.length, 70_000);
  assert.ok(Number.isFinite(large.bounds.max[0]));
});

function ggufFixture() {
  const pieces = [];
  const u32 = (value) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); pieces.push(bytes); };
  const u64 = (value) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true); pieces.push(bytes); };
  const string = (value) => { const bytes = new TextEncoder().encode(value); u64(bytes.length); pieces.push(bytes); };
  pieces.push(new TextEncoder().encode('GGUF')); u32(3); u64(0); u64(3);
  string('general.architecture'); u32(8); string('llama');
  string('llama.block_count'); u32(4); u32(22);
  string('llama.embedding_length'); u32(4); u32(2048);
  const length = pieces.reduce((sum, item) => sum + item.length, 0); const output = new Uint8Array(length); let offset = 0;
  for (const item of pieces) { output.set(item, offset); offset += item.length; }
  return output;
}

test('Local LLM Playground parses GGUF v3 metadata and estimates bounded memory', () => {
  const result = parseGgufMetadata(ggufFixture());
  assert.equal(result.version, 3);
  assert.equal(result.metadata['general.architecture'], 'llama');
  assert.equal(result.metadata['llama.block_count'], 22);
  const memory = estimateModelMemory(512 * 1024 * 1024, 2048, 22, 2048);
  assert.ok(memory.total > memory.weights);
  assert.throws(() => parseGgufMetadata(new TextEncoder().encode('nope')), /GGUF|available/);
});

test('Local Speech-to-Text normalizes word timestamps and exports valid VTT/SRT', () => {
  const normalized = normalizeTranscript({ text: 'Hello world.', chunks: [
    { text: 'Hello', timestamp: [0, 0.5] }, { text: 'world.', timestamp: [0.5, 1] }
  ] });
  assert.equal(normalized.cues.length, 1);
  assert.equal(normalized.text, 'Hello world.');
  assert.match(transcriptToVtt(normalized.cues), /^WEBVTT/);
  assert.match(transcriptToSrt(normalized.cues), /00:00:00,000 --> 00:00:01,000/);
  const reviewed = applyTranscriptReview(normalized, 'Edited transcript.', 1.25);
  assert.equal(reviewed.cues.length, 1);
  assert.equal(reviewed.cues[0].end, 1.25);
  assert.match(transcriptToVtt(reviewed.cues), /Edited transcript/);
});

test('Computer Vision Lab ranks finite tensor outputs without inventing adapters', () => {
  assert.deepEqual(topK(new Float32Array([0.1, 0.8, -0.2, 0.4]), 2, ['a', 'b', 'c', 'd']).map((item) => item.label), ['b', 'd']);
  assert.equal(topK(new Float32Array([Number.NaN, 1]), 5).length, 1);
  const nchwMask = decodeSegmentationMask(new Float32Array([0.9, 0.2, 0.1, 0.8]), [1, 2, 1, 2], { layout: 'nchw' });
  const nhwcMask = decodeSegmentationMask(new Float32Array([0.9, 0.1, 0.2, 0.8]), [1, 1, 2, 2], { layout: 'nhwc' });
  assert.deepEqual([...nchwMask.labels], [0, 1]);
  assert.deepEqual([...nhwcMask.labels], [0, 1]);
  assert.throws(() => decodeSegmentationMask(new Float32Array(3), [1, 1, 2, 2], { layout: 'nhwc' }), /required/);
});

test('Local AI Media Studio builds normalized embeddings and ranks related records', () => {
  const records = [
    { name: 'private.txt', text: 'privacy local browser', embedding: hashEmbedding('privacy local browser') },
    { name: 'mesh.txt', text: 'triangle model geometry', embedding: hashEmbedding('triangle model geometry') }
  ];
  const results = searchEmbeddings(records, 'private local browser');
  assert.equal(results[0].name, 'private.txt');
  assert.ok(results[0].score > results[1].score);
  assert.equal(rankEmbeddingRecords(records, records[1].embedding)[0].name, 'mesh.txt');
  assert.ok(cosineSimilarity(records[0].embedding, records[0].embedding) > 0.9999);
  assert.throws(() => cosineSimilarity(new Float32Array(1), new Float32Array(2)), /equal/);
});
