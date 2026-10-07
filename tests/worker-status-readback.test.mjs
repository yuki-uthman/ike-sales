// Oracle for "V5 Status read-back".
//
// Authority: docs/product/brief.md#Decisions (D5, D12, D13, D16) and
// Outcomes -> DESIGN "V5 Status read-back". The hr.expense state selection
// (draft -> submitted -> approved -> posted -> in_payment -> paid -> refused)
// is evidenced by ../odoo/CLAUDE.md. Neither document is opened by this file.
//
// Driving ports: the Cloudflare cron (D13's */15 schedule, reached through
// workerd's own /cdn-cgi/handler/scheduled port with NO Origin header) and
// HTTP (POST /expenses/entries, GET /expenses/entries,
// POST /expenses/entries/<id>/retry — D17).
//
// Driven ports: the D1 binding (read back directly, and used to apply the
// schema SSOT worker/migrations/0001_init.sql) and Odoo's XML-RPC endpoint,
// which here is a LOCAL FAKE on loopback speaking the same wire protocol. No
// call in this file can reach mrh-investment.odoo.com. The fake holds a
// MUTABLE record store so that a PERSON — never the Worker — moves a state.
//
// This oracle deliberately does not import tests/worker-odoo-sync.test.mjs, so
// the two cannot drift into one. Nothing under worker/src is imported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(REPO, 'worker');

const PIN = '4821';
const CRON = '*/15 * * * *';            // D13: the same schedule as the retries

// D12's chip words. V5 adds the last two; the first three are V4's.
const WAITING = 'Waiting to send';
const DRAFT = 'Draft';
const APPROVED = 'Approved';
const REFUSED = 'Refused';

// The seven members an entry has — exactly these, no more, for every chip.
const ENTRY_MEMBERS = [
  'amount_mvr', 'category', 'client_entry_id', 'next_retry_at',
  'receipt_bytes', 'receipt_present', 'status'
];

const EMPLOYEE_ID = 1;
// D18: the bank-transfer line is configuration by live id, never by name.
const PAYMENT_LINE_ID = 2;
const ODOO_DB = 'mrh-investment';
const ODOO_USER = 'mrhpvt@gmail.com';
const ODOO_KEY = 'rpc-key-must-never-escape-5e2b77';

// D12's mapping, written out here as the oracle's own independent table:
// Odoo state -> the chip the page must show.
const D12 = [
  ['draft', DRAFT],
  ['submitted', DRAFT],
  ['approved', APPROVED],
  ['posted', APPROVED],
  ['in_payment', APPROVED],
  ['paid', APPROVED],
  ['refused', REFUSED]
];

// ===========================================================================
// A minimal XML-RPC codec, used only so this oracle can read what the Worker
// actually put on the wire and answer it in Odoo's own shapes.
// ===========================================================================

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = s => String(s).replace(/[&<>]/g, c => ESC[c]);

function encodeValue(v) {
  if (v === null || v === undefined) return '<value><boolean>0</boolean></value>';
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? `<value><int>${v}</int></value>`
      : `<value><double>${v}</double></value>`;
  }
  if (typeof v === 'string') return `<value><string>${esc(v)}</string></value>`;
  if (Array.isArray(v)) {
    return `<value><array><data>${v.map(encodeValue).join('')}</data></array></value>`;
  }
  const members = Object.keys(v)
    .map(k => `<member><name>${esc(k)}</name>${encodeValue(v[k])}</member>`).join('');
  return `<value><struct>${members}</struct></value>`;
}

const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

class Cursor {
  constructor(xml) { this.s = xml; this.i = 0; }
  skipws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  tag() {
    const at = this.s.indexOf('<', this.i);
    if (at < 0) return null;
    const close = this.s.indexOf('>', at);
    const raw = this.s.slice(at + 1, close);
    this.i = close + 1;
    return raw;
  }
  text(until) {
    const at = this.s.indexOf(until, this.i);
    const t = this.s.slice(this.i, at);
    this.i = at + until.length;
    return t;
  }
}

