# Dowse
hyper fast local search and more for your obsidian

Dowse is an Obsidian plugin that finds notes by what they mean, not the exact words you typed, and runs entirely on your Mac. It adds a side pane next to native Obsidian Search, which stays the tool for exact keyword lookup. Filters such as `tag:`, `path:`, and quoted text narrow the results before they are ranked by meaning. The first beta searches only the active vault, and each Mac keeps its own index outside the vault. Dowse is an early development build and is not released.

## Setting up concept search

Searches with words need a small language model that runs on your Mac. Filters such as `tag:`, `path:`, and quoted text work without it. Open the Dowse pane and choose **Set up concept search**. Dowse downloads the model once, checks each file against its published SHA-256 checksum, and then indexes your notes. You can search the indexed notes while indexing continues.

- Model: [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5/tree/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a) at revision `5c38ec7`, MIT license, 133 MB.
- If you can't download from Dowse, download `onnx/model.onnx` (save it as `model.onnx`) and `vocab.txt` from that revision yourself. Then choose **Import** on the setup screen and enter the folder that holds them. Dowse applies the same checks.

## Network use

Dowse uses the network only when you choose to set up concept search. It then downloads the two model files listed above from huggingface.co, run by Hugging Face, because the model is too large to ship inside the plugin. These requests carry no note text, search queries, or account details. Indexing and searching run offline afterwards. Dowse has no telemetry.

## Files outside your vault

Dowse keeps its index and the model in `~/Library/Application Support/dowse`, outside your vault. That way sync services never copy or merge them, and each Mac builds its own index. The folder holds one index per vault and one copy of the model shared by all vaults. Removing the plugin leaves this folder behind. Delete it with **Delete local data** in the Dowse settings, or remove the folder yourself. Dowse never writes inside your vault.

## Development

Requires Node 25 and Obsidian 1.14.4 or later in `/Applications`, opened at least once. The suites copy its newest app package from Obsidian's data folder. Python 3 with `tokenizers` and `onnxruntime` is needed only to regenerate the reference fixtures in `test/fixtures/`.

- `node scripts/fetch-dev-model.ts` downloads the pinned model into `dev-assets/model` and verifies its checksums.
- `python3 -m venv dev-assets/pyenv && dev-assets/pyenv/bin/pip install blake3==1.0.9` installs the second BLAKE3 implementation the tests compare against.
- `npm test` builds the plugin and runs the four end-to-end suites in a separate Obsidian. Its windows open behind your other windows and never take focus, and it leaves your own Obsidian, its settings, and its command-line socket alone. The setup suite serves the model from a local test server. All tests are end to end.
- `npm run setup-real` runs a fresh-install setup against huggingface.co. It needs the network.
- `npm run load -- <label> 1000` measures a 1,000-note generated vault against the latency and memory budgets.
- `npm run build` writes `main.js`, `manifest.json`, and `styles.css` to `dist/`.
- `npm run try` opens a separate Obsidian on a generated test vault with Dowse and the model installed. `npm run try -- --setup` leaves the model out, so you can walk through setup there first.
- `scripts/eval/` holds the encoder comparison that chose the model. It needs a Python environment with `onnxruntime`, `tokenizers`, `numpy`, and `pyarrow`.

The plugin ID is `dowse`. The plugin code will use the MIT license.
