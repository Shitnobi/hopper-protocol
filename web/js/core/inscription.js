// Ord 0.22.2 inscription envelope codec (the subset HOPPER uses).
// Mirrors rust/crates/hopper-core/src/inscription.rs.

import { concatBytes, fromUtf8, utf8 } from './hex.js';

export const PROTOCOL_ID = utf8('ord');
export const MAX_SCRIPT_ELEMENT_SIZE = 520;

export const OP_FALSE = 0x00;
export const OP_PUSHDATA1 = 0x4c;
export const OP_PUSHDATA2 = 0x4d;
export const OP_PUSHDATA4 = 0x4e;
export const OP_IF = 0x63;
export const OP_ENDIF = 0x68;

export const TAG_CONTENT_TYPE = 0x01;
export const TAG_POINTER = 0x02;
export const TAG_PARENT = 0x03;

export function pushBytes(out, data) {
  const len = data.length;
  if (len === 0) out.push(OP_FALSE);
  else if (len <= 75) {
    out.push(len);
    out.push(...data);
  } else if (len <= 255) {
    out.push(OP_PUSHDATA1, len);
    out.push(...data);
  } else {
    if (len > MAX_SCRIPT_ELEMENT_SIZE) throw new Error(`push of ${len} bytes exceeds 520`);
    out.push(OP_PUSHDATA2, len & 255, (len >> 8) & 255);
    out.push(...data);
  }
}

// OP_FALSE OP_IF "ord" [1] content-type [3]* parents [0] body OP_ENDIF
export function buildInscriptionScript(contentType, body, parents = []) {
  const out = [OP_FALSE, OP_IF];
  pushBytes(out, PROTOCOL_ID);
  pushBytes(out, Uint8Array.of(TAG_CONTENT_TYPE));
  pushBytes(out, typeof contentType === 'string' ? utf8(contentType) : contentType);
  for (const parent of parents) {
    pushBytes(out, Uint8Array.of(TAG_PARENT));
    pushBytes(out, parent);
  }
  pushBytes(out, new Uint8Array(0)); // body tag
  const bytes = typeof body === 'string' ? utf8(body) : body;
  for (let at = 0; at < bytes.length; at += MAX_SCRIPT_ELEMENT_SIZE) {
    pushBytes(out, bytes.subarray(at, at + MAX_SCRIPT_ELEMENT_SIZE));
  }
  out.push(OP_ENDIF);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Parser (ord's RawEnvelope semantics; enough to verify what we build)
// ---------------------------------------------------------------------------

function decodeScript(script) {
  const items = [];
  let pos = 0;
  while (pos < script.length) {
    const op = script[pos++];
    if (op === 0x00) { items.push({ push: new Uint8Array(0) }); continue; }
    if (op >= 0x01 && op <= 0x4b) {
      if (script.length < pos + op) return null;
      items.push({ push: script.slice(pos, pos + op) });
      pos += op;
      continue;
    }
    if (op === OP_PUSHDATA1 || op === OP_PUSHDATA2 || op === OP_PUSHDATA4) {
      const width = op === OP_PUSHDATA1 ? 1 : op === OP_PUSHDATA2 ? 2 : 4;
      if (script.length < pos + width) return null;
      let len = 0;
      for (let i = 0; i < width; i++) len |= script[pos + i] << (8 * i);
      pos += width;
      if (script.length < pos + len || len > MAX_SCRIPT_ELEMENT_SIZE) return null;
      items.push({ push: script.slice(pos, pos + len) });
      pos += len;
      continue;
    }
    items.push({ op });
  }
  return items;
}

function parseEnvelope(items, start) {
  let i = start + 2;
  const first = items[i];
  if (!first || !first.push || fromUtf8(first.push) !== 'ord') return null;
  i++;
  const payload = [];
  let pushnum = false;
  while (i < items.length) {
    const item = items[i];
    if (item.op === OP_ENDIF) return buildInscription(payload, pushnum);
    if (item.op === 0x4f) { pushnum = true; payload.push(Uint8Array.of(0x81)); i++; continue; }
    if (item.op >= 0x51 && item.op <= 0x60) {
      pushnum = true; payload.push(Uint8Array.of(item.op - 0x50)); i++; continue;
    }
    if (item.push) { payload.push(item.push); i++; continue; }
    return null;
  }
  return null;
}

function advancePast(items, start) {
  for (let i = start + 2; i < items.length; i++) if (items[i].op === OP_ENDIF) return i + 1;
  return items.length;
}

function buildInscription(payload, pushnum) {
  let bodyAt = payload.findIndex((p, i) => i % 2 === 0 && p.length === 0);
  if (bodyAt < 0) bodyAt = payload.length;
  const fields = new Map();
  let incomplete = false;
  for (let i = 0; i < bodyAt; i += 2) {
    const key = payload[i];
    if (i + 1 >= bodyAt) { incomplete = true; break; }
    const k = fromUtf8(key);
    if (fields.has(k)) fields.set(k, null); // duplicate
    else fields.set(k, payload[i + 1]);
  }
  const bodyParts = payload.slice(bodyAt + 1);
  return {
    content_type: fields.get(String.fromCharCode(TAG_CONTENT_TYPE)) || null,
    pointer: fields.get(String.fromCharCode(TAG_POINTER)) || null,
    parents: [], // collected separately below for tag 3 (duplicates allowed)
    body: bodyParts.length ? concatBytes(bodyParts) : null,
    duplicate_field: [...fields.values()].some((v) => v === null),
    incomplete_field: incomplete,
    pushnum,
    stutter: false,
  };
}

export function parseInscriptions(script) {
  const items = decodeScript(script);
  if (!items) return [];
  const out = [];
  let i = 0;
  while (i < items.length) {
    const a = items[i];
    const b = items[i + 1];
    if (a.push && a.push.length === 0 && b && b.op === OP_IF) {
      const ins = parseEnvelope(items, i);
      if (ins) out.push(ins);
      i = advancePast(items, i);
    } else {
      i++;
    }
  }
  // Parents are tag-3 fields and may repeat; recover them in order with a
  // small second pass over each envelope's payload.
  let envIndex = -1;
  i = 0;
  while (i < items.length) {
    const a = items[i];
    const b = items[i + 1];
    if (a.push && a.push.length === 0 && b && b.op === OP_IF) {
      const ins = parseEnvelope(items, i);
      if (ins) {
        envIndex++;
        const parents = [];
        let j = i + 3;
        while (j < items.length && items[j].op !== OP_ENDIF) {
          const item = items[j];
          if (item.push && fromUtf8(item.push) === String.fromCharCode(TAG_PARENT)) {
            const next = items[j + 1];
            if (next && next.push) parents.push(next.push);
          }
          j++;
        }
        out[envIndex].parents = parents;
      }
      i = advancePast(items, i);
    } else i++;
  }
  return out;
}
