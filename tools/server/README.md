# InHand Cloud Server (tools/server)

A fully functional, locally runnable implementation of the InHand cloud
backend: teacher registration, discovery, update manifests, registration-token
management, and a management web UI. It speaks the exact API contract the
clients already implement, so you can run it locally against real host + client
builds, then deploy it (or its contract) to the official server later.

Zero third-party dependencies (Node ≥ 22.5 — uses the built-in `node:sqlite`).

```
npm start            # node scripts/server.mjs  (reads config.json if present)
npm test             # node scripts/test.mjs  (e2e over the real HTTP surface)
node scripts/interop.mjs            # drives the server with the REAL host/client crypto libs
node scripts/test-serverless.mjs    # verifies the Vercel entry (api/index.js)
```

Layout (everything is grouped by concern — nothing dumped in the root):

```
tools/server/
├── api/index.js        # the ONE Vercel serverless function (entry)
├── src/                # server code
│   ├── app.mjs         # routes, static serving, rate limit, audit wiring
│   ├── auth.mjs        # Cloud Admin: sessions, WebAuthn passkeys, Google
│   ├── config.mjs      # env > config.json > defaults
│   ├── crypto.mjs      # cloud Ed25519/X25519 keypair + signing
│   ├── storage.mjs     # storage driver factory
│   └── drivers/        # memory / json / sqlite / firestore
├── scripts/            # local bootstrap + test harnesses
│   ├── server.mjs      # node:http bootstrap (+ sweep timer)
│   ├── test.mjs        # full e2e suite
│   ├── test-serverless.mjs
│   └── interop.mjs
└── public/             # frontend (HTML / CSS / JS split, login ≠ console)
    ├── index.html      # login page only
    ├── admin.html      # console only
    ├── css/            # base.css (shared) + login.css + admin.css
    └── js/             # api.js (shared) + login.js + admin.js
```

All rounded corners use `corner-shape: squircle` (progressive enhancement on
top of `border-radius`; unsupported browsers fall back to plain rounding).

## Quick start

```bash
cp config.example.json config.json   # optional; everything works without it
node scripts/server.mjs
```

On first boot the server:

1. creates its cloud Ed25519 keypair at `data/cloud-keys.json` (0600),
2. creates the SQLite database at `data/server.db` (if `STORAGE_DRIVER=sqlite`),
3. prints the cloud public key (copy it into `client/config.json` → `cloudPub`),
4. prints a generated admin token if you did not set `ADMIN_TOKEN`.

Open the management UI at `http://127.0.0.1:8787/admin`, paste the admin token,
then create a registration token for the teacher.

## Public API (what the clients call)

