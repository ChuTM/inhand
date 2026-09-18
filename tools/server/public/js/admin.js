/*
 * InHand — admin console logic.
 * Loaded after api.js. Console-only page: if there is no session we bounce
 * straight back to the login page. Every privileged action goes through
 * INHAND.api, which carries the HttpOnly session cookie.
 */
"use strict";

const { $, esc, b64url, api, fmtTs, refreshMe } = INHAND;

let pubKey = "";
let latencyMs = null;
let regsCache = [];
let tokensCache = [];

// ---- console chrome -----------------------------------------------------------
function renderHeader() {
  if (!INHAND.session) return;
  $("session-info").textContent =
    `${INHAND.session.email} · ` +
    (INHAND.session.auth === "passkey"
      ? "passkey"
      : INHAND.session.auth === "google.com"
        ? "Google"
        : INHAND.session.auth);
  $("url-pill").textContent = window.location.host;
}

function showAppError(msg) {
  const el = $("app-error");
  el.textContent = msg;
  el.classList.add("visible");
}
function hideAppError() {
  $("app-error").classList.remove("visible");
}

async function loadAll() {
  const t0 = performance.now();
  try {
    const [tokens, regs, updates, admins, creds, audit, stats] = await Promise.all([
      api("/admin/tokens"),
      api("/admin/registrations"),
      api("/admin/updates"),
      api("/auth/admins"),
      api("/auth/credentials"),
      api("/auth/audit"),
      api("/admin/stats"),
    ]);
    latencyMs = Math.round(performance.now() - t0);
    tokensCache = tokens.tokens || [];
    regsCache = regs.registrations || [];
    renderTokens(tokensCache);
    renderRegistrations();
    renderUpdates(updates.updates || []);
    renderAdmins(admins.admins || []);
    renderCredentials(creds.credentials || []);
    renderAudit(audit.audit || []);
    pubKey = (stats.config && stats.config.cloudPub) || "";
    $("cloud-pub").textContent = pubKey || "unavailable";
    renderCharts(regsCache, tokensCache);
    renderPerf(tokensCache, regsCache, updates.updates || []);
    hideAppError();
  } catch (e) {
    if (String(e.message).includes("401")) {
      INHAND.session = null;
      window.location.replace("/");
      return;
    }
    showAppError("Load failed: " + e.message);
  }
}

// ---- charts & perf -------------------------------------------------------------
function dayKey(ts) {
  return new Date(ts).toLocaleDateString("en-CA");
}
function last7Buckets(items, pick) {
  const byDay = {};
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const k = d.toLocaleDateString("en-CA");
    byDay[k] = 0;
    out.push({ key: k, label: d.toLocaleDateString("en-US", { weekday: "short" }), value: 0, today: i === 0 });
  }
  for (const it of items) {
    const ts = pick(it);
    if (!ts) continue;
    const k = dayKey(ts);
    if (k in byDay) byDay[k]++;
  }
  return out.map((b) => ({ ...b, value: byDay[b.key] }));
}
function barChart(el, buckets) {
  const max = Math.max(1, ...buckets.map((b) => b.value));
  el.innerHTML = buckets.map((b) =>
    `<div class="bar-wrap" title="${b.label}: ${b.value}">
       <span class="bar-val">${b.value}</span>
       <div class="bar${b.today ? " today" : ""}" style="height:${Math.max(3, Math.round((b.value / max) * 100))}%"></div>
       <span class="bar-label">${b.label}</span>
     </div>`).join("");
}
function renderCharts(regs, tokens) {
  barChart($("reg-chart"), last7Buckets(regs, (r) => r.created_at ?? r.createdAt ?? r.expiresAt));
  barChart($("tok-chart"), last7Buckets(tokens, (t) => t.created_at ?? t.createdAt));
}
function renderPerf(tokens, regs, updates) {
  $("p-latency").textContent = latencyMs == null ? "—" : latencyMs + " ms";
  const now = Date.now();
  const activeRegs = regs.filter((r) => r.expiresAt && new Date(r.expiresAt).getTime() > now).length;
  $("p-regs").textContent = `${activeRegs} / ${regs.length}`;
  const activeTokens = tokens.filter((t) => !t.revoked).length;
  $("p-tokens").textContent = `${activeTokens} / ${tokens.length}`;
  $("p-updates").textContent = updates.length;
}

