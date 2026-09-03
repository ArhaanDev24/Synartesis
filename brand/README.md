# brand

These are not decoration. The three PNGs the README displays are built here,
and GitHub serves them straight out of this directory:

| File | Where it appears |
|---|---|
| `synartesis-banner.png` | the top of README.md |
| `synartesis-undo.png` | README.md, "What it looks like" |
| `synartesis-drift.png` | README.md, "What it looks like" |
| `synartesis-social-github.png` | the repo's social preview card |
| `synartesis-mark-1080.png` | the mark, used by the cards above |

Delete this directory and the README shows five broken images.

Each `.html` file is the source of the PNG beside it. They are HTML because
the type is: Cormorant Garamond and IBM Plex Mono from Google Fonts, and the
meander as a CSS mask, exactly as the site draws them. To rebuild one:

```bash
node brand/shoot.mjs brand/readme-banner.html brand/synartesis-banner.png 1280 300 2
```

The last three arguments are width, height and device scale factor. Shoot at
2x: GitHub serves these at roughly 880px wide and they should stay sharp.

None of this ships to npm. The package is `dist/`, `manifests/` and four
markdown files — see the `files` field in `package.json`.
