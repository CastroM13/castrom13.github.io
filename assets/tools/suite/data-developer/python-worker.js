import { loadPyodide } from '/vendor/pyodide/pyodide.mjs';

let activeLogs = [];
let runtimePromise = null;

function runtime() {
  if (!runtimePromise) runtimePromise = loadPyodide({
    indexURL: '/vendor/pyodide/',
    stdout: (line) => activeLogs.push(String(line)),
    stderr: (line) => activeLogs.push(`STDERR ${String(line)}`)
  }).then((pyodide) => {
    const blocked = () => Promise.reject(new Error('Network access is disabled inside this local notebook worker.'));
    globalThis.fetch = blocked;
    globalThis.XMLHttpRequest = undefined;
    globalThis.WebSocket = undefined;
    globalThis.EventSource = undefined;
    globalThis.importScripts = undefined;
    const denyDynamicCode = () => { throw new Error('Dynamic JavaScript execution is disabled inside this local notebook worker.'); };
    const blockedFunction = new Proxy(Function, { apply: denyDynamicCode, construct: denyDynamicCode });
    globalThis.eval = denyDynamicCode;
    globalThis.Function = blockedFunction;
    try { Object.defineProperty(blockedFunction.prototype, 'constructor', { value: blockedFunction, configurable: false, writable: false }); } catch (_) { /* best effort lockdown */ }
    try { Object.defineProperty(Object.getPrototypeOf(async function () {}), 'constructor', { value: blockedFunction, configurable: false, writable: false }); } catch (_) { /* best effort lockdown */ }
    return pyodide;
  });
  return runtimePromise;
}

function transferableResult(value) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value?.toJs === 'function') {
    try { return value.toJs({ dict_converter: Object.fromEntries }); }
    finally { value.destroy?.(); }
  }
  try { return structuredClone(value); } catch (_) { return String(value); }
}

self.onmessage = async (event) => {
  const { id, source, data } = event.data || {};
  activeLogs = [];
  try {
    const pyodide = await runtime();
    const dataProxy = pyodide.toPy(data);
    pyodide.globals.set('data', dataProxy);
    let value;
    try { value = await pyodide.runPythonAsync(String(source || '')); }
    finally { pyodide.globals.delete('data'); dataProxy.destroy?.(); }
    self.postMessage({ ok: true, id, result: { logs: activeLogs, value: transferableResult(value) } });
  } catch (error) {
    self.postMessage({ ok: false, id, error: error instanceof Error ? error.message : String(error) });
  } finally { activeLogs = []; }
};
