## V1 Description saved

### Purpose
Let staff say in a few words what a bank-transfer expense was for, on the Add sheet right after the amount, and keep that text durably with the entry in the Worker so V2 can send it to Odoo.

### Constraints
- D19: the description is optional; empty or absent is the same as none, and an entry without one is saved exactly as before.
- D19: stored trimmed, with every run of whitespace collapsed to one space, at most 200 characters counted as Unicode code points after that normalisation; longer text is refused before anything is saved.
- D8/D10: save-first, PIN, origin, rate limit and same-id idempotency are unchanged; the description is checked after the PIN like category and amount, so a wrong PIN still answers wrong_pin first.
- D9: one static index.html, no build step; every new id and class carries the e- prefix.
- The entry projection served to the page keeps exactly its seven members: the description is not shown in the day's list (out of scope).
- The production D1 already applied 0001_init.sql, so the column arrives through a new migration file, never by editing 0001.

### Targets
| Path | Decision | Reason |
|---|---|---|
| `worker/migrations/0002_description.sql` | CREATE_NEW | Adds entry.description TEXT NOT NULL DEFAULT '' so existing rows read as 'no description' and the live D1 gains it with `wrangler d1 migrations apply`. |
| `worker/src/index.mjs` | EXTEND | handleSave validates and normalises body.description and refuses an over-long or non-text one with a closed code. |
| `worker/src/save.mjs` | EXTEND | saveEntry inserts the description; SYNC_COLUMNS carries it so the sync rule (V2) reads it without touching this file again. |
| `index.html` | EXTEND | The Add sheet gains the description field after the amount, clears it on open, posts it, and words the new refusal. |

### Paradigm
functional

### Decisions
- Migration worker/migrations/0002_description.sql holds exactly one statement: ALTER TABLE entry ADD COLUMN description TEXT NOT NULL DEFAULT ''. Rows saved before it read as '' (no description). No index: nothing queries by description.
- handleSave (worker/src/index.mjs:96) normalises the description after the PIN, category, amount and client_entry_id checks and before the receipt decode: absent, null or '' becomes ''; a value that is not a string is refused 422 'description_not_text'; a string is trimmed and every /\s+/ run becomes one space; if the result has more than 200 code points ([...text].length) the save is refused 422 'description_too_long' with {limit_chars: 200}. Both refusals go through the existing refuse() (worker/src/index.mjs:50), so they carry saved:false and the CORS headers like every other refusal, and nothing is written.
- saveEntry (worker/src/save.mjs:89) adds description to its column-listing INSERT; ON CONFLICT(client_entry_id) DO NOTHING is unchanged, so a second send of the same id keeps the first send's description, exactly as it keeps the first amount.
- SYNC_COLUMNS (worker/src/save.mjs:77) gains `description`, so syncRow and dueEntries hand it to the sync rule. SELECT_COLUMNS and projectEntry (worker/src/save.mjs:55, :71) are untouched: the projection stays the seven declared members.
- The Add sheet (index.html) gains, between the amount box (index.html:601) and the Category field (index.html:606), a field <div class="e-field"> with <label class="e-lbl" for="e-description">Description <span class="e-opt">(optional)</span></label> and <input class="e-input" id="e-description" type="text" autocomplete="off" enterkeyhint="next">, reusing the .e-field/.e-lbl/.e-input styles (index.html:467) so it matches Category and PIN in light and dark. No maxlength attribute: the Worker is the one judge of the limit, after normalisation.
- openSheet (index.html:2381) clears the description with the other fields. send() (index.html:2503) always posts `description: descriptionEl.value` as typed; the Worker normalises it.
- refusalMessage (index.html:2480) maps description_too_long to 'Keep the description to 200 characters or fewer. Nothing was saved.' and description_not_text to the generic refusal; as with every refusal the typed entry, description included, stays in the sheet.
- The oracle observes storage by reading D1 back directly (as tests/worker-save-first.test.mjs does), not through the projection, because the description is deliberately not projected.

