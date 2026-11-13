// Mini-Kasse – Worker: API unter /api/*, statische Dateien liefert Workers Assets.

import { clearCookie, isAuthenticated, login } from "./auth.js";
import { HttpError, bad, csvResponse, euro, int, json, onlyKeys, readJson, str, toCsv, validateSale } from "./lib.js";
import { loadReport } from "./report.js";

const SETTING_KEYS = ["club_name", "receipt_footer"];
const now = () => new Date().toISOString();

async function activeEvent(db) {
  return db.prepare("SELECT * FROM events WHERE active = 1").first();
}

async function resolveEvent(db, url) {
  const id = url.searchParams.get("event_id");
  const ev = id ? await db.prepare("SELECT * FROM events WHERE id = ?").bind(Number(id)).first() : await activeEvent(db);
  if (!ev) throw new HttpError(404, "Veranstaltung nicht gefunden");
  return ev;
}

async function loadState(db) {
  const [settings, groups, articles, event] = await db.batch([
    db.prepare("SELECT key, value FROM settings"),
    db.prepare("SELECT id, name, sort FROM groups ORDER BY sort, id"),
    db.prepare("SELECT a.id, a.group_id, a.name, a.price_cents, a.active, a.sort FROM articles a JOIN groups g ON g.id = a.group_id ORDER BY g.sort, g.id, a.sort, a.id"),
    db.prepare("SELECT * FROM events WHERE active = 1"),
  ]);
  return {
    settings: Object.fromEntries(settings.results.map((r) => [r.key, r.value])),
    groups: groups.results,
    articles: articles.results,
    event: event.results[0] || null,
  };
}

// ---- Verkäufe -------------------------------------------------------------

async function postSale(env, request) {
  const sale = validateSale(await readJson(request));
  const db = env.DB;

  // Wiederholung (gleiche UUID): bestehenden Verkauf zurückgeben, nichts schreiben.
  const existing = await db.prepare("SELECT id, number, event_id FROM sales WHERE id = ?").bind(sale.id).first();
  if (existing) return json({ id: existing.id, number: existing.number, event_id: existing.event_id, duplicate: true });

  let eventId = sale.eventId;
  if (eventId !== null) {
    const ev = await db.prepare("SELECT id FROM events WHERE id = ?").bind(eventId).first();
    if (!ev) throw bad("event_id: unbekannte Veranstaltung");
  } else {
    const ev = await activeEvent(db);
    if (!ev) throw new HttpError(409, "Keine aktive Veranstaltung");
    eventId = ev.id;
  }

  const ids = [...new Set(sale.items.map((i) => i.article_id))];
  const known = await db.prepare(`SELECT id FROM articles WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  if (known.results.length !== ids.length) throw bad("Unbekannte Artikel-ID");

  // INSERT OR IGNORE + deterministische Positions-IDs: auch bei parallelen Wiederholungen wird nie doppelt gezählt.
  const stmts = [
    db
      .prepare(
        `INSERT OR IGNORE INTO sales (id, event_id, number, device_name, created_at_client, received_at, total_cents, given_cents)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(number), 0) + 1 FROM sales WHERE event_id = ?2), ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(sale.id, eventId, sale.device, sale.createdAt, now(), sale.total, sale.given),
    ...sale.items.map((it, i) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO sale_items (id, sale_id, article_id, name_snapshot, unit_price_cents, qty)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(`${sale.id}:${i}`, sale.id, it.article_id, it.name, it.unit_price_cents, it.qty),
    ),
  ];
  const res = await db.batch(stmts);
  const inserted = res[0].meta.changes > 0;
  const row = await db.prepare("SELECT number, event_id FROM sales WHERE id = ?").bind(sale.id).first();
  return json({ id: sale.id, number: row.number, event_id: row.event_id, duplicate: !inserted }, inserted ? 201 : 200);
}

async function attachItems(db, sales) {
  if (!sales.length) return sales;
  const rows = await db
    .prepare(`SELECT id, sale_id, article_id, name_snapshot AS name, unit_price_cents, qty FROM sale_items WHERE sale_id IN (${sales.map(() => "?").join(",")}) ORDER BY id`)
    .bind(...sales.map((s) => s.id))
    .all();
  const by = new Map(sales.map((s) => [s.id, { ...s, items: [] }]));
  for (const r of rows.results) by.get(r.sale_id).items.push(r);
  return sales.map((s) => by.get(s.id));
}