// ---- collapsible cards -----------------------------------------------------------
function toggleCard(bodyId, btn) {
  const body = $(bodyId);
  if (!body) return;
  const willOpen = body.style.display === "none";
  body.style.display = willOpen ? "block" : "none";
  if (btn) btn.classList.toggle("open", willOpen);
}
function openCard(name) {
  const ids = { updates: "updates-body", adm: "adm-body", audit: "audit-body" };
  const body = $(ids[name]);
  if (!body) return;
  if (body.style.display === "none") {
    body.style.display = "block";
    const btn = document.querySelector(`#card-${name} .card-head`);
    if (btn) btn.classList.add("open");
  }
  const card = $(`card-${name}`);
  if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- passkey enrolment -------------------------------------------------------------
async function registerPasskey() {
  try {
    const opts = await api("/auth/passkey/register/options", { method: "POST", body: { email: INHAND.session.email } });
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: Uint8Array.from(atob(opts.challenge.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
        rp: opts.rp,
        user: {
          id: Uint8Array.from(atob(opts.user.id), (c) => c.charCodeAt(0)),
          name: opts.user.name,
          displayName: opts.user.displayName,
        },
        pubKeyCredParams: opts.pubKeyCredParams,
        timeout: opts.timeout || 120000,
        attestation: opts.attestation || "none",
        authenticatorSelection: opts.authenticatorSelection,
        excludeCredentials: (opts.excludeCredentials || []).map((c) => ({
          id: Uint8Array.from(atob(c.id.replace(/-/g, "+").replace(/_/g, "/")), (x) => x.charCodeAt(0)),
          type: c.type,
          transports: c.transports,
        })),
      },
    });
    const resp = await api("/auth/passkey/register/verify", {
      method: "POST",
      body: {
        challengeId: opts.challengeId,
        response: {
          id: cred.id,
          rawId: b64url(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: b64url(cred.response.clientDataJSON),
            attestationObject: b64url(cred.response.attestationObject),
            transports: cred.response.getTransports ? cred.response.getTransports() : [],
          },
          clientExtensionResults: cred.getClientExtensionResults(),
          authenticatorAttachment: cred.authenticatorAttachment || null,
        },
      },
    });
    if (resp.ok) {
      loadAll();
      alert("Passkey registered for " + INHAND.session.email);
    }
  } catch (e) {
    alert("Passkey registration failed: " + e.message);
  }
}

// ---- token dialog ---------------------------------------------------------------
const tokenDialogForm = `
  <div class="dialog-inner">
    <h2 style="margin:0 0 4px">Create a registration token</h2>
    <p class="muted">A teacher enters this token once, when registering a school. One public IP = one registration.</p>
    <label for="token-label">Label</label>
    <input id="token-label" placeholder="e.g. ICT room — 2026 batch" autocomplete="off">
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="ghost" data-action="closeTokenDialog">Cancel</button>
      <button class="primary" data-action="createToken">Create token</button>
    </div>
    <div class="err" id="token-dialog-err"></div>
  </div>`;

function openTokenDialog() {
  const d = $("token-dialog");
  d.innerHTML = tokenDialogForm;
  d.showModal();
}
function closeTokenDialog() {
  const d = $("token-dialog");
  if (d.open) d.close();
}
async function createToken() {
  const label = ($("token-label") && $("token-label").value.trim()) || "manual";
  const errEl = $("token-dialog-err");
  if (errEl) errEl.textContent = "";
  try {
    const r = await api("/admin/tokens", { method: "POST", body: { label } });
    $("token-dialog").innerHTML = `
      <div class="dialog-inner">
        <h2 style="margin:0 0 4px">Token created</h2>
        <p class="muted">Share this one-time token with the teacher:</p>
        <div class="row">
          <input readonly id="token-value" value="${esc(r.token)}" data-select>
          <button class="primary" data-action="copyToken">Copy</button>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:14px">
          <button class="ghost" data-action="closeTokenDialog">Done</button>
        </div>
      </div>`;
    loadAll();
  } catch (e) {
    if (errEl) errEl.textContent = e.message;
  }
}
function copyToken() {
  const inp = $("token-value") || document.querySelector("#token-dialog input");
  if (!inp) return;
  inp.select();
  try { navigator.clipboard && navigator.clipboard.writeText(inp.value); } catch {}
}
function copyPub() {
  if (!pubKey) return;
  try { navigator.clipboard && navigator.clipboard.writeText(pubKey); } catch {}
  const btn = $("btn-copy");
  if (btn) {
    btn.textContent = "copied";
    setTimeout(() => { btn.textContent = "copy"; }, 1200);
  }
}

