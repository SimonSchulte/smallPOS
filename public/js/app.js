// Start der App: Anmeldung, Gerätename, Routing, Ereignisse, Hintergrund-Sync.

import { ApiError, OfflineError, api } from "./api.js";
import "./admin.js";
import { loadCatalog } from "./catalog.js";
import { S, acts, forms, parseRoute, render, renderChrome, renderSheet, showGate, showShell, views } from "./core.js";
import "./kasse.js";
import { metaGet, metaSet } from "./store.js";
import { createSync } from "./sync.js";
import { esc } from "./util.js";

// ---- Synchronisation ------------------------------------------------------

const sync = createSync({
  onChange: ({ pending, rejected }) => {
    S.pending = pending;
    S.rejected = rejected;
    renderChrome();
  },
  onAuthLost: () => {
    S.auth = "out";
    showLogin();
  },
});

async function ping() {
  try {
    await api("/api/session");
    S.online = true;
  } catch (e) {
    if (e instanceof OfflineError) S.online = false;
    else if (e instanceof ApiError && e.status === 401 && S.auth === "in") {
      S.auth = "out";
      showLogin();
      return;
    }
  }
  if (S.online) await sync.flush();
  else renderChrome();
}
acts.__flush = () => sync.flush();
acts.__ping = ping;

// ---- Anmeldung ------------------------------------------------------------

const L = { pin: "", error: "", busy: false };

function loginHtml() {
  const dots = Array.from({ length: Math.max(4, L.pin.length) }, (_, i) => `<i class="${i < L.pin.length ? "f" : ""}"></i>`).join("");
  const keys = [..."123456789"].map((k) => `<button data-act="pinkey" data-k="${k}">${k}</button>`).join("");
  return `<div class="login">
    <div class="club">${esc(S.cat?.settings.club_name || "Mini-Kasse")}</div>
    <h1>Kasse anmelden</h1>
    <div class="dots" aria-label="${L.pin.length} Ziffern eingegeben">${dots}</div>
    <div class="err" role="alert">${esc(L.error)}</div>
    <div class="pinpad">${keys}
      <button data-act="pinkey" data-k="C" class="ghost">Löschen</button>
      <button data-act="pinkey" data-k="0">0</button>
      <button data-act="pinkey" data-k="OK" class="okk">OK</button></div>
    <p class="muted">Nach 5 Fehlversuchen ist die Anmeldung 15 Minuten gesperrt. Dieses Gerät bleibt 14 Tage angemeldet.</p></div>`;
}
function showLogin() {
  showGate(loginHtml());
}
acts.pinkey = async (el) => {
  const k = el.dataset.k;
  if (L.busy) return;
  if (k === "C") L.pin = "";
  else if (k === "BS") L.pin = L.pin.slice(0, -1);
  else if (k === "OK") {
    if (!L.pin) return;
    L.busy = true;
    try {
      await api("/api/login", { method: "POST", body: { pin: L.pin } });
      L.pin = "";
      L.error = "";
      S.auth = "in";
      await metaSet("hasSession", true);
      await start();
    } catch (e) {
      L.pin = "";
      L.error = e instanceof OfflineError ? "Kein Netz – die Anmeldung braucht eine Verbindung." : e.message;
      showLogin();
    } finally {
      L.busy = false;
    }
    return;
  } else if (L.pin.length < 8) L.pin += k;
  showLogin();
};
document.addEventListener("keydown", (e) => {
  if (S.auth !== "out" || e.ctrlKey || e.metaKey || e.altKey || !document.querySelector(".pinpad")) return;
  const k = /^\d$/.test(e.key) ? e.key : e.key === "Backspace" ? "BS" : e.key === "Enter" ? "OK" : null;
  if (k) acts.pinkey({ dataset: { k } });
});

// ---- Gerätename -----------------------------------------------------------

function showDeviceSetup(value = "") {
  showGate(`<form class="login" data-form="deviceSetup">
    <h1>Wie heißt dieses Gerät?</h1>
    <p class="muted">Der Name wird bei jedem Verkauf mitgespeichert und im Bericht pro Gerät ausgewertet. Nur einmal nötig.</p>
    <label>Gerätename<input name="device" maxlength="40" value="${esc(value)}" required autofocus autocomplete="off" class="bigin"></label>
    <div class="chiprow">${["Kasse 1", "Kasse 2", "Ausschank", "Essen"].map((n) => `<button type="button" data-act="deviceChip" data-name="${n}">${n}</button>`).join("")}</div>
    <button class="go" type="submit">Los geht’s</button></form>`);
}
acts.deviceChip = (el) => {
  document.querySelector('[name="device"]').value = el.dataset.name;
};
forms.deviceSetup = async (form) => {
  const name = form.elements.device.value.trim();
  if (!name) return;
  S.device = name;
  await metaSet("device", name);
  await enter();
};

// ---- Start ----------------------------------------------------------------

async function enter() {
  if (!S.device) return showDeviceSetup();
  showShell();
  await route();
  sync.flush();
}

async function start() {
  S.device = (await metaGet("device")) || null;
  try {
    await loadCatalog();
    S.auth = "in";
    await metaSet("hasSession", true);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      S.auth = "out";
      return showLogin();
    }
    if (e instanceof OfflineError && (await metaGet("hasSession"))) {
      S.auth = "in"; // Kein Netz, aber dieses Gerät war schon angemeldet und hat Daten im Zwischenspeicher
    } else {
      S.auth = "out";
      L.error = "Kein Netz – die Anmeldung braucht eine Verbindung.";
      return showLogin();
    }
  }
  await enter();
}
acts.__gate = () => showLogin();

async function route() {
  S.route = parseRoute();
  if (!views[S.route.name]) S.route = { name: "kasse", args: [] };
  S.menu = false;
  const v = views[S.route.name];
  if (v.load) {
    S.data[S.route.name] = undefined;
    render();
    try {
      await v.load();
    } catch (e) {
      console.error(e);
    }
  }
  render();
}
window.addEventListener("hashchange", () => {
  if (S.auth === "in" && S.device) route();
});

// ---- Ereignisse -----------------------------------------------------------

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (el && el.getAttribute("aria-disabled") !== "true") {
    const fn = acts[el.dataset.act];
    if (fn) fn(el, e);
  }
  if (S.menu && !e.target.closest(".menu-pop") && !e.target.closest('[data-act="menu"]')) {
    S.menu = false;
    renderChrome();
  }
});
acts.menu = () => {
  S.menu = !S.menu;
  renderChrome();
};
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  await forms[form.dataset.form]?.(form);
});
document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-change]");
  if (el) acts[el.dataset.change]?.(el);
});
document.addEventListener("input", (e) => {
  const el = e.target.closest("[data-input]");
  if (el) acts[el.dataset.input]?.(el);
});
window.addEventListener("online", () => {
  S.online = true;
  ping();
});
window.addEventListener("offline", () => {
  S.online = false;
  renderChrome();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.auth === "in") ping();
});
setInterval(() => {
  if (S.auth === "in") ping();
}, 15000);
setInterval(() => {
  const c = document.getElementById("clock");
  if (c) c.textContent = new Date().toTimeString().slice(0, 5);
}, 20000);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.sheet) acts.closeSheet();
});

// Service Worker: App-Hülle offline verfügbar
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

start();
