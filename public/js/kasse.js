// Hauptansicht Kassieren, Bon und Verlauf der Verkäufe.

import { ApiError, OfflineError, api } from "./api.js";
import { S, acts, forms, go, icon, render, renderChrome, renderSheet, showToast, views } from "./core.js";
import { nextCounter, saleGet, salePut, salesAll } from "./store.js";
import { billNo, eur, esc, fmt, fmtDateTime, initials, uuid } from "./util.js";

// ---- Zustand der Kasse ----------------------------------------------------
const K = { cart: {}, given: null, typed: "", pad: false };

const articleList = () => (S.cat ? S.cat.articles : []);
const qty = (id) => K.cart[id] || 0;

function totals() {
  const lines = articleList().filter((a) => qty(a.id) > 0);
  const total = lines.reduce((t, a) => t + qty(a.id) * a.price_cents, 0);
  const count = lines.reduce((t, a) => t + qty(a.id), 0);
  return { lines, total, count, noPrice: lines.some((a) => a.price_cents === 0) };
}

/** Gegeben-Vorschläge: "Passend" plus die nächsten drei Scheine, die die Summe abdecken. */
function chipValues(total, count) {
  const bills = [5, 10, 20, 50, 100, 200].filter((b) => b * 100 >= total);
  const picks = count > 0 ? bills.slice(0, 3) : [10, 20, 50];
  return [{ label: "Passend", v: total }, ...picks.map((b) => ({ label: `${b} €`, v: b * 100 }))];
}

function changeInfo(t) {
  const change = K.given == null ? null : K.given - t.total;
  if (t.count === 0 || change == null) return { cls: "none", label: "Rückgeld", value: "– –", short: false };
  if (change > 0) return { cls: "ok", label: K.pad ? `Rückgeld bei ${fmt(K.given)} €` : "Rückgeld", value: eur(change), short: false };
  if (change === 0) return { cls: "ok", label: "Passend gezahlt", value: "✓", short: false };
  return { cls: "short", label: "Es fehlen", value: eur(-change), short: true };
}

views.kasse = {
  render() {
    if (!S.cat) return `<div class="empty-state">Katalog wird geladen …</div>`;
    const t = totals();
    const ch = changeInfo(t);
    const groups = S.cat.groups
      .map((g) => ({ g, items: articleList().filter((a) => a.group_id === g.id && (a.active || qty(a.id) > 0)) }))
      .filter((x) => x.items.length);
    const tiles = groups
      .map(
        ({ g, items }) => `<h2 class="gh">${esc(g.name)}</h2><div class="grid">${items
          .map(
            (a) => `<button class="art ${qty(a.id) > 0 ? "sel" : ""}" data-act="add" data-id="${a.id}">
              <b>${esc(a.name)}</b>
              ${a.price_cents === 0 ? `<span class="noprice">Preis setzen</span>` : `<span>${eur(a.price_cents)}</span>`}
              ${qty(a.id) > 0 ? `<i class="badge">${qty(a.id)}</i>` : ""}</button>`,
          )
          .join("")}</div>`,
      )
      .join("");
    const lines = t.lines
      .map(
        (a) => `<div class="line"><span class="n">${esc(a.name)}</span>
          <span class="q"><button data-act="dec" data-id="${a.id}" aria-label="${esc(a.name)} weniger">−</button><i>${qty(a.id)}</i><button data-act="inc" data-id="${a.id}" aria-label="${esc(a.name)} mehr">+</button></span>
          <span class="sum">${fmt(qty(a.id) * a.price_cents)}</span></div>`,
      )
      .join("");
    const chips = chipValues(t.total, t.count)
      .map((c) => `<button class="${K.given === c.v && t.count > 0 && !K.pad ? "on" : ""}" data-act="given" data-v="${c.v}">${c.label}</button>`)
      .join("");
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map((k) => `<button data-act="padkey" data-k="${k}">${k}</button>`).join("");
    let goLabel = `Kassieren · ${eur(t.total)}`;
    let goOff = false;
    if (t.count === 0) (goLabel = "Artikel antippen"), (goOff = true);
    else if (t.noPrice) (goLabel = "Preise fehlen – siehe Verwaltung"), (goOff = true);
    else if (ch.short) (goLabel = "Betrag reicht nicht"), (goOff = true);
    return `<div class="kasse">
      <div class="arts" data-keep-scroll>${tiles || `<div class="empty-state">Keine Artikel. In der Verwaltung anlegen.</div>`}</div>
      <div class="side">
        <div class="cart">
          <div class="ch"><span>Warenkorb</span><button data-act="clear">Leeren</button></div>
          <div class="lines" data-keep-scroll>${lines || `<div class="empty">Artikel antippen, jeder Tipp zählt +1</div>`}</div>
        </div>
        <div class="pay">
          <div class="sumrow"><span>Summe</span><b>${eur(t.total)}</b></div>
          <div class="chips">${chips}<button class="wide-only ${K.pad ? "on" : ""}" data-act="padtoggle">Betrag…</button></div>
          ${K.pad ? `<div class="pad wide-only">${keys}</div>` : ""}
          <div class="rg ${ch.cls}" aria-live="polite"><span>${ch.label}</span><b>${ch.value}</b></div>
        </div>
        <button class="go ${goOff ? "off" : ""}" data-act="pay" ${goOff ? 'aria-disabled="true"' : ""}>${goLabel}</button>
      </div>
    </div>`;
  },
};

