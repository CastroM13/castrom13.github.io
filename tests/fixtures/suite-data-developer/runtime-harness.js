import {
  createGitMemoryFs,
  inspectParquetEnvelope,
  mountTool,
  toolKeys
} from '/assets/tools/suite/data-developer.js';

const results = document.querySelector('#results');
const summary = document.querySelector('#summary');
const isolation = document.querySelector('#isolation');
const outcomes = [];

function normalize(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value.toJSON === 'function') {
    const serialized = value.toJSON();
    if (typeof serialized === 'string' && /^"(?:[^"\\]|\\.)*"$/.test(serialized)) {
      try { return JSON.parse(serialized); } catch (_) { /* retain the runtime representation */ }
    }
    return normalize(serialized);
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, operation) {
  const item = document.createElement('li');
  item.textContent = `${name}: running`;
  item.dataset.runtime = name;
  results.append(item);
  try {
    const detail = await operation();
    outcomes.push({ name, ok: true, detail });
    item.textContent = `${name}: PASS${detail ? ` — ${detail}` : ''}`;
    item.dataset.state = 'pass';
  } catch (error) {
    outcomes.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    item.textContent = `${name}: FAIL — ${outcomes.at(-1).error}`;
    item.dataset.state = 'fail';
  }
}

async function loadSqlite() {
  if (!globalThis.initSqlJs) await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/sqlite/sql-wasm.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('sql-wasm.js failed to load'));
    document.head.append(script);
  });
  const SQL = await globalThis.initSqlJs({ locateFile: (file) => `/vendor/sqlite/${file}` });
  const response = await fetch('./runtime.sqlite');
  assert(response.ok, `SQLite fixture returned ${response.status}`);
  const database = new SQL.Database(new Uint8Array(await response.arrayBuffer()));
  try {
    const query = database.exec('SELECT COUNT(*) AS rows, SUM(score) AS total FROM widgets')[0];
    assert(query.values[0][0] === 2 && query.values[0][1] === 25, 'SQLite query returned unexpected values');
    return `${query.values[0][0]} rows / total ${query.values[0][1]}`;
  } finally { database.close(); }
}

async function loadDuckDb() {
  const duckdb = await import('/vendor/suite/duckdb.js');
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: '/vendor/duckdb/duckdb-mvp.wasm', mainWorker: '/vendor/duckdb/duckdb-browser-mvp.worker.js' },
    eh: { mainModule: '/vendor/duckdb/duckdb-eh.wasm', mainWorker: '/vendor/duckdb/duckdb-browser-eh.worker.js' }
  });
  const worker = new Worker(bundle.mainWorker);
  const database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  let connection;
  try {
    await database.instantiate(bundle.mainModule, bundle.pthreadWorker || undefined);
    connection = await database.connect();
    const response = await fetch('./runtime.csv');
    assert(response.ok, `CSV fixture returned ${response.status}`);
    await database.registerFileBuffer('runtime.csv', new Uint8Array(await response.arrayBuffer()));
    const table = await connection.query("SELECT COUNT(*) AS rows, SUM(score) AS total FROM read_csv_auto('runtime.csv', header=true)");
    const row = normalize(table.toArray()[0]);
    assert(Number(row.rows) === 3 && Number(row.total) === 32, `DuckDB aggregate mismatch: ${JSON.stringify(row)}`);
    await connection.query("COPY (SELECT * FROM read_csv_auto('runtime.csv', header=true)) TO 'runtime.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)");
    const parquet = new Uint8Array(await database.copyFileToBuffer('runtime.parquet'));
    const envelope = inspectParquetEnvelope(parquet);
    const roundtrip = await connection.query("SELECT COUNT(*) AS rows, SUM(score) AS total FROM read_parquet('runtime.parquet')");
    const roundtripRow = normalize(roundtrip.toArray()[0]);
    assert(Number(roundtripRow.rows) === 3 && Number(roundtripRow.total) === 32, 'Parquet roundtrip query mismatch');
    return `CSV aggregate ${row.total}; Parquet ${envelope.size} bytes; roundtrip ${roundtripRow.rows} rows`;
  } finally {
    try { await connection?.close(); } catch (_) { /* best effort */ }
    try { await database.terminate(); } catch (_) { /* best effort */ }
    worker.terminate();
  }
}

