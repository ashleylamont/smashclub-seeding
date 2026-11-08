# Nemesis Changesets

Each pull request adds a Changeset with `pnpm changeset`. Select `@smashclub/web` for the Nemesis application, including server, database and maintenance changes. Release PRs consume the pending notes.

Start the note with a category and a short summary, for example `**Fix** · Keep the score-reporting QR visible on crowded OBS sources.` Use **Milestone** for major shifts, **Feature** for new capabilities, **Improvement** for refinements, **Fix** for defects and **Maintenance** for internal work. Choose the SemVer bump separately. A patch can include fixes, maintenance and small improvements.

Use optional Markdown paragraphs or an illustration when it helps explain a change. Store approved screenshots under `apps/web/public/changelog/` and link them as `![Alt text](./public/changelog/example.png)`. Use synthetic fixtures or public data appropriate for release notes.

The release formatter adds the Sydney date and build where the note landed on `main`. See [the release guide](../docs/development.md#versioned-releases) for cutting and publishing a version.
