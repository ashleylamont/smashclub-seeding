# Character head icons

`CharacterIcons` renders `/characters/<slug>.png` beside a player's name, where
`<slug>` comes from the roster in `packages/shared/src/characters.ts`. The two
must stay in step: the slug is what names the file the UI asks for.

The icons are committed. They have to be — Vite copies `public/` into `dist/`
at build time and the server serves `dist/`, so an icon missing from the build
context is missing from the deployed image. `publish.yml` builds from a git
checkout, so anything not committed here simply would not ship.

These are Nintendo's assets, used the way every other fan bracket site uses
them.

## Refreshing them

To re-pull (say, after a roster addition), either:

```sh
pnpm --filter @smashclub/fetch-character-icons start
```

or the standalone script, which needs no workspace install — just bash, curl
and python3 — and packs the result into a zip for moving between machines:

```sh
tools/fetch-character-icons/fetch-icons.sh
unzip -o smashclub-character-icons.zip -d apps/web/public/characters/
```

Both pull from [SSBWiki](https://www.ssbwiki.com/Category:Head_icons_(SSBU)),
match the category's actual members against the roster, and report anything
they could not match rather than skipping it silently.

Rebuild the web app afterwards, or the new files will not reach `dist/`.

Nothing breaks if an icon is absent: it degrades to a two-letter badge, so a
missing fighter is a cosmetic gap rather than a broken page.
