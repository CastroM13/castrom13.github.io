import { context } from '../toolkit.js';

export const TOOL_PACKS = Object.freeze({
  'universal-image-converter': './suite/media-foundation.js',
  'image-compressor': './suite/media-foundation.js',
  'raw-photo-processor': './suite/media-foundation.js',
  'svg-studio': './suite/media-foundation.js',
  'image-metadata-workbench': './suite/media-foundation.js',
  'ocr-studio': './suite/media-foundation.js',
  'document-scanner': './suite/media-foundation.js',
  'panorama-stitcher': './suite/media-foundation.js',
  'hdr-merger': './suite/media-foundation.js',
  'pixel-texture-editor': './suite/media-foundation.js',
  'offline-video-player': './suite/media-foundation.js',
  'video-converter': './suite/media-foundation.js',
  'video-compressor': './suite/media-foundation.js',
  'video-editor': './suite/media-documents.js',
  'animation-studio': './suite/media-documents.js',
  'subtitle-editor': './suite/media-documents.js',
  'audio-converter': './suite/media-documents.js',
  'daw-lite': './suite/media-documents.js',
  'audio-restoration': './suite/media-documents.js',
  'music-analyzer': './suite/media-documents.js',
  'pdf-toolbox': './suite/media-documents.js',
  'pdf-editor': './suite/media-documents.js',
  'office-viewer': './suite/media-documents.js',
  'epub-studio': './suite/media-documents.js',
  'publishing-studio': './suite/media-documents.js',
  'archive-manager': './suite/media-documents.js',
  'file-inspector': './suite/data-developer.js',
  'file-deduplicator': './suite/data-developer.js',
  'encryption-vault': './suite/data-developer.js',
  'sqlite-workbench': './suite/data-developer.js',
  'duckdb-studio': './suite/data-developer.js',
  'data-converter': './suite/data-developer.js',
  'bi-dashboard': './suite/data-developer.js',
  'data-notebook': './suite/data-developer.js',
  'regex-workbench': './suite/data-developer.js',
  'git-client': './suite/data-developer.js',
  'binary-diff': './suite/data-developer.js',
  'code-playground': './suite/data-developer.js',
  'packet-analyzer': './suite/data-developer.js',
  'local-search': './suite/engineering-ai.js',
  'model-viewer': './suite/engineering-ai.js',
  'model-converter': './suite/engineering-ai.js',
  'cad-lite': './suite/engineering-ai.js',
  'mesh-editor': './suite/engineering-ai.js',
  'slicer': './suite/engineering-ai.js',
  'gerber-viewer': './suite/engineering-ai.js',
  'llm-playground': './suite/engineering-ai.js',
  'speech-to-text': './suite/engineering-ai.js',
  'vision-lab': './suite/engineering-ai.js',
  'ai-media-studio': './suite/engineering-ai.js'
});

async function start() {
  const root = document.querySelector('[data-tool-root]');
  const key = root?.dataset.toolRoot;
  if (!root || !key || !TOOL_PACKS[key]) return;
  try {
    const pack = await import(TOOL_PACKS[key]);
    const app = context(key);
    if (!app || typeof pack.mountTool !== 'function') throw new Error(`No workbench registered for ${key}.`);
    pack.mountTool(key, app);
  } catch (error) {
    const pt = root.dataset.language === 'pt-BR';
    root.innerHTML = '';
    const message = document.createElement('p');
    message.className = 'tool-error';
    message.setAttribute('role', 'alert');
    message.textContent = pt
      ? `Não foi possível iniciar esta ferramenta local: ${error.message}`
      : `Could not start this local tool: ${error.message}`;
    root.append(message);
  }
}

if (typeof document !== 'undefined') start();
