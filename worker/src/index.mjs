// The HTTP boundary: the only module that knows Request, Response, headers and
// status codes (decision 17). Every answer is JSON; every answer except the
// origin refusal carries Access-Control-Allow-Origin and Vary: Origin; and
// `saved: true` occurs in exactly one place — the 200 answer to a save, built
// only after the store has already awaited the entry and its receipt.

import { isKnownCategory, listCategories } from './categories.mjs';
import { parseMvrToLaari } from './mvr.mjs';
import {
  listDay,
  maldivesDate,
  recordWrongPin,
  saveEntry,
  windowEnd,
  windowIndex,
  wrongPinMisses,
  WRONG_PIN_LIMIT
} from './save.mjs';
import { runReadBack } from './readback.mjs';
import { runSync, syncEntry } from './sync.mjs';

const RETRY_PATH = /^\/entries\/([^/]+)\/retry$/;

const RECEIPT_CAP_BYTES = 1000000; // the Worker's own declared cap (decision 16)
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Vary': 'Origin'
  };
}

function json(status, body, env, { cors = true } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(cors ? corsHeaders(env) : { 'Vary': 'Origin' })
    }
  });
}

function refuse(status, error, env, extra = {}, headers = {}) {
  const res = json(status, { saved: false, error, ...extra }, env,
    { cors: error !== 'origin_not_allowed' });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

function preflight(env) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(env),
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
    }
  });
}

/** Decode a base64 receipt strictly; null means "not base64". */
function decodeReceipt(value) {
  if (value === undefined || value === null || value === '') {
    return { bytes: null, length: 0 };
  }
  if (typeof value !== 'string') return null;
  if (value.length % 4 !== 0 || !BASE64.test(value)) return null;
  let binary;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, length: bytes.length };
}

/** Constant-time PIN comparison over UTF-8 bytes; the secret is never stored. */
function pinMatches(given, secret) {
  if (typeof given !== 'string' || typeof secret !== 'string') return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(given);
  const b = encoder.encode(secret);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

async function handleSave(request, env) {
  const source = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const index = windowIndex(now);

  // The wrong-PIN budget is read before the comparison, so an exhausted window
  // answers Retry even to a correct PIN, and nothing is saved (decision 11).
  const misses = await wrongPinMisses(env.DB, source, index);
  if (misses >= WRONG_PIN_LIMIT) {
    const end = windowEnd(index);
    const seconds = Math.max(0, Math.ceil((end.getTime() - now) / 1000));
    return refuse(429, 'too_many_wrong_pins', env,
      { retry_at: end.toISOString() }, { 'Retry-After': String(seconds) });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return refuse(422, 'bad_json', env);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return refuse(422, 'bad_json', env);
  }

  if (!pinMatches(body.pin, env.EXPENSE_PIN)) {
    await recordWrongPin(env.DB, source, index);
    return refuse(403, 'wrong_pin', env);
  }

  if (!isKnownCategory(body.category)) {
    return refuse(422, 'unknown_category', env);
  }

  const amountLaari = parseMvrToLaari(body.amount);
  if (amountLaari === null) {
    return refuse(422, 'amount_not_positive_mvr', env);
  }

  const clientEntryId = typeof body.client_entry_id === 'string'
    ? body.client_entry_id.trim()
    : '';
  if (clientEntryId === '') {
    return refuse(422, 'invalid_client_entry_id', env);
  }

  const receipt = decodeReceipt(body.receipt);
  if (receipt === null) {
    return refuse(422, 'bad_receipt_base64', env);
  }
  if (receipt.length > RECEIPT_CAP_BYTES) {
    return refuse(413, 'receipt_too_large', env,
      { receipt_bytes: receipt.length, limit_bytes: RECEIPT_CAP_BYTES });
  }

  let entry;
  try {
    entry = await saveEntry(env.DB, {
      client_entry_id: clientEntryId,
      amount_laari: amountLaari,
      category: body.category,
      receipt: receipt.bytes,
      entry_date: maldivesDate(now),
      saved_at: new Date(now).toISOString()
    });
  } catch (err) {
    return refuse(503, 'not_stored', env, { detail: String(err && err.message || err) });
  }

  // Nothing above was deferred: the row is durable before this is written.
  return json(200, { saved: true, entry }, env);
}

async function handleDay(url, env) {
  const asked = url.searchParams.get('date');
  const date = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : maldivesDate();
  try {
    const entries = await listDay(env.DB, date);
    return json(200, { date, entries }, env);
  } catch (err) {
    return refuse(503, 'not_read', env, { detail: String(err && err.message || err) });
  }
}

/**
 * D12's Retry button. It creates no new data and discloses nothing beyond what
 * GET /entries already serves, so it needs no PIN; it is origin-gated like every
 * other port. `saved: true` still occurs in exactly one place: the save answer.
 */
async function handleRetry(clientEntryId, env) {
  let entry;
  try {
    entry = await syncEntry(env, clientEntryId);
  } catch (err) {
    return refuse(503, 'not_read', env, { detail: String(err && err.message || err) });
  }
  if (!entry) return refuse(404, 'not_found', env);
  return json(200, { entry }, env);
}

export default {
  async fetch(request, env) {
    // Decided before the body is read and before the PIN is read, on every
    // method and path (decision 9). This is the one answer with no CORS header.
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) {
      return refuse(403, 'origin_not_allowed', env);
    }

    if (request.method === 'OPTIONS') return preflight(env);

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/categories') {
      return json(200, { categories: listCategories() }, env);
    }
    if (request.method === 'GET' && url.pathname === '/entries') {
      return handleDay(url, env);
    }
    if (request.method === 'POST' && url.pathname === '/entries') {
      return handleSave(request, env);
    }

    if (request.method === 'POST') {
      const retry = RETRY_PATH.exec(url.pathname);
      if (retry) return handleRetry(decodeURIComponent(retry[1]), env);
    }

    return refuse(404, 'not_found', env);
  },

  // The cron driving port (D13). Both steps are AWAITED rather than deferred to
  // ctx.waitUntil: the schedule's whole job is that run.
  //
  // Sync first, read-back last (decision 14): the sync carries the owner's own
  // promise and must not queue behind a read that can take 10 s, and reading
  // last means an expense created in this very run is already in the id set, so
  // a chip is never a run stale. The read-back is attempted even when the sync
  // step failed — the two steps are independent, so one entry Odoo refuses
  // cannot freeze every chip.
  async scheduled(event, env) {
    try {
      await runSync(env);
    } catch (err) {
      // The read-back is owed its turn regardless.
    }
    await runReadBack(env);
  }
};
