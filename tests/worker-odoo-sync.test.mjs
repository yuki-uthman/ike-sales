// Oracle for "V4 Odoo sync".
//
// Authority: docs/product/brief.md#Decisions (D4, D5, D7, D8, D10, D11, D12,
// D13, D16) and Outcomes -> DESIGN "V4 Odoo sync". Wire-protocol and field
// authority: ../odoo/CLAUDE.md (External API over XML-RPC, the payment_mode
// selection, MVR as the company currency, the ids/vals outer-list footgun) and
// ../ike-data/scripts/fetch_expenses.py. Neither is opened by this oracle.
//
// Driving ports: HTTP and the Cloudflare cron. The Worker runs in a real
// workerd (miniflare) on a loopback socket, spoken to with plain `fetch`; the
// schedule is triggered through workerd's own cron port
// (/cdn-cgi/handler/scheduled), not by importing anything.
//
// Driven ports: the D1 binding (read back directly, and used to apply the
// schema SSOT worker/migrations/0001_init.sql) and Odoo's XML-RPC endpoint,
// which here is a LOCAL FAKE on loopback speaking the same wire protocol. No
// call in this file can reach mrh-investment.odoo.com: ODOO_URL is bound to the
// fake, and the fake asserts which endpoints were asked for.
//
// Nothing under worker/src is imported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(REPO, 'worker');

const PIN = '4821';
const CRON = '*/15 * * * *';            // D13: every 15 minutes

// D12's status words this version produces, and no others.
const WAITING = 'Waiting to send';
const NOT_SENT = 'Not sent';
const DRAFT = 'Draft';

// The seven members an entry has — exactly these, no more. odoo_id, attempts,
// last_error and synced_at stay inside the Worker.
const ENTRY_MEMBERS = [
  'amount_mvr', 'category', 'client_entry_id', 'next_retry_at',
  'receipt_bytes', 'receipt_present', 'status'
];

// D4: the one employee every expense belongs to.
const EMPLOYEE_ID = 1;
// D18: the live bank-transfer payment method line is named by its ID, never by a
// name — the live database holds two lines called 'Transfer' and none called
// 'Bank Transfer MVR'.
const PAYMENT_LINE_ID = 2;

const ODOO_DB = 'mrh-investment';
const ODOO_USER = 'mrhpvt@gmail.com';
const ODOO_KEY = 'rpc-key-must-never-escape-0f9a1c';

// The backoff schedule, in minutes, for attempts 1..6+.
const BACKOFF_MINUTES = [15, 30, 60, 120, 240, 360];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = bytes => Buffer.from(bytes).toString('base64');
const JPEG = n => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, 0x5a)]);

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

function decodeOneValue(xml, from) {
  const c = new Cursor(xml);
  c.i = from;
  return parseValue(c);
}

function decodeCall(xml) {
  const m = /<methodName>([^<]*)<\/methodName>/.exec(xml);
  assert.ok(m, 'the Worker posts a well-formed XML-RPC <methodCall>');
  const params = [];
  let from = 0;
  for (;;) {
    const at = xml.indexOf('<param>', from);
    if (at < 0) break;
    params.push(decodeOneValue(xml, at + '<param>'.length));
    from = xml.indexOf('</param>', at) + '</param>'.length;
  }
  return { name: m[1], params };
}

// ===========================================================================
// The fake Odoo: /xmlrpc/2/common authenticate and /xmlrpc/2/object execute_kw.
// It logs every call, seeds the records V4 resolves by name, and can be told to
// fail in each way the design declares an outcome for.
// ===========================================================================

