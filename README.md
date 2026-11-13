# Kasse-Stand – Mini-Kasse für den Vereins-Stand

Zähl- und Kalkulationshilfe für einen Verkaufsstand (Glühwein, Kinderpunsch, Champignons).
2–3 Handys und optional ein Tablet (zentrale Kasse) erfassen Verkäufe gleichzeitig in einer gemeinsamen
Datensammlung. Danach gibt es einen Bericht mit Menge und Umsatz pro Artikel und eine Kassensturz-Rechnung.

> **Keine zertifizierte Kasse.** Keine TSE, kein DSFinV-K, keine Steuersatz-Auswertung, keine Kartenzahlung.
> Es ist ein Zählwerkzeug. Die steuerliche und kassenrechtliche Einordnung liegt beim Verein
> (Kassenwart/Steuerberater). Auf dem Bon steht deshalb „Zählbeleg, keine Kassenbon-Pflichtangaben“.

## Aufbau

| Teil | Technik |
| --- | --- |
| Frontend | Vanilla JS (ES-Module), HTML, CSS – kein Build-Schritt, keine externen Schriften/CDNs. PWA mit `manifest.json` und Service Worker (App-Hülle offline). |
| Backend | Cloudflare Worker mit Static Assets, API unter `/api/*` (`src/`). |
| Datenbank | Cloudflare D1, Migrationen als SQL in `migrations/`. |
| Tests | Vitest im Workers-Runtime-Pool (`test/`), E2E mit Playwright gegen `wrangler dev` (`e2e/`). |

Wichtige Entwurfsentscheidungen:

- **Offline zuerst:** Ein Verkauf wird zuerst in IndexedDB gespeichert und im Hintergrund gesendet. Das Tippen
  auf Artikel wartet nie auf das Netz. Oben zeigt die App „n Verkäufe noch nicht synchronisiert“.
- **Idempotent:** Jeder Verkauf hat eine UUID vom Gerät. `POST /api/sales` nutzt `INSERT OR IGNORE`
  (und feste Positions-IDs `<uuid>:<n>`), Wiederholungen zählen nie doppelt – auch nicht bei parallelen Anfragen.
- **Append-only:** Verkäufe werden nur hinzugefügt oder storniert (mit Grund), nie überschrieben.
  Stornos bleiben sichtbar und zählen nicht im Bericht.
- **Snapshot:** Name und Einzelpreis stehen in jeder Position. Spätere Preisänderungen verfälschen alte Verkäufe nicht.
- **Belegnummer:** fortlaufend je Veranstaltung, serverseitig beim Empfang vergeben. Offline zeigt die App eine
  vorläufige Nummer (Gerätekürzel + Zähler, z. B. `K1-017`), die beim Senden durch die echte ersetzt wird.
- **Geld:** überall ganze Cent, nie Fließkommazahlen. Die Summe wird auf dem Server aus den Positionen neu berechnet.
- **Layout:** Hochformat am Handy (Menü hinter ☰, große Tasten), Querformat am Tablet (Navigationsleiste links,
  Artikel groß, Warenkorb und Zahlung rechts, Zahlenblock für beliebige Beträge).

## Anmeldung und Sicherheit

- Login per PIN. Die PIN steht **nicht** im Repo, sondern als Worker-Secret `KASSE_PIN`.
  Das Session-Cookie wird per HMAC mit dem Secret `SESSION_SECRET` signiert (HttpOnly, Secure, SameSite=Strict, 14 Tage).
- PIN-Vergleich in konstanter Zeit. Alle `/api/*`-Routen außer `/api/login` verlangen die Session (sonst 401).
- Brute-Force-Schutz serverseitig in D1 (`login_attempts`): nach 5 Fehlversuchen von derselben IP 15 Minuten Sperre.
  *Hinweis:* Hinter demselben WLAN/Mobilfunk-NAT teilen sich mehrere Geräte eine IP; eine Sperre trifft dann alle.
- Eingaben werden serverseitig geprüft (Beträge, Mengen 1–99, bekannte Artikel-IDs, nur erlaubte Felder).
- Header: `nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, CSP; `robots.txt` mit `Disallow: /`.
- Keine personenbezogenen Daten außer dem Gerätenamen. Keine Tracker.
- *Optionale Härtung (nicht umgesetzt):* zusätzlich Cloudflare Access (E-Mail-Code) vor der Domain.

## Deployment

Voraussetzungen: Node 20+, ein Cloudflare-Account. Es werden nur **neue** Ressourcen angelegt
(Worker `kasse-stand`, D1-Datenbank `kasse-stand`). Bestehende Projekte (z. B. `openpos-kasse`) bleiben unberührt.

```bash
npm install
npx wrangler login            # oder CLOUDFLARE_API_TOKEN setzen
```

1. **Datenbank + Worker anlegen.** Beim ersten `wrangler deploy` legt Wrangler die D1-Datenbank `kasse-stand`
   automatisch an und trägt die ID ein. Alternativ vorab:

   ```bash
   npx wrangler d1 create kasse-stand
   ```

   (die ausgegebene `database_id` in `wrangler.jsonc` unter `d1_databases` ergänzen)

2. **Secrets setzen.** Die Werte nie in Dateien oder Logs ablegen. Wrangler fragt sie interaktiv ab:

   ```bash
   npx wrangler secret put KASSE_PIN        # die PIN eingeben (wird nicht angezeigt)
   openssl rand -base64 48                  # zufälligen Wert erzeugen und kopieren
   npx wrangler secret put SESSION_SECRET   # den erzeugten Wert einfügen
   ```

   Die PIN lässt sich jederzeit mit `wrangler secret put KASSE_PIN` ändern. Wird `SESSION_SECRET` neu gesetzt,
   werden alle Geräte abgemeldet.

3. **Migrationen und Deploy:**

   ```bash
   npm run deploy      # = wrangler d1 migrations apply DB --remote && wrangler deploy
   ```

   Die App läuft danach unter `https://kasse-stand.<dein-subdomain>.workers.dev`.
   Der erste Aufruf fragt nach der PIN und einmalig nach dem Gerätenamen (z. B. „Kasse 1“, „Ausschank“).
   Danach am Handy „Zum Startbildschirm hinzufügen“.