### Reuse analysis
| Symbol | Locator | Decision | Reason |
|---|---|---|---|
| refuse | `worker/src/index.mjs:50` | REUSE | Every save refusal already goes through it with saved:false, the error code and CORS; the two new codes are two more callers. |
| saveEntry | `worker/src/save.mjs:89` | EXTEND | The single durable write; adding one bound column keeps 'saved only after durable store' structural. |
| SYNC_COLUMNS | `worker/src/save.mjs:77` | EXTEND | The sync rule's only view of a row; carrying description here keeps V2 to sync.mjs alone. |
| projectEntry | `worker/src/save.mjs:55` | REUSE | Unchanged on purpose: the day list does not show the description. |
| .e-input | `index.html:467` | REUSE | The full-width field style shipped in 7019c50 for the PIN; the description uses the same so the sheet's fields match. |
| refusalMessage | `index.html:2480` | EXTEND | The one place the page words a Worker refusal. |

### Prefactoring
Not applicable: The one prefactor this value needed is already committed as 740947b: every oracle now applies all D1 migrations in file-name order, so 0002 reaches them without an oracle edit (11/11 pass before and after).

### Agreement analysis
| Contract | Role | Locator | Decision | Reason |
|---|---|---|---|---|
| POST /expenses/entries request body | producer | `index.html:2503` | MIGRATED | The page adds an optional string member `description`. |
| POST /expenses/entries request body | consumer | `worker/src/index.mjs:96` | UNCHANGED_COMPATIBLE | A body without description is still valid and saves exactly as before; an old page keeps working. |
| D1 table entry | producer | `worker/migrations/0001_init.sql:9` | MIGRATED | 0002 adds description with DEFAULT '', so every existing row and every old INSERT stays valid. |
| Saved entry projection (seven members) | producer | `worker/src/save.mjs:55` | UNCHANGED_COMPATIBLE | Not changed: the description is not projected. |

### Boundaries
- Driving port: HTTP POST /expenses/entries from the Add sheet in index.html
- Driven port: Cloudflare D1 binding DB, table entry
- Dependency direction: index.html -> HTTP -> worker/src/index.mjs (validation) -> worker/src/save.mjs -> D1; save.mjs knows nothing of Request or Response.
- Failure: Condition: description is longer than 200 code points after trim and collapse | Outcome: Refusal | Observation: 422 {saved:false, error:'description_too_long', limit_chars:200}; no row is written; the sheet keeps the typed entry and shows 'Keep the description to 200 characters or fewer. Nothing was saved.'
- Failure: Condition: description is present and not a string | Outcome: Refusal | Observation: 422 {saved:false, error:'description_not_text'}; no row is written.
- Failure: Condition: D1 write fails | Outcome: Indeterminate | Observation: 503 not_stored as today; the sheet keeps the entry.

### Acceptance supports
- `worker/wrangler.json`
- `worker/migrations/0001_init.sql`

### Public oracle
Observation: An entry posted from the Add sheet with a description has that description, normalised, stored with it; an over-long one is refused and nothing is saved; one without a description is stored with ''.

Stimulus: On a phone-sized page served over HTTP and a real workerd Worker with every migration applied, open the Add sheet, type an amount, a description '  Boat   trip to Male  ', pick a category, the PIN, and post; then post a second entry with a 201-character description; then a third with the field left empty; and POST once directly with description 42.

Expected: The sheet's fields run Amount, Description (optional), Category, Receipt, PIN; the first entry is saved and its D1 row's description is 'Boat trip to Male'; the second answers 422 description_too_long, the sheet stays open with the plain message and no row exists for it; the third is saved with description ''; the direct POST answers 422 description_not_text; the saved-entry answer still has exactly seven members.

Falsifier: Any of: the field is missing or not directly after the amount; the stored text is not trimmed and collapsed; an over-long description saves a row or closes the sheet; an empty description is refused or stored as anything but ''; the projection gains a description member.

