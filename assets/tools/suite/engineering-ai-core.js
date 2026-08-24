const utf8 = new TextDecoder();
const latin1 = new TextDecoder('latin1');
const encoder = new TextEncoder();

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return encoder.encode(value);
  throw new TypeError('Expected text, ArrayBuffer, or a byte view.');
}

export function tokenize(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) || [];
}

export function buildSearchIndex(documents, {
  maxTerms = 250_000,
  maxCharacters = 128 * 1024 * 1024,
  maxTokens = 8_000_000,
  maxPostings = 2_000_000
} = {}) {
  if (!Array.isArray(documents) || !documents.length) throw new TypeError('At least one document is required.');
  for (const [label, value] of Object.entries({ maxTerms, maxCharacters, maxTokens, maxPostings })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
  }
  const docs = [];
  const postings = new Map();
  let characterCount = 0;
  let tokenCount = 0;
  let postingCount = 0;
  for (const [id, source] of documents.entries()) {
    const name = String(source.name || `document-${id + 1}`);
    const text = String(source.text || '');
    characterCount += text.length;
    if (characterCount > maxCharacters) throw new RangeError(`Search input exceeds the ${maxCharacters.toLocaleString()}-character cap.`);
    const frequencies = new Map();
    let documentTokenCount = 0;
    const normalized = text.normalize('NFKC').toLocaleLowerCase();
    for (const match of normalized.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)) {
      tokenCount += 1;
      documentTokenCount += 1;
      if (tokenCount > maxTokens) throw new RangeError(`Search input exceeds the ${maxTokens.toLocaleString()}-token cap.`);
      const term = match[0];
      if (!frequencies.has(term) && frequencies.size >= maxTerms) throw new RangeError(`A document exceeds the ${maxTerms.toLocaleString()}-term cap.`);
      frequencies.set(term, (frequencies.get(term) || 0) + 1);
    }
    docs.push({ id, name, text, length: Math.max(1, documentTokenCount) });
    for (const [term, count] of frequencies) {
      if (!postings.has(term) && postings.size >= maxTerms) throw new RangeError(`Search index exceeds the ${maxTerms.toLocaleString()}-term cap.`);
      postingCount += 1;
      if (postingCount > maxPostings) throw new RangeError(`Search index exceeds the ${maxPostings.toLocaleString()}-posting cap.`);
      const list = postings.get(term) || [];
      list.push([id, count]);
      postings.set(term, list);
    }
  }
  return { version: 1, docs, postings, averageLength: docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length };
}

export function searchIndex(index, query, { limit = 50 } = {}) {
  const queryText = String(query || '').trim();
  const terms = [...new Set(tokenize(queryText))];
  if (!terms.length) return [];
  const scores = new Map();
  const N = index.docs.length;
  for (const term of terms) {
    const entries = index.postings.get(term) || [];
    const idf = Math.log(1 + (N - entries.length + 0.5) / (entries.length + 0.5));
    for (const [id, frequency] of entries) {
      const doc = index.docs[id];
      const denominator = frequency + 1.2 * (0.25 + 0.75 * doc.length / Math.max(1, index.averageLength));
      scores.set(id, (scores.get(id) || 0) + idf * frequency * 2.2 / denominator);
    }
  }
  const phrase = queryText.toLocaleLowerCase();
  return [...scores].map(([id, score]) => {
    const doc = index.docs[id];
    const haystack = doc.text.toLocaleLowerCase();
    const phraseAt = phrase.includes(' ') ? haystack.indexOf(phrase) : -1;
    if (phraseAt >= 0) score += terms.length * 2;
    const first = phraseAt >= 0 ? phraseAt : Math.max(0, Math.min(...terms.map((term) => {
      const at = haystack.indexOf(term);
      return at < 0 ? haystack.length : at;
    })));
    const start = Math.max(0, first - 90);
    const end = Math.min(doc.text.length, first + 210);
    return { id, name: doc.name, score, excerpt: `${start ? '…' : ''}${doc.text.slice(start, end).replace(/\s+/g, ' ')}${end < doc.text.length ? '…' : ''}` };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.max(1, Math.min(500, limit)));
}

export function exportSearchIndex(index) {
  return {
    version: 1,
    documents: index.docs.map(({ id, name, length }) => ({ id, name, length })),
    averageLength: index.averageLength,
    postings: Object.fromEntries([...index.postings].sort(([a], [b]) => a.localeCompare(b)))
  };
}

function cleanMesh(mesh) {
  const vertices = mesh.vertices.map((vertex) => vertex.slice(0, 3).map(Number));
  const faces = mesh.faces.map((face) => face.slice(0, 3).map(Number));
  if (vertices.some((vertex) => vertex.length !== 3 || vertex.some((value) => !Number.isFinite(value)))) throw new Error('Mesh contains an invalid vertex.');
  if (faces.some((face) => face.length !== 3 || face.some((value) => !Number.isSafeInteger(value) || value < 0 || value >= vertices.length))) throw new Error('Mesh contains an invalid face index.');
  return { ...mesh, vertices, faces };
}

export function parseObj(source, { maxVertices = 1_000_000, maxFaces = 2_000_000 } = {}) {
  const vertices = [];
  const textureVertices = [];
  const faces = [];
  const faceUvs = [];
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) { if (vertices.length >= maxVertices) throw new RangeError(`OBJ exceeds ${maxVertices.toLocaleString()} vertices.`); vertices.push(parts.slice(1, 4).map(Number)); }
    else if (parts[0] === 'vt' && parts.length >= 3) { if (textureVertices.length >= maxVertices) throw new RangeError(`OBJ exceeds ${maxVertices.toLocaleString()} texture vertices.`); textureVertices.push(parts.slice(1, 3).map(Number)); }
    else if (parts[0] === 'f' && parts.length >= 4) {
      if (parts.length - 1 > maxFaces + 2) throw new RangeError('OBJ polygon fan exceeds the face safety cap.');
      const refs = parts.slice(1).map((part) => {
        const [vertex, uv] = part.split('/');
        const resolve = (value, length) => Number(value) < 0 ? length + Number(value) : Number(value) - 1;
        return { vertex: resolve(vertex, vertices.length), uv: uv ? resolve(uv, textureVertices.length) : -1 };
      });
      for (let index = 1; index < refs.length - 1; index += 1) {
        if (faces.length >= maxFaces) throw new RangeError(`OBJ exceeds ${maxFaces.toLocaleString()} triangles.`);
        const triangle = [refs[0], refs[index], refs[index + 1]];
        faces.push(triangle.map((item) => item.vertex));
        faceUvs.push(triangle.map((item) => item.uv));
      }
    }
  }
  if (!vertices.length || !faces.length) throw new Error('OBJ has no triangle geometry.');
  return cleanMesh({ format: 'obj', vertices, faces, textureVertices, faceUvs });
}

