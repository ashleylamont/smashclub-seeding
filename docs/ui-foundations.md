# UI foundations

The working component gallery is at `/ui` (also linked from the admin navigation). Its examples use local state and never save players or tournament results. Use the Controls, Reporting and Foundations tabs to review controls, feedback, typography, colors and event workflows in both themes.

This is the first migration under [#63](https://github.com/ashleylamont/smashclub-seeding/issues/63), [#89](https://github.com/ashleylamont/smashclub-seeding/issues/89), [#94](https://github.com/ashleylamont/smashclub-seeding/issues/94) and [#88](https://github.com/ashleylamont/smashclub-seeding/issues/88). The richer main-stage desk in #73, unified event hub in #66 and bracket interaction work in #80 remain separate follow-ups.

## Component decision

Radix Primitives with shared CSS is the UI foundation across the app. Composite controls use Radix behind small wrappers in `apps/web/src/components/ui`; pages import those wrappers. Buttons, text inputs, textareas, semantic forms, tables and content sections use the same shared styles and retain browser semantics. Radix has no basic text-input or button primitive; `Button` supports Radix Slot composition through `asChild`.

Use Dialog for editing and previews, Alert Dialog for consequential confirmations, Popover for contextual help, Tabs for destinations, Select for choices, Checkbox/Switch for binary controls and Collapsible through `Disclosure` for expandable content. Public, profile, planner, settings and TO screens all follow this foundation. Do not add a page-specific control implementation or copy control appearance into a page stylesheet. Page CSS owns layout, data presentation and print content.

The app keeps its existing CSS and square visual identity. There is no Tailwind or shadcn dependency. Add another Radix primitive when a workflow needs its behavior, then wrap and style it in the shared layer.

Primary references: [Radix accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility), [Dialog](https://www.radix-ui.com/primitives/docs/components/dialog), [Alert Dialog](https://www.radix-ui.com/primitives/docs/components/alert-dialog), [Popover](https://www.radix-ui.com/primitives/docs/components/popover), [Tabs](https://www.radix-ui.com/primitives/docs/components/tabs), [Select](https://www.radix-ui.com/primitives/docs/components/select), [Checkbox](https://www.radix-ui.com/primitives/docs/components/checkbox), [Switch](https://www.radix-ui.com/primitives/docs/components/switch), [Collapsible](https://www.radix-ui.com/primitives/docs/components/collapsible) and [Slot](https://www.radix-ui.com/primitives/docs/utilities/slot). Radix uses the [MIT license](https://github.com/radix-ui/primitives/blob/main/LICENSE). Inter uses the [SIL Open Font License 1.1](https://github.com/rsms/inter/blob/master/LICENSE.txt); Inter, Oswald and JetBrains Mono are self-hosted through Fontsource. Axe is a development-only accessibility checker under [MPL 2.0](https://github.com/dequelabs/axe-core/blob/develop/LICENSE).

Dependencies live in `apps/web/package.json` and the root `pnpm-lock.yaml`. Auth, routing, queries and tournament API libraries stay in use.

## Tokens and ownership

`apps/web/src/styles/tokens.css` owns the palettes, fonts, spacing, type sizes, line heights, control sizes, focus ring, semantic states and layer order. `styles/ui.css` owns shared control, card, chip, feedback, field, dialog and tab styling. `styles/event.css` owns shared player/guest/TO match presentation; public pages no longer import the admin operations stylesheet. Page CSS owns its composition, not replacement control rules.

Keep the square arcade identity: dark field or light paper, Oswald headings, Inter reading text, JetBrains Mono numbers. Use `--s1` through `--s7` for spacing and `--fs-*` for type. Both the system light-theme block and explicit light-theme block currently carry the same palette; update them together. Text and control boundaries must remain readable in both themes. State labels, signs and messages carry meaning alongside color.

Controls have a 36px base height, 32px compact variant and 44px minimum on phone/coarse-pointer layouts. Phone input text is at least 16px. Do not use compact sizing for a dense phone workflow. Tables and bracket rounds can scroll within labelled regions; the page itself should not overflow horizontally. Focus rings and reduced-motion preferences are global.

## Shared building blocks

| Building block | Use and contract |
| --- | --- |
| `ui/Button` | Native button with Radix Slot support for `asChild`; default type is `button`. Specify `type="submit"` in forms. `pending` disables the action and sets `aria-busy`; keep a descriptive pending label. |
| `ui/Field` | Native input with linked label, hint and error. An error sets `aria-invalid`; pass `aria-describedby` for shared instructions. Callers own business validation. |
| `ui/Input`, `Textarea` | Shared native controls for existing labelled fields, file selection and browser validation. Prefer `Field` for a standalone text/number field. |
| `ui/Select`, `SelectItem` | Radix menu with keyboard navigation, typeahead, collision handling and disabled choices. `onValueChange` receives a string; numeric callers convert it explicitly. An empty item remains selectable and form submission uses the domain value. |
| `ui/Checkbox`, `Switch` | Radix binary controls; associate a visible label. `onCheckedChange` receives a boolean. Checked/disabled state and named form values remain available. |
| `ui/Disclosure` | Radix Collapsible with a named trigger and `defaultOpen`. Closed content stays mounted and hidden, preserving drafts. Attention links can expand ancestor disclosures before focusing their target. |
| `ui/ConfirmDialog`, `ConfirmCancel`, `useConfirmation` | Radix Alert Dialog focuses Cancel, contains focus and returns it to the action. Await `useConfirmation()` before a mutation; Cancel/Escape resolve false. Explicit confirmation dialogs retain the caller’s mutation and pending lifecycle. |
| `ui/Dialog` | Required title, optional description, close control, focus containment, Escape and return focus. Prefer a `trigger`; existing conditionally mounted callers can pass `open` and retain their opener. Closing calls `onOpenChange(false)`. Print previews use the same dialog with `print` and keep paper layout in their print stylesheet. |
| `ui/HelpPopover` (`InfoTip` compatibility export) | Labelled help button and Radix nonmodal popover. Works by keyboard and tap, fits the viewport and returns focus on Escape. Keep explanations optional. |
| `ui/Tabs` | Manual activation: arrows move focus, Enter/Space activates. Inactive panels remain mounted but hidden, preserving drafts. `TabList` requires an accessible label. |
| `ui/PageHeader` | Page heading, concise description and actions. Put the event's actual name in the heading. |
| `ui/Notice`, `LoadingState`, `EmptyState` | Inline error/status, busy feedback and an empty state with a next action. Failures should provide a retry when the user can recover. |
| `.card`, `.chip`, `.btn`, `.input`, `.select` | Shared CSS for semantic native sections, badges and controls. Include visible state text in chips; use real table elements for tabular data. |
| `ScoreFields` | Shared labelled game counts and winner hint for player, guest, correction and TO forms. Keep drafts as `ScoreInputValue` (`number \| ''`) so clearing a field stays empty; disable and guard submission until both scores are numbers. Each caller retains revisions, request IDs, permissions, submission policy and stale-write checks. |

Example:

```tsx
<form onSubmit={submit}>
  <Field label="TO email" type="email" value={email} error={error} onChange={changeEmail} />
  <Button type="submit" variant="primary" pending={saving}>
    {saving ? 'Saving…' : 'Add TO'}
  </Button>
</form>
```

Keep auth and mutation behavior in the caller. Reusing a control must not broaden permissions, treat a live score as final, discard an expected revision or generate a new request ID for a retry of the same submission.

## Operations workspace

The assigned-TO and admin routes share the same five destinations. `?view=` selects the destination and works with refresh and browser history. Existing `?plan=` admin links remain valid; the default is Run matches.

| Destination | Routine work |
| --- | --- |
| Run matches | Playing matches first, start/finish, score review and stations. Choose Ready to start for eligible pairings. Pool setup is a secondary disclosure. |
| Players | Find a player, follow their match or pool, adjust attendance. |
| Standings / draw | Pool standings, soft-lock, advancement, native finals and external bracket handoff. |
| Broadcast | Choose a station, update its live score or finish its match using the shared score card; open its overlay, manage announcements and awards. |
| Settings | Score policy, publication, guest QR access, TO access, reset and audit. |

Attention links switch destination, open ancestor disclosures, scroll and focus the relevant control. Switching tabs preserves edits; a full refresh still discards local drafts as before. The attention summary stays visible across destinations. Broadcast uses the same match controls and API; the OBS display remains a separate transparent composition. Its event title wraps instead of clipping, and idle/result rails use literal states without fallback announcements.

The initial Broadcast destination is a station selector plus the shared score card. Dedicated main-stage assignment, richer desk shortcuts and a unified public event hub need their own design and API review.

## Copy audit

Use the event name, state and next action. Preserve explanations that change a decision: approval policy, privacy, stale revisions, unfinished matches, holds, linking consequences and WHR/attendance rules.

| Surface | Change |
| --- | --- |
| App footer, live board, OBS and result rail | Removed recurring slogans, filler eyebrows and invented idle announcements. Actual announcement text and event identity remain. |
| Event discovery | `Events`, `Open event` and a short instruction to choose an event/name. |
| Signed-in and guest reporting | Shared heading and game-count controls; instructions and success text distinguish TO approval, immediate confirmation and disagreement. Guest expiry/revocation and device-name notices remain. |
| TO workspace | Five named destinations, Playing as the initial view, contextual empty-state guidance and secondary pool setup. |
| Account onboarding | Shorter steps; provider linking consequences remain explicit. |
| Leaderboard | A short rating description; the existing mathematical and attendance policy explanation moves into labelled help without changing its meaning. |
| Player profile | Reviewed; numerical history, identity and chart explanations remain useful and are retained. |

Avoid slogan headers, repeating helper paragraphs above every control and uppercase sentence copy. Short labels still need context: `Update live score` and `Finish match` are separate actions; `Keep recorded result` explains the review choice better than a generic confirmation button.

## Adoption and review

Use the shared components for every control. Keep primitive imports and control appearance in the shared layer. The linter recognizes shared controls for label checks. It also rejects native control elements and direct Radix imports in pages and domain components; new primitives belong in `components/ui`. Existing semantic sections, links, badges and tables use shared CSS directly.

Check the gallery and real workflow on phone and desktop, in both themes, with keyboard-only operation and long aliases. Extend the [UI visual suite](ui-visual-review.md) for new representative states. Browser tests choose items through the visible Radix menu and confirm through the Alert Dialog; they do not operate hidden form proxies. Keep server/domain tests as the authority for scoring and auth semantics.

The gallery includes empty/disabled choices, checkbox and switch labels, persisted disclosure drafts, form submission and cancellable confirmations. All existing control surfaces use the shared foundation, including print previews and local display setup. Result graphics, bracket drawings, charts and paper sheets keep their specialized rendering. Automated checks support review; they do not constitute a designer’s approval of the new baselines or a full screen-reader audit.
