import json
import random
import sys

from tokenizers import Tokenizer

PIECES = [
	"the", "Payment", "idempotency", "key", "retries", "cache-key", "C++", "foo_bar", "e.g.", "U.S.A.",
	"café", "résumé", "naïve", "Ünïcödé", "Ångström", "façade", "jalapeño", "ÆØÅ", "straße",
	"東京", "北京大学", "日本語のテキスト", "한국어", "안녕하세요", "Ελληνικά", "ΣΊΣΥΦΟΣ", "λόγος",
	"İstanbul", "ıi", "Привет", "мир", "مرحبا", "हिन्दी", "ภาษาไทย", "עברית",
	"🚀", "👩‍💻", "🇺🇸", "✓", "€100", "$5", "½", "²", "™", "©", "→", "≥", "∑",
	" ", "　", " ", "​", "‍", "﻿", "\u0007", "\u0000", "�", "\t", "\n", "\r\n",
	"«quoted»", "“curly”", "‘single’", "—", "–", "…", "¿qué?", "¡hola!", "#tag/nested", "[[wiki link]]",
	"x" * 101, "supercalifragilisticexpialidocious", "antidisestablishmentarianism", "123456789", "3.14159",
	"é", "ñ", "ä", "fi", "ﬁ", "Ⅻ", "ｆｕｌｌｗｉｄｔｈ", "ﾊﾝｶｸ",
]


def corpus(seed: int, count: int) -> list[str]:
	rng = random.Random(seed)
	texts = []
	for _ in range(count):
		parts = [rng.choice(PIECES) for _ in range(rng.randint(1, 12))]
		seps = [rng.choice([" ", "", "  ", ".", ",", "-", "\n"]) for _ in parts]
		texts.append("".join(p + s for p, s in zip(parts, seps)))
	return texts


if __name__ == "__main__":
	tok = Tokenizer.from_file(sys.argv[1])
	extra = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else []
	texts = list(PIECES) + extra + corpus(20261017, 400)
	rows = [{"text": t, "ids": tok.encode(t, add_special_tokens=False).ids} for t in texts]
	json.dump(rows, sys.stdout, ensure_ascii=False)
