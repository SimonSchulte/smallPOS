// Bericht, Kassensturz und Verwaltung.

import { OfflineError, api } from "./api.js";
import { loadCatalog } from "./catalog.js";
import { S, acts, forms, go, render, renderSheet, showToast, views } from "./core.js";
import { metaSet } from "./store.js";
import { eur, esc, fmt, fmtDate, fmtDateTime, parseEuro, todayIso } from "./util.js";

const sheets = (views.__sheets = views.__sheets || {});
const offlineMsg = `<div class="page"><h1>Keine Verbindung</h1><div class="notice warn">Dieser Bereich braucht Netz, weil er die Daten aller Geräte zeigt.</div></div>`;
const errText = (e) => (e instanceof OfflineError ? "Keine Verbindung." : e.message);

// ---- Bericht --------------------------------------------------------------

let reportEventId = null;

async function loadReport() {
  try {
    const [events, report] = await Promise.all([
      api("/api/events"),
      api("/api/report" + (reportEventId ? `?event_id=${reportEventId}` : "")),
    ]);
    S.data.bericht = { events: events.events, report };
    reportEventId = report.event.id;
  } catch (e) {
    if (e instanceof OfflineError) S.data.bericht = { offline: true };
    else throw e;
  }
}

function syncWarning() {
  const n = S.pending + S.rejected;
  if (!n) return "";
  return `<div class="notice danger" role="alert"><b>⚠ Achtung:</b> ${n} ${n === 1 ? "Verkauf" : "Verkäufe"} auf diesem Gerät ${n === 1 ? "ist" : "sind"} noch nicht synchronisiert. Der Bericht zeigt nicht alle Daten.</div>`;
}

function eventPicker(d) {
  return `<label class="evsel">Veranstaltung<select data-change="reportEvent">${d.events
    .map((e) => `<option value="${e.id}" ${e.id === d.report.event.id ? "selected" : ""}>${esc(e.name)} · ${fmtDate(e.date)}${e.active ? " (aktiv)" : ""}</option>`)
    .join("")}</select></label>`;
}

views.bericht = {
  load: loadReport,
  render() {
    const d = S.data.bericht;
    if (!d) return `<div class="empty-state">Lade Bericht …</div>`;
    if (d.offline) return offlineMsg;
    const r = d.report;
    const rows = r.groups
      .map(
        (g) => `${g.articles.map((a) => `<tr><td>${esc(a.name)}</td><td class="num">${a.qty}</td><td class="num">${fmt(a.revenue_cents)}</td></tr>`).join("")}
          <tr class="grp"><td>Summe ${esc(g.name)}</td><td class="num">${g.qty}</td><td class="num">${fmt(g.revenue_cents)}</td></tr>`,
      )
      .join("");
    const qtyAll = r.groups.reduce((t, g) => t + g.qty, 0);
    const dev = r.devices.map((x) => `<tr><td>${esc(x.device_name)}</td><td class="num">${x.sales_count}</td><td class="num">${fmt(x.revenue_cents)}</td></tr>`).join("");
    const q = `?event_id=${r.event.id}`;
    return `<div class="page report">
      <div class="rhead no-print"><h1>Bericht</h1>
        <button class="btn" data-act="refreshReport">↻ Aktualisieren</button></div>
      <div class="print-only"><h1>${esc(S.cat.settings.club_name)} – ${esc(r.event.name)}</h1></div>
      ${eventPicker(d)}
      <div class="muted">Stand: ${fmtDateTime(r.generated_at)} Uhr · alle Geräte</div>
      ${syncWarning()}
      <div class="kpis">
        <div class="kpi"><small>Umsatz</small><b>${eur(r.total_cents)}</b></div>
        <div class="kpi"><small>Verkäufe</small><b>${r.sales_count}</b></div>
        <div class="kpi"><small>Ø Bon</small><b>${eur(r.average_cents)}</b></div>
      </div>
      <section class="card"><h2>Artikel</h2>
        <table><thead><tr><th>Artikel</th><th class="num">Menge</th><th class="num">Umsatz €</th></tr></thead><tbody>${rows || `<tr><td colspan="3" class="muted">Noch keine Verkäufe.</td></tr>`}
        <tr class="total"><td>Gesamt</td><td class="num">${qtyAll}</td><td class="num">${fmt(r.total_cents)}</td></tr>
        <tr class="void"><td>Stornos (nicht enthalten)</td><td class="num">${r.voids.count}</td><td class="num">${r.voids.total_cents ? "−" : ""}${fmt(r.voids.total_cents)}</td></tr></tbody></table></section>
      <section class="card"><h2>Pro Gerät</h2>
        <table><thead><tr><th>Gerät</th><th class="num">Verk.</th><th class="num">Umsatz €</th></tr></thead><tbody>${dev || `<tr><td colspan="3" class="muted">–</td></tr>`}</tbody></table></section>
      ${cashBlock(r)}
      <div class="btnrow no-print">
        <a class="btn primary" href="#/kassensturz">Kassensturz ›</a>
        <button class="btn" data-act="printReport">Drucken</button>
      </div>
      <section class="card no-print"><h2>Export</h2><div class="btnrow">
        <a class="btn" href="/api/export/sales.csv${q}" download>CSV Verkäufe</a>
        <a class="btn" href="/api/export/articles.csv${q}" download>CSV Artikel</a></div></section>
    </div>`;
  },
};

