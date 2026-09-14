# Ike Sales

A small, free dashboard of daily sales at MRH Investment — Point of Sale plus
confirmed Sales Orders, counted once each. This repo is **static only**: no
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
