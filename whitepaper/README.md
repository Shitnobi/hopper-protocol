# HOPPER — technical whitepaper

A typeset whitepaper for the HOPPER v8 protocol, derived from
`../SPEC.md` (status 3.0, wire version `0x08`; the released v7 protocol is
grandfathered for one sat).

## Files

```
hopper-whitepaper.tex       main LaTeX source
frontmatter.tex             cover, abstract, contents
sections/                   body sections and appendices
figures/                    logo, spritesheet, plotted generation data (CSV)
references.tex              bibliography
COMPLIANCE.md               section-by-section audit against SPEC.md
hopper-whitepaper.pdf       built PDF (43 pages)
```

The v6 death table, the per-frog settlement digest and the two-leaf custody
tree are gone. The v7 generation schedule, block-wide wrap, 55-byte direction
body and four-leaf Taproot tree remain. Version 8 adds:

- `0x08`/`FRG8CROSS` and the `live_v8_html` mint document;
- a proof-checking fold that verifies each body-valid crossing against its
  raw transaction and reports `unverified` rather than guessing;
- one grandfathered v7 sat, whose released envelope, digest, `V7` body and
  `FRG7CROSS`/`0x07` custody path remain valid for custody and play only.

## Build

The document builds with [Tectonic](https://tectonic-typesetting.github.io/),
which fetches the needed LaTeX packages on first run.

```sh
cd hopper-protocol/whitepaper
tectonic hopper-whitepaper.tex
```

Output: `hopper-whitepaper.pdf`.

## Source of truth

`SPEC.md` in this repository is normative. The whitepaper is an exposition;
if the two disagree, the specification governs. The audit in `COMPLIANCE.md`
records the mapping, the verified value checks, and the wording ambiguities
resolved in the paper.

The source and built PDF live under `hopper-protocol/whitepaper`.
