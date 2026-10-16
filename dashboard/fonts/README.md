# Vendored fonts

The dashboard loads nothing from another origin, so its three typefaces are committed here and
`style.css` declares them with `@font-face`. Vite emits them into `dist/assets/` and the server
serves them from the manifest. All three are licensed under the SIL Open Font License 1.1
(`OFL.txt`). The files are used unmodified.

They come from the Fontsource npm packages, which ship the Latin-subset `woff2` files the Google
Fonts sources do not (subsetting those would need Python tooling, which this repo avoids). The
packages are not dependencies: each was fetched once with `npm pack <package>@<version>` and the
files below were copied out and renamed.

| Package | Version | `dist.integrity` | Files taken → committed as |
|---|---|---|---|
| `@fontsource/barlow-semi-condensed` | 5.3.0 | `sha512-EdpQ1GlLMofGqDsQhEw+g6DonNKmzt21p8y/oNbTl4BFzEkqYkFyE2fj25YGxmZBL/LZZGAxe74FlvEWcgc31w==` | `files/barlow-semi-condensed-latin-{600,700}-normal.woff2` → `BarlowSemiCondensed-{600,700}.woff2` |
| `@fontsource/barlow` | 5.3.0 | `sha512-tGR0y6QObRtKv71MOth44222+mdNFM/ZWFWDV1VLzNbG4oK9PNRlyJzmkck4vHAi9ibHBXgt4SlY51amFP55CA==` | `files/barlow-latin-{400,500,600}-normal.woff2` → `Barlow-{400,500,600}.woff2` |
| `@fontsource/dm-mono` | 5.3.0 | `sha512-OINjI8C1S/wpchhQxl7njZdMn4+hnDCpQ4YtvvOpKNARo+0J8O1x1IcrChxNjHOhfVv1by8C/FQoy3hXK+C1Ug==` | `files/dm-mono-latin-{400,500}-normal.woff2` → `DMMono-{400,500}.woff2` |

The `unicode-range` in each `@font-face` is the Latin range from the packages' own CSS.
