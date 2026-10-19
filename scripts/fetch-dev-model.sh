#!/bin/sh
set -eu
REPO=intfloat/e5-small-v2
REV=ffb93f3bd4047442299a41ebb6fa998a38507c52
OUT="${1:-dev-assets/e5-small-v2}"
mkdir -p "$OUT/1_Pooling"
for f in model.onnx vocab.txt tokenizer.json tokenizer_config.json special_tokens_map.json config.json modules.json 1_Pooling/config.json; do
	[ -s "$OUT/$f" ] || curl -sSfL "https://huggingface.co/$REPO/resolve/$REV/$f" -o "$OUT/$f"
done
echo "4b8205be2a3c5fc53c6534d76a2012064f7309c162b806f2889c6ec8ec4fdcba  $OUT/model.onnx" | shasum -a 256 -c -
