-- Mini-Kasse: Schema. Geldbeträge überall als ganze Cent.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE groups (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE articles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES groups(id),
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  date          TEXT NOT NULL,
  opening_cents INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
-- Es gibt immer höchstens eine aktive Veranstaltung.
CREATE UNIQUE INDEX one_active_event ON events(active) WHERE active = 1;

CREATE TABLE sales (
  id                TEXT PRIMARY KEY,            -- UUID vom Gerät (Idempotenz)
  event_id          INTEGER NOT NULL REFERENCES events(id),
  number            INTEGER NOT NULL,            -- fortlaufend je Veranstaltung, vom Server vergeben
  device_name       TEXT NOT NULL,
  created_at_client TEXT NOT NULL,
  received_at       TEXT NOT NULL,
  total_cents       INTEGER NOT NULL,
  given_cents       INTEGER,
  voided_at         TEXT,
  void_reason       TEXT,
  UNIQUE (event_id, number)
);
CREATE INDEX sales_event ON sales(event_id);

CREATE TABLE sale_items (
  id               TEXT PRIMARY KEY,             -- <sale_id>:<position>, damit Wiederholungen nichts doppeln
  sale_id          TEXT NOT NULL REFERENCES sales(id),
  article_id       INTEGER NOT NULL REFERENCES articles(id),
  name_snapshot    TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  qty              INTEGER NOT NULL
);
CREATE INDEX sale_items_sale ON sale_items(sale_id);

CREATE TABLE cash_counts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id),
  counted_cents INTEGER NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE login_attempts (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0       -- epoch ms
);

-- Startdaten. Preise bewusst 0 – die Preise setzt der Verein in der Verwaltung.
INSERT INTO settings (key, value) VALUES
  ('club_name', 'Verein'),
  ('receipt_footer', 'Zählbeleg, keine Kassenbon-Pflichtangaben');

INSERT INTO groups (name, sort) VALUES ('Getränke', 1), ('Essen', 2);

INSERT INTO articles (group_id, name, price_cents, sort) VALUES
  (1, 'Glühwein', 0, 1),
  (1, 'Kinderpunsch', 0, 2),
  (2, 'Champignons', 0, 1);

INSERT INTO events (name, date, opening_cents, active, created_at)
VALUES ('Veranstaltung 1', date('now'), 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
