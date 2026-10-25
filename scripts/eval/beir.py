# Usage: dev-assets/evalenv/bin/python -I scripts/eval/beir.py [modelsDir] [out] [dataDir] [models,...] [sets,...] [passageTokens,...]
# With passage token budgets, documents go through the plugin's own passage builder and score by their best passage, as in the pane.
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.request

import numpy as np
import onnxruntime as ort
import pyarrow.parquet as pq
from tokenizers import Tokenizer

MODELS = sys.argv[1] if len(sys.argv) > 1 else "dev-assets/models"
OUT = sys.argv[2] if len(sys.argv) > 2 else "dev-assets/m3/eval/beir.json"
DATA = sys.argv[3] if len(sys.argv) > 3 else "dev-assets/beir"
ONLY = set(sys.argv[4].split(",")) if len(sys.argv) > 4 else None
SETS = sys.argv[5].split(",") if len(sys.argv) > 5 else None
PASSAGE_TOKENS = [int(n) for n in sys.argv[6].split(",")] if len(sys.argv) > 6 else None

DATASETS = {
	"SciFact": ("BeIR/scifact", "b3b5335604bf5ee3c4447671af975ea25143d4f5", "BeIR/scifact-qrels", "2938d17dc3b09882fdb8c12bbbe2e2dc0e75a029"),
	"NFCorpus": ("BeIR/nfcorpus", "b5026a0e96e8a7ac4f95f482a596389289d46269", "BeIR/nfcorpus-qrels", "a451b3b26d3ae1358f259c1a3a4dd61fcea35a65"),
	"FiQA2018": ("BeIR/fiqa", "979c07a7cb5ccc6ca009792241fa1250b98055dd", "BeIR/fiqa-qrels", "252958f2d646e22cab6d0c72dd3f0d5de6d0655a"),
}


def fetch(repo, rev, name, target):
	if not os.path.exists(target):
		os.makedirs(os.path.dirname(target), exist_ok=True)
		urllib.request.urlretrieve(f"https://huggingface.co/datasets/{repo}/resolve/{rev}/{name}", target)
	return hashlib.sha256(open(target, "rb").read()).hexdigest()


def load(name):
	repo, rev, qrepo, qrev = DATASETS[name]
	base = os.path.join(DATA, name)
	digests = {
		"corpus": fetch(repo, rev, "corpus/corpus-00000-of-00001.parquet", f"{base}/corpus.parquet"),
		"queries": fetch(repo, rev, "queries/queries-00000-of-00001.parquet", f"{base}/queries.parquet"),
		"qrels": fetch(qrepo, qrev, "test.tsv", f"{base}/test.tsv"),
	}
	corpus = pq.read_table(f"{base}/corpus.parquet").to_pylist()
	queries = {q["_id"]: q["text"] for q in pq.read_table(f"{base}/queries.parquet").to_pylist()}
	qrels = {}
	for line in open(f"{base}/test.tsv").read().splitlines()[1:]:
		qid, did, score = line.split("\t")
		if int(score) > 0:
			qrels.setdefault(qid, {})[did] = int(score)
	return corpus, {q: queries[q] for q in qrels}, qrels, digests


def published(readme, dataset):
	text = open(readme, encoding="utf8").read()
	at = text.find(f"name: MTEB {dataset}")
	if at < 0:
		return None
	block = text[at : at + 6000]
	m = re.search(r"type: ndcg_at_10\s+value: ([0-9.]+)", block)
	if not m:
		return None
	v = float(m.group(1))
	return v / 100 if v > 1 else v


