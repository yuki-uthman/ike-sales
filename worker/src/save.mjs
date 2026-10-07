// The save rule and the day read. Takes an already-parsed entry plus the D1
// binding; knows nothing of Request, Response, headers or status codes
// (decision 17). D1 failures are left to propagate — the boundary turns them
// into the Indeterminate answers `not_stored` and `not_read` (decision 16).

import { formatLaariAsMvr } from './mvr.mjs';

// D12's vocabulary, mapped in exactly one place so no second vocabulary can
// appear. V5 adds the last two words the page already knows how to render.
const STATUS_WORD = {
  waiting: 'Waiting to send',
  failed: 'Not sent',
  draft: 'Draft',
  approved: 'Approved',
  refused: 'Refused'
};
export const STATUS_WAITING = 'waiting';
export const STATUS_FAILED = 'failed';
export const STATUS_DRAFT = 'draft';
export const STATUS_APPROVED = 'approved';
export const STATUS_REFUSED = 'refused';

// The statuses that mean "this entry is already in Odoo, there is nothing left
// to send". Deliberately not 'odoo_id is not null': an entry that failed after
// adopting its expense must still retry so its receipt can attach (decision 13).
const IN_ODOO = new Set([STATUS_DRAFT, STATUS_APPROVED, STATUS_REFUSED]);

export function isInOdoo(status) {
  return IN_ODOO.has(status);
}

