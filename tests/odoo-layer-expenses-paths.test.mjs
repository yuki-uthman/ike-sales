// Oracle for "Va Odoo layer naming and /expenses/ paths".
//
// Authority: docs/product/brief.md#Decisions D17 (with D3, D9, D10, D12, D13
// unchanged) and Observations Va -> DESIGN "Va Odoo layer naming and the
// expenses paths". The brief is cited, never opened by this file.
//
// Driving ports, both real:
//   * HTTP — the actual worker/src/index.mjs on a real workerd (miniflare) over
//     a real loopback socket, started FROM worker/wrangler.json, with the schema
//     SSOT worker/migrations/0001_init.sql applied through the declared D1
//     binding. Spoken to with plain `fetch`.
//   * a real browser (Playwright/Chromium) at the phone viewport, loading the
//     deployed artefact index.html over HTTP from a local static server, which
//     is how GitHub Pages serves it.
//
// Nothing is imported from worker/src or from the page, and no expected path is
// read out of either: every path literal below is written out from D17.
//
// Supports: the four integrated V2–V5 oracles moved to the /expenses/ paths.
// Two of them (worker-odoo-sync, worker-status-readback) were later narrowed by
// Vb to D18's configured bank-transfer line id; that narrowing touches no path,
// so nothing below depends on it.
//
// ALLOWED_ORIGIN is bound to the page's own loopback origin — deployment
// configuration, exactly as the committed V3 harness does — while the NAME of
// the configured origin is still asserted from wrangler.json, the config SSOT.
//
// Narrowed at Vc: migrations_dir is read from d1_databases[0], where wrangler's
// own schema places it (wrangler 4.148.0 rejects the top-level key). Only the
// read location moved; no claim was added or retired.

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

// D17: the layer is named 'odoo' and its database 'ike-odoo'.
const LAYER_NAME = 'odoo';
const DATABASE_NAME = 'ike-odoo';

// D17: the area prefix, and the four addresses the Worker answers under it.
const AREA = '/expenses';
const ENTRIES = AREA + '/entries';
const CATEGORIES = AREA + '/categories';
const retryPath = id => AREA + '/entries/' + id + '/retry';

// The addresses the Worker answered before Va, and answers no longer.
const OLD_PATHS = ['/entries', '/categories'];

// D9: the deployed page's origin, which lives in config and never in code.
const EXPECTED_ALLOWED_ORIGIN = 'https://yuki-uthman.github.io';
const CRON = ['*/15 * * * *'];

// The shared PIN exists only as a Worker secret (D14).
const PIN = '482913';

// The design screens are drawn at 390x844 — "on a phone".
const PHONE = { width: 390, height: 844 };

const FEED_BASE = 'https://raw.githubusercontent.com/yuki-uthman/ike-data/main/data/';
const EXPENSES_FEED = FEED_BASE + 'expenses.json';

/** D16: the Maldives (UTC+5) date, the page's TODAY. */
const maldivesToday = (at = Date.now()) =>
  new Date(at + 5 * 3600 * 1000).toISOString().slice(0, 10);

const flat = s => (s || '').replace(/\s+/g, ' ').trim();

// =========================================================================
// Obligation B: the naming link. The layer under test is started from this
// very file, so the asserted names and the running layer cannot disagree.
// =========================================================================

async function readConfig() {
  const cfg = JSON.parse(await fs.readFile(path.join(WORKER, 'wrangler.json'), 'utf8'));

  assert.equal(cfg.name, LAYER_NAME,
    "the Worker is the Odoo layer: wrangler.json names it 'odoo' (D17)");
  assert.equal((cfg.d1_databases || []).length, 1,
    'the one driven store is a single D1 binding');
  assert.equal(cfg.d1_databases[0].database_name, DATABASE_NAME,
    "the layer's database is named 'ike-odoo' (D17)");
  assert.ok(typeof cfg.d1_databases[0].database_id === 'string'
    && cfg.d1_databases[0].database_id.trim() !== '',
    'a database_id is declared; Cloudflare mints its real value at deploy, so only '
    + 'its shape is this value\'s business');

  // Unchanged by Va — the config facts V2 already declared.
  assert.ok(typeof cfg.main === 'string' && cfg.main.endsWith('.mjs'),
    'wrangler.json still declares an .mjs module entrypoint');
  assert.match(cfg.compatibility_date || '', /^\d{4}-\d{2}-\d{2}$/,
    'wrangler.json still declares a compatibility date');
  assert.ok(typeof cfg.d1_databases[0].migrations_dir === 'string',
    'wrangler.json still declares migrations_dir, so deploy and this oracle read one schema');
  assert.equal((cfg.vars || {}).ALLOWED_ORIGIN, EXPECTED_ALLOWED_ORIGIN,
    'ALLOWED_ORIGIN still lives in config, not as a literal in code (D9)');
  assert.deepEqual((cfg.triggers || {}).crons, CRON,
    'the config still declares exactly the */15 cron trigger (D13)');
  return cfg;
}