function cashBlock(r) {
  const c = r.cash;
  if (c.latest_difference_cents === null) return "";
  const diff = c.latest_difference_cents;
  return `<section class="card"><h2>Letzter Kassensturz</h2><div class="diff ${diffClass(diff)}"><span>${diffText(diff)}</span><b>${diff > 0 ? "+" : ""}${eur(diff)}</b></div></section>`;
}
const diffClass = (d) => (d === 0 ? "ok" : d < 0 ? "short" : "over");
const diffText = (d) => (d === 0 ? "Stimmt auf den Cent" : d < 0 ? `Es fehlen ${eur(-d)}` : `Zu viel in der Kasse: ${eur(d)}`);

acts.refreshReport = async () => {
  try {
    await loadReport();
  } catch (e) {
    showToast({ kind: "err", title: errText(e) });
  }
  render();
};
acts.printReport = () => window.print();
acts.reportEvent = (el) => {
  reportEventId = Number(el.value);
  return acts.refreshReport();
};

// ---- Kassensturz ----------------------------------------------------------

views.kassensturz = {
  load: loadReport,
  render() {
    const d = S.data.bericht;
    if (!d) return `<div class="empty-state">Lade …</div>`;
    if (d.offline) return offlineMsg;
    const r = d.report;
    const c = r.cash;
    const hist = c.counts
      .map((x) => `<div class="hist"><span>${fmtDateTime(x.created_at).slice(11)} ${x.note ? `· „${esc(x.note)}“` : ""}</span><b class="${diffClass(x.difference_cents)}-t">${x.difference_cents > 0 ? "+" : ""}${eur(x.difference_cents)}</b></div>`)
      .join("");
    const k = S.data.kassensturz || {};
    const counted = k.value == null ? null : parseEuro(k.value);
    const live = counted == null ? "" : `<div class="diff ${diffClass(counted - c.expected_cents)}"><span>${diffText(counted - c.expected_cents)}</span><b>${counted - c.expected_cents > 0 ? "+" : ""}${eur(counted - c.expected_cents)}</b></div>`;
    return `<div class="page"><a class="back" href="#/bericht">‹ Bericht</a><h1>Kassensturz</h1>
      <div class="muted">${esc(r.event.name)} · Stand ${fmtDateTime(r.generated_at)} Uhr</div>
      ${syncWarning()}
      <section class="card">
        <div class="r"><span>Anfangsbestand Wechselgeld</span><b>${eur(c.opening_cents)}</b></div>
        <div class="r"><span>+ Umsatz (ohne Stornos)</span><b>${eur(r.total_cents)}</b></div>
        <div class="r tot"><span>Soll in der Kasse</span><b>${eur(c.expected_cents)}</b></div></section>
      <form class="card" data-form="cashcount">
        <label>Gezähltes Bargeld (Ist) in €<input name="counted" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(k.value || "")}" data-input="cashLive" class="bigin"></label>
        <label>Notiz (optional)<input name="note" maxlength="200" autocomplete="off" placeholder="z. B. Zählung nach Spätschicht"></label>
        <div id="cashlive">${live}</div>
        ${k.error ? `<div class="notice danger">${esc(k.error)}</div>` : ""}
        <button class="btn primary" type="submit">Zählung speichern</button></form>
      ${hist ? `<section class="card"><h2>Frühere Zählungen</h2>${hist}</section>` : ""}
      <section class="card no-print"><h2>Export</h2><div class="btnrow">
        <a class="btn" href="/api/export/sales.csv?event_id=${r.event.id}" download>CSV Verkäufe</a>
        <a class="btn" href="/api/export/articles.csv?event_id=${r.event.id}" download>CSV Artikel</a>
        <button class="btn" data-act="printReport">Drucken</button></div></section></div>`;
  },
};