function parseValue(c) {
  c.skipws();
  let t = c.tag();
  if (t !== 'value') throw new Error('expected <value>, saw <' + t + '>');
  c.skipws();
  if (c.s.indexOf('<', c.i) !== c.i) return unesc(c.text('</value>'));
  t = c.tag();
  let out;
  if (t === 'array') {
    out = [];
    c.skipws(); if (c.tag() !== 'data') throw new Error('expected <data>');
    for (;;) {
      c.skipws();
      if (c.s.startsWith('</data>', c.i)) { c.i += 7; break; }
      out.push(parseValue(c));
    }
    c.skipws(); c.tag();
  } else if (t === 'struct') {
    out = {};
    for (;;) {
      c.skipws();
      if (c.s.startsWith('</struct>', c.i)) { c.i += 9; break; }
      if (c.tag() !== 'member') throw new Error('expected <member>');
      c.skipws(); if (c.tag() !== 'name') throw new Error('expected <name>');
      const k = unesc(c.text('</name>'));
      out[k] = parseValue(c);
      c.skipws(); c.tag();
    }
  } else if (t === 'nil/' || t === 'nil') {
    if (t === 'nil') c.text('</nil>');
    out = null;
  } else {
    const raw = unesc(c.text('</' + t + '>'));
    if (t === 'int' || t === 'i4' || t === 'i8') out = parseInt(raw, 10);
    else if (t === 'double') out = raw;          // money stays TEXT, never a float
    else if (t === 'boolean') out = raw.trim() === '1';
    else out = raw;
  }
  c.skipws(); c.tag();
  return out;
}

function decodeCall(xml) {
  const m = /<methodName>([^<]*)<\/methodName>/.exec(xml);
  assert.ok(m, 'the Worker posts a well-formed XML-RPC <methodCall>');
  const params = [];
  let from = 0;
  for (;;) {
    const at = xml.indexOf('<param>', from);
    if (at < 0) break;
    const c = new Cursor(xml);
    c.i = at + '<param>'.length;
    params.push(parseValue(c));
    from = xml.indexOf('</param>', at) + '</param>'.length;
  }
  return { name: m[1], params };
}

// ===========================================================================
// The fake Odoo. Its hr.expense store is mutable from the outside, so the test
// can act as the PERSON who approves or refuses an expense in the Odoo web UI,
// or who deletes one. The Worker is never given a way to move a state.
// ===========================================================================

