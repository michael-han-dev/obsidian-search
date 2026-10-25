import json
import sys

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

model_dir, texts_path = sys.argv[1], sys.argv[2]
texts = json.load(open(texts_path))
tok = Tokenizer.from_file(f"{model_dir}/tokenizer.json")
sess = ort.InferenceSession(f"{model_dir}/model.onnx", providers=["CPUExecutionProvider"])
names = [i.name for i in sess.get_inputs()]
cls = json.load(open(f"{model_dir}/1_Pooling/config.json")).get("pooling_mode_cls_token", False)
out = []
for text in texts:
	enc = tok.encode(text)
	ids = np.array([enc.ids[:512]], dtype=np.int64)
	mask = np.ones_like(ids)
	feeds = {"input_ids": ids, "attention_mask": mask}
	if "token_type_ids" in names:
		feeds["token_type_ids"] = np.zeros_like(ids)
	hidden = sess.run(None, feeds)[0][0]
	pooled = hidden[0] if cls else hidden.mean(axis=0)
	pooled = pooled / np.linalg.norm(pooled)
	out.append({"text": text, "ids": enc.ids, "embedding": [float(x) for x in pooled]})
json.dump({"inputs": [(i.name, i.type, i.shape) for i in sess.get_inputs()], "outputs": [(o.name, o.type, o.shape) for o in sess.get_outputs()], "rows": out}, sys.stdout)
