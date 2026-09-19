# Optional pool floor sheets

From the event operations desk, **Print pool sheets** opens a separate preview for native round-robin pools. Select any combination of pools, then print on A4 portrait or save a PDF. The preview captures one snapshot; close and reopen it after station, roster or result changes.

Each pool starts on a new page, with the event and pool name, assigned station bank, open/later/finished status, roster (including withdrawn players), round pairings, odd-player rests, and space to write unplayed scores. Results already recorded appear with their status; byes and forfeits identify the winner without inventing game scores. Large pools or long names can continue onto further pages with repeated column headers and unsplit match rows.

The QR opens the stable public pool board on the current site origin. It contains no reporting credential and does not expire like a guest reporting invitation. Unpublished events omit the QR and explain that the board is unavailable. The sheet explains that guests still need the current reporting QR to submit scores.

Pairing rounds are a reference, not a promised station assignment or start time. The online station queue remains authoritative. Paper entries are a fallback: enter each result online once, and ask a TO to correct an existing result.

This feature reads existing event data only. It adds no mutation, public endpoint, dependency or migration. It does not print elimination brackets or external Challonge brackets.

Validation: helper tests cover held/unpublished pools, native-only scope, withdrawn rests, no-contests, forfeit/bye winners and snapshot immutability. The local browser scenario decodes the QR, checks pool selection and frozen previews, produces four A4 pages for four pools and one page for a selected five-player pool, and checks print-only isolation. Generated PDFs were visually inspected for readable pairings, QR and footer without clipped rows.
