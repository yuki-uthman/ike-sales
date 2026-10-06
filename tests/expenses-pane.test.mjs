// Oracle for "V1 Expenses pane with dummy data".
//
// Authority: docs/product/brief.md#Decisions (D2, D7, D9, D11, D12, D15) and
// design/expenses-tab/ (the approved screens, read as acceptance supports).
//
// Driving port: a real browser (Playwright/Chromium) at the design's phone
// viewport, loading the deployed artefact index.html over HTTP from a local
// static server, exactly as GitHub Pages serves it. Nothing is imported from
// the page; every fact below is read through the DOM a phone would get.
//
// Every selector is a public, authority-named handle: the pane id #pane-expenses
// (decision 1), the tab's visible word "Expenses", the FAB's aria-label
// "Add expense" and the field labels "Amount" / "Category" / "Your PIN" and the
// "Post expense" button from design/expenses-tab/AddSheet.dc.html and Main.dc.html,
// the chip words of D12, and the 21 category names of D7. No id, class or
// wording is invented here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The design screens are drawn at 390x844 — "on a phone".
const PHONE = { width: 390, height: 844 };

// D7: the 21 Odoo expense categories ('Expenses' and 'Mileage' excluded,
// 'Salary' included).
const CATEGORIES_D7 = [
  'Advertising & Marketing', 'Communication', 'Electricity', 'Fuel / Petrol',
  'Gate Pass (Boat Delivery)', 'Gifts', 'Internet', 'Meals',
  'Medical Checkup (Visa)', 'Salary', 'Shop Maintenance & Repairs', 'Shop Rent',
  'Software Subscriptions', 'Staff Accommodation Rent',
  'Stationery & Packing Supplies', 'Travel & Accommodation',
  'Vehicle Maintenance', 'Visa & Work Permit', 'Warehouse Rent',
  'Waste Disposal', 'Water'
];

// D12: the five chips, and the words the design used that D12 retires.
const CHIPS = ['Waiting to send', 'Not sent', 'Draft', 'Approved', 'Refused'];
const RETIRED_WORDS = ['Posted', 'Posts straight to Odoo'];

// Decision 5: the plum accent measured as the dominant one in
// design/expenses-tab/Main.dc.html (light) and MainDark.dc.html (dark).
const PLUM_LIGHT = 'rgb(138, 63, 100)';   // #8a3f64
const PLUM_DARK = 'rgb(217, 138, 176)';   // #d98ab0

// The requests index.html already makes on load, before this observation: two
// Google Fonts hosts and ike-data's two feeds. "It makes no network call" is the
// pane's claim, so it is checked as "no request outside this pre-existing set".
const PRE_EXISTING = [
  'https://fonts.googleapis.com/',
  'https://fonts.gstatic.com/',
  'https://raw.githubusercontent.com/yuki-uthman/ike-data/main/data/sales.json',
  'https://raw.githubusercontent.com/yuki-uthman/ike-data/main/data/quotations.json'
];

// The two feeds are answered with empty payloads, which index.html already
// handles through its own .catch/empty-days message. The point of this oracle is
// the Expenses pane, and a pane that needed live Odoo data to be judged would
// not be judgeable at all.
const EMPTY_FEEDS = {
  'sales.json': '{"days":[]}',
  'quotations.json': '{"records":[],"days":[]}'
};

async function startServer() {
  const html = await fs.readFile(path.join(REPO, 'index.html'));
  const server = http.createServer((req, res) => {
    if ((req.url || '/').split('?')[0] === '/' || req.url.startsWith('/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}/` };
}

/** Open index.html in one colour scheme, with every request accounted for. */
async function openPage(browser, origin, colorScheme) {
  const offLimits = [];
  const context = await browser.newContext({
    viewport: PHONE, colorScheme, hasTouch: true, isMobile: true,
    deviceScaleFactor: 3
  });
  const page = await context.newPage();
  const crashes = [];
  page.on('pageerror', e => crashes.push(String(e)));

  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    const feed = Object.keys(EMPTY_FEEDS).find(f => url.endsWith(f));
    if (feed) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_FEEDS[feed] });
    }
    if (!PRE_EXISTING.some(p => url.startsWith(p))) offLimits.push(url);
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });

  await page.goto(origin, { waitUntil: 'load' });
  return { page, context, offLimits, crashes };
}

