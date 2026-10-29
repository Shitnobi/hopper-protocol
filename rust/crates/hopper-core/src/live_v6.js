/* FROGGER v6 fold — the whole game state, from ord's recursive endpoints.
 *
 * Pure part: foldFrog(input) is synchronous, network-free, and pinned to
 * the Rust implementation by tests/v6_fold_vectors.json.
 * Browser part: boot() wires it to /r/… on the viewer's own ord node.
 *
 * No external host appears anywhere in this file or in the document that
 * embeds it. If any fetch fails, the static card stays and never claims
 * the frog is alive.
 */
"use strict";

/* ------------------------------ integer core ------------------------- */

function requiredAt(h, p) {
  if (h <= p.g) return p.b;
  var a1 = p.g + (p.u1 - p.b) * p.s1;
  var a2 = a1 + (p.u2 - p.u1) * p.s2;
  var a3 = a2 + (p.cap - p.u2) * p.s3;
  if (h < a1) return p.b + Math.floor((h - p.g) / p.s1);
  if (h < a2) return p.u1 + Math.floor((h - a1) / p.s2);
  if (h < a3) return p.u2 + Math.floor((h - a2) / p.s3);
  return p.cap;
}

function deathBps(target, p) {
  var t = target > p.cap ? p.cap : target;
  return p.bps[t];
}