function likelyBinaryStl(bytes) {
  if (bytes.length < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  return triangles > 0 && 84 + triangles * 50 === bytes.length;
}

export function parseStl(value, { maxVertices = 1_000_000, maxFaces = 2_000_000 } = {}) {
  const bytes = bytesOf(value);
  if (likelyBinaryStl(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    if (count > maxFaces || count * 3 > maxVertices) throw new RangeError('STL triangle or expanded-vertex count exceeds the parser safety cap.');
    const vertices = [];
    const faces = [];
    for (let triangle = 0; triangle < count; triangle += 1) {
      const offset = 84 + triangle * 50 + 12;
      const face = [];
      for (let corner = 0; corner < 3; corner += 1) {
        const at = offset + corner * 12;
        face.push(vertices.length);
        vertices.push([view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)]);
      }
      faces.push(face);
    }
    return cleanMesh({ format: 'stl-binary', vertices, faces });
  }
  const source = utf8.decode(bytes);
  const vertices = [];
  const faces = [];
  let face = [];
  for (const match of source.matchAll(/\bvertex\s+([-+\deE.]+)\s+([-+\deE.]+)\s+([-+\deE.]+)/g)) {
    if (vertices.length >= maxVertices) throw new RangeError(`STL exceeds ${maxVertices.toLocaleString()} expanded vertices.`);
    face.push(vertices.length);
    vertices.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    if (face.length === 3) { if (faces.length >= maxFaces) throw new RangeError(`STL exceeds ${maxFaces.toLocaleString()} triangles.`); faces.push(face); face = []; }
  }
  if (!faces.length) throw new Error('STL has no complete facets.');
  return cleanMesh({ format: 'stl-ascii', vertices, faces });
}

export function parsePly(source, { maxVertices = 1_000_000, maxFaces = 2_000_000 } = {}) {
  const text = String(source);
  const headerEnd = text.indexOf('end_header');
  if (headerEnd < 0) throw new Error('PLY header is incomplete.');
  const header = text.slice(0, headerEnd).split(/\r?\n/);
  if (!header.some((line) => line.trim() === 'format ascii 1.0')) throw new Error('Only ASCII PLY is supported by this parser.');
  const vertexCount = Number(header.find((line) => /^element vertex\s/.test(line))?.split(/\s+/).at(-1));
  const faceCount = Number(header.find((line) => /^element face\s/.test(line))?.split(/\s+/).at(-1));
  if (!Number.isSafeInteger(vertexCount) || !Number.isSafeInteger(faceCount)) throw new Error('PLY element counts are invalid.');
  if (vertexCount > maxVertices || faceCount > maxFaces) throw new RangeError('PLY element counts exceed the parser safety cap.');
  const lines = text.slice(headerEnd + 'end_header'.length).trim().split(/\r?\n/);
  if (lines.length < vertexCount + faceCount) throw new Error('PLY body is shorter than its declared element counts.');
  const vertices = lines.slice(0, vertexCount).map((line) => line.trim().split(/\s+/).slice(0, 3).map(Number));
  const faces = [];
  for (const line of lines.slice(vertexCount, vertexCount + faceCount)) {
    const values = line.trim().split(/\s+/).map(Number);
    const count = values[0];
    if (!Number.isSafeInteger(count) || count < 3 || values.length < count + 1) throw new Error('PLY face list is invalid.');
    for (let index = 2; index < count; index += 1) { if (faces.length >= maxFaces) throw new RangeError(`PLY triangulation exceeds ${maxFaces.toLocaleString()} faces.`); faces.push([values[1], values[index], values[index + 1]]); }
  }
  if (!vertices.length || !faces.length) throw new Error('PLY has no triangle geometry.');
  return cleanMesh({ format: 'ply-ascii', vertices, faces });
}

function dataUriBytes(uri, maxBytes = 256 * 1024 * 1024) {
  if (typeof uri !== 'string' || !uri.startsWith('data:')) throw new Error('External glTF buffers are not supported; embed each buffer as a base64 data URI.');
  const match = /^data:[^,]*;base64,(.*)$/is.exec(uri);
  if (!match) throw new Error('glTF buffers must use base64-encoded data URIs.');
  if (match[1].length > Math.ceil(maxBytes / 3) * 4 + 4) throw new RangeError('Embedded glTF buffer exceeds the parser byte cap.');
  let binary;
  try { binary = atob(match[1]); } catch (_) { throw new Error('Embedded glTF buffer contains invalid base64 data.'); }
  if (binary.length > maxBytes) throw new RangeError('Embedded glTF buffer exceeds the parser byte cap.');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function parseGltf(source, {
  maxVertices = 1_000_000,
  maxFaces = 2_000_000,
  maxBufferBytes = 256 * 1024 * 1024,
  maxPrimitives = 100_000
} = {}) {
  const document = typeof source === 'string' ? JSON.parse(source) : source;
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new TypeError('glTF source must be a JSON object.');
  for (const [label, value] of Object.entries({ maxVertices, maxFaces, maxBufferBytes, maxPrimitives })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
  }
  if (!Array.isArray(document.meshes) || !document.meshes.length) throw new Error('glTF has no mesh definitions.');
  if (!Array.isArray(document.buffers) || !document.buffers.length) throw new Error('glTF has no embedded geometry buffer.');
  if (!Array.isArray(document.bufferViews) || !Array.isArray(document.accessors)) throw new Error('glTF bufferViews and accessors must be arrays.');
  let totalBufferBytes = 0;
  const buffers = document.buffers.map((buffer) => {
    const bytes = dataUriBytes(buffer?.uri, maxBufferBytes - totalBufferBytes);
    if (!Number.isSafeInteger(buffer?.byteLength) || buffer.byteLength < 1) throw new Error('glTF buffer byteLength is missing or invalid.');
    if (bytes.byteLength < buffer.byteLength) throw new RangeError('Embedded glTF buffer is shorter than its declared byteLength.');
    totalBufferBytes += bytes.byteLength;
    if (totalBufferBytes > maxBufferBytes) throw new RangeError('Embedded glTF buffers exceed the aggregate parser byte cap.');
    return { bytes, declaredLength: buffer.byteLength };
  });
  function accessor(index, { limit, expectedType, allowedComponents, semantic, allowNormalized = false, requireNormalizedIntegers = false, tightlyPacked = false }) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error(`glTF ${semantic} accessor reference is invalid.`);
    const item = document.accessors[index];
    if (!item) throw new Error(`glTF ${semantic} accessor reference is missing.`);
    if (item.sparse) throw new Error(`Sparse glTF ${semantic} accessors are not supported.`);
    if (!Number.isSafeInteger(item.bufferView) || item.bufferView < 0) throw new Error(`glTF ${semantic} accessor must reference an embedded bufferView.`);
    const view = document.bufferViews[item.bufferView];
    if (!view) throw new Error(`glTF ${semantic} bufferView reference is missing.`);
    if (!Number.isSafeInteger(view.buffer) || view.buffer < 0) throw new Error(`glTF ${semantic} buffer reference is invalid.`);
    const buffer = buffers[view.buffer]; if (!buffer) throw new Error(`glTF ${semantic} buffer reference is missing.`);
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[item.type];
    const component = {
      5120: { width: 1, read: (data, at) => data.getInt8(at), normalize: (value) => Math.max(-1, value / 127) },
      5121: { width: 1, read: (data, at) => data.getUint8(at), normalize: (value) => value / 255 },
      5122: { width: 2, read: (data, at) => data.getInt16(at, true), normalize: (value) => Math.max(-1, value / 32767) },
      5123: { width: 2, read: (data, at) => data.getUint16(at, true), normalize: (value) => value / 65535 },
      5125: { width: 4, read: (data, at) => data.getUint32(at, true), normalize: (value) => value / 4294967295 },
      5126: { width: 4, read: (data, at) => data.getFloat32(at, true), normalize: (value) => value }
    }[item.componentType];
    if (!components || !component) throw new Error(`glTF ${semantic} accessor type is unsupported.`);
    if (item.type !== expectedType) throw new Error(`glTF ${semantic} accessor must use ${expectedType}.`);
    if (!allowedComponents.includes(item.componentType)) throw new Error(`glTF ${semantic} accessor uses an unsupported component type.`);
    if (item.normalized && !allowNormalized) throw new Error(`glTF ${semantic} accessor cannot be normalized.`);
    if (item.normalized && item.componentType === 5126) throw new Error(`Float glTF ${semantic} accessors cannot be normalized.`);
    if (requireNormalizedIntegers && item.componentType !== 5126 && item.normalized !== true) throw new Error(`Integer glTF ${semantic} accessors must be normalized.`);
    if (!Number.isSafeInteger(item.count) || item.count < 1 || item.count > limit) throw new RangeError(`glTF ${semantic} accessor count exceeds the ${limit.toLocaleString()}-item cap.`);
    const viewOffset = view.byteOffset ?? 0; const viewLength = view.byteLength;
    const itemOffset = item.byteOffset ?? 0;
    if (![viewOffset, viewLength, itemOffset].every((value) => Number.isSafeInteger(value) && value >= 0) || viewLength < 1) throw new Error(`glTF ${semantic} byte offsets or lengths are invalid.`);
    const width = component.width;
    const stride = view.byteStride || components * width;
    if (!Number.isSafeInteger(stride) || stride < components * width || stride > 252 || stride % width) throw new Error(`glTF ${semantic} accessor byte stride is invalid.`);
    if (tightlyPacked && view.byteStride != null) throw new Error(`glTF ${semantic} accessor must be tightly packed.`);
    const offset = viewOffset + itemOffset;
    const viewEnd = viewOffset + viewLength;
    const accessorEnd = offset + (item.count - 1) * stride + components * width;
    if (![offset, viewEnd, accessorEnd].every(Number.isSafeInteger) || offset < viewOffset || accessorEnd > viewEnd || viewEnd > buffer.declaredLength || viewEnd > buffer.bytes.byteLength) throw new RangeError(`glTF ${semantic} accessor exceeds its embedded bufferView bounds.`);
    const dataView = new DataView(buffer.bytes.buffer, buffer.bytes.byteOffset, buffer.bytes.byteLength);
    const readValue = (row, column) => {
      const value = component.read(dataView, offset + row * stride + column * width);
      return item.normalized ? component.normalize(value) : value;
    };
    if (components === 1) return Array.from({ length: item.count }, (_, row) => readValue(row, 0));
    return Array.from({ length: item.count }, (_, row) => Array.from({ length: components }, (_, column) => readValue(row, column)));
  }
  const vertices = []; const faces = []; let textureVertices = []; let vertexNormals = [];
  let sawUvs = false; let sawNormals = false; let primitiveCount = 0; let uvPrimitiveCount = 0; let normalPrimitiveCount = 0;
  for (const mesh of document.meshes) {
    if (!Array.isArray(mesh?.primitives)) throw new Error('glTF mesh primitives are missing or invalid.');
    for (const primitive of mesh.primitives) {
      primitiveCount += 1;
      if (primitiveCount > maxPrimitives) throw new RangeError(`glTF exceeds the ${maxPrimitives.toLocaleString()}-primitive cap.`);
      if (!primitive || typeof primitive !== 'object' || !primitive.attributes || primitive.attributes.POSITION == null) throw new Error('glTF primitive has no POSITION accessor.');
      if ((primitive.mode ?? 4) !== 4) throw new Error('Only glTF TRIANGLES primitives (mode 4) are supported.');
      const baseVertex = vertices.length;
      const positions = accessor(primitive.attributes.POSITION, { limit: maxVertices - baseVertex, expectedType: 'VEC3', allowedComponents: [5126], semantic: 'POSITION' });
      if (positions.some((row) => row.some((value) => !Number.isFinite(value)))) throw new Error('glTF POSITION accessor contains a non-finite value.');
      const normals = primitive.attributes.NORMAL == null ? null : accessor(primitive.attributes.NORMAL, { limit: positions.length, expectedType: 'VEC3', allowedComponents: [5126], semantic: 'NORMAL' });
      const uvs = primitive.attributes.TEXCOORD_0 == null ? null : accessor(primitive.attributes.TEXCOORD_0, { limit: positions.length, expectedType: 'VEC2', allowedComponents: [5121, 5123, 5126], semantic: 'TEXCOORD_0', allowNormalized: true, requireNormalizedIntegers: true });
      if (normals && normals.length !== positions.length) throw new Error('glTF NORMAL accessor count must match POSITION.');
      if (uvs && uvs.length !== positions.length) throw new Error('glTF TEXCOORD_0 accessor count must match POSITION.');
      if (normals?.some((row) => row.some((value) => !Number.isFinite(value))) || uvs?.some((row) => row.some((value) => !Number.isFinite(value)))) throw new Error('glTF vertex attributes contain a non-finite value.');
      const remainingIndices = (maxFaces - faces.length) * 3;
      let rawIndices;
      if (primitive.indices == null) {
        if (positions.length > remainingIndices) throw new RangeError(`glTF exceeds ${maxFaces.toLocaleString()} triangles.`);
        rawIndices = positions.map((_, index) => index);
      } else rawIndices = accessor(primitive.indices, { limit: remainingIndices, expectedType: 'SCALAR', allowedComponents: [5121, 5123, 5125], semantic: 'indices', tightlyPacked: true });
      if (!rawIndices.length || rawIndices.length % 3) throw new Error('glTF triangle index count must be a non-zero multiple of three.');
      if (rawIndices.length > remainingIndices) throw new RangeError(`glTF exceeds ${maxFaces.toLocaleString()} triangles.`);
      for (const index of rawIndices) if (!Number.isSafeInteger(index) || index < 0 || index >= positions.length) throw new RangeError('glTF primitive contains an out-of-range vertex index.');
      for (const position of positions) vertices.push(position);
      if (uvs) {
        if (!sawUvs) { for (let index = 0; index < baseVertex; index += 1) textureVertices.push([0, 0]); sawUvs = true; }
        for (const uv of uvs) textureVertices.push(uv);
        uvPrimitiveCount += 1;
      } else if (sawUvs) for (let index = 0; index < positions.length; index += 1) textureVertices.push([0, 0]);
      if (normals) {
        if (!sawNormals) { for (let index = 0; index < baseVertex; index += 1) vertexNormals.push([0, 0, 1]); sawNormals = true; }
        for (const item of normals) vertexNormals.push(item);
        normalPrimitiveCount += 1;
      } else if (sawNormals) for (let index = 0; index < positions.length; index += 1) vertexNormals.push([0, 0, 1]);
      for (let index = 0; index < rawIndices.length; index += 3) faces.push(rawIndices.slice(index, index + 3).map((vertex) => vertex + baseVertex));
    }
  }
  if (!primitiveCount || !faces.length) throw new Error('glTF has no supported triangle geometry.');
  const mesh = {
    format: 'gltf', vertices, faces,
    attributeCoverage: { primitives: primitiveCount, texcoord0: uvPrimitiveCount, normals: normalPrimitiveCount }
  };
  if (sawUvs) { mesh.textureVertices = textureVertices; mesh.faceUvs = faces.map((face) => [...face]); }
  if (sawNormals) mesh.vertexNormals = vertexNormals;
  return cleanMesh(mesh);
}

export function parseMesh(value, filename = 'model.obj', options = {}) {
  const bytes = bytesOf(value);
  const lower = String(filename).toLocaleLowerCase();
  if (lower.endsWith('.stl')) return parseStl(bytes, options);
  const text = utf8.decode(bytes);
  if (lower.endsWith('.obj')) return parseObj(text, options);
  if (lower.endsWith('.ply')) return parsePly(text, options);
  if (lower.endsWith('.gltf')) return parseGltf(text, options);
  if (/^\s*solid\b/i.test(text)) return parseStl(bytes, options);
  if (/^\s*ply\b/.test(text)) return parsePly(text, options);
  if (/^\s*\{/.test(text) && text.includes('"asset"')) return parseGltf(text, options);
  if (/^\s*(?:#.*\n)*v\s/m.test(text)) return parseObj(text, options);
  throw new Error('Could not identify a supported STL, OBJ, PLY, or embedded glTF mesh.');
}

export function meshBounds(mesh) {
  if (!mesh.vertices.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  const min = [...mesh.vertices[0]];
  const max = [...mesh.vertices[0]];
  for (const vertex of mesh.vertices) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], vertex[axis]); max[axis] = Math.max(max[axis], vertex[axis]); }
  const size = min.map((value, axis) => max[axis] - value);
  return { min, max, size, center: min.map((value, axis) => (value + max[axis]) / 2) };
}

function normal(a, b, c) {
  const ab = b.map((value, axis) => value - a[axis]);
  const ac = c.map((value, axis) => value - a[axis]);
  const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const length = Math.hypot(...n) || 1;
  return n.map((value) => value / length);
}

export function meshSurfaceArea(mesh) {
  return mesh.faces.reduce((sum, face) => {
    const [a, b, c] = face.map((index) => mesh.vertices[index]);
    const ab = b.map((value, axis) => value - a[axis]);
    const ac = c.map((value, axis) => value - a[axis]);
    return sum + Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) / 2;
  }, 0);
}

export function transformMesh(mesh, { scale = 1, translate = [0, 0, 0], center = false, mirrorX = false } = {}) {
  const origin = center ? meshBounds(mesh).center : [0, 0, 0];
  const sx = mirrorX ? -scale : scale;
  const vertices = mesh.vertices.map((vertex) => [
    (vertex[0] - origin[0]) * sx + translate[0],
    (vertex[1] - origin[1]) * scale + translate[1],
    (vertex[2] - origin[2]) * scale + translate[2]
  ]);
  const faces = mirrorX ? mesh.faces.map(([a, b, c]) => [a, c, b]) : mesh.faces.map((face) => [...face]);
  return { ...mesh, vertices, faces };
}

export function transformMeshSelection(mesh, { vertexIndices = [], faceIndices = [], scale = 1, translate = [0, 0, 0] } = {}) {
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Selection scale must be positive.');
  if (!Array.isArray(translate) || translate.length !== 3 || translate.some((value) => !Number.isFinite(Number(value)))) throw new RangeError('Selection translation must contain three finite values.');
  const selected = new Set(vertexIndices.map(Number));
  for (const faceIndex of faceIndices.map(Number)) {
    if (!Number.isSafeInteger(faceIndex) || faceIndex < 0 || faceIndex >= mesh.faces.length) throw new RangeError('Selected face index is outside the mesh.');
    mesh.faces[faceIndex].forEach((index) => selected.add(index));
  }
  if (!selected.size) throw new RangeError('Select at least one vertex or face.');
  for (const index of selected) if (!Number.isSafeInteger(index) || index < 0 || index >= mesh.vertices.length) throw new RangeError('Selected vertex index is outside the mesh.');
  const center = [0, 1, 2].map((axis) => [...selected].reduce((sum, index) => sum + mesh.vertices[index][axis], 0) / selected.size);
  const vertices = mesh.vertices.map((vertex, index) => selected.has(index)
    ? vertex.map((value, axis) => (value - center[axis]) * scale + center[axis] + Number(translate[axis]))
    : [...vertex]);
  return { ...mesh, vertices, faces: mesh.faces.map((face) => [...face]), selectedVertices: [...selected].sort((a, b) => a - b) };
}

export function computeVertexNormals(mesh) {
  const sums = Array.from({ length: mesh.vertices.length }, () => [0, 0, 0]);
  for (const face of mesh.faces) {
    const faceNormal = normal(...face.map((index) => mesh.vertices[index]));
    for (const index of face) for (let axis = 0; axis < 3; axis += 1) sums[index][axis] += faceNormal[axis];
  }
  return sums.map((sum) => {
    const length = Math.hypot(...sum) || 1;
    return sum.map((value) => value / length);
  });
}

export function generatePlanarUvs(mesh, projection = 'xy') {
  const axes = { xy: [0, 1], xz: [0, 2], yz: [1, 2] }[projection];
  if (!axes) throw new Error('UV projection must be xy, xz, or yz.');
  const bounds = meshBounds(mesh);
  const [uAxis, vAxis] = axes;
  const uSize = bounds.size[uAxis] || 1;
  const vSize = bounds.size[vAxis] || 1;
  return mesh.vertices.map((vertex) => [
    (vertex[uAxis] - bounds.min[uAxis]) / uSize,
    (vertex[vAxis] - bounds.min[vAxis]) / vSize
  ]);
}

export function parseIndexList(source, maximum, { maxItems = 100_000 } = {}) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError('Index maximum must be a positive integer.');
  const result = new Set();
  for (const token of String(source).split(/[\s,;]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) throw new Error(`Invalid index token: ${token}`);
    const start = Number(match[1]); const end = Number(match[2] ?? match[1]);
    if (start > end || start < 0 || end >= maximum) throw new RangeError(`Index range ${token} is outside 0–${maximum - 1}.`);
    if (end - start + 1 + result.size > maxItems) throw new RangeError(`Selection exceeds ${maxItems.toLocaleString()} indices.`);
    for (let index = start; index <= end; index += 1) result.add(index);
  }
  if (!result.size) throw new Error('Enter at least one index.');
  return [...result].sort((a, b) => a - b);
}

