// Oracle for "Vc Live with the owner: the deployed address the shipped page
// carries".
//
// Authority: docs/product/brief.md#Decisions (D17, D18, with D10, D12, D13, D14
// unchanged) read through the DESIGN section "Vc Live with the owner: the
// deployed address the shipped page carries". The brief is cited, never opened
// by this file.
//
// WHAT THIS FILE JUDGES, AND WHAT IT DOES NOT.
// Vc's value is mostly the owner's own acts on live systems: the deploy, the two
// secrets, the Odoo read access for the layer's key, the 30-second entry from a
// phone, the accountant's sighting, the 'Approved' chip within one schedule
// interval and the PIN change. None of those change a repository byte, and this
// oracle does not pretend to witness them: they stay Vc's human-observed part.
// What IS in the repository is the configuration this slice ships:
//   * worker/wrangler.json — the minted D1 id and migrations_dir where
//     wrangler's own schema wants it;
//   * index.html — the one declarative line that carries the deployed address.
// This file judges exactly those two, through public ports only.
//
// Driving ports, both real:
//   * the browser (Playwright/Chromium) at the design's phone viewport, loading
//     the SHIPPED index.html — meta line included, byte for byte — over HTTP
//     from a local static server, which is how GitHub Pages serves it;
//   * at deploy only, wrangler itself: the real pinned CLI, run `--dry-run` on a
//     COPY of worker/ outside this worktree, with an empty XDG_CONFIG_HOME and
//     metrics off, so no login state is readable and no Cloudflare call is
//     possible. The copy is the cwd because the run writes a .wrangler/
//     directory there. wrangler is deliberately NOT added to package.json.
//
// The deployed host is never reached over the network. Every request the page
// makes to https://odoo.ike-mrh.workers.dev is intercepted in the browser
// context and answered from the real worker/src/index.mjs running on a real
// workerd (miniflare) over its own socket, with ALLOWED_ORIGIN bound to the
// page's origin and EXPENSE_PIN chosen here — deployment configuration only,
// exactly as the committed V3 harness already does. An unintercepted call to the
// live host, or ANY call to the crafted ?api= origin, fails the test.
//
// Nothing is imported from worker/src or from the page. The expected address is
// derived, not copied from the page: '<wrangler name>.<the account's workers.dev
// subdomain>.workers.dev', with the name read from wrangler.json and the
// measured subdomain written out from the DESIGN section.
//
// SUPPORTS NARROWED BY THIS SLICE. migrations_dir now lives inside
// d1_databases[0], where wrangler's own schema wants it, so every support that
// reads it reads it from there. Va's oracle (tests/odoo-layer-expenses-paths
// .test.mjs) and Vb's oracle (tests/odoo-live-schema-retry.test.mjs) each carry
// the matching "Narrowed at Vc: migrations_dir is read from d1_databases[0] ..."
// header note recording that narrowing; no assertion of theirs changed, and the
// retired top-level read is not restored anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Miniflare } from 'miniflare';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(REPO, 'worker');

// D17: the layer is named 'odoo', its database 'ike-odoo', and it answers under
// one area prefix.
const LAYER_NAME = 'odoo';
const DATABASE_NAME = 'ike-odoo';
const AREA = '/expenses';
const CATEGORIES = AREA + '/categories';
const ENTRIES = AREA + '/entries';
const CRON = ['*/15 * * * *'];

// D9: the deployed page's origin lives in config, never in code.
const EXPECTED_ALLOWED_ORIGIN = 'https://yuki-uthman.github.io';

