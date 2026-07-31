# Character head icons

`CharacterIcons` renders `/characters/<slug>.png` beside a player's name, where
`<slug>` comes from the roster in `packages/shared/src/characters.ts`.

The PNGs are Nintendo's assets, so they are fetched on demand rather than
committed. Populate this directory with:

```sh
pnpm --filter @smashclub/fetch-character-icons start
```

That pulls the current SSBU head icons from
[SSBWiki](https://www.ssbwiki.com/Category:Head_icons_(SSBU)) and writes one
file per roster entry, reporting anything it could not match.

There is also a standalone `tools/fetch-character-icons/fetch-icons.sh`, which
needs no workspace install — just bash, curl and python3 — and packs the
result into a zip for moving between machines:

```sh
tools/fetch-character-icons/fetch-icons.sh
unzip -o smashclub-character-icons.zip -d apps/web/public/characters/
```

Nothing breaks if this directory stays empty: every icon falls back to a
two-letter badge, so the feature works — just less prettily — with no icons
present at all.
