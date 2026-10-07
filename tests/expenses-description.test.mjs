// Oracle for "V1 Description saved".
//
// Authority: docs/product/brief.md#Decisions (D2, D8, D9, D10, D14, D16, D19)
// and #Observations "V1 Description saved", read through the DESIGN section
// "V1 Description saved". The brief is cited, never opened by this file.
//
// Driving port: a real browser (Playwright/Chromium) at the design's phone
// viewport, loading the deployed artefact index.html over HTTP from a local
// static server, exactly as GitHub Pages serves it, talking to the real
// worker/src/index.mjs on a real workerd (miniflare) over a real socket with a
// real D1. Nothing under worker/ is imported here, and nothing is read out of
// the page: every fact below comes through the DOM a phone would get, through
// the service's own HTTP contract, or out of the declared driven port (the D1
// binding), which is read back directly because D19's description is
// deliberately NOT part of the entry projection.
//
// The schema is the one this repo declares: every file in worker/migrations
// applied in file-name order, as `wrangler d1 migrations apply` runs them. The
// store is migrated IN PLACE here — 0001 first, a row saved under it, then the
// rest — because the production D1 has already applied 0001 and the column must
// arrive for it the same way.
//
// Every handle below is public: the pane id #pane-expenses and the e- prefixed
// ids already in index.html's markup, the FAB's aria-label "Add expense", the
// field labels "Amount" / "Description (optional)" / "Category" / "Receipt" /
// "Your PIN", the "Post expense" button, and the service's own JSON members and
// error codes. No id, class or wording is invented here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Miniflare } from 'miniflare';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(REPO, 'worker/migrations');

// The design screens are drawn at 390x844 — "on a phone".
const PHONE = { width: 390, height: 844 };

// The shared PIN exists only as a Worker secret (D14); the oracle chooses it for
// this instance and the page never holds it.
const PIN = '482913';
const WRONG_PIN = '000000';

// D19's limit, counted in Unicode code points after normalisation.
const LIMIT_CHARS = 200;

// The seven members an entry has — exactly these, and never a description
// (the day's list does not show it).
const ENTRY_MEMBERS = [
  'amount_mvr', 'category', 'client_entry_id', 'next_retry_at',
  'receipt_bytes', 'receipt_present', 'status'
];

// The sheet's fields, in the order D19 asks for: the description right after the
// amount and before the category.
const SHEET_FIELDS = ['Amount', 'Description', 'Category', 'Receipt', 'Your PIN'];

// What the page says when the Worker refuses an over-long description.
const TOO_LONG_MESSAGE =
  'Keep the description to 200 characters or fewer. Nothing was saved.';

// The description typed in the sheet, and what D19 says must be stored for it.
const TYPED = '  Boat   trip to Male  ';
const NORMALISED = 'Boat trip to Male';

const FEED_URL =
  'https://raw.githubusercontent.com/yuki-uthman/ike-data/main/data/expenses.json';

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

