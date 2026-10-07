-- Schema SSOT for the V2 save-first service.
-- Applied by `wrangler d1 migrations apply` and, statement by statement, by the
-- acceptance oracle. Keep every statement terminated by a single semicolon and
-- keep semicolons out of comments.

-- One entry and its receipt bytes in one durable row, so a 'saved' answer can
-- only follow a store that already holds both. client_entry_id is the primary
-- key, which is what makes the same send twice one row (D10).
CREATE TABLE IF NOT EXISTS entry (
  client_entry_id TEXT PRIMARY KEY,
  amount_laari    INTEGER NOT NULL CHECK (amount_laari > 0),
  category        TEXT NOT NULL,
  receipt         BLOB,
  status          TEXT NOT NULL,
  entry_date      TEXT NOT NULL,
  saved_at        TEXT NOT NULL,
  -- The Odoo sync's own columns. odoo_id is null until the draft expense exists
  -- and is what lets the entry remember which expense is its own. attempts
  -- carries a DEFAULT so the save's column-listing INSERT stays valid unchanged.
  odoo_id         INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TEXT,
  last_error      TEXT,
  synced_at       TEXT
);

-- The day read (D16) goes through this index, so a later day boundary cannot
-- move an already-saved entry out of the day it was recorded in.
CREATE INDEX IF NOT EXISTS entry_by_date
  ON entry (entry_date, saved_at, client_entry_id);

-- The work queue the schedule reads: entries never sent, and failed entries
-- whose next retry time has come, oldest first.
CREATE INDEX IF NOT EXISTS entry_by_sync
  ON entry (status, next_retry_at, saved_at, client_entry_id);

-- The wrong-PIN fixed-window counter. It holds no PIN, only a count of misses
-- per source per 10-second window.
CREATE TABLE IF NOT EXISTS pin_attempt (
  source   TEXT NOT NULL,
  "window" INTEGER NOT NULL,
  misses   INTEGER NOT NULL,
  PRIMARY KEY (source, "window")
);