/** The Maldives UTC+5 date (D16) at `at`, as YYYY-MM-DD. */
export function maldivesDate(at = Date.now()) {
  return new Date(at + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** The wrong-PIN window index (decision 11): fixed 10-second windows. */
export const WINDOW_MS = 10000;
export const WRONG_PIN_LIMIT = 5;

export function windowIndex(at = Date.now()) {
  return Math.floor(at / WINDOW_MS);
}

export function windowEnd(index) {
  return new Date((index + 1) * WINDOW_MS);
}

/**
 * Project a stored row onto the seven members the contract declares, used by the
 * save answer, the day list and the single-entry answer alike, so the three
 * cannot drift. The receipt bytes themselves never leave D1, and neither do
 * odoo_id, attempts, last_error or synced_at (decision 18).
 */
function projectEntry(row) {
  const bytes = Number(row.receipt_bytes || 0);
  const status = STATUS_WORD[row.status] ? row.status : STATUS_WAITING;
  return {
    client_entry_id: row.client_entry_id,
    amount_mvr: formatLaariAsMvr(Number(row.amount_laari)),
    category: row.category,
    status: STATUS_WORD[status],
    receipt_present: bytes > 0,
    receipt_bytes: bytes,
    // The page renders the retry bar on this member's truthiness, so anything
    // but an unsent entry is explicitly null.
    next_retry_at: status === STATUS_FAILED ? (row.next_retry_at || null) : null
  };
}

const SELECT_COLUMNS =
  'client_entry_id, amount_laari, category, status, next_retry_at,'
  + ' COALESCE(length(receipt), 0) AS receipt_bytes';

// What the sync rule needs to know about an entry: never the receipt bytes
// themselves, only whether there are any.
const SYNC_COLUMNS =
  'client_entry_id, amount_laari, category, entry_date, status,'
  + ' COALESCE(attempts, 0) AS attempts, odoo_id, next_retry_at,'
  + ' COALESCE(length(receipt), 0) AS receipt_bytes';

const SYNC_LIMIT = 25;

/**
 * Store the entry and its receipt bytes together in one awaited statement, then
 * answer out of the store. The same client_entry_id twice stores one row and
 * answers about the row the first send stored (D10, decision 5).
 */
export async function saveEntry(db, entry) {
  await db
    .prepare(
      'INSERT INTO entry'
      + ' (client_entry_id, amount_laari, category, receipt, status, entry_date, saved_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT(client_entry_id) DO NOTHING'
    )
    .bind(
      entry.client_entry_id,
      entry.amount_laari,
      entry.category,
      entry.receipt === null ? null : entry.receipt,
      STATUS_WAITING,
      entry.entry_date,
      entry.saved_at
    )
    .run();

  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM entry WHERE client_entry_id = ?`)
    .bind(entry.client_entry_id)
    .first();

  if (!row) throw new Error('entry not present after insert');
  return projectEntry(row);
}

/** The day's entries, ordered by saved_at then client_entry_id (decision 13). */
export async function listDay(db, date) {
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM entry WHERE entry_date = ?`
      + ' ORDER BY saved_at ASC, client_entry_id ASC'
    )
    .bind(date)
    .all();
  return (results || []).map(projectEntry);
}

/** One entry's projection, or null when no such entry was ever saved. */
export async function entryProjection(db, clientEntryId) {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM entry WHERE client_entry_id = ?`)
    .bind(clientEntryId)
    .first();
  return row ? projectEntry(row) : null;
}

/** What the sync rule needs about one entry, or null. */
export async function syncRow(db, clientEntryId) {
  return db
    .prepare(`SELECT ${SYNC_COLUMNS} FROM entry WHERE client_entry_id = ?`)
    .bind(clientEntryId)
    .first();
}

/**
 * The work queue: entries never sent are always due, and failed entries become
 * due again at their next retry time (decision 15).
 */
export async function dueEntries(db, nowIso, limit = SYNC_LIMIT) {
  const { results } = await db
    .prepare(
      `SELECT ${SYNC_COLUMNS} FROM entry`
      + ` WHERE status = '${STATUS_WAITING}'`
      + `    OR (status = '${STATUS_FAILED}'`
      + '        AND (next_retry_at IS NULL OR next_retry_at <= ?))'
      + ' ORDER BY saved_at ASC, client_entry_id ASC LIMIT ?'
    )
    .bind(nowIso, limit)
    .all();
  return results || [];
}

/**
 * The read-back queue (D13): the entries that still show 'Draft'. The
 * `status = 'draft'` predicate IS the clause "an entry in Approved or Refused is
 * not read again" — it needs no second mechanism and no flag. There is
 * deliberately no entry_date filter and no cap: a draft filed yesterday that a
 * person approves today must still catch up, and capping the list would starve a
 * new draft behind older never-approved ones (decisions 4, 5).
 */
export async function draftEntries(db) {
  const { results } = await db
    .prepare(
      'SELECT client_entry_id, odoo_id FROM entry'
      + ` WHERE status = '${STATUS_DRAFT}' AND odoo_id IS NOT NULL`
      + ' ORDER BY saved_at ASC, client_entry_id ASC'
    )
    .all();
  return results || [];
}

/**
 * The read-back's only write: one column, and only where the chip moved. The
 * `status = 'draft'` guard makes it idempotent and unable to overwrite a chip
 * another step has since moved. last_error, next_retry_at and attempts are never
 * touched — the send succeeded, so 'Not sent' would be a lie (decisions 9, 10).
 */
export async function markOdooState(db, { clientEntryId, status }) {
  await db
    .prepare(
      `UPDATE entry SET status = ? WHERE client_entry_id = ? AND status = '${STATUS_DRAFT}'`
    )
    .bind(status, clientEntryId)
    .run();
}

/** The receipt bytes, read only when there is an attachment to make. */
export async function receiptBytes(db, clientEntryId) {
  const row = await db
    .prepare('SELECT receipt FROM entry WHERE client_entry_id = ?')
    .bind(clientEntryId)
    .first();
  const value = row && row.receipt;
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/**
 * The entry is now a draft expense. The entry row, its receipt and its amount
 * are never rewritten; attempts is left as the honest count of tries it took.
 */
export async function markSynced(db, { clientEntryId, odooId, attempts, syncedAt }) {
  await db
    .prepare(
      `UPDATE entry SET status = '${STATUS_DRAFT}', odoo_id = ?, attempts = ?,`
      + ' next_retry_at = NULL, last_error = NULL, synced_at = ?'
      + ' WHERE client_entry_id = ?'
    )
    .bind(odooId, attempts, syncedAt, clientEntryId)
    .run();
}

/** The attempt did not land. odoo_id is left untouched (decision 14). */
export async function markFailed(db, { clientEntryId, attempts, nextRetryAt, code }) {
  await db
    .prepare(
      `UPDATE entry SET status = '${STATUS_FAILED}', attempts = ?,`
      + ' next_retry_at = ?, last_error = ? WHERE client_entry_id = ?'
    )
    .bind(attempts, nextRetryAt, code, clientEntryId)
    .run();
}

/** Misses already recorded for this source in this window. */
export async function wrongPinMisses(db, source, index) {
  const row = await db
    .prepare('SELECT misses FROM pin_attempt WHERE source = ? AND "window" = ?')
    .bind(source, index)
    .first();
  return row ? Number(row.misses) : 0;
}

/** Only a failed comparison consumes budget (decision 11). */
export async function recordWrongPin(db, source, index) {
  await db
    .prepare(
      'INSERT INTO pin_attempt (source, "window", misses) VALUES (?, ?, 1)'
      + ' ON CONFLICT(source, "window") DO UPDATE SET misses = misses + 1'
    )
    .bind(source, index)
    .run();
}