async function listSales(env, url) {
  const ev = await resolveEvent(env.DB, url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 50);
  const rows = await env.DB.prepare("SELECT * FROM sales WHERE event_id = ? ORDER BY number DESC LIMIT ?").bind(ev.id, limit).all();
  return json({ event_id: ev.id, sales: await attachItems(env.DB, rows.results) });
}

async function voidSale(env, request, id) {
  const body = onlyKeys(await readJson(request), ["reason"], "Storno");
  const reason = str(body.reason, "reason", 200);
  const res = await env.DB.prepare("UPDATE sales SET voided_at = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL").bind(now(), reason, id).run();
  const row = await env.DB.prepare("SELECT * FROM sales WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "Verkauf nicht gefunden");
  return json({ id, voided: true, changed: res.meta.changes > 0 });
}

// ---- Verwaltung -----------------------------------------------------------

async function postGroup(env, request) {
  const b = onlyKeys(await readJson(request), ["name"], "Gruppe");
  const name = str(b.name, "name", 40);
  const max = await env.DB.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM groups").first();
  const r = await env.DB.prepare("INSERT INTO groups (name, sort) VALUES (?, ?)").bind(name, max.m + 1).run();
  return json({ id: r.meta.last_row_id }, 201);
}

async function patchGroup(env, request, id) {
  const b = onlyKeys(await readJson(request), ["name"], "Gruppe");
  const r = await env.DB.prepare("UPDATE groups SET name = ? WHERE id = ?").bind(str(b.name, "name", 40), id).run();
  if (!r.meta.changes) throw new HttpError(404, "Gruppe nicht gefunden");
  return json({ ok: true });
}

async function postArticle(env, request) {
  const b = onlyKeys(await readJson(request), ["group_id", "name", "price_cents"], "Artikel");
  const gid = int(b.group_id, "group_id", 1, 1_000_000);
  const g = await env.DB.prepare("SELECT id FROM groups WHERE id = ?").bind(gid).first();
  if (!g) throw bad("group_id: unbekannte Gruppe");
  const price = b.price_cents === undefined ? 0 : int(b.price_cents, "price_cents", -100_000, 100_000);
  const max = await env.DB.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM articles WHERE group_id = ?").bind(gid).first();
  const r = await env.DB.prepare("INSERT INTO articles (group_id, name, price_cents, sort) VALUES (?, ?, ?, ?)")
    .bind(gid, str(b.name, "name", 80), price, max.m + 1)
    .run();
  return json({ id: r.meta.last_row_id }, 201);
}

async function patchArticle(env, request, id) {
  const b = onlyKeys(await readJson(request), ["group_id", "name", "price_cents", "active"], "Artikel");
  const sets = [];
  const vals = [];
  if (b.name !== undefined) (sets.push("name = ?"), vals.push(str(b.name, "name", 80)));
  if (b.price_cents !== undefined) (sets.push("price_cents = ?"), vals.push(int(b.price_cents, "price_cents", -100_000, 100_000)));
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") throw bad("active: true/false erwartet");
    sets.push("active = ?");
    vals.push(b.active ? 1 : 0);
  }
  if (b.group_id !== undefined) {
    const gid = int(b.group_id, "group_id", 1, 1_000_000);
    if (!(await env.DB.prepare("SELECT id FROM groups WHERE id = ?").bind(gid).first())) throw bad("group_id: unbekannte Gruppe");
    sets.push("group_id = ?");
    vals.push(gid);
  }
  if (!sets.length) throw bad("Keine Änderung angegeben");
  const r = await env.DB.prepare(`UPDATE articles SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  if (!r.meta.changes) throw new HttpError(404, "Artikel nicht gefunden");
  return json({ ok: true });
}

async function reorder(env, request) {
  const b = onlyKeys(await readJson(request), ["kind", "ids"], "Sortierung");
  if (b.kind !== "groups" && b.kind !== "articles") throw bad("kind: groups oder articles erwartet");
  if (!Array.isArray(b.ids) || b.ids.length < 1 || b.ids.length > 200) throw bad("ids: Liste erwartet");
  const ids = b.ids.map((x) => int(x, "id", 1, 1_000_000_000));
  await env.DB.batch(ids.map((id, i) => env.DB.prepare(`UPDATE ${b.kind} SET sort = ? WHERE id = ?`).bind(i + 1, id)));
  return json({ ok: true });
}

async function putSettings(env, request) {
  const b = onlyKeys(await readJson(request), SETTING_KEYS, "Einstellungen");
  const stmts = Object.entries(b).map(([k, v]) =>
    env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, str(v, k, k === "club_name" ? 80 : 200)),
  );
  if (!stmts.length) throw bad("Keine Einstellung angegeben");
  await env.DB.batch(stmts);
  return json({ ok: true });
}

async function postEvent(env, request) {
  const b = onlyKeys(await readJson(request), ["name", "date", "opening_cents"], "Veranstaltung");
  const name = str(b.name, "name", 80);
  const date = str(b.date, "date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad("date: JJJJ-MM-TT erwartet");
  const opening = int(b.opening_cents ?? 0, "opening_cents", 0, 100_000_000);
  // Reihenfolge zählt: erst die alte schließen (eindeutiger Index auf aktive Veranstaltung).
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE events SET active = 0 WHERE active = 1"),
    env.DB.prepare("INSERT INTO events (name, date, opening_cents, active, created_at) VALUES (?, ?, ?, 1, ?)").bind(name, date, opening, now()),
  ]);
  return json({ id: res[1].meta.last_row_id }, 201);
}

async function patchEvent(env, request, id) {
  const b = onlyKeys(await readJson(request), ["name", "date", "opening_cents"], "Veranstaltung");
  const sets = [];
  const vals = [];
  if (b.name !== undefined) (sets.push("name = ?"), vals.push(str(b.name, "name", 80)));
  if (b.date !== undefined) {
    const d = str(b.date, "date", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad("date: JJJJ-MM-TT erwartet");
    sets.push("date = ?");
    vals.push(d);
  }
  if (b.opening_cents !== undefined) (sets.push("opening_cents = ?"), vals.push(int(b.opening_cents, "opening_cents", 0, 100_000_000)));
  if (!sets.length) throw bad("Keine Änderung angegeben");
  const r = await env.DB.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  if (!r.meta.changes) throw new HttpError(404, "Veranstaltung nicht gefunden");
  return json({ ok: true });
}

async function postCashCount(env, request) {
  const b = onlyKeys(await readJson(request), ["event_id", "counted_cents", "note"], "Zählung");
  const counted = int(b.counted_cents, "counted_cents", 0, 1_000_000_000);
  const note = b.note === undefined ? "" : str(b.note, "note", 200, { allowEmpty: true });
  const eventId = b.event_id === undefined ? (await activeEvent(env.DB))?.id : int(b.event_id, "event_id", 1, 1_000_000_000);
  if (!eventId || !(await env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(eventId).first())) throw bad("Unbekannte Veranstaltung");
  const r = await env.DB.prepare("INSERT INTO cash_counts (event_id, counted_cents, note, created_at) VALUES (?, ?, ?, ?)").bind(eventId, counted, note, now()).run();
  return json({ id: r.meta.last_row_id }, 201);
}

// ---- Export ---------------------------------------------------------------

async function exportAll(env) {
  const tables = ["settings", "groups", "articles", "events", "sales", "sale_items", "cash_counts"];
  const res = await env.DB.batch(tables.map((t) => env.DB.prepare(`SELECT * FROM ${t}`)));
  const data = Object.fromEntries(tables.map((t, i) => [t, res[i].results]));
  return new Response(JSON.stringify({ exported_at: now(), ...data }, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="kasse-backup-${now().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
}

async function exportSalesCsv(env, url) {
  const ev = await resolveEvent(env.DB, url);
  const rows = await env.DB.prepare("SELECT * FROM sales WHERE event_id = ? ORDER BY number").bind(ev.id).all();
  const sales = await attachItems(env.DB, rows.results);
  const header = ["Beleg", "Zeit (Gerät)", "Gerät", "Status", "Storno-Grund", "Positionen", "Summe EUR", "Gegeben EUR", "Rückgeld EUR"];
  const data = sales.map((s) => [
    s.number,
    s.created_at_client,
    s.device_name,
    s.voided_at ? "STORNIERT" : "gültig",
    s.void_reason || "",
    s.items.map((i) => `${i.qty}x ${i.name} à ${euro(i.unit_price_cents)}`).join(" | "),
    euro(s.total_cents),
    s.given_cents === null ? "" : euro(s.given_cents),
    s.given_cents === null ? "" : euro(Math.max(0, s.given_cents - s.total_cents)),
  ]);
  return csvResponse(`verkaeufe-${ev.id}.csv`, toCsv(header, data));
}

async function exportArticlesCsv(env, url) {
  const ev = await resolveEvent(env.DB, url);
  const rep = await loadReport(env.DB, ev);
  const data = [];
  for (const g of rep.groups) {
    for (const a of g.articles) data.push([g.name, a.name, a.qty, euro(a.revenue_cents)]);
    data.push([g.name, "Summe " + g.name, g.qty, euro(g.revenue_cents)]);
  }
  data.push(["", "Gesamt", rep.groups.reduce((t, g) => t + g.qty, 0), euro(rep.total_cents)]);
  return csvResponse(`artikel-${ev.id}.csv`, toCsv(["Gruppe", "Artikel", "Menge", "Umsatz EUR"], data));
}

// ---- Routing --------------------------------------------------------------

const ID = "(\\d+)";
const routes = [
  ["GET", /^\/api\/session$/, async () => json({ ok: true })],
  ["POST", /^\/api\/logout$/, async () => json({ ok: true }, 200, { "set-cookie": clearCookie() })],
  ["GET", /^\/api\/state$/, async (env) => json(await loadState(env.DB))],
  ["POST", /^\/api\/sales$/, (env, req) => postSale(env, req)],
  ["GET", /^\/api\/sales$/, (env, req, url) => listSales(env, url)],
  ["POST", /^\/api\/sales\/([0-9a-fA-F-]{36})\/void$/, (env, req, url, m) => voidSale(env, req, m[1].toLowerCase())],
  ["GET", /^\/api\/report$/, async (env, req, url) => json(await loadReport(env.DB, await resolveEvent(env.DB, url)))],
  ["GET", /^\/api\/events$/, async (env) => json({ events: (await env.DB.prepare("SELECT * FROM events ORDER BY id DESC").all()).results })],
  ["POST", /^\/api\/events$/, (env, req) => postEvent(env, req)],
  ["PATCH", new RegExp(`^/api/events/${ID}$`), (env, req, url, m) => patchEvent(env, req, Number(m[1]))],
  ["POST", /^\/api\/cash-counts$/, (env, req) => postCashCount(env, req)],
  ["POST", /^\/api\/groups$/, (env, req) => postGroup(env, req)],
  ["PATCH", new RegExp(`^/api/groups/${ID}$`), (env, req, url, m) => patchGroup(env, req, Number(m[1]))],
  ["POST", /^\/api\/articles$/, (env, req) => postArticle(env, req)],
  ["PATCH", new RegExp(`^/api/articles/${ID}$`), (env, req, url, m) => patchArticle(env, req, Number(m[1]))],
  ["POST", /^\/api\/reorder$/, (env, req) => reorder(env, req)],
  ["PUT", /^\/api\/settings$/, (env, req) => putSettings(env, req)],
  ["GET", /^\/api\/export\/all\.json$/, (env) => exportAll(env)],
  ["GET", /^\/api\/export\/sales\.csv$/, (env, req, url) => exportSalesCsv(env, url)],
  ["GET", /^\/api\/export\/articles\.csv$/, (env, req, url) => exportArticlesCsv(env, url)],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (!url.pathname.startsWith("/api/")) return new Response("Nicht gefunden", { status: 404 });

      if (url.pathname === "/api/login" && request.method === "POST") {
        const body = onlyKeys(await readJson(request), ["pin"], "Login");
        const cookie = await login(request, env, body.pin);
        return json({ ok: true }, 200, { "set-cookie": cookie });
      }

      if (!(await isAuthenticated(request, env))) return json({ error: "Nicht angemeldet" }, 401);

      for (const [method, pattern, handler] of routes) {
        if (request.method !== method) continue;
        const m = url.pathname.match(pattern);
        if (m) return await handler(env, request, url, m);
      }
      return json({ error: "Nicht gefunden" }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("Unerwarteter Fehler", err);
      return json({ error: "Interner Fehler" }, 500);
    }
  },
};
