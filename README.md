# Dowse
hyper fast local search and more for your obsidian

Dowse is an Obsidian plugin that finds notes by what they mean, not the exact words you typed, and runs entirely on your Mac. It adds a side pane next to native Obsidian Search, which stays the tool for exact keyword lookup. Filters such as `tag:`, `path:`, and quoted text will narrow the results before they are ranked by meaning. The first beta searches only the active vault, and each Mac keeps its own index outside the vault. Dowse is an early development build and is not released.

## Development

Requires Node 25. Python 3 with `tokenizers` and `onnxruntime` is needed only to regenerate the reference fixtures in `test/fixtures/`.

- `./scripts/fetch-dev-model.sh` downloads the pinned candidate model into `dev-assets/`.
- `npm test` runs the unit tests.
- `npm run build` writes `main.js`, `manifest.json`, and `styles.css` to `dist/`.
- `npm run try` opens a separate Obsidian on a generated test vault with Dowse installed.
- `npm run live` runs the end-to-end checks in a separate Obsidian.

The plugin ID is `dowse`. The plugin code will use the MIT license.
