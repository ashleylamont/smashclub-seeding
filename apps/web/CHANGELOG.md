# Nemesis changelog

## 0.1.0

### Minor Changes

- Introduce versioned Nemesis releases and a public changelog covering the history of rankings, event planning, live tournaments and broadcasts.

## Before versioned releases

Entries use the date the changes landed in Git, in Sydney time.

### 8 November 2026

- Seed native finals with confirmed pool places and frozen WHR. The TO can review seeds, byes and possible rematches before creating each ready bracket. [#151](https://github.com/ashleylamont/smashclub-seeding/pull/151)
- Show player or team totals in draft plans, with unresolved entries separate. Frozen plans show actual division and pool sizes. [#150](https://github.com/ashleylamont/smashclub-seeding/pull/150)
- Release clear qualifiers from a completed pool while an organiser settles its tied places. [#149](https://github.com/ashleylamont/smashclub-seeding/pull/149)

### 31 October 2026

- Explain doubles rating uncertainty and let organisers sort pairs without changing their saved seeds. [#146](https://github.com/ashleylamont/smashclub-seeding/pull/146)
- Rotate through tournament progress between streamed sets and switch to gameplay automatically when the selected station starts. [#143](https://github.com/ashleylamont/smashclub-seeding/pull/143)
- Show native draws in the TO workspace, print backup sheets and use match names that describe their bracket paths. [#142](https://github.com/ashleylamont/smashclub-seeding/pull/142), [#138](https://github.com/ashleylamont/smashclub-seeding/pull/138)
- Open live events from Home. Players can follow their own path, find their next match and report scores in one event hub with shared controls. [#141](https://github.com/ashleylamont/smashclub-seeding/pull/141), [#133](https://github.com/ashleylamont/smashclub-seeding/pull/133), [#126](https://github.com/ashleylamont/smashclub-seeding/pull/126), [#124](https://github.com/ashleylamont/smashclub-seeding/pull/124)
- Record forfeits without game scores and review the effects of restoring a withdrawn entrant before applying the change. [#137](https://github.com/ashleylamont/smashclub-seeding/pull/137), [#135](https://github.com/ashleylamont/smashclub-seeding/pull/135)
- Save left and right player sides for OBS and show recent official results beside gameplay. [#134](https://github.com/ashleylamont/smashclub-seeding/pull/134), [#132](https://github.com/ashleylamont/smashclub-seeding/pull/132)
- Resolve finals qualifiers as pools finish, record unambiguous set-win orders automatically and distinguish a true bye from an unknown opponent. [#131](https://github.com/ashleylamont/smashclub-seeding/pull/131), [#128](https://github.com/ashleylamont/smashclub-seeding/pull/128), [#127](https://github.com/ashleylamont/smashclub-seeding/pull/127)
- Explain unavailable stations and let organisers dispatch matches from shared capacity. Played scores can be reported before a separate Start action. [#130](https://github.com/ashleylamont/smashclub-seeding/pull/130), [#120](https://github.com/ashleylamont/smashclub-seeding/pull/120)
- Show reliable public brackets with measured feeder connections and readable scrolling. [#125](https://github.com/ashleylamont/smashclub-seeding/pull/125)
- Keep guest reporting passes valid until an organiser revokes them. [#119](https://github.com/ashleylamont/smashclub-seeding/pull/119)

### 24 October 2026

- Improve double-elimination previews, including feeder labels and the conditional reset final. [#113](https://github.com/ashleylamont/smashclub-seeding/pull/113)

### 23 October 2026

- Stabilise browser recovery checks and make main use the full release verification workflow. [#112](https://github.com/ashleylamont/smashclub-seeding/pull/112)
- Compile native draws for supported pool, round-robin and elimination formats through one format engine. [#111](https://github.com/ashleylamont/smashclub-seeding/pull/111)

### 22 October 2026

- Update runtime dependencies to address security fixes. [#110](https://github.com/ashleylamont/smashclub-seeding/pull/110)
- Preview draft tournament timelines, divisions and bracket layouts before locking the draw. [#109](https://github.com/ashleylamont/smashclub-seeding/pull/109)
- Let organisers recover, revert or remove eligible soft-locked plans while retaining their history. [#108](https://github.com/ashleylamont/smashclub-seeding/pull/108)

### 20 October 2026

- Run native doubles tournaments, choose tournament formats and optionally use WHR pair adjustments for seeding. [#107](https://github.com/ashleylamont/smashclub-seeding/pull/107)

### 10 October 2026

- Show the native tournament history in the TO workspace, including recorded decisions and their effects. [#106](https://github.com/ashleylamont/smashclub-seeding/pull/106)

### 8 October 2026

- Improve the local event rehearsal and verify recovery after network interruptions. The app shows when it is displaying the last received event state. [#105](https://github.com/ashleylamont/smashclub-seeding/pull/105), [#104](https://github.com/ashleylamont/smashclub-seeding/pull/104)

### 6 October 2026

- Make the Act journal authoritative for native live play and retain reviewed result revisions through publication. [#100](https://github.com/ashleylamont/smashclub-seeding/pull/100)

### 5 October 2026

- Publish WHR as the sole ratings model and require database and production image verification before publishing builds. [#102](https://github.com/ashleylamont/smashclub-seeding/pull/102), [#103](https://github.com/ashleylamont/smashclub-seeding/pull/103)

### 4 October 2026

- Standardise controls, improve score reporting and organise the TO workspace around focused tasks. [#101](https://github.com/ashleylamont/smashclub-seeding/pull/101)

### 29 September 2026

- Allow native finals to proceed while independent pool matches are still running. [#49](https://github.com/ashleylamont/smashclub-seeding/pull/49)
- Show an organiser attendee roster with copy filters and links to edit player records. [#48](https://github.com/ashleylamont/smashclub-seeding/pull/48)

### 28 September 2026

- Print bracket backup sheets and focus the player view on selected matches. [#47](https://github.com/ashleylamont/smashclub-seeding/pull/47), [#46](https://github.com/ashleylamont/smashclub-seeding/pull/46)
- Make pool soft lock explicit and reversible before play. Limit attendance changes to the affected draw. [#45](https://github.com/ashleylamont/smashclub-seeding/pull/45), [#39](https://github.com/ashleylamont/smashclub-seeding/pull/39)
- Manage administrator access in Nemesis and print reusable station QR signs. [#44](https://github.com/ashleylamont/smashclub-seeding/pull/44), [#40](https://github.com/ashleylamont/smashclub-seeding/pull/40)
- Add stricter lint and formatting checks, expand event workflow coverage in CI and refresh the development guides. [#43](https://github.com/ashleylamont/smashclub-seeding/pull/43), [#42](https://github.com/ashleylamont/smashclub-seeding/pull/42), [#41](https://github.com/ashleylamont/smashclub-seeding/pull/41)

### 26 September 2026

- Show TO breakthrough analysis and let players find their pool, next set and station call. [#38](https://github.com/ashleylamont/smashclub-seeding/pull/38), [#33](https://github.com/ashleylamont/smashclub-seeding/pull/33)
- Manage event stations and print pool sheets with pairings and live-board QR codes. [#37](https://github.com/ashleylamont/smashclub-seeding/pull/37), [#34](https://github.com/ashleylamont/smashclub-seeding/pull/34)
- Open the event-night player hub without an account and allow scores to be approved automatically unless disputed. [#35](https://github.com/ashleylamont/smashclub-seeding/pull/35)

### 21 September 2026

- Group score reviews and match decisions in the TO attention desk. [#32](https://github.com/ashleylamont/smashclub-seeding/pull/32)

### 19 September 2026

- Let pools use their own station queues and confirm their scores. [#31](https://github.com/ashleylamont/smashclub-seeding/pull/31)

### 18 September 2026

- Run live Nemesis nights with guest reporting, station management, finals, broadcast views and publication. Adopt completed historical events while keeping their original results. [#30](https://github.com/ashleylamont/smashclub-seeding/pull/30), [#29](https://github.com/ashleylamont/smashclub-seeding/pull/29), [#28](https://github.com/ashleylamont/smashclub-seeding/pull/28)

### 8 September 2026

- Refresh recent events and distinguish group-stage sets in ratings views. [#27](https://github.com/ashleylamont/smashclub-seeding/pull/27)

### 4 September 2026

- Support two-stage results, event standings and curated club-night recaps. [#26](https://github.com/ashleylamont/smashclub-seeding/pull/26)

### 24 August 2026

- Plan two-division tournaments, seed players and prepare pools before the event. [#25](https://github.com/ashleylamont/smashclub-seeding/pull/25)

### 6 August 2026

- Hide players who have been inactive for six months by default. [#24](https://github.com/ashleylamont/smashclub-seeding/pull/24)

### 3 August 2026

- Name the whole club night on inactivity rows shared by multiple brackets. [#22](https://github.com/ashleylamont/smashclub-seeding/pull/22)

### 2 August 2026

- Base recap awards on eligible played results and show sets in play order. [#21](https://github.com/ashleylamont/smashclub-seeding/pull/21), [#20](https://github.com/ashleylamont/smashclub-seeding/pull/20)
- Add Whole-History Rating and calibrate rookie debut ratings and exposure to the established field. [#19](https://github.com/ashleylamont/smashclub-seeding/pull/19), [#16](https://github.com/ashleylamont/smashclub-seeding/pull/16)
- Publish aliases across public views and link the build stamp to the serving Git commit. [#18](https://github.com/ashleylamont/smashclub-seeding/pull/18), [#17](https://github.com/ashleylamont/smashclub-seeding/pull/17)

### 1 August 2026

- Improve inactivity handling and default the rankings to the active field. [#15](https://github.com/ashleylamont/smashclub-seeding/pull/15), [#13](https://github.com/ashleylamont/smashclub-seeding/pull/13)
- Add event recaps, share cards and venue mode. Improve mobile layouts and explanations of rating changes. [#14](https://github.com/ashleylamont/smashclub-seeding/pull/14), [#11](https://github.com/ashleylamont/smashclub-seeding/pull/11)
- Give CI checks individual statuses and remove clock reads during React render. [#12](https://github.com/ashleylamont/smashclub-seeding/pull/12), [#8](https://github.com/ashleylamont/smashclub-seeding/pull/8)
- Improve administrator revocation and connection limits. Default public aliases to first names and initials and retain chosen aliases. [bfd7c8b](https://github.com/ashleylamont/smashclub-seeding/commit/bfd7c8bf6e46d2fa7eaa960dafbc87870ef6a7f9), [1407081](https://github.com/ashleylamont/smashclub-seeding/commit/14070816b35e97eaf3991b2328f6b292cc96034a)
- Resolve match participants through the player registry and import registry files in the admin UI. [#9](https://github.com/ashleylamont/smashclub-seeding/pull/9), [#7](https://github.com/ashleylamont/smashclub-seeding/pull/7)
- Keep YAML loading compatible with the server build. [b249ecc](https://github.com/ashleylamont/smashclub-seeding/commit/b249ecc208e98e0a188ef44c6b951aca91be1c5f)
- Correct live tournament grouping, reduce Challonge requests and repair the public bracket fallback. [#6](https://github.com/ashleylamont/smashclub-seeding/pull/6), [#5](https://github.com/ashleylamont/smashclub-seeding/pull/5), [#3](https://github.com/ashleylamont/smashclub-seeding/pull/3)
- Add player profiles, character mains, company administration and provider-independent sign-in. [#4](https://github.com/ashleylamont/smashclub-seeding/pull/4)

### 29 July 2026

- Turn the seeding CLI into the Nemesis web app with persistent rankings and publish container images to GitHub Container Registry. [#2](https://github.com/ashleylamont/smashclub-seeding/pull/2), [#1](https://github.com/ashleylamont/smashclub-seeding/pull/1)

### 23 March 2026

- Add a Glicko-based ranking system to the original toolkit. [f213c51](https://github.com/ashleylamont/smashclub-seeding/commit/f213c5104abac70a590de6fd24b5796ad6f5a7d2)

### 4 March 2026

- Add the project licence. [4ef964e](https://github.com/ashleylamont/smashclub-seeding/commit/4ef964e7e3db5cefa6af90eacd6a9c105eb7559e)

### 3 March 2026

- Use fictional player names in the test fixtures. [734ea58](https://github.com/ashleylamont/smashclub-seeding/commit/734ea58aa0bd3439e32e564db155023689595710)

### 2 February 2026

- Improve terminal colours and move formatted output into its own module. [f7deb39](https://github.com/ashleylamont/smashclub-seeding/commit/f7deb3930fe4ea4da5f171adff3b069ecfc0edff), [7ae1dcf](https://github.com/ashleylamont/smashclub-seeding/commit/7ae1dcf5d05a1b4225f371f9f3cbc8b7cd24b2aa)
- Refine placement and peak-performance weighting. [2dd2c0a](https://github.com/ashleylamont/smashclub-seeding/commit/2dd2c0a021a2f801e1e15263dc98ae25e016abb9)

### 1 February 2026

- Document the toolkit and fix terminal output. [4b7cdc1](https://github.com/ashleylamont/smashclub-seeding/commit/4b7cdc1a06116c934d4479806057af0586727a6d)

### 30 January 2026

- Expand the company lookup table. [e69a0af](https://github.com/ashleylamont/smashclub-seeding/commit/e69a0af4d1a3d1fdd5cd8158842cbeace5fc1edc)

### 9 January 2026

- Use doubles results to supplement rookie evidence and adjust recent-result weighting. [4ab0b96](https://github.com/ashleylamont/smashclub-seeding/commit/4ab0b96b5786f75f4efe73848198faa8406d7e0e)

### 28 October 2025

- Refine rookie seeding adjustments in the original ranking tool. [5da0df1](https://github.com/ashleylamont/smashclub-seeding/commit/5da0df15cf2799c792851f29e4a4fc1b677ac948)

### 20 October 2025

- Start the Smash Club seeding toolkit and document its purpose. [d22c8e3](https://github.com/ashleylamont/smashclub-seeding/commit/d22c8e3278c9d8976c9487730ff026c20e7f018c), [51106fc](https://github.com/ashleylamont/smashclub-seeding/commit/51106fca5cfc085f5ba26e6375340c65db4613dc)
