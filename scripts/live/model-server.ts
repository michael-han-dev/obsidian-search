import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { EncoderSpec } from "../../src/core/encoder-spec.ts";

export type ServeMode = { readonly kind: "normal"; readonly bytesPerSecond?: number } | { readonly kind: "refuse"; readonly status: number } | { readonly kind: "cut"; readonly afterBytes: number } | { readonly kind: "corrupt" };

export interface ServedRequest {
	readonly path: string;
	readonly range: string | null;
	readonly status: number;
	sentBytes: number;
	closedEarly: boolean;
}

export interface ModelServer {
	readonly baseUrl: string;
	readonly requests: ServedRequest[];
	mode: ServeMode;
	close(): Promise<void>;
}

const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range, content-length" };

export async function startModelServer(spec: EncoderSpec, modelDir: string): Promise<ModelServer> {
	const files = new Map<string, Buffer>();
	for (const file of [spec.model, spec.vocab]) files.set(`/${spec.id}/resolve/${spec.revision}/${file.path}`, await readFile(join(modelDir, file.name)));
	const requests: ServedRequest[] = [];
	const state = { mode: { kind: "normal" } as ServeMode };

	const send = (res: ServerResponse, body: Buffer, record: ServedRequest, mode: ServeMode) => {
		const limit = mode.kind === "cut" ? Math.min(mode.afterBytes, body.length) : body.length;
		const rate = mode.kind === "normal" ? mode.bytesPerSecond : undefined;
		const chunk = 256 * 1024;
		let at = 0;
		const next = () => {
			if (res.destroyed) {
				record.closedEarly = at < body.length;
				return;
			}
			if (at >= limit) {
				if (limit < body.length) {
					record.closedEarly = true;
					res.destroy();
				} else res.end();
				return;
			}
			const piece = body.subarray(at, Math.min(at + chunk, limit));
			at += piece.length;
			record.sentBytes = at;
			res.write(piece);
			setTimeout(next, rate ? (1000 * piece.length) / rate : 0);
		};
		res.on("close", () => {
			if (at < body.length) record.closedEarly = true;
		});
		next();
	};

	const server = createServer((req, res) => {
		const path = decodeURIComponent((req.url ?? "").split("?")[0]!);
		if (req.method === "OPTIONS") {
			res.writeHead(204, { ...CORS, "access-control-allow-headers": "range" });
			return res.end();
		}
		const mode = state.mode;
		const range = req.headers.range ?? null;
		let body = files.get(path);
		if (!body) {
			requests.push({ path, range, status: 404, sentBytes: 0, closedEarly: false });
			res.writeHead(404, CORS);
			return res.end();
		}
		if (mode.kind === "refuse") {
			requests.push({ path, range, status: mode.status, sentBytes: 0, closedEarly: false });
			res.writeHead(mode.status, CORS);
			return res.end();
		}
		if (mode.kind === "corrupt" && path.endsWith(spec.model.path)) {
			body = Buffer.from(body);
			body.writeUInt8(body.readUInt8(body.length >> 1) ^ 0xff, body.length >> 1);
		}
		const start = Number(/^bytes=(\d+)-$/.exec(range ?? "")?.[1] ?? 0);
		const status = start > 0 ? 206 : 200;
		const record: ServedRequest = { path, range, status, sentBytes: 0, closedEarly: false };
		requests.push(record);
		const slice = body.subarray(start);
		res.writeHead(status, { ...CORS, "content-length": slice.length, ...(start > 0 ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
		send(res, slice, record, mode);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		get mode() {
			return state.mode;
		},
		set mode(mode: ServeMode) {
			state.mode = mode;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
