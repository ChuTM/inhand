/*
 * InHand — shared frontend runtime (loaded by both login and console pages).
 * Plain script, no modules: exposes window.INHAND with helpers, API client
 * and session state. Security: only session metadata is kept client-side;
 * the session cookie is HttpOnly and managed by the server.
 *
 * Methods deliberately reference the INHAND closure instead of `this`, so
 * they stay bound even when callers destructure them (e.g. const { api } = INHAND).
 */
"use strict";

const INHAND = (window.INHAND = {
  API: "/api/v1",
  session: null,
  hasAdmins: false,

  $(id) {
    return document.getElementById(id);
  },

  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  },

  b64url(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },

  _busy: 0,
  _spinnerEl: null,
  _ensureSpinner() {
    if (INHAND._spinnerEl) return;
    const el = document.createElement("div");
    el.className = "inhand-busy";
    el.setAttribute("role", "status");
    el.innerHTML =
      '<span class="inhand-busy-spinner" aria-hidden="true"></span>' +
      '<span class="inhand-busy-label">Working…</span>';
    document.body.appendChild(el);
    INHAND._spinnerEl = el;
  },
  _setBusy(on) {
    if (on) {
      INHAND._busy += 1;
      INHAND._ensureSpinner();
      INHAND._spinnerEl.classList.add("show");
    } else {
      INHAND._busy = Math.max(0, INHAND._busy - 1);
      if (INHAND._busy === 0 && INHAND._spinnerEl) {
        INHAND._spinnerEl.classList.remove("show");
      }
    }
  },

  async api(path, opts = {}) {
    INHAND._setBusy(true);
    try {
      const res = await fetch(INHAND.API + path, {
        method: opts.method || "GET",
        headers: opts.body ? { "Content-Type": "application/json" } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    } finally {
      INHAND._setBusy(false);
    }
  },

  fmtTs(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    return isNaN(d) ? "—" : d.toLocaleDateString();
  },

  /** GET /auth/me and store session state. Returns the me payload. */
  async refreshMe() {
    try {
      const me = await INHAND.api("/auth/me");
      INHAND.session = me.authenticated ? me.session : null;
      INHAND.hasAdmins = !!me.hasAdmins;
    } catch {
      INHAND.session = null;
      INHAND.hasAdmins = false;
    }
    return { session: INHAND.session, hasAdmins: INHAND.hasAdmins };
  },
});
