// Oracle for "V2 Description in Odoo".
//
// Authority: docs/product/architecture/brief.md#V2 Description in Odoo, and the
// obligations D19, D8, D5/D18 carried with it.
//
// Driving ports: HTTP (POST /expenses/entries seeds the entries) and the
// Cloudflare cron. The Worker runs in a real workerd (miniflare) on a loopback
// socket; the schedule is triggered through workerd's own cron port
// (/cdn-cgi/handler/scheduled), never by importing a handler.
//
// Driven port: Odoo's XML-RPC endpoint, which here is a LOCAL FAKE on loopback
// speaking the same wire protocol. The name this oracle judges is read off the
// wire, out of the create call's vals — not out of any Worker-internal value.
// No call in this file can reach mrh-investment.odoo.com: ODOO_URL is bound to
// the fake.
//
// Nothing under worker/src is imported: expenseName is never called directly,
// only observed through the name Odoo is actually sent.

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

const EMPLOYEE_ID = 1;
const PAYMENT_LINE_ID = 2;

const ODOO_DB = 'mrh-investment';
const ODOO_USER = 'mrhpvt@gmail.com';
const ODOO_KEY = 'rpc-key-must-never-escape-0f9a1c';

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
// The fake Odoo. It logs every call and seeds the records the sync resolves by
// name. Its `like` is a substring match, exactly as Odoo's is, which is what
// lets this oracle prove a description in front of the mark cannot hide an
// expense from the dedupe search.
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
    const log = { path: req.url, method: call.name, params: call.params };
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

    if (state.mode === 'lose-answer' && model === 'hr.expense' && method === 'create') {
      const vals = args[0][0];
      const id = state.nextId++;
      state.expenses.set(id, { ...vals, id, state: 'draft' });
      log.createdId = id;
      res.destroy();                               // committed, answer lost
      return;
    }

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
    // Anything else is a method the design promises never to call.
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
    'the config still declares the 15-minute schedule as the cron driving port');
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

  const tick = async () => {
    const res = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(CRON)}`);
    await res.text();
    assert.equal(res.status, 200,
      'the scheduled handler is reached through the real cron port and completes');
  };

  return { mf, db, call, tick };
}

async function applySchema(db, cfg) {
  // Every migration, in file-name order, as `wrangler d1 migrations apply` runs
  // them: the description column arrives through its own migration.
  const dir = path.join(WORKER, cfg.d1_databases[0].migrations_dir);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  const sql = (await Promise.all(files.map(f => fs.readFile(path.join(dir, f), 'utf8')))).join('\n');
  const statements = sql
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
  await db.batch(statements.map(s => db.prepare(s)));
}

function maldivesDate(at = Date.now()) {
  return new Date(at + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

// ===========================================================================

test('the_draft_expense_name_carries_the_description', async t => {
  const cfg = await readConfig();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ike-v2-desc-'));
  const odoo = await startFakeOdoo();
  const w0 = { mf: null };
  t.after(async () => {
    if (w0.mf) { try { await w0.mf.dispose(); } catch { /* done */ } }
    await odoo.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  // The categories the sync resolves to an expensable product BY NAME.
  odoo.seed('product.product', [
    { id: 77, name: 'Salary', can_be_expensed: true },
    { id: 78, name: 'Meals', can_be_expensed: true },
    { id: 79, name: 'Fuel / Petrol', can_be_expensed: true }
  ]);

  const w = await startWorker(cfg, { persist: path.join(root, 'main'), odooUrl: odoo.url });
  w0.mf = w.mf;
  await applySchema(w.db, cfg);

  const today = maldivesDate();
  const save = over => w.call('POST', '/expenses/entries', {
    body: { pin: PIN, category: 'Salary', amount: '250.50', ...over }
  });

  // The entries: one with a description, one with none, plus the three ways the
  // save port is told "no description" — absent, null and whitespace-only.
  const RECEIPT = JPEG(100);
  const DESCRIPTION = 'Diesel for the pickup';

  const withDesc = await save({
    client_entry_id: 'ce-desc', category: 'Fuel / Petrol', amount: '310.00',
    description: DESCRIPTION, receipt: b64(RECEIPT)
  });
  assert.equal(withDesc.res.status, 200);
  assert.equal(withDesc.json.saved, true);

  const absent = await save({ client_entry_id: 'ce-absent', category: 'Meals', amount: '42.00' });
  assert.equal(absent.res.status, 200, 'an entry may still be saved with no description at all');
  const nulled = await save({
    client_entry_id: 'ce-null', category: 'Meals', amount: '43.00', description: null
  });
  assert.equal(nulled.res.status, 200);
  const blank = await save({
    client_entry_id: 'ce-blank', category: 'Meals', amount: '44.00', description: '   \t  '
  });
  assert.equal(blank.res.status, 200);

  assert.equal(odoo.state.calls.length, 0, 'saving contacts Odoo not at all');

  await w.tick();

  const creates = () => odoo.objectCalls().filter(c => c.model === 'hr.expense' && c.rpc === 'create');
  const createdFor = id => {
    const hit = creates().find(c => String(c.args[0][0].name).includes(`[ike:${id}]`));
    assert.ok(hit, `the entry ${id} became exactly one hr.expense create`);
    return hit;
  };

  assert.equal(creates().length, 4, 'four saved entries became four hr.expense creates');

  // ================================================== D19: the name, both forms
  const described = createdFor('ce-desc').args[0][0];
  assert.equal(described.name, `Fuel / Petrol - ${DESCRIPTION} [ike:ce-desc]`,
    'a described entry is named "<category> - <description> <mark>"');

  for (const id of ['ce-absent', 'ce-null', 'ce-blank']) {
    assert.equal(createdFor(id).args[0][0].name, `Meals [ike:${id}]`,
      `an entry with no description keeps the bare "<category> <mark>" name (${id})`);
  }

  // The separator belongs to the described form only: an undescribed name carries
  // no dangling ' - ', and the description is not doubled into the described one.
  assert.ok(!createdFor('ce-absent').args[0][0].name.includes(' - '),
    'no empty description leaves a dangling separator behind');
  assert.equal(
    described.name.split(DESCRIPTION).length - 1, 1,
    'the description appears exactly once in the name');

  // ============================== D8: the mark stays the LAST token of the name
  for (const id of ['ce-desc', 'ce-absent', 'ce-null', 'ce-blank']) {
    const name = createdFor(id).args[0][0].name;
    const mark = `[ike:${id}]`;
    assert.ok(name.endsWith(mark),
      `the mark is still the last token of the name, after the description (${id})`);
    assert.equal(name.split(' ').pop(), mark,
      `and it is a whole trailing token, space-separated (${id})`);
  }

  // ======= D8: the mark search runs BEFORE every create, with the same domain --
  const firstObject = odoo.objectCalls()[0];
  assert.equal(firstObject.model, 'hr.expense');
  assert.equal(firstObject.rpc, 'search_read',
    'every attempt still looks for the mark before it considers creating anything');
  for (const id of ['ce-desc', 'ce-absent', 'ce-null', 'ce-blank']) {
    const searches = odoo.objectCalls().filter(c =>
      c.model === 'hr.expense' && c.rpc === 'search_read'
      && JSON.stringify(c.args).includes(`[ike:${id}]`));
    assert.ok(searches.length >= 1, `the dedupe search ran for ${id}`);
    assert.deepEqual(searches[0].args, [[['name', 'like', `[ike:${id}]`]]],
      `the dedupe search domain is unchanged by the description (${id})`);
    const searchAt = odoo.objectCalls().indexOf(searches[0]);
    const createAt = odoo.objectCalls().indexOf(createdFor(id));
    assert.ok(searchAt < createAt, `the search preceded the create for ${id}`);
  }

  // ================================ D5/D18: no other field sent to Odoo changed
  const row = async id => w.db.prepare(
    'SELECT client_entry_id, status, odoo_id, entry_date, description FROM entry'
    + ' WHERE client_entry_id = ?').bind(id).first();
  const descRow = await row('ce-desc');
  assert.equal(descRow.description, DESCRIPTION,
    'the stored description is the one V1 normalised, carried through untouched');
  assert.deepEqual(Object.keys(described).sort(), [
    'date', 'employee_id', 'name', 'payment_method_line_id', 'payment_mode',
    'product_id', 'total_amount', 'total_amount_currency'
  ], 'the create still sends exactly the declared fields — the description added none');
  assert.equal(described.employee_id, EMPLOYEE_ID);
  assert.equal(described.product_id, 79, 'the category still resolved by name, not the name sent');
  assert.equal(described.total_amount, '310.00');
  assert.equal(described.total_amount_currency, '310.00');
  assert.equal(described.payment_mode, 'company_account');
  assert.equal(described.payment_method_line_id, PAYMENT_LINE_ID);
  assert.equal(described.date, descRow.entry_date);
  assert.equal(described.date, today);
  assert.ok(!('state' in described), 'no state is written: the record is born draft');
  assert.ok(!('description' in described),
    'the description reaches Odoo only through the name, never as a field of its own');
  assert.ok(!('currency_id' in described), 'no currency is sent: MVR is the company currency');

  const methods = new Set(odoo.state.calls.map(c => c.rpc || c.method));
  assert.deepEqual([...methods].sort(), ['authenticate', 'create', 'search_read'],
    'the complete set of Odoo methods — no write, no unlink, no action_*');
  assert.ok(!JSON.stringify(odoo.state.calls).includes('action_'),
    'nothing is ever submitted, approved, posted or paid');

  // ======================= the receipt attachment name is untouched by all this
  const attachments = [...odoo.state.attachments.values()];
  assert.equal(attachments.length, 1, 'the one given receipt became exactly one attachment');
  assert.equal(attachments[0].name, 'receipt [ike:ce-desc]',
    'the attachment name carries the mark alone — never the description');
  assert.equal(attachments[0].res_model, 'hr.expense');
  assert.equal(attachments[0].res_id, createdFor('ce-desc').createdId);
  assert.equal(attachments[0].mimetype, 'image/jpeg');
  assert.ok(Buffer.from(attachments[0].raw, 'base64').equals(RECEIPT),
    'the attached bytes are the posted receipt, byte for byte');

  // =============== a later run creates no second expense for a described entry
  await w.tick();
  await w.tick();
  assert.equal(creates().length, 4,
    'later runs create no second expense: a description in front of the mark cannot hide it');
  assert.equal(odoo.state.attachments.size, 1, 'and no second copy of the receipt');

  // ====== and a described expense whose create answer was lost is ADOPTED, so
  // ====== the substring search really does see past the description (D8) ------
  await save({
    client_entry_id: 'ce-lost', category: 'Meals', amount: '19.00',
    description: 'Lunch with the supplier'
  });
  odoo.set('lose-answer');
  await w.tick();
  odoo.set('ok');
  const committed = [...odoo.state.expenses.values()]
    .filter(e => String(e.name).includes('[ike:ce-lost]'));
  assert.equal(committed.length, 1, 'Odoo committed the described expense');
  assert.equal(committed[0].name, 'Meals - Lunch with the supplier [ike:ce-lost]');
  assert.equal((await row('ce-lost')).odoo_id, null, 'the Worker never learned the id');

  const retried = await w.call('POST', '/expenses/entries/ce-lost/retry');
  assert.equal(retried.res.status, 200);
  assert.equal(retried.json.entry.status, 'Draft');
  assert.equal(
    [...odoo.state.expenses.values()].filter(e => String(e.name).includes('[ike:ce-lost]')).length,
    1, 'the retry found the described expense by its mark instead of creating a second');
  assert.equal((await row('ce-lost')).odoo_id, committed[0].id,
    'and adopted exactly that expense');

  // =========== the day list still projects the seven declared members, with no
  // =========== description among them: this version changed Odoo, not the page
  const day = await w.call('GET', `/expenses/entries?date=${today}`);
  assert.equal(day.res.status, 200);
  const listed = day.json.entries.find(e => e.client_entry_id === 'ce-desc');
  assert.deepEqual(Object.keys(listed).sort(), [
    'amount_mvr', 'category', 'client_entry_id', 'next_retry_at',
    'receipt_bytes', 'receipt_present', 'status'
  ], 'an entry still carries exactly the seven declared members');
  assert.equal(listed.status, 'Draft');
  assert.equal(listed.amount_mvr, '310.00');
  assert.equal(listed.category, 'Fuel / Petrol');
});
