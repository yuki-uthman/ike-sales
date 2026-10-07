// Oracle for "V3 Pane on real data".
//
// Authority: docs/product/brief.md#Decisions (D2, D7, D9, D10, D11, D12, D13,
// D14, D16) and #Outcomes, read through the DESIGN section "V3 Pane on real
// data". The brief is cited, never opened by this file.
//
// Driving port: a real browser (Playwright/Chromium) at the design's phone
// viewport, loading the deployed artefact index.html over HTTP from a local
// static server, exactly as GitHub Pages serves it. Nothing is imported from the
// page; every fact below is read through the DOM a phone would get, or through
// the service's own HTTP contract.
//
// The service is NOT a stub: it is the real worker/src/index.mjs running on a
// real workerd (miniflare) over a real socket with a real D1, because the whole
// point of this observation is that the pane speaks to the actual V2 contract.
// Its ALLOWED_ORIGIN is bound to the page's own loopback origin — deployment
// configuration, not code; no byte of worker/ is read differently because of it.
//
// ike-data's expenses.json is answered by Playwright routing with a payload in
// the shape measured from the live feed, so the oracle does not depend on the
// live internet. The page learns the service's base URL the only way a loopback
// page may: the ?api= query parameter (on a non-loopback hostname that
// parameter must be ignored, which is checked here too).
//
// Every handle below is public: the pane id #pane-expenses and the e- prefixed
// ids already in index.html's markup, the FAB's aria-label "Add expense", the
// field labels "Amount" / "Category" / "Your PIN", the "Post expense" button,
// D12's chip words, and the service's own JSON members.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Miniflare } from 'miniflare';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The design screens are drawn at 390x844 — "on a phone".
const PHONE = { width: 390, height: 844 };

// The shared PIN exists only as a Worker secret (D14); the oracle chooses it for
// this instance and the page never holds it.
const PIN = '482913';
const WRONG_PIN = '000000';

const FEED_URL =
  'https://raw.githubusercontent.com/yuki-uthman/ike-data/main/data/expenses.json';

// The requests index.html may make: two font hosts, ike-data's three feeds, its
// own origin, and the service it was told about. Anything else is off limits.
const PRE_EXISTING = [
  'https://fonts.googleapis.com/',
  'https://fonts.gstatic.com/',
  'https://raw.githubusercontent.com/yuki-uthman/ike-data/main/data/sales.json',
  'https://raw.githubusercontent.com/yuki-uthman/ike-data/main/data/quotations.json',
  FEED_URL
];

const EMPTY_FEEDS = {
  'sales.json': '{"days":[]}',
  'quotations.json': '{"records":[],"days":[]}'
};

