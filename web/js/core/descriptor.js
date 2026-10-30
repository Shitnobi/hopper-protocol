// BIP-380 descriptor checksum (SPEC §5.5).
//
// The emergency export carries a `tr(internal,{raw(L),raw(S),raw(R),raw(X)})`
// descriptor with the checksum appended. Many signers cannot parse raw
// leaves, so `leaves[]` hex and control blocks are the authoritative form;
// the descriptor is a convenience for tools that can.

const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(c, val) {
  const GEN = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];
  const c0 = c >> 35n;
  c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
  for (let i = 0; i < 5; i += 1) {
    if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c;
}

export function descriptorChecksum(desc) {
  let c = 1n;
  let cls = 0;
  let clscount = 0;
  for (const ch of String(desc)) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos < 0) return null;
    c = polymod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    clscount += 1;
    if (clscount === 3) {
      c = polymod(c, cls);
      cls = 0;
      clscount = 0;
    }
  }
  if (clscount > 0) c = polymod(c, cls);
  for (let j = 0; j < 8; j += 1) c = polymod(c, 0);
  c ^= 1n;
  let out = '';
  for (let j = 0; j < 8; j += 1) {
    out += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - j))) & 31n)];
  }
  return out;
}

// `tr(internal,{raw(L),raw(S),raw(R),raw(X)})#checksum`
export function taprootDescriptor(internalXonlyHex, leafScriptHexes) {
  const body = `tr(${internalXonlyHex},{${leafScriptHexes.map((s) => `raw(${s})`).join(',')}})`;
  const checksum = descriptorChecksum(body);
  if (!checksum) throw new Error('descriptor contains a character outside the BIP-380 set');
  return `${body}#${checksum}`;
}

// A tool MUST rebuild the tree before trusting an export.
export function descriptorBody(descriptor) {
  const at = String(descriptor).lastIndexOf('#');
  return at < 0 ? String(descriptor) : String(descriptor).slice(0, at);
}

export function descriptorChecksumOk(descriptor) {
  const at = String(descriptor).lastIndexOf('#');
  if (at < 0) return false;
  return descriptorChecksum(String(descriptor).slice(0, at)) === String(descriptor).slice(at + 1);
}
