# Ike Today Sales

A small, free, self-hosted dashboard of today's total sales at MRH Investment —
Point of Sale plus confirmed Sales Orders, counted once each (see
`scripts/fetch_sales.py` for the de-duplication logic). No dependency on any
Claude subscription: GitHub Actions pulls the data, GitHub Pages serves the page.

## One-time setup

1. **Add the Odoo API key as a repo secret** (this is the only manual step):
   Settings → Secrets and variables → Actions → New repository secret
   - Name: `ODOO_API_KEY`
   - Value: an Odoo API key scoped to **RPC**, created under
     Settings → Users → (the Odoo user) → Account Security → API Keys in Odoo.
     Use a key dedicated to this automation so it can be revoked independently
     of any other integration.

2. **Enable GitHub Pages**: Settings → Pages → Source: "Deploy from a branch" →
   Branch: `main`, folder `/ (root)`. The page will be at
   `https://<your-username>.github.io/ike-today-sales/`.

3. **Run the workflow once manually** to seed real data immediately instead of
   waiting for the next 30-minute tick: Actions tab → "Refresh sales data" →
   Run workflow.

That's it — from then on, `.github/workflows/refresh-sales.yml` runs every
30 minutes, recomputes today's totals, and commits `data/sales.json`, which
the page reads directly.

## How the numbers are computed

- **Point of Sale**: every POS order (`paid` or `done`) dated "today" in
  Maldives time.
- **Sales Orders**: confirmed sale orders (`state = sale`) dated today, but
  **excluding** any whose lines were settled through the POS register
  (`sale_order_origin_id` on `pos.order.line` is how Odoo links the two) —
  otherwise the same transaction gets counted twice.
- **Pending Quotations**: draft/sent (unconfirmed) sale orders, shown
  separately and never added to the total.

## Changing things later

- **Refresh frequency**: edit the `cron` line in
  `.github/workflows/refresh-sales.yml` (GitHub's practical minimum is 5
  minutes; every 30 minutes is the current setting).
- **Odoo URL / database / username**: plain values in the same workflow file
  (only the API key is a secret).
- The workflow commits to the repo on every run, which also means it never
  triggers GitHub's 60-day "inactive schedule" auto-disable.

## Visibility

GitHub Pages on a free plan requires a **public** repository, so this page
(and `data/sales.json`) is technically reachable by anyone with the exact
URL, though it isn't linked or indexed anywhere. If that's ever a concern,
GitHub Pages on private repos requires GitHub Pro or higher.
