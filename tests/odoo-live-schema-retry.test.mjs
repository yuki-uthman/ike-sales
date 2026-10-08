// Oracle for "Vb Live-schema corrections and the Retry press".
//
// Authority: docs/product/brief.md#Decisions D18 (with D4, D5, D11, D12, D15,
// D16 unchanged) and Observations Vb -> DESIGN "Vb Live-schema corrections and
// the Retry press". The brief is cited, never opened by this file.
//
// Driving ports, all three real:
//   * the Cloudflare cron, through workerd's own cron port
//     (/cdn-cgi/handler/scheduled) — never by importing the handler;
//   * HTTP — the actual worker/src/index.mjs on a real workerd (miniflare) over
//     a real loopback socket, started FROM worker/wrangler.json, with the schema
//     SSOT worker/migrations/0001_init.sql applied through the declared D1
//     binding;
//   * a real browser (Playwright/Chromium) at the phone viewport, loading the
//     deployed artefact index.html over HTTP from a local static server, which
//     is how GitHub Pages serves it.
//
// Driven ports: the D1 binding (read back directly) and Odoo's XML-RPC
// endpoint, which here is a LOCAL FAKE on loopback speaking the same wire
// protocol. No call in this file can reach mrh-investment.odoo.com: ODOO_URL is
// bound to the fake on every layer this file starts.
//
// Nothing is imported from worker/src or from the page, and no expected value is
// read out of either: every literal below — the line id 2, the two 'Transfer'
// lines, the field names total_amount / total_amount_currency / price_unit, the
// closed code, the path shape — is written out from D18.
//
// Narrowed at Vc: migrations_dir is read from d1_databases[0], where
// wrangler's own schema places it (wrangler 4.148.0 rejects the top-level
// key). Only the read location moved; no claim was added or retired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Miniflare } from 'miniflare';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(REPO, 'worker');

// ---------------------------------------------------------------- D18's facts
// The live account.payment.method.line the company's bank transfers are paid
// by: id 2, named 'Transfer', on the Bank journal, outbound. Id 1 is ALSO named
// 'Transfer' (inbound), which is exactly why a name cannot name it.
const PAYMENT_LINE_ID = 2;
const LIVE_LINES = [
  { id: 1, name: 'Transfer' },
  { id: 2, name: 'Transfer' }
];
// The name the pristine Worker guessed, which no live record carries.
const ABSENT_LINE_NAME = 'Bank Transfer MVR';
// The var that carries the id, and the var that must no longer exist.
const LINE_ID_VAR = 'ODOO_PAYMENT_METHOD_LINE_ID';
const OLD_LINE_NAME_VAR = 'ODOO_PAYMENT_METHOD_LINE';
// D18: hr.expense.total_amount_currency is the amount in the expense's own
// currency and must be sent beside total_amount; price_unit is readonly and
// computed, so it is never sent.
const CURRENCY_AMOUNT_FIELD = 'total_amount_currency';
const AMOUNT_FIELD = 'total_amount';
const FORBIDDEN_FIELD = 'price_unit';
// The one closed code a missing or unusable configured id fails with — the same
// code the deleted name search used, so no reader learns a new word.
const NO_LINE_CODE = 'odoo_no_payment_method_line';
// Values that are not a positive integer id. Each must behave exactly as if the
// var were absent, and none may crash the run. ' 2 ' is accepted instead,
// because a dashboard value may carry whitespace.
const BAD_IDS = ['', '0', '-2', '2.5', 'two'];
const PADDED_GOOD_ID = ' 2 ';

// D4: the one employee every expense belongs to.
const EMPLOYEE_ID = 1;
// D15's backoff, in minutes, for attempts 1..6+.
const BACKOFF_MINUTES = [15, 30, 60, 120, 240, 360];
// D12's chip words.
const CHIPS = ['Waiting to send', 'Not sent', 'Draft', 'Approved', 'Refused'];
const NOT_SENT = 'Not sent';
const DRAFT = 'Draft';

const CRON = '*/15 * * * *';
const PIN = '482913';
const AMOUNT_TYPED = '250.50';
const AMOUNT_LAARI = 25050;
// D7 names this category; the fake seeds an expensable product for whichever
// name the layer's own list offers, so no name is assumed here.
const HTTP_CATEGORY = 'Salary';

