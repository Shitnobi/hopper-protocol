/* HOPPER v8 fold — the whole game state, from ord's recursive endpoints.
 *
 * Pure part: foldFrog(input) is synchronous, network-free, and pinned to
 * the Rust implementation. The road's wrap is a function of a block hash,
 * so the fold needs no async hashing and never asks the indexer what
 * happened.
 *
 * Browser part: boot() wires it to /r/… on the viewer's own ord node.
 *
 * No external host appears anywhere in this file or in the document that
 * embeds it. If any fetch fails, the static card stays and never claims
 * the Hopper is alive.
 */
"use strict";

/* ------------------------------ integer core ------------------------- */

function generationStart(p, k) {
  return p.g + (k - 1) * p.gl;
}

function generationAt(h, p) {
  if (h < p.g) return 1;
  return 1 + Math.floor((h - p.g) / p.gl);
}

function requiredAt(h, p) {
  if (h < p.g) return p.b;
  var s = generationStart(p, generationAt(h, p));
  var r = p.b + Math.floor((h - s) / p.gi);
  return r > p.cap ? p.cap : r;
}

function hexToBytes(hex) {
  var out = new Uint8Array(hex.length >> 1);
  for (var i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/* wrap(B) = u32LE(H(B)_internal[0..4]) mod 3. The caller supplies the
 * display hex ord returns; internal order is the reverse. */
function wrapOfHashHex(displayHex) {
  var b = hexToBytes(displayHex);
  var x =
    ((b[31] | (b[30] << 8) | (b[29] << 16) | (b[28] << 24)) >>> 0);
  return x % 3;
}

/* --------------------------- the fold itself ------------------------- */
/*
 * input = {
 *   sat: number,
 *   tip: number,                            // /r/blockheight
 *   me: { satpoint: "txid:vout:off" },      // /r/inscription/{id}
 *   children: [{ height, sequence, satpoint, bodyOk, dir }],
 *   hash: {<height>: "<display hex>"},      // /r/blockhash/{T+1}
 *   p: <params>
 * }
 * returns { state, dist, dir, target, pending }
 */
function foldFrog(input) {
  var p = input.p;
  var targetNow = requiredAt((input.tip || 0) + 1, p);
  function unverified(reason) {
    return {
      state: "unverified", dist: 0, dir: null, target: targetNow,
      pending: true, reason: reason,
    };
  }
  if (input.incomplete) return unverified("incomplete children");
  var all = input.children || [];
  var bodyValid = all.filter(function (c) { return c && c.bodyOk === true; });
  // A body-valid child whose witness/transaction cannot be proven must
  // stop the fold. Skipping it could hide a death and reach a false HOME.
  if (bodyValid.some(function (c) { return c.proofOk !== true; })) {
    return unverified("unverified child");
  }
  var seen = bodyValid
    .filter(function (c) {
      return (
        c.dir === c.dir && c.dir >= 0 && c.dir <= 2 &&
        c.height != null &&
        input.me && input.me.satpoint &&
        c.satpoint === input.me.satpoint
      );
    })
    .sort(function (a, b) {
      return a.height - b.height || (a.sequence || 0) - (b.sequence || 0);
    });

  var state = "idle";
  var dist = 0;
  var lastT = null;
  var txids = {};

  for (var i = 0; i < seen.length; i++) {
    var c = seen[i];
    var T = c.height;
    // One crossing per transaction and at least cross_finality blocks
    // between accepted crossings. A second crossing while the first is
    // in flight is invalid and must never be counted.
    if (c.id && txids[c.id]) return unverified("duplicate crossing");
    if (lastT !== null && T - lastT < p.fin) return unverified("crossing before finality");
    var t = requiredAt(T, p);
    if (T + p.fin > input.tip) {
      return { state: "crossing", dist: dist, dir: c.dir, target: t, pending: true };
    }
    var h = input.hash[String(T + 1)];
    if (!h) {
      return {
        state: "crossing", dist: dist, dir: c.dir, target: t, pending: true,
        reason: "missing hash",
      };
    }
    if (c.dir === wrapOfHashHex(h)) {
      return { state: "dead", dist: dist, dir: c.dir, target: t, pending: false };
    }
    dist += 1;
    if (c.id) txids[c.id] = true;
    lastT = T;
    if (dist >= t) {
      return { state: "home", dist: dist, dir: c.dir, target: t, pending: false };
    }
    state = "idle";
  }
  return {
    state: state, dist: dist, dir: null,
    target: requiredAt((input.tip || 0) + 1, p), pending: false,
  };
}

/* -------------------- v8 proof helpers (raw tx) --------------------- */

var NUMS = hexToBytes("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");

function concatBytes(list) {
  var n = 0, i;
  for (i = 0; i < list.length; i++) n += list[i].length;
  var out = new Uint8Array(n), at = 0;
  for (i = 0; i < list.length; i++) { out.set(list[i], at); at += list[i].length; }
  return out;
}

function bytesEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function utf8(s) { return new TextEncoder().encode(s); }

function sha256(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then(function (b) {
    return new Uint8Array(b);
  });
}

function taggedHash(tag, parts) {
  return sha256(utf8(tag)).then(function (th) {
    var list = [th, th].concat(parts);
    return sha256(concatBytes(list));
  });
}

function compactSize(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 255, (n >> 8) & 255);
  var out = new Uint8Array(5); out[0] = 0xfe;
  for (var i = 0; i < 4; i++) out[i + 1] = (n >>> (8 * i)) & 255;
  return out;
}

function leafHash(script) {
  return taggedHash("TapLeaf", [Uint8Array.of(0xc0), compactSize(script.length), script]);
}

function branchHash(a, b) {
  var x = a, y = b, i;
  for (i = 0; i < 32; i++) {
    if (a[i] < b[i]) { x = a; y = b; break; }
    if (a[i] > b[i]) { x = b; y = a; break; }
  }
  return taggedHash("TapBranch", [x, y]);
}

function pushBytes(out, data) {
  var len = data.length;
  if (len === 0) out.push(0x00);
  else if (len <= 75) { out.push(len); for (var i = 0; i < len; i++) out.push(data[i]); }
  else if (len <= 255) { out.push(0x4c, len); for (var j = 0; j < len; j++) out.push(data[j]); }
  else { out.push(0x4d, len & 255, (len >> 8) & 255); for (var k = 0; k < len; k++) out.push(data[k]); }
}

function parentTag(body) {
  var out = [];
  var mint = body.slice(18, 50);
  for (var i = 0; i < 32; i++) out.push(mint[i]);
  var idx = body[50] | (body[51] << 8) | (body[52] << 16) | (body[53] << 24);
  var n = 4;
  while (n > 0 && ((idx >>> (8 * (n - 1))) & 255) === 0) n -= 1;
  for (var j = 0; j < n; j++) out.push((idx >>> (8 * j)) & 255);
  return Uint8Array.from(out);
}

function buildEnvelope(body) {
  var out = [0x00, 0x63];
  pushBytes(out, utf8("ord"));
  pushBytes(out, Uint8Array.of(0x01));
  pushBytes(out, utf8("application/octet-stream"));
  pushBytes(out, Uint8Array.of(0x03));
  pushBytes(out, parentTag(body));
  pushBytes(out, new Uint8Array(0));
  pushBytes(out, body);
  out.push(0x68);
  return Uint8Array.from(out);
}

function buildLeaf(owner, body) {
  return concatBytes([
    Uint8Array.of(0x20), owner, Uint8Array.of(0xad),
    buildEnvelope(body), Uint8Array.of(0x51),
  ]);
}

function buildSendLeaf(owner) {
  return concatBytes([Uint8Array.of(0x20), owner, Uint8Array.of(0xac)]);
}

function controlPath(hashes, dir) {
  return Promise.all([
    branchHash(hashes[0], hashes[1]),
    branchHash(hashes[2], hashes[3]),
  ]).then(function (branches) {
    var hLS = branches[0], hRX = branches[1];
    if (dir === 0) return [hashes[1], hRX];
    if (dir === 1) return [hashes[0], hRX];
    if (dir === 2) return [hashes[3], hLS];
    return [hashes[2], hLS];
  });
}

function readU32(b, at) {
  return ((b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0);
}

function readVarInt(b, at) {
  var op = b[at];
  if (op < 0xfd) return { value: op, at: at + 1 };
  if (op === 0xfd) return { value: b[at + 1] | (b[at + 2] << 8), at: at + 3 };
  if (op === 0xfe) return { value: readU32(b, at + 1), at: at + 5 };
  var lo = readU32(b, at + 1), hi = readU32(b, at + 5);
  return { value: lo + hi * 4294967296, at: at + 9 };
}

function parseTx(hex) {
  var b = hexToBytes(hex), at = 0;
  var version = readU32(b, at); at += 4;
  var segwit = false;
  if (b[at] === 0x00 && b[at + 1] === 0x01) { segwit = true; at += 2; }
  var nIn = readVarInt(b, at); at = nIn.at;
  var inputs = [];
  for (var i = 0; i < nIn.value; i++) {
    var txid = b.slice(at, at + 32); at += 32;
    var vout = readU32(b, at); at += 4;
    var sl = readVarInt(b, at); at = sl.at;
    var scriptSig = b.slice(at, at + sl.value); at += sl.value;
    var seq = readU32(b, at); at += 4;
    inputs.push({ txid: txid, vout: vout, scriptSig: scriptSig, sequence: seq, witness: [] });
  }
  var nOut = readVarInt(b, at); at = nOut.at;
  var outputs = [];
  for (var j = 0; j < nOut.value; j++) {
    var lo = readU32(b, at), hi = readU32(b, at + 4); at += 8;
    var value = lo + hi * 4294967296;
    var ol = readVarInt(b, at); at = ol.at;
    var script = b.slice(at, at + ol.value); at += ol.value;
    outputs.push({ value: value, script: script });
  }
  if (segwit) {
    for (var k = 0; k < inputs.length; k++) {
      var nw = readVarInt(b, at); at = nw.at;
      var items = [];
      for (var w = 0; w < nw.value; w++) {
        var il = readVarInt(b, at); at = il.at;
        items.push(b.slice(at, at + il.value)); at += il.value;
      }
      inputs[k].witness = items;
    }
  }
  if (at + 4 > b.length) throw new Error("truncated transaction");
  var locktime = readU32(b, at);
  return { version: version, inputs: inputs, outputs: outputs, locktime: locktime };
}

function hasOrdEnvelope(script) {
  if (!script || script.length < 6) return false;
  for (var i = 0; i + 5 < script.length; i++) {
    if (script[i] === 0x00 && script[i + 1] === 0x63 && script[i + 2] === 3
        && script[i + 3] === 0x6f && script[i + 4] === 0x72 && script[i + 5] === 0x64) return true;
  }
  return false;
}

function getText(url) {
  return fetch(url, { credentials: "omit" }).then(function (r) {
    if (!r.ok) throw new Error(url + ": " + r.status);
    return r.text();
  });
}

function no() { return false; }

function verifyChildProof(txid, body, dir) {
  return getText("/r/tx/" + txid).then(function (raw) {
    // ord's recursive /r/tx answers application/json, i.e. a QUOTED hex
    // string. Older builds returned bare hex, so accept both.
    var hex = raw.trim();
    if (hex.charAt(0) === '"') {
      try { hex = JSON.parse(hex); } catch (e) { return no("tx json"); }
    }
    var tx = parseTx(hex);
    if (tx.version !== 2 || tx.locktime !== 0) return no("version/locktime");
    if (!tx.inputs.length || !tx.outputs.length || tx.outputs[0].value <= 0) return no("io");
    var out0script = tx.outputs[0].script;
    if (!out0script || out0script.length !== 34 || out0script[0] !== 0x51 || out0script[1] !== 0x20) {
      return no("output0 is not P2TR");
    }
    for (var s = 0; s < tx.inputs.length; s++) {
      if (tx.inputs[s].sequence !== 0xffffffff) return no("sequence");
    }
    for (var o = 0; o < tx.outputs.length; o++) {
      var os = tx.outputs[o].script;
      if (os && os[0] === 0x6a && os.length >= 6
          && os[1] === 0x46 && os[2] === 0x52 && os[3] === 0x47) return no("frg output");
    }
    var in0 = tx.inputs[0];
    if (!in0 || in0.witness.length < 2) return no("witness");
    var control = in0.witness[in0.witness.length - 1];
    var script = in0.witness[in0.witness.length - 2];
    if (!control || control.length !== 97 || (control[0] & 0xfe) !== 0xc0) return no("control shape");
    if (!bytesEq(control.slice(1, 33), NUMS)) return no("nums");
    if (!script || script.length < 35 || script[0] !== 0x20 || script[33] !== 0xad) return no("script shape");
    var owner = script.slice(1, 33);
    var expected = buildLeaf(owner, body);
    if (!bytesEq(script, expected)) return no("leaf");
    var body0 = body.slice(); body0[54] = 0;
    var body1 = body.slice(); body1[54] = 1;
    var body2 = body.slice(); body2[54] = 2;
    var hashes = [
      leafHash(buildLeaf(owner, body0)),
      leafHash(buildLeaf(owner, body1)),
      leafHash(buildLeaf(owner, body2)),
      leafHash(buildSendLeaf(owner)),
    ];
    return Promise.all(hashes).then(function (h) {
      return controlPath(h, dir).then(function (path) {
        if (!bytesEq(control.slice(33, 65), path[0])) return no("path0");
        if (!bytesEq(control.slice(65, 97), path[1])) return no("path1");
        for (var i = 1; i < tx.inputs.length; i++) {
          for (var w = 0; w < tx.inputs[i].witness.length; w++) {
            if (hasOrdEnvelope(tx.inputs[i].witness[w])) return no("other envelope");
          }
        }
        return true;
      });
    });
  });
}

/* ------------------------------- browser ----------------------------- */

/* The embedding document defines `V8 = {sat, genHint, name, p}` BEFORE
 * this file runs, in the same script tag. This file must NEVER assign V8:
 * a `var V8 = {…}` here is hoisted into the same global scope and
 * overwrites the document's values (the v6.0 bug). Read only. */
if (typeof V8 === "undefined") {
  var V8 = { sat: 0, genHint: 1, name: "", p: null };
}

function qid() {
  var m = location.pathname.match(/([0-9a-fA-F]{64}i\d+)\/*$/);
  return m ? m[1].toLowerCase() : null;
}

function getJson(url) {
  return fetch(url, { credentials: "omit" }).then(function (r) {
    if (!r.ok) throw new Error(url + ": " + r.status);
    return r.json();
  });
}

/* Cursed inscriptions (every first state inscription is one: it is a
 * reinscription) are NOT served under /r/ by ord 0.22.2 — the canonical
 * /content path is. ord 0.22.2 answers the recursive route with 200 and an
 * EMPTY body for these, not 404, so an empty body must also fall back.
 * Without this the fold sees a zero-length child and renders "unverified"
 * forever. */
function contentBytes(id) {
  function canonical() {
    return fetch("/content/" + id, { credentials: "omit" }).then(function (r2) {
      if (!r2.ok) throw new Error("content " + r2.status);
      return r2.arrayBuffer();
    });
  }
  return fetch("/r/content/" + id, { credentials: "omit" }).then(function (r) {
    if (!r.ok) return canonical();
    return r.arrayBuffer().then(function (body) {
      return body.byteLength ? body : canonical();
    });
  });
}

function displayTxid(internalBytes) {
  return Array.prototype.map
    .call(internalBytes.slice().reverse(), function (b) {
      return ("0" + b.toString(16)).slice(-2);
    })
    .join("");
}

/* A child is genuine only if it is the canonical v7 crossing body for
 * this frog. Content is fetched, not trusted by parent tag alone.
 * Returns the direction byte, or -1. */
function parseBody(body, sat, id, allowLegacy) {
  if (!body || body.length !== 55) return null;
  var magic = "";
  for (var m = 0; m < 9; m++) magic += String.fromCharCode(body[m]);
  var legacy = magic === "FRG7CROSS" && body[9] === 7;
  var current = magic === "FRG8CROSS" && body[9] === 8;
  if (!legacy && !current) return null;
  if (legacy && !allowLegacy) return null;
  var view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (view.getUint32(10, true) !== (sat >>> 0)) return null;
  if (view.getUint32(14, true) !== Math.floor(sat / 4294967296)) return null;
  var mint = displayTxid(body.slice(18, 50));
  var idx = view.getUint32(50, true);
  var parts = id.split("i");
  if (mint !== parts[0] || idx !== Number(parts[1])) return null;
  var dir = body[54];
  if (dir > 2) return null;
  return { dir: dir, legacy: legacy };
}

function painter() {
  var root = document.documentElement;
  var band = document.getElementById("band");
  var genEl = document.getElementById("gen");
  return function paint(state, dist, gen) {
    root.setAttribute("data-frogger", state);
    root.setAttribute("data-frogger-dist", String(dist));
    root.setAttribute("data-frogger-gen", "G" + gen);
    if (genEl) genEl.textContent = "G" + gen;
    if (!band) return;
    var name = V8.name || "HOPPER";
    var text = name + " 🛣 " + dist;
    if (state === "unverified") text = name + " 🛣 —";
    if (state === "dead") text = "RIP " + text;
    if (state === "home") text += " HOME";
    band.textContent = text;
  };
}

async function boot() {
  if (!window.crypto) return;
  if (typeof V8 === "undefined" || !V8 || !V8.p) return;
  var id = qid();
  if (!id) return;
  var paint = painter();
  try {
    var p = V8.p;
    var tip = await getJson("/r/blockheight");
    var me = await getJson("/r/inscription/" + id);
    var parent = (me.parents && me.parents[0]) || me.parent || null;
    var mint = parent || id;

    // ord >= 0.22 answers /r/children with {"ids":[...],"more":bool}
    // (older builds sent a bare array), so read both shapes and follow
    // the pagination cursor.
    var ids = [];
    var page = 0;
    var incomplete = false;
    for (;;) {
      var resp = await getJson("/r/children/" + id + (page ? "?page=" + page : ""));
      var list = Array.isArray(resp) ? resp : (resp && resp.ids) || [];
      ids = ids.concat(list);
      if (Array.isArray(resp) || !resp || !resp.more) break;
      if (page >= 100) { incomplete = true; break; }
      page += 1;
    }

    var allowLegacy = V8.sat === (V8.grandfatheredSat || 0) && (V8.grandfatheredSat || 0) > 0;
    var children = [];
    var hash = {};
    for (var i = 0; i < ids.length; i++) {
      var cid = ids[i];
      var meta;
      try { meta = await getJson("/r/inscription/" + cid); }
      catch (e) { incomplete = true; continue; }
      var parsed = null;
      var contentTypeOk = !meta.content_type
        || meta.content_type === "application/octet-stream";
      if (contentTypeOk) {
        try {
          var bytes = new Uint8Array(await contentBytes(cid));
          parsed = parseBody(bytes, V8.sat, id, allowLegacy);
        } catch (e) {
          parsed = null;
        }
      }
      var onSat = Number(meta.sat) === Number(V8.sat)
        && meta.satpoint === me.satpoint;
      var proofOk = false;
      if (parsed && onSat) {
        try {
          proofOk = await verifyChildProof(
            String(cid).split("i")[0], bytes, parsed.dir, parsed.legacy,
          );
        } catch (e) { proofOk = false; }
      }
      var h = meta.height;
      if (h != null && !hash[String(h + 1)]) {
        try {
          hash[String(h + 1)] = await getJson("/r/blockhash/" + (h + 1));
        } catch (e) {
          /* leave missing: fold reports pending */
        }
      }
      children.push({
        id: cid,
        height: h,
        sequence: meta.sequence_number || 0,
        satpoint: meta.satpoint,
        sat: Number(meta.sat),
        bodyOk: !!parsed && onSat,
        dir: parsed ? parsed.dir : -1,
        proofOk: proofOk,
      });
    }

    var r = foldFrog({
      sat: V8.sat,
      tip: tip,
      me: me,
      children: children,
      hash: hash,
      p: p,
      incomplete: incomplete,
    });

    // The authoritative generation is the mint's height; the hint is a
    // display fallback only (SPEC §2.3).
    var gen = generationAt(V8.genHint, p);
    if (mint === id) {
      if (me.height != null) gen = generationAt(me.height, p);
    } else {
      try {
        var mm = await getJson("/r/inscription/" + mint);
        if (mm.height != null) gen = generationAt(mm.height, p);
      } catch (e) {
        /* keep the hint */
      }
    }
    paint(r.state, r.dist, gen);
  } catch (e) {
    /* the static card is the honest fallback */
  }
}

if (typeof document !== "undefined" && !window.__hopperV8Boot) {
  window.__hopperV8Boot = true;
  document.addEventListener("DOMContentLoaded", boot);
  if (document.readyState !== "loading") boot();
}