// ---- admin operations ---------------------------------------------------------------
async function revokeToken(token) {
  try {
    await api("/admin/tokens", { method: "POST", body: { revoke: true, token } });
    loadAll();
  } catch (e) { alert(e.message); }
}
async function removeReg(ip) {
  if (!confirm("Remove registration for " + ip + "?")) return;
  try { await api("/admin/registrations/" + encodeURIComponent(ip), { method: "DELETE" }); loadAll(); }
  catch (e) { alert(e.message); }
}
async function publishUpdate() {
  try {
    await api("/admin/updates", {
      method: "POST",
      body: {
        version: $("upd-version").value.trim(),
        platform: $("upd-platform").value.trim() || "mac-arm64",
        url: $("upd-url").value.trim(),
        sha256: $("upd-sha").value.trim(),
      },
    });
    ["upd-version", "upd-platform", "upd-url", "upd-sha"].forEach((id) => ($(id).value = ""));
    loadAll();
  } catch (e) { alert(e.message); }
}
async function deleteUpdate(id) {
  if (!confirm("Delete manifest #" + id + "?")) return;
  try { await api("/admin/updates/" + encodeURIComponent(id), { method: "DELETE" }); loadAll(); }
  catch (e) { alert(e.message); }
}
async function addAdmin() {
  const email = $("admin-email").value.trim();
  if (!email) return;
  try {
    await api("/auth/admins", { method: "POST", body: { email } });
    $("admin-email").value = "";
    loadAll();
  } catch (e) { alert(e.message); }
}
async function removeAdmin(email) {
  if (!confirm("Remove " + email + " from the admin team?")) return;
  try { await api("/auth/admins/" + encodeURIComponent(email), { method: "DELETE" }); loadAll(); }
  catch (e) { alert(e.message); }
}
async function deleteCredential(id) {
  if (!confirm("Remove this passkey?")) return;
  try { await api("/auth/credentials/" + encodeURIComponent(id), { method: "DELETE" }); loadAll(); }
  catch (e) { alert(e.message); }
}
async function logout() {
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  INHAND.session = null;
  window.location.replace("/");
}

