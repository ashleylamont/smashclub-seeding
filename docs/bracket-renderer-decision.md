# Bracket renderer reliability (#80, #88)

Decision: retain the native React renderer and share its pure lane geometry with the double-elimination planning preview. This is a bounded rendering change; it does not choose seeds, generate tournament commands, predict a winner, or create provisional finals before the server supplies a bracket.

## Library comparison (source review, 31 October 2026)

This initial assessment uses the versions declared by the upstream source manifests inspected at the time. The executed comparison below uses the published `brackets-viewer` bundle and a React 19-compatible fork of React Tournament Brackets. The original React package and bracketry were assessed from source.

| Candidate | Verified source fit | Integration cost / decision |
| --- | --- | --- |
| [brackets-viewer 1.9.1](https://github.com/Drarig29/brackets-viewer.js/blob/main/package.json) | [README](https://github.com/Drarig29/brackets-viewer.js#readme) supports SE, DE and round robin, vanilla JS, themes and crafted `brackets-model` data. No React peer dependency. | Strongest future replacement candidate. Requires a native-to-brackets-model stage/group/round/match adapter and an imperative DOM lifecycle. Our native parent winner/loser IDs, automatic byes, suppressed reset and no-contest semantics still need adapter tests. Adopting it alone does not prove keyboard, screen-reader, long-team or update correctness. |
| [@g-loot/react-tournament-brackets 1.0.0](https://github.com/g-loot/react-tournament-brackets/blob/master/package.json) | [README](https://github.com/g-loot/react-tournament-brackets#readme) provides React SE/DE and SVG rendering. Manifest peers require React/React DOM `^18.1.0`, `react-svg-pan-zoom` and styled-components `^4.1.3`. | The application uses React 19.2.4. The declared peer range excludes it. A dependency upgrade/fork and SVG content/accessibility checks would precede adoption. Not a bounded fix for this application. |
| [bracketry 1.1.3](https://github.com/sbachinin/bracketry/blob/main/package.json) | [README](https://github.com/sbachinin/bracketry#readme) describes mobile tuning, doubles, live updates and custom match markup. It explicitly targets SE and warns that DE is awkward and wastes space. | Useful for SE-only products; this application needs native DE winner/loser lanes and conditional finals. A second renderer or custom DE reconstruction would retain substantial local logic. |

The native renderer already receives authoritative `nativeRound`, `nativeSlot`, `bracketLane`, `bracketRound`, parent IDs and parent outcomes. Its HTML text and normal overflow regions integrate directly with the existing React 19 application. Sharing the existing planning geometry avoids maintaining a second implementation of lane contraction and connector routing. Both executable probes use that same native fixture graph.

## Executed comparison (8 November 2026)

### brackets-viewer 1.9.1

Playwright ran [brackets-viewer 1.9.1](https://github.com/Drarig29/brackets-viewer.js/releases/tag/v1.9.1) from its published browser bundle on the native engine's seven-entrant SE and DE fixtures and four independent stages at 390px and 1440px. The candidate rendered all seven SE matches, 14 of 15 pending DE matches, and all 12 mixed-stage matches. It displayed played scores, winner and loser states, and a bye. This candidate uses an imperative DOM API.

| Requirement | Observed viewer behavior |
| --- | --- |
| Correct feeder identity and status | With the origin flags enabled and positional inputs supplied, pending winners R2 had no source label. Both grand-final slots said “Winner of LB Final” even though one comes from the winners final. A losers R2 slot sourced from the **winner** of losers R1 said “Loser of WB Semi 1”. A completed no-contest had the same empty rows as an unresolved match. |
| Conditional reset | The viewer omitted the pending reset while the winners finalist was unknown. Once that finalist was known, it showed the reset before a result and after a loss, and hid it after a win. The supported `customRoundName` callback labelled a visible reset “If needed”. |
| Narrow navigation and long names | The default phone layout kept page width bounded, but its scroll region was unfocusable and the full doubles alias appeared only in a title. Adding a labelled, focusable region enabled Tab and ArrowRight scrolling and cleared the scroll-region Axe finding. A CSS override wrapped the full alias, but its taller card separated the adjacent connector strokes in the phone DE capture. DE contrast findings remained after the limited host styling. |

The [viewer configuration](https://github.com/Drarig29/brackets-viewer.js/blob/v1.9.1/src/types.ts#L115) provides origin flags and round-heading customization. The [final render path](https://github.com/Drarig29/brackets-viewer.js/blob/v1.9.1/src/main.ts#L440) discards the reset before invoking the heading callback, and the [origin implementation](https://github.com/Drarig29/brackets-viewer.js/blob/v1.9.1/src/lang.ts#L77) derives its hints from round, group and slot position. Those inputs cannot express the source match ID, winner or loser outcome and destination side for each native feed. Achieving equivalent behavior would require maintaining the native graph alongside the viewer and replacing generated labels, conditional stages and connector geometry, or extending upstream.

### React Tournament Brackets fork 1.1.6

The same fixtures ran in [@cm3tahkuh/react-tournament-brackets 1.1.6](https://registry.npmjs.org/@cm3tahkuh%2freact-tournament-brackets/1.1.6) on React and React DOM 19.2.4 at both widths. It rendered 7/7 SE, 15/15 DE and 12/12 mixed-stage cards with scores. It displayed the supplied conditional reset and omitted it when the graph left it out.

| Requirement | Observed React fork behavior |
| --- | --- |
| Correct feeder identity and status | Default unknown slots were blank. Supplying participant labels from the native display helper made the pending grand-final feeds, the cross-lane drop and the bye distinguishable. A completed no-contest then displayed “No entrant” in both slots. Distinguishing it from pending requires an additional host outcome label. |
| Connector identity | Measuring SVG endpoints mapped 14 paths to all 14 distinct winner source/target pairs. The seven winners-to-losers drop pairs had no path. A single grand-final-to-reset path represented a pair with both a winner and loser feed. Cross-lane labels still depend on the native graph. |
| Long names and accessibility | With the default 110px card box, the long doubles alias pushed the “Bye” row below its SVG viewport. The documented `boxHeight` option at 175px, a high-contrast theme and a labelled focusable overflow region restored the row and passed the measured Axe, Tab and ArrowRight checks at both widths and in both themes. The optional pan/zoom wrapper rendered a second set of match nodes in its minimap and had unnamed-button and contrast findings. |

The [fork's documentation](https://github.com/cm3tahkuh/react-tournament-brackets#readme) covers a custom match component, theme, box dimensions and SVG viewer. The React candidate fits more of the fixture when the host supplies the existing labels and outcome rules. Keeping the native renderer retains match-side feed identity and content-measured cards while sharing the same semantics across public, preview and broadcast views.

## Archived TIP12 replay

The public [TIP12 archive](https://nemesis.ashl.dev/play/42765e65-a0ca-47d8-b22e-b3ace8b520d1) still serves the event's completed match graph. The replay compared the historical `e32d53e` bracket component with the repaired component on the same 52 bracket matches across four scopes. The graph has 48 authoritative feeder edges. At 390px and 1440px the old renderer drew 37 CSS stubs, with no stub on 11 true feeder sources. The repaired renderer drew all 48 exact source-to-destination/side paths and no extra path. Both replays kept page width bounded. This reproduces the connector defect on the real archived graph. The original live state and viewport remain unavailable.

Rerun the [reproduction harness](bracket-renderer-reproduction/run.sh) from a disposable worktree with the repository dependencies and Playwright Chromium available. It verifies the first viewer bundle hash, installs the pinned React candidate into a scratch directory, and downloads the completed graph through the public endpoint. Both candidates reuse the repository’s native fixture. The script removes the temporary test files and downloaded data after the run. The existing Playwright dependency runs all cases and writes separate captures.

```sh
UI_PORT=3451 bash docs/bracket-renderer-reproduction/run.sh --output=/tmp/nemesis-renderer-replay
UI_PORT=3451 pnpm --filter @smashclub/web test:ui bracket-reliability.spec.ts pending-finals.spec.ts broadcast-intermission.spec.ts
```

The local runs passed six cases for each candidate, four archived replay cases and 23 existing native cases. The vanilla candidate ran on its light surface with and without host overrides. The React candidate also ran adapted DE in dark and light themes, as does the native suite. The harness writes desktop and phone captures to the output directory.

## Concrete regressions and fixes

The original public renderer's small status label called every completed non-bye a “Final result”, including the real public no-contest contract (`status: complete`, `winnerId: null`, `outcome: null`, and an explanatory `blockedReason`). A completed automatic bye with an unresolved source on its empty side still displayed “Winner/Loser of …”. Running the same no-contest case against the original `e32d53e` component fails with expected “No contest”, received “losers 1 · M1 · Final result”; the fixed component passes. Both states are covered by the browser regression named `completed byes and no contests do not claim unresolved entrants or a result winner`.

The old pseudo-element drew a horizontal line after every card except the final sibling, without checking a parent ID; it could imply a connection that did not exist. The new SVG draws only explicit forward feeds inside the current lane. Cross-lane drops remain named in the destination card. Winners, losers and finals have separate labelled scroll regions. Native engine rounds are globally ordered. The archived replay isolates the connector defect.

Wrapped HTML cards are measured, including actual participant row centers. Lane spacing uses the tallest card; text remains complete. Known winner/loser feeds leave the corresponding participant row, unknown feeds leave the source card center, and endpoints reach the actual destination side. The planning wrapper retains its prior compact card dimensions and offsets. Winner highlights require a completed match. Completed no-contests have no winner; a blocked reset says “If needed”; a reset suppressed by the server is not recreated. Empty, singleton and unpublished draws receive explicit text.

## Acceptance evidence and limits

`apps/web/test/eventBracket.test.ts` uses synthetic fixtures built with the real SE/DE engine. It checks semantic states and deterministic, bounded, disjoint geometry for 2, 3, 4, 7, 16, 32, 64 and 128 entrants. Local connectors must correspond exactly to supplied parent/outcome/side metadata. The existing planning geometry tests remain in place.

`apps/web/ui-tests/bracket-reliability.spec.ts` checks desktop and 390px light/dark layouts, complete long doubles labels, bye versus pending winner/loser feeds, conditional reset, empty/singleton brackets, changed results, completed champion and omitted reset. A four-bracket case checks upper/lower championship/consolation labels, scores, unique match IDs and local-only feeds simultaneously. DOM assertions verify card bounds/non-overlap and SVG endpoints against measured participant rows after resizing. Axe, keyboard focus/ArrowRight scrolling and absence of page-wide horizontal overflow are checked. Screenshots are attached for review; they are not replacement Darwin pixel baselines.

The existing `bracket-phone`, `wide-bracket-light` and `wide-bracket-light-phone` pixel gates remain enabled with their original tolerance and Darwin files. Their intended rendering changes require the normal [visual review procedure](ui-visual-review.md) on macOS. The sixteen-slot fixture still checks all rounds and final-card keyboard reachability.

The archived replay covers completed TIP12 data. The original live viewport and manual assistive-technology review remain outside this evidence. The public and OBS provisional qualification paths have separate fixture coverage. A connected historical Challonge bracket remains a discoverable external link.
