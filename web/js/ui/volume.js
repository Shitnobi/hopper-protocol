// A settings fader is a percentage (0–100); the wallet stores gain as 0–1.
//
// The fader used to be read as if it were already 0–1, so any click above
// zero clamped to 1 (100%). Accept both scales here: the element's own max
// decides the divisor, and a missing/one max leaves a 0–1 input alone.
export function volumeFromRange(value, max = 100) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const ceiling = Number(max);
  const scale = Number.isFinite(ceiling) && ceiling > 1 ? ceiling : 1;
  return Math.max(0, Math.min(1, raw / scale));
}