/** D16: the Maldives (UTC+5) date, the day the pane opens on. */
function maldivesToday(at = Date.now()) {
  return new Date(at + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** A day of ike-data's feed, in the shape measured from the live document. */
function feedWithToday(today) {
  return JSON.stringify({
    company: 'MRH Investment',
    currency: 'MVR',
    days: [{
      date: today,
      generatedAt: today + 'T03:01:23Z',
      confirmed: { total: 208.0, count: 5 },
      pending: { total: 100030.0, count: 5 },
      categories: [{ name: 'Fuel / Petrol', count: 1, total: 50.0 }]
    }]
  });
}

/** Serves index.html as GitHub Pages does. */
async function startStaticServer(host) {
  const html = await fs.readFile(path.join(REPO, 'index.html'));
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
  return { server, origin: `http://${host}:${server.address().port}` };
}

async function migrationNames() {
  return (await fs.readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort();
}

/** Apply the named migrations, in the order given, statement by statement. */
async function applyMigrations(db, names) {
  for (const name of names) {
    const sql = await fs.readFile(path.join(MIGRATIONS, name), 'utf8');
    for (const statement of sql.split(';')) {
      const one = statement.replace(/^\s*--.*$/gm, '').trim();
      if (one) await db.prepare(one).run();
    }
  }
}

/**
 * The real Worker on a real workerd, with an empty D1 the caller migrates
 * itself. ALLOWED_ORIGIN is deployment configuration: in production it is the
 * Pages host, here it is the page under test. EXPENSE_PIN is the Worker secret.
 */
async function startService(allowedOrigin, dbName) {
  const wrangler = JSON.parse(
    await fs.readFile(path.join(REPO, 'worker/wrangler.json'), 'utf8'));
  const mf = new Miniflare({
    scriptPath: path.join(REPO, 'worker/src/index.mjs'),
    modules: true,
    modulesRoot: path.join(REPO, 'worker/src'),
    compatibilityDate: wrangler.compatibility_date,
    d1Databases: { DB: dbName },
    bindings: { ALLOWED_ORIGIN: allowedOrigin, EXPENSE_PIN: PIN },
    host: '127.0.0.1',
    port: 0
  });
  const url = await mf.ready;
  return { mf, origin: url.origin.replace(/\/$/, ''), db: await mf.getD1Database('DB') };
}

/** Ask the service directly, as the page's own origin would. */
async function service(serviceOrigin, pageOrigin, pathAndQuery, init = {}) {
  const res = await fetch(serviceOrigin + pathAndQuery, {
    ...init,
    headers: { Origin: pageOrigin, ...(init.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch { /* asserted by the caller */ }
  return { status: res.status, body, headers: res.headers };
}

/** POST one entry body directly, each from its own source address. */
let sources = 0;
function post(serviceOrigin, pageOrigin, body) {
  sources += 1;
  return service(serviceOrigin, pageOrigin, '/expenses/entries', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': `198.51.100.${sources}`
    },
    body: JSON.stringify(body)
  });
}

/** Open index.html, with every request accounted for and every POST recorded. */
async function openPage(browser, { pageOrigin, api, feed }) {
  const offLimits = [];
  const crashes = [];
  const sent = [];
  const answers = [];
  const context = await browser.newContext({
    viewport: PHONE, colorScheme: 'light', hasTouch: true, isMobile: true,
    deviceScaleFactor: 3
  });
  const page = await context.newPage();
  page.on('pageerror', e => crashes.push(String(e)));

  const isSave = r =>
    r.request().method() === 'POST' && r.url() === api + '/expenses/entries';
  page.on('request', r => {
    if (r.method() === 'POST' && r.url() === api + '/expenses/entries') {
      let body = null;
      try { body = JSON.parse(r.postData() || 'null'); } catch { /* asserted */ }
      sent.push(body);
    }
  });
  page.on('response', async r => {
    if (!isSave(r)) return;
    let body = null;
    try { body = await r.json(); } catch { /* asserted by the caller */ }
    answers.push({ status: r.status(), body });
  });

  await context.route('**/*', async route => {
    const url = route.request().url();
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

  await page.goto(`${pageOrigin}/?api=${encodeURIComponent(api)}`, { waitUntil: 'load' });
  return { page, context, offLimits, crashes, sent, answers };
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

const flat = s => (s || '').replace(/\s+/g, ' ').trim();

/** Open the pane and the Add sheet, and hand back its public handles. */
async function openSheet(page) {
  const tab = page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' });
  await tab.click();
  await waitFor('the Expenses tab to be selected',
    async () => await tab.getAttribute('aria-selected') === 'true');
  await page.locator('#pane-expenses [aria-label="Add expense"]').click();
  const handles = {
    amount: page.getByLabel('Amount'),
    description: page.getByLabel(/Description/i),
    category: page.getByLabel('Category'),
    pin: page.getByLabel(/PIN/i),
    post: page.getByRole('button', { name: 'Post expense' }),
    note: page.locator('#e-note')
  };
  await waitFor('the Add sheet to open', async () => await handles.post.isVisible());
  await waitFor('the category list to arrive from the service',
    async () => (await handles.category.locator('option').count()) === 21);
  return handles;
}

/** The description this store holds for one entry, read off the driven port. */
async function storedDescription(db, clientEntryId) {
  const row = await db
    .prepare('SELECT description FROM entry WHERE client_entry_id = ?')
    .bind(clientEntryId).first();
  return row ? row.description : null;
}

async function rowCount(db, clientEntryId) {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM entry WHERE client_entry_id = ?')
    .bind(clientEntryId).first();
  return Number(row.n);
}

test('description_is_saved_with_the_entry', async t => {
  const TODAY = maldivesToday();

  const { server, origin: pageOrigin } = await startStaticServer('127.0.0.1');
  const { mf, origin: serviceOrigin, db } =
    await startService(pageOrigin, 'ike-sales-expenses-description-oracle');
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await mf.dispose();
    server.close();
  });

  // ===== 1. The column arrives through a NEW migration, over a live 0001 store =
  const names = await migrationNames();
  assert.ok(names.length >= 2,
    'the column arrives through a migration file beyond 0001, never by editing it');
  assert.equal(names[0], '0001_init.sql', '0001 is still the first migration');
  assert.ok(!(await fs.readFile(path.join(MIGRATIONS, names[0]), 'utf8')).includes('description'),
    'the already-applied 0001_init.sql is untouched: it names no description');

  // The production store as it stands today: 0001 applied, entries already in it.
  await applyMigrations(db, [names[0]]);
  await db.prepare(
    'INSERT INTO entry'
    + ' (client_entry_id, amount_laari, category, receipt, status, entry_date, saved_at)'
    + " VALUES ('ce-legacy', 5000, 'Water', NULL, 'waiting', '2026-09-13',"
    + " '2026-09-13T04:00:00.000Z')").run();

  // ...and the rest of the migrations reaching it, as `wrangler d1 migrations
  // apply` would: the row saved before the column reads as "no description".
  await applyMigrations(db, names.slice(1));
  assert.equal(await storedDescription(db, 'ce-legacy'), '',
    'a row saved before the migration reads as no description, not as null');

  // ===== 2. The field is on the sheet, right after the amount, and starts empty =
  const { page, offLimits, crashes, sent, answers } =
    await openPage(browser, { pageOrigin, api: serviceOrigin, feed: feedWithToday(TODAY) });
  const sheet = await openSheet(page);

  assert.equal(await sheet.description.count(), 1,
    "the Add sheet carries exactly one field labelled 'Description (optional)'");
  assert.match(
    flat(await sheet.description.evaluate(
      el => (el.labels && el.labels[0] ? el.labels[0].textContent : ''))),
    /^Description \(optional\)$/,
    "the field is labelled 'Description (optional)': typing one is never required");

  // The order a reader sees, and the order the fields are reached in.
  const sheetText = flat(await page.locator('#e-sheet').innerText());
  // The amount's label is styled uppercase and innerText applies text-transform,
  // so a reader's order is compared without regard to case.
  const positions = SHEET_FIELDS.map(
    word => sheetText.toLowerCase().indexOf(word.toLowerCase()));
  for (const [i, at] of positions.entries()) {
    assert.ok(at >= 0, `the sheet names '${SHEET_FIELDS[i]}'`);
    if (i > 0) {
      assert.ok(at > positions[i - 1],
        `the sheet's fields run ${SHEET_FIELDS.join(', ')}: `
        + `'${SHEET_FIELDS[i]}' comes after '${SHEET_FIELDS[i - 1]}'`);
    }
  }
  const order = await page.evaluate(() => {
    // The sheet's typed fields, in document order; the receipt's two file inputs
    // are the Receipt field's pickers, not fields of their own.
    const controls = Array.from(
      document.querySelectorAll('#e-sheet input, #e-sheet select, #e-sheet textarea'))
      .filter(el => el.type !== 'file' && el.getAttribute('aria-hidden') !== 'true');
    return controls.map(el => {
      const label = el.labels && el.labels[0];
      return (label ? label.textContent : '').replace(/\s+/g, ' ').trim();
    });
  });
  assert.deepEqual(order,
    ['Amount', 'Description (optional)', 'Category', 'Your PIN'],
    'the description is the field directly after the amount and directly before '
    + 'the category; nothing was inserted between them');

  assert.equal(await sheet.description.inputValue(), '',
    'the sheet clears the description when it opens');

  // Closing and reopening clears it again, so yesterday's words are never posted.
  await sheet.description.fill('left over');
  await page.keyboard.press('Escape');
  await waitFor('the sheet to close', async () => !(await sheet.post.isVisible()));
  const reopened = await openSheet(page);
  assert.equal(await reopened.description.inputValue(), '',
    'reopening the sheet clears the description again');

  // ===== 3. A described entry is saved, and the store holds it normalised ======
  await reopened.amount.fill('137.50');
  await reopened.description.fill(TYPED);
  await reopened.category.selectOption({ label: 'Fuel / Petrol' });
  await reopened.pin.fill(PIN);
  await reopened.post.click();
  await waitFor('the sheet to close on the service\'s 200',
    async () => !(await reopened.post.isVisible()));

  assert.equal(sent.length, 1, 'the save was posted once');
  assert.equal(sent[0].description, TYPED,
    'the page posts the description exactly as typed; the Worker normalises it');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].status, 200);
  assert.equal(answers[0].body.saved, true, 'the described entry is saved');
  const savedId = answers[0].body.entry.client_entry_id;
  assert.deepEqual(Object.keys(answers[0].body.entry).sort(), ENTRY_MEMBERS,
    'the saved entry still carries exactly its seven members: the description is '
    + 'not projected');
  assert.equal(answers[0].body.entry.amount_mvr, '137.50',
    'the amount reached the store as typed MVR, as before');

  assert.equal(await storedDescription(db, savedId), NORMALISED,
    "the store holds the description trimmed, with every whitespace run collapsed "
    + `to one space ('${NORMALISED}')`);

  // It is kept with the entry, not shown in the day's list.
  await waitFor('the saved entry to appear in the day\'s list',
    async () => flat(await page.locator('#e-entries').innerText()).includes('Fuel / Petrol'));
  assert.ok(!flat(await page.locator('#pane-expenses').innerText()).includes('Boat'),
    "the description is not shown in the day's entry list (out of scope)");

  // ===== 4. An over-long description is refused, and nothing is saved ==========
  const long = 'x'.repeat(LIMIT_CHARS + 1);
  const second = await openSheet(page);
  await second.amount.fill('42');
  await second.description.fill(long);
  await second.category.selectOption({ label: 'Water' });
  await second.pin.fill(PIN);
  const before = Number(
    (await db.prepare('SELECT COUNT(*) AS n FROM entry').first()).n);
  await second.post.click();

  await waitFor('the plain over-long message',
    async () => flat(await second.note.innerText()) === TOO_LONG_MESSAGE);
  assert.equal(answers.length, 2, 'the over-long entry was answered once');
  assert.equal(answers[1].status, 422,
    'an over-long description is refused 422, before anything is saved');
  assert.equal(answers[1].body.saved, false, 'a refusal cannot answer saved');
  assert.equal(answers[1].body.error, 'description_too_long');
  assert.equal(answers[1].body.limit_chars, LIMIT_CHARS,
    'the refusal names the limit it applied');
  assert.ok(!('entry' in answers[1].body), 'a refused entry is not answered');

  assert.ok(await second.post.isVisible(), 'the sheet stays open on the refusal');
  assert.equal(await second.description.inputValue(), long,
    'the typed description stays in the sheet, like every other refused field');
  assert.equal(await second.amount.inputValue(), '42', 'and the typed amount');
  assert.equal(await second.category.inputValue(), 'Water', 'and the chosen category');
  assert.equal(
    Number((await db.prepare('SELECT COUNT(*) AS n FROM entry').first()).n), before,
    'the refused description wrote no row at all');

  // ===== 5. An entry with the field left empty is saved exactly as before =====
  await second.description.fill('');
  await second.post.click();
  await waitFor('the sheet to close on the emptied description',
    async () => !(await second.post.isVisible()));
  assert.equal(answers.length, 3);
  assert.equal(answers[2].status, 200, 'an empty description is not refused');
  assert.equal(answers[2].body.saved, true);
  const emptyId = answers[2].body.entry.client_entry_id;
  assert.deepEqual(Object.keys(answers[2].body.entry).sort(), ENTRY_MEMBERS,
    'an entry without a description is answered exactly as before');
  assert.equal(await storedDescription(db, emptyId), '',
    "an empty description is stored as '', never as null and never refused");
  assert.equal(sent[2].description, '',
    'the page posts the empty field as the empty string');

  assert.deepEqual(offLimits, [],
    `the page contacted nothing beyond its feeds and its service: ${offLimits.join(', ')}`);
  assert.deepEqual(crashes, [], `no script error: ${crashes.join(' | ')}`);

  // ===== 6. The contract itself: absent, null, non-text, and the exact limit ===
  const direct = body => post(serviceOrigin, pageOrigin, body);
  const entry = (id, over = {}) => ({
    pin: PIN, category: 'Meals', amount: '10.00', client_entry_id: id, ...over
  });

  // Absent and null are the same as none: saved exactly as before.
  for (const [id, over] of [['d-absent', {}], ['d-null', { description: null }],
    ['d-blank', { description: '   \n\t  ' }]]) {
    const answer = await direct(entry(id, over));
    assert.equal(answer.status, 200, `${id} is saved`);
    assert.equal(answer.body.saved, true);
    assert.deepEqual(Object.keys(answer.body.entry).sort(), ENTRY_MEMBERS);
    assert.equal(await storedDescription(db, id), '',
      `${id} is stored with the empty description`);
  }

  // Not a string: refused, with nothing written.
  for (const [id, value] of [['d-num', 42], ['d-obj', { a: 1 }], ['d-arr', ['x']],
    ['d-bool', true]]) {
    const answer = await direct(entry(id, { description: value }));
    assert.equal(answer.status, 422, `a description of ${JSON.stringify(value)} is refused`);
    assert.equal(answer.body.saved, false);
    assert.equal(answer.body.error, 'description_not_text');
    assert.equal(answer.headers.get('access-control-allow-origin'), pageOrigin,
      'the new refusals carry CORS like every other refusal');
    assert.equal(await rowCount(db, id), 0, 'and wrote no row');
  }

  // The limit is counted in Unicode code points, after trim and collapse — not in
  // UTF-16 units and not on the text as typed.
  const atLimit = '🚤'.repeat(LIMIT_CHARS);
  const overLimit = '🚤'.repeat(LIMIT_CHARS + 1);
  const at = await direct(entry('d-at-limit', { description: atLimit }));
  assert.equal(at.status, 200,
    `${LIMIT_CHARS} code points is within the limit, whatever its UTF-16 length`);
  assert.equal(await storedDescription(db, 'd-at-limit'), atLimit,
    'the description at the limit is stored whole');

  const over = await direct(entry('d-over-limit', { description: overLimit }));
  assert.equal(over.status, 422, `${LIMIT_CHARS + 1} code points is over the limit`);
  assert.equal(over.body.error, 'description_too_long');
  assert.equal(over.body.limit_chars, LIMIT_CHARS);
  assert.equal(await rowCount(db, 'd-over-limit'), 0);

  // Text that only normalisation brings under the limit is saved, normalised: the
  // limit is judged after trim and collapse, not before.
  const padded = '   ' + 'y'.repeat(LIMIT_CHARS - 2) + '  \n  z   ';
  const squeezed = await direct(entry('d-squeezed', { description: padded }));
  assert.equal(squeezed.status, 200,
    'a description that is over 200 as typed but 200 once normalised is saved');
  const squeezedText = await storedDescription(db, 'd-squeezed');
  assert.equal([...squeezedText].length, LIMIT_CHARS);
  assert.equal(squeezedText, 'y'.repeat(LIMIT_CHARS - 2) + ' z',
    'every run of whitespace — spaces, tabs and newlines alike — becomes one space');

  // ===== 7. Save-first, PIN, origin, rate limit and idempotency are unchanged ==
  // The description is judged after the PIN, the category and the amount, so a
  // wrong PIN still answers wrong_pin first and an over-long description cannot
  // reveal which other field was also wrong.
  const wrongPin = await direct(entry('d-pin', { pin: WRONG_PIN, description: long }));
  assert.equal(wrongPin.status, 403, 'a wrong PIN is still answered first');
  assert.equal(wrongPin.body.error, 'wrong_pin');
  assert.equal(await rowCount(db, 'd-pin'), 0);

  const badCategory = await direct(entry('d-cat', { category: 'Mileage', description: long }));
  assert.equal(badCategory.body.error, 'unknown_category',
    'the category is still judged before the description');
  const badAmount = await direct(entry('d-amt', { amount: '-1', description: long }));
  assert.equal(badAmount.body.error, 'amount_not_positive_mvr',
    'the amount is still judged before the description');
  const badId = await direct(entry('x', { client_entry_id: '  ', description: long }));
  assert.equal(badId.body.error, 'invalid_client_entry_id',
    'the client entry id is still judged before the description');

  // The origin check still comes before everything.
  const badOrigin = await service(serviceOrigin, 'https://evil.example', '/expenses/entries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry('d-origin', { description: TYPED }))
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.body.error, 'origin_not_allowed');
  assert.equal(await rowCount(db, 'd-origin'), 0);

  // The same client entry id twice stores one row, and keeps the FIRST send's
  // description, exactly as it keeps the first amount (D10).
  const firstSend = await direct(entry('d-same', { description: 'first words' }));
  assert.equal(firstSend.status, 200);
  const secondSend = await direct(entry('d-same', { description: 'second words' }));
  assert.equal(secondSend.status, 200, 'a repeat send is still answered about the stored row');
  assert.deepEqual(secondSend.body, firstSend.body,
    'the second send answers about the row the first send stored');
  assert.equal(await rowCount(db, 'd-same'), 1, 'one row, not two');
  assert.equal(await storedDescription(db, 'd-same'), 'first words',
    "a repeat send keeps the first send's description, as it keeps the first amount");

  // The day's list and the single-entry answer still carry the seven members and
  // no description anywhere in the JSON the page is served.
  const day = await service(serviceOrigin, pageOrigin, `/expenses/entries?date=${TODAY}`);
  assert.equal(day.status, 200);
  assert.ok(day.body.entries.length >= 3, "the day's entries are still served");
  for (const e of day.body.entries) {
    assert.deepEqual(Object.keys(e).sort(), ENTRY_MEMBERS,
      'every listed entry keeps exactly the seven declared members');
  }
  assert.ok(!JSON.stringify(day.body).includes(NORMALISED),
    'the description is in the store, and nowhere in the projection served to the page');
});