Base path defaults to `/api/v1` (`BASE_PATH`).

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST {base}/admin/register` | `{token, lanIp, signPub, encPub, info?{schoolName}}` | `200 {ok, registrationId, heartbeatMs, expiresInMs}` | `400` invalid fields · `401` bad token · `409` public IP already registered by another teacher |
| `POST {base}/admin/unregister` | `{token}` | `200 {ok}` | `401` bad token · `404` not registered |
| `GET {base}/discover` | — | `200 {payload, signature}` | `204` no registration for this public IP |
| `GET {base}/update?platform=` | — | `200 {version, url, sha256, signature}` | `404` no manifest |
| `GET {base}/health` | — | `200 {ok, …stats}` | — |

**Signature rules** (verified by the real clients):

- `discover`: `signature = Ed25519(cloudPriv, base64(payload))` where
  `payload = base64(JSON{lanIp, signPub, encPub, schoolName, ts, expiresAt})`.
  During the key-rotation grace window the payload additionally carries
  `prevSignPub / prevEncPub / prevSince`.
- `update`: `signature = Ed25519(cloudPriv, JSON.stringify({version, url, sha256}))`
  (exact key order matters).

**Registration semantics:**

- The public IP is taken from the request (`PUBLIC_IP_MODE`). One public IP =
  one teacher (`409`), enforcing the one-school-per-IP model.
- Re-registering with the same token is a heartbeat; `expiresAt` is extended to
  `now + REGISTRATION_TTL_MS`.
- Registering with a *different* `signPub` is a key rotation: the previous key
  pair is kept and exposed via `prevSignPub` for `KEY_GRACE_MS` so not-yet-
  updated clients keep verifying.
- Expired registrations are swept on `SWEEP_INTERVAL_MS`.

## Management API (admin token)

Send `X-Admin-Token: <token>` (or `Authorization: Bearer <token>`).

| Method & path | Body | Purpose |
|---|---|---|
| `GET {base}/admin/tokens` | — | list registration tokens |
| `POST {base}/admin/tokens` | `{label}` | create a registration token |
| `DELETE {base}/admin/tokens/:token` | — | revoke a token |
| `GET {base}/admin/registrations` | — | list live registrations |
| `DELETE {base}/admin/registrations/:publicIp` | — | force-remove a registration |
| `GET {base}/admin/updates` | — | list update manifests |
| `POST {base}/admin/updates` | `{version, url, sha256, platform?}` | publish a manifest (clients auto-update on their next poll) |
| `DELETE {base}/admin/updates/:id` | — | remove a manifest |
| `GET {base}/admin/stats` | — | driver/stats/uptime/cloud public key |

## Configuration (customization)

Priority: **environment variable > config.json > default**. The example file
`config.example.json` documents every key:

| Key | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8787` | listen address |
| `BASE_PATH` | `/api/v1` | API prefix — change to `/api/v2` etc. |
| `STORAGE_DRIVER` | `sqlite` | `sqlite` \| `json` \| `memory` (see below) |
| `DB_FILE` | `data/server.db` | SQLite file (`:memory:` allowed) |
| `JSON_FILE` | `data/data.json` | JSON driver file |
| `KEYS_FILE` | `data/cloud-keys.json` | cloud keypair (0600) |
| `ADMIN_TOKEN` | `""` | empty → random token printed at boot |
| `REGISTRATION_TTL_MS` | `3600000` | heartbeat expiry |
| `SWEEP_INTERVAL_MS` | `60000` | expiry sweep cadence |
| `KEY_GRACE_MS` | `86400000` | key-rotation grace window |
| `PUBLIC_IP_MODE` | `auto` | `auto` (x-forwarded-for → socket), `socket`, or `header:<NAME>` |
| `RATE_LIMIT` / `RATE_LIMIT_WINDOW_MS` | `300` / `60000` | per-IP limit on public routes (`0` disables) |
| `VERBOSE` | `true` | request logging |
| `LOG_FILE` | `""` | JSONL access log path |

Any key can be overridden per-run:

```bash
PORT=9000 STORAGE_DRIVER=json ADMIN_TOKEN=secret node scripts/server.mjs
```

## Storage drivers (pluggable "database API")

`tools/server/src/storage.mjs` defines the interface; every driver implements it:

```
init(config)
getRegistration(publicIp) / listRegistrations() / upsertRegistration(reg)
deleteRegistration(publicIp) / sweepExpired(now)
createToken(label) / listTokens() / revokeToken(token) / tokenValid(token)
listUpdates() / getCurrentUpdate(platform?) / publishUpdate(update) / deleteUpdate(id)
stats() / close()
```

Included drivers:

- `sqlite` (default) — `node:sqlite`, WAL mode, real schema (see
  `src/drivers/sqlite.mjs`). Zero deps.
- `json` — one atomic JSON file. Simple and portable.
- `memory` — process-lifetime only; used by the test suite.

**Adding your own** (e.g. Postgres/MySQL/Mongo): create `src/drivers/<name>.mjs`
implementing the interface above, register it in the `DRIVERS` map in
`src/storage.mjs`, and select it with `STORAGE_DRIVER=<name>`. The server and its
routes never change.

The route table in `src/app.mjs` is also declarative — add, rename, or guard an
endpoint by editing one line.

## Deployment notes

- This build can run **locally** (plain `node:http`, `node scripts/server.mjs`) or as a
  **serverless function** (Vercel / Cloud Functions) using Firebase Firestore
  as the database. Both styles run the exact same application
  (`src/app.mjs` → `createApp()`), so the API contract is identical.
