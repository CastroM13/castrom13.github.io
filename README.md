# castrom13.dev

Static bilingual portfolio and local-first community lab. GitHub Pages publishes `main` through `.github/workflows/static.yml`.

## Write a note

1. Copy `content/posts/_template.en.md` or `_template.pt-BR.md`.
2. Rename it without the leading underscore.
3. Keep `draft: true` while writing; change it to `false` when it is ready.
4. Pair translations with the same `translationKey`.
5. Push to `main`. The workflow turns Markdown into static HTML, RSS, and sitemap entries.

Run `npm run build` before a local preview. Generated `/blog/` and `/pt-br/blog/` files should not be edited manually.

## Replace the portrait placeholder

Export the portrait as an optimized AVIF or WebP with a useful crop around 4:5. Replace the `.portrait-signal` element in both `index.html` and `pt-br/index.html` with an `<img>` that has concise alternative text. Keep the surrounding `<figure>` and translated captions.

## Quality checks

`npm run check` validates the primary pages for structural landmarks, language metadata, local links, anchors, and image alternatives. It complements—not replaces—keyboard, screen-reader, zoom, reduced-motion, and browser testing.
