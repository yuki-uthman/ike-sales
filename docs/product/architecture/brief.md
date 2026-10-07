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