- The clients reach the server via the base URL configured by `WP_API_URL`
  (env) / `client/config.json` `apiUrl` / `install.sh -a`. `ADMIN_TOKEN`
  protects all management endpoints — set it to a long random value in
  production.
- The `tools/mock-cloud/` server is superseded by this one; it is kept only as
  a historical reference.

## Serverless deployment (Vercel + Firebase)

Serverless functions are request-scoped and have an ephemeral filesystem, so
the deployment model differs from local mode in three ways:

| Concern | Local (`node scripts/server.mjs`) | Serverless (Vercel) |
| --- | --- | --- |
| HTTP entry | `scripts/server.mjs` (node:http + timers) | `api/index.js` (ONE function; `vercel.json` catch-all rewrite sends every path to it) |
| Storage | sqlite / json / memory (files) | `firestore` driver (Firebase Firestore) |
| Cloud signing key | `data/cloud-keys.json` (0600) | `CLOUD_KEYPAIR_JSON` env var (base64) |
| Expired registrations | background sweep timer | self-healing on read (register/discover), optional `POST /admin/sweep` |

### 1. Generate the cloud keypair (do this ONCE, keep it private)

```bash
cd tools/server
node -e "import('./src/crypto.mjs').then(m=>{const k=m.generateKeyPair();console.log('CLOUD_KEYPAIR_JSON='+Buffer.from(JSON.stringify(k)).toString('base64'))})"
```

Copy the output; it becomes the `CLOUD_KEYPAIR_JSON` env var. **Clients cache
the cloud public key in `client/config.json` (`cloudPub`)**, so keep this
keypair forever — rotating it requires updating every client.

### 2. Firebase project

1. Create a Firebase project and enable **Cloud Firestore** (production mode).
2. Add a service account (`Project settings → Service accounts → Generate new
   private key`).
3. Store the service-account JSON base64-encoded as the
   `FIREBASE_CREDENTIALS_JSON` env var:

```bash
base64 -i path/to/service-account.json   # macOS/Linux
```

(The individual `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` /
`FIREBASE_PRIVATE_KEY` vars are also supported.)

### 3. Vercel environment variables

Set these in the Vercel project (Settings → Environment Variables) — every
one of them, or the function refuses to boot loudly (that is intentional):

```
STORAGE_DRIVER=firestore
CLOUD_KEYPAIR_JSON=<from step 1>
FIREBASE_CREDENTIALS_JSON=<from step 2>
ADMIN_TOKEN=<long random secret>
PUBLIC_IP_MODE=auto
SESSION_SECRET=<openssl rand -base64 32>
```

Optional: `BASE_PATH` (default `/api/v1`), `REGISTRATION_TTL_MS`,
`KEY_GRACE_MS`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `LOG_LEVEL`.

Admin-auth tuning (all optional; defaults are the secure choice):
`ALLOW_EMAIL_PASSWORD=false` (flip to `true` to re-enable email/password
sign-in), `ALLOWED_ADMIN_EMAILS=alice@school.edu,bob@school.edu` (one-time
bootstrap of the first admins — after that, manage the team from the console),
`RP_ID=inhand-server.vercel.app`, `RP_ORIGINS=https://inhand-server.vercel.app,...`.
`SESSION_TTL_MS` defaults to 12h.

### 4. Deploy

The Vercel project root is **this folder** (`tools/server/`) — all Vercel
files live here, nothing sits in the repo root. The deployment is named
**inhand-server** (production alias: `https://inhand-server.vercel.app`).

```bash
cd tools/server
npm i                      # installs firebase-admin (this folder's package.json)
npx vercel link --project inhand-server   # once; stores .vercel/ here (gitignored)
npx vercel deploy --prod --yes            # every redeploy
```

### 5. Cloud Admin authentication (Google + passkey)

The admin console at `/admin` no longer relies on a single shared token.
Sign-in is **Google (Firebase Auth) or a WebAuthn passkey** — either one
works, and the email must be on the allowlist. Email + password sign-in is
implemented but **disabled** server-side (`ALLOW_EMAIL_PASSWORD=false`; flip
to re-enable later). The legacy `ADMIN_TOKEN` is kept strictly as a
first-run bootstrap / CLI debugging fallback — every use is audited.

