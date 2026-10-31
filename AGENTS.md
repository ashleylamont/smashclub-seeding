# Repository guidance

## UI work

Read [UI foundations](docs/ui-foundations.md) and [visual review](docs/ui-visual-review.md) before changing a page or shared component. Inspect the relevant `/ui` gallery examples and an existing comparable app screen.

- Use `apps/web/src/components/ui` for controls and feedback, including `Button asChild` for button-like navigation and `Progress` for progress bars. New primitives belong in that shared layer and the gallery.
- Use the spacing, font, color, radius and state tokens in `styles/tokens.css`. Page CSS owns composition and domain data layout; control appearance belongs in `styles/ui.css`. Avoid page-specific replacement buttons, browser-default widgets and copied control styling.
- The app uses square edges, Oswald headings, Inter reading text and JetBrains Mono figures. Review both dark field and light paper themes. Standalone OBS and exported graphics have intentional compositions; embedded app content must use the surrounding app theme.
- Review the complete route after composing components. Check hierarchy, spacing, wrapping, repeated messages and whether copy matches active, completed, pending and interrupted states. Individually correct components can still produce an inconsistent page.
- Preserve reporting identity/privacy, score drafts, revisions, retry request IDs and permissions while changing presentation. Keep actual player/result facts authoritative.
- For shared CSS or primitives, inspect other consumers, including player, TO and OBS views. Fix concrete regressions or track a scoped follow-up; do not describe an unperformed audit as complete.
- Scope reusable domain layouts to the component, not an ancestor's palette class. Expand disclosures during review: hidden brackets, tables and forms can conceal cross-page selector collisions and phone overflow.
- Validate representative phone and desktop views in both themes with long aliases, keyboard navigation and accessibility checks. Add a rendered regression fixture for the state that exposed a defect; a passing typecheck or Axe scan does not establish visual consistency.
- Run normal visual CI before baseline updates. Manually compare every intended expected/actual/difference image, update only approved platform-specific images, then rerun normal CI. Keep assertions, tolerances and required gates intact. Linux captures must not replace Darwin baselines.

UI changes are complete only after inspecting the rendered page and recording the relevant validation.