const ODOO_DB = 'mrh-investment';
const ODOO_USER = 'mrhpvt@gmail.com';
const ODOO_KEY = 'rpc-key-must-never-escape-vb-7731';

// The design screens are drawn at 390x844 — "on a phone".
const PHONE = { width: 390, height: 844 };

const FEED_BASE = 'https://raw.githubusercontent.com/yuki-uthman/ike-data/main/data/';
const EXPENSES_FEED = FEED_BASE + 'expenses.json';

/** D16: the Maldives (UTC+5) date, the page's TODAY. */
const maldivesToday = (at = Date.now()) =>
  new Date(at + 5 * 3600 * 1000).toISOString().slice(0, 10);

const flat = s => (s || '').replace(/\s+/g, ' ').trim();

// ===========================================================================
// A minimal XML-RPC codec, so this oracle can read what the Worker actually put
// on the wire and answer it in Odoo's own shapes.
// ===========================================================================

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const xesc = s => String(s).replace(/[&<>]/g, c => ESC[c]);

function encodeValue(v) {
  if (v === null || v === undefined) return '<value><boolean>0</boolean></value>';
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? `<value><int>${v}</int></value>`
      : `<value><double>${v}</double></value>`;
  }
  if (typeof v === 'string') return `<value><string>${xesc(v)}</string></value>`;
  if (Array.isArray(v)) {
    return `<value><array><data>${v.map(encodeValue).join('')}</data></array></value>`;
  }
  const members = Object.keys(v)
    .map(k => `<member><name>${xesc(k)}</name>${encodeValue(v[k])}</member>`).join('');
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
// The fake Odoo, SHAPED BY D18 so that the expectation cannot be read off the
// code: it holds both 'Transfer' lines and no 'Bank Transfer MVR', and it
// REFUSES a create whose vals break any of D18's live-schema rules.
// ===========================================================================

async function startFakeOdoo() {
  const state = {
    calls: [], expenses: new Map(), attachments: new Map(),
    seed: new Map(), nextId: 901, uid: 7
  };
  state.seed.set('account.payment.method.line', LIVE_LINES.map(l => ({ ...l })));

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
    throw new Error('the fake was asked for an operator this value does not declare: ' + op);
  });
  const project = (rows, fields) => rows.map(r => {
    const out = { id: r.id };
    for (const f of fields || Object.keys(r)) out[f] = r[f] === undefined ? false : r[f];
    return out;
  });

  /** D18's live schema, enforced as the real database would enforce it. */
  const refuseBadExpense = vals => {
    if (FORBIDDEN_FIELD in vals) {
      return `Invalid field '${FORBIDDEN_FIELD}' on model 'hr.expense': readonly and computed`;
    }
    if (!(CURRENCY_AMOUNT_FIELD in vals)) {
      return `${CURRENCY_AMOUNT_FIELD} is required on hr.expense`;
    }
    if (String(vals[CURRENCY_AMOUNT_FIELD]) !== String(vals[AMOUNT_FIELD])) {
      return `${CURRENCY_AMOUNT_FIELD} must equal ${AMOUNT_FIELD} in the company currency`;
    }
    const lines = state.seed.get('account.payment.method.line');
    if (!lines.some(l => l.id === vals.payment_method_line_id)) {
      return 'Invalid payment_method_line_id: ' + JSON.stringify(vals.payment_method_line_id);
    }
    return null;
  };

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

    if (method === 'create') {
      assert.ok(Array.isArray(args) && Array.isArray(args[0]),
        'create wraps its vals in the outer list Odoo demands, even for one record');
      const vals = args[0][0];
      if (model === 'hr.expense') {
        const refusal = refuseBadExpense(vals);
        if (refusal) { log.refused = refusal; return fault(res, 2, refusal); }
        const id = state.nextId++;
        state.expenses.set(id, { ...vals, id, state: 'draft' });
        log.createdId = id;
        return respond(res, id);
      }
      if (model === 'ir.attachment') {
        const id = state.nextId++;
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
    return fault(res, 2, 'forbidden method ' + method + ' on ' + model);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    state,
    objectCalls: () => state.calls.filter(c => c.path === '/xmlrpc/2/object'),
    expenseCreates: () => state.calls.filter(
      c => c.path === '/xmlrpc/2/object' && c.model === 'hr.expense' && c.rpc === 'create'),
    lineCalls: () => state.calls.filter(
      c => c.path === '/xmlrpc/2/object' && c.model === 'account.payment.method.line'),
    seed(model, rows) { state.seed.set(model, rows); },
    close: () => new Promise(r => server.close(r))
  };
}