**Session** — an HMAC-signed HttpOnly cookie (`SESSION_SECRET`, 12h TTL).
**Allowlist** — `admins` collection/table (email → uid). First admin:
set `ALLOWED_ADMIN_EMAILS` once, sign in with Google, then add teammates
from the console. **Passkeys** — `webauthn_credentials` collection/table;
enrol from the console after signing in. **Audit** — every privileged action
(who, what, when, IP) lands in the `audit` / `admin_audit` store and is
viewable in the console.

Firebase console (free Spark plan, do once):
1. Authentication → Sign-in method → enable **Google**.
2. Authentication → Settings → Authorized domains: add
   `inhand-server.vercel.app` (localhost is already allowed for `vercel dev`).

No paid features are used: no Identity Platform, no TOTP/SMS, no Firebase
native passkeys — WebAuthn is implemented in-process with
`@simplewebauthn/server`.

API (all under `/api/v1`, JSON):

| Method | Path | Purpose |
|---|---|---|
| POST | `auth/google` | exchange Firebase ID token for a session cookie |
| POST | `auth/passkey/login/options` | start passkey assertion (public) |
| POST | `auth/passkey/login/verify` | finish passkey assertion → cookie |
| POST | `auth/passkey/register/options` | start passkey enrolment (needs session) |
| POST | `auth/passkey/register/verify` | finish enrolment (needs session) |
| POST | `auth/devtoken` | bootstrap/dev sign-in with `ADMIN_TOKEN` |
| GET | `auth/me` | current session |
| POST | `auth/logout` | clear session |
| GET/POST | `auth/admins` | list / add allowlisted admin |
| DELETE | `auth/admins/<email>` | remove allowlisted admin |
| GET | `auth/credentials` | list enrolled passkeys |
| DELETE | `auth/credentials/<id>` | revoke a passkey |
| GET | `auth/audit` | audit log (latest 100) |

Existing admin endpoints accept either the session cookie or the legacy
`X-Admin-Token` header.


Why a single `api/index.js` + a catch-all rewrite instead of an
`api/[...path].js` catch-all file: the Vercel CLI (59.x) generates broken
routing for an `api-dir` catch-all — only single-segment `/api/<x>` paths are
forwarded, multi-segment paths like `/api/v1/health` fall through to a 404
rule and `/` never reaches the index function. A `vercel.json` rewrite
(`/(.*)` → `/api/index`) sends every path to the one function with the
original URL preserved; this is verified working for `/`, `/admin` and all
`/api/v1/*` shapes. `test-serverless.mjs` simulates exactly this shape.

### Firestore data model (what the driver manages)

```
registrations/<publicIp>   one active teacher per public IP (one school)
tokens/<token>             registration tokens (revoked flag)
updates/<platform>         CURRENT update manifest per platform ("mac-arm64")
updates_history/<autoId>   manifest history (list/delete)
```

Single-document reads are strongly consistent, which keeps the
one-school-per-IP registration + discover flow correct without extra indices.

### Serverless caveats (read before relying on it)

- **Rate limiting is per-function-instance and advisory only.** Vercel spawns
  many instances; a determined attacker can exceed per-instance limits. The
  registration token + signature verification remain the real gate.
- **The admin UI is served by the same function** (`/` and `/admin`). No
  static file hosting is needed.
- **Sweeps are lazy.** Expired registrations are treated as absent on
  register/discover, so correctness does not depend on any timer. To clean up
  storage explicitly, call `POST /api/v1/admin/sweep` with `X-Admin-Token`; a
  Vercel Cron (`vercel.json`) can hit it periodically if you want.
- **Vercel Hobby functions have a 10 s max duration** (the `functions` config
  was removed from `vercel.json` because it corrupts route generation). All
  handlers complete in well under that with Firestore.
- **Firestore egress is billed** on the project's Firestore quota. A classroom
  (≤ a few hundred students × 1 discover / 60 s) stays well within the free
  tier.
- **Local tests** (`scripts/test.mjs`, `scripts/interop.mjs`,
  `scripts/test-serverless.mjs`) run
  without Firebase (memory driver); `test-serverless.mjs` simulates the Vercel
  entry points locally.