async function startFakeOdoo() {
  const state = {
    calls: [], expenses: new Map(), attachments: new Map(),
    seed: new Map(), nextId: 101, mode: 'ok', uid: 2
  };

  const respond = (res, value) => {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end('<?xml version="1.0"?><methodResponse><params><param>'
      + encodeValue(value) + '</param></params></methodResponse>');
  };
  const fault = (res, code, string) => {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end('<?xml version="1.0"?><methodResponse><fault>'
      + encodeValue({ faultCode: code, faultString: string }) + '</fault></methodResponse>');
  };
  const matches = (row, domain) => domain.every(cond => {
    if (!Array.isArray(cond)) return true;
    const [f, op, v] = cond;
    const got = row[f];
    if (op === '=') return String(got) === String(v);
    if (op === 'in') return v.map(String).includes(String(got));
    if (op === 'like' || op === 'ilike') return String(got).includes(String(v).replace(/%/g, ''));
    throw new Error('the fake was asked for an operator this design does not declare: ' + op);
  });
  const project = (rows, fields) => rows.map(r => {
    const out = { id: r.id };
    for (const f of fields || Object.keys(r)) out[f] = r[f] === undefined ? false : r[f];
    return out;
  });

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = decodeCall(body);
    const log = { path: req.url, method: call.name, params: call.params, at: Date.now() };
    state.calls.push(log);

    if (req.url === '/xmlrpc/2/common') {
      if (call.name !== 'authenticate') return fault(res, 1, 'unknown common method');
      const [d, u, k] = call.params;
      const ok = d === ODOO_DB && u === ODOO_USER && k === ODOO_KEY;
      return respond(res, ok ? state.uid : false);
    }
    if (req.url !== '/xmlrpc/2/object') return fault(res, 1, 'no such endpoint');
    if (call.name !== 'execute_kw') return fault(res, 1, 'unknown object method');

    const [, uid, key, model, method, args, kwargs] = call.params;
    Object.assign(log, { model, rpc: method, args, kwargs });
    if (key !== ODOO_KEY || uid !== state.uid) return fault(res, 3, 'AccessDenied');

    if (state.mode === 'ratelimit') {
      res.writeHead(429, { 'content-type': 'text/plain' }); return res.end('Too Many Requests');
    }
    if (state.mode === 'http500') {
      res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('Internal Server Error');
    }
    if (state.mode === 'fault') return fault(res, 2, "Invalid field 'nope' on model 'hr.expense'");

    if (method === 'create') {
      assert.ok(Array.isArray(args) && Array.isArray(args[0]),
        'create wraps its vals in the outer list Odoo demands, even for one record');
      const vals = args[0][0];
      const id = state.nextId++;
      if (model === 'hr.expense') {
        state.expenses.set(id, { ...vals, id, state: 'draft' });
        log.createdId = id;
        return respond(res, id);
      }
      if (model === 'ir.attachment') {
        state.attachments.set(id, { ...vals, id });
        return respond(res, id);
      }
      return fault(res, 2, 'cannot create ' + model);
    }
    if (method === 'search_read') {
      const domain = args[0] || [];
      const fields = (kwargs && kwargs.fields) || null;
      const source = state.seed.has(model) ? state.seed.get(model)
        : model === 'ir.attachment' ? [...state.attachments.values()]
          : model === 'hr.expense' ? [...state.expenses.values()]
            : [];
      let rows = source.filter(r => matches(r, domain));
      if (kwargs && kwargs.limit) rows = rows.slice(0, kwargs.limit);
      return respond(res, project(rows, fields));
    }
    // Anything else is a method this design promises never to call — above all
    // write, unlink and the action_* family that would move a state.
    return fault(res, 2, 'forbidden method ' + method + ' on ' + model);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    state,
    set(mode) { state.mode = mode; },
    seed(model, rows) { state.seed.set(model, rows); },
    objectCalls: () => state.calls.filter(c => c.path === '/xmlrpc/2/object'),
    /** The read-back's own call: the hr.expense search_read over an id list. */
    readBacks: () => state.calls.filter(c =>
      c.model === 'hr.expense' && c.rpc === 'search_read'
      && Array.isArray(c.args) && Array.isArray(c.args[0]) && Array.isArray(c.args[0][0])
      && c.args[0][0][0] === 'id' && c.args[0][0][1] === 'in'),
    /** A PERSON moves the state in the Odoo UI. The Worker cannot do this. */
    person: {
      setState(id, next) {
        const row = state.expenses.get(id);
        assert.ok(row, 'the person can only move an expense that exists: ' + id);
        state.expenses.set(id, { ...row, state: next });
      },
      deleteExpense(id) {
        assert.ok(state.expenses.delete(id), 'the person deleted expense ' + id);
      }
    },
    close: () => new Promise(r => server.close(r))
  };
}

// ===========================================================================
// config, runtime, and the two driving ports
// ===========================================================================

async function readConfig() {
  const cfg = JSON.parse(await fs.readFile(path.join(WORKER, 'wrangler.json'), 'utf8'));
  assert.deepEqual(cfg.triggers && cfg.triggers.crons, [CRON],
    "the read-back runs on D13's existing 15-minute schedule; V5 adds no second cron");
  assert.equal((cfg.d1_databases || []).length, 1);
  return cfg;
}