// ===========================================================================
// config, and the real layer on a real workerd
// ===========================================================================

async function readConfig() {
  const cfg = JSON.parse(await fs.readFile(path.join(WORKER, 'wrangler.json'), 'utf8'));
  const vars = cfg.vars || {};

  // Obligation C's configuration link. The layer under test is started FROM this
  // very object, so the asserted configuration and the running Worker cannot
  // disagree.
  assert.equal(vars[LINE_ID_VAR], String(PAYMENT_LINE_ID),
    `${LINE_ID_VAR} is the live bank-transfer line id ${PAYMENT_LINE_ID}, as a string, `
    + 'because every Cloudflare var is text (D18)');
  assert.ok(!(OLD_LINE_NAME_VAR in vars),
    `${OLD_LINE_NAME_VAR} is gone: the live database holds two lines named 'Transfer' `
    + `and none named '${ABSENT_LINE_NAME}', so a name cannot name the line (D18)`);
  const configText = JSON.stringify(cfg);
  assert.ok(!configText.includes(ABSENT_LINE_NAME),
    `the guessed name '${ABSENT_LINE_NAME}' appears nowhere in the config`);

  // Unchanged by Vb.
  assert.deepEqual((cfg.triggers || {}).crons, [CRON],
    'the config still declares exactly the */15 cron driving port');
  assert.equal(vars.ODOO_URL, 'https://mrh-investment.odoo.com',
    'the Odoo endpoint still lives in config, not as a literal in code');
  assert.equal(vars.ODOO_DB, ODOO_DB);
  assert.equal(String(vars.ODOO_EMPLOYEE_ID), String(EMPLOYEE_ID),
    "D4's one employee id is still configuration");
  assert.ok(typeof cfg.main === 'string' && cfg.main.endsWith('.mjs'));
  assert.equal((cfg.d1_databases || []).length, 1);
  assert.ok(typeof cfg.d1_databases[0].migrations_dir === 'string');
  assert.ok(!('ODOO_API_KEY' in vars), 'ODOO_API_KEY is a Worker secret, never a var');
  assert.ok(!('ODOO_USERNAME' in vars), 'ODOO_USERNAME is a Worker secret, never a var');
  return cfg;
}

/**
 * The real Worker on a real workerd, over the given persisted store.
 * `lineId: null` means the var is ABSENT — the misconfiguration this value is
 * about; any other value is bound verbatim, exactly as a dashboard would.
 */
async function startLayer(cfg, { allowedOrigin, persist, odooUrl, lineId }) {
  const binding = cfg.d1_databases[0].binding;
  const vars = { ...(cfg.vars || {}) };
  delete vars[LINE_ID_VAR];
  delete vars[OLD_LINE_NAME_VAR];

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
      ...vars,
      ...(lineId === null ? {} : { [LINE_ID_VAR]: lineId }),
      ALLOWED_ORIGIN: allowedOrigin,
      EXPENSE_PIN: PIN,
      ODOO_URL: odooUrl,
      ODOO_DB: ODOO_DB,
      ODOO_USERNAME: ODOO_USER,
      ODOO_API_KEY: ODOO_KEY,
      ODOO_EMPLOYEE_ID: String(EMPLOYEE_ID)
    },
    host: '127.0.0.1',
    port: 0
  });
  const url = await mf.ready;
  const db = await mf.getD1Database(binding);
  const base = url.origin.replace(/\/$/, '');

  const call = async (method, pathname, { body } = {}) => {
    const headers = { 'CF-Connecting-IP': '127.0.0.1', Origin: allowedOrigin };
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
    return res.status;
  };

  return { mf, db, base, call, tick };
}