acts.add = (el) => {
  K.cart[el.dataset.id] = qty(el.dataset.id) + 1;
  navigator.vibrate?.(15);
  render();
};
acts.inc = acts.add;
acts.dec = (el) => {
  const n = qty(el.dataset.id) - 1;
  if (n <= 0) delete K.cart[el.dataset.id];
  else K.cart[el.dataset.id] = n;
  render();
};
acts.clear = () => {
  Object.assign(K, { cart: {}, given: null, typed: "", pad: false });
  render();
};
acts.given = (el) => {
  K.given = Number(el.dataset.v);
  K.typed = "";
  K.pad = false;
  render();
};
acts.padtoggle = () => {
  K.pad = !K.pad;
  K.typed = "";
  if (!K.pad) K.given = null;
  render();
};
acts.padkey = (el) => {
  const k = el.dataset.k;
  if (k === "C") K.typed = "";
  else if (k === "⌫") K.typed = K.typed.slice(0, -1);
  else K.typed = (K.typed + k).replace(/^0+/, "").slice(0, 4);
  K.given = K.typed === "" ? null : parseInt(K.typed, 10) * 100;
  render();
};

acts.pay = async () => {
  const t = totals();
  const ch = changeInfo(t);
  if (t.count === 0 || t.noPrice || ch.short) return;
  const n = await nextCounter();
  const sale = {
    id: uuid(),
    event_id: S.cat.event ? S.cat.event.id : null,
    device_name: S.device,
    created_at_client: new Date().toISOString(),
    items: t.lines.map((a) => ({ article_id: a.id, name: a.name, unit_price_cents: a.price_cents, qty: qty(a.id) })),
    total_cents: t.total,
    given_cents: K.given,
    status: "pending",
    number: null,
    provisional: `${initials(S.device)}-${String(n).padStart(3, "0")}`,
  };
  await salePut(sale); // zuerst lokal sichern, erst dann aufräumen
  const change = K.given == null ? 0 : Math.max(0, K.given - t.total);
  Object.assign(K, { cart: {}, given: null, typed: "", pad: false });
  navigator.vibrate?.(40);
  showToast({ kind: "ok", title: `✓ ${eur(t.total)} kassiert`, sub: change > 0 ? `Rückgeld ${eur(change)}` : "Kein Rückgeld", href: `#/bon/${sale.id}` });
  S.pending += 1;
  render();
  acts.__flush?.();
};

// ---- Bon ------------------------------------------------------------------

async function findSale(id) {
  const local = await saleGet(id);
  if (local && local.status !== "synced") return local; // wartet noch: der Server kennt ihn nicht
  try {
    const r = await api("/api/sales?limit=50");
    const remote = r.sales.find((s) => s.id === id);
    if (remote) return { ...(local || {}), ...remote, status: "synced" };
  } catch (e) {
    if (!(e instanceof OfflineError) && !(e instanceof ApiError)) throw e;
    if (!local) throw e;
  }
  return local || null; // offline: lokale Kopie (ohne spätere Stornos)
}

