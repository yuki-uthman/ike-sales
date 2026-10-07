// Regression oracle for "the receipt reaches Odoo empty".
//
// Observed defect (2026-10-07): attachment 2015 on hr.expense 55, named
// "receipt [ike:6d384ca3-037f-41ef-9a7f-e3e356bc7b55]", mimetype image/jpeg,
// was stored EMPTY — file_size 0, checksum False. The create call answered an
// id and raised nothing, so nothing flagged the failure.
//
// Authority: ../odoo/CLAUDE.md, the "ir.attachment has no `datas` field in
// saas-19.4" bullet. Cited, never opened by this file. On that instance:
//   * ir.attachment has no `datas` field, and create() drops unknown keys
//     without an error, so a `datas` upload stores 0 bytes;
//   * the content field is `raw`, sent as a base64 STRING — `raw` as an
//     XML-RPC <base64> (xmlrpc.client.Binary) is refused;
//   * the stored attachment carries file_size and checksum (the sha1 hex of
//     the bytes);
//   * create() with a list of vals answers a LIST of ids, [id], not an int.
//
// Driving ports: HTTP and the Cloudflare cron, on a real workerd (miniflare)
// started from worker/wrangler.json. Driven ports: the D1 binding (read back
// directly) and Odoo's XML-RPC endpoint, here a LOCAL FAKE on loopback that
// models the saas-19.4 behaviour above. No call in this file can reach
// mrh-investment.odoo.com.
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
const CRON = '*/15 * * * *';

const DRAFT = 'Draft';
const NOT_SENT = 'Not sent';

const EMPLOYEE_ID = 1;
const PAYMENT_LINE_ID = 2;

const ODOO_DB = 'mrh-investment';
const ODOO_USER = 'mrhpvt@gmail.com';
const ODOO_KEY = 'rpc-key-must-never-escape-0f9a1c';

const b64 = bytes => Buffer.from(bytes).toString('base64');
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest('hex');
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
// The fake Odoo, as saas-19.4 behaves. ir.attachment knows only the fields
// below; every other key in a create() is dropped without an error, exactly as
// the live instance drops `datas`. `raw` is accepted only as a base64 string.
// Every create() answers a LIST of ids.
// ===========================================================================

const ATTACHMENT_FIELDS = new Set(['name', 'res_model', 'res_id', 'mimetype', 'raw', 'type']);

async function startFakeOdoo() {
  const state = {
    calls: [], expenses: new Map(), attachments: new Map(),
    seed: new Map(), nextId: 201, uid: 2,
    storesNothing: false        // the server keeps 0 bytes whatever it is sent
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
    if (op === 'like' || op === 'ilike') return String(got).includes(String(v).replace(/%/g, ''));
    if (op === 'in') return v.map(String).includes(String(got));
    throw new Error('the fake was asked for an operator it does not model: ' + op);
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
    const log = { path: req.url, method: call.name, params: call.params, body };
    state.calls.push(log);

    if (req.url === '/xmlrpc/2/common') {
      const [d, u, k] = call.params;
      return respond(res, d === ODOO_DB && u === ODOO_USER && k === ODOO_KEY ? state.uid : false);
    }
    if (req.url !== '/xmlrpc/2/object' || call.name !== 'execute_kw') {
      return fault(res, 1, 'no such endpoint');
    }
    const [, uid, key, model, method, args, kwargs] = call.params;
    Object.assign(log, { model, rpc: method, args, kwargs });
    if (key !== ODOO_KEY || uid !== state.uid) return fault(res, 3, 'AccessDenied');

    if (method === 'create') {
      assert.ok(Array.isArray(args) && Array.isArray(args[0]),
        'create wraps its vals in the outer list Odoo demands, even for one record');
      const vals = args[0][0];
      const id = state.nextId++;
      log.createdId = id;
      if (model === 'hr.expense') {
        state.expenses.set(id, { ...vals, id, state: 'draft' });
        return respond(res, [id]);
      }
      if (model === 'ir.attachment') {
        if (/<name>raw<\/name>\s*<value>\s*<base64>/.test(body)) {
          return fault(res, 2, 'TypeError: ir.attachment.raw: use BinaryValue instead of Binary');
        }
        const kept = Object.fromEntries(
          Object.entries(vals).filter(([k]) => ATTACHMENT_FIELDS.has(k)));
        const bytes = typeof kept.raw === 'string' && !state.storesNothing
          ? Buffer.from(kept.raw, 'base64') : Buffer.alloc(0);
        delete kept.raw;
        state.attachments.set(id, {
          ...kept, id,
          file_size: bytes.length,
          checksum: bytes.length ? sha1(bytes) : false,
          bytes
        });
        return respond(res, [id]);
      }
      return fault(res, 2, 'cannot create ' + model);
    }
    if (method === 'search_read') {
      const domain = args[0] || [];
      const fields = (kwargs && kwargs.fields) || null;
      if (fields && fields.includes('datas')) {
        return fault(res, 2, "Invalid field 'datas' on 'ir.attachment'");
      }
      const source = state.seed.has(model) ? state.seed.get(model)
        : model === 'ir.attachment' ? [...state.attachments.values()]
          : model === 'hr.expense' ? [...state.expenses.values()]
            : [];
      let rows = source.filter(r => matches(r, domain));
      if (kwargs && kwargs.limit) rows = rows.slice(0, kwargs.limit);
      return respond(res, project(rows, fields));
    }
    return fault(res, 2, 'forbidden method ' + method + ' on ' + model);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    state,
    objectCalls: () => state.calls.filter(c => c.path === '/xmlrpc/2/object'),
    seed(model, rows) { state.seed.set(model, rows); },
    close: () => new Promise(r => server.close(r))
  };
}

