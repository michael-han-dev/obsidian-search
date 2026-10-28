// Usage: npm run release -- <x.y.z> --notes <text> [--deny <word>]... [--stable] [--dry-run]
// Publishes dist/ as the GitHub release BRAT installs. The version must already be committed and pushed.
// Rerunning after a partial failure verifies the existing release instead of creating another.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const FILES = ["main.js", "manifest.json", "styles.css"];
const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		notes: { type: "string", default: "" },
		deny: { type: "string", multiple: true, default: [] },
		stable: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
	},
});
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const succeeds = (cmd: string, args: string[]) => {
	try {
		run(cmd, args);
		return true;
	} catch {
		return false;
	}
};
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const semver = (tag: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number);
const newer = (a: string, b: string) => {
	const [x, y] = [semver(a)!, semver(b)!];
	const i = x.findIndex((part, index) => part !== y[index]);
	return i >= 0 && x[i]! > y[i]!;
};

const version = positionals[0] ?? "";
if (!semver(version) || !values.notes) throw new Error("usage: npm run release -- <x.y.z> --notes <text> [--deny <word>]... [--stable] [--dry-run]");
if (!succeeds("gh", ["auth", "status"])) throw new Error("gh is not logged in. Run gh auth login.");
if (run("git", ["status", "--porcelain"]) !== "") throw new Error("commit or stash local changes first");
run("git", ["fetch", "-q", "origin", "--tags"]);
const head = run("git", ["rev-parse", "HEAD"]);
if (head !== run("git", ["rev-parse", "@{u}"])) throw new Error("push HEAD before releasing");
const lock = await readJson("package-lock.json");
const versions: Record<string, string> = {
	"manifest.json": (await readJson("manifest.json")).version,
	"package.json": (await readJson("package.json")).version,
	"package-lock.json": lock.version,
	'package-lock.json packages[""]': lock.packages[""].version,
};
for (const [where, found] of Object.entries(versions)) if (found !== version) throw new Error(`${where} has version ${found}, not ${version}`);
if (!(await readFile("CHANGELOG.md", "utf8")).includes(`## [${version}]`)) throw new Error(`CHANGELOG.md has no ## [${version}] section`);

const exists = succeeds("gh", ["release", "view", version]);
if (exists) {
	if (run("git", ["rev-parse", `${version}^{commit}`]) !== head) throw new Error(`release ${version} exists at another commit`);
} else {
	if (succeeds("git", ["rev-parse", "-q", "--verify", `refs/tags/${version}`])) throw new Error(`tag ${version} exists without a release`);
	const tags = (JSON.parse(run("gh", ["release", "list", "--limit", "1000", "--json", "tagName"])) as { tagName: string }[]).map((r) => r.tagName);
	const blocking = tags.find((tag) => semver(tag) && !newer(version, tag));
	if (blocking) throw new Error(`${version} must be newer than release ${blocking}`);
}

execFileSync("npm", ["run", "build"], { stdio: "inherit" });
if ((await readJson("dist/manifest.json")).version !== version) throw new Error("dist/manifest.json does not match manifest.json");
const email = succeeds("git", ["config", "user.email"]) ? run("git", ["config", "user.email"]) : "";
// The bundle embeds base64 WASM, where short words turn up by chance between base64 characters.
const mentions = (text: string, word: string) => new RegExp(`(?<![A-Za-z0-9+/=])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9+/=])`, "i").test(text);
const texts: [string, string][] = [...(await Promise.all(FILES.map(async (f): Promise<[string, string]> => [`dist/${f}`, await readFile(`dist/${f}`, "utf8")]))), ["notes", values.notes]];
for (const [where, text] of texts) {
	for (const found of [homedir(), email].filter((s) => s !== "")) if (text.includes(found)) throw new Error(`${where} contains ${found}`);
	for (const word of [userInfo().username, ...values.deny]) if (mentions(text, word)) throw new Error(`${where} mentions ${word}`);
}
if (values["dry-run"]) {
	console.log(`release: ${version} passes every check. Rerun without --dry-run to publish.`);
	process.exit(0);
}

if (!exists) run("gh", ["release", "create", version, ...FILES.map((f) => `dist/${f}`), "--target", head, "--title", `Dowse ${version}`, "--notes", values.notes, ...(values.stable ? [] : ["--prerelease"])]);
const download = await mkdtemp(join(tmpdir(), "dowse-release-"));
try {
	run("gh", ["release", "download", version, "--dir", download]);
	for (const f of FILES) if ((await sha256(join(download, f))) !== (await sha256(`dist/${f}`))) throw new Error(`${f} on GitHub differs from dist/${f}`);
} finally {
	await rm(download, { recursive: true, force: true });
}
run("git", ["fetch", "-q", "origin", "--tags"]);
if (run("git", ["rev-parse", `${version}^{commit}`]) !== head) throw new Error(`tag ${version} does not point at HEAD`);
// BRAT reads the release list without signing in and installs the highest version, pre-releases included.
const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`);
if (!response.ok) throw new Error(`GitHub's public release list answered HTTP ${response.status}`);
const releases = (await response.json()) as { tag_name: string; prerelease: boolean; html_url: string; assets: { name: string }[] }[];
const published = releases.find((r) => r.tag_name === version);
if (!published) throw new Error(`release ${version} is missing from the public release list`);
if (published.prerelease === values.stable) throw new Error(`release ${version} is ${published.prerelease ? "" : "not "}marked as a pre-release`);
const assets = published.assets.map((a) => a.name).sort();
if (assets.join() !== [...FILES].sort().join()) throw new Error(`release ${version} carries ${assets.join(", ")}`);
const highest = releases.map((r) => r.tag_name).filter((tag) => semver(tag)).reduce((a, b) => (newer(b, a) ? b : a));
if (highest !== version) throw new Error(`BRAT would install ${highest}, not ${version}`);
console.log(`release: ${published.html_url}`);
console.log(`release: the uploaded files match dist/, tag ${version} is ${head.slice(0, 7)}, and BRAT installs this release`);
