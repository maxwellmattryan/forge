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
| `@fontsource/space-grotesk` | 5.3.0 | `sha512-ksnGizDPXIDuvqcTYTSrmZ+evx9sDlS8rp7+42BQ7wU+spt3twEoXfbJz672C+5CLg6VeUQwRy5RXshWb67LcQ==` | `files/space-grotesk-latin-{500,700}-normal.woff2` → `SpaceGrotesk-{500,700}.woff2` |
| `@fontsource/ibm-plex-sans` | 5.3.0 | `sha512-CbE4CbbEEZJX860XyUiRpsksXIQR8Rp2XDva2VO53NJox9tVNtusrysd2x5YkUEY3ErQ66W1IiiQL8/wihhw5w==` | `files/ibm-plex-sans-latin-{400,500,600}-normal.woff2` → `IBMPlexSans-{400,500,600}.woff2` |
| `@fontsource/ibm-plex-mono` | 5.3.0 | `sha512-eTgnZjZEGk1QtD3ZstF+Vclo2HLAni8YMy34/DxllwZvyz1lR/1RF/xTiAquOBO7MvqBx8D2Ig2WCPMVfdZu7Q==` | `files/ibm-plex-mono-latin-{400,500,600}-normal.woff2` → `IBMPlexMono-{400,500,600}.woff2` |

The `unicode-range` in each `@font-face` is the Latin range from the packages' own CSS.
