# Nemesis Changesets

Each pull request adds a Changeset with `pnpm changeset`. Select `@smashclub/web` for the Nemesis application, including server, database and maintenance changes. Release PRs consume the pending notes.

Start the note with a category and a short summary. Use **Milestone** for major shifts, **Feature** for new capabilities, **Improvement** for refinements, **Fix** for defects and **Maintenance** for internal work. The category describes the change's purpose. Choose its SemVer bump separately.

- **Patch** for fixes, maintenance and small compatible refinements.
- **Minor** for substantial compatible capabilities. Before 1.0, use a minor bump for an intentional compatibility break and include explicit migration notes.
- **Major** for a deliberate 1.0 stability milestone or a change that breaks a published contract after 1.0.

Consider existing user workflows, API clients, persisted event data and OBS browser-source links or settings when judging compatibility.

Lead with what the reader can do or what works differently. Use the names people see on screen and give a starting point for an unfamiliar action. Put any required setup in the first sentence when it fits. Use a follow-up paragraph for steps or links when they need more room.

| Audience | Example |
| --- | --- |
| Players | `**Fix** · Keep your unsent score when you reload Event Night in the same tab.` |
| Organisers | `**Improvement** · Open Needs attention to review disputed scores without searching the match list.` |
| Stream operators | `**Feature** · Add a Twitch link to your OBS overlay. In Display setup, save your channel and copy the updated browser source URL into OBS.` |
| Maintainers | `**Maintenance** · Run browser checks in parallel to shorten the wait for a verified build.` |

Use optional Markdown paragraphs or an illustration when it helps explain a change. Store approved screenshots under `apps/web/public/changelog/` and link them as `![Alt text](./public/changelog/example.png)`. Use synthetic fixtures or public data appropriate for release notes.

The release formatter adds the Sydney date and build where the note landed on `main`. See [the release guide](../docs/development.md#versioned-releases) for cutting and publishing a version.
