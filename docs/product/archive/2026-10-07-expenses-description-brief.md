# Product brief

## Request
    Follow-up: staff can add an optional short description to a bank-transfer expense on the Add sheet, typed right after the amount, and the accountant sees it on the draft expense in Odoo. Context: MRH Investment (Maldives, MVR). The Expenses tab is live through the ike Odoo layer (Worker 'odoo', D1 'ike-odoo', saas-19.4). A category alone often does not say what the money was for (which boat trip, which repair), so the accountant still asks in WhatsApp. Jobs: Staff - say in a few words what this transfer was for, without slowing down. Accountant - read what an expense was for in Odoo without asking.

## Outcomes
-     Staff can type an optional description right after the amount on the Add sheet; an expense posted without one still takes under 30 seconds from opening the tab to seeing it saved.
-     The accountant reads the description on the draft hr.expense in Odoo, next to its category, without asking in WhatsApp.

## Scope

### In scope
-     A 'Description (optional)' field on the Add sheet right after the amount, posted with the entry.
-     Storing the description with the entry in the Worker's D1 (a new column through a new migration), with its 200-character limit.
-     Sending the description in the draft hr.expense's name, before the mark.

### Out of scope
Applicability: applicable
Reason:     The request is one optional field from the Add sheet to Odoo; these items are separate jobs or later decisions.
-     Showing the description in the day's entry list or the categories card.
-     Editing a description after posting, from the page or the Worker.
-     Any other new field sent to Odoo (who paid, paid to, notes).
-     Making the description required.
-     Back-filling a description on entries already in Odoo.
-     Deploying, applying the D1 migration on Cloudflare, or any call to the real Odoo; the owner does those after review.

## Observations
-     V1 Description saved: on the Add sheet a field labelled 'Description (optional)' sits right after the amount and before the category; the text typed there is posted with the entry and the Worker stores it with the entry, trimmed and with whitespace runs collapsed to one space; a description longer than 200 characters is refused with a plain message and nothing is saved; an entry posted with an empty description, or with none, is saved exactly as before; the sheet clears the field when it opens; save-first, PIN, origin, rate limit and idempotency are unchanged.
-     V2 Description in Odoo: the draft hr.expense the Worker creates for an entry that has a description is named '<category> - <description> [ike:<client_entry_id>]'; for an entry without one the name stays '<category> [ike:<client_entry_id>]'; the mark search before every create, the adoption of a found expense, the receipt upload and every other field sent are unchanged.