4. **Ersteinrichtung in der App** (Menü ☰ → Verwaltung): Preise der Artikel setzen (Startdaten haben bewusst `0,00 €`
   mit Hinweis „Preis setzen“), Vereinsname und Bon-Fußzeile eintragen, Veranstaltung mit Anfangsbestand Wechselgeld anlegen.

Lokal entwickeln:

```bash
printf 'KASSE_PIN=1234\nSESSION_SECRET=lokal-nur-zum-testen\n' > .dev.vars   # .dev.vars ist gitignored
npm run db:migrate:local
npm run dev                                                                   # http://localhost:8787
```

Nach Änderungen an Dateien in `public/` die Versionsnummer `CACHE` in `public/sw.js` erhöhen, damit
Geräte die neue App-Hülle laden.

## Betrieb und Backup

- **Bericht:** Menü → Bericht, live aus der Datenbank (alle Geräte), mit „Aktualisieren“ und Zeitstempel „Stand“.
  Hat das Gerät noch nicht synchronisierte Verkäufe, zeigt der Bericht einen deutlichen Warnhinweis.
- **Export:** CSV der Verkäufe (ein Verkauf pro Zeile mit Positionen) und CSV der Artikelzusammenfassung
  (Semikolon, UTF-8 mit BOM, öffnet direkt in deutschem Excel). Druckbare Berichtsansicht über „Drucken“.
- **Backup als Datei:** Verwaltung → Einstellungen → „Alles als JSON exportieren“, oder per Kommandozeile:

  ```bash
  npx wrangler d1 export kasse-stand --remote --output kasse-backup.sql
  ```

- **D1 Time Travel:** Cloudflare hält die Datenbank der letzten 30 Tage wiederherstellbar:

  ```bash
  npx wrangler d1 time-travel info kasse-stand
  npx wrangler d1 time-travel restore kasse-stand --timestamp=<ISO-Zeit>
  ```

## Tests

```bash
npm test            # API-/Berichtstests in der Workers-Runtime (Miniflare), ca. 3 s
npm run test:e2e    # Browser-Test: Kassieren, Offline-Warteschlange, Sync genau einmal, Storno, Tablet
```

`test:e2e` startet selbst ein lokales `wrangler dev` mit Test-Secrets und benötigt Playwright mit Chromium
(`npm i -D playwright && npx playwright install chromium`, falls nicht ohnehin vorhanden). Mit `SHOTS=<Ordner>`
legt er Screenshots ab.

Abgedeckt sind: Login (richtige/falsche PIN, Sperre nach 5 Versuchen, 401 ohne Cookie), Idempotenz,
zwei parallele Geräte, Preis-Snapshot, Storno, Kassensturz in Cent, Eingabevalidierung, Exporte, Offline-Sync.

## Abnahme (Handy)

1. 3 Geräte anmelden, je einen eigenen Gerätenamen vergeben.
2. Je 10 Verkäufe erfassen und parallel eine Strichliste führen. Bericht („Aktualisieren“) mit der Strichliste vergleichen.
3. Flugmodus: Verkauf erfassen (Hinweis „1 Verkauf noch nicht synchronisiert“), Flugmodus aus, Hinweis verschwindet,
   Verkauf erscheint genau einmal im Bericht.
4. Bon: auf dem Bon „Drucken“ und „Teilen“ ausprobieren. Einen Verkauf stornieren.
5. Kassensturz: Soll prüfen, gezähltes Bargeld eingeben, Differenz kontrollieren.

## Annahmen (offene Punkte aus der Anforderung)

- Kein Becherpfand (gibt es am Stand nicht), daher kein Pfand-Artikel.
- Artikelpreise sind Platzhalter (`0,00 €`), solange der Verein sie nicht setzt. Mit Preis 0 lässt sich nicht kassieren.
- Vereinsname ist anfangs „Verein“, die Bon-Kopfzeile ist der Vereinsname. Beides in der Verwaltung ändern.
- Annahme zur Netzabdeckung: am Stand kann sie ausfallen, deshalb ist die Offline-Warteschlange fester Bestandteil.
- Storno und Bericht brauchen Netz (sie betreffen die Daten aller Geräte). Kassieren geht immer.
- Die PIN ist vorläufig; Änderung jederzeit über das Secret `KASSE_PIN`.
