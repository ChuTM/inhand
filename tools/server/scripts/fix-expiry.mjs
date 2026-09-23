#!/usr/bin/env node
// tools/server/scripts/fix-expiry.mjs — one-off production data migration.
//
// 1. Existing registrations: clear expiresAt so they never expire (forever).
// 2. Existing tokens flagged revoked: delete them (revoke is now a delete).
//
// Uses the Firebase service account in private/. Run from tools/server:
//   node scripts/fix-expiry.mjs

import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE = path.resolve(HERE, "../../../private");

const credFile = readdirSync(PRIVATE).find((f) => f.endsWith(".json"));
if (!credFile) {
  console.error("[fix-expiry] no service-account JSON found in private/");
  process.exit(1);
}
const serviceAccount = JSON.parse(readFileSync(path.join(PRIVATE, credFile), "utf8"));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  const regs = await db.collection("registrations").get();
  let regUpdated = 0;
  for (const doc of regs.docs) {
    const d = doc.data();
    if (d.expiresAt != null) {
      await doc.ref.update({ expiresAt: null });
      regUpdated++;
    }
  }
  console.log(`[fix-expiry] registrations: ${regs.size} total, ${regUpdated} expiry cleared (now forever)`);

  const tokens = await db.collection("tokens").get();
  let tokDeleted = 0;
  for (const doc of tokens.docs) {
    const d = doc.data();
    if (d.revoked === true) {
      await doc.ref.delete();
      tokDeleted++;
    }
  }
  console.log(`[fix-expiry] tokens: ${tokens.size} total, ${tokDeleted} revoked deleted`);

  console.log("[fix-expiry] done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[fix-expiry] failed:", err.message);
  process.exit(1);
});