function bonText(sale) {
  const s = S.cat.settings;
  const lines = [s.club_name, S.cat.event?.name || "", `Bon-Nr. ${billNo(sale)}  ${fmtDateTime(sale.created_at_client)}`, `Gerät: ${sale.device_name}`, ""];
  for (const i of sale.items) lines.push(`${i.qty} × ${i.name}  ${fmt(i.qty * i.unit_price_cents)}`);
  lines.push("", `SUMME ${eur(sale.total_cents)}`);
  if (sale.given_cents != null) lines.push(`Gegeben ${eur(sale.given_cents)}`, `Rückgeld ${eur(Math.max(0, sale.given_cents - sale.total_cents))}`);
  lines.push("", s.receipt_footer);
  return lines.join("\n");
}

views.bon = {
  async load() {
    S.data.bon = await findSale(S.route.args[0]).catch((e) => (e instanceof OfflineError ? "offline" : null));
  },
  render() {
    const sale = S.data.bon;
    if (sale === undefined) return `<div class="empty-state">Lade Bon …</div>`;
    if (sale === "offline") return `<div class="empty-state">Dieser Bon liegt auf einem anderen Gerät. Bitte mit Netz öffnen.</div>`;
    if (!sale) return `<div class="empty-state">Verkauf nicht gefunden.</div>`;
    const s = S.cat.settings;
    const voided = !!sale.voided_at;
    return `<div class="page bon-view">
      ${voided ? `<div class="notice danger">STORNIERT${sale.void_reason ? ` – ${esc(sale.void_reason)}` : ""}</div>` : ""}
      ${sale.status === "pending" ? `<div class="notice warn">Noch nicht synchronisiert – vorläufige Nummer, wird beim Senden ersetzt.</div>` : ""}
      ${sale.status === "rejected" ? `<div class="notice danger">Vom Server abgelehnt: ${esc(sale.error || "")}</div>` : ""}
      <div class="paper" id="paper">
        <div class="c b">${esc(s.club_name)}</div>
        <div class="c">${esc(S.cat.event?.name || "")}</div>
        <hr>
        <div class="r"><span>Bon-Nr. ${esc(billNo(sale))}</span><span>${fmtDateTime(sale.created_at_client)}</span></div>
        <div>Gerät: ${esc(sale.device_name)}</div>
        <hr>
        ${sale.items
          .map((i) => `<div class="r"><span>${i.qty} × ${esc(i.name)}</span><span>${fmt(i.qty * i.unit_price_cents)}</span></div>${i.qty > 1 ? `<div class="r sub"><span>&nbsp;&nbsp;à ${fmt(i.unit_price_cents)}</span><span></span></div>` : ""}`)
          .join("")}
        <hr>
        <div class="r big"><span>SUMME</span><span>${eur(sale.total_cents)}</span></div>
        ${sale.given_cents != null ? `<div class="r"><span>Gegeben</span><span>${eur(sale.given_cents)}</span></div><div class="r"><span>Rückgeld</span><span>${eur(Math.max(0, sale.given_cents - sale.total_cents))}</span></div>` : ""}
        <hr>
        <div class="c small">${esc(s.receipt_footer)}</div>
      </div>
      <div class="btnrow no-print">
        <button class="btn" data-act="printBon">Drucken</button>
        <button class="btn" data-act="shareBon" data-id="${esc(sale.id)}">Teilen</button>
      </div>
      <div class="btnrow no-print">
        ${!voided && sale.status !== "pending" ? `<button class="btn danger-outline" data-act="voidAsk" data-id="${esc(sale.id)}">Verkauf stornieren …</button>` : ""}
        <a class="btn primary" href="#/kasse">Zur Kasse</a>
      </div>
    </div>`;
  },
};

acts.printBon = () => {
  document.body.classList.add("print-bon");
  window.print();
};
window.addEventListener("afterprint", () => document.body.classList.remove("print-bon"));

acts.shareBon = async (el) => {
  const sale = S.data.bon;
  if (!sale || sale.id !== el.dataset.id) return;
  const text = bonText(sale);
  try {
    if (navigator.share) await navigator.share({ title: `Bon ${billNo(sale)}`, text });
    else if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      showToast({ title: "Bon in die Zwischenablage kopiert" });
    }
  } catch {
    /* Teilen abgebrochen */
  }
};