### Oracle and verification
Oracle target locator: `tests/expenses-description.test.mjs::description_is_saved_with_the_entry`

Verification command: `npm install --no-audit --no-fund`
Verification command: `node --test tests/expenses-description.test.mjs`
## V2 Description in Odoo

### Purpose
Put the description the Worker stored (V1) where the accountant reads it in Odoo: the draft hr.expense's name, which Odoo labels 'Description', next to the category.

### Constraints
- D19: name is '<category> - <description> [ike:<client_entry_id>]' when the stored description is non-empty, and exactly '<category> [ike:<client_entry_id>]' when it is ''.
- D8: the mark search runs before every create and a found expense is adopted, so the mark stays the last token of the name and the search domain is unchanged.
- D5/D18: no other field sent to Odoo changes; the Worker still calls only authenticate, search_read and create.
- The receipt attachment name stays 'receipt [ike:<client_entry_id>]'.

### Targets
| Path | Decision | Reason |
|---|---|---|
| `worker/src/sync.mjs` | EXTEND | syncOne builds the hr.expense name; one pure helper decides it from category, description and mark. |

### Paradigm
functional

### Decisions
- Add a pure exported helper expenseName(category, description, mark) in worker/src/sync.mjs beside markFor (worker/src/sync.mjs:31): it returns `${category} - ${description} ${mark}` when description is a non-empty string and `${category} ${mark}` otherwise. It does no normalising of its own: V1 already stored the description trimmed and collapsed, and the mark is the last token in both forms.
- syncOne (worker/src/sync.mjs:100) sends name: expenseName(row.category, row.description, mark) in place of the literal at worker/src/sync.mjs:143. row.description arrives through SYNC_COLUMNS, which V1 extended; this value touches no other file.
- The mark search at worker/src/sync.mjs:117 is unchanged: it matches the mark as a substring, so a description in front of it cannot hide the expense or cause a second create.
- The oracle drives the cron port of a real workerd Worker against a fake Odoo on loopback and reads the create call's name off the wire, as tests/worker-odoo-sync.test.mjs does; it seeds entries by posting through HTTP, with and without a description.

### Reuse analysis
| Symbol | Locator | Decision | Reason |
|---|---|---|---|
| markFor | `worker/src/sync.mjs:31` | REUSE | The mark is still derived, never stored, and stays the name's last token. |
| syncOne | `worker/src/sync.mjs:100` | EXTEND | The one place an hr.expense is created; only its name expression changes. |
| syncRow / dueEntries via SYNC_COLUMNS | `worker/src/save.mjs:77` | REUSE | V1 already carries description to the sync rule. |

### Prefactoring
Not applicable: The name is one expression in syncOne; extracting it into expenseName is part of this change, not a separate behaviour-preserving step.

### Agreement analysis
| Contract | Role | Locator | Decision | Reason |
|---|---|---|---|---|
| hr.expense create vals sent to Odoo | producer | `worker/src/sync.mjs:143` | MIGRATED | name gains ' - <description>' before the mark when there is a description; every other member is unchanged. |
| The mark search domain [['name','like','[ike:<id>]']] | consumer | `worker/src/sync.mjs:117` | UNCHANGED_COMPATIBLE | Substring match on the mark still finds both name forms. |

### Boundaries
- Driving port: The Cloudflare cron (scheduled handler) and the Retry route, both through syncOne
- Driven port: Odoo XML-RPC execute_kw (hr.expense search_read and create)
- Driven port: Cloudflare D1 binding DB, table entry
- Dependency direction: index.mjs -> sync.mjs -> {save.mjs, odoo.mjs}; expenseName is pure and depends on nothing.
- Failure: Condition: Odoo refuses or does not answer the create | Outcome: Retry | Observation: Unchanged: the entry stays 'Not sent' with its next retry time; the next attempt finds any created expense by its mark.