async function waitFor(what, fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what} (last: ${last})`);
    await new Promise(r => setTimeout(r, 50));
  }
}

/**
 * Read the pane's entries the way a reader does: each entry is the largest block
 * inside the pane that still carries exactly one of D12's five chips. No class
 * or id of the implementation is assumed.
 */
function readEntries(page, chips) {
  return page.evaluate(chipWords => {
    const pane = document.getElementById('pane-expenses');
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    // A reader sees separate fields, not one run-together string: textContent
    // concatenates siblings with no separator ("just now" + "137" -> "now137"),
    // which would destroy the boundary between a row's fields. Read each text
    // node separately and join with a space, so field boundaries survive.
    const fieldText = el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const parts = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = norm(n.nodeValue);
        if (t) parts.push(t);
      }
      return norm(parts.join(' '));
    };
    const chipsIn = el => chipWords.reduce(
      (n, w) => n + (norm(el.textContent).match(new RegExp(w.replace(/[/()&]/g, '\\$&'), 'g')) || []).length, 0);

    // leaf-most elements whose whole text is one chip word
    const chipEls = Array.from(pane.querySelectorAll('*')).filter(el =>
      chipWords.includes(norm(el.textContent)) &&
      !Array.from(el.children).some(c => chipWords.includes(norm(c.textContent))));

    return chipEls.map(chip => {
      let row = chip;
      while (row.parentElement && row.parentElement !== pane && chipsIn(row.parentElement) === 1) {
        row = row.parentElement;
      }
      return {
        chip: norm(chip.textContent),
        text: fieldText(row),
        hasRetryButton: Array.from(row.querySelectorAll('button')).some(b => norm(b.textContent) === 'Retry')
      };
    });
  }, chips);
}

test('expenses_pane_posts_an_entry_as_waiting_to_send', async t => {
  const { server, origin } = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });

  const { page, offLimits, crashes } = await openPage(browser, origin, 'light');

  const tabs = page.locator('#tabs [role="tab"]');
  const expensesTab = tabs.filter({ hasText: 'Expenses' });
  const pane = page.locator('#pane-expenses');

  // ---- A third tab, reached by the tab bar and by swipe, like the other two ----
  assert.equal(await tabs.count(), 3, 'the tab bar carries three tabs');
  assert.deepEqual(
    await tabs.evaluateAll(els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim())),
    ['Sales', 'Quotations', 'Expenses'],
    'Expenses is the third tab, after Sales and Quotations');
  assert.equal(await expensesTab.getAttribute('aria-controls'), 'pane-expenses');
  assert.equal(await pane.count(), 1, 'the pane exists with the declared id');

  // Swipe: the pager is a scroll-snap row and the Expenses pane is its third
  // full-width snap stop, so a finger lands on it. Scrolling the pager is what a
  // finger produces, and is read here instead of a synthetic drag, whose
  // momentum would make the assertion about the test's physics rather than the
  // page's. The tab bar must follow that scroll, as it does for Sales/Quotations.
  const geometry = await page.evaluate(() => {
    const pager = document.getElementById('pager');
    const pane = document.getElementById('pane-expenses');
    return {
      snapType: getComputedStyle(pager).scrollSnapType,
      paneParent: pane.parentElement.id,
      paneIndex: Array.prototype.indexOf.call(pager.children, pane),
      paneWidth: pane.getBoundingClientRect().width,
      pagerWidth: pager.clientWidth,
      snapAlign: getComputedStyle(pane).scrollSnapAlign
    };
  });
  assert.equal(geometry.paneParent, 'pager', 'the pane is a child of the existing pager');
  assert.equal(geometry.paneIndex, 2, 'it is the third pane');
  assert.equal(geometry.paneWidth, geometry.pagerWidth, 'it fills the viewport width');
  assert.match(geometry.snapAlign, /start/);
  assert.match(geometry.snapType, /x mandatory/);

  await page.evaluate(() => {
    const pager = document.getElementById('pager');
    pager.scrollLeft = 2 * pager.clientWidth;
  });
  await waitFor('a swipe to the third pane to select the Expenses tab',
    async () => await expensesTab.getAttribute('aria-selected') === 'true');

  // ...and back, then in by tapping the tab, which must work the same way.
  await page.evaluate(() => { document.getElementById('pager').scrollLeft = 0; });
  await waitFor('the swipe back to Sales',
    async () => await tabs.nth(0).getAttribute('aria-selected') === 'true');
  await expensesTab.click();
  await waitFor('tapping the Expenses tab to select it',
    async () => await expensesTab.getAttribute('aria-selected') === 'true');
  await waitFor('the tap to scroll the pager onto the Expenses pane', async () => {
    const left = await page.evaluate(() => {
      const p = document.getElementById('pager');
      return Math.abs(p.scrollLeft - 2 * p.clientWidth);
    });
    return left < 2;
  });

  // ---- Plum accent (decision 5, measured from the approved screens) ----
  // `.tab` transitions its colour, so the final accent is what is read: poll
  // until the computed colour settles on the plum (and fail on timeout).
  await waitFor(
    'the selected Expenses tab to wear the light plum of design/expenses-tab/Main.dc.html'
      + ` (${PLUM_LIGHT})`,
    async () => await expensesTab.evaluate(el => getComputedStyle(el).color) === PLUM_LIGHT);

  // ---- The day's confirmed total, a separate pending line, the category list ----
  const paneText = (await pane.innerText()).replace(/\s+/g, ' ');
  assert.match(paneText, /MVR\s*[\d,]+/, "the day's confirmed total is shown in MVR");
  assert.match(paneText, /pending[^.]*[\d,]+|[\d,]+[^.]*pending/i,
    'a separate pending line carries its own figure (D11: app drafts are pending, not counted)');
  const listed = CATEGORIES_D7.filter(c => paneText.includes(c));
  assert.ok(listed.length >= 1,
    `the category list names D7 categories (found: ${listed.join(', ') || 'none'})`);

  // ---- All five of D12's chips are exhibited on one load, in D12's words ----
  const before = await readEntries(page, CHIPS);
  for (const chip of CHIPS) {
    assert.ok(before.some(e => e.chip === chip), `an entry is chipped '${chip}'`);
  }
  const notSent = before.find(e => e.chip === 'Not sent');
  assert.match(notSent.text, /\d{1,2}:\d{2}/, "'Not sent' shows its next retry time");
  assert.ok(notSent.hasRetryButton, "'Not sent' offers Retry");

  for (const word of RETIRED_WORDS) {
    assert.ok(!paneText.includes(word),
      `D12 retires the design's '${word}', so it must not appear`);
  }

  // ---- The Add sheet: amount (MVR), one of the 21 categories, optional receipt
  //      from camera or gallery, and the PIN (D2, D7) ----
  assert.ok(!before.some(e => /\b137(\.00)?\b/.test(e.text)),
    'the amount this oracle posts is not already in the dummy day');
  const requestsBeforePost = offLimits.length;
  const networkBeforePost = await page.evaluate(() => performance.getEntriesByType('resource').length);

  await pane.locator('[aria-label="Add expense"]').click();

  const amount = page.getByLabel('Amount');
  const category = page.getByLabel('Category');
  const pin = page.getByLabel(/PIN/i);
  const post = page.getByRole('button', { name: 'Post expense' });
  await waitFor('the Add sheet to open', async () => await post.isVisible());

  assert.deepEqual(
    (await category.locator('option').evaluateAll(
      os => os.map(o => o.textContent.replace(/\s+/g, ' ').trim()))).sort(),
    CATEGORIES_D7.slice().sort(),
    'the category select carries exactly D7\'s 21 names');

  // The camera claim is the `capture` attribute; no headless run has a camera,
  // so this is where it is readable at all.
  assert.equal(
    await page.locator('input[type=file][accept*="image"][capture="environment"]').count(), 1,
    'Take photo offers the camera (capture=environment)');
  assert.ok(
    await page.locator('input[type=file][accept*="image"]:not([capture])').count() >= 1,
    'Gallery offers a plain image pick');
  assert.ok(await amount.count() === 1 && await pin.count() === 1,
    'the sheet takes an amount and the PIN');
  assert.ok(!(await post.locator('xpath=ancestor::*[1]').innerText())
    .includes('Posts straight to Odoo'), 'D12 drops the Odoo promise under the button');

  await amount.fill('137');
  await category.selectOption({ label: 'Fuel / Petrol' });
  await pin.fill('1234');
  await post.click();

  // ---- The entry appears in the list as 'Waiting to send', and the sheet closes ----
  await waitFor('the sheet to close after posting', async () => !(await post.isVisible()));

  const posted = await waitFor('the posted entry to appear in the day\'s list', async () => {
    const rows = (await readEntries(page, CHIPS))
      .filter(e => /\b137(\.00)?\b/.test(e.text));
    return rows.length ? rows : null;
  });
  assert.equal(posted.length, 1, 'the posted entry appears once');
  assert.equal(posted[0].chip, 'Waiting to send',
    "the entry added on the sheet appears in the list as 'Waiting to send'");
  assert.ok(posted[0].text.includes('Fuel / Petrol'),
    'the entry carries the category that was chosen');

  // ---- It makes no network call ----
  const networkAfterPost = await page.evaluate(() => performance.getEntriesByType('resource').length);
  assert.equal(networkAfterPost, networkBeforePost,
    'opening the sheet and posting issued no request at all');
  assert.deepEqual(offLimits.slice(requestsBeforePost), [], 'no new endpoint was contacted');
  assert.deepEqual(offLimits, [],
    `the page requested nothing beyond its pre-existing four: ${offLimits.join(', ')}`);

  // ---- ids and classes scoped to the pane; Sales and Quotations behave as before ----
  const scoping = await page.evaluate(() => {
    const pane = document.getElementById('pane-expenses');
    // The Add sheet is scoped too, but it lives outside #pager. Find it without
    // assuming any implementation id: climb from the Post button to the nearest
    // ancestor that also holds the sheet's Amount, Category and PIN fields.
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const holdsFields = el => {
      const t = norm(el.textContent);
      return /Amount/i.test(t) && /Category/i.test(t) && /PIN/i.test(t);
    };
    const sheetRoots = Array.from(document.querySelectorAll('button'))
      .filter(b => norm(b.textContent) === 'Post expense')
      .map(b => {
        let el = b.parentElement;
        while (el && !holdsFields(el)) el = el.parentElement;
        return el;
      });
    const scopes = [pane].concat(sheetRoots).filter(Boolean);
    const ids = Array.from(document.querySelectorAll('[id]')).map(e => e.id);
    const inside = el => scopes.some(s => s.contains(el));
    return {
      duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
      unscopedInside: Array.from(document.querySelectorAll('[id]'))
        .filter(el => inside(el) && el.id !== 'pane-expenses' && !/^e-/.test(el.id))
        .map(el => el.id),
      leakedOutside: Array.from(document.querySelectorAll('[id]'))
        .filter(el => !inside(el) && el.id !== 'pane-expenses' && /^e-/.test(el.id))
        .map(el => el.id),
      salesPane: !!document.getElementById('pane-sales'),
      quotesPane: !!document.getElementById('pane-quotes'),
      salesRendered: (document.getElementById('pane-sales').innerText || '').trim().length > 0,
      quotesRendered: (document.getElementById('pane-quotes').innerText || '').trim().length > 0
    };
  });
  assert.deepEqual(scoping.unscopedInside, [],
    'every id the pane and its sheet introduce carries the e- prefix');
  assert.deepEqual(scoping.leakedOutside, [], 'no e- id was placed outside the pane');
  assert.deepEqual(scoping.duplicateIds, [], 'the new ids collide with nothing');
  assert.ok(scoping.salesPane && scoping.quotesPane, 'both old panes are still there');
  assert.ok(scoping.salesRendered && scoping.quotesRendered, 'both old panes still render');
  assert.deepEqual(crashes, [], `no script error anywhere on the page: ${crashes.join(' | ')}`);

  // ---- Dark: the same pane, the same D12 words, the dark plum ----
  const dark = await openPage(browser, origin, 'dark');
  const darkTab = dark.page.locator('#tabs [role="tab"]').filter({ hasText: 'Expenses' });
  await darkTab.click();
  await waitFor('the Expenses tab in dark', async () => await darkTab.getAttribute('aria-selected') === 'true');
  await waitFor(
    'the dark scheme to wear the dark plum of design/expenses-tab/MainDark.dc.html'
      + ` (${PLUM_DARK})`,
    async () => await darkTab.evaluate(el => getComputedStyle(el).color) === PLUM_DARK);
  const darkEntries = await readEntries(dark.page, CHIPS);
  for (const chip of CHIPS) {
    assert.ok(darkEntries.some(e => e.chip === chip), `dark shows an entry chipped '${chip}'`);
  }
  const darkText = (await dark.page.locator('#pane-expenses').innerText()).replace(/\s+/g, ' ');
  for (const word of RETIRED_WORDS) {
    assert.ok(!darkText.includes(word), `dark does not reinstate '${word}'`);
  }
  assert.deepEqual(dark.offLimits, [], 'dark made no call of its own either');
  assert.deepEqual(dark.crashes, [], `no script error in dark: ${dark.crashes.join(' | ')}`);
});
