// The sync rule and the run (decision 5). syncOne is one entry, one attempt,
// with the store and the Odoo client injected, so it knows nothing of Request,
// Response or env. The Worker never moves an expense out of draft: the only
// methods it may ever call are authenticate, search_read and create (D5).

import { formatLaariAsMvr } from './mvr.mjs';
import { makeOdooClient } from './odoo.mjs';
import { decimal } from './xmlrpc.mjs';
import {
  dueEntries,
  entryProjection,
  markFailed,
  markSynced,
  receiptBytes,
  isInOdoo,
  syncRow
} from './save.mjs';

/** Minutes until the next try, for attempts 1..6 and then capped (decision 15). */
export const BACKOFF_MINUTES = [15, 30, 60, 120, 240, 360];

export function nextRetryAt(attempts, at) {
  const step = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
  return new Date(at + step * 60000).toISOString();
}

/**
 * The unique mark naming the entry. Derived, never stored, so no column can
 * drift from it; client_entry_id is the D1 primary key (decision 9).
 */
export function markFor(clientEntryId) {
  return `[ike:${clientEntryId}]`;
}

/** The type is sniffed from the first bytes, never taken from the client. */
function sniffMimetype(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50
    && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  return 'application/octet-stream';
}

/** Chunked so String.fromCharCode stays inside its argument limit. */
function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function firstId(value) {
  return Array.isArray(value) && value.length && value[0]
    ? Number(value[0].id)
    : null;
}

/**
 * One entry, one attempt. Either the entry ends up a draft expense it remembers
 * the id of, or it stays saved as 'Not sent' with its next retry time and a
 * closed code. Idempotence is structural: the mark search runs on EVERY attempt,
 * before any create, and a found expense is adopted rather than re-created.
 */
export async function syncOne(db, odoo, row, now = Date.now()) {
  const clientEntryId = row.client_entry_id;
  const mark = markFor(clientEntryId);
  const attempts = Number(row.attempts || 0) + 1;

  const fail = async code => {
    await markFailed(db, {
      clientEntryId,
      attempts,
      nextRetryAt: nextRetryAt(attempts, now),
      code
    });
    return { ok: false, code };
  };

  // (1) Has this entry already become an expense? Substring, so a human editing
  // the description around the mark cannot cause a duplicate.
  const found = await odoo.call('hr.expense', 'search_read',
    [[['name', 'like', mark]]], { fields: ['id', 'state'], limit: 2 });
  if (!found.ok) return fail(found.code);
  let expenseId = firstId(found.value);

  if (expenseId === null) {
    // (2) The category resolves to an expensable product BY NAME at run time.
    const product = await odoo.call('product.product', 'search_read',
      [[['can_be_expensed', '=', true], ['name', '=', row.category]]],
      { fields: ['id'], limit: 1 });
    if (!product.ok) return fail(product.code);
    const productId = firstId(product.value);
    if (productId === null) return fail('odoo_no_product');

    // (3) So does the bank-transfer payment method line.
    const line = await odoo.call('account.payment.method.line', 'search_read',
      [[['name', 'like', row.payment_method_line]]], { fields: ['id'], limit: 1 });
    if (!line.ok) return fail(line.code);
    const lineId = firstId(line.value);
    if (lineId === null) return fail('odoo_no_payment_method_line');

    // (4) No state is written and no action is ever called, so the record is
    // born draft. No currency is sent: MVR is the company currency.
    const created = await odoo.call('hr.expense', 'create', [[{
      name: `${row.category} ${mark}`,
      employee_id: Number(row.employee_id),
      product_id: productId,
      total_amount: decimal(formatLaariAsMvr(Number(row.amount_laari))),
      date: row.entry_date,
      payment_mode: 'company_account',
      payment_method_line_id: lineId
    }]]);
    if (!created.ok) return fail(created.code);
    if (!Number.isInteger(created.value) || created.value <= 0) {
      return fail('odoo_bad_answer');
    }
    expenseId = created.value;
  }

  // (5) The receipt attach is idempotent the same way: an adopted expense is
  // never given a second copy of the same receipt.
  if (Number(row.receipt_bytes || 0) > 0) {
    const existing = await odoo.call('ir.attachment', 'search_read',
      [[['res_model', '=', 'hr.expense'], ['res_id', '=', expenseId]]],
      { fields: ['id'], limit: 1 });
    if (!existing.ok) return fail(existing.code);
    if (firstId(existing.value) === null) {
      const bytes = await receiptBytes(db, clientEntryId);
      if (bytes && bytes.length > 0) {
        const attached = await odoo.call('ir.attachment', 'create', [[{
          name: `receipt ${mark}`,
          res_model: 'hr.expense',
          res_id: expenseId,
          mimetype: sniffMimetype(bytes),
          datas: toBase64(bytes)
        }]]);
        if (!attached.ok) return fail(attached.code);
      }
    }
  }

  await markSynced(db, {
    clientEntryId,
    odooId: expenseId,
    attempts,
    syncedAt: new Date(now).toISOString()
  });
  return { ok: true, odoo_id: expenseId };
}

/** The configuration the rule needs, carried on the row rather than read by it. */
function withConfig(env, row) {
  return {
    ...row,
    employee_id: env.ODOO_EMPLOYEE_ID,
    payment_method_line: env.ODOO_PAYMENT_METHOD_LINE
  };
}

/**
 * The scheduled run. Each entry is attempted inside its own try/catch, so one
 * bad entry cannot block the rest of the run.
 */
export async function runSync(env, now = Date.now()) {
  const odoo = makeOdooClient(env);
  const rows = await dueEntries(env.DB, new Date(now).toISOString());
  const results = [];
  for (const row of rows) {
    try {
      results.push(await syncOne(env.DB, odoo, withConfig(env, row), Date.now()));
    } catch (err) {
      results.push({ ok: false, code: 'not_attempted' });
    }
  }
  return results;
}

/**
 * One entry, now: D12's Retry button. It sends even when the scheduled time is
 * in the future, and an entry already in Odoo — whatever chip the read-back has
 * since given it — is answered with its projection and zero Odoo calls, so a
 * Retry can never pull an Approved chip back to 'Draft'. The status vocabulary
 * stays the single authority: this asks it rather than comparing to one word.
 * Null means no such entry was ever saved.
 */
export async function syncEntry(env, clientEntryId) {
  const row = await syncRow(env.DB, clientEntryId);
  if (!row) return null;
  if (!isInOdoo(row.status)) {
    const odoo = makeOdooClient(env);
    try {
      await syncOne(env.DB, odoo, withConfig(env, row), Date.now());
    } catch (err) {
      // The answer is made out of the store either way.
    }
  }
  return entryProjection(env.DB, clientEntryId);
}