/** The real Worker on a real workerd, over its own fresh persisted store. */
async function startLayer(cfg, { allowedOrigin, persist }) {
  const binding = cfg.d1_databases[0].binding;
  const mf = new Miniflare({
    scriptPath: path.join(WORKER, cfg.main),
    modules: true,
    modulesRoot: WORKER,
    compatibilityDate: cfg.compatibility_date,
    compatibilityFlags: cfg.compatibility_flags || [],
    d1Databases: { [binding]: cfg.d1_databases[0].database_id },
    d1Persist: persist,
    bindings: {
      ...(cfg.vars || {}),
      ALLOWED_ORIGIN: allowedOrigin,
      EXPENSE_PIN: PIN,
      // Va moves addresses; it sends nothing to Odoo. ODOO_URL is bound to a
      // closed loopback port so that no call in this file can reach
      // mrh-investment.odoo.com, whatever a route decides to attempt.
      ODOO_URL: 'http://127.0.0.1:1'
    },
    host: '127.0.0.1',
    port: 0
  });
  const url = await mf.ready;
  const db = await mf.getD1Database(binding);
  const base = url.origin.replace(/\/$/, '');

  const call = async (method, pathname, { origin = allowedOrigin, body } = {}) => {
    const headers = { 'CF-Connecting-IP': '127.0.0.1' };
    if (origin !== null) headers.Origin = origin;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + pathname, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
    return { res, text, json };
  };

  return { mf, db, base, call };
}

async function applySchema(db, cfg) {
  const sql = await fs.readFile(
    path.join(WORKER, cfg.d1_databases[0].migrations_dir, '0001_init.sql'), 'utf8');
  const statements = sql
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
  await db.batch(statements.map(s => db.prepare(s)));
}

const entryCount = async db =>
  (await db.prepare('SELECT COUNT(*) AS n FROM entry').first()).n;

// =========================================================================
// the page, served the way Pages serves it
// =========================================================================

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
 * carrying exactly one of D12's chip words is one entry.
 */
const CHIPS = ['Waiting to send', 'Not sent', 'Draft', 'Approved', 'Refused'];

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
      return { chip: norm(chip.textContent), text: norm(row.textContent) };
    });
  }, CHIPS);
}

// =========================================================================

