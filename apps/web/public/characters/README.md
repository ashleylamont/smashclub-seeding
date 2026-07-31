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

Nothing breaks if this directory stays empty: every icon falls back to a
two-letter badge, so the feature works — just less prettily — with no icons
present at all.