export function weldMesh(mesh, tolerance = 1e-6) {
  const map = new Map();
  const vertices = [];
  const remap = [];
  for (const vertex of mesh.vertices) {
    const key = vertex.map((value) => Math.round(value / tolerance)).join(':');
    if (!map.has(key)) { map.set(key, vertices.length); vertices.push([...vertex]); }
    remap.push(map.get(key));
  }
  const seen = new Set();
  const faces = [];
  for (const source of mesh.faces) {
    const face = source.map((index) => remap[index]);
    if (new Set(face).size < 3) continue;
    const key = [...face].sort((a, b) => a - b).join(':');
    if (!seen.has(key)) { seen.add(key); faces.push(face); }
  }
  return { ...mesh, vertices, faces };
}

export function exportObj(mesh) {
  const vertices = mesh.vertices.map((vertex) => `v ${vertex.map((value) => Number(value.toFixed(7))).join(' ')}`);
  const textureVertices = mesh.textureVertices?.length === mesh.vertices.length ? mesh.textureVertices : generatePlanarUvs(mesh, 'xy');
  const vertexNormals = mesh.vertexNormals?.length === mesh.vertices.length ? mesh.vertexNormals : computeVertexNormals(mesh);
  const uvs = textureVertices.map((uv) => `vt ${Number(uv[0].toFixed(7))} ${Number(uv[1].toFixed(7))}`);
  const normals = vertexNormals.map((item) => `vn ${item.map((value) => Number(value.toFixed(7))).join(' ')}`);
  const faces = mesh.faces.map((face) => `f ${face.map((index) => `${index + 1}/${index + 1}/${index + 1}`).join(' ')}`);
  return `${vertices.join('\n')}\n${uvs.join('\n')}\n${normals.join('\n')}\n${faces.join('\n')}\n`;
}