## Decisions
-     D1. Bank-transfer expenses only. No cash and no cash/transfer choice.
-     D2. Entry fields: category (dropdown), amount (MVR), optional description (D19), optional receipt (camera or gallery), PIN. No 'who', no 'paid from', no 'paid to'.
-     D3. The PIN is one shared key that authorises saving. It does not identify a person.
-     D4. Every entry belongs to one default Odoo employee: Ahmed Rashad (hr.employee id 1).
-     D5. The app only creates a DRAFT hr.expense in Odoo. No submit, approve, post or pay from the app.
-     D6. No amount limit.
-     D7. Categories are Odoo expense categories: 23 exist; 'Expenses' and 'Mileage' are excluded; 'Salary' is included -> 21: Advertising & Marketing, Communication, Electricity, Fuel / Petrol, Gate Pass (Boat Delivery), Gifts, Internet, Meals, Medical Checkup (Visa), Salary, Shop Maintenance & Repairs, Shop Rent, Software Subscriptions, Staff Accommodation Rent, Stationery & Packing Supplies, Travel & Accommodation, Vehicle Maintenance, Visa & Work Permit, Warehouse Rent, Waste Disposal, Water.
-     D8. Reliable before instant: save first on the server side, sync to Odoo later, retry on failure, never lose an entry, never create a duplicate.
-     D9. A third tab 'Expenses' in the existing ike-sales page (static GitHub Pages, no build step, same look, plum accent, light + dark). Approved screens: design/expenses-tab/ (live at https://claude.ai/artifact/9cwfccMncJ7pWwr6twq98Z).
-     D10. Hosting: Cloudflare Worker + D1 for save-and-sync. The Odoo key is a Worker secret only, never in the page. The page is public, so the Worker checks the PIN and the page's origin.
-     D11. Read side exists: ike-data/data/expenses.json (approved/posted/in_payment/paid = confirmed; draft/submitted = pending; refused dropped; category list counts confirmed only; refreshed every 15 minutes). App drafts therefore show as pending, not in the total.
-     D12. Status chips: 'Waiting to send' (saved in the Worker, not yet in Odoo), 'Not sent' (last Odoo call failed; shows next retry time and a Retry button), 'Draft' (in Odoo as draft or submitted; pending, not counted), 'Approved' (approved, posted, in_payment or paid; counted), 'Refused' (refused in Odoo; never counted, stays in the list). The mapping follows the D11 counting rule, so a chip always agrees with the total. The design's 'Posted' is replaced by these words, its legend reads 'Waiting > Draft > Approved', and the Add sheet no longer says 'Posts straight to Odoo'.
-     D13. Read-back: on the same Cloudflare Cron Trigger that runs sync retries, every 15 minutes (the ike-data refresh interval), the Worker makes one read-only search_read on hr.expense for the Odoo ids of its entries that still show 'Draft' and updates their chips; an entry in a final chip (Approved or Refused) is not read again. The page never calls Odoo; chip and day total may disagree for up to about 15 minutes because the two schedules are independent.
-     D14. The owner sets and changes the PIN without a developer: it is a Worker secret changed in the Cloudflare dashboard. A new PIN works at once, the old one stops, saved entries are not affected. Wrong PINs are rate-limited. A leak is handled by the owner changing it.
-     D15. Everyone sees the day's full entry list (no names exist, so there is no 'own' list).
-     D16. The Odoo expense date is the Maldives (UTC+5) date on which the entry was saved, not the date it reached Odoo.
-     D17. The Worker is the ike Odoo layer: Worker name 'odoo' on the owner's workers.dev subdomain 'ike-mrh' ('ike' was taken), URL https://odoo.ike-mrh.workers.dev, D1 database 'ike-odoo'. Expense routes move under /expenses/: /expenses/entries, /expenses/categories, /expenses/entries/<id>/retry. OPTIONS stays 204 on any path and the origin check stays on every path. Each later Odoo area gets its own /<area>/ prefix and its own Odoo user and key; no route passes arbitrary Odoo calls through.
-     D18. Live-schema corrections from the read-only check of the live Odoo on 2026-10-07: no payment method line is named 'Bank Transfer MVR'; the company-paid bank-transfer line is id 2 'Transfer' (journal 6 Bank, outbound) and id 1 is also 'Transfer' (inbound), so a name search is ambiguous and the Worker sends the configured id ODOO_PAYMENT_METHOD_LINE_ID instead. total_amount and total_amount_currency are both writable and equal for MVR, the company currency; price_unit is readonly and computed, so it is never sent. The other assumed facts (name as the mark, the 21 products, receipt by res_model/res_id, the 7 state values, the 'id in' read shape, employee 1, payment_mode company_account) were confirmed. The page's Retry button (D12) calls the Worker's retry route.
-     D19. Description (owner, 2026-10-07): an optional free-text description, typed on the Add sheet in its own field right after the amount. The Worker stores it with the entry, trimmed, with internal whitespace runs collapsed to one space, at most 200 characters; longer text is refused before anything is saved, and an empty or absent description is the same as none. In Odoo it is part of the draft hr.expense's name (Odoo's 'Description' field): '<category> - <description> [ike:<client_entry_id>]' when present, and unchanged '<category> [ike:<client_entry_id>]' when absent, so the mark search (D8) and the category stay where they are. It is not shown in the day's entry list.
-     D20. Pane alignment with Sales and Quotations (owner, 2026-10-07, shipped in 7019c50, replacing these parts of the D9 screens): the Expenses pane has no header; its day pills run oldest on the left to today on the right; the Add sheet's PIN is a field like the others, label above and a full-width input below, with field borders that read in dark mode; the amount's digits sit centred under the AMOUNT label.

## Values
| Observation | Dependencies |
| --- | --- |
| V1 Description saved: on the Add sheet a field labelled 'Description (optional)' sits right after the amount and before the category; the text typed there is posted with the entry and the Worker stores it with the entry, trimmed and with whitespace runs collapsed to one space; a description longer than 200 characters is refused with a plain message and nothing is saved; an entry posted with an empty description, or with none, is saved exactly as before; the sheet clears the field when it opens; save-first, PIN, origin, rate limit and idempotency are unchanged. |  |
| V2 Description in Odoo: the draft hr.expense the Worker creates for an entry that has a description is named '<category> - <description> [ike:<client_entry_id>]'; for an entry without one the name stays '<category> [ike:<client_entry_id>]'; the mark search before every create, the adoption of a found expense, the receipt upload and every other field sent are unchanged. | V1 Description saved: on the Add sheet a field labelled 'Description (optional)' sits right after the amount and before the category; the text typed there is posted with the entry and the Worker stores it with the entry, trimmed and with whitespace runs collapsed to one space; a description longer than 200 characters is refused with a plain message and nothing is saved; an entry posted with an empty description, or with none, is saved exactly as before; the sheet clears the field when it opens; save-first, PIN, origin, rate limit and idempotency are unchanged. |
