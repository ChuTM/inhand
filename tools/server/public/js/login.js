/*
 * InHand — login page logic.
 * Loaded after api.js. If a session already exists we bounce straight to the
 * console; otherwise we render the provider buttons and (only while the
 * console has NO admin yet) the owner-setup token entry.
 */
"use strict";

const { $, esc, b64url, api, refreshMe } = INHAND;

let firebaseAuth = null;

function getFirebase() {
  return new Promise((resolve, reject) => {
    if (firebaseAuth) return resolve(firebaseAuth);
    const config = {
      apiKey: "AIzaSyDR4V5jFlTl3MV--Sf_9BqXG6GUYiCoDXs",
      authDomain: "inhand-software.firebaseapp.com",
      projectId: "inhand-software",
    };
    try {
      const app = firebase.initializeApp(config, "inhandAdmin");
      firebaseAuth = firebase.auth(app);
      resolve(firebaseAuth);
    } catch (e) {
      reject(e);
    }
  });
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  if (!btn.dataset.html) btn.dataset.html = btn.innerHTML;
  btn.innerHTML = busy ? '<span class="zi">Please wait…</span>' : btn.dataset.html;
}

function renderLogin() {
  $("login-error").textContent = "";
  const owner = $("owner-setup");
  if (owner) owner.style.display = (!INHAND.session && !INHAND.hasAdmins) ? "block" : "none";
}

async function googleLogin() {
  const btn = $("btn-google");
  setBusy(btn, true);
  $("login-error").textContent = "";
  try {
    const fb = await getFirebase();
    const provider = new firebase.auth.GoogleAuthProvider();
    const cred = await fb.signInWithPopup(provider);
    const idToken = await cred.user.getIdToken();
    await api("/auth/google", { method: "POST", body: { idToken } });
    await refreshMe();
    if (INHAND.session) { window.location.href = "/admin"; return; }
    renderLogin();
  } catch (e) {
    $("login-error").textContent = "Google sign-in failed: " + e.message;
  } finally {
    setBusy(btn, false);
  }
}

async function passkeyLogin() {
  const btn = $("btn-passkey");
  setBusy(btn, true);
  $("login-error").textContent = "";
  try {
    const opts = await api("/auth/passkey/login/options", { method: "POST", body: {} });
    const challenge = Uint8Array.from(
      atob(opts.challenge.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: opts.rpId,
        allowCredentials: (opts.allowCredentials || []).map((c) => ({
          id: Uint8Array.from(atob(c.id.replace(/-/g, "+").replace(/_/g, "/")), (x) => x.charCodeAt(0)),
          type: c.type,
          transports: c.transports,
        })),
        userVerification: opts.userVerification || "required",
        timeout: opts.timeout || 120000,
      },
    });
    await api("/auth/passkey/login/verify", {
      method: "POST",
      body: {
        challengeId: opts.challengeId,
        response: {
          id: assertion.id,
          rawId: b64url(assertion.rawId),
          type: assertion.type,
          response: {
            clientDataJSON: b64url(assertion.response.clientDataJSON),
            authenticatorData: b64url(assertion.response.authenticatorData),
            signature: b64url(assertion.response.signature),
            userHandle: assertion.response.userHandle ? b64url(assertion.response.userHandle) : undefined,
          },
          clientExtensionResults: assertion.getClientExtensionResults(),
        },
      },
    });
    await refreshMe();
    if (INHAND.session) { window.location.href = "/admin"; return; }
    renderLogin();
  } catch (e) {
    $("login-error").textContent = "Passkey sign-in failed: " + e.message;
  } finally {
    setBusy(btn, false);
  }
}

async function devTokenLogin() {
  const val = $("devtoken-input").value.trim();
  if (!val) return;
  try {
    await api("/auth/devtoken", { method: "POST", body: { token: val } });
    await refreshMe();
    if (INHAND.session) { window.location.href = "/admin"; return; }
    renderLogin();
  } catch (e) {
    $("login-error").textContent = "Token rejected: " + e.message;
  }
}

// ---- bind UI (no inline handlers anywhere — CSP stays strict) ----------------
$("btn-google").addEventListener("click", googleLogin);
$("btn-passkey").addEventListener("click", passkeyLogin);
$("btn-devtoken").addEventListener("click", devTokenLogin);

// ---- boot: existing session goes straight to the console --------------------
refreshMe().then(() => {
  if (INHAND.session) {
    window.location.replace("/admin");
    return;
  }
  renderLogin();
});