// The account's workers.dev subdomain, measured at deploy and recorded in the
// DESIGN section. D17 defers the final URL to deploy, so this is where it is
// written down — and the address below is composed from it, never copied from
// the page the oracle judges.
const WORKERS_DEV_SUBDOMAIN = 'ike-mrh';
const LIVE_BASE = `https://${LAYER_NAME}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;

// The pinned real CLI. Not a dependency of the product: the craft targets are
// worker/wrangler.json and index.html.
const WRANGLER = 'wrangler@4.148.0';

// A crafted ?api= target. It must receive nothing at all; the hostname is
// deliberately unresolvable so that a leak cannot quietly succeed either.
const CRAFTED_BASE = 'https://crafted-attacker.invalid';

// The shared PIN exists only as a Worker secret (D14).
const PIN = '482913';

// The design screens are drawn at 390x844 — "on a phone".
const PHONE = { width: 390, height: 844 };

const FEED_BASE = 'https://raw.githubusercontent.com/yuki-uthman/ike-data/main/data/';
const EXPENSES_FEED = FEED_BASE + 'expenses.json';
const FONTS = ['https://fonts.googleapis.com/', 'https://fonts.gstatic.com/'];

/** D16: the Maldives (UTC+5) date, the page's TODAY. */
const maldivesToday = (at = Date.now()) =>
  new Date(at + 5 * 3600 * 1000).toISOString().slice(0, 10);

const flat = s => (s || '').replace(/\s+/g, ' ').trim();

// =========================================================================
// the config, and the real tool's verdict on it
// =========================================================================

const readConfig = async () =>
  JSON.parse(await fs.readFile(path.join(WORKER, 'wrangler.json'), 'utf8'));

function run(file, args, options) {
  return new Promise(resolve => {
    execFile(file, args, options, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

/**
 * Copy worker/ to a fresh directory under the OS temp dir and ask the real
 * wrangler to prepare a deploy from it without contacting Cloudflare. The copy
 * is the cwd (the run writes .wrangler/ there), the account is unreadable, and
 * the only fact taken from the run is "this config is one wrangler accepts
 * cleanly": exit 0, with no 'Unexpected fields' complaint.
 */
async function wranglerDryRun(root) {
  const copy = path.join(root, 'worker');
  const outdir = path.join(root, 'out');
  const emptyConfigHome = path.join(root, 'xdg');
  await fs.cp(WORKER, copy, { recursive: true });
  await fs.mkdir(emptyConfigHome, { recursive: true });

  return run('npx', ['--yes', WRANGLER, 'deploy', '--dry-run', '--outdir', outdir], {
    cwd: copy,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: emptyConfigHome,
      WRANGLER_SEND_METRICS: 'false',
      CI: '1'
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180000
  });
}

// =========================================================================
// the page, served the way Pages serves it — shipped bytes, nothing rewritten
// =========================================================================

async function startStaticServer(host) {
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
    server.listen(0, host, resolve);
  });
  const authority = host.includes(':') ? `[${host}]` : host;
  return { server, origin: `http://${authority}:${server.address().port}` };
}

/** A feed document in the shape the live feed has, carrying TODAY. */
const feedWithToday = today => JSON.stringify({
  company: 'MRH Investment', currency: 'MVR',
  days: [{
    date: today, generatedAt: today + 'T03:01:23Z',
    confirmed: { total: 208.0, count: 5 },
    pending: { total: 0, count: 0 },
    categories: [{ name: 'Fuel / Petrol', count: 1, total: 50.0 }]
  }]
});

// =========================================================================
// the real layer, on a real workerd
// =========================================================================

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
      // Vc moves an address; it sends nothing to Odoo. ODOO_URL is bound to a
      // closed loopback port so no call in this file can reach the live Odoo.
      ODOO_URL: 'http://127.0.0.1:1'
    },
    host: '127.0.0.1',
    port: 0
  });
  const url = await mf.ready;
  const base = url.origin.replace(/\/$/, '');
  const db = await mf.getD1Database(binding);

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
  // Every migration, in file-name order, as `wrangler d1 migrations apply` runs them.
  const dir = path.join(WORKER, cfg.d1_databases[0].migrations_dir);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  const sql = (await Promise.all(files.map(f => fs.readFile(path.join(dir, f), 'utf8')))).join('\n');
  const statements = sql
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
  await db.batch(statements.map(s => db.prepare(s)));
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

const CHIPS = ['Waiting to send', 'Not sent', 'Draft', 'Approved', 'Refused'];