// Live-Differenz beim Tippen, ohne das Formular neu aufzubauen (sonst ginge der Fokus verloren).
acts.cashLive = (el) => {
  S.data.kassensturz = { ...(S.data.kassensturz || {}), value: el.value, error: "" };
  const r = S.data.bericht.report;
  const counted = parseEuro(el.value);
  const box = document.getElementById("cashlive");
  if (counted == null) box.innerHTML = "";
  else {
    const diff = counted - r.cash.expected_cents;
    box.innerHTML = `<div class="diff ${diffClass(diff)}"><span>${diffText(diff)}</span><b>${diff > 0 ? "+" : ""}${eur(diff)}</b></div>`;
  }
};
forms.cashcount = async (form) => {
  const counted = parseEuro(form.elements.counted.value);
  if (counted == null || counted < 0) {
    S.data.kassensturz = { value: form.elements.counted.value, error: "Bitte einen Betrag wie 538,00 eingeben." };
    return render();
  }
  try {
    await api("/api/cash-counts", { method: "POST", body: { event_id: S.data.bericht.report.event.id, counted_cents: counted, note: form.elements.note.value } });
    S.data.kassensturz = {};
    await loadReport();
    showToast({ kind: "ok", title: "Zählung gespeichert" });
  } catch (e) {
    S.data.kassensturz = { value: form.elements.counted.value, error: errText(e) };
  }
  render();
};

// ---- Verwaltung -----------------------------------------------------------

const TABS = [
  ["artikel", "Artikel"],
  ["veranstaltung", "Veranstaltung"],
  ["system", "Einstellungen"],
];

function tabs(active) {
  return `<div class="seg no-print">${TABS.map(([k, l]) => `<a class="${k === active ? "on" : ""}" href="#/verwaltung/${k}">${l}</a>`).join("")}</div>`;
}

views.verwaltung = {
  async load() {
    const tab = S.route.args[0] || "artikel";
    if (tab === "veranstaltung") {
      try {
        S.data.events = (await api("/api/events")).events;
      } catch (e) {
        if (!(e instanceof OfflineError)) throw e;
        S.data.events = null;
      }
    }
  },
  render() {
    const tab = S.route.args[0] || "artikel";
    const body = { artikel: adminArticles, veranstaltung: adminEvent, system: adminSystem }[tab] || adminArticles;
    return `<div class="page"><h1>Verwaltung</h1>${tabs(tab)}${body()}</div>`;
  },
};