async function startFakeOdoo() {
  const state = {
    calls: [], bodies: [], expenses: new Map(), attachments: new Map(),
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
    throw new Error('the fake was asked for an operator V4 does not declare: ' + op);
  });
  const project = (rows, fields) => rows.map(r => {
    const out = { id: r.id };
    for (const f of fields || Object.keys(r)) out[f] = r[f] === undefined ? false : r[f];
    return out;
  });

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    state.bodies.push(body);
    const call = decodeCall(body);
    const log = { path: req.url, method: call.name, params: call.params, at: Date.now() };
    state.calls.push(log);

    if (req.url === '/xmlrpc/2/common') {
      if (call.name !== 'authenticate') return fault(res, 1, 'unknown common method');
      const [d, u, k] = call.params;
      const ok = d === ODOO_DB && u === ODOO_USER && k === ODOO_KEY;
      // the documented failed-auth shape is boolean false, not a fault
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
    if (state.mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'text/xml' }); return res.end('<<not xml at all');
    }
    if (state.mode === 'fault') return fault(res, 2, "Invalid field 'nope' on model 'hr.expense'");
    if (state.mode === 'hang') return;             // never answers; socket held open

    if (method === 'create') {
      assert.ok(Array.isArray(args) && Array.isArray(args[0]),
        'create wraps its vals in the outer list Odoo demands, even for one record');
      const vals = args[0][0];
      const id = state.nextId++;
      if (model === 'hr.expense') {
        state.expenses.set(id, { ...vals, id, state: 'draft' });
        log.createdId = id;
        if (state.mode === 'lose-answer') { res.destroy(); return; }   // committed, answer lost
        return respond(res, id);
      }
      if (model === 'ir.attachment') {
        // saas-19.4 keeps the content of `raw` only (it has no `datas`), and
        // records its size and sha1 the way Odoo does.
        const bytes = typeof vals.raw === 'string' ? Buffer.from(vals.raw, 'base64') : Buffer.alloc(0);
        state.attachments.set(id, {
          ...vals, id,
          file_size: bytes.length,
          checksum: bytes.length ? crypto.createHash('sha1').update(bytes).digest('hex') : false
        });
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
    // Anything else is a method V4 promises never to call.
    return fault(res, 2, 'forbidden method ' + method + ' on ' + model);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    state,
    set(mode) { state.mode = mode; },
    objectCalls: () => state.calls.filter(c => c.path === '/xmlrpc/2/object'),
    seed(model, rows) { state.seed.set(model, rows); },
    close: () => new Promise(r => server.close(r))
  };
}

// ===========================================================================
// config, runtime, and the two driving ports
// ===========================================================================

async function readConfig() {
  const cfg = JSON.parse(await fs.readFile(path.join(WORKER, 'wrangler.json'), 'utf8'));
  assert.deepEqual(cfg.triggers && cfg.triggers.crons, [CRON],
    'the config declares D13\'s 15-minute schedule as the cron driving port');
  assert.equal((cfg.d1_databases || []).length, 1);
  assert.ok(typeof cfg.d1_databases[0].migrations_dir === 'string');
  const vars = cfg.vars || {};
  assert.equal(vars.ODOO_URL, 'https://mrh-investment.odoo.com',
    'the Odoo endpoint lives in config, not as a literal in code');
  assert.equal(vars.ODOO_DB, ODOO_DB);
  assert.equal(String(vars.ODOO_EMPLOYEE_ID), String(EMPLOYEE_ID),
    'D4\'s one employee id is configuration');
  assert.equal(String(vars.ODOO_PAYMENT_METHOD_LINE_ID), String(PAYMENT_LINE_ID),
    "the bank-transfer payment method line is identified in config by its live id (D18)");
  assert.ok(!('ODOO_PAYMENT_METHOD_LINE' in vars),
    'and never by an ambiguous name');
  // The login pair is a pair of secrets: it is never committed to the config.
  assert.ok(!('ODOO_API_KEY' in vars), 'ODOO_API_KEY is a Worker secret, never a var');
  assert.ok(!('ODOO_USERNAME' in vars), 'ODOO_USERNAME is a Worker secret, never a var');
  return cfg;
}

