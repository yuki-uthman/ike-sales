# Product brief

## Request
    Follow-up: in Odoo the draft expense's Description shows only what the staff typed (or the category when they typed nothing), not '<category> - <description> [ike:<id>]'. Context: MRH Investment (Maldives, MVR). The description Request is live (Worker 'odoo', saas-19.4); its first live entry was named 'Water - Nagaraj [ike:056143fe-...]' and the owner wants it to read 'Nagaraj'. The mark that stops duplicate expenses moves to the expense's Internal Notes. Jobs: Accountant - read a clean description in the Odoo expense list. Owner - never get a duplicate expense.

## Outcomes
-     The accountant sees in Odoo's Description column only what staff typed, or the category when nothing was typed.
-     A sync that is retried or run twice still never creates a second Odoo expense for one entry.

## Scope

### In scope
-     The hr.expense name the Worker sends.
-     Sending the mark in the hr.expense Internal Notes (field description) and searching for it there before every create.

### Out of scope
Applicability: applicable
Reason:     The owner asked only for a clean Description; the rest is unchanged or a later decision.
-     Renaming expenses already in Odoo.
-     The receipt attachment's name.
-     The page, the D1 schema and the save route.
-     Deploying, or any call to the real Odoo; the owner deploys after review.

## Observations
-     V1 Clean description in Odoo: the draft hr.expense the Worker creates is named exactly the description the staff typed (as stored, trimmed and collapsed), or the category when there is none, with no mark in the name; the entry's mark '[ike:<client_entry_id>]' is the whole of the expense's Internal Notes (field description); the duplicate search before every create looks for the mark in Internal Notes, so an expense already created for the entry is adopted and a second run creates nothing; the receipt attachment, the status read-back and every other field sent are unchanged.

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
-     D19. Description (owner, 2026-10-07): an optional free-text description, typed on the Add sheet in its own field right after the amount. The Worker stores it with the entry, trimmed, with internal whitespace runs collapsed to one space, at most 200 characters; longer text is refused before anything is saved, and an empty or absent description is the same as none. In Odoo it is the draft hr.expense's name (Odoo's 'Description' field) as D21 sets out. It is not shown in the day's entry list.
-     D20. Pane alignment with Sales and Quotations (owner, 2026-10-07, shipped in 7019c50, replacing these parts of the D9 screens): the Expenses pane has no header; its day pills run oldest on the left to today on the right; the Add sheet's PIN is a field like the others, label above and a full-width input below, with field borders that read in dark mode; the amount's digits sit centred under the AMOUNT label.
-     D21. Clean description in Odoo (owner, 2026-10-08, replacing the name format of D19 that shipped in 5281554): the draft hr.expense's name (Odoo's 'Description') is exactly the stored description, or the category when the description is empty. The entry's mark '[ike:<client_entry_id>]' moves out of the name into the expense's 'Internal Notes' (the hr.expense field `description`, stored text, writable on saas-19.4), which holds the mark alone. The duplicate search before every create (D8) looks for the mark there: [['description','like','[ike:<client_entry_id>]']]. The receipt attachment keeps its name 'receipt [ike:<client_entry_id>]'. Expenses already in Odoo keep their old names; the status read-back finds them by stored Odoo id, so they need no change. Accepted risk: an entry whose create succeeded under the old version but whose Odoo id was never stored would not be found by the new search; on 2026-10-08 every live entry already had its Odoo id.

## Values
| Observation | Dependencies |
| --- | --- |
| V1 Clean description in Odoo: the draft hr.expense the Worker creates is named exactly the description the staff typed (as stored, trimmed and collapsed), or the category when there is none, with no mark in the name; the entry's mark '[ike:<client_entry_id>]' is the whole of the expense's Internal Notes (field description); the duplicate search before every create looks for the mark in Internal Notes, so an expense already created for the entry is adopted and a second run creates nothing; the receipt attachment, the status read-back and every other field sent are unchanged. |  |