// Storno mit Grund und Rückfrage
const REASONS = ["Vertippt", "Kunde verzichtet", "Falscher Artikel"];
acts.voidAsk = (el) => {
  S.sheet = { type: "void", id: el.dataset.id, reason: REASONS[0], error: "" };
  renderSheet();
};
acts.voidReason = (el) => {
  S.sheet.reason = el.dataset.reason;
  renderSheet();
};
forms.void = async (form) => {
  const reason = (form.elements.reason.value || "").trim() || S.sheet.reason;
  try {
    await api(`/api/sales/${S.sheet.id}/void`, { method: "POST", body: { reason } });
    S.sheet = null;
    renderSheet();
    await views.bon.load();
    render();
    showToast({ title: "Verkauf storniert" });
  } catch (e) {
    S.sheet.error = e instanceof OfflineError ? "Stornieren braucht eine Verbindung." : e.message;
    renderSheet();
  }
};

// ---- Letzte Verkäufe ------------------------------------------------------

views.verkaeufe = {
  async load() {
    const local = await salesAll();
    let server = null;
    try {
      server = (await api("/api/sales?limit=50")).sales;
    } catch (e) {
      if (!(e instanceof OfflineError) && !(e instanceof ApiError)) throw e;
    }
    const byId = new Map();
    for (const s of local) byId.set(s.id, s);
    for (const s of server || []) byId.set(s.id, { ...(byId.get(s.id) || {}), ...s, status: "synced" });
    const evId = S.cat?.event?.id;
    S.data.verkaeufe = {
      offline: server === null,
      rows: [...byId.values()]
        .filter((s) => !evId || !s.event_id || s.event_id === evId)
        .sort((a, b) => b.created_at_client.localeCompare(a.created_at_client))
        .slice(0, 50),
    };
  },
  render() {
    const d = S.data.verkaeufe;
    if (!d) return `<div class="empty-state">Lade …</div>`;
    const rows = d.rows
      .map((s) => {
        const tag = s.voided_at ? `<span class="tag">STORNIERT</span>` : s.status === "pending" ? `<span class="tag p">WARTET</span>` : s.status === "rejected" ? `<span class="tag">ABGELEHNT</span>` : "";
        return `<a class="srow ${s.voided_at ? "void" : ""}" href="#/bon/${esc(s.id)}">
          <span class="main"><b class="${s.voided_at ? "strike" : ""}">${esc(billNo(s))} · ${eur(s.total_cents)}</b>
          <small>${new Date(s.created_at_client).toTimeString().slice(0, 5)} · ${esc(s.device_name)} · ${s.items.length} ${s.items.length === 1 ? "Position" : "Positionen"}${s.voided_at && s.void_reason ? ` · ${esc(s.void_reason)}` : ""}</small></span>
          ${tag || '<span class="more">Bon ›</span>'}</a>`;
      })
      .join("");
    return `<div class="page"><h1>Letzte Verkäufe</h1>
      ${d.offline ? `<div class="notice warn">Kein Netz – es werden nur Verkäufe von diesem Gerät gezeigt.</div>` : ""}
      <div class="list">${rows || `<div class="empty-state">Noch keine Verkäufe.</div>`}</div></div>`;
  },
};

// Hilfsansicht für Sheets (Storno wird hier gebaut, Verwaltung in admin.js ergänzt weitere)
const sheetBuilders = (views.__sheets = views.__sheets || {});
sheetBuilders.void = (sh) => `
  <form data-form="void">
    <h2>Verkauf stornieren?</h2>
    <p class="muted">Der Verkauf bleibt sichtbar markiert, zählt aber nicht mehr im Bericht.</p>
    <div class="chiprow">${REASONS.map((r) => `<button type="button" class="${sh.reason === r ? "on" : ""}" data-act="voidReason" data-reason="${esc(r)}">${esc(r)}</button>`).join("")}</div>
    <label>Oder eigener Grund<input name="reason" maxlength="200" autocomplete="off" placeholder="${esc(sh.reason)}"></label>
    ${sh.error ? `<div class="notice danger">${esc(sh.error)}</div>` : ""}
    <div class="btnrow"><button type="button" class="btn" data-act="closeSheet">Abbrechen</button><button class="btn primary" type="submit">Stornieren</button></div>
  </form>`;
views.__sheet = (sh) => (views.__sheets[sh.type] ? views.__sheets[sh.type](sh) : "");

acts.closeSheet = () => {
  S.sheet = null;
  renderSheet();
};