function adminArticles() {
  const c = S.cat;
  const groups = c.groups
    .map((g, gi) => {
      const arts = c.articles.filter((a) => a.group_id === g.id);
      return `<div class="gh2"><span>${esc(g.name)}</span>
          <span><button class="lnk" data-act="moveGroup" data-id="${g.id}" data-dir="-1" aria-label="Gruppe nach oben" ${gi === 0 ? "disabled" : ""}>▲</button>
          <button class="lnk" data-act="moveGroup" data-id="${g.id}" data-dir="1" aria-label="Gruppe nach unten" ${gi === c.groups.length - 1 ? "disabled" : ""}>▼</button>
          <button class="lnk" data-act="editGroup" data-id="${g.id}">Umbenennen</button></span></div>
        ${arts
          .map(
            (a, i) => `<div class="arow ${a.active ? "" : "off"}">
              <span class="mv"><button data-act="moveArticle" data-id="${a.id}" data-dir="-1" aria-label="${esc(a.name)} nach oben" ${i === 0 ? "disabled" : ""}>▲</button><button data-act="moveArticle" data-id="${a.id}" data-dir="1" aria-label="${esc(a.name)} nach unten" ${i === arts.length - 1 ? "disabled" : ""}>▼</button></span>
              <button class="aname" data-act="editArticle" data-id="${a.id}"><b>${esc(a.name)}</b>${a.active ? "" : "<small>deaktiviert</small>"}</button>
              ${a.price_cents === 0 ? `<span class="hint">Preis setzen</span>` : ""}
              <span class="price">${eur(a.price_cents)}</span></div>`,
          )
          .join("")}
        <button class="add" data-act="newArticle" data-group="${g.id}">+ Artikel in „${esc(g.name)}“</button>`;
    })
    .join("");
  return `${groups}<button class="add" data-act="newGroup">+ Gruppe hinzufügen</button>
    <p class="muted">Artikel werden nie gelöscht, nur deaktiviert – so bleibt die Historie der Berichte vollständig.</p>`;
}

function adminEvent() {
  const ev = S.cat.event;
  const list = S.data.events;
  return `${
    ev
      ? `<form class="card" data-form="event"><h2>Aktive Veranstaltung</h2>
          <label>Name<input name="name" maxlength="80" value="${esc(ev.name)}" required></label>
          <div class="two"><label>Datum<input name="date" type="date" value="${esc(ev.date)}" required></label>
          <label>Anfangsbestand €<input name="opening" inputmode="decimal" value="${fmt(ev.opening_cents)}" required></label></div>
          <button class="btn primary" type="submit">Speichern</button></form>`
      : ""
  }
    <form class="card" data-form="newEvent"><h2>Neue Veranstaltung</h2>
      <label>Name<input name="name" maxlength="80" required placeholder="z. B. Weihnachtsmarkt 2026"></label>
      <div class="two"><label>Datum<input name="date" type="date" value="${todayIso()}" required></label>
      <label>Anfangsbestand €<input name="opening" inputmode="decimal" value="0,00" required></label></div>
      <button class="btn" type="submit">Anlegen und alte schließen</button>
      <p class="muted">Die bisherige Veranstaltung wird geschlossen. Ihre Verkäufe bleiben im Bericht abrufbar.</p></form>
    <section class="card"><h2>Alle Veranstaltungen</h2>${
      list
        ? list.map((e) => `<div class="hist"><span>${esc(e.name)} · ${fmtDate(e.date)}${e.active ? " <span class=\"tag g\">aktiv</span>" : ""}</span><button class="lnk" data-act="eventReport" data-id="${e.id}">Bericht ›</button></div>`).join("")
        : `<div class="muted">Liste braucht Netz.</div>`
    }</section>`;
}

