# Bundled Markdown dependencies

These browser ES modules are copied verbatim from the exact npm versions pinned in `package.json` and `package-lock.json`. Include this directory in extension release archives. No runtime CDN or separate vendor build step is required. Application TypeScript is compiled separately with `npm run build`.

| File | npm source | License |
| --- | --- | --- |
| `marked.js` | `marked@18.0.13/lib/marked.esm.js` | `marked.LICENSE` |
| `dompurify.js` | `dompurify@3.4.15/dist/purify.es.mjs` | `dompurify.LICENSE` |

The adjacent `.d.ts` files are local development declarations that reuse the types from the pinned npm packages; they are not runtime dependencies.

When updating dependencies, copy these two modules and their corresponding package-root `LICENSE` files again, then run the test suite and browser layout checks.

The renderer sanitizes Markdown HTML before inserting it into the extension, following the [Marked security guidance](https://marked.js.org/). Its allowlist excludes active HTML, arbitrary data attributes, and embedded remote resources.