// ===========================================================================
// config, runtime, and the two driving ports
// ===========================================================================

async function readConfig() {
  return JSON.parse(await fs.readFile(path.join(WORKER, 'wrangler.json'), 'utf8'));
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

async function row(db, id) {
  return db.prepare(
    'SELECT client_entry_id, status, odoo_id, attempts, next_retry_at, last_error,'
    + ' synced_at, amount_laari, entry_date, length(receipt) AS receipt_bytes'
    + ' FROM entry WHERE client_entry_id = ?').bind(id).first();
}

async function setup(t) {
  const cfg = await readConfig();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ike-receipt-'));
  const odoo = await startFakeOdoo();
  odoo.seed('product.product', [{ id: 77, name: 'Salary', can_be_expensed: true }]);
  const w = await startWorker(cfg, { persist: path.join(root, 'main'), odooUrl: odoo.url });
  t.after(async () => {
    try { await w.mf.dispose(); } catch { /* done */ }
    await odoo.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await applySchema(w.db, cfg);
  const today = maldivesDate();
  const save = (id, receipt) => w.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Salary', amount: '250.50', client_entry_id: id, receipt: b64(receipt) }
  });
  const status = async id => {
    const day = await w.call('GET', `/expenses/entries?date=${today}`);
    assert.equal(day.res.status, 200);
    return day.json.entries.find(e => e.client_entry_id === id).status;
  };
  const retry = async id => {
    const r = await w.call('POST', `/expenses/entries/${encodeURIComponent(id)}/retry`);
    assert.equal(r.res.status, 200);
    return r.json.entry;
  };
  return { w, odoo, save, status, retry };
}

const creates = (odoo, model) =>
  odoo.objectCalls().filter(c => c.model === model && c.rpc === 'create');

// ===========================================================================

test('receipt_reaches_odoo_with_its_own_size_and_checksum', async t => {
  const { w, odoo, save, status } = await setup(t);
  const receipt = JPEG(5000);
  assert.equal((await save('ce-a', receipt)).res.status, 200);

  await w.tick();

  const sent = creates(odoo, 'ir.attachment');
  assert.equal(sent.length, 1, 'the receipt was uploaded exactly once');
  const vals = sent[0].args[0][0];
  assert.ok(!('datas' in vals),
    'saas-19.4 has no ir.attachment.datas: a `datas` upload is dropped and stores 0 bytes');
  assert.equal(typeof vals.raw, 'string', 'the content travels in `raw`, as a base64 string');
  assert.ok(!/<base64>/.test(sent[0].body), '`raw` is never an XML-RPC <base64> (Binary)');
  assert.equal(vals.mimetype, 'image/jpeg');
  assert.equal(vals.res_model, 'hr.expense');

  const stored = [...odoo.state.attachments.values()];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].file_size, receipt.length,
    'Odoo stored as many bytes as the receipt has — not 0');
  assert.equal(stored[0].checksum, sha1(receipt),
    "Odoo's checksum is the sha1 of the posted receipt");
  assert.ok(stored[0].bytes.equals(receipt), 'the stored bytes are the receipt, byte for byte');

  assert.equal((await row(w.db, 'ce-a')).status, 'draft');
  assert.equal(await status('ce-a'), DRAFT);
});