async function applySchema(db, cfg) {
  // Every migration, in file-name order, as `wrangler d1 migrations apply` runs them.
  const dir = path.join(WORKER, cfg.d1_databases[0].migrations_dir);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  const sql = (await Promise.all(files.map(f => fs.readFile(path.join(dir, f), 'utf8')))).join('\n');
  const statements = sql
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
  await db.batch(statements.map(s => db.prepare(s)));
}

async function row(db, id) {
  return db.prepare(
    'SELECT client_entry_id, status, odoo_id, attempts, next_retry_at, last_error,'
    + ' synced_at, amount_laari, entry_date FROM entry WHERE client_entry_id = ?')
    .bind(id).first();
}

/** 'Not sent' with a next try about 15 minutes out — D15's first step. */
function assertFirstRetryTime(entry, after) {
  assert.equal(entry.status, NOT_SENT);
  const at = Date.parse(entry.next_retry_at);
  assert.ok(Number.isFinite(at), 'next_retry_at is an ISO 8601 UTC instant');
  const minutes = (at - after) / 60000;
  assert.ok(Math.abs(minutes - BACKOFF_MINUTES[0]) < 2,
    `the next try is about ${BACKOFF_MINUTES[0]} minutes out, not ${minutes.toFixed(1)}`);
}

// ===========================================================================
// the page, served the way Pages serves it
// ===========================================================================

