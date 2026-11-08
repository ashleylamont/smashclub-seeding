---
'@smashclub/web': patch
---

**Fixed** · Require a fresh organiser preview before removing a changed finals draw.

Returning a call still refreshes the removal controls for the same draw. If another organiser removes or redraws any of those finals, preview the current draw before removing it.
