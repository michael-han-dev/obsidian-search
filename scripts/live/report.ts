import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function createReport() {
	const report: Record<string, unknown> = {};
	const failures: string[] = [];
	return {
		step(name: string, value: unknown): void {
			report[name] = value;
			console.log(name, JSON.stringify(value));
		},
		expect(name: string, ok: boolean, detail: unknown = null): void {
			if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
			console.log(ok ? "PASS" : "FAIL", name, ok ? "" : JSON.stringify(detail));
		},
		async finish(path: string): Promise<void> {
			report.failures = failures;
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(report, null, 1)}\n`);
			console.log(failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED`);
			if (failures.length > 0) process.exitCode = 1;
		},
	};
}

export async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]))));
	return nested.flat();
}