/** D16 / decision 21: the Maldives (UTC+5) date, the page's TODAY. */
function maldivesToday(at = Date.now()) {
  return new Date(at + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

// Two real days of the feed, copied verbatim from the live document, plus the
// same figures carried on TODAY so the figures region has something to render
// for the day the pane opens on.
const DAY_EMPTY = {
  date: '2026-09-13',
  generatedAt: '2026-09-14T10:54:15Z',
  confirmed: { total: 0, count: 0 },
  pending: { total: 0, count: 0 },
  categories: []
};
const DAY_FULL_CATEGORIES = [
  { name: 'Vehicle Maintenance', count: 1, total: 130.0 },
  { name: 'Fuel / Petrol', count: 1, total: 50.0 },
  { name: 'Expenses', count: 1, total: 18.0 },
  { name: 'Gate Pass (Boat Delivery)', count: 2, total: 10.0 }
];
const DAY_FULL = {
  date: '2026-09-14',
  generatedAt: '2026-09-14T18:45:43Z',
  confirmed: { total: 208.0, count: 5 },
  pending: { total: 100030.0, count: 5 },
  categories: DAY_FULL_CATEGORIES
};

function feedDocument(days) {
  return JSON.stringify({ company: 'MRH Investment', currency: 'MVR', days });
}

/** The feed as it ordinarily is: ascending, carrying TODAY last. */
function feedWithToday(today) {
  return feedDocument([
    DAY_EMPTY,
    DAY_FULL,
    { ...DAY_FULL, date: today, generatedAt: today + 'T03:01:23Z' }
  ]);
}

/** The ordinary daily state between Maldives midnight and the next rebuild. */
function feedWithoutToday() {
  return feedDocument([DAY_EMPTY, DAY_FULL]);
}

/**
 * Serves index.html as GitHub Pages does.
 *
 * `blankServiceMeta` exists for section 7 alone. That section's claim is "?api=
 * is ignored off loopback", and it reads that ignoring through the only words a
 * page with no service configured can say. Now that the shipped page carries the
 * deployed layer's address in its meta line, an off-loopback page would read
 * that address instead of saying nothing — so this server blanks that one
 * attribute for that one section, leaving the claim word for word. The shipped
 * bytes, meta included, are the new Vc oracle's business
 * (tests/odoo-layer-go-live.test.mjs). Sections 1-6 run on 127.0.0.1, where the
 * meta is never read, and are served verbatim.
 */
async function startStaticServer(host, { blankServiceMeta = false } = {}) {
  let html = await fs.readFile(path.join(REPO, 'index.html'));
  if (blankServiceMeta) {
    const before = html.toString('utf8');
    const after = before.replace(
      /(<meta name="ike-expenses-service" content=")[^"]*(">)/, '$1$2');
    assert.notEqual(after, before,
      'the shipped page carries the one meta line this section blanks');
    html = Buffer.from(after, 'utf8');
  }
  const server = http.createServer((req, res) => {
    if ((req.url || '/').split('?')[0] === '/' || req.url.startsWith('/index.html')) {
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
  const { port } = server.address();
  const authority = host.includes(':') ? `[${host}]` : host;
  return { server, origin: `http://${authority}:${port}` };
}

/** The real Worker on a real workerd, with the schema this repo declares. */
async function startService(allowedOrigin) {
  const wrangler = JSON.parse(
    await fs.readFile(path.join(REPO, 'worker/wrangler.json'), 'utf8'));
  const schema = await fs.readFile(
    path.join(REPO, 'worker/migrations/0001_init.sql'), 'utf8');

  const mf = new Miniflare({
    scriptPath: path.join(REPO, 'worker/src/index.mjs'),
    modules: true,
    modulesRoot: path.join(REPO, 'worker/src'),
    compatibilityDate: wrangler.compatibility_date,
    d1Databases: { DB: 'ike-sales-expenses-v3-oracle' },
    // ALLOWED_ORIGIN is deployment configuration: in production it is the Pages
    // host, here it is the page under test. EXPENSE_PIN is the Worker secret.
    bindings: { ALLOWED_ORIGIN: allowedOrigin, EXPENSE_PIN: PIN },
    host: '127.0.0.1',
    port: 0
  });
  const url = await mf.ready;

  const db = await mf.getD1Database('DB');
  for (const statement of schema.split(';')) {
    const sql = statement.replace(/^\s*--.*$/gm, '').trim();
    if (sql) await db.prepare(sql).run();
  }
  return { mf, origin: url.origin.replace(/\/$/, '') };
}

/** Ask the service directly, as the page's own origin, to compare against. */
async function service(serviceOrigin, pageOrigin, pathAndQuery, init = {}) {
  const res = await fetch(serviceOrigin + pathAndQuery, {
    ...init,
    headers: { Origin: pageOrigin, ...(init.headers || {}) }
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Open index.html, with every request accounted for. `api` is the service base
 * the page is told about through the loopback-only ?api= parameter; null means
 * "no service configured".
 */
async function openPage(browser, { pageOrigin, api, feed, colorScheme = 'light' }) {
  const offLimits = [];
  const requested = [];
  const context = await browser.newContext({
    viewport: PHONE, colorScheme, hasTouch: true, isMobile: true,
    deviceScaleFactor: 3
  });
  const page = await context.newPage();
  const crashes = [];
  page.on('pageerror', e => crashes.push(String(e)));

  await context.route('**/*', async route => {
    const url = route.request().url();
    requested.push(url);
    if (url.startsWith(pageOrigin)) return route.continue();
    // The service is real: its requests go over the socket, untouched.
    if (api && url.startsWith(api)) return route.continue();
    if (url.startsWith(FEED_URL)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: feed });
    }
    const other = Object.keys(EMPTY_FEEDS).find(f => url.split('?')[0].endsWith(f));
    if (other) {
      return route.fulfill({
        status: 200, contentType: 'application/json', body: EMPTY_FEEDS[other]
      });
    }
    if (!PRE_EXISTING.some(p => url.startsWith(p))) offLimits.push(url);
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });

  const target = api
    ? `${pageOrigin}/?api=${encodeURIComponent(api)}`
    : `${pageOrigin}/`;
  await page.goto(target, { waitUntil: 'load' });
  return { page, context, offLimits, requested, crashes };
}

async function waitFor(what, fn, timeout = 15000) {
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
 * that carries exactly one of D12's five chip words is one entry. No class of
 * the implementation is assumed.
 */
function readEntries(page, chips = CHIPS) {
  return page.evaluate(chipWords => {
    const card = document.getElementById('e-entries');
    if (!card) return [];
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const fieldText = el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const parts = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = norm(n.nodeValue);
        if (t) parts.push(t);
      }
      return norm(parts.join(' '));
    };
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
      return {
        chip: norm(chip.textContent),
        text: fieldText(row),
        hasRetryButton: Array.from(row.querySelectorAll('button'))
          .some(b => norm(b.textContent) === 'Retry')
      };
    });
  }, chips);
}

const flat = s => (s || '').replace(/\s+/g, ' ').trim();

async function regionText(page, id) {
  return flat(await page.locator('#' + id).innerText());
}

/** Open the pane and the Add sheet, and hand back its public handles. */
async function openSheet(page) {
  const expensesTab = page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' });
  await expensesTab.click();
  await waitFor('the Expenses tab to be selected',
    async () => await expensesTab.getAttribute('aria-selected') === 'true');
  await page.locator('#pane-expenses [aria-label="Add expense"]').click();
  const handles = {
    amount: page.getByLabel('Amount'),
    category: page.getByLabel('Category'),
    pin: page.getByLabel(/PIN/i),
    post: page.getByRole('button', { name: 'Post expense' }),
    note: page.locator('#e-note')
  };
  await waitFor('the Add sheet to open', async () => await handles.post.isVisible());
  return handles;
}

test('pane_saves_through_the_service_and_shows_only_confirmed_entries', async t => {
  const TODAY = maldivesToday();

  const { server, origin: pageOrigin } = await startStaticServer('127.0.0.1');
  const { mf, origin: serviceOrigin } = await startService(pageOrigin);
  const browser = await chromium.launch();

  // A port nothing listens on: an unreachable service, which is also how an
  // origin refusal looks to the page (decision 12).
  const dead = await startStaticServer('127.0.0.1');
  const deadOrigin = dead.origin;
  await new Promise(r => dead.server.close(r));

  t.after(async () => {
    await browser.close();
    await mf.dispose();
    server.close();
  });

  // ================= 1. The service is the only author of the entry list ======
  const { page, offLimits, requested, crashes } = await openPage(browser, {
    pageOrigin, api: serviceOrigin, feed: feedWithToday(TODAY)
  });

  const pane = page.locator('#pane-expenses');
  await page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' }).click();

  // The day's figures come from ike-data's feed, rendered as the feed gives them.
  await waitFor("the day's confirmed total to come from the feed",
    async () => flat(await page.locator('#e-heroTotal').innerText()) === '208');
  assert.match(await regionText(page, 'e-heroCount'), /\b5 entries\b/,
    "the hero's count is the feed day's confirmed.count");
  assert.equal(await regionText(page, 'e-pending'),
    'Pending MVR 100,030 · 5 entries not counted yet',
    'the pending line is the feed day\'s pending total and count, and nothing else');

  const catsText = await regionText(page, 'e-cats');
  assert.deepEqual(
    await page.locator('#e-cats .catname').allTextContents().then(x => x.map(flat)),
    DAY_FULL_CATEGORIES.map(c => c.name),
    'the category rows are the feed day\'s categories, in the order given, '
    + "including the generic 'Expenses' the read side must not hide");
  for (const c of DAY_FULL_CATEGORIES) {
    assert.ok(catsText.includes(String(c.total).replace(/\.0$/, '')),
      `the category row for ${c.name} carries its feed total`);
  }

  // The day pills are the feed's days, newest first, each addressable.
  assert.deepEqual(
    await page.locator('#e-pills [data-day]').evaluateAll(
      els => els.map(e => e.getAttribute('data-day'))),
    [TODAY, DAY_FULL.date, DAY_EMPTY.date],
    'every feed day is a selectable pill, newest first');

  // The entries card is the service's rows and nothing else: the store is empty.
  const emptyDay = await service(serviceOrigin, pageOrigin, `/expenses/entries?date=${TODAY}`);
  assert.equal(emptyDay.status, 200);
  assert.deepEqual(emptyDay.body.entries, [], 'the service holds nothing for today yet');
  assert.deepEqual(await readEntries(page), [],
    'the pane shows no entry when the service has none');

  // The sheet's select is the service's category list, in the service's order.
  const cats = await service(serviceOrigin, pageOrigin, '/expenses/categories');
  assert.equal(cats.status, 200);
  assert.equal(cats.body.categories.length, 21, 'D7: the service serves 21 categories');
  const sheet = await openSheet(page);
  assert.deepEqual(
    (await sheet.category.locator('option').allTextContents()).map(flat),
    cats.body.categories,
    'the select carries exactly the service\'s categories, in the service\'s order');

  // ================= 2. A wrong PIN keeps the typed entry in the sheet =======
  await sheet.amount.fill('137.50');
  await sheet.category.selectOption({ label: 'Fuel / Petrol' });
  await sheet.pin.fill(WRONG_PIN);
  await sheet.post.click();

  await waitFor('the wrong-PIN message',
    async () => flat(await sheet.note.innerText())
      === 'That PIN was not accepted. Check it and try again.');
  assert.ok(await sheet.post.isVisible(), 'the sheet stays open on a wrong PIN');
  assert.equal(await sheet.amount.inputValue(), '137.50', 'the typed amount is still there');
  assert.equal(await sheet.category.inputValue(), 'Fuel / Petrol',
    'the chosen category is still there');
  assert.deepEqual(await readEntries(page), [], 'a refused entry adds no row');
  assert.deepEqual(
    (await service(serviceOrigin, pageOrigin, `/expenses/entries?date=${TODAY}`)).body.entries, [],
    'and the service stored nothing');

  // ================= 3. The right PIN saves through the service =============
  await sheet.pin.fill(PIN);
  const started = Date.now();
  await sheet.post.click();
  await waitFor('the sheet to close on the service\'s 200',
    async () => !(await sheet.post.isVisible()));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 30000,
    `the save closes the sheet inside the 30-second budget (took ${elapsed} ms)`);

  const saved = await waitFor('the saved entry to appear in the day\'s list', async () => {
    const rows = await readEntries(page);
    return rows.length ? rows : null;
  });

  // What the service holds is what the page shows — member by member.
  const day = await service(serviceOrigin, pageOrigin, `/expenses/entries?date=${TODAY}`);
  assert.equal(day.body.entries.length, 1, 'the service stored exactly one entry');
  const entry = day.body.entries[0];
  assert.equal(entry.status, 'Waiting to send',
    "V2's only status word, and the chip the pane must show");
  assert.equal(saved.length, 1, 'the page shows exactly the one row the service holds');
  assert.equal(saved[0].chip, entry.status,
    'the chip is the service\'s own word for the entry');
  assert.ok(saved[0].text.includes(entry.category),
    'the row carries the category the service recorded');
  assert.ok(saved[0].text.includes(entry.amount_mvr)
    || saved[0].text.includes(entry.amount_mvr.replace(/\.00$/, '')),
    `the row carries the amount as the service formatted it (${entry.amount_mvr})`);
  assert.ok(!saved[0].hasRetryButton,
    'no row offers Retry in V3: the contract carries no next-retry time');
  assert.equal(entry.amount_mvr, '137.50', 'the amount reached the store as typed MVR');

  // The entry was posted as the contract declares, with a minted client entry id,
  // and the PIN is nowhere in the page afterwards.
  const posts = requested.filter(u => u.startsWith(serviceOrigin) && u.endsWith('/expenses/entries'));
  assert.ok(posts.length >= 1, 'the save went to the service');
  assert.match(entry.client_entry_id, /^[0-9a-f-]{36}$/,
    'the entry carries the id the page minted');
  const stored = await page.evaluate(() => ({
    local: Object.entries(localStorage).map(([k, v]) => k + '=' + v).join('|'),
    session: Object.entries(sessionStorage).map(([k, v]) => k + '=' + v).join('|')
  }));
  assert.ok(!stored.local.includes(PIN) && !stored.session.includes(PIN),
    'the PIN is never stored in the browser');

  // A reload can add nothing: the list is re-read from the service.
  await page.reload({ waitUntil: 'load' });
  await page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' }).click();
  const afterReload = await waitFor('the list after a reload', async () => {
    const rows = await readEntries(page);
    return rows.length ? rows : null;
  });
  assert.equal(afterReload.length, 1,
    'a reload shows the one entry the service holds, not one the page remembered');

  assert.deepEqual(offLimits, [],
    `the page contacted nothing beyond its feeds and its service: ${offLimits.join(', ')}`);
  assert.deepEqual(crashes, [], `no script error: ${crashes.join(' | ')}`);

  // ================= 4. The two regions fail independently ==================
  // The feed has no record for TODAY yet (the ordinary state between Maldives
  // midnight and the next rebuild): the figures say so, and the entries card,
  // which reads the service, keeps showing the day's row.
  const noFeedDay = await openPage(browser, {
    pageOrigin, api: serviceOrigin, feed: feedWithoutToday()
  });
  await noFeedDay.page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' }).click();
  await waitFor('the figures to name the missing day', async () => {
    const text = flat(await noFeedDay.page.locator('#pane-expenses').innerText());
    return text.includes("Could not load the day's totals")
      && text.includes(TODAY)
      && text.includes('Try refreshing in a minute.');
  });
  const stillListed = await readEntries(noFeedDay.page);
  assert.equal(stillListed.length, 1,
    'a feed without the day does not blank the service-backed entries card');
  assert.ok(await noFeedDay.page.locator('#pane-expenses [aria-label="Add expense"]').isVisible(),
    'the pane is never replaced by a message: the FAB stays reachable');
  assert.deepEqual(noFeedDay.crashes, [], noFeedDay.crashes.join(' | '));

  // ================= 5. An unreachable service =============================
  const down = await openPage(browser, {
    pageOrigin, api: deadOrigin, feed: feedWithToday(TODAY)
  });
  await down.page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' }).click();
  await waitFor('the entries card to say it could not load', async () => {
    const text = await regionText(down.page, 'e-entries');
    return text.includes("Could not load today's entries")
      && text.includes('Nothing is shown as saved.');
  });
  assert.deepEqual(await readEntries(down.page), [],
    'an unreadable list shows no row at all');
  assert.equal(flat(await down.page.locator('#e-heroTotal').innerText()), '208',
    'the figures region is unaffected by the service being down');

  // The Add sheet when the category list is not readable: the select stays the
  // service's list and nothing else, so there is nothing to choose and the sheet
  // refuses to pretend otherwise. Post is asserted disabled, never clicked — a
  // real click on a disabled button is not delivered at all.
  const downSheet = await openSheet(down.page);
  await waitFor('the failed-categories note', async () =>
    flat(await downSheet.note.innerText())
      === 'Could not load the categories (service unreachable). Try again in a minute.');
  assert.deepEqual(
    await downSheet.category.locator('option').allTextContents(), [],
    'no copy of the 21 names lives in the page: with no readable list there is '
    + 'no option to choose');
  assert.equal(await downSheet.post.isDisabled(), true,
    'Post is disabled, so an entry whose category the service never offered '
    + 'cannot be sent');

  // Typed fields are never cleared or rewritten by that rendering.
  await downSheet.amount.fill('80');
  await downSheet.pin.fill(PIN);
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(await downSheet.amount.inputValue(), '80', 'the typed amount is kept');
  assert.equal(await downSheet.pin.inputValue(), PIN, 'and so is the typed PIN');
  assert.equal(await downSheet.post.isDisabled(), true, 'Post is still disabled');
  assert.ok(await down.page.locator('#pane-expenses [aria-label="Add expense"]').isVisible(),
    'the FAB and the sheet stay reachable while the service is down');
  assert.equal(flat(await down.page.locator('#e-heroTotal').innerText()), '208',
    'and the figures region kept reading the feed');
  assert.deepEqual(await readEntries(down.page), [],
    'nothing the service did not confirm is ever shown as saved');
  assert.deepEqual(
    down.requested.filter(u => u.startsWith(deadOrigin) && u.includes('/expenses/entries')
      && !u.includes('?date=')), [],
    'the page issued no POST at all to a service it could not read');
  assert.deepEqual(down.crashes, [], down.crashes.join(' | '));

  // ========== 5c. A category list re-read while the sheet is open ===========
  // Opening the sheet re-reads /expenses/categories, so a service that comes back fills
  // the select with no reload. That answer can land AFTER the person has chosen
  // (the open-sheet re-read, the 5-minute refresh, a return to the tab). The
  // choice must survive it: "keeps the typed entry in the sheet" covers the
  // category as much as the amount. The re-read is held at the network edge
  // until the choice is made, so the order is fixed, not raced.
  const third = await startService(pageOrigin);
  const held = await openPage(browser, {
    pageOrigin, api: third.origin, feed: feedWithToday(TODAY)
  });
  t.after(async () => {
    await held.context.close().catch(() => {});
    await third.mf.dispose().catch(() => {});
  });
  await waitFor('the first category read to fill the select', async () =>
    (await held.page.getByLabel('Category').locator('option').count()) === 21);
  let release;
  const gate = new Promise(r => { release = r; });
  let heldReads = 0;
  await held.page.route(third.origin + '/expenses/categories', async route => {
    heldReads++;
    await gate;
    await route.continue();
  });
  const heldSheet = await openSheet(held.page);
  await waitFor('the open-sheet re-read to be in flight', async () => heldReads >= 1);
  await heldSheet.amount.fill('80');
  await heldSheet.category.selectOption({ label: 'Meals' });
  await heldSheet.pin.fill(PIN);
  const reread = held.page.waitForResponse(r => r.url().startsWith(third.origin + '/expenses/categories'));
  release();
  await reread;
  await held.page.evaluate(() => new Promise(r => setTimeout(r, 500)));
  assert.equal(await heldSheet.category.locator('option').count(), 21,
    'the re-read list is the service\'s 21 names');
  assert.equal(await heldSheet.category.inputValue(), 'Meals',
    'a category list that arrives after the choice keeps the chosen category');
  assert.equal(await heldSheet.amount.inputValue(), '80', 'and the typed amount');
  assert.equal(await heldSheet.post.isDisabled(), false, 'and Post stays enabled');
  assert.deepEqual(held.crashes, [], held.crashes.join(' | '));

  // ========== 5b. The service dies AFTER the select loaded ==================
  // This is the stimulus V3's observation names with "an unreachable service
  // keeps the typed entry in the sheet with a plain message": a SECOND real
  // workerd fills the select with the service's own 21 names, then its socket
  // really dies, and only then is Post pressed.
  const second = await startService(pageOrigin);
  const dying = await openPage(browser, {
    pageOrigin, api: second.origin, feed: feedWithToday(TODAY)
  });
  await dying.page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' }).click();
  const dyingSheet = await openSheet(dying.page);
  await waitFor('the select to fill from the live second service', async () =>
    (await dyingSheet.category.locator('option').count()) === 21);
  assert.equal(await dyingSheet.post.isDisabled(), false,
    'with the list read, Post is enabled');
  await dyingSheet.amount.fill('80');
  await dyingSheet.category.selectOption({ label: 'Meals' });
  await dyingSheet.pin.fill(PIN);

  await second.mf.dispose();          // the socket really dies

  await dyingSheet.post.click();
  await waitFor('the unreachable message',
    async () => flat(await dyingSheet.note.innerText())
      === 'Could not reach the expenses service. Your entry is still here — try again.');
  assert.ok(await dyingSheet.post.isVisible(), 'the sheet stays open');
  assert.equal(await dyingSheet.amount.inputValue(), '80', 'the typed entry is still there');
  assert.equal(await dyingSheet.category.inputValue(), 'Meals',
    'including the chosen category');
  assert.equal(await dyingSheet.pin.inputValue(), PIN, 'including the PIN');
  assert.deepEqual(await readEntries(dying.page), [],
    'no row is appended on any non-200 path');
  assert.deepEqual(dying.crashes, [], dying.crashes.join(' | '));

  // The real service still holds exactly the one entry: nothing leaked to it.
  assert.equal(
    (await service(serviceOrigin, pageOrigin, `/expenses/entries?date=${TODAY}`)).body.entries.length,
    1, 'the failed post created nothing anywhere');

  // ================= 6. No service configured ==============================
  const unset = await openPage(browser, {
    pageOrigin, api: null, feed: feedWithToday(TODAY)
  });
  await unset.page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' }).click();
  await waitFor('the honest not-set-up state',
    async () => (await regionText(unset.page, 'e-entries'))
      === 'The expenses service is not set up yet.');
  assert.deepEqual(
    unset.requested.filter(u => u.startsWith(serviceOrigin)), [],
    'with no service configured the page makes no service call at all');
  assert.equal(flat(await unset.page.locator('#e-heroTotal').innerText()), '208',
    "the day's figures still come from the feed");

  // The sheet says the same honest thing, with nothing to choose and Post
  // disabled — asserted, never clicked.
  const unsetSheet = await openSheet(unset.page);
  await waitFor('the not-set-up note in the sheet',
    async () => flat(await unsetSheet.note.innerText())
      === 'The expenses service is not set up yet.');
  assert.deepEqual(
    await unsetSheet.category.locator('option').allTextContents(), [],
    'an unconfigured service offers no category');
  assert.equal(await unsetSheet.post.isDisabled(), true, 'and Post is disabled');
  await unsetSheet.amount.fill('999');
  await unsetSheet.pin.fill(PIN);
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(await unsetSheet.amount.inputValue(), '999', 'the typed amount is kept');
  assert.equal(await unsetSheet.pin.inputValue(), PIN, 'and the typed PIN is kept');
  assert.deepEqual(
    unset.requested.filter(u => u.startsWith(serviceOrigin)), [],
    'and still not one service call was made');
  assert.deepEqual(unset.offLimits, [], unset.offLimits.join(', '));
  assert.deepEqual(unset.crashes, [], unset.crashes.join(' | '));

  // ================= 7. ?api= is loopback-only =============================
  // A crafted https://…/?api=<attacker> link must not redirect a typed PIN, so
  // on any hostname other than 127.0.0.1 / localhost the parameter is ignored.
  const v6 = await startStaticServer('::1', { blankServiceMeta: true });
  try {
    const crafted = await openPage(browser, {
      pageOrigin: v6.origin, api: serviceOrigin, feed: feedWithToday(TODAY)
    });
    await crafted.page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' }).click();
    await waitFor('a non-loopback page to ignore ?api= entirely',
      async () => (await regionText(crafted.page, 'e-entries'))
        === 'The expenses service is not set up yet.');

    const craftedSheet = await openSheet(crafted.page);
    await waitFor('the not-set-up note on the crafted page',
      async () => flat(await craftedSheet.note.innerText())
        === 'The expenses service is not set up yet.');
    await craftedSheet.amount.fill('999');
    await craftedSheet.pin.fill(PIN);
    // Structural denial: the typed PIN cannot even be offered to the crafted
    // origin, because Post is disabled. Asserted, never clicked.
    assert.deepEqual(
      await craftedSheet.category.locator('option').allTextContents(), [],
      'the crafted origin never filled the select');
    assert.equal(await craftedSheet.post.isDisabled(), true,
      'Post is disabled, so the crafted link is denied the PIN structurally too');
    await new Promise(r => setTimeout(r, 1000));
    assert.deepEqual(
      crafted.requested.filter(u => u.startsWith(serviceOrigin)), [],
      'a crafted ?api= link on a non-loopback host never receives the typed PIN');
    assert.deepEqual(crafted.crashes, [], crafted.crashes.join(' | '));
  } finally {
    v6.server.close();
  }

  // ================= 8. Nothing reached the service it should not have =====
  const finalDay = await service(serviceOrigin, pageOrigin, `/expenses/entries?date=${TODAY}`);
  assert.equal(finalDay.body.entries.length, 1,
    'across every path, exactly the one confirmed entry exists');
});