// ---- rendering ----------------------------------------------------------------------
function applyFilter() {
  renderRegistrations();
}
function renderRegistrations() {
  const q = ($("search-input").value || "").toLowerCase().trim();
  const st = $("filter-select").value;
  const now = Date.now();
  const list = regsCache.filter((r) => {
    const active = r.expiresAt && new Date(r.expiresAt).getTime() > now;
    if (st === "active" && !active) return false;
    if (st === "expired" && active) return false;
    if (q) {
      const hay = `${r.schoolName || ""} ${r.publicIp || ""} ${r.lanIp || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  $("registrations-list").innerHTML = list.length
    ? `<table><colgroup><col style="width:34%"><col style="width:16%"><col style="width:18%"><col style="width:20%"><col style="width:12%"></colgroup><tr><th>School</th><th>Status</th><th>Expires</th><th>Remaining</th><th></th></tr>` +
      list.map((r) => {
        const active = r.expiresAt && new Date(r.expiresAt).getTime() > now;
        const days = r.expiresAt ? Math.max(0, Math.ceil((new Date(r.expiresAt).getTime() - now) / 86400000)) : null;
        return `<tr>
          <td>${esc(r.schoolName || "—")}<span class="sub">${esc(r.publicIp)} · ${esc(r.lanIp)}</span></td>
          <td>${active ? `<span class="badge ok">Active</span>` : `<span class="badge">Expired</span>`}</td>
          <td>${fmtTs(r.expiresAt)}</td>
          <td>${days == null ? "—" : active ? days + " day" + (days === 1 ? "" : "s") : "expired"}</td>
          <td><button class="ghost danger" data-action="removeReg" data-arg="${esc(r.publicIp)}">Remove</button></td>
        </tr>`;
      }).join("") + `</table>`
    : `<p class="empty">${q || st !== "all" ? "No registrations match your search." : "No active registrations."}</p>`;
}
function renderTokens(tokens) {
  const summary = $("tokens-summary");
  if (summary) summary.textContent = `Registration tokens (${tokens.length})`;
  $("tokens-list").innerHTML = tokens.length
    ? `<table><colgroup><col style="width:36%"><col style="width:22%"><col style="width:18%"><col style="width:14%"><col style="width:10%"></colgroup><tr><th>Token</th><th>Label</th><th>Created</th><th>Status</th><th></th></tr>` +
      tokens.map((t) => `<tr>
          <td class="mono" title="${esc(t.token || "")}">${esc(String(t.token || "").slice(0, 18))}…</td>
          <td>${esc(t.label)}</td>
          <td>${fmtTs(t.created_at ?? t.createdAt)}</td>
          <td>${t.revoked ? `<span class="badge">revoked</span>` : `<span class="badge ok">active</span>`}</td>
          <td>${t.revoked ? "" : `<button class="ghost danger" data-action="revokeToken" data-arg="${esc(t.token)}">Revoke</button>`}</td>
        </tr>`).join("") + `</table>`
    : `<p class="empty">No tokens yet — create one with “Create a Token”.</p>`;
}
function renderUpdates(updates) {
  $("updates-list").innerHTML = updates.length
    ? `<table><colgroup><col style="width:14%"><col style="width:18%"><col style="width:34%"><col style="width:18%"><col style="width:10%"></colgroup><tr><th>Version</th><th>Platform</th><th>URL</th><th>Published</th><th></th></tr>` +
      updates.map((u) => `<tr>
          <td>${esc(u.version)}</td>
          <td>${esc(u.platform)}</td>
          <td class="mono" style="font-size:11px" title="${esc(u.url)}">${esc(String(u.url || "").slice(0, 34))}…</td>
          <td>${fmtTs(u.created_at ?? u.createdAt)}</td>
          <td><button class="ghost danger" data-action="deleteUpdate" data-arg="${esc(u.id)}">Delete</button></td>
        </tr>`).join("") + `</table>`
    : `<p class="empty">No manifests published.</p>`;
}
function renderAdmins(admins) {
  $("admins-list").innerHTML = admins.length
    ? `<table><colgroup><col style="width:70%"><col style="width:20%"><col style="width:10%"></colgroup><tr><th>Email</th><th>Added</th><th></th></tr>` +
      admins.map((a) => `<tr>
          <td>${esc(a.email)}${a.email === INHAND.session.email ? ` <span class="badge ok">you</span>` : ""}</td>
          <td>${fmtTs(a.added_at ?? a.addedAt)}</td>
          <td><button class="ghost danger" data-action="removeAdmin" data-arg="${esc(a.email)}">Remove</button></td>
        </tr>`).join("") + `</table>`
    : `<p class="empty">No admins yet — add your first teammate above.</p>`;
}
function renderCredentials(creds) {
  $("credentials-list").innerHTML = creds.length
    ? `<table><colgroup><col style="width:55%"><col style="width:30%"><col style="width:15%"></colgroup><tr><th>Passkey ID</th><th>Owner</th><th></th></tr>` +
      creds.map((c) => `<tr>
          <td class="mono" style="font-size:11px" title="${esc(c.id)}">${esc(String(c.id || "").slice(0, 20))}…</td>
          <td>${esc(c.email)}</td>
          <td><button class="ghost danger" data-action="deleteCredential" data-arg="${esc(c.id)}">Remove</button></td>
        </tr>`).join("") + `</table>`
    : `<p class="empty">No passkeys enrolled yet.</p>`;
}
function renderAudit(items) {
  $("audit-list").innerHTML = items.length
    ? `<table><colgroup><col style="width:16%"><col style="width:22%"><col style="width:18%"><col style="width:34%"><col style="width:10%"></colgroup><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th><th>IP</th></tr>` +
      items.map((a) => `<tr>
          <td>${fmtTs(a.ts)}</td>
          <td class="mono">${esc(a.actor)}</td>
          <td>${esc(a.method)}</td>
          <td style="font-size:12px">${esc(a.detail)}</td>
          <td class="mono">${esc(a.ip)}</td>
        </tr>`).join("") + `</table>`
    : `<p class="empty">Nothing yet.</p>`;
}

// ---- event wiring (event delegation; no inline handlers anywhere) -----------
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  const arg = el.dataset.arg || null;
  switch (a) {
    case "logout": logout(); break;
    case "copyPub": copyPub(); break;
    case "openCard": openCard(arg); break;
    case "openTokenDialog": openTokenDialog(); break;
    case "toggleCard": toggleCard(el.dataset.body, el); break;
    case "closeTokenDialog": closeTokenDialog(); break;
    case "createToken": createToken(); break;
    case "copyToken": copyToken(); break;
    case "publishUpdate": publishUpdate(); break;
    case "addAdmin": addAdmin(); break;
    case "registerPasskey": registerPasskey(); break;
    case "revokeToken": revokeToken(arg); break;
    case "removeReg": removeReg(arg); break;
    case "deleteUpdate": deleteUpdate(arg); break;
    case "removeAdmin": removeAdmin(arg); break;
    case "deleteCredential": deleteCredential(arg); break;
  }
});
document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "search-input") applyFilter();
});
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "filter-select") applyFilter();
});
document.addEventListener("click", (e) => {
  const sel = e.target.closest("[data-select]");
  if (sel) sel.select();
});

// ---- boot: no session → back to login -----------------------------------------------
refreshMe().then(() => {
  if (!INHAND.session) {
    window.location.replace("/");
    return;
  }
  renderHeader();
  loadAll();
});