function adminSystem() {
  const s = S.cat.settings;
  return `<form class="card" data-form="settings"><h2>Verein und Bon</h2>
      <label>Vereinsname (Kopfzeile)<input name="club" maxlength="80" value="${esc(s.club_name)}" required></label>
      <label>Fußzeile<input name="footer" maxlength="200" value="${esc(s.receipt_footer)}" required></label>
      <button class="btn primary" type="submit">Speichern</button></form>
    <form class="card" data-form="device"><h2>Dieses Gerät</h2>
      <label>Gerätename<input name="device" maxlength="40" value="${esc(S.device)}" required></label>
      <button class="btn" type="submit">Name ändern</button>
      <p class="muted">Der Name wird bei jedem Verkauf mitgespeichert. Ausstehend: ${S.pending}, abgelehnt: ${S.rejected}.</p>
      <button class="btn" type="button" data-act="syncNow">Jetzt synchronisieren</button></form>
    <section class="card"><h2>Backup</h2>
      <a class="btn" href="/api/export/all.json" download>Alles als JSON exportieren</a>
      <p class="muted">Zusätzlich sichert Cloudflare D1 „Time Travel“ die Datenbank der letzten 30 Tage.</p></section>
    <section class="card"><h2>Sitzung</h2><button class="btn danger-outline" data-act="logout">Abmelden</button></section>`;
}

async function save(fn) {
  try {
    await fn();
    return true;
  } catch (e) {
    if (S.sheet) {
      S.sheet.error = errText(e);
      renderSheet();
    } else showToast({ kind: "err", title: errText(e) });
    return false;
  }
}

acts.eventReport = (el) => {
  reportEventId = Number(el.dataset.id);
  go("#/bericht");
};
acts.syncNow = async () => {
  await acts.__ping?.();
  showToast({ title: S.pending ? "Senden nicht möglich (kein Netz?)" : "Alles synchronisiert" });
  render();
};
acts.logout = async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  await metaSet("hasSession", false);
  S.auth = "out";
  acts.__gate?.();
};

forms.event = (form) =>
  save(async () => {
    const opening = parseEuro(form.elements.opening.value);
    if (opening == null || opening < 0) throw new Error("Anfangsbestand: bitte einen Betrag wie 100,00 eingeben.");
    await api(`/api/events/${S.cat.event.id}`, { method: "PATCH", body: { name: form.elements.name.value, date: form.elements.date.value, opening_cents: opening } });
    await loadCatalog();
    showToast({ kind: "ok", title: "Gespeichert" });
    render();
  });
forms.newEvent = (form) =>
  save(async () => {
    const opening = parseEuro(form.elements.opening.value);
    if (opening == null || opening < 0) throw new Error("Anfangsbestand: bitte einen Betrag wie 100,00 eingeben.");
    if (!confirm("Neue Veranstaltung anlegen? Die aktuelle wird geschlossen, ihre Verkäufe bleiben abrufbar.")) return;
    await api("/api/events", { method: "POST", body: { name: form.elements.name.value, date: form.elements.date.value, opening_cents: opening } });
    await loadCatalog();
    S.data.events = (await api("/api/events")).events;
    reportEventId = null;
    showToast({ kind: "ok", title: "Neue Veranstaltung ist aktiv" });
    render();
  });
forms.settings = (form) =>
  save(async () => {
    await api("/api/settings", { method: "PUT", body: { club_name: form.elements.club.value, receipt_footer: form.elements.footer.value } });
    await loadCatalog();
    showToast({ kind: "ok", title: "Gespeichert" });
    render();
  });
forms.device = (form) =>
  save(async () => {
    const name = form.elements.device.value.trim();
    if (!name) throw new Error("Bitte einen Namen eingeben.");
    S.device = name;
    await metaSet("device", name);
    showToast({ kind: "ok", title: "Gerätename geändert" });
    render();
  });