async function startStaticServer() {
  const html = await fs.readFile(path.join(REPO, 'index.html'));
  const server = http.createServer((req, res) => {
    const only = (req.url || '/').split('?')[0];
    if (only === '/' || only === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}

/** A feed document in the shape the live feed has, carrying TODAY. */
function feedWithToday(today) {
  return JSON.stringify({
    company: 'MRH Investment', currency: 'MVR',
    days: [{
      date: today, generatedAt: today + 'T03:01:23Z',
      confirmed: { total: 208.0, count: 5 },
      pending: { total: 0, count: 0 },
      categories: [{ name: 'Fuel / Petrol', count: 1, total: 50.0 }]
    }]
  });
}

async function waitFor(what, fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what} (last: ${last})`);
    await new Promise(r => setTimeout(r, 50));
  }
}

/**
 * Read the entries card the way a reader does: every block inside #e-entries
 * carrying exactly one of D12's chip words is one entry. The retry button is
 * read as the page's own markup, so a row that offers no Retry is visible as
 * such.
 */
function readEntries(page) {
  return page.evaluate(chipWords => {
    const card = document.getElementById('e-entries');
    if (!card) return [];
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const chipsIn = el => chipWords.filter(w => norm(el.textContent).includes(w)).length;
    const chipEls = Array.from(card.querySelectorAll('*')).filter(el =>
      chipWords.includes(norm(el.textContent)) &&
      !Array.from(el.children).some(c => chipWords.includes(norm(c.textContent))));
    return chipEls.map(chip => {
      let row = chip;
      while (row.parentElement && row.parentElement !== card
             && chipsIn(row.parentElement) === 1) {
        row = row.parentElement;
      }
      const btn = row.querySelector('button.retry');
      const bar = btn ? btn.closest('div') : null;
      return {
        chip: norm(chip.textContent),
        text: norm(row.textContent),
        hasRetry: !!btn,
        retryDisabled: btn ? btn.disabled : null,
        entryId: btn ? btn.getAttribute('data-entry') : null,
        barText: bar ? norm(bar.textContent) : null
      };
    });
  }, CHIPS);
}

const onlyRow = async page => {
  const rows = await readEntries(page);
  assert.equal(rows.length, 1, `exactly one row is shown, saw ${rows.length}`);
  return rows[0];
};

// ===========================================================================

test('retry_sends_the_configured_bank_transfer_line_id_with_both_mvr_amounts_and_the_row_shows_what_came_back',
  async t => {
    const TODAY = maldivesToday();
    const cfg = await readConfig();

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ike-vb-'));
    const store = path.join(root, 'main');
    const odoo = await startFakeOdoo();
    const { server, origin: pageOrigin } = await startStaticServer();
    const browser = await chromium.launch();
    const running = [];
    t.after(async () => {
      await browser.close();
      for (const mf of running) { try { await mf.dispose(); } catch { /* done */ } }
      await odoo.close();
      server.close();
      await fs.rm(root, { recursive: true, force: true });
    });

    const start = async opts => {
      const layer = await startLayer(cfg, {
        allowedOrigin: pageOrigin, odooUrl: odoo.url, ...opts
      });
      running.push(layer.mf);
      return layer;
    };

    /**
     * A browser context pointed at one layer. The feed is fulfilled; every
     * request to the layer goes over the real socket, except that a retry may be
     * aborted or held, which is how a failed press and an in-flight press are
     * made to happen.
     */
    const openPage = async base => {
      const seen = { urls: [], retries: [], crashes: [] };
      const control = { mode: 'pass', release: null };
      const context = await browser.newContext({
        viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 3
      });
      const page = await context.newPage();
      page.on('pageerror', e => seen.crashes.push(String(e)));
      await context.route('**/*', async route => {
        const url = route.request().url();
        seen.urls.push(url);
        if (url.startsWith(base)) {
          if (url.slice(base.length).includes('/retry')) {
            seen.retries.push({ url, method: route.request().method() });
            if (control.mode === 'abort') return route.abort('failed');
            if (control.mode === 'hold') {
              await new Promise(r => { control.release = r; });
            }
          }
          return route.continue();
        }
        if (url.startsWith(pageOrigin)) return route.continue();
        if (url.startsWith(EXPENSES_FEED)) {
          return route.fulfill({
            status: 200, contentType: 'application/json', body: feedWithToday(TODAY)
          });
        }
        if (url.startsWith(FEED_BASE)) {
          return route.fulfill({
            status: 200, contentType: 'application/json', body: '{"days":[],"records":[]}'
          });
        }
        return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
      });
      await page.goto(`${pageOrigin}/?api=${encodeURIComponent(base)}`, { waitUntil: 'load' });
      const expensesTab = page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' });
      await expensesTab.click();
      await waitFor('the Expenses tab to be selected',
        async () => await expensesTab.getAttribute('aria-selected') === 'true');
      return { context, page, seen, control };
    };

    /** The save, made the way a person makes it. Returns the chosen category. */
    const saveThroughTheSheet = async page => {
      await page.locator('#pane-expenses [aria-label="Add expense"]').click();
      const amount = page.getByLabel('Amount');
      const category = page.getByLabel('Category');
      const pin = page.getByLabel(/PIN/i);
      const post = page.getByRole('button', { name: 'Post expense' });
      await waitFor('the Add sheet to open', async () => await post.isVisible());
      const offered = await waitFor("the category list the layer serves", async () => {
        const labels = (await category.locator('option').allTextContents()).map(flat);
        return labels.length ? labels : null;
      });
      const chosen = offered.includes(HTTP_CATEGORY) ? HTTP_CATEGORY : offered[0];
      await amount.fill(AMOUNT_TYPED);
      await category.selectOption({ label: chosen });
      await pin.fill(PIN);
      await post.click();
      await waitFor("the sheet to close on the layer's 200",
        async () => !(await post.isVisible()));
      return chosen;
    };

    // =================================================================== §1
    // Obligation C, phase 1: the var is ABSENT. A real save, then one real cron
    // tick, and the entry is left 'Not sent' with the closed code — never a
    // crash, and never a wrong expense.
    const missing = await start({ persist: store, lineId: null });
    await applySchema(missing.db, cfg);

    const first = await openPage(missing.base);
    const chosen = await saveThroughTheSheet(first.page);
    // The product the chosen category resolves to by name exists, so the ONLY
    // thing standing between this entry and a draft expense is the line id.
    odoo.seed('product.product', [{ id: 77, name: chosen, can_be_expensed: true }]);

    const day0 = await missing.call('GET', `/expenses/entries?date=${TODAY}`);
    assert.equal(day0.res.status, 200);
    assert.equal(day0.json.entries.length, 1, 'the save stored exactly one entry');
    const ENTRY_ID = day0.json.entries[0].client_entry_id;
    assert.equal(day0.json.entries[0].amount_mvr, AMOUNT_TYPED);
    assert.equal(day0.json.entries[0].category, chosen);

    const tickAt = Date.now();
    assert.equal(await missing.tick(), 200,
      'a misconfigured line id does not crash the scheduled run: the cron port answers 200');

    const notSent = (await missing.call('GET', `/expenses/entries?date=${TODAY}`))
      .json.entries.find(e => e.client_entry_id === ENTRY_ID);
    assertFirstRetryTime(notSent, tickAt);
    assert.equal(notSent.amount_mvr, AMOUNT_TYPED, 'a failed send cannot alter a saved entry');
    assert.equal(notSent.category, chosen);

    const r0 = await row(missing.db, ENTRY_ID);
    assert.equal(r0.status, 'failed');
    assert.equal(r0.attempts, 1, 'exactly one attempt was made');
    assert.equal(r0.odoo_id, null, 'nothing in Odoo was adopted or created');
    assert.equal(r0.last_error, NO_LINE_CODE,
      'an absent line id joins the existing closed set, inventing no new code');
    assert.equal(r0.amount_laari, AMOUNT_LAARI);
    assert.equal(odoo.expenseCreates().length, 0,
      'ZERO hr.expense creates: a misconfigured line never becomes a wrong expense');

    // The page shows the person exactly that, with a Retry bar carrying the row's
    // own id — and the automatic next try is still named. The page re-reads the
    // day only on its own poll or on a return to it, so the person's next look
    // is a reload; the tick happened on the server, not in this page.
    await first.page.reload({ waitUntil: 'load' });
    await first.page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' }).click();
    await waitFor("the page's row to read 'Not sent'", async () => {
      const got = await readEntries(first.page);
      return got.length === 1 && got[0].chip === NOT_SENT ? got : null;
    });
    const shown = await onlyRow(first.page);
    assert.ok(shown.hasRetry, "a 'Not sent' row offers Retry");
    assert.equal(shown.entryId, ENTRY_ID,
      "the Retry button carries its OWN row's client_entry_id, not another row's");
    assert.equal(shown.retryDisabled, false, 'and it is pressable');
    assert.ok(shown.text.includes(chosen) && shown.text.includes(AMOUNT_TYPED),
      'the row still carries the category and amount the person saved');

    await first.context.close();

    // =================================================================== §2
    // Obligation C's totality: every non-positive, non-integer value behaves
    // exactly as an absent one, each over its own fresh store, and none crashes.
    // ' 2 ' is accepted, because a dashboard value may carry whitespace.
    let n = 0;
    for (const value of BAD_IDS.concat([PADDED_GOOD_ID])) {
      const bad = await start({ persist: path.join(root, 'bad-' + (n++)), lineId: value });
      await applySchema(bad.db, cfg);
      const id = 'ce-cfg-' + n;
      const saved = await bad.call('POST', '/expenses/entries', {
        body: { pin: PIN, category: chosen, amount: '31.00', client_entry_id: id }
      });
      assert.equal(saved.res.status, 200, `the save is unaffected by ${JSON.stringify(value)}`);
      const createsBefore = odoo.expenseCreates().length;
      const at = Date.now();
      assert.equal(await bad.tick(), 200,
        `${JSON.stringify(value)} never crashes the run`);
      const r = await row(bad.db, id);
      const listed = (await bad.call('GET', `/expenses/entries?date=${TODAY}`))
        .json.entries.find(e => e.client_entry_id === id);

      if (value === PADDED_GOOD_ID) {
        assert.equal(r.status, 'draft',
          `${JSON.stringify(value)} is the live id with whitespace, so the entry is sent`);
        assert.equal(listed.status, DRAFT);
        assert.equal(listed.next_retry_at, null);
        assert.equal(odoo.expenseCreates().length, createsBefore + 1);
      } else {
        assert.equal(r.status, 'failed', `${JSON.stringify(value)} is not a usable id`);
        assert.equal(r.last_error, NO_LINE_CODE,
          `${JSON.stringify(value)} fails with the one closed code`);
        assert.equal(r.odoo_id, null);
        assert.equal(r.attempts, 1);
        assertFirstRetryTime(listed, at);
        assert.equal(odoo.expenseCreates().length, createsBefore,
          `${JSON.stringify(value)} created no hr.expense at all`);
      }
      await bad.mf.dispose();
    }

    // =================================================================== §3
    // Obligation E: the owner's correction is CONFIGURATION, not code. The same
    // store, a second layer, the live id — and the persisted row still reads
    // 'Not sent' until a person presses Retry.
    await missing.mf.dispose();
    const fixed = await start({ persist: store, lineId: String(PAYMENT_LINE_ID) });
    const persisted = (await fixed.call('GET', `/expenses/entries?date=${TODAY}`))
      .json.entries.find(e => e.client_entry_id === ENTRY_ID);
    assert.equal(persisted.status, NOT_SENT,
      'configuring the id does not retro-send anything: the row is still Not sent');
    assert.ok(persisted.next_retry_at, 'and still carries its next try time');

    const { context, page, seen, control } = await openPage(fixed.base);
    await waitFor("the reopened page's row to read 'Not sent'", async () => {
      const got = await readEntries(page);
      return got.length === 1 && got[0].chip === NOT_SENT ? got : null;
    });

    const retryButton = page.locator('#e-entries button.retry');
    const beforePress = await onlyRow(page);
    assert.equal(beforePress.entryId, ENTRY_ID);

    // ---- (1) a press that cannot reach the service keeps the row and says one
    // ---- plain sentence, and the button becomes pressable again -------------
    control.mode = 'abort';
    await retryButton.click();
    const failed = await waitFor('the row to gain one plain sentence', async () => {
      const got = await onlyRow(page);
      return got.barText && got.barText.length > beforePress.barText.length
        && got.retryDisabled === false ? got : null;
    });
    assert.equal(failed.chip, NOT_SENT, 'a failed press leaves the row exactly as it was');
    assert.ok(failed.text.includes(chosen) && failed.text.includes(AMOUNT_TYPED),
      'with its category and its amount');
    assert.ok(failed.hasRetry, 'and its Retry bar');
    assert.equal(failed.retryDisabled, false, 'the button is pressable again');

    // The added words, and only they: plain English, no machinery.
    const note = flat(failed.barText.slice(beforePress.barText.length));
    assert.ok(/[A-Za-z]/.test(note) && note.length > 10,
      `the row gained a sentence of words, saw ${JSON.stringify(note)}`);
    assert.ok(!/\d/.test(note), `no status code reaches the row: ${JSON.stringify(note)}`);
    for (const forbidden of ['HTTP', 'undefined', 'not_found', 'not_read', 'faultString']) {
      assert.ok(!note.includes(forbidden),
        `the sentence never shows '${forbidden}': ${JSON.stringify(note)}`);
    }
    assert.ok(failed.barText.includes(persisted.next_retry_at),
      'the automatic next try is still named, because it is still true');
    assert.equal((await row(fixed.db, ENTRY_ID)).status, 'failed',
      'a press that never reached the service changed nothing in the store');

    // ---- (2) while the call is in flight the button is disabled and the chip
    // ---- has not moved ------------------------------------------------------
    const retriesBefore = seen.retries.length;
    control.mode = 'hold';
    await retryButton.click();
    const inFlight = await waitFor('the button to be disabled while the call runs',
      async () => {
        const got = await onlyRow(page);
        return got.retryDisabled === true ? got : null;
      });
    assert.equal(inFlight.chip, NOT_SENT,
      'nothing is guessed while the service is answering: the chip has not moved');
    assert.ok(seen.retries.length > retriesBefore, 'the press really reached the route');
    await waitFor('the held request', async () => control.release);
    control.release();

    // ---- (3) the row becomes the service's own answer: 'Draft', no Retry ----
    const sent = await waitFor("the row's chip to become 'Draft'", async () => {
      const got = await onlyRow(page);
      return got.chip === DRAFT ? got : null;
    });
    assert.equal(sent.hasRetry, false,
      'a sent row offers no Retry bar, because there is no next try');
    assert.ok(sent.text.includes(chosen) && sent.text.includes(AMOUNT_TYPED),
      'and it is still the same entry');
    const documentLoads = seen.urls.filter(u => u.split('?')[0] === `${pageOrigin}/`
      || u.split('?')[0] === `${pageOrigin}/index.html`).length;
    assert.equal(documentLoads, 1,
      'the row changed with NO page reload between the press and the observation: '
      + `the document was fetched ${documentLoads} times`);

    // ---- (4) the press addressed that row, under the /expenses/ prefix ------
    const expectedRetryUrl = `${fixed.base}/expenses/entries/${encodeURIComponent(ENTRY_ID)}/retry`;
    assert.ok(seen.retries.length >= 2, 'both presses were recorded');
    for (const r of seen.retries) {
      assert.equal(r.method, 'POST', 'Retry is a POST');
      assert.equal(r.url, expectedRetryUrl,
        'the press addresses THIS entry under the /expenses/ prefix');
    }

    // =================================================================== §4
    // Obligation B: what the press actually put on the wire.
    const creates = odoo.expenseCreates();
    // D21: the mark lives in Internal Notes (field `description`), never in the
    // name, so this entry's create is selected by its mark there.
    const mine = creates.filter(c => String(c.args[0][0].description).includes(ENTRY_ID));
    assert.equal(mine.length, 1, 'the press created exactly one hr.expense for this entry');
    const vals = mine[0].args[0][0];

    assert.equal(vals.payment_method_line_id, PAYMENT_LINE_ID,
      `the configured live bank-transfer line id ${PAYMENT_LINE_ID} is what crosses the wire`);
    assert.ok(Number.isInteger(vals.payment_method_line_id),
      'and it crosses as an integer id, not as text');
    assert.equal(vals[AMOUNT_FIELD], AMOUNT_TYPED,
      'the amount crosses as an exact decimal, not a binary float');
    assert.equal(vals[CURRENCY_AMOUNT_FIELD], AMOUNT_TYPED,
      `${CURRENCY_AMOUNT_FIELD} is sent and equals ${AMOUNT_FIELD} (D18)`);
    assert.ok(!(FORBIDDEN_FIELD in vals),
      `${FORBIDDEN_FIELD} is readonly and computed, so it is never sent (D18)`);
    assert.ok(!('state' in vals), 'no state is written: the record is born draft (D5)');
    assert.ok(!('currency_id' in vals),
      'no currency is sent: MVR is the company currency');
    assert.equal(vals.payment_mode, 'company_account', 'company-paid, not out of pocket (D11)');
    assert.equal(vals.employee_id, EMPLOYEE_ID, 'every expense is the one employee (D4)');
    assert.equal(vals.date, (await row(fixed.db, ENTRY_ID)).entry_date,
      "the expense is dated by the entry's stored UTC+5 day (D16)");

    const rFinal = await row(fixed.db, ENTRY_ID);
    assert.equal(rFinal.status, 'draft');
    assert.equal(rFinal.odoo_id, mine[0].createdId, 'the entry remembers its own expense');
    assert.equal(rFinal.next_retry_at, null);
    assert.equal(rFinal.last_error, null);
    assert.equal(rFinal.attempts, 2, 'the honest count: one cron attempt, one press');

    // The ambiguity clause. A name search would be the bug even if it happened
    // to hit, because the live database holds TWO lines named 'Transfer'.
    assert.equal(odoo.lineCalls().length, 0,
      'account.payment.method.line is never searched, in the whole run');
    const wire = JSON.stringify(odoo.state.calls);
    assert.ok(!wire.includes(ABSENT_LINE_NAME),
      `the guessed name '${ABSENT_LINE_NAME}' never crosses the wire`);
    assert.ok(!wire.includes(FORBIDDEN_FIELD),
      `${FORBIDDEN_FIELD} never crosses the wire`);
    const methods = new Set(odoo.state.calls.map(c => c.rpc || c.method));
    assert.deepEqual([...methods].sort(), ['authenticate', 'create', 'search_read'],
      'the complete set of Odoo methods — no write, no unlink, no action_* (D5)');
    for (const c of odoo.state.calls) {
      assert.match(c.path, /^\/xmlrpc\/2\/(common|object)$/);
    }

    assert.deepEqual(seen.crashes, [], `no script error: ${seen.crashes.join(' | ')}`);
    assert.equal(
      (await fixed.db.prepare('SELECT COUNT(*) AS n FROM entry').first()).n, 1,
      'across the whole chain, this store holds exactly the one entry the person saved');
    await context.close();
  });
