import { evaluateJavaScriptCell, runRegex } from '../data-developer.js';

function format(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return `${value}n`;
  try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
}

self.onmessage = async (event) => {
  const { kind, payload } = event.data || {};
  try {
    let result;
    if (kind === 'regex') result = runRegex(payload.pattern, payload.flags, payload.input, payload.options);
    else if (kind === 'javascript-cell') {
      const asyncFunctionPrototype = Object.getPrototypeOf(async function () {});
      const functionPrototype = Function.prototype;
      const WorkerAsyncFunction = asyncFunctionPrototype.constructor;
      globalThis.fetch = () => Promise.reject(new Error('Network access is disabled inside this local code worker.'));
      globalThis.XMLHttpRequest = undefined;
      globalThis.WebSocket = undefined;
      globalThis.EventSource = undefined;
      globalThis.importScripts = undefined;
      globalThis.eval = undefined;
      globalThis.Function = undefined;
      for (const prototype of [functionPrototype, asyncFunctionPrototype]) {
        try { Object.defineProperty(prototype, 'constructor', { value: undefined, configurable: false, writable: false }); } catch (_) { /* best effort lockdown */ }
      }
      const executed = await evaluateJavaScriptCell(payload.source, { data: payload.data, AsyncFunction: WorkerAsyncFunction });
      result = { logs: executed.logs, result: format(executed.result) };
    } else throw new Error(`Unknown worker operation: ${kind}.`);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
