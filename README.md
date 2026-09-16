# Ike Sales

A small, free dashboard of daily takings at MRH Investment — the money that
actually arrived each day, counted once each. This repo is **static only**: no
secret, no cron, no build step. It just fetches its data live from
[ike-data](https://github.com/yuki-uthman/ike-data), the shared Odoo pipeline
that also backs any future dashboards (expenses, etc.).

## One-time setup

**Enable GitHub Pages**: Settings → Pages → Source: "Deploy from a branch" →
Branch: `main`, folder `/ (root)`. The page will be at
`https://<your-username>.github.io/ike-sales/`.

That's it — there's nothing else to configure here. Data freshness, the Odoo
credential, and the de-duplication logic all live in
[ike-data](https://github.com/yuki-uthman/ike-data).

## What a day's number means

**Money received that day**, not sales made that day — the same question
[ike-today](https://github.com/yuki-uthman/ike-today) asks, so the two
dashboards can never disagree. A credit sale confirmed today does not appear
here until the payment lands; an old invoice settled today appears here today.

The product list underneath is the products on whatever was paid for that
day. One caveat: a partial payment contributes its invoice's whole line set,
so in that case the products total more than the day's figure. MRH settles
invoices in full as a rule, so this is a stated edge rather than a routine
distortion.

A cheque, a card, or any other method that is neither cash nor transfer is
still money received, so it counts in this dashboard's total. ike-today, which
has only a cash card and a transfer card to put it in, holds it out of both
and names it in a separate strip instead.

**This changed on 2026-09-16.** The dashboard used to count sales *made* each
day, paid or not. The full 60-day history was re-backfilled under the new
meaning at the same time, so the chart is comparable end to end.

## How it gets its data

`index.html` fetches
`https://raw.githubusercontent.com/yuki-uthman/ike-data/main/data/sales.json`
directly in the browser on every page load (`cache: 'no-store'`) — GitHub
serves raw file content with `Access-Control-Allow-Origin: *`, so this works
cross-repo with no server or API needed. See
[ike-data](https://github.com/yuki-uthman/ike-data)'s README for how that
file gets refreshed and what "Point of Sale" vs "Sales Orders" actually
counts.

## Visibility

GitHub Pages on a free plan requires a **public** repository, so this page
is technically reachable by anyone with the exact URL, though it isn't
linked or indexed anywhere. If that's ever a concern, GitHub Pages on
private repos requires GitHub Pro or higher.
