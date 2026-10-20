# Dowse
hyper fast local search and more for your obsidian

Dowse is an Obsidian plugin that finds notes by what they mean, not the exact words you typed, and runs entirely on your Mac. It adds a side pane next to native Obsidian Search, which stays the tool for exact keyword lookup. Filters such as `tag:`, `path:`, and quoted text narrow the results before they are ranked by meaning. The first beta searches only the active vault, and each Mac keeps its own index outside the vault. Dowse is an early development build and is not released.

## Development

Requires Node 25 and Obsidian 1.14.4 in `/Applications`. Python 3 with `tokenizers` and `onnxruntime` is needed only to regenerate the reference fixtures in `test/fixtures/`.

- `./scripts/fetch-dev-model.sh` downloads the pinned candidate model into `dev-assets/`.
- `python3 -m venv dev-assets/pyenv && dev-assets/pyenv/bin/pip install blake3==1.0.9` installs the second BLAKE3 implementation the tests compare against.
- `npm test` builds the plugin and runs the end-to-end checks in a separate Obsidian. All tests are end to end.
- `npm run load -- <label> 1000` measures a 1,000-note generated vault against the latency budgets.
- `npm run build` writes `main.js`, `manifest.json`, and `styles.css` to `dist/`.
- `npm run try` opens a separate Obsidian on a generated test vault with Dowse installed.

The plugin ID is `dowse`. The plugin code will use the MIT license.
