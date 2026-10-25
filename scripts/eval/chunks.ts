// Usage: node scripts/eval/chunks.ts <corpus.jsonl> <maxInputTokens> <out.jsonl>
// Turns each public-set document into a note titled by the document, and writes the plugin's passage inputs as [doc, ...tokenIds] lines.
import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ENCODER, embeddingFingerprint } from "../../src/core/encoder-spec.ts";
import { extractDocument } from "../../src/core/markdown.ts";
import { noteMetadata } from "../../src/core/metadata.ts";
import { buildPassages } from "../../src/core/passages.ts";
import { createWordPieceTokenizer } from "../../src/core/tokenizer.ts";
import { VAULT_COLLECTION } from "../../src/core/types.ts";

const [corpus, tokens, outPath] = process.argv.slice(2);
const policy = { maxInputTokens: Number(tokens), maxContextTokens: 32 };
const tokenizer = createWordPieceTokenizer(await readFile("dev-assets/model/vocab.txt", "utf8"), { lowercase: ENCODER.lowercase });
const fingerprint = await embeddingFingerprint(ENCODER);
const metadata = noteMetadata({ aliases: [], tags: [], frontmatter: {} });
const out = createWriteStream(outPath!);
let passages = 0;
for await (const line of createInterface({ input: createReadStream(corpus!) })) {
	const [index, title, text]: [number, string, string] = JSON.parse(line);
	const name = title.replace(/[\\/:]/g, " ").trim() || `Document ${index}`;
	const doc = await extractDocument({ collectionId: VAULT_COLLECTION, path: `${name}.md`, text, metadata });
	for (const w of await buildPassages(doc, tokenizer, ENCODER, fingerprint, policy)) {
		out.write(`${JSON.stringify([index, ...w.input])}\n`);
		passages++;
	}
}
await new Promise((resolve) => out.end(resolve));
console.log(JSON.stringify({ corpus, policy, passages }));
