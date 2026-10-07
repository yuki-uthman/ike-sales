// A hand-written XML-RPC codec over web APIs only, because workerd has no XML
// parser (no DOMParser, no XMLHttpRequest; HTMLRewriter parses HTML only).
// Pure: knows nothing of fetch, URLs, D1 or the Odoo credentials (decision 3).
//
// Money never crosses this module as a JS float. It is encoded from exact
// decimal TEXT through `decimal()` and decoded out of <double> as TEXT.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

function escapeText(value) {
  return String(value).replace(/[&<>]/g, c => ESCAPES[c]);
}

function unescapeText(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const DECIMAL = '__xmlrpc_decimal';

/** An exact decimal, encoded verbatim as <double> — never through Number. */
export function decimal(text) {
  return { [DECIMAL]: true, text: String(text) };
}

function isDecimal(value) {
  return value !== null && typeof value === 'object' && value[DECIMAL] === true;
}

export function encodeValue(value) {
  if (value === null || value === undefined) return '<value><nil/></value>';
  if (isDecimal(value)) return `<value><double>${escapeText(value.text)}</double></value>`;
  if (typeof value === 'boolean') {
    return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('xmlrpc: a non-finite number');
    if (Number.isInteger(value)) return `<value><int>${value}</int></value>`;
    throw new Error('xmlrpc: a fractional number must be a decimal(), not a float');
  }
  if (typeof value === 'string') return `<value><string>${escapeText(value)}</string></value>`;
  if (Array.isArray(value)) {
    return '<value><array><data>'
      + value.map(encodeValue).join('')
      + '</data></array></value>';
  }
  const members = Object.keys(value)
    .map(key => `<member><name>${escapeText(key)}</name>${encodeValue(value[key])}</member>`)
    .join('');
  return `<value><struct>${members}</struct></value>`;
}

/** The request body for one <methodCall>. */
export function encodeMethodCall(name, params) {
  return '<?xml version="1.0"?><methodCall>'
    + `<methodName>${escapeText(name)}</methodName><params>`
    + params.map(p => `<param>${encodeValue(p)}</param>`).join('')
    + '</params></methodCall>';
}

// ---------------------------------------------------------------- decoding

function skipSpace(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i++;
  return i;
}

function readTag(s, i) {
  if (s[i] !== '<') throw new Error('xmlrpc: expected a tag');
  const close = s.indexOf('>', i);
  if (close < 0) throw new Error('xmlrpc: unterminated tag');
  return { name: s.slice(i + 1, close).trim(), next: close + 1 };
}

function readUntil(s, i, needle) {
  const at = s.indexOf(needle, i);
  if (at < 0) throw new Error(`xmlrpc: missing ${needle}`);
  return { text: s.slice(i, at), next: at + needle.length };
}

function scalar(tag, raw) {
  if (tag === 'int' || tag === 'i4' || tag === 'i8') {
    const n = parseInt(raw.trim(), 10);
    if (!Number.isFinite(n)) throw new Error('xmlrpc: a malformed integer');
    return n;
  }
  if (tag === 'boolean') return raw.trim() === '1';
  if (tag === 'double') return raw.trim();       // exact decimal TEXT, never a float
  if (tag === 'string' || tag === 'base64' || tag === 'dateTime.iso8601') {
    return unescapeText(raw);
  }
  throw new Error(`xmlrpc: an unknown value type <${tag}>`);
}

function parseValue(s, start) {
  let i = skipSpace(s, start);
  const open = readTag(s, i);
  if (open.name !== 'value') throw new Error('xmlrpc: expected <value>');
  i = skipSpace(s, open.next);

  // An untyped <value>text</value> is a string.
  if (s[i] !== '<') {
    const body = readUntil(s, i, '</value>');
    return { value: unescapeText(body.text), next: body.next };
  }

  const inner = readTag(s, i);
  let value;
  if (inner.name.endsWith('/')) {
    const bare = inner.name.slice(0, -1).trim();
    i = inner.next;
    if (bare === 'nil') value = null;
    else if (bare === 'array') value = [];
    else if (bare === 'struct') value = {};
    else value = scalar(bare, '');
  } else if (inner.name === 'array') {
    value = [];
    i = skipSpace(s, inner.next);
    const data = readTag(s, i);
    if (data.name === 'data/') {
      i = data.next;
    } else {
      if (data.name !== 'data') throw new Error('xmlrpc: expected <data>');
      i = data.next;
      for (;;) {
        i = skipSpace(s, i);
        if (s.startsWith('</data>', i)) { i += '</data>'.length; break; }
        const item = parseValue(s, i);
        value.push(item.value);
        i = item.next;
      }
    }
    i = skipSpace(s, i);
    const end = readTag(s, i);
    if (end.name !== '/array') throw new Error('xmlrpc: expected </array>');
    i = end.next;
  } else if (inner.name === 'struct') {
    value = {};
    i = inner.next;
    for (;;) {
      i = skipSpace(s, i);
      if (s.startsWith('</struct>', i)) { i += '</struct>'.length; break; }
      const member = readTag(s, i);
      if (member.name !== 'member') throw new Error('xmlrpc: expected <member>');
      i = skipSpace(s, member.next);
      const nameTag = readTag(s, i);
      if (nameTag.name !== 'name') throw new Error('xmlrpc: expected <name>');
      const nameBody = readUntil(s, nameTag.next, '</name>');
      const item = parseValue(s, nameBody.next);
      value[unescapeText(nameBody.text)] = item.value;
      i = skipSpace(s, item.next);
      const memberEnd = readTag(s, i);
      if (memberEnd.name !== '/member') throw new Error('xmlrpc: expected </member>');
      i = memberEnd.next;
    }
  } else {
    const body = readUntil(s, inner.next, `</${inner.name}>`);
    value = scalar(inner.name, body.text);
    i = body.next;
  }

  i = skipSpace(s, i);
  const close = readTag(s, i);
  if (close.name !== '/value') throw new Error('xmlrpc: expected </value>');
  return { value, next: close.next };
}

/**
 * Decode one <methodResponse>. A <fault> is an answer, not a throw: the port
 * turns it into the closed code `odoo_fault`. Anything unparseable throws, and
 * the port turns that into `odoo_bad_answer`.
 */
export function decodeMethodResponse(xml) {
  if (typeof xml !== 'string') throw new Error('xmlrpc: a non-text answer');
  const faultAt = xml.indexOf('<fault>');
  if (faultAt >= 0) {
    return { fault: parseValue(xml, faultAt + '<fault>'.length).value };
  }
  const paramAt = xml.indexOf('<param>');
  if (paramAt < 0) throw new Error('xmlrpc: no <param> and no <fault>');
  return { value: parseValue(xml, paramAt + '<param>'.length).value };
}
