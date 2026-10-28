# Changelog

## [Unreleased]

### Added

- MIT license.
- Install instructions for BRAT and the release files in the README.

## [0.0.1] - 2026-10-27

First beta.

### Added

- Concept search pane beside native Search. Notes rank by meaning, and each result shows its best passages.
- Filters with `file:`, `path:`, `tag:`, `property.NAME:`, quoted text, and `-` exclusions. They narrow the notes before ranking and work without the model.
- Guided setup that downloads BAAI/bge-small-en-v1.5 (133 MB) once from huggingface.co and checks it against published SHA-256 checksums, or imports it from a folder.
- Background indexing in 80-token passages with title and heading context. Search works while indexing runs.
- Index and model stored outside the vault, in `~/Library/Application Support/dowse`, with **Delete local data** in settings.
- Model memory released after 5 idle minutes.
