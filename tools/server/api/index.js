/**
 * Vercel serverless function — the ONE function of the InHand cloud server.
 *
 * Lives INSIDE tools/server/ (the Vercel project root is this folder). A
 * catch-all rewrite in vercel.json sends EVERY request path ("/", "/admin",
 * "/api/v1/*", ...) here with the ORIGINAL request URL preserved, so this
 * single function runs the exact same application as the local server
 * (./app.mjs) — one contract, both deployment styles.
 *
 * Note: we deliberately do NOT use an `api/[...path].js` catch-all file —
 * the Vercel CLI (59.x) generates broken routing for it (multi-segment
 * /api/v1/* paths fall through to a 404 rule). The rewrite approach is
 * verified to preserve req.url on all path shapes.
 *
 * Config comes from environment variables (see config.mjs and README.md →
 * "Serverless deployment").
 */
import { loadConfig } from "../src/config.mjs";
import { createApp } from "../src/app.mjs";

let appPromise = null;
async function getApp() {
	if (!appPromise) {
		appPromise = createApp(loadConfig(process.argv.slice(2)));
	}
	return appPromise;
}

export default async function handler(req, res) {
	try {
		const app = await getApp();
		// req.url already carries the ORIGINAL path (rewrite preserves it).
		await app.handler(req, res);
	} catch (err) {
		console.error(`[vercel] fatal: ${err.stack || err.message}`);
		res.statusCode = 500;
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.end(JSON.stringify({ ok: false, error: "internal error" }));
	}
}
