# MoL-Bench v0.2 Vendored Fonts (`harness/fonts/`)

> **Status:** Placeholder + loader frozen at Milestone M1 (`WP-0a`).

To guarantee same-machine, same-toolchain visual and APCA contrast repeatability across OS font updates (`docs/V02-DESIGN.md §2.2`), v0.2 web rooms serve repo-vendored SIL Open Font License 1.1 (`OFL-1.1`) fonts locally via `fonts.css`.

## Required OFL-1.1 Binaries & License Files

Because no OFL font binaries were available offline during WP-0a, the coordinator should drop the following verified official OFL-1.1 files into `harness/fonts/`, update `sha256` values in `manifest.json`, and set `"status": "vendored"`:

| Family | Filename | License File | Official Source |
|---|---|---|---|
| Pretendard | `PretendardVariable.woff2` | `OFL-Pretendard.txt` | `github.com/orioncactus/pretendard` |
| Noto Sans JP | `NotoSansJP-Variable.woff2` | `OFL-Noto.txt` | `github.com/notofonts/noto-cjk` |
| Inter | `InterVariable.woff2` | `OFL-Inter.txt` | `github.com/rsms/inter` |
| Noto Serif | `NotoSerif-Variable.woff2` | `OFL-Noto.txt` | `github.com/notofonts/latin-greek-cyrillic` |

## Loader API (`harness/fonts/loader.mjs`)
- `getFontManifest(fontsDir?)` -> parsed `manifest.json`
- `verifyVendoredFonts(fontsDir?)` -> `{ complete, status, presentFonts, missingFonts, missingLicenses, hashMismatches }`
- `copyFontsTo(destDir, fontsDir?)` -> copies `fonts.css`, `manifest.json`, and all present font/license files
