---
'@smashclub/web': minor
---

**Fix** · Keep late singles additions consistent when an organiser merges player profiles at the same time. Retrying a confirmed addition returns its original match counts.

API clients adding a late entrant should preview and apply the addition through `eventOps.previewAttendance` and `eventOps.applyAttendance`. The generic `eventOps.live.command` endpoint no longer accepts an attendance Add.
