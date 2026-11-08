# Resetting and deleting event plans

Admins can use **Reset or delete this event** in the event planner at any stage, including after soft lock, recorded play, cancellation, or publication. Saved plans also have a **Delete** action. Review the preview, enter a reason, and confirm the action.

**Revert to draft** closes the old live draw and creates a fresh draft with its current roster, competition format, structure, seeding policy, pool settings, and station names. Seeds, pool draws, scores, publication, and guest access start fresh. The planner opens the replacement draft so the roster and pairs can be edited, frozen, and drawn again. The replacement has a new event ID; old links and score forms cannot write to its matches.

**Delete** removes the plan from the planner and event-night list and closes its live links. Original planning facts, live decisions, reports, and sealed result revisions remain as the audit record. Reverting likewise removes the original plan from active views.

Published native results are retained by default. To discard an accidental event completely, select **Also withdraw published results from public history and ratings**. This withdraws every published revision, removes the event from singles and pair-rating inputs, and durably queues a rating recalculation. A restart resumes pending work. Old result URLs stop showing withdrawn results. Linked Challonge tournaments and their results are retained; these actions do not change remote brackets.

The preview includes recorded/started matches, pending reports, and published result brackets. If a score or other live decision changes while the preview is open, review the updated preview before confirming again. A retirement decision closes the old event before its planner projection changes, and interrupted or repeated requests resume the same operation without creating duplicate drafts. The ordinary pause/resume controls retain the existing draw and remain suitable for a temporary break in play.

## Recovering a legacy pool order

When a withdrawal erased a confirmed order in an older native event, an administrator can open **Event planner → Pools** and select **Check journal for original order** on the affected pool. Review the recorded places and withdrawal, enter a reason, and restore the original order. The planner records this action in event history. The finals draw, scores, and published result stay as recorded.

Recovery requires the complete prior order and the withdrawal that cleared it in the same imported legacy journal. It is available for a locked draw or an already published legacy V1 result. The review reads the journal in small forward pages and stops if it exceeds 400 facts. The cap bounds the work for this on-demand check. A missing record also stops the review. A frozen draw may retain qualifiers without the complete finishing order. Cases erased before journal adoption need separate evidence, and results that embed pool orders require a separate publication review.

Before any restoration, the repair code can be reverted without adding a journal compatibility requirement. A successful restoration appends `DecisionRecordedV11`. After that, recover or redeploy the affected stream with a build that reads V11, including a forward fix if needed. An image from before this change cannot replay that fact. Keep the original journal and its repair record together.
