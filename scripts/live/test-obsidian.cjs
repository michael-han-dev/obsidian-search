// Packed by harness.ts into each test profile as an obsidian-<version>.asar that outranks every real
// release, so Obsidian's loader runs it and its updater never replaces it. It then starts the real app
// from real-obsidian.asar, with two changes that keep the test instance away from the person at the Mac:
// windows open behind other windows without taking focus (unless DOWSE_TEST_WINDOWS=visible, as in
// `npm run try`), and the command-line socket that Obsidian would otherwise take over at
// ~/.obsidian-cli.sock lives in a private temporary path.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

if (process.env.DOWSE_TEST_WINDOWS !== "visible") {
	const quiet = (win) => {
		win.showInactive();
		win.blur();
	};

	BrowserWindow.prototype.show = function show() {
		quiet(this);
	};
	BrowserWindow.prototype.focus = function focus() {};

	app.on("web-contents-created", (_, contents) => {
		const setHandler = contents.setWindowOpenHandler.bind(contents);
		contents.setWindowOpenHandler = (handler) =>
			setHandler((details) => {
				const result = handler(details);
				return result.action === "allow" ? { ...result, overrideBrowserWindowOptions: { ...result.overrideBrowserWindowOptions, show: false } } : result;
			});
		contents.on("did-create-window", (win) => win.once("ready-to-show", () => quiet(win)));
	});
}

const sharedSocket = path.join(os.homedir(), ".obsidian-cli.sock");
const ownSocket = path.join(os.tmpdir(), `dowse-test-obsidian-${process.pid}.sock`);
const socket = (p) => (p === sharedSocket ? ownSocket : p);
const unlinkSync = fs.unlinkSync;
fs.unlinkSync = (p, ...rest) => unlinkSync(socket(p), ...rest);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (p, ...rest) {
	return listen.call(this, socket(p), ...rest);
};
const createConnection = net.createConnection;
net.createConnection = (p, ...rest) => createConnection(socket(p), ...rest);

const real = path.join(path.dirname(__dirname), "real-obsidian.asar");
module.exports = (_asarPath, updateEvents) => require(path.join(real, "main.js"))(real, updateEvents);