async function startWorker(cfg, { persist, odooUrl, apiKey = ODOO_KEY, username = ODOO_USER }) {
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
      ODOO_USERNAME: username,
      ODOO_API_KEY: apiKey,
      ODOO_EMPLOYEE_ID: String(EMPLOYEE_ID),
      ODOO_PAYMENT_METHOD_LINE_ID: String(PAYMENT_LINE_ID)
    },
    port: 0
  });
  const url = await mf.ready;
  const db = await mf.getD1Database(binding);
  const base = url.origin;
  const allowed = cfg.vars.ALLOWED_ORIGIN;

  const call = async (method, pathname, { body, ip = '127.0.0.1' } = {}) => {
    const headers = { 'CF-Connecting-IP': ip, Origin: allowed };
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
    const text = await res.text();
    assert.equal(res.status, 200,
      'the scheduled handler is reached through the real cron port and completes');
    return text;
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

function maldivesDate(at = Date.now()) {
  return new Date(at + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function assertEntryShape(entry, expected) {
  assert.deepEqual(Object.keys(entry).sort(), ENTRY_MEMBERS,
    'an entry carries exactly the seven declared members — no odoo id, no attempts, no error text');
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(entry[k], v, `entry.${k}`);
  }
}

/** The retry bar is on exactly when the entry is 'Not sent'. */
function assertRetryTime(entry, { expectedMinutes, after }) {
  assert.equal(entry.status, NOT_SENT);
  const at = Date.parse(entry.next_retry_at);
  assert.ok(Number.isFinite(at), 'next_retry_at is an ISO 8601 UTC instant');
  const minutes = (at - after) / 60000;
  assert.ok(Math.abs(minutes - expectedMinutes) < 2,
    `the next try is about ${expectedMinutes} minutes out, not ${minutes.toFixed(1)}`);
}

async function row(db, id) {
  return db.prepare(
    'SELECT client_entry_id, status, odoo_id, attempts, next_retry_at, last_error,'
    + ' synced_at, amount_laari, entry_date, length(receipt) AS receipt_bytes'
    + ' FROM entry WHERE client_entry_id = ?').bind(id).first();
}

// ===========================================================================

test('worker_creates_one_draft_expense_per_entry_and_never_a_second', async t => {
  const cfg = await readConfig();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ike-v4-'));
  const odoo = await startFakeOdoo();
  const running = [];
  t.after(async () => {
    for (const mf of running) { try { await mf.dispose(); } catch { /* done */ } }
    await odoo.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  // The two records V4 resolves BY NAME at run time rather than by a guessed id.
  const PRODUCT = { id: 77, name: 'Salary', can_be_expensed: true };
  const PRODUCT2 = { id: 78, name: 'Meals', can_be_expensed: true };
  const NOT_EXPENSABLE = { id: 79, name: 'Water', can_be_expensed: false };
  odoo.seed('product.product', [PRODUCT, PRODUCT2, NOT_EXPENSABLE]);
  // No account.payment.method.line is seeded at all: D18 forbids searching that
  // model, so any search for it would find nothing and refuse the entry.

  const start = async opts => {
    const w = await startWorker(cfg, opts);
    running.push(w.mf);
    return w;
  };
  const w = await start({ persist: path.join(root, 'main'), odooUrl: odoo.url });
  await applySchema(w.db, cfg);

  const today = maldivesDate();
  const save = (id, over = {}) => w.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Salary', amount: '250.50', client_entry_id: id, ...over }
  });

  // ===================================================== one entry, one expense
  const receipt = JPEG(100);
  const saved = await save('ce-a', { receipt: b64(receipt) });
  assert.equal(saved.res.status, 200);
  assert.equal(saved.json.saved, true);
  assertEntryShape(saved.json.entry, {
    client_entry_id: 'ce-a', amount_mvr: '250.50', category: 'Salary',
    receipt_present: true, receipt_bytes: 100,
    status: WAITING,            // D12: saving is not sending
    next_retry_at: null         // nothing has failed, so the page shows no retry bar
  });
  assert.equal(odoo.state.calls.length, 0,
    'saving contacts Odoo not at all: the save answer is about the store (D3)');

  await w.tick();

  // ---- exactly one hr.expense, and its payload field by field (D4, D5, D16) --
  const creates = odoo.objectCalls().filter(c => c.model === 'hr.expense' && c.rpc === 'create');
  assert.equal(creates.length, 1, 'one saved entry became exactly one hr.expense');
  const vals = creates[0].args[0][0];
  const MARK_A = '[ike:ce-a]';
  assert.equal(vals.name, `Salary ${MARK_A}`,
    'the description carries the category and the unique mark naming the entry');
  assert.equal(vals.employee_id, EMPLOYEE_ID, 'every expense is Ahmed Rashad, id 1 (D4)');
  assert.equal(vals.product_id, PRODUCT.id,
    'the category resolved to an expensable product by name, never a guessed id');
  assert.equal(vals.total_amount, '250.50',
    'the amount crosses the wire as an exact decimal, not a binary float');
  assert.equal(vals.payment_mode, 'company_account', 'company-paid, not out of pocket (D11)');
  assert.equal(vals.payment_method_line_id, PAYMENT_LINE_ID,
    'paid by the configured bank-transfer line, named by its live id (D18)');
  assert.equal(vals.date, (await row(w.db, 'ce-a')).entry_date,
    'the expense is dated by the entry\'s stored UTC+5 day (D16)');
  assert.equal(vals.date, today);
  assert.ok(!('state' in vals), 'no state is written: the record is born draft (D5)');
  assert.ok(!('currency_id' in vals),
    'no currency is sent: MVR is the company currency, so the amount is MVR');

  // ---- the mark search runs BEFORE any create, on the very first attempt -----
  const firstObject = odoo.objectCalls()[0];
  assert.equal(firstObject.model, 'hr.expense');
  assert.equal(firstObject.rpc, 'search_read',
    'every attempt looks for the mark before it considers creating anything');
  assert.deepEqual(firstObject.args, [[['name', 'like', MARK_A]]],
    'the dedupe search is by the entry\'s own mark, as a substring');

  // ---- the receipt became one attachment on that expense, byte-identical -----
  const expenseId = creates[0].createdId;
  const attachments = [...odoo.state.attachments.values()];
  assert.equal(attachments.length, 1, 'the given receipt became exactly one attachment');
  assert.equal(attachments[0].res_model, 'hr.expense');
  assert.equal(attachments[0].res_id, expenseId, 'attached to the expense just created');
  assert.equal(attachments[0].name, `receipt ${MARK_A}`);
  assert.equal(attachments[0].mimetype, 'image/jpeg', 'the type is sniffed from the bytes');
  assert.ok(Buffer.from(attachments[0].raw, 'base64').equals(receipt),
    'the attached bytes are the posted receipt, byte for byte');

  // ---- the expense is draft, and the Worker called nothing that could move it
  assert.equal(odoo.state.expenses.get(expenseId).state, 'draft');
  const methods = new Set(odoo.state.calls.map(c => c.rpc || c.method));
  assert.deepEqual([...methods].sort(), ['authenticate', 'create', 'search_read'],
    'the complete set of Odoo methods V4 ever calls — no write, no unlink, no action_*');
  assert.ok(!JSON.stringify(odoo.state.calls).includes('action_'),
    'nothing is ever submitted, approved, posted or paid (D5)');

  // ---- and the page now sees 'Draft' with no retry bar (D12) -----------------
  const afterCreate = await w.call('GET', `/expenses/entries?date=${today}`);
  assert.equal(afterCreate.res.status, 200);
  const sentEntry = afterCreate.json.entries.find(e => e.client_entry_id === 'ce-a');
  assertEntryShape(sentEntry, {
    status: DRAFT, next_retry_at: null, amount_mvr: '250.50',
    receipt_present: true, receipt_bytes: 100
  });
  const r1 = await row(w.db, 'ce-a');
  assert.equal(r1.odoo_id, expenseId, 'the entry remembers which expense is its own');
  assert.equal(r1.status, 'draft');
  assert.equal(r1.last_error, null);
  assert.equal(r1.next_retry_at, null);
  assert.ok(Number.isFinite(Date.parse(r1.synced_at)));
  assert.equal(r1.amount_laari, 25050, 'the saved amount was never rewritten by syncing');

  // ===================================== a second run never creates a second one
  await w.tick();
  await w.tick();
  assert.equal(
    odoo.objectCalls().filter(c => c.model === 'hr.expense' && c.rpc === 'create').length, 1,
    'later runs create no second expense for an entry already sent');
  assert.equal(odoo.state.attachments.size, 1, 'and no second copy of the receipt');

  // =============================== every Odoo failure is 'Not sent' with a retry
  const failureModes = [
    ['http500', 'odoo_http_500'],
    ['ratelimit', 'odoo_rate_limited'],
    ['fault', 'odoo_fault'],
    ['garbage', 'odoo_bad_answer']
  ];
  let n = 0;
  for (const [mode, code] of failureModes) {
    const id = `ce-f${n++}`;
    await save(id, { amount: '12.00' });
    odoo.set(mode);
    const at = Date.now();
    await w.tick();
    odoo.set('ok');
    const listed = (await w.call('GET', `/expenses/entries?date=${today}`)).json.entries
      .find(e => e.client_entry_id === id);
    assertRetryTime(listed, { expectedMinutes: BACKOFF_MINUTES[0], after: at });
    assertEntryShape(listed, { amount_mvr: '12.00', category: 'Salary', status: NOT_SENT });
    const r = await row(w.db, id);
    assert.equal(r.status, 'failed', `${mode} leaves the entry saved and unsent`);
    assert.equal(r.attempts, 1);
    assert.equal(r.odoo_id, null);
    assert.equal(r.last_error, code, `${mode} is recorded as the closed code ${code}`);
    assert.equal(r.amount_laari, 1200, 'a failed send cannot alter a saved entry');
  }

  // ---- a category that resolves to no expensable product refuses THAT entry,
  // ---- while a healthy entry in the SAME run still reaches Draft -------------
  await save('ce-bad', { category: 'Water', amount: '5.00' });
  await save('ce-good', { category: 'Meals', amount: '7.00' });
  const atMixed = Date.now();
  await w.tick();
  const bad = await row(w.db, 'ce-bad');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.last_error, 'odoo_no_product',
    'a name that matches nothing expensable never becomes a wrong expense');
  assert.equal(bad.odoo_id, null);
  const good = await row(w.db, 'ce-good');
  assert.equal(good.status, 'draft', 'one bad entry does not block the rest of the run');
  assert.ok(good.odoo_id > 0);
  const mixed = (await w.call('GET', `/expenses/entries?date=${today}`)).json.entries;
  assertRetryTime(mixed.find(e => e.client_entry_id === 'ce-bad'),
    { expectedMinutes: BACKOFF_MINUTES[0], after: atMixed });
  assert.equal(mixed.find(e => e.client_entry_id === 'ce-good').status, DRAFT);

  // ===================== a create whose answer was lost is adopted, not repeated
  await save('ce-d', { category: 'Meals', amount: '31.00', receipt: b64(JPEG(64)) });
  odoo.set('lose-answer');
  await w.tick();
  odoo.set('ok');
  const lost = await row(w.db, 'ce-d');
  assert.equal(lost.status, 'failed', 'a lost answer is Indeterminate, so the entry stays unsent');
  assert.equal(lost.odoo_id, null, 'the Worker never learned the id');
  assert.equal(lost.attempts, 1);
  const marked = [...odoo.state.expenses.values()]
    .filter(e => String(e.name).includes('[ike:ce-d]'));
  assert.equal(marked.length, 1, 'but Odoo committed the expense');

  const retried = await w.call('POST', '/expenses/entries/ce-d/retry');
  assert.equal(retried.res.status, 200);
  assertEntryShape(retried.json.entry, {
    client_entry_id: 'ce-d', status: DRAFT, next_retry_at: null, amount_mvr: '31.00'
  });
  const adopted = [...odoo.state.expenses.values()]
    .filter(e => String(e.name).includes('[ike:ce-d]'));
  assert.equal(adopted.length, 1,
    'the retry found the existing expense by its mark instead of creating a second');
  const rd = await row(w.db, 'ce-d');
  assert.equal(rd.odoo_id, marked[0].id, 'and adopted exactly that expense');
  assert.equal(rd.next_retry_at, null);
  assert.equal(rd.last_error, null);
  assert.equal(
    [...odoo.state.attachments.values()].filter(a => a.res_id === marked[0].id).length, 1,
    'the adopted expense is never given a second copy of the same receipt');

  // ============================================ the Retry port, D12's button
  // An entry already Draft is answered with its projection and zero Odoo calls.
  const before = odoo.state.calls.length;
  const again = await w.call('POST', '/expenses/entries/ce-d/retry');
  assert.equal(again.res.status, 200);
  assert.deepEqual(again.json.entry, retried.json.entry);
  assert.equal(odoo.state.calls.length, before, 'a sent entry is not sent again');
  assert.ok(!('saved' in again.json),
    "'saved: true' still occurs in exactly one place in the service: the save answer");

  const unknown = await w.call('POST', '/expenses/entries/ce-nope/retry');
  assert.equal(unknown.res.status, 404);
  assert.equal(unknown.json.saved, false);
  assert.equal(unknown.json.error, 'not_found');

  // ---- Retry sends at once even when the scheduled time is in the future, and
  // ---- the backoff lengthens with each failed try --------------------------
  await save('ce-b', { amount: '9.00' });
  odoo.set('http500');
  for (const [i, minutes] of [BACKOFF_MINUTES[0], BACKOFF_MINUTES[1], BACKOFF_MINUTES[2]].entries()) {
    const at = Date.now();
    const answer = await w.call('POST', '/expenses/entries/ce-b/retry');
    assert.equal(answer.res.status, 200);
    assertRetryTime(answer.json.entry, { expectedMinutes: minutes, after: at });
    const r = await row(w.db, 'ce-b');
    assert.equal(r.attempts, i + 1, 'attempts is the honest count of tries');
  }
  odoo.set('ok');
  const recovered = await w.call('POST', '/expenses/entries/ce-b/retry');
  assert.equal(recovered.json.entry.status, DRAFT, 'Retry sends it the moment Odoo is back');
  assert.equal(recovered.json.entry.next_retry_at, null);
  assert.equal((await row(w.db, 'ce-b')).attempts, 4,
    'success leaves the honest attempt count, it does not reset it');

  // ======================= an unanswered Odoo ends the run instead of hanging it
  await save('ce-h', { amount: '3.00' });
  odoo.set('hang');
  const startedAt = Date.now();
  await w.tick();
  const elapsed = Date.now() - startedAt;
  odoo.set('ok');
  const hung = await row(w.db, 'ce-h');
  assert.equal(hung.status, 'failed');
  assert.equal(hung.last_error, 'odoo_timeout');
  assert.ok(elapsed < 30000,
    `the run ended on its own timeout (${elapsed} ms), it did not hang the schedule`);
  assert.ok(Number.isFinite(Date.parse(hung.next_retry_at)));

  // =================================== bad credentials are a code, not a crash
  const badAuth = await start({
    persist: path.join(root, 'badauth'), odooUrl: odoo.url, apiKey: 'wrong-key'
  });
  await applySchema(badAuth.db, cfg);
  await badAuth.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Salary', amount: '8.00', client_entry_id: 'ce-auth' }
  });
  const authAt = Date.now();
  await badAuth.tick();
  const authRow = await row(badAuth.db, 'ce-auth');
  assert.equal(authRow.status, 'failed');
  assert.equal(authRow.last_error, 'odoo_auth_failed',
    'a refused login is a closed code, never a crash and never Odoo\'s own text');
  assert.equal(authRow.odoo_id, null);
  assertRetryTime(
    (await badAuth.call('GET', `/expenses/entries?date=${today}`)).json.entries
      .find(e => e.client_entry_id === 'ce-auth'),
    { expectedMinutes: BACKOFF_MINUTES[0], after: authAt });

  // ================== the API key exists only as a Worker secret, and stays one
  const everyAnswer = JSON.stringify([
    saved.json, afterCreate.json, retried.json, again.json, unknown.json,
    recovered.json, mixed,
    (await w.call('GET', `/expenses/entries?date=${today}`)).json,
    (await w.call('GET', '/expenses/categories')).json
  ]);
  assert.ok(!everyAnswer.includes(ODOO_KEY), 'the key never appears in any answer');
  assert.ok(!everyAnswer.includes(ODOO_USER), 'nor does the login name');
  assert.ok(!/odoo\.com/.test(everyAnswer), 'nor the Odoo endpoint');

  const tables = await w.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
    + " AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
    + " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all();
  for (const { name } of tables.results) {
    const all = await w.db.prepare(`SELECT * FROM "${name}"`).all();
    const dump = JSON.stringify(all.results);
    assert.ok(!dump.includes(ODOO_KEY), `the key appears nowhere in ${name}`);
    assert.ok(!dump.includes('faultString'), `no Odoo text is stored in ${name}`);
  }
  for (const c of odoo.state.calls) {
    assert.match(c.path, /^\/xmlrpc\/2\/(common|object)$/,
      'the key only ever travelled to the configured Odoo XML-RPC endpoints');
  }
});
