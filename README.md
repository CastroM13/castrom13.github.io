# castrom13.dev

Static bilingual portfolio and local-first community lab. GitHub Pages publishes `main` through `.github/workflows/static.yml`.

## Community Lab

The Lab has thirteen no-account utilities. Ten tools are generated at paired English and Brazilian Portuguese routes by `scripts/build-tools.mjs`; the original QR, password, and contrast tools remain hand-authored.

| Tool | English route | Processing model |
| --- | --- | --- |
| QR Code Studio | `/qrcode/` | Browser |
| Password & Passphrase | `/tools/password/` | Web Crypto |
| Contrast Workbench | `/tools/contrast/` | Browser |
| TokenDesk | `/tools/tokendesk/` | Browser / Web Crypto |
| Image Metadata Cleaner | `/tools/media-cleaner/` | Canvas, local files |
| HARsafe | `/tools/harsafe/` | Local JSON |
| LogGlass | `/tools/logglass/` | Streaming worker |
| EdgeBench | `/tools/edgebench/` | ONNX Runtime Web worker |
| Dataset Clinic | `/tools/dataset-clinic/` | Local files and SHA-256 |
| StateScope | `/tools/statescope/` | Local JSON |
| SecretSweep | `/tools/secretsweep/` | Streaming local scan |
| PDF Bench | `/tools/pdf-bench/` | pdf-lib, local files |
| Private Transcriber | `/tools/private-transcriber/` | Transformers.js / Whisper worker |

Run `npm run build` before previewing. It generates the bilingual tool pages, copies pinned lazy browser runtimes into ignored `/vendor/`, builds Markdown notes, and refreshes the sitemap. Heavy ONNX, PDF, and transcription code is not loaded by the homepage or Lab directory.

`npm run check` validates generated HTML, every JavaScript file, local references, metadata, and privacy regression fixtures. Test fixtures stay outside the Pages artifact.

## Write a note

1. Copy `content/posts/_template.en.md` or `_template.pt-BR.md`.
2. Rename it without the leading underscore.
3. Keep `draft: true` while writing; change it to `false` when it is ready.
4. Pair translations with the same `translationKey`.
5. Push to `main`. The workflow turns Markdown into static HTML, RSS, and sitemap entries.

Generated `/blog/`, `/pt-br/blog/`, the ten new `/tools/` routes, and their `/pt-br/ferramentas/` counterparts should not be edited manually.

## Replace the portrait placeholder

Export the portrait as an optimized AVIF or WebP with a useful crop around 4:5. Replace the `.portrait-signal` element in both `index.html` and `pt-br/index.html` with an `<img>` that has concise alternative text. Keep the surrounding `<figure>` and translated captions.

## Quality checks

The automated checks complement—not replace—keyboard, screen-reader, zoom, reduced-motion, and browser testing.
