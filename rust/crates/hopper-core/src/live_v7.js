/* HOPPER v7 fold — the whole game state, from ord's recursive endpoints.
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
  var seen = (input.children || [])
    .filter(function (c) {
      return (
        c.bodyOk === true &&
        c.dir === c.dir && c.dir >= 0 && c.dir <= 2 &&
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
    if (dist >= t) {
      return { state: "home", dist: dist, dir: c.dir, target: t, pending: false };
    }
    state = "idle";
  }
  /* On the bank: the honest requirement is what the NEXT hop will be
   * judged against (`required(tip + 1)`), never the frozen target of a
   * hopping that already happened. */
  return {
    state: state, dist: dist, dir: null,
    target: requiredAt((input.tip || 0) + 1, p), pending: false,
  };
}

/* ------------------------------- browser ----------------------------- */

/* The embedding document defines `V7 = {sat, genHint, name, p}` BEFORE
 * this file runs, in the same script tag. This file must NEVER assign V7:
 * a `var V7 = {…}` here is hoisted into the same global scope and
 * overwrites the document's values (the v6.0 bug). Read only. */
if (typeof V7 === "undefined") {
  var V7 = { sat: 0, genHint: 1, name: "", p: null };
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
 * /content path is. Try the recursive endpoint first and fall back. */
function contentBytes(id) {
  return fetch("/r/content/" + id, { credentials: "omit" }).then(function (r) {
    if (r.ok) return r.arrayBuffer();
    return fetch("/content/" + id, { credentials: "omit" }).then(function (r2) {
      if (!r2.ok) throw new Error("content " + r2.status);
      return r2.arrayBuffer();
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
function bodyDir(body, sat, id) {
  if (!body || body.length !== 55) return -1;
  var want = "FRG7CROSS";
  for (var i = 0; i < 9; i++) if (body[i] !== want.charCodeAt(i)) return -1;
  if (body[9] !== 7) return -1;
  var view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  /* sat is u64: compare both 32-bit halves. */
  if (view.getUint32(10, true) !== (sat >>> 0)) return -1;
  if (view.getUint32(14, true) !== Math.floor(sat / 4294967296)) return -1;
  var mint = displayTxid(body.slice(18, 50));
  var idx = view.getUint32(50, true);
  var parts = id.split("i");
  if (mint !== parts[0] || idx !== Number(parts[1])) return -1;
  var dir = body[54];
  return dir <= 2 ? dir : -1;
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
    var name = V7.name || "HOPPER";
    var text = name + " 🛣 " + dist;
    if (state === "dead") text = "RIP " + text;
    if (state === "home") text += " HOME";
    band.textContent = text;
  };
}

async function boot() {
  if (!window.crypto) return;
  if (typeof V7 === "undefined" || !V7 || !V7.p) return;
  var id = qid();
  if (!id) return;
  var paint = painter();
  try {
    var p = V7.p;
    var tip = await getJson("/r/blockheight");
    var me = await getJson("/r/inscription/" + id);
    var parent = (me.parents && me.parents[0]) || me.parent || null;
    var mint = parent || id;

    // ord >= 0.22 answers /r/children with {"ids":[...],"more":bool}
    // (older builds sent a bare array), so read both shapes and follow
    // the pagination cursor.
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
    var hash = {};
    for (var i = 0; i < ids.length; i++) {
      var cid = ids[i];
      var meta = await getJson("/r/inscription/" + cid);
      var dir = -1;
      var contentTypeOk = !meta.content_type
        || meta.content_type === "application/octet-stream";
      if (contentTypeOk) {
        try {
          var bytes = new Uint8Array(await contentBytes(cid));
          dir = bodyDir(bytes, V7.sat, id);
        } catch (e) {
          dir = -1;
        }
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
        bodyOk: dir >= 0,
        dir: dir,
      });
    }

    var r = foldFrog({
      sat: V7.sat,
      tip: tip,
      me: me,
      children: children,
      hash: hash,
      p: p,
    });

    // The authoritative generation is the mint's height; the hint is a
    // display fallback only (SPEC §2.3).
    var gen = generationAt(V7.genHint, p);
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

if (typeof document !== "undefined" && !window.__hopperV7Boot) {
  window.__hopperV7Boot = true;
  document.addEventListener("DOMContentLoaded", boot);
  if (document.readyState !== "loading") boot();
}
