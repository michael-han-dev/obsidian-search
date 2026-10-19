import { blake3 } from "hash-wasm";
import type { Digest } from "./types.ts";

export async function digest(data: string | Uint8Array): Promise<Digest> {
	return `blake3:${await blake3(data)}` as Digest;
}
