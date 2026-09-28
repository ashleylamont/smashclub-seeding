# Optional pool floor sheets

From the event operations desk, **Print pool sheets** opens a separate preview for native round-robin pools. Select any combination of pools, then print on A4 portrait or save a PDF. The preview captures one snapshot; close and reopen it after station, roster or result changes.

Each pool starts on a new page, with the event and pool name, assigned station bank, open/later/finished status, roster (including withdrawn players), round pairings, odd-player rests, and space to write unplayed scores. Results already recorded appear with their status; byes and forfeits identify the winner without inventing game scores. Large pools or long names can continue onto further pages with repeated column headers and unsplit match rows.

These are TO backup sheets for an outage. The station QR signs are separate and contain no match assignments. **Print bracket backup sheets** in the same event desk area opens four championship/consolation worksheets. Once a native draw exists, the sheets show its current matches and winner dependencies. Before then, they provide an estimated round structure based on current pool sizes, with blank first-round slots and winner paths for an offline draw. Reopen either preview after the event changes, and reconcile paper results online before finalizing.

The QR opens the stable public pool board on the current site origin. It contains no reporting credential. Unpublished events omit the QR and explain that the board is unavailable. Guests need a separate reporting QR to submit scores; organisers can print [permanent station signs](station-signs.md) when invitation rotation is disabled.

Pairing rounds are a reference, not a promised station assignment or start time. The online station queue remains authoritative. Paper entries are a fallback: enter each result online once, and ask a TO to correct an existing result.

This feature reads existing event data only. It adds no mutation, public endpoint, dependency or migration. It does not print elimination brackets or external Challonge brackets.

Validation: helper tests cover held/unpublished pools, native-only scope, withdrawn rests, no-contests, forfeit/bye winners and snapshot immutability. The local browser scenario decodes the QR, checks pool selection and frozen previews, produces four A4 pages for four pools and one page for a selected five-player pool, and checks print-only isolation. Generated PDFs were visually inspected for readable pairings, QR and footer without clipped rows.
