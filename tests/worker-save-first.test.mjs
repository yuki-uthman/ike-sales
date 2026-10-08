// Oracle for "V2 Save-first service".
//
// Authority: docs/product/brief.md#Decisions (D3, D7, D8, D10, D12, D14, D15,
// D16) and Scope -> DESIGN "V2 Save-first service".
//
// Driving port: HTTP. The Worker is served by a real workerd runtime (miniflare)
// on a real loopback socket and spoken to with plain `fetch`. Nothing under
// worker/src is imported here. The only other thing this oracle touches is the
// driven port the design declares — the D1 binding — and it touches it only to
// apply worker/migrations/0001_init.sql (the schema SSOT) and to read back what
// the store actually holds.
//
// Every name asserted below is declared by the handover's HTTP contract: the
// paths /expenses/entries, /expenses/categories (D17), the request members pin/category/amount/receipt/
// client_entry_id, the six response members client_entry_id/amount_mvr/category/
// status/receipt_present/receipt_bytes, the error codes, and D12's status word
// "Waiting to send". Config facts (main, compatibility date, the D1 binding
// name, migrations_dir, ALLOWED_ORIGIN) are read from worker/wrangler.json, the
// declared config SSOT, rather than duplicated here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(REPO, 'worker');

// D7: the 21 Odoo expense categories, in D7's order.
const CATEGORIES_D7 = [
  'Advertising & Marketing', 'Communication', 'Electricity', 'Fuel / Petrol',
  'Gate Pass (Boat Delivery)', 'Gifts', 'Internet', 'Meals',
  'Medical Checkup (Visa)', 'Salary', 'Shop Maintenance & Repairs', 'Shop Rent',
  'Software Subscriptions', 'Staff Accommodation Rent',
  'Stationery & Packing Supplies', 'Travel & Accommodation',
  'Vehicle Maintenance', 'Visa & Work Permit', 'Warehouse Rent',
  'Waste Disposal', 'Water'
];

// D12: every V2 entry starts here, and V2 produces no other status.
const STATUS_WAITING = 'Waiting to send';

// The members an entry has — exactly these seven, no more. The receipt bytes
// never leave D1 in V2, so only their presence and length appear here.
// next_retry_at belongs to the sending vocabulary; V2 sends nothing, so it is
// null on every V2 entry, but the member is part of the one entry shape.
const ENTRY_MEMBERS = [
  'amount_mvr', 'category', 'client_entry_id', 'next_retry_at',
  'receipt_bytes', 'receipt_present', 'status'
];

const PIN = '4821';
const OTHER_PIN = '9073';

// Decision 9: the allowed origin is a browser-enforced host check; the host is
// read from wrangler.json, this is only the authority it must equal.
const EXPECTED_ALLOWED_ORIGIN = 'https://yuki-uthman.github.io';

const RECEIPT_CAP = 1000000; // decision 16: the Worker's own declared cap