### Acceptance supports
- `worker/wrangler.json`
- `worker/migrations/0001_init.sql`

### Public oracle
Observation: The draft hr.expense created for an entry with a description is named '<category> - <description> [ike:<id>]'; one for an entry without a description keeps '<category> [ike:<id>]'.

Stimulus: Post two entries through HTTP to a real workerd Worker with every migration applied — 'Fuel / Petrol' with description '  Boat   trip to Male  ' and 'Water' with none — then trigger the cron port with ODOO_URL bound to a fake Odoo; then trigger it again.

Expected: Exactly two hr.expense creates: names 'Fuel / Petrol - Boat trip to Male [ike:<id1>]' and 'Water [ike:<id2>]'; the second cron run creates nothing new; both entries show 'Draft'; the set of Odoo methods called is authenticate, search_read, create.

Falsifier: A name without the description when one was stored, a name with ' - ' when none was, the mark not last, a second create on the second run, or any other create member changing.

### Oracle and verification
Oracle target locator: `tests/expenses-description-odoo.test.mjs::the_draft_expense_name_carries_the_description`

Verification command: `npm install --no-audit --no-fund`
Verification command: `node --test tests/expenses-description-odoo.test.mjs`
## V1 Clean description in Odoo

### Purpose
Show the accountant only what staff typed in Odoo's Description column, and keep duplicate protection by moving the entry's mark into the expense's Internal Notes.

### Constraints
- D21: hr.expense name is exactly the stored description when it is non-empty, and exactly the category when it is ''. No mark, no separator.
- D21: hr.expense description (Odoo 'Internal Notes', stored text) is exactly '[ike:<client_entry_id>]'.
- D8 + D21: the search before every create is [['description','like','[ike:<client_entry_id>]']] with fields ['id','state'] and limit 2; a found expense is adopted, never re-created.
- D5/D18: every other create member is unchanged; the Worker still calls only authenticate, search_read and create.
- The receipt attachment name stays 'receipt [ike:<client_entry_id>]'. The status read-back (by stored Odoo id) is unchanged.

### Targets
| Path | Decision | Reason |
|---|---|---|
| `worker/src/sync.mjs` | EXTEND | syncOne builds the hr.expense create vals and runs the mark search; expenseName decides the name. |

### Paradigm
functional