async function startWorker(cfg, { persist, odooUrl }) {
  const binding = cfg.d1_databases[0].binding;
  const mf = new Miniflare({
    scriptPath: path.join(WORKER, cfg.main),
    modules: true,
    modulesRoot: WORKER,
    compatibilityDate: cfg.compatibility_date,
    compatibilityFlags: cfg.compatibility_flags || [],
    d1Databases: { [binding]: cfg.d1_databases[0].database_id || binding },
    d1Persist: persist,
    unsafeTriggerHandlers: true,
    bindings: {
      ...(cfg.vars || {}),
      EXPENSE_PIN: PIN,
      ODOO_URL: odooUrl,
      ODOO_DB: ODOO_DB,
      ODOO_USERNAME: ODOO_USER,
      ODOO_API_KEY: ODOO_KEY,
      ODOO_EMPLOYEE_ID: String(EMPLOYEE_ID),
      ODOO_PAYMENT_METHOD_LINE_ID: String(PAYMENT_LINE_ID)
    },
    port: 0
  });
  const url = await mf.ready;
  const db = await mf.getD1Database(binding);
  const base = url.origin;
  const allowed = cfg.vars.ALLOWED_ORIGIN;

  const call = async (method, pathname, { body } = {}) => {
    const headers = { 'CF-Connecting-IP': '127.0.0.1', Origin: allowed };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + pathname, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
    return { res, text, json };
  };

  // The cron driving port, as workerd itself exposes it. No Origin header: this
  // stimulus is the schedule, not a browser.
  const tick = async () => {
    const res = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(CRON)}`);
    await res.text();
    assert.equal(res.status, 200,
      'the scheduled handler is reached through the real cron port and completes');
  };

  return { mf, db, call, base, tick };
}

async function applySchema(db, cfg) {
  const sql = await fs.readFile(
    path.join(WORKER, cfg.d1_databases[0].migrations_dir, '0001_init.sql'), 'utf8');
  const statements = sql
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
  await db.batch(statements.map(s => db.prepare(s)));
}

const maldivesDate = (at = Date.now()) =>
  new Date(at + 5 * 3600 * 1000).toISOString().slice(0, 10);

function assertEntryShape(entry, expected) {
  assert.deepEqual(Object.keys(entry).sort(), ENTRY_MEMBERS,
    'an entry carries exactly the seven declared members, whatever its chip');
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(entry[k], v, `entry.${k}`);
  }
}

/** Every column the read-back must be able to leave alone. */
async function row(db, id) {
  return db.prepare(
    'SELECT client_entry_id, status, odoo_id, attempts, next_retry_at, last_error,'
    + ' synced_at, amount_laari, entry_date, saved_at, length(receipt) AS receipt_bytes'
    + ' FROM entry WHERE client_entry_id = ?').bind(id).first();
}

// ===========================================================================

test('worker_reads_odoo_state_back_into_the_chip_and_writes_nothing', async t => {
  const cfg = await readConfig();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ike-v5-'));
  const odoo = await startFakeOdoo();
  t.after(async () => {
    await odoo.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  odoo.seed('product.product', [{ id: 77, name: 'Salary', can_be_expensed: true }]);
  // No account.payment.method.line seed: D18 forbids searching that model.

  const w = await startWorker(cfg, { persist: path.join(root, 'main'), odooUrl: odoo.url });
  t.after(async () => { try { await w.mf.dispose(); } catch { /* done */ } });
  await applySchema(w.db, cfg);

  const today = maldivesDate();
  const save = (id, over = {}) => w.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Salary', amount: '10.00', client_entry_id: id, ...over }
  });
  const chips = async () => {
    const got = await w.call('GET', `/expenses/entries?date=${today}`);
    assert.equal(got.res.status, 200);
    return new Map(got.json.entries.map(e => [e.client_entry_id, e]));
  };
  const chip = async id => (await chips()).get(id);

  // ===================================================================== §1
  // A run with nothing to do asks Odoo nothing at all: no queue, no call, and
  // in particular no login just to discover there was no work.
  await w.tick();
  assert.equal(odoo.state.calls.length, 0,
    'a scheduled run with no entry at all makes zero Odoo calls');

  // ===================================================================== §2
  // Eight entries become eight draft expenses in one run, and that same run
  // ends with exactly ONE read-only call asking about all eight.
  const ids = ['ce-01', 'ce-02', 'ce-03', 'ce-04', 'ce-05', 'ce-06', 'ce-07', 'ce-08'];
  for (const id of ids) {
    const saved = await save(id);
    assert.equal(saved.res.status, 200);
    assert.equal(saved.json.entry.status, WAITING, 'saving is still not sending (D12)');
  }
  assert.equal(odoo.state.calls.length, 0, 'and saving still contacts Odoo not at all');

  await w.tick();

  const expenseId = {};
  for (const id of ids) {
    const r = await row(w.db, id);
    assert.equal(r.status, 'draft', `${id} reached Odoo as a draft expense`);
    expenseId[id] = r.odoo_id;
    assert.ok(r.odoo_id > 0);
  }

  // ---- exactly one read-back call in the run, bound as the literal wire value
  let reads = odoo.readBacks();
  assert.equal(reads.length, 1, 'one scheduled run issues exactly one read-back call');
  assert.equal(reads[0].path, '/xmlrpc/2/object');
  assert.equal(reads[0].method, 'execute_kw');
  assert.equal(reads[0].model, 'hr.expense');
  assert.equal(reads[0].rpc, 'search_read');
  assert.deepEqual(reads[0].args, [[['id', 'in', ids.map(i => expenseId[i])]]],
    'one domain carries every draft id, in the queue order, oldest first');
  assert.deepEqual(reads[0].kwargs, { fields: ['id', 'state'] },
    'only id and state are asked for: no limit, no order, no context');

  // ---- sync first, read-back last, both inside the one awaited run ----------
  const objects = odoo.objectCalls();
  const lastCreate = objects.map(c => c.rpc).lastIndexOf('create');
  const readAt = objects.indexOf(reads[0]);
  assert.ok(lastCreate >= 0 && readAt > lastCreate,
    'the read runs after the sends, so an expense created in this very run is in the id set');

  // ---- all eight are still draft in Odoo, so no chip moved -----------------
  for (const id of ids) {
    assertEntryShape(await chip(id), { status: DRAFT, next_retry_at: null });
  }

  // ===================================================================== §3
  // A PERSON moves each of the seven hr.expense states. The next scheduled run
  // maps every one of them by D12, and touches nothing but the chip.
  const before = new Map();
  for (const id of ids) before.set(id, await row(w.db, id));

  D12.forEach(([odooState], i) => odoo.person.setState(expenseId[ids[i]], odooState));
  // ce-08 is left exactly as Odoo created it: still 'draft'.

  await w.tick();

  for (const [i, [odooState, expectedChip]] of D12.entries()) {
    const id = ids[i];
    const e = await chip(id);
    assertEntryShape(e, { status: expectedChip, next_retry_at: null });
    assert.equal(e.status, expectedChip,
      `Odoo state '${odooState}' shows as '${expectedChip}' (D12)`);
    assert.equal(e.amount_mvr, '10.00', 'the saved amount is never rewritten by a read-back');
  }
  assert.equal((await chip('ce-08')).status, DRAFT, 'an untouched expense keeps its Draft chip');

  // ---- the ONLY column the read-back wrote is status, and only where it moved
  for (const id of ids) {
    const was = before.get(id);
    const now = await row(w.db, id);
    for (const col of ['client_entry_id', 'odoo_id', 'attempts', 'next_retry_at',
      'last_error', 'synced_at', 'amount_laari', 'entry_date', 'saved_at', 'receipt_bytes']) {
      assert.deepEqual(now[col], was[col],
        `the read-back left ${id}.${col} untouched — it writes one column only`);
    }
  }
  assert.equal((await row(w.db, 'ce-01')).status, 'draft', "'draft' stays draft");
  assert.equal((await row(w.db, 'ce-02')).status, 'draft', "'submitted' stays draft");
  assert.equal((await row(w.db, 'ce-03')).status, 'approved');
  assert.equal((await row(w.db, 'ce-06')).status, 'approved');
  assert.equal((await row(w.db, 'ce-07')).status, 'refused');

  // ===================================================================== §4
  // An entry in Approved or Refused is never read again: the next run's domain
  // carries only the three that still show Draft.
  const readsBefore = odoo.readBacks().length;
  await w.tick();
  reads = odoo.readBacks();
  assert.equal(reads.length, readsBefore + 1, 'still exactly one read-back call per run');
  assert.deepEqual(reads[reads.length - 1].args,
    [[['id', 'in', [expenseId['ce-01'], expenseId['ce-02'], expenseId['ce-08']]]]],
    'the five entries that became Approved or Refused are not asked about again');

  // ===================================================================== §5
  // A state this design has never seen, and an expense a person deleted, both
  // change no chip and are both asked about again on the next run.
  odoo.person.setState(expenseId['ce-08'], 'reported');   // a word Odoo invented
  odoo.person.deleteExpense(expenseId['ce-02']);          // a person deleted it
  const wasUnknown = await row(w.db, 'ce-08');
  const wasGone = await row(w.db, 'ce-02');

  await w.tick();

  assert.deepEqual(await row(w.db, 'ce-08'), wasUnknown,
    'an unrecognised state is never guessed into Approved: the row is byte-identical');
  assert.deepEqual(await row(w.db, 'ce-02'), wasGone,
    'an id Odoo no longer returns changes nothing: the row is byte-identical');
  assert.equal((await chip('ce-08')).status, DRAFT);
  assert.equal((await chip('ce-02')).status, DRAFT,
    "a deleted expense is honestly still 'Draft' — Odoo never said 'refused'");

  await w.tick();
  reads = odoo.readBacks();
  assert.deepEqual(reads[reads.length - 1].args,
    [[['id', 'in', [expenseId['ce-01'], expenseId['ce-02'], expenseId['ce-08']]]]],
    'both are asked about again on every following run');

  // ===================================================================== §6
  // Every Odoo failure during the read-back moves no chip, records no error and
  // sets no retry time — the send succeeded, so 'Not sent' would be a lie. The
  // sync queue is empty here, so the only call of each run is the read-back's.
  for (const mode of ['http500', 'ratelimit', 'fault']) {
    const was = await row(w.db, 'ce-01');
    const objectsBefore = odoo.objectCalls().length;
    odoo.set(mode);
    await w.tick();
    odoo.set('ok');
    assert.equal(odoo.objectCalls().length - objectsBefore, 1,
      `${mode}: the run made exactly one object call and did not retry it inside the run`);
    assert.deepEqual(await row(w.db, 'ce-01'), was,
      `${mode}: no chip moved, no attempt counted, no next_retry_at, no last_error`);
    assertEntryShape(await chip('ce-01'), { status: DRAFT, next_retry_at: null });
  }

  // ---- and the very next healthy run picks the change up ------------------
  odoo.person.setState(expenseId['ce-01'], 'approved');
  await w.tick();
  assertEntryShape(await chip('ce-01'), { status: APPROVED, next_retry_at: null });
  assert.equal((await row(w.db, 'ce-01')).last_error, null,
    'a failed read-back left no error behind to outlive it');

  // ===================================================================== §7
  // Retry on an entry that is already in Odoo sends nothing, whatever its chip.
  const callsBefore = odoo.state.calls.length;
  const retried = await w.call('POST', '/expenses/entries/ce-01/retry');
  assert.equal(retried.res.status, 200);
  assertEntryShape(retried.json.entry, { client_entry_id: 'ce-01', status: APPROVED, next_retry_at: null });
  assert.equal(odoo.state.calls.length, callsBefore,
    'Retry on an Approved entry makes zero Odoo calls: there is nothing left to send');
  assert.ok(!('saved' in retried.json),
    "'saved: true' still occurs in exactly one place in the service: the save answer");

  const refusedRetry = await w.call('POST', '/expenses/entries/ce-07/retry');
  assert.equal(refusedRetry.res.status, 200);
  assertEntryShape(refusedRetry.json.entry, { client_entry_id: 'ce-07', status: REFUSED, next_retry_at: null });

  // ---- nor can a later scheduled run pull an Approved chip back to Draft ----
  await save('ce-09');
  await w.tick();
  assertEntryShape(await chip('ce-09'), { status: DRAFT, next_retry_at: null });
  assertEntryShape(await chip('ce-01'), { status: APPROVED, next_retry_at: null });
  assertEntryShape(await chip('ce-07'), { status: REFUSED, next_retry_at: null });
  assert.equal(
    [...odoo.state.expenses.values()].filter(e => String(e.name).includes('[ike:ce-01]')).length,
    1, 'and no second expense was ever created for it: the one original remains');

  // ===================================================================== §8
  // No cap on the id list: more drafts than the sync queue's own batch size are
  // all asked about in the ONE call, so a new draft can never be starved out.
  const bulk = [];
  for (let i = 10; i < 50; i++) bulk.push(`ce-${i}`);
  for (const id of bulk) await save(id);
  await w.tick();
  await w.tick();                     // the sync batches; the read-back does not
  for (const id of bulk) {
    assert.equal((await row(w.db, id)).status, 'draft', `${id} was sent`);
  }
  await w.tick();
  const last = odoo.readBacks().pop();
  const asked = last.args[0][0][2];
  const expectedDrafts = (await w.db.prepare(
    "SELECT odoo_id FROM entry WHERE status = 'draft' AND odoo_id IS NOT NULL"
    + ' ORDER BY saved_at ASC, client_entry_id ASC').all()).results.map(r => r.odoo_id);
  assert.ok(expectedDrafts.length > 25,
    'this run really does have more drafts than the sync queue would take at once');
  assert.deepEqual(asked, expectedDrafts,
    'one call asks about every entry that still shows Draft — there is no cap and no starvation');
  assert.deepEqual(last.kwargs, { fields: ['id', 'state'] }, 'and still no limit kwarg');

  // ===================================================================== §9
  // Structurally, across this entire oracle, the read-back wrote nothing.
  const methods = new Set(odoo.state.calls.map(c => c.rpc || c.method));
  assert.deepEqual([...methods].sort(), ['authenticate', 'create', 'search_read'],
    'the complete set of Odoo methods the service ever calls — no write, no unlink, no action_*');
  assert.ok(!JSON.stringify(odoo.state.calls).includes('action_'),
    'nothing is ever submitted, approved, posted, refused or paid by this Worker (D5)');
  for (const c of odoo.state.calls) {
    assert.match(c.path, /^\/xmlrpc\/2\/(common|object)$/,
      'the key only ever travelled to the configured Odoo XML-RPC endpoints');
  }

  // ---- and the new chips disclose nothing new over the wire ----------------
  const everyAnswer = JSON.stringify([
    (await w.call('GET', `/expenses/entries?date=${today}`)).json,
    retried.json, refusedRetry.json
  ]);
  assert.ok(!everyAnswer.includes(ODOO_KEY), 'the key never appears in any answer');
  assert.ok(!everyAnswer.includes(ODOO_USER), 'nor does the login name');
  assert.ok(!/odoo/i.test(everyAnswer),
    'no Odoo id, state word or endpoint leaks: the page sees only D12 chips');
});
