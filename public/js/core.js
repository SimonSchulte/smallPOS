// Gemeinsamer Zustand und Rendering-Grundlagen. Views und Aktionen registrieren sich hier.

import { esc, fmtTime } from "./util.js";

export const S = {
  auth: "unknown", // unknown | in | out
  cat: null, // { settings, groups, articles, event }
  device: null,
  online: navigator.onLine,
  pending: 0,
  rejected: 0,
  menu: false,
  toast: null,
  sheet: null,
  data: {}, // geladene Daten je View
  route: { name: "kasse", args: [] },
};

/** Aktionen: data-act="name" im HTML ruft acts.name(element, event) auf. */
export const acts = {};
/** Views: { render(): string, load?(): Promise, after?(root) } */
export const views = {};
/** Formulare: data-form="name" ruft forms.name(formElement) beim Absenden auf. */
export const forms = {};

const $ = (id) => document.getElementById(id);

export function parseRoute() {
  const parts = (location.hash.replace(/^#\/?/, "") || "kasse").split("/");
  return { name: parts[0], args: parts.slice(1).map(decodeURIComponent) };
}

export const NAV = [
  { name: "kasse", label: "Kassieren", href: "#/kasse", icon: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 12h2M12 12h2M8 16h2M12 16h2"/>' },
  { name: "verkaeufe", label: "Verkäufe", href: "#/verkaeufe", icon: '<path d="M8 6h12M8 12h12M8 18h12M4 6h0M4 12h0M4 18h0"/>' },
  { name: "bericht", label: "Bericht", href: "#/bericht", icon: '<path d="M5 20V10M12 20V4M19 20v-7"/>' },
  { name: "verwaltung", label: "Verwaltung", href: "#/verwaltung/artikel", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>' },
];
const activeNav = () => ({ bon: "verkaeufe", kassensturz: "bericht" })[S.route.name] || S.route.name;

export const icon = (paths, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export function showGate(html) {
  $("shell").hidden = true;
  const g = $("gate");
  g.hidden = false;
  g.innerHTML = html;
  g.querySelector("[autofocus]")?.focus();
}

export function showShell() {
  $("gate").hidden = true;
  $("gate").innerHTML = "";
  $("shell").hidden = false;
}

/** Kopfzeile, Hinweisband, Navigation, Menü: wird auch bei Hintergrund-Ereignissen (Sync) erneuert. */
export function renderChrome() {
  if ($("shell").hidden) return;
  const ev = S.cat?.event;
  let chip;
  if (S.pending > 0 || S.rejected > 0) {
    chip = `<span class="chip warn">${S.pending + S.rejected} nicht synchronisiert</span>`;
  } else if (!S.online) {
    chip = `<span class="chip warn">Kein Netz</span>`;
  } else {
    chip = `<span class="chip">● Synchron</span>`;
  }
  $("hdr").innerHTML = `
    <button class="mb narrow-only" data-act="menu" aria-label="Menü" aria-expanded="${S.menu}">${icon('<path d="M4 7h16M4 12h16M4 17h16"/>').replace('stroke-width="2"', 'stroke-width="2.5"')}</button>
    <div class="ttl"><small>${esc(ev ? ev.name : "Keine aktive Veranstaltung")}</small><b>${esc(S.device || "")}</b></div>
    ${chip}
    <span class="clock wide-only" id="clock">${fmtTime(new Date().toISOString())}</span>`;

  const parts = [];
  if (S.pending > 0) {
    parts.push(`${S.pending} ${S.pending === 1 ? "Verkauf" : "Verkäufe"} noch nicht synchronisiert${S.online ? " – wird gesendet …" : " – kein Netz, alles ist sicher auf diesem Gerät gespeichert."}`);
  }
  if (S.rejected > 0) parts.push(`${S.rejected} Verkauf vom Server abgelehnt – siehe Letzte Verkäufe.`);
  if (!parts.length && !S.online) parts.push("Kein Netz – Verkäufe werden auf diesem Gerät gespeichert und später gesendet.");
  $("banner").className = "banner no-print" + (parts.length ? "" : " empty");
  $("banner").innerHTML = parts.map(esc).join("<br>");

  const active = activeNav();
  const links = NAV.map(
    (n) => `<a href="${n.href}" class="${n.name === active ? "on" : ""}" ${n.name === active ? 'aria-current="page"' : ""}>${icon(n.icon, 26)}<span>${n.label}</span></a>`,
  ).join("");
  $("rail").innerHTML = links;
  $("menu").hidden = !S.menu;
  $("menu").innerHTML = S.menu ? `<div class="menu-pop">${links}</div>` : "";
}

/** Inhalt des aktuellen Views. Behält die Scroll-Positionen innerhalb des Views. */
export function render() {
  if ($("shell").hidden) return;
  const v = views[S.route.name] || views.kasse;
  const view = $("view");
  const scrolls = [...view.querySelectorAll("[data-keep-scroll]")].map((e) => e.scrollTop);
  view.className = `view view-${S.route.name}`;
  view.innerHTML = v.render();
  view.querySelectorAll("[data-keep-scroll]").forEach((e, i) => {
    if (scrolls[i] !== undefined) e.scrollTop = scrolls[i];
  });
  v.after?.(view);
  renderChrome();
}

export function renderSheet() {
  const el = $("sheet");
  if (!S.sheet) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<div class="dim" data-act="closeSheet"></div><div class="sheet" role="dialog" aria-modal="true">${views.__sheet(S.sheet)}</div>`;
  el.querySelector("[autofocus]")?.focus();
}

let toastTimer;
export function showToast(t) {
  S.toast = t;
  const el = $("toast");
  clearTimeout(toastTimer);
  el.innerHTML = `<div class="toast ${t.kind || ""}" role="status">
      <div><div class="t1">${esc(t.title)}</div>${t.sub ? `<div class="t2">${esc(t.sub)}</div>` : ""}</div>
      ${t.href ? `<a href="${t.href}">Bon ›</a>` : ""}</div>`;
  toastTimer = setTimeout(() => {
    el.innerHTML = "";
    S.toast = null;
  }, t.ms || 3500);
}
export function clearToast() {
  clearTimeout(toastTimer);
  $("toast").innerHTML = "";
  S.toast = null;
}

export function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}