test('odoo_layer_answers_expenses_only_under_the_expenses_prefix', async t => {
  const TODAY = maldivesToday();
  const cfg = await readConfig();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ike-va-'));
  const { server, origin: pageOrigin } = await startStaticServer();
  const layer = await startLayer(cfg, {
    allowedOrigin: pageOrigin, persist: path.join(root, 'main')
  });
  await applySchema(layer.db, cfg);
  const browser = await chromium.launch();

  t.after(async () => {
    await browser.close();
    await layer.mf.dispose();
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = layer.base;

  // ===================================================================== §1
  // Obligation D: a person makes the save, through the moved path, in a real
  // browser — and obligation C records every URL the page asks for.
  const requested = [];
  const crashes = [];
  const context = await browser.newContext({
    viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 3
  });
  const page = await context.newPage();
  page.on('pageerror', e => crashes.push(String(e)));

  await context.route('**/*', async route => {
    const url = route.request().url();
    requested.push(url);
    if (url.startsWith(pageOrigin)) return route.continue();
    // The layer is real: its requests go over the socket, untouched.
    if (url.startsWith(base)) return route.continue();
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

  await page.locator('#pane-expenses [aria-label="Add expense"]').click();
  const amount = page.getByLabel('Amount');
  const category = page.getByLabel('Category');
  const pin = page.getByLabel(/PIN/i);
  const post = page.getByRole('button', { name: 'Post expense' });
  await waitFor('the Add sheet to open', async () => await post.isVisible());

  // The select is the layer's own list, read over the moved path; the person
  // chooses one of the names it offers.
  const offered = await waitFor('the category list the layer serves', async () => {
    const labels = (await category.locator('option').allTextContents()).map(flat);
    return labels.length ? labels : null;
  });
  const chosen = offered[0];

  await amount.fill('137.50');
  await category.selectOption({ label: chosen });
  await pin.fill(PIN);
  await post.click();

  await waitFor("the sheet to close on the layer's 200",
    async () => !(await post.isVisible()));

  const rows = await waitFor("the saved entry in the day's list", async () => {
    const got = await readEntries(page);
    return got.length ? got : null;
  });

  // What the layer recorded is what the day's list shows.
  const day = await layer.call('GET', `${ENTRIES}?date=${TODAY}`);
  assert.equal(day.res.status, 200, 'the day list is served under the moved path');
  assert.equal(day.json.date, TODAY);
  assert.equal(day.json.entries.length, 1, 'the layer recorded exactly one entry');
  const entry = day.json.entries[0];
  assert.equal(entry.status, 'Waiting to send',
    "the save is still save-first: D12's waiting word, unchanged by the move");
  assert.equal(entry.amount_mvr, '137.50', 'the amount reached the store as typed MVR');
  assert.equal(entry.category, chosen, 'and the category the person chose');

  assert.equal(rows.length, 1, 'the page shows exactly the one row the layer holds');
  assert.equal(rows[0].chip, 'Waiting to send',
    "the row carries the chip 'Waiting to send'");
  assert.ok(rows[0].text.includes(entry.category),
    'the row carries the category the layer recorded');
  assert.ok(rows[0].text.includes(entry.amount_mvr)
    || rows[0].text.includes(entry.amount_mvr.replace(/\.00$/, '')),
    `the row carries the amount as the layer formatted it (${entry.amount_mvr})`);

  assert.equal(await entryCount(layer.db), 1,
    'exactly one row in the store, read back through the declared binding');
  assert.deepEqual(crashes, [], `no script error: ${crashes.join(' | ')}`);

  // ===================================================================== §2
  // Obligation C: the page calls only the /expenses/ paths — both halves.
  const toLayer = requested.filter(u => u.startsWith(base));
  for (const url of [
    `${base}${ENTRIES}?date=${TODAY}`,
    base + CATEGORIES,
    base + ENTRIES
  ]) {
    assert.ok(toLayer.includes(url), `the page asked for ${url}`);
  }
  const unprefixed = toLayer.filter(u => !u.slice(base.length).startsWith(AREA + '/'));
  assert.deepEqual(unprefixed, [],
    'every request the page makes to the layer is under /expenses/: '
    + unprefixed.join(', '));

  await context.close();

  // ===================================================================== §3
  // Obligation E: the old addresses are gone, and are refused the way this
  // Worker already refuses an address it does not serve.
  const gone = [
    ['POST', '/entries'],
    ['GET', '/entries'],
    ['GET', `/entries?date=${TODAY}`],
    ['GET', '/categories'],
    ['POST', `/entries/${entry.client_entry_id}/retry`]
  ];
  for (const [method, pathname] of gone) {
    const answer = await layer.call(method, pathname, method === 'POST'
      ? { body: { pin: PIN, category: chosen, amount: '9.00', client_entry_id: 'ce-old' } }
      : {});
    assert.equal(answer.res.status, 404,
      `${method} ${pathname} is no longer answered`);
    assert.deepEqual(answer.json, { saved: false, error: 'not_found' },
      `${method} ${pathname} joins the Worker's existing not_found refusal, inventing nothing`);
    assert.equal(answer.res.headers.get('access-control-allow-origin'), pageOrigin,
      `${method} ${pathname} carries Access-Control-Allow-Origin like every non-origin answer`);
    assert.match(answer.res.headers.get('vary') || '', /Origin/i,
      `${method} ${pathname} carries Vary: Origin`);
  }
  assert.equal(await entryCount(layer.db), 1,
    'the POST to an old path stored no row: there is no silent dual-mount');

  // ===================================================================== §4
  // The two things Va promises not to move. OPTIONS still answers 204 on any
  // path, including one no prefix claims.
  for (const pathname of [ENTRIES, '/nowhere/at/all']) {
    const pre = await layer.call('OPTIONS', pathname);
    assert.equal(pre.res.status, 204, `OPTIONS ${pathname} is still 204`);
    assert.equal(pre.text, '', `OPTIONS ${pathname} has an empty body`);
    assert.equal(pre.res.headers.get('access-control-allow-origin'), pageOrigin);
    assert.equal(pre.res.headers.get('access-control-allow-headers'), 'content-type');
    assert.equal(pre.res.headers.get('access-control-allow-methods'), 'POST, GET, OPTIONS');
    assert.match(pre.res.headers.get('vary') || '', /Origin/i);
  }

  // And the origin check still applies on every path — prefixed, old and
  // unknown alike, OPTIONS included — so an unknown path never discloses which
  // prefix exists.
  for (const pathname of [ENTRIES, CATEGORIES, ...OLD_PATHS, '/nowhere/at/all']) {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      for (const origin of ['https://evil.example', null]) {
        const refused = await layer.call(method, pathname, { origin });
        assert.equal(refused.res.status, 403,
          `${method} ${pathname} from ${origin || 'no origin'} is refused before anything else`);
        assert.deepEqual(refused.json, { saved: false, error: 'origin_not_allowed' },
          `${method} ${pathname} names the origin refusal`);
        assert.equal(refused.res.headers.get('access-control-allow-origin'), null,
          'the origin refusal is still the one answer carrying no Access-Control-Allow-Origin');
      }
    }
  }

  // ===================================================================== §5
  // The fourth moved address, reached as the page's Retry bar would reach it.
  // What the retry MAKES OF the entry is V4's value, not Va's; all this value
  // asks is that the route is reachable under the prefix and still answers
  // about the entry named in it, and that an unknown id is the same not_found
  // refusal as before.
  const retried = await layer.call('POST', retryPath(entry.client_entry_id));
  assert.equal(retried.res.status, 200, 'the retry route is served under /expenses/');
  assert.equal(retried.json.entry.client_entry_id, entry.client_entry_id,
    'and it answers about the entry the save stored');
  const unknownRetry = await layer.call('POST', retryPath('ce-nope'));
  assert.equal(unknownRetry.res.status, 404);
  assert.deepEqual(unknownRetry.json, { saved: false, error: 'not_found' });

  assert.equal(await entryCount(layer.db), 1,
    'across every path in this oracle, exactly the one saved entry exists');
});