test('an_upload_odoo_stores_empty_is_never_reported_as_sent', async t => {
  const { w, odoo, save, status, retry } = await setup(t);
  const receipt = JPEG(3000);
  odoo.state.storesNothing = true;           // the 2026-10-07 symptom: an id, and 0 bytes
  assert.equal((await save('ce-b', receipt)).res.status, 200);

  await w.tick();

  const [upload] = creates(odoo, 'ir.attachment');
  assert.ok(upload, 'the upload was attempted');
  assert.equal(odoo.state.attachments.get(upload.createdId).file_size, 0);

  // The Worker read the attachment back rather than trusting the id.
  const readBack = odoo.objectCalls().find(c => c.model === 'ir.attachment'
    && c.rpc === 'search_read'
    && JSON.stringify(c.args[0]).includes(JSON.stringify(['id', '=', upload.createdId])));
  assert.ok(readBack, 'the created attachment is read back by its id');
  assert.ok(readBack.kwargs.fields.includes('file_size') && readBack.kwargs.fields.includes('checksum'),
    'the read-back asks for file_size and checksum');

  const r1 = await row(w.db, 'ce-b');
  assert.notEqual(r1.status, 'draft', 'an empty receipt is not a sent entry');
  assert.equal(r1.last_error, 'odoo_receipt_not_stored',
    'the failure has its own closed code, so it is not mistaken for a network fault');
  assert.equal(await status('ce-b'), NOT_SENT, 'the page shows it as Not sent, with Retry');

  // A retry must not take the empty copy left by the first attempt for the receipt.
  assert.equal((await retry('ce-b')).status, NOT_SENT,
    'an empty attachment already on the expense does not count as the receipt');

  // Once Odoo stores what it is sent, the next retry completes the entry.
  odoo.state.storesNothing = false;
  assert.equal((await retry('ce-b')).status, DRAFT);
  const full = [...odoo.state.attachments.values()].filter(a => a.file_size > 0);
  assert.equal(full.length, 1, 'exactly one attachment carries the receipt');
  assert.equal(full[0].checksum, sha1(receipt));
  assert.equal(creates(odoo, 'hr.expense').length, 1, 'still one expense, never a second');
});

test('a_create_answered_as_a_list_gives_the_worker_the_id_inside_it', async t => {
  const { w, odoo, save, status } = await setup(t);
  const receipt = JPEG(1200);
  assert.equal((await save('ce-c', receipt)).res.status, 200);

  await w.tick();

  const expenseCreates = creates(odoo, 'hr.expense');
  assert.equal(expenseCreates.length, 1);
  const expenseId = expenseCreates[0].createdId;
  const r = await row(w.db, 'ce-c');
  assert.equal(r.last_error, null, 'an answer of [id] is a good answer, not odoo_bad_answer');
  assert.equal(r.status, 'draft', 'the entry is sent on its first attempt');
  assert.equal(r.odoo_id, expenseId, 'the entry remembers the id inside [id], as a number');

  const [upload] = creates(odoo, 'ir.attachment');
  assert.ok(upload, 'the receipt was uploaded in the same attempt');
  assert.equal(upload.args[0][0].res_id, expenseId,
    'the attachment points at the expense id, not at a list');
  const readBack = odoo.objectCalls().find(c => c.model === 'ir.attachment'
    && c.rpc === 'search_read'
    && JSON.stringify(c.args[0]).includes(JSON.stringify(['id', '=', upload.createdId])));
  assert.ok(readBack, 'the read-back uses the attachment id inside [id]');
  assert.equal(await status('ce-c'), DRAFT);
});