### Decisions
- expenseName(category, description) in worker/src/sync.mjs:41 drops its mark parameter and returns description when it is a non-empty string, otherwise category. Its doc comment cites D21.
- syncOne (worker/src/sync.mjs:113) sends name: expenseName(row.category, row.description) and adds description: mark to the hr.expense create vals at worker/src/sync.mjs:154. Odoo's hr.expense field `description` is 'Internal Notes', stored, writable, type text on saas-19.4 (fields_get read 2026-10-08).
- The mark search at worker/src/sync.mjs:129 becomes [[['description', 'like', mark]]]; its comment says the mark lives in Internal Notes so the name stays the staff's words.
- markFor, the receipt attachment name `receipt ${mark}` and worker/src/readback.mjs are unchanged.
- The oracle step owns the earlier oracles that pin the old shape and migrates them in place, since this Request replaces the behaviour they assert: tests/worker-odoo-sync.test.mjs (name 'Salary [ike:ce-a]' at :472, search domain on name at :494, lost-answer filters by name at :596 and :605), tests/expenses-description-odoo.test.mjs (the '<category> - <description> <mark>' names at :414-435 and :517, the name-based search domain at :450, the declared create members at :464, 'description' absent from vals at :477, the name filters at :515 and :524), tests/worker-status-readback.test.mjs:590 (counts expenses by mark in name), and tests/odoo-live-schema-retry.test.mjs:844 (selects the entry's create by the id in its name). Each keeps its intent with the mark read from the expense's description field instead of its name. These four migrated files are declared acceptance supports of this value, so the candidate carries their migrated bytes.

### Reuse analysis
| Symbol | Locator | Decision | Reason |
|---|---|---|---|
| markFor | `worker/src/sync.mjs:31` | REUSE | The mark is still derived from client_entry_id, never stored in D1. |
| expenseName | `worker/src/sync.mjs:41` | EXTEND | The one place the name is decided; its rule changes to D21. |
| syncOne | `worker/src/sync.mjs:113` | EXTEND | The one place an hr.expense is searched for and created. |

### Prefactoring
Not applicable: The change is two expressions and one domain in syncOne plus the expenseName body; nothing needs moving first.

### Agreement analysis
| Contract | Role | Locator | Decision | Reason |
|---|---|---|---|---|
| hr.expense create vals sent to Odoo | producer | `worker/src/sync.mjs:154` | MIGRATED | name loses the category prefix and the mark; description (Internal Notes) gains the mark; every other member is unchanged. |
| The mark search domain | consumer | `worker/src/sync.mjs:129` | MIGRATED | Searches description instead of name, where the producer now puts the mark. |
| Expenses created before this change (mark in name, already holding a stored Odoo id) | consumer | `worker/src/readback.mjs:74` | UNCHANGED_COMPATIBLE | Read-back is by stored id, never by mark, so old names need no change. |

### Boundaries
- Driving port: The Cloudflare cron (scheduled handler) and the Retry route, both through syncOne
- Driven port: Odoo XML-RPC execute_kw (hr.expense search_read and create)
- Driven port: Cloudflare D1 binding DB, table entry
- Dependency direction: index.mjs -> sync.mjs -> {save.mjs, odoo.mjs}; expenseName is pure and depends on nothing.
- Failure: Condition: Odoo commits the create but its answer is lost | Outcome: Retry | Observation: The entry stays 'Not sent'; the retry finds the expense by the mark in its Internal Notes and adopts it, so there is still one expense.

### Acceptance supports
- `worker/wrangler.json`
- `worker/migrations/0001_init.sql`
- `worker/migrations/0002_description.sql`
- `tests/worker-odoo-sync.test.mjs`
- `tests/expenses-description-odoo.test.mjs`
- `tests/worker-status-readback.test.mjs`
- `tests/odoo-live-schema-retry.test.mjs`

### Public oracle
Observation: The draft hr.expense is named exactly what staff typed, or the category when they typed nothing; its Internal Notes hold the mark alone; the duplicate search reads Internal Notes, so a lost create answer or a second cron run never makes a second expense.

Stimulus: Post through HTTP to a real workerd Worker with every migration applied: 'Water' with description '  Nagaraj  ', 'Meals' with none, 'Fuel / Petrol' with description 'Boat trip to Male' and a JPEG receipt; trigger the cron port with ODOO_URL bound to a saas-19.4 fake Odoo; then set the fake to commit a create and drop its answer for a fourth entry, retry it, and trigger the cron again.

Expected: Names 'Nagaraj', 'Meals', 'Boat trip to Male'; each expense's description is exactly '[ike:<its id>]'; no name contains '[ike:'; every hr.expense search before a create is [['description','like','[ike:<id>]']]; the lost-answer entry ends with exactly one expense and is adopted; the second cron run creates nothing; the receipt attachment is named 'receipt [ike:<id>]' with matching size and checksum; methods called are only authenticate, search_read, create.

Falsifier: A name holding the category with a description, a separator, or the mark; Internal Notes empty or holding more than the mark; a search on name; a second expense for one entry; any other create member changing.

### Oracle and verification
Oracle target locator: `tests/expenses-clean-name-odoo.test.mjs::the_odoo_description_is_only_what_staff_typed`

Verification command: `npm install --no-audit --no-fund`
Verification command: `node --test tests/expenses-clean-name-odoo.test.mjs tests/worker-odoo-sync.test.mjs tests/expenses-description-odoo.test.mjs tests/worker-status-readback.test.mjs tests/odoo-live-schema-retry.test.mjs`