class Encoder:
	def __init__(self, c):
		d = os.path.join(MODELS, c["name"])
		self.tok = Tokenizer.from_file(f"{d}/tokenizer.json")
		self.tok.enable_truncation(512)
		self.tok.no_padding()
		self.sess = ort.InferenceSession(f"{d}/{c['onnx']}", providers=["CPUExecutionProvider"])
		self.inputs = [i.name for i in self.sess.get_inputs()]
		pool = json.load(open(f"{d}/1_Pooling/config.json"))
		self.cls = bool(pool.get("pooling_mode_cls_token"))

	def embed(self, texts, batch=32):
		return self.embed_ids([e.ids for e in self.tok.encode_batch(texts)], batch)

	def embed_ids(self, seqs, batch=32):
		order = sorted(range(len(seqs)), key=lambda i: len(seqs[i]))
		out = [None] * len(seqs)
		for s in range(0, len(order), batch):
			idx = order[s : s + batch]
			n = max(len(seqs[i]) for i in idx)
			ids = np.zeros((len(idx), n), dtype=np.int64)
			mask = np.zeros((len(idx), n), dtype=np.int64)
			for r, i in enumerate(idx):
				ids[r, : len(seqs[i])] = seqs[i]
				mask[r, : len(seqs[i])] = 1
			feeds = {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)}
			hidden = self.sess.run(None, {k: feeds[k] for k in self.inputs})[0]
			if self.cls:
				pooled = hidden[:, 0]
			else:
				pooled = (hidden * mask[..., None]).sum(1) / mask.sum(1, keepdims=True)
			pooled = pooled / np.linalg.norm(pooled, axis=1, keepdims=True)
			for r, i in enumerate(idx):
				out[i] = pooled[r]
		return np.stack(out)


def ndcg10(ranked, rel):
	dcg = sum(rel.get(d, 0) / math.log2(i + 2) for i, d in enumerate(ranked[:10]))
	ideal = sorted(rel.values(), reverse=True)[:10]
	idcg = sum(g / math.log2(i + 2) for i, g in enumerate(ideal))
	return dcg / idcg if idcg > 0 else 0.0


def passage_docs(enc, name, corpus, tokens):
	base = os.path.join(DATA, name)
	source = f"{base}/corpus.jsonl"
	if not os.path.exists(source):
		with open(source, "w") as f:
			for i, d in enumerate(corpus):
				f.write(json.dumps([i, d["title"], d["text"]]) + "\n")
	target = f"{base}/passages-{tokens}.jsonl"
	subprocess.run(["node", "scripts/eval/chunks.ts", source, str(tokens), target], check=True)
	rows = [json.loads(line) for line in open(target)]
	owners = np.array([r[0] for r in rows])
	starts = np.flatnonzero(np.r_[True, owners[1:] != owners[:-1]])
	return enc.embed_ids([r[1:] for r in rows]), owners[starts], starts, len(rows)


results = json.load(open(OUT)) if os.path.exists(OUT) else {}
manifest = json.load(open(os.path.join(MODELS, "manifest.json")))
data = {name: load(name) for name in DATASETS if not SETS or name in SETS}
for c in manifest:
	if ONLY and c["name"] not in ONLY:
		continue
	enc = Encoder(c)
	row = results.get(c["name"], {})
	for name, (corpus, queries, qrels, digests) in data.items():
		for tokens in PASSAGE_TOKENS or [None]:
			key = name if tokens is None else f"{name} passages {tokens}"
			if key in row:
				continue
			started = time.time()
			qids = list(queries)
			qs = enc.embed([c["queryPrefix"] + queries[q] for q in qids])
			if tokens is None:
				docs = enc.embed([c["passagePrefix"] + (d["title"] + " " + d["text"]).strip() for d in corpus])
				scores = qs @ docs.T
				ids = [d["_id"] for d in corpus]
				passages = None
			else:
				vectors, owners, starts, passages = passage_docs(enc, name, corpus, tokens)
				scores = np.maximum.reduceat(qs @ vectors.T, starts, axis=1)
				ids = [corpus[i]["_id"] for i in owners]
			values = []
			for r, q in enumerate(qids):
				top = np.argpartition(-scores[r], 100)[:100]
				top = top[np.argsort(-scores[r][top])]
				values.append(ndcg10([ids[i] for i in top], qrels[q]))
			row[key] = {
				"ndcg10": round(float(np.mean(values)), 4),
				"queries": len(qids),
				"docs": len(ids),
				"passages": passages,
				"published": published(os.path.join(MODELS, c["name"], "README.md"), name),
				"seconds": round(time.time() - started),
				"data": digests,
			}
			print(c["name"], key, row[key]["ndcg10"], "published", row[key]["published"], row[key]["seconds"], "s", flush=True)
			results[c["name"]] = row
			json.dump(results, open(OUT, "w"), indent=1)