// Sortierung
async function reorderIn(kind, list, id, dir) {
  const ids = list.map((x) => x.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await save(async () => {
    await api("/api/reorder", { method: "POST", body: { kind, ids } });
    await loadCatalog();
    render();
  });
}
acts.moveArticle = (el) => {
  const id = Number(el.dataset.id);
  const a = S.cat.articles.find((x) => x.id === id);
  return reorderIn("articles", S.cat.articles.filter((x) => x.group_id === a.group_id), id, Number(el.dataset.dir));
};
acts.moveGroup = (el) => reorderIn("groups", S.cat.groups, Number(el.dataset.id), Number(el.dataset.dir));

// Sheets für Artikel und Gruppen
acts.editArticle = (el) => {
  const a = S.cat.articles.find((x) => x.id === Number(el.dataset.id));
  S.sheet = { type: "article", id: a.id, name: a.name, price: fmt(a.price_cents), group_id: a.group_id, active: !!a.active, error: "" };
  renderSheet();
};
acts.newArticle = (el) => {
  S.sheet = { type: "article", id: null, name: "", price: "", group_id: Number(el.dataset.group), active: true, error: "" };
  renderSheet();
};
acts.editGroup = (el) => {
  const g = S.cat.groups.find((x) => x.id === Number(el.dataset.id));
  S.sheet = { type: "group", id: g.id, name: g.name, error: "" };
  renderSheet();
};
acts.newGroup = () => {
  S.sheet = { type: "group", id: null, name: "", error: "" };
  renderSheet();
};

sheets.article = (sh) => `<form data-form="article">
  <h2>${sh.id ? "Artikel bearbeiten" : "Neuer Artikel"}</h2>
  <label>Name<input name="name" maxlength="80" value="${esc(sh.name)}" required autofocus autocomplete="off"></label>
  <label>Preis in €<input name="price" inputmode="decimal" value="${esc(sh.price)}" placeholder="3,50" required autocomplete="off"></label>
  <label>Gruppe<select name="group_id">${S.cat.groups.map((g) => `<option value="${g.id}" ${g.id === sh.group_id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>
  ${sh.id ? `<label class="check"><input type="checkbox" name="active" ${sh.active ? "checked" : ""}> Aktiv (in der Kasse sichtbar)</label>` : ""}
  ${sh.error ? `<div class="notice danger">${esc(sh.error)}</div>` : ""}
  <div class="btnrow"><button type="button" class="btn" data-act="closeSheet">Abbrechen</button><button class="btn primary" type="submit">Speichern</button></div></form>`;
sheets.group = (sh) => `<form data-form="group">
  <h2>${sh.id ? "Gruppe umbenennen" : "Neue Gruppe"}</h2>
  <label>Name<input name="name" maxlength="40" value="${esc(sh.name)}" required autofocus autocomplete="off"></label>
  ${sh.error ? `<div class="notice danger">${esc(sh.error)}</div>` : ""}
  <div class="btnrow"><button type="button" class="btn" data-act="closeSheet">Abbrechen</button><button class="btn primary" type="submit">Speichern</button></div></form>`;

forms.article = async (form) => {
  const sh = S.sheet;
  const price = parseEuro(form.elements.price.value);
  Object.assign(sh, { name: form.elements.name.value, price: form.elements.price.value, group_id: Number(form.elements.group_id.value), active: form.elements.active ? form.elements.active.checked : true });
  if (price == null) {
    sh.error = "Bitte einen Preis wie 3,50 eingeben.";
    return renderSheet();
  }
  const ok = await save(async () => {
    if (sh.id) await api(`/api/articles/${sh.id}`, { method: "PATCH", body: { name: sh.name, price_cents: price, group_id: sh.group_id, active: sh.active } });
    else await api("/api/articles", { method: "POST", body: { name: sh.name, price_cents: price, group_id: sh.group_id } });
    await loadCatalog();
  });
  if (ok) {
    S.sheet = null;
    renderSheet();
    render();
  }
};
forms.group = async (form) => {
  const sh = S.sheet;
  sh.name = form.elements.name.value;
  const ok = await save(async () => {
    if (sh.id) await api(`/api/groups/${sh.id}`, { method: "PATCH", body: { name: sh.name } });
    else await api("/api/groups", { method: "POST", body: { name: sh.name } });
    await loadCatalog();
  });
  if (ok) {
    S.sheet = null;
    renderSheet();
    render();
  }
};