function hexToBytes(hex) {
  var out = new Uint8Array(hex.length >> 1);
  for (var i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function le8(n) {
  var b = new Uint8Array(8);
  var v = BigInt(n);
  for (var i = 0; i < 8; i++) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
}

function concat(parts) {
  var len = 0, i;
  for (i = 0; i < parts.length; i++) len += parts[i].length;
  var out = new Uint8Array(len), at = 0;
  for (i = 0; i < parts.length; i++) {
    out.set(parts[i], at);
    at += parts[i].length;
  }
  return out;
}

/* SHA256("FRG3-CROSS" ‖ u64LE(sat) ‖ H(B) internal) — identical to
 * frogger_core::settle::cross_digest. The hash argument is the display
 * hex ord returns, so it is reversed to internal byte order first. */
async function isDead(sat, blockHashHex, target, p) {
  var msg = concat([
    new TextEncoder().encode("FRG3-CROSS"),
    le8(sat),
    hexToBytes(blockHashHex).reverse(),
  ]);
  var d = new Uint8Array(await crypto.subtle.digest("SHA-256", msg));
  var x =
    (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0;
  return BigInt(x) * 10000n < (BigInt(deathBps(target, p)) << 32n);
}

/* --------------------------- the fold itself ------------------------- */
/*
 * input = {
 *   sat: number,
 *   id: "<64 hex>i<n>",                     // the mint inscription
 *   tip: number,                            // /r/blockheight
 *   me: { satpoint: "txid:vout:off" },      // /r/inscription/{id}
 *   children: [{ id, height, sequence, satpoint, bodyOk }],
 *   hash: {<height>: "<display hex>"},      // /r/blockhash/{T+1}
 *   p: <params>
 * }
 * returns { state, dist, target, pending, reason }
 */
async function foldFrog(input) {
  var p = input.p;
  var seen = (input.children || [])
    .filter(function (c) {
      return (
        c.bodyOk === true &&
        c.height != null &&
        input.me &&
        input.me.satpoint &&
        c.satpoint === input.me.satpoint
      );
    })
    .sort(function (a, b) {
      return a.height - b.height || a.sequence - b.sequence;
    });

  var state = "idle";
  var dist = 0;

  for (var i = 0; i < seen.length; i++) {
    var c = seen[i];
    var T = c.height;
    var t = requiredAt(T, p);
    if (T + p.fin > input.tip) {
      return { state: "crossing", dist: dist, target: t, pending: true };
    }
    var h = input.hash[String(T + 1)];
    if (!h) {
      return { state: "crossing", dist: dist, target: t, pending: true, reason: "missing hash" };
    }
    if (await isDead(input.sat, h, t, p)) {
      return { state: "dead", dist: dist, target: t, pending: false };
    }
    dist += 1;
    if (dist >= t) {
      return { state: "home", dist: dist, target: t, pending: false };
    }
    state = "idle";
  }
  /* On the bank: the honest requirement is what the NEXT crossing will be
   * judged against (`required(tip + 1)`, the height the wallet previews
   * with), never the frozen target of a crossing that already happened. */
  return { state: state, dist: dist, target: requiredAt((input.tip || 0) + 1, p), pending: false };
}

/* ------------------------------- browser ----------------------------- */

/* The embedding document defines `V6 = {sat, p}` BEFORE this file runs
 * (`live_v6_html`, `<script>var V6={sat:…,p:{…}};` then this source in
 * the same script tag). This file must NEVER assign V6: `var V6 = {…}`
 * here is hoisted into the same global scope and *overwrites* the
 * document's values with sat=0 / p=null — the fold then throws on
 * `p.g`, the catch swallows it, and the card stays in the quantum
 * alive/dead animation forever. That is the v6.0 bug (every frog
 * inscribed before the fix renders quantum on any ord explorer).
 * Pinned by `tests/v6_doc_boot.mjs`. */
if (typeof V6 === "undefined") {
  var V6 = { sat: 0, p: null };
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
 * /content path is. Try the recursive endpoint first (it is the one that
 * stays available when recursion is on) and fall back; a fold that only
 * knew /r/content saw zero crossings on a real server. */
function contentBytes(id) {
  return fetch("/r/content/" + id, { credentials: "omit" }).then(function (r) {
    if (r.ok) return r.arrayBuffer();
    return fetch("/content/" + id, { credentials: "omit" }).then(function (r2) {
      if (!r2.ok) throw new Error("content " + r2.status);
      return r2.arrayBuffer();
    });
  });
}

function txt(url) {
  return fetch(url, { credentials: "omit" }).then(function (r) {
    if (!r.ok) throw new Error(url + ": " + r.status);
    return r.text();
  });
}

function displayTxid(internalBytes) {
  return Array.prototype.map
    .call(internalBytes.slice().reverse(), function (b) {
      return ("0" + b.toString(16)).slice(-2);
    })
    .join("");
}

/* A child is genuine only if it is the canonical v6 crossing body for
 * this frog. Content is fetched, not trusted by parent tag alone. */
function bodyOk(body, sat, id) {
  if (!body || body.length !== 54) return false;
  var magic = body.slice(0, 9);
  var want = "FRG6CROSS";
  for (var i = 0; i < 9; i++) if (magic[i] !== want.charCodeAt(i)) return false;
  if (body[9] !== 6) return false;
  var view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  /* sat is u64: compare both 32-bit halves. */
  if (view.getUint32(10, true) !== (sat >>> 0)) return false;
  if (view.getUint32(14, true) !== Math.floor(sat / 4294967296)) return false;
  var mint = displayTxid(body.slice(18, 50));
  var idx = view.getUint32(50, true);
  var parts = id.split("i");
  return mint === parts[0] && idx === Number(parts[1]);
}

function paint(state, target, dist) {
  var root = document.documentElement;
  root.setAttribute("data-frogger", state);
  root.setAttribute("data-frogger-target", String(target));
  root.setAttribute("data-frogger-dist", String(dist));
  var band = document.getElementById("band");
  if (!band) return;
  if (state === "idle") band.textContent = "ON THE BANK — " + dist + "/" + target;
  else if (state === "crossing") band.textContent = "ON THE ROAD — " + dist + "/" + target;
  else if (state === "dead") band.textContent = "ROADKILL";
  else if (state === "home") band.textContent = "HOME — IMMORTAL";
}

async function boot() {
  if (!window.crypto || !crypto.subtle) return;
  if (typeof V6 === "undefined" || !V6 || !V6.p) return;
  var id = qid();
  if (!id) return;
  try {
    var p = V6.p;
    var tip = await getJson("/r/blockheight");
    var me = await getJson("/r/inscription/" + id);
    // ord >= 0.22 answers /r/children with {"ids":[...],"more":bool}
    // (older builds sent a bare array), so read both shapes and follow
    // the pagination cursor. A fold that assumed an array would see
    // zero crossings on every real ord server.
    var ids = [];
    var page = 0;
    for (;;) {
      var resp = await getJson("/r/children/" + id + (page ? "?page=" + page : ""));
      var list = Array.isArray(resp) ? resp : (resp && resp.ids) || [];
      ids = ids.concat(list);
      if (Array.isArray(resp) || !resp || !resp.more || page >= 100) break;
      page += 1;
    }
    var children = [];
    for (var i = 0; i < ids.length; i++) {
      var cid = ids[i];
      var meta = await getJson("/r/inscription/" + cid);
      var ok = false;
      try {
        var bytes = new Uint8Array(await contentBytes(cid));
        ok = bodyOk(bytes, V6.sat, id);
      } catch (e) {
        ok = false;
      }
      children.push({
        id: cid,
        height: meta.height,
        sequence: meta.sequence_number || 0,
        satpoint: meta.satpoint,
        bodyOk: ok,
      });
    }
    var hash = {};
    for (var j = 0; j < children.length; j++) {
      var h = children[j].height;
      if (h != null && !hash[String(h + 1)]) {
        try {
          hash[String(h + 1)] = await getJson("/r/blockhash/" + (h + 1));
        } catch (e) {
          /* leave missing: fold reports pending */
        }
      }
    }
    var r = await foldFrog({
      sat: V6.sat,
      id: id,
      tip: tip,
      me: me,
      children: children,
      hash: hash,
      p: p,
    });
    paint(r.state, r.target, r.dist);
  } catch (e) {
    /* the static card is the honest fallback */
  }
}

if (typeof document !== "undefined" && !window.__froggerV6Boot) {
  window.__froggerV6Boot = true;
  document.addEventListener("DOMContentLoaded", boot);
  if (document.readyState !== "loading") boot();
}
