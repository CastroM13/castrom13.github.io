# Publishing notes

1. Copy the relevant `_template` file and remove the leading underscore from the new filename.
2. Keep one language per file. Pair translations with the same `translationKey`.
3. Leave `draft: true` while writing. Change it to `false` to publish on the next push to `main`.
4. Run `npm run build` locally to preview the generated pages.

The build owns `/blog/` and `/pt-br/blog/`; do not hand-edit generated HTML there.
