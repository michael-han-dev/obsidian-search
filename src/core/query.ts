import { normalizeForMatch, normalizeTag } from "./metadata.ts";
import type { Constraint, ParsedQuery, PropertyLiteral, Test } from "./types.ts";

export type ParseResult = { readonly ok: true; readonly query: ParsedQuery } | { readonly ok: false; readonly error: string };

const OPERATOR = /^([A-Za-z][\w.-]*):/;
const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const GROUPING = /\(\s*(?:-?"|-?[A-Za-z][\w.-]*:\S)/;
const NATIVE_ONLY = new Set(["content", "line", "block", "section", "task", "task-todo", "task-done", "match-case", "ignore-case"]);
const SUPPORTED = "Dowse understands file:, path:, tag:, and property.NAME:.";

class QueryError extends Error {}

function readQuoted(input: string, start: number): { value: string; end: number } {
	let value = "";
	for (let i = start + 1; i < input.length; i++) {
		const ch = input[i]!;
		if (ch === '"') return { value, end: i + 1 };
		if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
			value += input[++i];
			continue;
		}
		value += ch;
	}
	throw new QueryError(`Close the quote after "${value}.`);
}

function readBare(input: string, start: number): { value: string; end: number } {
	let end = start;
	while (end < input.length && !/\s/.test(input[end]!)) end++;
	return { value: input.slice(start, end), end };
}

function filterTest(name: string, value: string, quoted: boolean): Test {
	if (!quoted && value.length > 2 && value.startsWith("/") && value.endsWith("/")) {
		throw new QueryError(`${name}:${value} is a regular expression in Obsidian's Search, which Dowse doesn't support. To match the text, quote it: ${name}:"${value}".`);
	}
	if (value === "") throw new QueryError(`Add a value after ${name}:.`);
	if (name === "file") return { kind: "file", text: normalizeForMatch(value) };
	if (name === "path") return { kind: "path", text: normalizeForMatch(value.replaceAll("\\", "/")) };
	if (name === "tag") {
		const tag = normalizeTag(value);
		if (tag === "") throw new QueryError("Add a tag name after tag:#.");
		return { kind: "tag", tag };
	}
	const key = name.slice("property.".length);
	if (key === "") throw new QueryError("Name the property, as in property.status:done.");
	const literal: PropertyLiteral = quoted ? normalizeForMatch(value) : value === "true" ? true : value === "false" ? false : NUMBER.test(value) ? Number(value) : normalizeForMatch(value);
	return { kind: "property", key: normalizeForMatch(key), value: literal };
}

function parseOrThrow(input: string): ParsedQuery {
	if (GROUPING.test(input)) throw new QueryError("Dowse doesn't group searches with parentheses. Remove them; all filters must match.");
	const constraints: Constraint[] = [];
	const words: string[] = [];
	let i = 0;
	while (i < input.length) {
		if (/\s/.test(input[i]!)) {
			i++;
			continue;
		}
		const negated = input[i] === "-" && i + 1 < input.length && !/\s/.test(input[i + 1]!);
		const start = negated ? i + 1 : i;
		if (input[start] === '"') {
			const { value, end } = readQuoted(input, start);
			if (value === "") throw new QueryError("Put text inside the quotes, or remove them.");
			constraints.push({ negated, test: { kind: "text", text: normalizeForMatch(value) } });
			i = end;
			continue;
		}
		const operator = OPERATOR.exec(input.slice(start));
		const valueStart = start + (operator?.[0].length ?? 0);
		const hasValue = valueStart < input.length && !/\s/.test(input[valueStart]!);
		if (operator) {
			const name = operator[1]!.toLowerCase();
			if (name === "collection") throw new QueryError("Dowse searches this vault only for now, so collection: isn't available. Remove it.");
			if (NATIVE_ONLY.has(name)) throw new QueryError(`${name}: is a native Search operator that Dowse doesn't support. Use Obsidian's Search for it.`);
			const known = name === "file" || name === "path" || name === "tag" || name.startsWith("property.");
			if (known) {
				const quoted = input[valueStart] === '"';
				const { value, end } = quoted ? readQuoted(input, valueStart) : readBare(input, valueStart);
				constraints.push({ negated, test: filterTest(name, value, quoted) });
				i = end;
				continue;
			}
			if (hasValue) throw new QueryError(`Unknown filter ${operator[1]}:. ${SUPPORTED} To search for this text, put it in quotes.`);
		}
		const { value, end } = readBare(input, start);
		i = end;
		if (value === "OR") throw new QueryError("Dowse combines everything with AND, so OR isn't supported. Run separate searches instead.");
		if (value.startsWith("[") && value.includes(":")) throw new QueryError(`Write property filters as property.NAME:VALUE, not ${value}.`);
		if (value.length > 2 && value.startsWith("/") && value.endsWith("/")) throw new QueryError(`${value} looks like a regular expression, which Dowse doesn't support. To match the text, quote it.`);
		if (negated) constraints.push({ negated, test: { kind: "word", word: normalizeForMatch(value) } });
		else words.push(value);
	}
	return { constraints, relevance: words.join(" ") };
}

export function parseQuery(input: string): ParseResult {
	try {
		return { ok: true, query: parseOrThrow(input) };
	} catch (error) {
		if (error instanceof QueryError) return { ok: false, error: error.message };
		throw error;
	}
}
