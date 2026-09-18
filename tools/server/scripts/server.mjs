/**
 * tools/server/server.mjs — Local development/production bootstrap.
 *
 * Starts the same application as the Vercel serverless deployment
 * (see app.mjs) as a plain node:http server with a periodic sweep timer.
 *
 *   node server.mjs [--port 8787] [--host 0.0.0.0] [--driver firestore]
 *
 * Environment variables override everything (see config.mjs).
 */

import http from "http";
import { loadConfig } from "../src/config.mjs";
import { createApp } from "../src/app.mjs";

const config = loadConfig(process.argv.slice(2));
const app = await createApp(config);

if (!config.ADMIN_TOKEN) {
	console.log("\n  [admin] ADMIN_TOKEN not configured — generated for this run:");
	console.log(`          ${app.adminToken}\n`);
}

const server = http.createServer(app.handler);

const sweepTimer = setInterval(async () => {
	try {
		const removed = await app.sweep();
		if (removed) app.log(`sweep: removed ${removed} expired registration(s)`);
	} catch (err) {
		app.log(`sweep error: ${err.message}`);
	}
}, config.SWEEP_INTERVAL_MS);
sweepTimer.unref();

server.listen(config.PORT, config.HOST, () => {
	console.log("\n  InHand cloud server");
	console.log(`  Listening on http://${config.HOST}:${config.PORT}`);
	console.log(`  Base path:  ${config.BASE_PATH}`);
	console.log(`  Storage:    ${config.STORAGE_DRIVER}`);
	console.log(`  Admin UI:   http://${config.HOST}:${config.PORT}/admin`);
	console.log(`  Cloud pub:  ${app.cloudKeys.signPub}`);
	console.log("");
});

async function shutdown() {
	clearInterval(sweepTimer);
	await app.storage.close();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
