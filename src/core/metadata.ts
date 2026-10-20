import type { NoteMetadata, PropertyValue } from "./types.ts";

// Lowercase only, no Unicode normalization: native Search treats decomposed accents as different text.
export function normalizeForMatch(text: string): string {
	return text.toLowerCase();
}

export function normalizeTag(tag: string): string {
	return normalizeForMatch(tag.startsWith("#") ? tag.slice(1) : tag);
}

export function toPropertyValue(value: unknown): PropertyValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) return value.map(toPropertyValue).filter((v) => v !== undefined);
	return undefined;
}

const unique = (items: readonly string[]): string[] => [...new Set(items)];

export interface RawMetadata {
	readonly aliases: readonly string[];
	readonly tags: readonly string[];
	readonly frontmatter: Readonly<Record<string, unknown>>;
}

export function noteMetadata(raw: RawMetadata): NoteMetadata {
	const properties: Record<string, PropertyValue> = {};
	for (const [key, value] of Object.entries(raw.frontmatter)) {
		const parsed = toPropertyValue(value);
		if (parsed !== undefined) properties[key] = parsed;
	}
	return {
		aliases: unique(raw.aliases.map((a) => a.trim()).filter((a) => a !== "")),
		tags: unique(raw.tags.map(normalizeTag).filter((t) => t !== "")).sort(),
		properties,
	};
}
