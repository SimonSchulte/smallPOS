import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, freshIp, login } from "./helpers.js";

describe("Login", () => {
  it("richtige PIN setzt ein sicheres Session-Cookie, das geschützte Routen freischaltet", async () => {
    const { res, cookie, setCookie } = await login("0000");
    expect(res.status).toBe(200);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Max-Age=1209600/);
    const ok = await call("/api/session", { cookie });
    expect(ok.status).toBe(200);
  });

  it("falsche PIN gibt 401 und kein Cookie", async () => {
    const { res, setCookie } = await login("9999");
    expect(res.status).toBe(401);
    expect(setCookie).toBeNull();
  });

  it("geschützte Routen ohne Cookie geben 401", async () => {
    for (const [method, path] of [
      ["GET", "/api/state"],
      ["GET", "/api/sales"],
      ["POST", "/api/sales"],
      ["GET", "/api/report"],
      ["GET", "/api/export/all.json"],
      ["PUT", "/api/settings"],
    ]) {
      const res = await call(path, { method, body: method === "GET" ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("manipuliertes oder abgelaufenes Cookie wird abgelehnt", async () => {
    const { cookie } = await login("0000");
    const [name, value] = cookie.split("=");
    const [exp, sig] = value.split(".");
    const tamperedExp = `${name}=${Number(exp) + 1000}.${sig}`;
    const tamperedSig = `${name}=${exp}.${sig.slice(0, -2)}xx`;
    const past = `${name}=${Math.floor(Date.now() / 1000) - 10}.${sig}`;
    for (const c of [tamperedExp, tamperedSig, past, `${name}=muell`]) {
      expect((await call("/api/session", { cookie: c })).status).toBe(401);
    }
  });

  it("sperrt nach 5 Fehlversuchen 15 Minuten, auch für die richtige PIN, unabhängig vom Client", async () => {
    const ip = freshIp();
    for (let i = 1; i <= 4; i++) {
      const r = await call("/api/login", { method: "POST", body: { pin: "1111" }, ip });
      expect(r.status).toBe(401);
    }
    const fifth = await call("/api/login", { method: "POST", body: { pin: "1111" }, ip });
    expect(fifth.status).toBe(429);
    const correctWhileLocked = await call("/api/login", { method: "POST", body: { pin: "0000" }, ip });
    expect(correctWhileLocked.status).toBe(429);
    expect(correctWhileLocked.headers.get("set-cookie")).toBeNull();
    // andere IP ist nicht betroffen
    const other = await login("0000", freshIp());
    expect(other.res.status).toBe(200);
  });

  it("Sperre läuft nach 15 Minuten ab", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await call("/api/login", { method: "POST", body: { pin: "1111" }, ip });
    expect((await call("/api/login", { method: "POST", body: { pin: "0000" }, ip })).status).toBe(429);
    await env.DB.prepare("UPDATE login_attempts SET locked_until = ? WHERE key = ?").bind(Date.now() - 1000, `ip:${ip}`).run();
    expect((await call("/api/login", { method: "POST", body: { pin: "0000" }, ip })).status).toBe(200);
  });

  it("erfolgreicher Login setzt den Fehlerzähler zurück", async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await call("/api/login", { method: "POST", body: { pin: "1111" }, ip });
    expect((await call("/api/login", { method: "POST", body: { pin: "0000" }, ip })).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await call("/api/login", { method: "POST", body: { pin: "1111" }, ip })).status).toBe(401);
  });

  it("Antworten tragen Sicherheitsheader", async () => {
    const res = await call("/api/session");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
  });
});