export function exportPly(mesh) {
  return `ply\nformat ascii 1.0\nelement vertex ${mesh.vertices.length}\nproperty float x\nproperty float y\nproperty float z\nelement face ${mesh.faces.length}\nproperty list uchar int vertex_indices\nend_header\n${mesh.vertices.map((vertex) => vertex.join(' ')).join('\n')}\n${mesh.faces.map((face) => `3 ${face.join(' ')}`).join('\n')}\n`;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

export function exportGltf(mesh) {
  if (!mesh.vertices.length || !mesh.faces.length) throw new Error('Mesh has no geometry to export.');
  const positions = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach((vertex, index) => positions.set(vertex, index * 3));
  const indices = new Uint32Array(mesh.faces.length * 3);
  mesh.faces.forEach((face, index) => indices.set(face, index * 3));
  const positionBytes = new Uint8Array(positions.buffer);
  const indexOffset = Math.ceil(positionBytes.byteLength / 4) * 4;
  const buffer = new Uint8Array(indexOffset + indices.byteLength);
  buffer.set(positionBytes);
  buffer.set(new Uint8Array(indices.buffer), indexOffset);
  const bounds = meshBounds(mesh);
  return JSON.stringify({
    asset: { version: '2.0', generator: 'castrom13.dev local mesh converter' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    buffers: [{ byteLength: buffer.byteLength, uri: `data:application/octet-stream;base64,${bytesToBase64(buffer)}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.byteLength, target: 34962 },
      { buffer: 0, byteOffset: indexOffset, byteLength: indices.byteLength, target: 34963 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: mesh.vertices.length, type: 'VEC3', min: bounds.min, max: bounds.max },
      { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR', min: [0], max: [mesh.vertices.length - 1] }
    ]
  }, null, 2);
}

export function exportBinaryStl(mesh, name = 'castrom13-lab') {
  const buffer = new ArrayBuffer(84 + mesh.faces.length * 50);
  const bytes = new Uint8Array(buffer);
  bytes.set(encoder.encode(name).subarray(0, 80));
  const view = new DataView(buffer);
  view.setUint32(80, mesh.faces.length, true);
  mesh.faces.forEach((face, index) => {
    const vertices = face.map((item) => mesh.vertices[item]);
    const n = normal(...vertices);
    let offset = 84 + index * 50;
    for (const value of n) { view.setFloat32(offset, value, true); offset += 4; }
    for (const vertex of vertices) for (const value of vertex) { view.setFloat32(offset, value, true); offset += 4; }
    view.setUint16(offset, 0, true);
  });
  return new Uint8Array(buffer);
}

export function createExtrusion({ shape = 'rectangle', width = 40, depth = 30, height = 10, sides = 32 } = {}) {
  if (![width, depth, height].every((value) => Number.isFinite(value) && value > 0)) throw new RangeError('Dimensions must be positive.');
  sides = Math.max(3, Math.min(256, Math.round(sides)));
  let profile;
  if (shape === 'rectangle') profile = [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]];
  else profile = Array.from({ length: sides }, (_, index) => {
    const angle = index / sides * Math.PI * 2;
    return [Math.cos(angle) * width / 2, Math.sin(angle) * depth / 2];
  });
  const vertices = [...profile.map(([x, y]) => [x, y, 0]), ...profile.map(([x, y]) => [x, y, height])];
  const faces = [];
  for (let index = 1; index < profile.length - 1; index += 1) {
    faces.push([0, index + 1, index]);
    faces.push([profile.length, profile.length + index, profile.length + index + 1]);
  }
  for (let index = 0; index < profile.length; index += 1) {
    const next = (index + 1) % profile.length;
    faces.push([index, next, profile.length + next], [index, profile.length + next, profile.length + index]);
  }
  return cleanMesh({ format: 'parametric', vertices, faces, design: { shape, width, depth, height, sides } });
}

function primitiveBounds(primitive) {
  const x = Number(primitive.offsetX) || 0;
  const y = Number(primitive.offsetY) || 0;
  const z = Number(primitive.offsetZ) || 0;
  return { min: [x - primitive.width / 2, y - primitive.depth / 2, z], max: [x + primitive.width / 2, y + primitive.depth / 2, z + primitive.height] };
}

function insidePrimitive(point, primitive) {
  const x = point[0] - (Number(primitive.offsetX) || 0);
  const y = point[1] - (Number(primitive.offsetY) || 0);
  const z = point[2] - (Number(primitive.offsetZ) || 0);
  if (z < 0 || z > primitive.height) return false;
  if (primitive.shape === 'rectangle') return Math.abs(x) <= primitive.width / 2 && Math.abs(y) <= primitive.depth / 2;
  if (primitive.shape === 'circle') return (x / (primitive.width / 2)) ** 2 + (y / (primitive.depth / 2)) ** 2 <= 1;
  const sides = Math.max(3, Math.min(256, Math.round(primitive.sides || 6)));
  const profile = Array.from({ length: sides }, (_, index) => {
    const angle = index / sides * Math.PI * 2;
    return [Math.cos(angle) * primitive.width / 2, Math.sin(angle) * primitive.depth / 2];
  });
  let inside = false;
  for (let current = 0, previous = profile.length - 1; current < profile.length; previous = current++) {
    const a = profile[current]; const b = profile[previous];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function voxelBooleanExtrusions(primary, secondary, operation = 'union', resolution = 40) {
  const validate = (item) => {
    if (!item || !['rectangle', 'circle', 'polygon'].includes(item.shape)) throw new Error('Boolean solids require a rectangle, circle, or polygon profile.');
    if (![item.width, item.depth, item.height].every((value) => Number.isFinite(Number(value)) && Number(value) > 0)) throw new RangeError('Boolean solid dimensions must be positive.');
  };
  validate(primary); validate(secondary);
  if (!['union', 'difference', 'intersection'].includes(operation)) throw new Error('Boolean operation must be union, difference, or intersection.');
  resolution = Math.max(12, Math.min(96, Math.round(Number(resolution) || 40)));
  const a = primitiveBounds(primary); const b = primitiveBounds(secondary);
  const bounds = operation === 'difference' ? a : operation === 'intersection'
    ? { min: a.min.map((value, axis) => Math.max(value, b.min[axis])), max: a.max.map((value, axis) => Math.min(value, b.max[axis])) }
    : { min: a.min.map((value, axis) => Math.min(value, b.min[axis])), max: a.max.map((value, axis) => Math.max(value, b.max[axis])) };
  const span = bounds.min.map((value, axis) => bounds.max[axis] - value);
  if (span.some((value) => value <= 0)) throw new Error('The selected boolean operation produces no overlapping volume.');
  const cell = Math.max(...span) / resolution;
  const counts = span.map((value) => Math.max(1, Math.ceil(value / cell)));
  const [nx, ny, nz] = counts;
  const total = nx * ny * nz;
  if (!Number.isSafeInteger(total) || total > 900_000) throw new RangeError('Boolean resolution exceeds the 900,000-cell safety cap.');
  const occupied = new Uint8Array(total);
  const at = (x, y, z) => (z * ny + y) * nx + x;
  let occupiedCount = 0;
  for (let z = 0; z < nz; z += 1) for (let y = 0; y < ny; y += 1) for (let x = 0; x < nx; x += 1) {
    const point = [bounds.min[0] + (x + 0.5) * span[0] / nx, bounds.min[1] + (y + 0.5) * span[1] / ny, bounds.min[2] + (z + 0.5) * span[2] / nz];
    const inA = insidePrimitive(point, primary); const inB = insidePrimitive(point, secondary);
    const keep = operation === 'union' ? inA || inB : operation === 'difference' ? inA && !inB : inA && inB;
    if (keep) { occupied[at(x, y, z)] = 1; occupiedCount += 1; }
  }
  if (!occupiedCount) throw new Error('The selected boolean operation produced an empty solid at this resolution.');
  const vertices = []; const faces = []; const vertexMap = new Map();
  const vertex = (x, y, z) => {
    const key = `${x}:${y}:${z}`;
    if (!vertexMap.has(key)) {
      vertexMap.set(key, vertices.length);
      vertices.push([bounds.min[0] + x * span[0] / nx, bounds.min[1] + y * span[1] / ny, bounds.min[2] + z * span[2] / nz]);
    }
    return vertexMap.get(key);
  };
  const addQuad = (corners) => {
    const indices = corners.map(([x, y, z]) => vertex(x, y, z));
    faces.push([indices[0], indices[1], indices[2]], [indices[0], indices[2], indices[3]]);
    if (faces.length > 2_000_000) throw new RangeError('Boolean surface exceeds the triangle safety cap.');
  };
  const has = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && occupied[at(x, y, z)];
  for (let z = 0; z < nz; z += 1) for (let y = 0; y < ny; y += 1) for (let x = 0; x < nx; x += 1) if (has(x, y, z)) {
    if (!has(x - 1, y, z)) addQuad([[x, y, z], [x, y, z + 1], [x, y + 1, z + 1], [x, y + 1, z]]);
    if (!has(x + 1, y, z)) addQuad([[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]]);
    if (!has(x, y - 1, z)) addQuad([[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]]);
    if (!has(x, y + 1, z)) addQuad([[x, y + 1, z], [x, y + 1, z + 1], [x + 1, y + 1, z + 1], [x + 1, y + 1, z]]);
    if (!has(x, y, z - 1)) addQuad([[x, y, z], [x, y + 1, z], [x + 1, y + 1, z], [x + 1, y, z]]);
    if (!has(x, y, z + 1)) addQuad([[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]]);
  }
  return cleanMesh({ format: 'voxel-csg', vertices, faces, design: { operation, resolution, occupiedCells: occupiedCount, primary, secondary } });
}

export function subdivideMesh(mesh, { maxVertices = 1_000_000, maxFaces = 2_000_000, maxEdgeEntries = 3_000_000 } = {}) {
  for (const [label, value] of Object.entries({ maxVertices, maxFaces, maxEdgeEntries })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
  }
  if (mesh.vertices.length > maxVertices || mesh.faces.length > Math.floor(maxFaces / 4)) throw new RangeError('Subdivision would exceed the mesh vertex or triangle safety cap.');
  if (mesh.faces.length > Math.floor(maxEdgeEntries / 3)) throw new RangeError('Subdivision would exceed the edge-work safety cap.');
  const vertices = mesh.vertices.map((vertex) => [...vertex]);
  const edges = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!edges.has(key)) {
      if (vertices.length >= maxVertices) throw new RangeError(`Subdivision exceeds the ${maxVertices.toLocaleString()}-vertex cap.`);
      edges.set(key, vertices.length); vertices.push(vertices[a].map((value, axis) => (value + vertices[b][axis]) / 2));
    }
    return edges.get(key);
  };
  const faces = [];
  for (const [a, b, c] of mesh.faces) {
    const ab = midpoint(a, b); const bc = midpoint(b, c); const ca = midpoint(c, a);
    faces.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
  }
  return { ...mesh, vertices, faces };
}

export function smoothMesh(mesh, strength = 0.35, { maxAdjacencyEntries = 6_000_000 } = {}) {
  if (!Number.isFinite(strength)) throw new RangeError('Smoothing strength must be finite.');
  if (!Number.isSafeInteger(maxAdjacencyEntries) || maxAdjacencyEntries < 1) throw new RangeError('maxAdjacencyEntries must be a positive safe integer.');
  if (mesh.faces.length > Math.floor(maxAdjacencyEntries / 6)) throw new RangeError(`Smoothing would exceed the ${maxAdjacencyEntries.toLocaleString()}-adjacency-work cap.`);
  const neighbors = Array.from({ length: mesh.vertices.length }, () => new Set());
  for (const face of mesh.faces) for (let i = 0; i < 3; i += 1) { neighbors[face[i]].add(face[(i + 1) % 3]); neighbors[face[i]].add(face[(i + 2) % 3]); }
  const vertices = mesh.vertices.map((vertex, index) => {
    if (!neighbors[index].size) return [...vertex];
    const average = [0, 1, 2].map((axis) => [...neighbors[index]].reduce((sum, neighbor) => sum + mesh.vertices[neighbor][axis], 0) / neighbors[index].size);
    return vertex.map((value, axis) => value * (1 - strength) + average[axis] * strength);
  });
  return { ...mesh, vertices };
}

export function sculptMesh(mesh, { radius = 10, strength = 1, center = [0, 0] } = {}) {
  const vertices = mesh.vertices.map((vertex) => {
    const distance = Math.hypot(vertex[0] - center[0], vertex[1] - center[1]);
    if (distance >= radius) return [...vertex];
    const falloff = (1 - distance / radius) ** 2;
    return [vertex[0], vertex[1], vertex[2] + strength * falloff];
  });
  return { ...mesh, vertices };
}

function intersectTriangleAtZ(vertices, z) {
  const points = [];
  for (const [a, b] of [[vertices[0], vertices[1]], [vertices[1], vertices[2]], [vertices[2], vertices[0]]]) {
    const da = a[2] - z; const db = b[2] - z;
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const ratio = da / (da - db);
      points.push([a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio]);
    } else if (Math.abs(da) < 1e-9 && Math.abs(db) >= 1e-9) points.push([a[0], a[1]]);
  }
  if (points.length < 2) return null;
  return [points[0], points[1]];
}

export function sliceMesh(mesh, layerHeight = 0.2, { maxLayers = 2_000, maxSegments = 2_000_000, maxTriangleTests = 20_000_000 } = {}) {
  if (!Number.isFinite(layerHeight) || layerHeight <= 0) throw new RangeError('Layer height must be positive.');
  for (const [label, value] of Object.entries({ maxLayers, maxSegments, maxTriangleTests })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
  }
  const bounds = meshBounds(mesh);
  const count = Math.ceil(bounds.size[2] / layerHeight);
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Slice layer count is outside the supported numeric range.');
  if (count > maxLayers) throw new RangeError(`Slice would exceed ${maxLayers} layers.`);
  const layers = Array.from({ length: count }, (_, index) => ({
    index,
    z: bounds.min[2] + Math.min(bounds.size[2], (index + 0.5) * layerHeight),
    segments: []
  }));
  let totalSegments = 0;
  let triangleTests = 0;
  for (const face of mesh.faces) {
    const faceVertices = face.map((vertex) => mesh.vertices[vertex]);
    const minZ = Math.min(...faceVertices.map((vertex) => vertex[2]));
    const maxZ = Math.max(...faceVertices.map((vertex) => vertex[2]));
    const firstLayer = Math.max(0, Math.ceil((minZ - bounds.min[2]) / layerHeight - 0.5 - 1e-9));
    const lastLayer = Math.min(count - 1, Math.floor((maxZ - bounds.min[2]) / layerHeight - 0.5 + 1e-9));
    if (lastLayer < firstLayer) continue;
    const faceTests = lastLayer - firstLayer + 1;
    if (triangleTests > maxTriangleTests - faceTests) throw new RangeError(`Slice would exceed the ${maxTriangleTests.toLocaleString()} triangle-intersection work cap.`);
    triangleTests += faceTests;
    for (let index = firstLayer; index <= lastLayer; index += 1) {
      const segment = intersectTriangleAtZ(faceVertices, layers[index].z);
      if (!segment) continue;
      layers[index].segments.push(segment);
      totalSegments += 1;
      if (totalSegments > maxSegments) throw new RangeError(`Slice would exceed ${maxSegments} path segments.`);
    }
  }
  return { bounds, layerHeight, layers, totalSegments, triangleTests };
}

export function joinLayerSegments(segments, tolerance = 1e-5, { maxSegments = 2_000_000 } = {}) {
  if (!Array.isArray(segments)) throw new TypeError('Layer segments must be an array.');
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError('Layer join tolerance must be positive.');
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 1) throw new RangeError('maxSegments must be a positive safe integer.');
  if (segments.length > maxSegments) throw new RangeError(`Layer join exceeds the ${maxSegments.toLocaleString()}-segment cap.`);
  const pointMap = new Map(); const edges = []; const adjacency = new Map();
  const keyFor = (point) => point.map((value) => Math.round(value / tolerance)).join(':');
  const remember = (point) => { const key = keyFor(point); if (!pointMap.has(key)) pointMap.set(key, [...point]); return key; };
  const connect = (key, edgeIndex) => { if (!adjacency.has(key)) adjacency.set(key, []); adjacency.get(key).push(edgeIndex); };
  for (const segment of segments) {
    const a = remember(segment[0]); const b = remember(segment[1]);
    if (a === b) continue;
    const index = edges.length; edges.push({ a, b }); connect(a, index); connect(b, index);
  }
  const used = new Uint8Array(edges.length); const paths = [];
  for (let seed = 0; seed < edges.length; seed += 1) {
    if (used[seed]) continue;
    const path = []; const first = edges[seed].a; let current = first; let edgeIndex = seed;
    for (let guard = 0; guard <= edges.length; guard += 1) {
      if (used[edgeIndex]) break;
      used[edgeIndex] = 1; path.push(pointMap.get(current));
      const edge = edges[edgeIndex]; current = edge.a === current ? edge.b : edge.a;
      if (current === first) { path.push(pointMap.get(first)); break; }
      const next = (adjacency.get(current) || []).find((candidate) => !used[candidate]);
      if (next == null) { path.push(pointMap.get(current)); break; }
      edgeIndex = next;
    }
    if (path.length >= 2) paths.push(path);
  }
  return paths.sort((a, b) => b.length - a.length);
}

function pointInsidePaths(point, paths) {
  let inside = false;
  for (const path of paths) for (let index = 0, previous = path.length - 1; index < path.length; previous = index++) {
    const a = path[index]; const b = path[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function pathsBounds(paths, maxPoints = Number.MAX_SAFE_INTEGER) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity; let pointCount = 0;
  for (const path of paths) for (const point of path) {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) throw new Error('Infill paths contain an invalid point.');
    pointCount += 1;
    if (pointCount > maxPoints) throw new RangeError(`Infill exceeds the ${maxPoints.toLocaleString()}-path-point cap.`);
    minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]); maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
  }
  if (!pointCount) return null;
  return { min: [minX, minY], max: [maxX, maxY], pointCount };
}

export function layerInfillSegments(paths, density = 20, lineWidth = 0.4, vertical = false, maxSegments = 1_000_000, { maxPathPoints = 2_000_000, maxIntersectionTests = 20_000_000 } = {}) {
  if (!Array.isArray(paths)) throw new TypeError('Infill paths must be an array.');
  for (const [label, value] of Object.entries({ maxSegments, maxPathPoints, maxIntersectionTests })) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
  density = Math.max(0, Math.min(100, Number(density) || 0));
  if (!paths.length || density <= 0) return [];
  if (!Number.isFinite(lineWidth) || lineWidth <= 0) throw new RangeError('Infill line width must be positive.');
  const bounds = pathsBounds(paths, maxPathPoints); const spacing = Math.max(lineWidth, lineWidth / Math.max(0.01, density / 100)); const segments = [];
  if (!bounds) return [];
  const low = vertical ? bounds.min[0] : bounds.min[1]; const high = vertical ? bounds.max[0] : bounds.max[1];
  const scanCount = Math.max(0, Math.ceil((high - low) / spacing));
  const edgeCount = paths.reduce((sum, path) => sum + Math.max(0, path.length - 1), 0);
  if (!edgeCount || !scanCount) return [];
  if (!Number.isSafeInteger(scanCount)) throw new RangeError('Infill scanline count exceeds the supported numeric range.');
  if (edgeCount && scanCount > Math.floor(maxIntersectionTests / edgeCount)) throw new RangeError(`Infill would exceed the ${maxIntersectionTests.toLocaleString()} intersection-work cap.`);
  for (let scan = low + spacing / 2; scan < high; scan += spacing) {
    const intersections = [];
    for (const path of paths) for (let index = 1; index < path.length; index += 1) {
      const a = path[index - 1]; const b = path[index];
      const aPrimary = vertical ? a[0] : a[1]; const bPrimary = vertical ? b[0] : b[1];
      if ((aPrimary > scan) === (bPrimary > scan)) continue;
      const ratio = (scan - aPrimary) / (bPrimary - aPrimary);
      intersections.push((vertical ? a[1] : a[0]) + ((vertical ? b[1] : b[0]) - (vertical ? a[1] : a[0])) * ratio);
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const start = vertical ? [scan, intersections[index]] : [intersections[index], scan];
      const end = vertical ? [scan, intersections[index + 1]] : [intersections[index + 1], scan];
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) >= lineWidth) {
        segments.push([start, end]);
        if (segments.length > maxSegments) throw new RangeError(`Infill exceeds the ${maxSegments.toLocaleString()}-segment cap.`);
      }
    }
  }
  return segments;
}

function insetPath(path, distance) {
  if (!distance) return path;
  const points = path.slice(0, path.length > 2 && path[0][0] === path.at(-1)[0] && path[0][1] === path.at(-1)[1] ? -1 : undefined);
  const center = [0, 1].map((axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
  const inset = points.map((point) => {
    const radius = Math.hypot(point[0] - center[0], point[1] - center[1]);
    const ratio = radius ? Math.max(0, (radius - distance) / radius) : 0;
    return [center[0] + (point[0] - center[0]) * ratio, center[1] + (point[1] - center[1]) * ratio];
  });
  if (inset.length) inset.push([...inset[0]]);
  return inset;
}

export function generateGcode(slicing, {
  nozzle = 0.4, filament = 1.75, lineWidth = nozzle, layerHeight = slicing.layerHeight,
  printSpeed = 40, travelSpeed = 120, hotend = 200, bed = 60, infill = 20, walls = 2,
  supports = false, supportDensity = 12, bedWidth = 220, bedDepth = 220, buildHeight = 250,
  maxSupportSegments = 500_000, maxSupportProjectionTests = 5_000_000, maxToolpathSegments = 2_000_000
} = {}) {
  if (![nozzle, filament, lineWidth, layerHeight, printSpeed, travelSpeed, bedWidth, bedDepth, buildHeight].every((value) => Number.isFinite(Number(value)) && Number(value) > 0)) throw new RangeError('Slicer dimensions and speeds must be positive.');
  for (const [label, value] of Object.entries({ maxSupportSegments, maxSupportProjectionTests, maxToolpathSegments })) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer.`);
  walls = Math.max(1, Math.min(8, Math.round(Number(walls) || 2)));
  const modelWidth = slicing.bounds.size[0]; const modelDepth = slicing.bounds.size[1]; const modelHeight = slicing.bounds.size[2];
  if (modelWidth > bedWidth || modelDepth > bedDepth || modelHeight > buildHeight) throw new RangeError(`Model bounds ${modelWidth.toFixed(2)} × ${modelDepth.toFixed(2)} × ${modelHeight.toFixed(2)} exceed the configured build volume.`);
  const shift = [(bedWidth - modelWidth) / 2 - slicing.bounds.min[0], (bedDepth - modelDepth) / 2 - slicing.bounds.min[1], -slicing.bounds.min[2]];
  const filamentArea = Math.PI * (filament / 2) ** 2;
  const extrusionPerMm = lineWidth * layerHeight / filamentArea;
  let e = 0;
  const lines = ['; castrom13.dev experimental local slicer', `; shifted by X${shift[0].toFixed(3)} Y${shift[1].toFixed(3)} Z${shift[2].toFixed(3)} inside ${bedWidth} × ${bedDepth} × ${buildHeight} mm`, 'G21', 'G90', 'M82', `M104 S${hotend}`, `M140 S${bed}`, 'G28', `M109 S${hotend}`, `M190 S${bed}`, 'G92 E0'];
  const layerPaths = slicing.layers.map((layer) => joinLayerSegments(layer.segments, Math.max(1e-6, lineWidth / 1000)));
  const supportByLayer = Array.from({ length: slicing.layers.length }, () => []);
  if (supports) {
    const seen = supportByLayer.map(() => new Set());
    let supportSegments = 0; let supportProjectionTests = 0;
    for (let upper = 1; upper < layerPaths.length; upper += 1) {
      const candidates = layerInfillSegments(layerPaths[upper], supportDensity, lineWidth, upper % 2 === 0);
      for (const segment of candidates) {
        const midpoint = [(segment[0][0] + segment[1][0]) / 2, (segment[0][1] + segment[1][1]) / 2];
        for (let lower = upper - 1; lower >= 0; lower -= 1) {
          const projectionTests = layerPaths[lower].reduce((sum, path) => sum + Math.max(0, path.length - 1), 0);
          if (supportProjectionTests > maxSupportProjectionTests - projectionTests) throw new RangeError(`Support planning exceeds the ${maxSupportProjectionTests.toLocaleString()} edge-test cap.`);
          supportProjectionTests += projectionTests;
          if (pointInsidePaths(midpoint, layerPaths[lower])) break;
          const key = segment.flat().map((value) => value.toFixed(3)).join(':');
          if (!seen[lower].has(key)) { seen[lower].add(key); supportByLayer[lower].push(segment); supportSegments += 1; }
          if (supportSegments > maxSupportSegments) throw new RangeError(`Generated supports exceed the ${maxSupportSegments.toLocaleString()}-segment cap.`);
        }
      }
    }
  }
  let emittedSegments = 0;
  const emit = (segment, speed) => {
    const [start, end] = segment;
    emittedSegments += 1; if (emittedSegments > maxToolpathSegments) throw new RangeError(`G-code expansion exceeds the ${maxToolpathSegments.toLocaleString()}-segment cap.`);
    lines.push(`G0 X${(start[0] + shift[0]).toFixed(3)} Y${(start[1] + shift[1]).toFixed(3)} F${Math.round(travelSpeed * 60)}`);
    e += Math.hypot(end[0] - start[0], end[1] - start[1]) * extrusionPerMm;
    lines.push(`G1 X${(end[0] + shift[0]).toFixed(3)} Y${(end[1] + shift[1]).toFixed(3)} E${e.toFixed(5)} F${Math.round(speed * 60)}`);
  };
  for (let layerIndex = 0; layerIndex < slicing.layers.length; layerIndex += 1) {
    const layer = slicing.layers[layerIndex]; const paths = layerPaths[layerIndex];
    lines.push(`;LAYER:${layer.index}`, `G0 Z${(layer.z + shift[2]).toFixed(3)} F${Math.round(travelSpeed * 60)}`);
    for (let wall = 0; wall < walls; wall += 1) {
      lines.push(`;TYPE:${wall ? 'WALL-INNER' : 'WALL-OUTER'}`);
      for (const path of paths) {
        const inset = insetPath(path, wall * lineWidth);
        for (let index = 1; index < inset.length; index += 1) emit([inset[index - 1], inset[index]], printSpeed);
      }
    }
    const infillSegments = layerInfillSegments(paths, infill, lineWidth, layer.index % 2 === 1);
    if (infillSegments.length) { lines.push(`;TYPE:INFILL ${Math.max(0, Math.min(100, infill))}%`); infillSegments.forEach((segment) => emit(segment, printSpeed)); }
    if (supportByLayer[layerIndex].length) { lines.push(`;TYPE:SUPPORT ${Math.max(1, Math.min(100, supportDensity))}%`); supportByLayer[layerIndex].forEach((segment) => emit(segment, Math.min(printSpeed, 30))); }
  }
  lines.push('M104 S0', 'M140 S0', 'G92 E0', 'G1 E-1 F1800', 'M84', '; end');
  return `${lines.join('\n')}\n`;
}

function parseCoordinate(raw, integerDigits, decimals, zeroSuppression = 'L') {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (text.includes('.')) return Number(text);
  const sign = text.startsWith('-') ? -1 : 1;
  const digits = text.replace(/^[-+]/, '');
  const width = integerDigits + decimals;
  if (!/^\d+$/.test(digits) || digits.length > width) throw new RangeError(`Coordinate ${text} exceeds the declared ${integerDigits}.${decimals} format.`);
  const padded = zeroSuppression === 'T' ? digits.padEnd(width, '0') : digits.padStart(width, '0');
  return sign * Number(padded) / 10 ** decimals;
}

export function parseGerber(source, filename = '', { commandLimit = 500_000 } = {}) {
  const text = String(source).replace(/\r/g, '');
  const isDrill = /M48|\.drl$/i.test(`${text.slice(0, 400)} ${filename}`);
  const units = /MOIN|G70|INCH/i.test(text) ? 'inch' : 'mm';
  let xIntegerDigits = 2; let xDecimals = 4; let yIntegerDigits = 2; let yDecimals = 4; let zeroSuppression = 'L'; let notation = 'A';
  const format = /FS([LT])([AI])?X(\d)(\d)Y(\d)(\d)/i.exec(text);
  const drillFormat = /FILE_FORMAT\s*=\s*\d+\s*[:.]\s*(\d+)/i.exec(text);
  const drillZeroSuppression = /(?:METRIC|INCH)\s*,?\s*(LZ|TZ)/i.exec(text);
  if (format) {
    zeroSuppression = format[1].toUpperCase(); notation = (format[2] || 'A').toUpperCase();
    xIntegerDigits = Number(format[3]); xDecimals = Number(format[4]); yIntegerDigits = Number(format[5]); yDecimals = Number(format[6]);
  } else {
    if (drillFormat) { xDecimals = Number(drillFormat[1]); yDecimals = xDecimals; }
    if (drillZeroSuppression) zeroSuppression = drillZeroSuppression[1][0].toUpperCase();
  }
  const apertures = new Map();
  for (const match of text.matchAll(/%ADD(\d+)([A-Z]),?([^*%]*)\*%/gi)) apertures.set(Number(match[1]), { shape: match[2], parameters: match[3].split('X').map(Number) });
  const commands = [];
  const warnings = [];
  let x = 0; let y = 0; let tool = null; let modalOperation = 'move';
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  if (!Number.isInteger(commandLimit) || commandLimit < 1 || commandLimit > 500_000) throw new RangeError('Gerber command limit must be between 1 and 500,000.');
  const tokens = text.split(/\*|\n/);
  for (const tokenRaw of tokens) {
    const token = tokenRaw.replace(/%/g, '').trim();
    if (!token) continue;
    if (/^(?:FS|MO|ADD|AM|M48|METRIC|INCH|FMAT|VER)/i.test(token)) continue;
    if (/^G90$/i.test(token)) { notation = 'A'; continue; }
    if (/^G91$/i.test(token)) { notation = 'I'; continue; }
    if (!isDrill) {
      const standaloneOperation = /^D0?([123])$/i.exec(token);
      if (standaloneOperation) { modalOperation = standaloneOperation[1] === '1' ? 'draw' : standaloneOperation[1] === '3' ? 'flash' : 'move'; continue; }
      const apertureMatch = /^(?:G54)?D(\d+)$/i.exec(token);
      if (apertureMatch && Number(apertureMatch[1]) >= 10) { tool = Number(apertureMatch[1]); continue; }
    } else {
      const toolMatch = /^T(\d+)(?:C([-+\d.]+))?$/i.exec(token);
      if (toolMatch) {
        tool = Number(toolMatch[1]);
        if (toolMatch[2] != null) apertures.set(tool, { shape: 'C', parameters: [Number(toolMatch[2])] });
        continue;
      }
    }
    const xMatch = /X([-+]?\d*\.?\d+)/i.exec(token); const yMatch = /Y([-+]?\d*\.?\d+)/i.exec(token);
    if (!xMatch && !yMatch) continue;
    const operationMatch = /D0?([123])(?:\D|$)/i.exec(token);
    if (operationMatch && !isDrill) modalOperation = operationMatch[1] === '1' ? 'draw' : operationMatch[1] === '3' ? 'flash' : 'move';
    const parsedX = xMatch == null ? null : parseCoordinate(xMatch[1], xIntegerDigits, xDecimals, zeroSuppression);
    const parsedY = yMatch == null ? null : parseCoordinate(yMatch[1], yIntegerDigits, yDecimals, zeroSuppression);
    const nextX = parsedX == null ? x : notation === 'I' ? x + parsedX : parsedX;
    const nextY = parsedY == null ? y : notation === 'I' ? y + parsedY : parsedY;
    const operation = isDrill ? 'drill' : modalOperation;
    commands.push({ operation, x1: x, y1: y, x2: nextX, y2: nextY, tool, aperture: apertures.get(tool) || null });
    if (commands.length > commandLimit) throw new RangeError(`Fabrication layer exceeds the ${commandLimit.toLocaleString('en-US')}-command safety cap.`);
    minX = Math.min(minX, x, nextX); minY = Math.min(minY, y, nextY); maxX = Math.max(maxX, x, nextX); maxY = Math.max(maxY, y, nextY);
    x = nextX; y = nextY;
  }
  if (/AM[^*]+\*/i.test(text)) warnings.push('Aperture macros are retained but not expanded.');
  if (/G0?[23]/.test(text)) warnings.push('Arc commands are approximated as endpoints in this compact viewer.');
  if (/G36|G37/i.test(text)) warnings.push('Region fills are not expanded; only their coordinate paths are shown.');
  if (/%?LPC/i.test(text)) warnings.push('Clear layer polarity is not composited; clear objects are shown as ordinary geometry.');
  if (/%?SR(?:X|Y)/i.test(text)) warnings.push('Step-and-repeat blocks are not expanded; only source coordinates are shown.');
  const unsupportedApertures = [...apertures.values()].filter((aperture) => !['C', 'R'].includes(aperture.shape));
  if (unsupportedApertures.length) warnings.push('Obround, polygon, or macro apertures use a circular preview fallback.');
  if (isDrill && !format && !drillFormat && !/[XY][-+]?\d*\.\d+/i.test(text)) warnings.push(`No Excellon coordinate format was declared; ${xDecimals} implicit decimal places were assumed.`);
  const bounds = commands.length ? { min: [minX, minY], max: [maxX, maxY] } : { min: [0, 0], max: [0, 0] };
  return { format: isDrill ? 'Excellon' : 'RS-274X', units, integerDigits: xIntegerDigits, decimals: xDecimals, xFormat: [xIntegerDigits, xDecimals], yFormat: [yIntegerDigits, yDecimals], zeroSuppression, notation, apertures, commands, bounds, warnings };
}

class ByteReader {
  constructor(value) { this.bytes = bytesOf(value); this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength); this.offset = 0; }
  need(length) { if (this.offset + length > this.bytes.length) throw new RangeError('GGUF metadata exceeds the available byte window.'); }
  u8() { this.need(1); return this.view.getUint8(this.offset++); }
  i8() { this.need(1); return this.view.getInt8(this.offset++); }
  u16() { this.need(2); const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  i16() { this.need(2); const value = this.view.getInt16(this.offset, true); this.offset += 2; return value; }
  u32() { this.need(4); const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
  i32() { this.need(4); const value = this.view.getInt32(this.offset, true); this.offset += 4; return value; }
  f32() { this.need(4); const value = this.view.getFloat32(this.offset, true); this.offset += 4; return value; }
  u64() { this.need(8); const value = this.view.getBigUint64(this.offset, true); this.offset += 8; if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('GGUF count exceeds the safe browser range.'); return Number(value); }
  i64() { this.need(8); const value = this.view.getBigInt64(this.offset, true); this.offset += 8; return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString(); }
  f64() { this.need(8); const value = this.view.getFloat64(this.offset, true); this.offset += 8; return value; }
  string() { const length = this.u64(); if (length > 16 * 1024 * 1024) throw new RangeError('GGUF string exceeds the metadata safety cap.'); this.need(length); const value = utf8.decode(this.bytes.subarray(this.offset, this.offset + length)); this.offset += length; return value; }
}

function readGgufValue(reader, type, depth = 0) {
  if (depth > 4) throw new RangeError('GGUF array nesting is too deep.');
  if (type === 0) return reader.u8();
  if (type === 1) return reader.i8();
  if (type === 2) return reader.u16();
  if (type === 3) return reader.i16();
  if (type === 4) return reader.u32();
  if (type === 5) return reader.i32();
  if (type === 6) return reader.f32();
  if (type === 7) return Boolean(reader.u8());
  if (type === 8) return reader.string();
  if (type === 9) {
    const child = reader.u32(); const length = reader.u64();
    if (length > 100_000) throw new RangeError('GGUF metadata array exceeds the safety cap.');
    return Array.from({ length }, () => readGgufValue(reader, child, depth + 1));
  }
  if (type === 10) return reader.u64();
  if (type === 11) return reader.i64();
  if (type === 12) return reader.f64();
  throw new Error(`Unsupported GGUF metadata type ${type}.`);
}

export function parseGgufMetadata(value, { maxEntries = 20_000 } = {}) {
  const reader = new ByteReader(value);
  reader.need(4);
  const magic = latin1.decode(reader.bytes.subarray(0, 4)); reader.offset = 4;
  if (magic !== 'GGUF') throw new Error('File does not start with the GGUF magic bytes.');
  const version = reader.u32();
  if (version < 2 || version > 3) throw new Error(`GGUF version ${version} is not supported.`);
  const tensorCount = reader.u64();
  const metadataCount = reader.u64();
  if (metadataCount > maxEntries) throw new RangeError('GGUF metadata entry count exceeds the safety cap.');
  const metadata = {};
  for (let index = 0; index < metadataCount; index += 1) {
    const key = reader.string();
    const type = reader.u32();
    metadata[key] = readGgufValue(reader, type);
  }
  return { version, tensorCount, metadataCount, metadata, metadataBytes: reader.offset };
}

export function estimateModelMemory(fileBytes, contextLength = 2048, layers = 24, embedding = 2048) {
  const weights = Math.max(0, Number(fileBytes) || 0);
  const kvCache = Math.max(0, contextLength) * Math.max(1, layers) * Math.max(1, embedding) * 2 * 2;
  const runtime = Math.max(128 * 1024 * 1024, weights * 0.12);
  return { weights, kvCache, runtime, total: weights + kvCache + runtime };
}

export function normalizeTranscript(result) {
  const words = Array.isArray(result?.chunks) ? result.chunks.map((item) => ({
    text: String(item.text || '').trim(),
    start: Number(item.timestamp?.[0] ?? 0),
    end: Number(item.timestamp?.[1] ?? item.timestamp?.[0] ?? 0)
  })).filter((item) => item.text) : [];
  const cues = [];
  let current = null;
  for (const word of words) {
    if (!current) current = { ...word };
    else if (word.end - current.start <= 7 && current.text.length < 90) { current.end = word.end; current.text += `${/^[,.;:!?]/.test(word.text) ? '' : ' '}${word.text}`; }
    else { cues.push(current); current = { ...word }; }
  }
  if (current) cues.push(current);
  if (!cues.length && result?.text) cues.push({ start: 0, end: 0, text: String(result.text).trim() });
  return { text: String(result?.text || cues.map((cue) => cue.text).join(' ')).trim(), cues };
}

export function applyTranscriptReview(transcript, reviewedText, duration = 0) {
  const text = String(reviewedText || '').trim();
  if (text === String(transcript?.text || '').trim()) return { ...transcript, text, cues: (transcript?.cues || []).map((cue) => ({ ...cue })) };
  return {
    ...transcript,
    text,
    cues: text ? [{ start: 0, end: Math.max(0, Number(duration) || 0), text }] : [],
    reviewNote: 'Whole-text edits cannot be mapped back to word timestamps, so timed exports use one full-duration reviewed cue.'
  };
}

function clock(seconds, separator = '.') {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0').replace('.', separator)}`;
}

export function transcriptToVtt(cues) { return `WEBVTT\n\n${cues.map((cue) => `${clock(cue.start)} --> ${clock(cue.end)}\n${cue.text}`).join('\n\n')}\n`; }
export function transcriptToSrt(cues) { return `${cues.map((cue, index) => `${index + 1}\n${clock(cue.start, ',')} --> ${clock(cue.end, ',')}\n${cue.text}`).join('\n\n')}\n`; }

export function topK(values, count = 5, labels = []) {
  return Array.from(values, (value, index) => ({ index, value: Number(value), label: labels[index] || String(index) }))
    .filter((item) => Number.isFinite(item.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(1, Math.min(100, count)));
}

export function decodeSegmentationMask(values, dims, { threshold = 0.5, maxPixels = 8_388_608, layout = 'nchw' } = {}) {
  if (!Array.isArray(dims) || ![3, 4].includes(dims.length)) throw new Error('Segmentation output must have [N,H,W], [N,C,H,W], or [N,H,W,C] dimensions.');
  let width; let height; let classes; let resolvedLayout = layout;
  if (dims.length === 3) { [, height, width] = dims.map(Number); classes = 1; resolvedLayout = 'labels'; }
  else if (layout === 'nchw') [, classes, height, width] = dims.map(Number);
  else if (layout === 'nhwc') [, height, width, classes] = dims.map(Number);
  else throw new Error('Four-dimensional segmentation output layout must be nchw or nhwc.');
  const pixels = width * height;
  if (![width, height, classes].every((value) => Number.isSafeInteger(value) && value > 0) || pixels > maxPixels || classes > 4096) throw new RangeError('Segmentation output dimensions exceed the supported bounds.');
  const expectedValues = resolvedLayout === 'labels' ? pixels : pixels * classes;
  if (values.length !== expectedValues) throw new RangeError(`Segmentation tensor has ${values.length.toLocaleString()} values; ${expectedValues.toLocaleString()} are required by its dimensions.`);
  const labels = new Uint16Array(pixels);
  if (resolvedLayout === 'labels') for (let pixel = 0; pixel < pixels; pixel += 1) labels[pixel] = Math.max(0, Math.min(65535, Math.round(Number(values[pixel]) || 0)));
  else if (classes === 1) for (let pixel = 0; pixel < pixels; pixel += 1) labels[pixel] = Number(values[pixel]) >= threshold ? 1 : 0;
  else for (let pixel = 0; pixel < pixels; pixel += 1) {
    let bestClass = 0; let bestValue = -Infinity;
    for (let classIndex = 0; classIndex < classes; classIndex += 1) {
      const index = resolvedLayout === 'nchw' ? classIndex * pixels + pixel : pixel * classes + classIndex;
      const value = Number(values[index]);
      if (Number.isFinite(value) && value > bestValue) { bestValue = value; bestClass = classIndex; }
    }
    labels[pixel] = bestClass;
  }
  return { width, height, classes, labels };
}

export function hashEmbedding(text, dimensions = 256) {
  if (!Number.isSafeInteger(dimensions) || dimensions < 16 || dimensions > 4096) throw new RangeError('Embedding dimensions are outside the supported range.');
  const vector = new Float32Array(dimensions);
  const terms = tokenize(text);
  for (const term of terms) {
    let hash = 2166136261;
    for (let index = 0; index < term.length; index += 1) { hash ^= term.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    const slot = (hash >>> 0) % dimensions;
    vector[slot] += (hash & 1) ? 1 : -1;
  }
  const norm = Math.hypot(...vector) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new RangeError('Vectors must have equal dimensions.');
  let dot = 0; let aa = 0; let bb = 0;
  for (let index = 0; index < a.length; index += 1) { dot += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function rankEmbeddingRecords(records, queryVector, limit = 10) {
  if (!queryVector?.length) throw new Error('Query embedding is empty.');
  return records.filter((record) => record.embedding?.length === queryVector.length)
    .map((record) => ({ ...record, score: cosineSimilarity(record.embedding, queryVector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export function searchEmbeddings(records, query, limit = 10) {
  const vector = hashEmbedding(query, records[0]?.embedding?.length || 256);
  return rankEmbeddingRecords(records, vector, limit);
}