async function loadPython() {
  const worker = new Worker('/assets/tools/suite/data-developer/python-worker.js', { type: 'module' });
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Pyodide worker exceeded 60 seconds')), 60_000);
      worker.onmessage = (event) => {
        clearTimeout(timeout);
        if (event.data?.ok) resolve(event.data.result); else reject(new Error(event.data?.error || 'Pyodide worker failed'));
      };
      worker.onerror = () => { clearTimeout(timeout); reject(new Error('Pyodide worker crashed')); };
      worker.postMessage({ id: 1, source: 'sum(row["score"] for row in data)', data: [{ score: 10 }, { score: 7 }, { score: 15 }] });
    });
    assert(result.value === 32, `Pyodide returned ${JSON.stringify(result.value)}`);
    return `Python result ${result.value}`;
  } finally { worker.terminate(); }
}

async function loadJavaScriptSandbox() {
  const execute = (source, data) => new Promise((resolve, reject) => {
    const worker = new Worker('/assets/tools/suite/data-developer/worker.js', { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('JavaScript worker exceeded 5 seconds')); }, 5_000);
    worker.onmessage = (event) => {
      clearTimeout(timeout); worker.terminate();
      if (event.data?.ok) resolve(event.data.result); else reject(new Error(event.data?.error || 'JavaScript worker failed'));
    };
    worker.onerror = () => { clearTimeout(timeout); worker.terminate(); reject(new Error('JavaScript worker crashed')); };
    worker.postMessage({ kind: 'javascript-cell', payload: { source, data } });
  });
  const result = await execute('console.log("sandbox"); return data.reduce((sum, value) => sum + value, 0);', [1, 2, 3]);
  assert(result.result === '6' && result.logs[0] === 'sandbox', 'JavaScript sandbox returned unexpected output');
  let constructorBlocked = false;
  try { await execute('return (async () => {}).constructor("return 1")();', null); }
  catch (error) { constructorBlocked = /constructor/.test(error.message); }
  assert(constructorBlocked, 'JavaScript function-constructor escape was not blocked');
  return 'worker result 6; constructor escape blocked';
}

async function loadGit() {
  if (!globalThis.Buffer) {
    const bufferModule = await import('/vendor/suite/buffer.js');
    globalThis.Buffer = bufferModule.Buffer || bufferModule.default?.Buffer;
  }
  assert(globalThis.Buffer, 'browser Buffer compatibility layer did not initialize');
  const git = await import('/vendor/suite/isomorphic-git.js');
  assert(typeof git.log === 'function' && typeof git.statusMatrix === 'function' && typeof git.commit === 'function', 'isomorphic-git exports are incomplete');
  const fs = createGitMemoryFs([], { mutable: true });
  await git.init({ fs, dir: '/repo', defaultBranch: 'main' });
  await fs.promises.writeFile('/repo/README.md', 'browser virtual fixture\n');
  await git.add({ fs, dir: '/repo', filepath: 'README.md' });
  const oid = await git.commit({ fs, dir: '/repo', message: 'browser fixture', author: { name: 'Runtime Harness', email: 'runtime@example.test', timestamp: 1_700_000_000, timezoneOffset: 0 } });
  const branch = await git.currentBranch({ fs, dir: '/repo', fullname: false });
  const matrix = await git.statusMatrix({ fs, dir: '/repo' });
  const history = await git.log({ fs, dir: '/repo', depth: 2 });
  assert(branch === 'main' && /^[a-f0-9]{40}$/.test(oid), 'isomorphic-git did not create the virtual branch/commit');
  assert(JSON.stringify(matrix[0]) === JSON.stringify(['README.md', 1, 1, 1]) && history[0].oid === oid, 'virtual commit status/history mismatch');
  return `branch ${branch}; commit ${oid.slice(0, 12)}; clean status`;
}