/** The Maldives UTC+5 date (D16) at this instant, as YYYY-MM-DD. */
function maldivesDate(at = Date.now()) {
  return new Date(at + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function readConfig() {
  const cfg = JSON.parse(await fs.readFile(path.join(WORKER, 'wrangler.json'), 'utf8'));
  assert.ok(typeof cfg.main === 'string' && cfg.main.endsWith('.mjs'),
    'wrangler.json declares an .mjs module entrypoint (decision 3)');
  assert.match(cfg.compatibility_date || '', /^\d{4}-\d{2}-\d{2}$/,
    'wrangler.json declares a compatibility date');
  assert.equal((cfg.d1_databases || []).length, 1,
    'the one driven port is a single D1 binding (decision 17)');
  assert.ok(typeof cfg.d1_databases[0].migrations_dir === 'string',
    'wrangler.json declares migrations_dir, so deploy and this oracle read one schema');
  assert.equal((cfg.vars || {}).ALLOWED_ORIGIN, EXPECTED_ALLOWED_ORIGIN,
    'ALLOWED_ORIGIN lives in config, not as a literal in code (decision 9)');
  assert.deepEqual((cfg.triggers || {}).crons, ['*/15 * * * *'],
    'the config declares exactly the */15 cron trigger');
  return cfg;
}

/** Start a real workerd on a loopback socket over the given D1 directory. */
async function startWorker(cfg, { pin, persist }) {
  const binding = cfg.d1_databases[0].binding;
  const mf = new Miniflare({
    scriptPath: path.join(WORKER, cfg.main),
    modules: true,
    modulesRoot: WORKER,
    compatibilityDate: cfg.compatibility_date,
    compatibilityFlags: cfg.compatibility_flags || [],
    d1Databases: { [binding]: cfg.d1_databases[0].database_id || binding },
    d1Persist: persist,
    bindings: { ...(cfg.vars || {}), EXPENSE_PIN: pin },
    port: 0
  });
  const url = await mf.ready;
  const db = await mf.getD1Database(binding);
  const base = url.origin;
  const allowed = cfg.vars.ALLOWED_ORIGIN;

  const call = async (method, pathname, { origin = allowed, body, ip = '127.0.0.1', raw } = {}) => {
    const headers = { 'CF-Connecting-IP': ip };
    if (origin !== null) headers.Origin = origin;
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + pathname, {
      method,
      headers,
      body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body))
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
    return { res, text, json };
  };

  return { mf, db, call, allowed, binding };
}

/**
 * Apply the schema SSOT the way decision 12 declares: strip `--` comments, split
 * on ';', run the statements as one batch. If 0001_init.sql cannot be applied
 * this way, nothing below can run — which is itself the point.
 */
async function applySchema(db, cfg) {
  // Every migration, in file-name order, as `wrangler d1 migrations apply` runs them.
  const dir = path.join(WORKER, cfg.d1_databases[0].migrations_dir);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  const sql = (await Promise.all(files.map(f => fs.readFile(path.join(dir, f), 'utf8')))).join('\n');
  const statements = sql
    .split('\n').map(line => line.replace(/--.*$/, '')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
  assert.ok(statements.length >= 3,
    'the migration creates entry, entry_by_date and pin_attempt (decision 12)');
  await db.batch(statements.map(s => db.prepare(s)));
}

/** Every answer is JSON, and carries CORS unless it is the origin refusal. */
function assertJsonAnswer({ res, json }, { cors = true } = {}) {
  assert.match(res.headers.get('content-type') || '', /application\/json/,
    'every answer is content-type: application/json');
  assert.match(res.headers.get('vary') || '', /Origin/i,
    'every answer carries Vary: Origin');
  if (cors) {
    assert.equal(res.headers.get('access-control-allow-origin'), EXPECTED_ALLOWED_ORIGIN,
      'the answer carries Access-Control-Allow-Origin: ALLOWED_ORIGIN');
  } else {
    assert.equal(res.headers.get('access-control-allow-origin'), null,
      'the origin refusal is the one answer carrying no Access-Control-Allow-Origin');
  }
  assert.ok(json !== null, 'the body parses as JSON');
}

function assertRefusal(answer, status, code) {
  assertJsonAnswer(answer, { cors: code !== 'origin_not_allowed' });
  assert.equal(answer.res.status, status, `${code} is answered ${status}`);
  assert.equal(answer.json.saved, false, `${code} cannot answer 'saved'`);
  assert.equal(answer.json.error, code, `the refusal names itself '${code}'`);
}

function assertEntryShape(entry, expected) {
  assert.deepEqual(Object.keys(entry).sort(), ENTRY_MEMBERS,
    'an entry carries exactly the declared members and never the receipt bytes');
  assert.equal(entry.status, STATUS_WAITING, `every V2 entry is '${STATUS_WAITING}' (D12)`);
  assert.equal(entry.next_retry_at, null, 'V2 sends nothing, so next_retry_at is null');
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(entry[k], v, `entry.${k}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('worker_answers_saved_only_after_durable_store', async t => {
  const cfg = await readConfig();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ike-v2-'));
  const mainDir = path.join(root, 'main');
  const brokenDir = path.join(root, 'broken');

  const running = [];
  t.after(async () => {
    for (const mf of running) { try { await mf.dispose(); } catch { /* done */ } }
    await fs.rm(root, { recursive: true, force: true });
  });
  const start = async opts => {
    const w = await startWorker(cfg, opts);
    running.push(w.mf);
    return w;
  };

  // ============================================================= the live store
  let w = await start({ pin: PIN, persist: mainDir });
  await applySchema(w.db, cfg);

  // ---- a save answers 'saved' with the stored entry, receipt and all (D3) ----
  const receipt = Buffer.alloc(100, 0xab);
  const save = {
    pin: PIN, category: 'Salary', amount: '250.50',
    receipt: b64(receipt), client_entry_id: 'ce-1'
  };
  const first = await w.call('POST', '/expenses/entries', { body: save });
  assertJsonAnswer(first);
  assert.equal(first.res.status, 200);
  assert.equal(first.json.saved, true, 'the save is the one place that answers saved: true');
  assertEntryShape(first.json.entry, {
    client_entry_id: 'ce-1', amount_mvr: '250.50', category: 'Salary',
    receipt_present: true, receipt_bytes: 100
  });

  // ...and 'saved' is true only because the bytes are already in the store.
  const stored = await w.db
    .prepare('SELECT amount_laari, typeof(amount_laari) AS t, length(receipt) AS n, entry_date'
      + ' FROM entry WHERE client_entry_id = ?').bind('ce-1').first();
  assert.equal(stored.amount_laari, 25050, 'MVR 250.50 is stored as integer laari (decision 6)');
  assert.equal(stored.t, 'integer', 'laari is an INTEGER, not a REAL');
  assert.equal(stored.n, 100, 'the receipt bytes are in the same durable row as the entry');
  assert.equal(stored.entry_date, maldivesDate(), 'the day is the UTC+5 date of saving (D16)');

  // ---- the same client entry id twice stores one entry, not two (D10) ----
  const second = await w.call('POST', '/expenses/entries', { body: save });
  assert.equal(second.res.status, 200);
  assert.deepEqual(second.json, first.json,
    'the second send answers about the row the first send stored');
  const rows = await w.db.prepare('SELECT COUNT(*) AS n FROM entry').first();
  assert.equal(rows.n, 1, 'one row, not two');

  // ---- the day's entries, in saved_at then client_entry_id order ----
  const later = await w.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Meals', amount: 42, client_entry_id: 'ce-2' }
  });
  assert.equal(later.res.status, 200);
  assertEntryShape(later.json.entry, {
    client_entry_id: 'ce-2', amount_mvr: '42.00', category: 'Meals',
    receipt_present: false, receipt_bytes: 0
  });

  const today = maldivesDate();
  const day = await w.call('GET', `/expenses/entries?date=${today}`);
  assertJsonAnswer(day);
  assert.equal(day.res.status, 200);
  assert.equal(day.json.date, today);
  assert.deepEqual(day.json.entries.map(e => e.client_entry_id), ['ce-1', 'ce-2'],
    "the day's entries come back ordered by saved_at then client_entry_id");
  assert.deepEqual(day.json.entries[0], first.json.entry,
    'the listed entry is byte-identical to the one the save answered, so it came out of the store');
  for (const e of day.json.entries) assertEntryShape(e, {});

  const implied = await w.call('GET', '/expenses/entries');
  assert.equal(implied.res.status, 200);
  assert.equal(implied.json.date, today, "an omitted date resolves to D16's UTC+5 day and is echoed");
  assert.deepEqual(implied.json.entries, day.json.entries);

  // ---- the 21 categories, in D7's order, with no PIN (D7, decision 13) ----
  const cats = await w.call('GET', '/expenses/categories');
  assertJsonAnswer(cats);
  assert.equal(cats.res.status, 200);
  assert.deepEqual(cats.json.categories, CATEGORIES_D7,
    'the Worker serves exactly D7\'s 21 names in D7\'s order, without a PIN');

  // ---- the preflight a cross-origin JSON POST needs (decision 9) ----
  const pre = await w.call('OPTIONS', '/expenses/entries');
  assert.equal(pre.res.status, 204);
  assert.equal(pre.text, '', 'the preflight body is empty');
  assert.equal(pre.res.headers.get('access-control-allow-origin'), EXPECTED_ALLOWED_ORIGIN);
  assert.equal(pre.res.headers.get('access-control-allow-headers'), 'content-type');
  assert.equal(pre.res.headers.get('access-control-allow-methods'), 'POST, GET, OPTIONS');
  assert.match(pre.res.headers.get('vary') || '', /Origin/i);

  // ---- the boundaries, none of which can answer 'saved' (decision 16) ----
  const body = over => ({ ...save, client_entry_id: `ce-x-${Math.random()}`, ...over });

  assertRefusal(await w.call('POST', '/expenses/entries', { body: body({ pin: OTHER_PIN }), ip: '10.0.0.1' }),
    403, 'wrong_pin');

  for (const origin of ['https://evil.example', null]) {
    const bad = await w.call('POST', '/expenses/entries',
      { origin, body: body({ pin: OTHER_PIN, category: 'nope', amount: '-1' }) });
    assertRefusal(bad, 403, 'origin_not_allowed');
  }
  const badOriginGet = await w.call('GET', '/expenses/categories', { origin: 'https://evil.example' });
  assertRefusal(badOriginGet, 403, 'origin_not_allowed');

  assertRefusal(await w.call('POST', '/expenses/entries', { body: body({ category: 'Mileage' }) }),
    422, 'unknown_category');

  for (const amount of [0, -5, 12.345, 'abc', '0.00', '']) {
    assertRefusal(await w.call('POST', '/expenses/entries', { body: body({ amount }) }),
      422, 'amount_not_positive_mvr');
  }

  for (const client_entry_id of [undefined, '', '   ']) {
    assertRefusal(await w.call('POST', '/expenses/entries', { body: { ...save, client_entry_id } }),
      422, 'invalid_client_entry_id');
  }
  assertRefusal(await w.call('POST', '/expenses/entries', { raw: '{not json' }), 422, 'bad_json');
  assertRefusal(await w.call('POST', '/expenses/entries', { body: body({ receipt: '!!!not base64!!!' }) }),
    422, 'bad_receipt_base64');

  assertRefusal(await w.call('GET', '/nowhere'), 404, 'not_found');
  assertRefusal(await w.call('DELETE', '/expenses/entries'), 404, 'not_found');

  // ---- the receipt cap is the Worker's own, and it is exact ----
  const atCap = await w.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Fuel / Petrol', amount: '1999.99',
      receipt: b64(Buffer.alloc(RECEIPT_CAP, 0x7f)), client_entry_id: 'ce-cap' }
  });
  assert.equal(atCap.res.status, 200, `${RECEIPT_CAP} decoded bytes still saves`);
  assert.equal(atCap.json.entry.receipt_bytes, RECEIPT_CAP);
  assert.equal(atCap.json.entry.amount_mvr, '1999.99');
  assert.equal(
    (await w.db.prepare('SELECT length(receipt) AS n FROM entry WHERE client_entry_id = ?')
      .bind('ce-cap').first()).n,
    RECEIPT_CAP, 'the capped receipt is stored whole');

  const overCap = await w.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Fuel / Petrol', amount: '10.00',
      receipt: b64(Buffer.alloc(RECEIPT_CAP + 1, 0x7f)), client_entry_id: 'ce-over' }
  });
  assertRefusal(overCap, 413, 'receipt_too_large');
  assert.equal(overCap.json.receipt_bytes, RECEIPT_CAP + 1);
  assert.equal(overCap.json.limit_bytes, RECEIPT_CAP);
  assert.equal(
    (await w.db.prepare('SELECT COUNT(*) AS n FROM entry WHERE client_entry_id = ?')
      .bind('ce-over').first()).n,
    0, 'the refused receipt stored no row');

  // ---- wrong PINs are rate-limited, and the outcome is Retry (decision 11) ----
  const ip = '203.0.113.7';
  for (let i = 1; i <= 5; i++) {
    assertRefusal(
      await w.call('POST', '/expenses/entries', { body: body({ pin: OTHER_PIN }), ip }),
      403, 'wrong_pin');
  }
  const limited = await w.call('POST', '/expenses/entries', { body: body({ pin: OTHER_PIN }), ip });
  assertRefusal(limited, 429, 'too_many_wrong_pins');
  assert.match(limited.res.headers.get('retry-after') || '', /^\d+$/,
    'Retry-After is whole seconds');
  const retryAt = Date.parse(limited.json.retry_at);
  assert.ok(Number.isFinite(retryAt), 'retry_at is an ISO 8601 UTC instant');
  assert.ok(retryAt > Date.now() - 1000 && retryAt <= Date.now() + 11000,
    'retry_at is the end of the current 10-second window');

  const correctButLimited = await w.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Water', amount: '5.00', client_entry_id: 'ce-blocked' }, ip
  });
  assertRefusal(correctButLimited, 429, 'too_many_wrong_pins');
  assert.equal(
    (await w.db.prepare('SELECT COUNT(*) AS n FROM entry WHERE client_entry_id = ?')
      .bind('ce-blocked').first()).n,
    0, 'the budget is read before the comparison, so nothing was saved');

  const budget = await w.db
    .prepare('SELECT source, misses FROM pin_attempt WHERE source = ?').bind(ip).all();
  assert.equal(budget.results.length, 1, 'one counter row for this source and window');
  assert.equal(budget.results[0].misses, 5,
    'only failed comparisons consume budget, and it stops at the limit');

  await sleep(Math.max(0, retryAt - Date.now()) + 300);
  const nextWindow = await w.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Water', amount: '5.00', client_entry_id: 'ce-next' }, ip
  });
  assert.equal(nextWindow.res.status, 200, 'the next window admits a correct PIN again');
  assert.equal(nextWindow.json.saved, true);

  // ---- the PIN is never written into the store (D14) ----
  const tables = await w.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'" +
      " AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'" +
      " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
    ).all();
  for (const { name } of tables.results) {
    const all = await w.db.prepare(`SELECT * FROM "${name}"`).all();
    assert.ok(!JSON.stringify(all.results).includes(PIN),
      `the PIN appears nowhere in ${name}`);
  }

  // ================================================== durability across runtimes
  const beforeStop = first.json.entry;
  await w.mf.dispose();

  w = await start({ pin: PIN, persist: mainDir });
  const afterRestart = await w.call('GET', `/expenses/entries?date=${today}`);
  assert.equal(afterRestart.res.status, 200);
  assert.deepEqual(
    afterRestart.json.entries.find(e => e.client_entry_id === 'ce-1'), beforeStop,
    "a brand-new runtime over the same store still answers the entry it said was saved");
  assert.equal(
    (await w.db.prepare('SELECT length(receipt) AS n FROM entry WHERE client_entry_id = ?')
      .bind('ce-1').first()).n,
    100, 'the receipt survived the runtime, not just the entry');

  // ---- a changed secret takes effect at once, without touching saved entries ----
  await w.mf.dispose();
  w = await start({ pin: OTHER_PIN, persist: mainDir });
  // the old PIN stops working at once
  assertRefusal(await w.call('POST', '/expenses/entries', { body: body({ pin: PIN }), ip: '10.0.0.2' }),
    403, 'wrong_pin');
  const withNewPin = await w.call('POST', '/expenses/entries', {
    body: { pin: OTHER_PIN, category: 'Internet', amount: '99.00', client_entry_id: 'ce-3' },
    ip: '10.0.0.2'
  });
  assert.equal(withNewPin.res.status, 200, 'the new PIN is accepted immediately');
  assert.equal(withNewPin.json.saved, true);
  const untouched = await w.call('GET', `/expenses/entries?date=${today}`);
  assert.deepEqual(
    untouched.json.entries.find(e => e.client_entry_id === 'ce-1'), beforeStop,
    'the entries saved under the old secret are untouched');

  // ============================== the store failing is Indeterminate, not 'saved'
  const broken = await start({ pin: PIN, persist: brokenDir });
  await applySchema(broken.db, cfg);
  await broken.db.prepare('DROP TABLE entry').run();

  const notStored = await broken.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Gifts', amount: '77.00', client_entry_id: 'ce-fail' }
  });
  assertRefusal(notStored, 503, 'not_stored');
  assert.ok(!('entry' in notStored.json),
    'a save that was not stored answers no entry');

  assertRefusal(await broken.call('GET', `/expenses/entries?date=${today}`), 503, 'not_read');

  // The save-first falsifier passed the origin, budget and PIN gates and failed
  // at the save itself: pin_attempt is intact and consumed nothing.
  const miss = await broken.db.prepare('SELECT COUNT(*) AS n FROM pin_attempt').first();
  assert.equal(miss.n, 0, 'the correct PIN consumed no budget on the way to the failure');
});
