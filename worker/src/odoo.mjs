// The driven port for Odoo's External API over XML-RPC: the ONLY module that
// knows fetch, URLs or the API key (decision 4).
//
// Every answer is {ok: true, value} or {ok: false, code} where code comes from a
// closed set — odoo_unreachable, odoo_timeout, odoo_rate_limited,
// odoo_http_<status>, odoo_fault, odoo_bad_answer, odoo_auth_failed — so no Odoo
// text and no credential can reach a response body, a D1 column or a log line.

import { decodeMethodResponse, encodeMethodCall } from './xmlrpc.mjs';

const TIMEOUT_MS = 10000;

function networkCode(err) {
  const name = err && err.name;
  return name === 'TimeoutError' || name === 'AbortError'
    ? 'odoo_timeout'
    : 'odoo_unreachable';
}

/**
 * One client per run. The uid is cached for the run; the key is read from env on
 * every call and never kept in a module-level variable.
 */
export function makeOdooClient(env) {
  const base = String(env.ODOO_URL || '').replace(/\/+$/, '');
  let uid = null;

  async function post(pathname, name, params) {
    let body;
    try {
      body = encodeMethodCall(name, params);
    } catch {
      return { ok: false, code: 'odoo_bad_answer' };
    }

    let res;
    try {
      res = await fetch(base + pathname, {
        method: 'POST',
        headers: { 'content-type': 'text/xml' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      return { ok: false, code: networkCode(err) };
    }

    if (res.status === 429) return { ok: false, code: 'odoo_rate_limited' };
    if (!res.ok) return { ok: false, code: `odoo_http_${res.status}` };

    let text;
    try {
      text = await res.text();
    } catch (err) {
      return { ok: false, code: networkCode(err) };
    }

    let answer;
    try {
      answer = decodeMethodResponse(text);
    } catch {
      return { ok: false, code: 'odoo_bad_answer' };
    }
    // Odoo's own fault text stays here: only the code travels onwards.
    if ('fault' in answer) return { ok: false, code: 'odoo_fault' };
    return { ok: true, value: answer.value };
  }

  async function authenticate() {
    if (uid !== null) return { ok: true, value: uid };
    const answer = await post('/xmlrpc/2/common', 'authenticate',
      [env.ODOO_DB, env.ODOO_USERNAME, env.ODOO_API_KEY, {}]);
    if (!answer.ok) return answer;
    // The documented failed-auth shape is boolean false, never a crash.
    if (!Number.isInteger(answer.value) || answer.value <= 0) {
      return { ok: false, code: 'odoo_auth_failed' };
    }
    uid = answer.value;
    return { ok: true, value: uid };
  }

  return {
    /** execute_kw(model, method, args, kwargs), authenticating on first use. */
    async call(model, method, args, kwargs = {}) {
      const session = await authenticate();
      if (!session.ok) return session;
      return post('/xmlrpc/2/object', 'execute_kw',
        [env.ODOO_DB, session.value, env.ODOO_API_KEY, model, method, args, kwargs]);
    }
  };
}
