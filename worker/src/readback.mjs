// The status read-back (D12, D13). This module reads Odoo and NEVER writes to
// it: it contains no create, no write and no action_*, and the client it uses is
// wrapped so that any method other than 'search_read' is refused before it can
// reach the wire (decision 11).
//
// Dependency direction: index.mjs -> readback.mjs -> {save.mjs, odoo.mjs}. It
// does not import sync.mjs and sync.mjs does not import it, so the two steps of
// one scheduled run cannot entangle.

import { makeOdooClient } from './odoo.mjs';
import {
  draftEntries,
  markOdooState,
  STATUS_APPROVED,
  STATUS_DRAFT,
  STATUS_REFUSED
} from './save.mjs';

/**
 * D12's mapping, bound value by value in exactly one table. These seven names
 * are this instance's complete hr.expense.state selection; anything else is a
 * word this design has never seen and must not be guessed at.
 */
const STATE_STATUS = {
  draft: STATUS_DRAFT,
  submitted: STATUS_DRAFT,
  approved: STATUS_APPROVED,
  posted: STATUS_APPROVED,
  in_payment: STATUS_APPROVED,
  paid: STATUS_APPROVED,
  refused: STATUS_REFUSED
};

/**
 * The stored status for an Odoo state, or null for anything outside the table.
 * Own-property lookup, so no prototype key can be mistaken for a state; no
 * trimming and no case folding, so 'DRAFT' and 'approved ' map to nothing.
 * Failing closed is the point: an unknown word stays 'Draft' (decision 7).
 */
export function statusForState(state) {
  if (typeof state !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(STATE_STATUS, state)
    ? STATE_STATUS[state]
    : null;
}

/**
 * The read-only view of the Odoo client. Structural, not a matter of inspection:
 * this step cannot write to Odoo even by mistake (decision 11). The code is a
 * member of the closed set and is unobservable outside the Worker — a read-back
 * failure writes nothing, so it can never reach last_error or a response body.
 */
export function readOnly(client) {
  return {
    async call(model, method, args, kwargs) {
      if (method !== 'search_read') {
        return { ok: false, code: 'odoo_method_not_allowed' };
      }
      return client.call(model, method, args, kwargs);
    }
  };
}

/**
 * One pass over the entries that still show 'Draft'. Exactly one read-only call
 * covers every id, and the only write is a chip that actually changed: nothing
 * is written for a state that maps back to 'draft', for an unrecognised state,
 * for an id Odoo no longer returns, or for a failed call (decisions 3, 9, 10).
 */
export async function readBack(db, odoo, rows) {
  if (!rows || rows.length === 0) return { ok: true, moved: 0 };

  const ids = rows.map(r => Number(r.odoo_id));
  const answer = await odoo.call('hr.expense', 'search_read',
    [[['id', 'in', ids]]], { fields: ['id', 'state'] });
  // An Odoo failure moves no chip; the same ids are read again next cron.
  if (!answer.ok) return { ok: false, code: answer.code };
  if (!Array.isArray(answer.value)) return { ok: false, code: 'odoo_bad_answer' };

  const stateById = new Map();
  for (const found of answer.value) {
    if (found && typeof found === 'object') {
      stateById.set(Number(found.id), found.state);
    }
  }

  let moved = 0;
  for (const row of rows) {
    // An id that is absent from the answer is simply skipped.
    if (!stateById.has(Number(row.odoo_id))) continue;
    const status = statusForState(stateById.get(Number(row.odoo_id)));
    if (status === null || status === STATUS_DRAFT) continue;
    await markOdooState(db, { clientEntryId: row.client_entry_id, status });
    moved++;
  }
  return { ok: true, moved };
}

/**
 * The scheduled read-back. Its own Odoo client, so a hung or failed sync step
 * cannot leave it holding a poisoned uid. An empty queue makes no call at all —
 * not even a login to discover there was no work.
 */
export async function runReadBack(env) {
  const rows = await draftEntries(env.DB);
  if (rows.length === 0) return { ok: true, moved: 0 };
  return readBack(env.DB, readOnly(makeOdooClient(env)), rows);
}
