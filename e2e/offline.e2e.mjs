// E2E im echten Browser gegen einen lokalen `wrangler dev`: Kassieren, Offline-Warteschlange, Sync genau einmal.
// Aufruf: npm run test:e2e   (benötigt Playwright mit Chromium; Screenshots optional mit SHOTS=<Ordner>)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PORT = 8791;
const BASE = `http://localhost:${PORT}`;
const PIN = "2468"; // nur für diesen Testlauf, nicht die echte PIN
const SECRET = "e2e-session-secret-0123456789abcdef";
const persist = mkdtempSync(join(tmpdir(), "kasse-e2e-"));
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const mig = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], { encoding: "utf8" });
assert.equal(mig.status, 0, mig.stdout + mig.stderr);

const server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", persist, "--var", `KASSE_PIN:${PIN}`, "--var", `SESSION_SECRET:${SECRET}`], { stdio: "ignore", detached: true });
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/robots.txt`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev startete nicht");
}

async function adminApi() {
  const res = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: PIN }) });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, { ...opts, headers: { cookie, "content-type": "application/json" }, body: opts.body && JSON.stringify(opts.body) });
    return r.json();
  };
}

let failed = false;
let page;
try {
  await waitUp();
  const admin = await adminApi();
  const state = await admin("/api/state");
  const prices = { Glühwein: 350, Kinderpunsch: 250, Champignons: 400 };
  for (const a of state.articles) await admin(`/api/articles/${a.id}`, { method: "PATCH", body: { price_cents: prices[a.name] } });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const shot = async (name) => shots && page.screenshot({ path: join(shots, name + ".png") });

  // --- Anmeldung und Gerätename
  await page.goto(BASE + "/");
  await page.waitForSelector(".pinpad");
  for (const k of "1111") await page.click(`.pinpad [data-k="${k}"]`);
  await page.click('.pinpad [data-k="OK"]');
  await page.waitForFunction(() => document.querySelector(".err")?.textContent.includes("Falsche PIN"));
  for (const k of PIN) await page.click(`.pinpad [data-k="${k}"]`);
  await page.click('.pinpad [data-k="OK"]');
  await page.fill("input[name=device]", "Kasse 1");
  await page.click(".login .go");
  await page.waitForSelector(".kasse .art");
  await shot("01-kasse-leer");

  // --- Online kassieren: 2x Glühwein, 1x Champignons = 11,00 €, 20 € gegeben -> 9,00 € Rückgeld
  const art = (name) => page.locator(".art", { hasText: name });
  await art("Glühwein").click();
  await art("Glühwein").click();
  await art("Champignons").click();
  assert.match(await page.locator(".sumrow b").innerText(), /11,00/);
  await page.locator(".chips button", { hasText: "20" }).first().click();
  assert.match(await page.locator(".rg").innerText(), /Rückgeld[\s\S]*9,00/);
  await shot("02-kasse-rueckgeld");
  await page.click(".kasse .go");
  await page.waitForSelector(".toast.ok");
  assert.match(await page.locator(".toast").innerText(), /11,00.*kassiert[\s\S]*Rückgeld 9,00/);
  await page.waitForFunction(() => !document.querySelector(".chip.warn"), null, { timeout: 15000 });
  assert.equal((await admin("/api/report")).sales_count, 1, "Online-Verkauf kam nicht an");
  assert.match(await page.locator(".lines").innerText(), /Artikel antippen/, "Warenkorb wurde nicht geleert");

  // --- Offline: Kasse bleibt bedienbar, Verkauf wird lokal gespeichert
  await page.waitForTimeout(500); // Service Worker hat die App-Hülle im Zwischenspeicher
  await ctx.setOffline(true);
  await art("Kinderpunsch").click();
  await art("Kinderpunsch").click();
  await page.click(".kasse .go");
  await page.waitForSelector(".toast.ok");
  await page.waitForFunction(() => document.getElementById("banner").textContent.includes("1 Verkauf noch nicht synchronisiert"));
  assert.match(await page.locator("#hdr .chip").innerText(), /1 nicht synchronisiert/);
  await shot("03-offline-wartend");
  assert.equal((await admin("/api/report")).sales_count, 1, "Offline-Verkauf darf noch nicht auf dem Server sein");

  // Seite offline neu laden: App-Hülle und Katalog kommen aus dem Zwischenspeicher
  await page.reload();
  await page.waitForSelector(".kasse .art");
  assert.match(await page.locator("#banner").innerText(), /1 Verkauf noch nicht synchronisiert/);

  // --- Netz kehrt zurück: genau eine Synchronisation
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => document.getElementById("banner").classList.contains("empty"), null, { timeout: 20000 });
  let report = await admin("/api/report");
  assert.equal(report.sales_count, 2, "Verkauf wurde nicht (genau einmal) synchronisiert");
  assert.equal(report.total_cents, 1100 + 500);
  await page.evaluate(() => window.dispatchEvent(new Event("online"))); // weitere Auslöser dürfen nichts doppeln
  await page.reload();
  await page.waitForSelector(".kasse .art");
  await page.waitForTimeout(1500);
  report = await admin("/api/report");
  assert.equal(report.sales_count, 2, "Wiederholtes Senden hat doppelt gezählt");

  // --- Verlauf, Bon, Storno, Bericht
  await page.goto(BASE + "/#/verkaeufe");
  await page.waitForSelector(".srow");
  assert.equal(await page.locator(".srow").count(), 2);
  await page.locator(".srow").first().click();
  await page.waitForSelector(".paper");
  assert.match(await page.locator(".paper").innerText(), /2 × Kinderpunsch/);
  await shot("04-bon");
  await page.click('[data-act="voidAsk"]');
  await page.click('[data-act="voidReason"]');
  await shot("05-storno");
  await page.click('#sheet button[type="submit"]');
  await page.waitForSelector(".notice.danger");
  report = await admin("/api/report");
  assert.equal(report.sales_count, 1);
  assert.equal(report.voids.count, 1);

  await page.goto(BASE + "/#/bericht");
  await page.waitForSelector(".kpis");
  assert.match(await page.locator(".kpis").innerText(), /11,00/);
  await shot("06-bericht");
  await page.goto(BASE + "/#/kassensturz");
  await page.waitForSelector("input[name=counted]");
  await page.fill("input[name=counted]", "10,50");
  await page.waitForSelector(".diff.short");
  await shot("07-kassensturz");

  await page.goto(BASE + "/#/verwaltung/artikel");
  await page.waitForSelector(".arow");
  await page.locator(".aname", { hasText: "Glühwein" }).click();
  await page.fill('#sheet input[name="price"]', "3,80");
  await page.click('#sheet button[type="submit"]');
  await page.waitForFunction(() => document.querySelector(".arow .price")?.textContent.includes("3,80"));
  assert.equal((await admin("/api/state")).articles.find((a) => a.name === "Glühwein").price_cents, 380);
  await shot("09-verwaltung");

  // --- Tablet quer
  const tab = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await ctx.storageState() });
  const tp = await tab.newPage();
  await tp.goto(BASE + "/");
  await tp.waitForSelector("input[name=device]"); // neues Gerät (andere IndexedDB): Name wird abgefragt
  await tp.fill("input[name=device]", "Zentrale Kasse");
  await tp.click(".login .go");
  await tp.waitForSelector(".kasse .art");
  assert.ok(await tp.locator("#rail").isVisible(), "Tablet: Navigationsleiste fehlt");
  await tp.locator(".art", { hasText: "Glühwein" }).click();
  await tp.locator(".chips button", { hasText: "Betrag" }).click();
  for (const k of "20") await tp.click(`.pad [data-k="${k}"]`);
  assert.match(await tp.locator(".rg").innerText(), /Rückgeld[\s\S]*16,20/);
  if (shots) await tp.screenshot({ path: join(shots, "08-tablet.png") });
  await tab.close();

  assert.deepEqual(pageErrors, [], "JavaScript-Fehler im Browser: " + pageErrors.join("; "));
  await browser.close();
  console.log("E2E OK");
} catch (err) {
  failed = true;
  console.error("E2E FEHLGESCHLAGEN:", err);
  if (shots && page) await page.screenshot({ path: join(shots, "fehler.png") }).catch(() => {});
} finally {
  stop();
  process.exit(failed ? 1 : 0);
}