async function mountEveryTool() {
  for (const key of toolKeys) {
    const root = document.createElement('section');
    document.body.append(root);
    const cleanup = mountTool(key, { root, t: (english) => english, pt: false });
    assert(root.querySelector('form') && root.querySelector('h2'), `${key} did not mount its accessible shell`);
    cleanup();
    root.remove();
  }
  return `${toolKeys.length} workbenches mounted and cleaned up`;
}

function attachFixture(input, bytes, name, type) {
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], name, { type }));
  input.files = transfer.files;
}

async function waitForWorkbench(root, timeoutMs = 60_000) {
  const started = performance.now();
  const target = root.querySelector('[data-status]');
  while (performance.now() - started < timeoutMs) {
    if (target.dataset.kind === 'success') return target.textContent;
    if (target.dataset.kind === 'error') throw new Error(target.textContent || 'Workbench reported an error');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Workbench exceeded ${Math.round(timeoutMs / 1_000)} seconds`);
}

async function exerciseParquetConverter() {
  const response = await fetch('./runtime.csv');
  assert(response.ok, `CSV fixture returned ${response.status}`);
  const root = document.createElement('section');
  document.body.append(root);
  const cleanup = mountTool('data-converter', { root, t: (english) => english, pt: false });
  try {
    attachFixture(root.querySelector('[data-file]'), new Uint8Array(await response.arrayBuffer()), 'runtime.csv', 'text/csv');
    root.querySelector('[data-output-format]').value = 'parquet';
    root.querySelector('[data-form]').requestSubmit();
    const message = await waitForWorkbench(root);
    const preview = root.querySelector('[data-preview]').textContent;
    assert(preview.includes('"magic": "PAR1"') && !root.querySelector('[data-download]').disabled, 'Parquet converter did not expose a real downloadable envelope');
    return `${message} PAR1 preview and download enabled`;
  } finally { cleanup(); root.remove(); }
}

async function loadCompiler() {
  const { createEmception } = await import('/vendor/emception/browser.js');
  const runtime = await createEmception({ manifestUrl: '/vendor/emception/cdn/manifest.json', tty: 'none' });
  try {
    const source = '#include <stdio.h>\nint main(void){puts("emception-ok");return 0;}';
    await runtime.workspace.writeFile('/home/user/default/main.cpp', source);
    const result = await runtime.compileAndRun(source, {
      build: { toolchain: 'c' }, cwd: '/home/user/default', stdin: 'none', stdout: 'capture', stderr: 'capture'
    });
    assert(result.exitCode === 0 && String(result.stdout).includes('emception-ok'), `Compiler result: ${JSON.stringify(result)}`);
    const wasm = await runtime.workspace.readFile('/home/user/default/main.wasm');
    assert(wasm && WebAssembly.validate(wasm), 'Compiler did not retain a valid main.wasm artifact');
    return `exit ${result.exitCode}; ${String(result.stdout).trim()}; ${wasm.length} byte WASM`;
  } finally { runtime.dispose?.(); }
}

if (!globalThis.crossOriginIsolated) {
  isolation.textContent = 'Waiting for the local COI service worker to take control and reload this harness…';
  summary.textContent = 'WAITING FOR ISOLATED RELOAD';
} else {
  isolation.textContent = 'crossOriginIsolated: true';
  await check('mounts', mountEveryTool);
  await check('Parquet converter UI', exerciseParquetConverter);
  await check('SQLite WASM', loadSqlite);
  await check('DuckDB WASM + Parquet', loadDuckDb);
  await check('Pyodide worker', loadPython);
  await check('JavaScript sandbox', loadJavaScriptSandbox);
  await check('isomorphic-git', loadGit);
  if (new URLSearchParams(location.search).has('compiler')) await check('Emception C', loadCompiler);
  const failed = outcomes.filter((item) => !item.ok);
  summary.textContent = JSON.stringify({ ok: failed.length === 0, crossOriginIsolated, outcomes }, null, 2);
  summary.dataset.state = failed.length ? 'fail' : 'pass';
  globalThis.__runtimeHarness = { done: true, ok: failed.length === 0, outcomes };
}