/**
 * Read the entries card the way a reader does: every block inside #e-entries
 * carrying exactly one of D12's chip words is one entry.
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
      return { chip: norm(chip.textContent), text: norm(row.textContent) };
    });
  }, CHIPS);
}

// =========================================================================

test('the_shipped_page_off_loopback_calls_only_the_deployed_ike_odoo_layer_and_wrangler_accepts_its_config',
  async t => {
    const TODAY = maldivesToday();
    const cfg = await readConfig();

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ike-vc-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

    // =================================================================== §1
    // The config the owner deploys is one wrangler accepts cleanly, and the
    // facts the deployed address is derived from are the shipped config's own.
    assert.equal(cfg.name, LAYER_NAME,
      "the deployed Worker is the Odoo layer: wrangler.json names it 'odoo' (D17)");
    assert.equal((cfg.d1_databases || []).length, 1,
      'the one driven store is a single D1 binding');
    assert.equal(cfg.d1_databases[0].database_name, DATABASE_NAME,
      "the layer's database is named 'ike-odoo' (D17)");
    assert.deepEqual((cfg.triggers || {}).crons, CRON,
      "the config still declares exactly D13's */15 cron trigger");
    assert.equal((cfg.vars || {}).ALLOWED_ORIGIN, EXPECTED_ALLOWED_ORIGIN,
      'ALLOWED_ORIGIN still lives in config, not as a literal in code (D9)');
    assert.equal(String((cfg.vars || {}).ODOO_PAYMENT_METHOD_LINE_ID), '2',
      "D18's bank-transfer payment method line id is still configuration");

    // The id is now Cloudflare's, not a placeholder: judged by SHAPE — a minted
    // 36-character UUID that is not the database's name — so this assertion is
    // not a copy of the bytes it judges.
    const id = cfg.d1_databases[0].database_id;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'database_id is a Cloudflare-minted UUID, filled in at deploy');
    assert.notEqual(id, DATABASE_NAME,
      'the minted id is no longer the placeholder that repeated the database name');

    // migrations_dir belongs to the database, which is where wrangler's own
    // schema puts it — the claim §1 proves with the real tool below.
    assert.equal(cfg.d1_databases[0].migrations_dir, 'migrations',
      'the D1 binding declares its migrations_dir, so deploy and every oracle '
      + 'read one schema');
    assert.ok(!('migrations_dir' in cfg),
      'and no top-level migrations_dir is left behind');

    const dry = await wranglerDryRun(root);
    const output = dry.stdout + dry.stderr;
    assert.equal(dry.code, 0,
      `the real wrangler prepares a deploy from this config: ${output}`);
    assert.ok(!/Unexpected fields/.test(output),
      `wrangler reports no unexpected field in the config: ${output}`);
    assert.ok(output.includes(`env.${cfg.d1_databases[0].binding} (${DATABASE_NAME})`),
      `the prepared deploy still binds ${cfg.d1_databases[0].binding} to `
      + `${DATABASE_NAME}: ${output}`);
    for (const name of Object.keys(cfg.vars || {})) {
      assert.ok(output.includes(name),
        `the prepared deploy still carries the var ${name}: ${output}`);
    }

    // The deployed address is derived from the shipped name and the account's
    // measured subdomain — this is the address §2 demands the page carry.
    assert.equal(LIVE_BASE, `https://${cfg.name}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`,
      "the deployed address is '<wrangler name>.<the account's subdomain>.workers.dev'");

    // =================================================================== §2
    // The shipped page, off loopback, in a real browser: it calls the deployed
    // layer and nothing else — and the crafted ?api= link gets nothing.
    const { server, origin: pageOrigin } = await startStaticServer('::1');
    const layer = await startLayer(cfg, {
      allowedOrigin: pageOrigin, persist: path.join(root, 'd1')
    });
    await applySchema(layer.db, cfg);
    const browser = await chromium.launch();
    t.after(async () => {
      await browser.close();
      await layer.mf.dispose();
      server.close();
    });

    // One entry already recorded by the layer, placed through the layer's own
    // public HTTP contract, so the day has a row to render.
    const seeded = await layer.call('POST', ENTRIES, {
      body: {
        pin: PIN, category: 'Fuel / Petrol', amount: '137.50',
        client_entry_id: 'vc-seed-1'
      }
    });
    assert.equal(seeded.res.status, 200, 'the layer accepted the seeded entry');
    assert.equal(seeded.json.saved, true);

    const requested = [];
    const unintercepted = [];
    const crashes = [];
    const context = await browser.newContext({
      viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 3
    });
    const page = await context.newPage();
    page.on('pageerror', e => crashes.push(String(e)));
    page.on('requestfailed', r => { requested.push(r.url()); });

    await context.route('**/*', async route => {
      const url = route.request().url();
      requested.push(url);
      if (url.startsWith(pageOrigin)) return route.continue();

      // The deployed host is answered by the real Worker over its own socket,
      // never by the network.
      if (url.startsWith(LIVE_BASE)) {
        const request = route.request();
        const answer = await layer.call(
          request.method(), url.slice(LIVE_BASE.length),
          { origin: pageOrigin, body: undefined });
        return route.fulfill({
          status: answer.res.status,
          headers: Object.fromEntries(
            [...answer.res.headers].filter(([k]) => k !== 'content-encoding')),
          body: answer.text
        });
      }

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
      if (FONTS.some(f => url.startsWith(f))) {
        return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
      }

      // Anything else — the crafted origin above all — is recorded as a leak and
      // answered with nothing.
      unintercepted.push(url);
      return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    });

    // The crafted link an attacker would send: a non-loopback page with ?api=.
    await page.goto(
      `${pageOrigin}/?api=${encodeURIComponent(CRAFTED_BASE)}`, { waitUntil: 'load' });

    const expensesTab = page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' });
    await expensesTab.click();
    await waitFor('the Expenses tab to be selected',
      async () => await expensesTab.getAttribute('aria-selected') === 'true');

    // The day's row is the deployed layer's own row, read over the live address.
    const rows = await waitFor("the deployed layer's row in the day's list", async () => {
      const got = await readEntries(page);
      return got.length ? got : null;
    });
    const day = await layer.call('GET', `${ENTRIES}?date=${TODAY}`);
    assert.equal(day.res.status, 200);
    assert.equal(day.json.entries.length, 1, 'the layer holds exactly the seeded entry');
    const entry = day.json.entries[0];
    assert.equal(rows.length, 1, 'the page shows exactly the one row the layer holds');
    assert.equal(rows[0].chip, entry.status,
      "the chip is the layer's own word for the entry");
    assert.ok(rows[0].text.includes(entry.category),
      'the row carries the category the layer recorded');
    assert.ok(rows[0].text.includes(entry.amount_mvr)
      || rows[0].text.includes(entry.amount_mvr.replace(/\.00$/, '')),
      `the row carries the amount as the layer formatted it (${entry.amount_mvr})`);

    // The sheet's select is the deployed layer's category list: the page is
    // configured, so it says nothing about not being set up.
    await page.locator('#pane-expenses [aria-label="Add expense"]').click();
    const post = page.getByRole('button', { name: 'Post expense' });
    await waitFor('the Add sheet to open', async () => await post.isVisible());
    const offered = await waitFor('the category list the deployed layer serves', async () => {
      const labels = (await page.getByLabel('Category').locator('option').allTextContents())
        .map(flat);
      return labels.length ? labels : null;
    });
    const cats = await layer.call('GET', CATEGORIES);
    assert.deepEqual(offered, cats.json.categories,
      "the select carries exactly the deployed layer's categories, in its order");
    assert.equal(offered.length, 21, "D7's 21 expensable categories, served by the layer");
    assert.equal(await post.isDisabled(), false,
      'a configured page offers Post, so the owner can record an expense');
    assert.ok(!flat(await page.locator('#e-note').innerText())
      .includes('not set up yet'),
      'the shipped page no longer says the service is not set up');

    // =================================================================== §3
    // Where every request went. This is the guarantee the trade bought.
    const toLive = requested.filter(u => u.startsWith(LIVE_BASE));
    for (const url of [
      LIVE_BASE + CATEGORIES,
      `${LIVE_BASE}${ENTRIES}?date=${TODAY}`
    ]) {
      assert.ok(toLive.includes(url), `the shipped page asked the deployed layer for ${url}`);
    }
    const unprefixed = toLive.filter(u => !u.slice(LIVE_BASE.length).startsWith(AREA + '/'));
    assert.deepEqual(unprefixed, [],
      'every request to the layer is under /expenses/: ' + unprefixed.join(', '));
    assert.deepEqual(requested.filter(u => u.startsWith(CRAFTED_BASE)), [],
      'the crafted ?api= origin off loopback receives nothing at all');
    assert.deepEqual(unintercepted, [],
      'no request escaped to an address this oracle does not account for: '
      + unintercepted.join(', '));
    assert.deepEqual(crashes, [], `no script error: ${crashes.join(' | ')}`);
  });
