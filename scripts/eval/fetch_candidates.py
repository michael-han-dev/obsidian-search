import hashlib
import json
import os
import sys
import urllib.request

OUT = sys.argv[1] if len(sys.argv) > 1 else "dev-assets/models"
EXTRA = ["vocab.txt", "tokenizer.json", "tokenizer_config.json", "config.json", "1_Pooling/config.json", "config_sentence_transformers.json", "README.md", "LICENSE"]


def api(repo, revision):
	return json.load(urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true", timeout=60))


def sha256(path):
	h = hashlib.sha256()
	with open(path, "rb") as f:
		for chunk in iter(lambda: f.read(1 << 20), b""):
			h.update(chunk)
	return h.hexdigest()


manifest = []
for c in json.load(open(os.path.join(os.path.dirname(__file__), "candidates.json"))):
	info = api(c["repo"], c["revision"])
	if info["sha"] != c["revision"]:
		sys.exit(f"{c['repo']}: API answered revision {info['sha']}, expected {c['revision']}")
	siblings = {s["rfilename"]: s for s in info["siblings"]}
	files = {}
	for name in [c["onnx"], *EXTRA]:
		s = siblings.get(name)
		if s is None:
			continue
		target = os.path.join(OUT, c["name"], name)
		os.makedirs(os.path.dirname(target), exist_ok=True)
		if not (os.path.exists(target) and os.path.getsize(target) == s["size"]):
			urllib.request.urlretrieve(f"https://huggingface.co/{c['repo']}/resolve/{c['revision']}/{name}", target)
		digest = sha256(target)
		published = (s.get("lfs") or {}).get("sha256")
		if published and digest != published:
			sys.exit(f"{c['repo']}/{name}: sha256 {digest} does not match published {published}")
		files[name] = {"bytes": s["size"], "sha256": digest, "publishedSha256": published}
	card = info.get("cardData") or {}
	license_tags = [t.removeprefix("license:") for t in info.get("tags", []) if t.startswith("license:")]
	manifest.append({**c, "license": card.get("license") or license_tags, "files": files})
	print(c["name"], files[c["onnx"]]["bytes"], "ok", flush=True)
json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
