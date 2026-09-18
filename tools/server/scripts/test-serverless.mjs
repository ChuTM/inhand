/**
 * tools/server/test-serverless.mjs — Local simulation of the Vercel function.
 *
 * Imports api/index.js (the ONE file Vercel runs) and drives it with mocked
 * req/res objects, mirroring exactly what the vercel.json catch-all rewrite
 * does in production: every request path is delivered to the function with
 * its ORIGINAL URL preserved. Verifies routing + storage in the serverless
 * shape:
 *
 *   /                      -> admin UI 200
 *   /api/v1/health         -> 200
 *   /api/v1/discover       -> 204 (no registration)
 *   /api/v1/admin/tokens   -> create token (POST)
 *   /api/v1/admin/register -> 200 (POST)
 *   /api/v1/discover       -> 200 signed payload
 *
 * Run: node test-serverless.mjs   (from tools/server)
 */
import { EventEmitter } from "events";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.STORAGE_DRIVER = "memory";
process.env.KEYS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wg-vercel-")), "cloud-keys.json");
process.env.ADMIN_TOKEN = "vercel-test-admin";
process.env.PUBLIC_IP_MODE = "socket";

const index = await import(path.join(__dirname, "..", "api/index.js"));

let passed = 0;
let failed = 0;
function ok(name, cond) {
	cond ? passed++ : failed++;
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
}

class FakeReq extends EventEmitter {
	constructor({ method, url, headers = {}, body }) {
		super();
		this.method = method;
		this.url = url;
		this.headers = headers;
		this.socket = { remoteAddress: "127.0.0.1" };
		if (body) {
			setImmediate(() => {
				this.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
				this.emit("end");
			});
		} else {
			setImmediate(() => this.emit("end"));
		}
	}
}

function call(fn, req) {
	return new Promise((resolve) => {
		const res = {
			statusCode: 200,
			headers: {},
			body: "",
			writeHead(status, headers = {}) {
				this.statusCode = status;
				this.headers = { ...this.headers, ...headers };
			},
			setHeader(k, v) {
				this.headers[k] = v;
			},
			end(chunk) {
				this.body += chunk || "";
				resolve(res);
			},
		};
		fn(req, res);
	});
}

console.log("\nServerless (Vercel entry) simulation\n");

// index.js -> "/" (admin UI)
{
	const r = await call(index.default, new FakeReq({ method: "GET", url: "/", headers: { host: "x.vercel.app" } }));
	ok("index.js serves admin UI", r.statusCode === 200 && r.body.includes("<html"));
}

// index.js -> /api/v1/health
{
	const r = await call(index.default, new FakeReq({ method: "GET", url: "/api/v1/health", headers: { host: "x.vercel.app" } }));
	ok("health 200", r.statusCode === 200 && JSON.parse(r.body).ok === true);
}

// index.js -> /api/v1/discover (empty)
{
	const r = await call(index.default, new FakeReq({ method: "GET", url: "/api/v1/discover", headers: { host: "x.vercel.app" } }));
	ok("discover 204", r.statusCode === 204);
}

// index.js -> /admin
{
	const r = await call(index.default, new FakeReq({ method: "GET", url: "/admin", headers: { host: "x.vercel.app" } }));
	ok("/admin serves UI", r.statusCode === 200 && r.body.includes("<html"));
}

// full flow: create token -> register -> discover
{
	const tokRes = await call(
		index.default,
		new FakeReq({
			method: "POST",
			url: "/api/v1/admin/tokens",
			headers: { host: "x.vercel.app", "x-admin-token": process.env.ADMIN_TOKEN, "content-type": "application/json" },
			body: { label: "school" },
		})
	);
	const token = JSON.parse(tokRes.body).token;
	ok("create token", tokRes.statusCode === 200 && typeof token === "string" && token.length >= 32);

	const regRes = await call(
		index.default,
		new FakeReq({
			method: "POST",
			url: "/api/v1/admin/register",
			headers: { host: "x.vercel.app", "content-type": "application/json" },
			body: { token, lanIp: "192.168.1.5", signPub: "MCowBQYDK2VwAyEAx", encPub: "MCowBQYDK2VwAyEAy" },
		})
	);
	ok("register 200", regRes.statusCode === 200 && JSON.parse(regRes.body).ok === true);

	const discRes = await call(index.default, new FakeReq({ method: "GET", url: "/api/v1/discover", headers: { host: "x.vercel.app" } }));
	const j = JSON.parse(discRes.body);
	ok("discover 200 + payload", discRes.statusCode === 200 && j.payload && j.signature);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
