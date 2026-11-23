import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatChangelog,
  groupReleaseNotes,
  readChangelog,
} from '../../apps/web/src/lib/changelog.mjs';

const repo = 'https://github.com/ashleylamont/smashclub-seeding';
const build = `[build abcdef1](${repo}/commit/abcdef1234567890abcdef1234567890abcdef12)`;
const source = `[#42](${repo}/pull/42) · ${build}`;
const archive = '## Before versioned releases\n\n### 20 October 2025\n\n- Older entry.\n';
const disclosure = '\n\n<details>\n<summary>Full release notes</summary>\n\n';

const publishedNotes = (version: string, cwd?: string) =>
  execFileSync(process.execPath, ['scripts/release-notes.mjs', version], {
    cwd,
    encoding: 'utf8',
  });

describe('release note presentation', () => {
  it('groups explicit categories across bumps while keeping nested Markdown, provenance and unlabelled notes', () => {
    const release = [
      'Released 8 November 2026.',
      '',
      '### Minor Changes',
      '',
      '- **Maintenance** · Check the integration fixtures.',
      '',
      '### Patch Changes',
      '',
      `- 8 November 2026 · **Fix** · Keep your score when changing tabs. ${source}`,
      `- 9 November 2026 · **Improvement** · Find [the setup instructions](/help). ${build}`,
      '',
      '  Follow the steps below.',
      '',
      '  1. Open Display setup.',
      '     - Set your channel.',
      '',
      '  ![Display setup](./public/changelog/setup.png)',
      '',
      '- Keep the original wording of this older note.',
    ].join('\n');

    const grouped = groupReleaseNotes(release);
    expect(grouped.match(/^### .+$/gm)).toEqual([
      '### New and improved',
      '### Fixes',
      '### Other changes',
      '### Maintenance',
    ]);
    expect(grouped).toContain('Released 8 November 2026.');
    expect(grouped).toContain(
      `- **Improvement** · Find [the setup instructions](/help).\n\n  Follow the steps below.\n\n  1. Open Display setup.\n     - Set your channel.\n\n  ![Display setup](./public/changelog/setup.png)\n\n  *9 November 2026 · ${build}*`,
    );
    expect(grouped).toContain(
      `Keep your score when changing tabs.\n\n  *8 November 2026 · ${source}*`,
    );
    expect(grouped).toContain('- Keep the original wording of this older note.');
    expect(formatChangelog(`# Nemesis changelog\n\n## 2.0.0\n\n${release}\n\n${archive}`)).toBe(
      `# Nemesis changelog\n\n## 2.0.0\n\n${grouped}\n\n${archive}`,
    );
  });

  it('preserves a release with custom Markdown outside the generated list format', () => {
    const release = '### Patch Changes\n\n- **Fix** · A note.\n\n> A historical note.';
    expect(groupReleaseNotes(release)).toBe(release);
  });

  it('reads historical introductions and chooses actual public changes for newly versioned releases', () => {
    const futureNotes = [
      '### Patch Changes',
      '',
      `- 8 November 2026 · **Maintenance** · Update browser tooling. ${source}`,
      '',
      `- 8 November 2026 · **Fix** · Keep a score draft on reload. ${source}`,
      '',
      `- 8 November 2026 · **Feature** · Follow your matches. ${source}`,
      '',
      '- **Fix** · A third change stays in the full notes.',
    ].join('\n');
    const intro = 'Open your saved score drafts from **Event Night**.';
    const olderNotes = '### Patch Changes\n\n- **Maintenance** · Update the visual checks.';
    const { releases, archive: oldNotes } = readChangelog(
      `# Nemesis changelog\n\n## 1.0.0\n\n${futureNotes}\n\n## 0.21.1\n\n${intro}\n\n${olderNotes}\n\n## 0.2.11\n\n${olderNotes}\n\n${archive}`,
    );
    expect(releases).toEqual([
      {
        version: '1.0.0',
        anchor: '100',
        highlights: '- Follow your matches.\n- Keep a score draft on reload.',
        notes: groupReleaseNotes(futureNotes),
      },
      {
        version: '0.21.1',
        anchor: '0211',
        highlights: intro,
        notes: groupReleaseNotes(olderNotes),
      },
      {
        version: '0.2.11',
        anchor: '0211-1',
        highlights: '- Update the visual checks.',
        notes: groupReleaseNotes(olderNotes),
      },
    ]);
    expect(oldNotes).toBe(archive);
  });

  it.each([
    {
      description: 'an authored summary',
      summary: 'See how Nemesis rankings and tournament tools developed.',
      highlights: 'See how Nemesis rankings and tournament tools developed.',
    },
    {
      description: 'a generated summary',
      summary: '',
      highlights: '- Introduce the public Nemesis changelog.',
    },
  ])(
    'keeps legacy release build provenance in the full notes with $description',
    ({ summary, highlights }) => {
      const metadata = `Released 8 November 2026 · [release build cecd3d4](${repo}/commit/cecd3d4297b78b3fd03531e5f7c016578fa97739)`;
      const milestone = '- **Milestone** · Introduce the public Nemesis changelog.';
      const markdown = [
        '# Nemesis changelog',
        '## 0.1.0',
        summary,
        metadata,
        '### Minor Changes',
        milestone,
      ]
        .filter(Boolean)
        .join('\n\n');
      expect(readChangelog(markdown).releases).toEqual([
        {
          version: '0.1.0',
          anchor: '010',
          highlights,
          notes: `${metadata}\n\n### New and improved\n\n${milestone}`,
        },
      ]);
    },
  );

  it('starts mixed GitHub releases with two reader-facing changes and keeps full notes available', () => {
    const [highlights, details] = publishedNotes('0.23.6').split(disclosure);
    const leads = highlights.split('\n');
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatch(/^- In OBS Display setup, turn on \*\*Use event Twitch announcement/);
    expect(leads[1]).toMatch(/^- Turn on Include profile mains/);
    expect(highlights).not.toContain('https://github.com/');
    expect(details).toContain('### New and improved');
    expect(details).toContain('Read both player names and the recorded result');
    expect(details).toContain('### Maintenance');
    expect(details).toContain('Speed up release verification');
    expect(details).toContain(`*23 November 2026 · [#596](${repo}/pull/596) · [build `);
    expect(details).toMatch(/\n\n<\/details>\n$/);
  });

  it('uses the authored summary and keeps the exact version screenshot and source in full GitHub notes', () => {
    const notes = publishedNotes('0.3.0');
    const [highlights, details] = notes.split(disclosure);
    expect(highlights).toMatch(/^Stream operators could add a Twitch channel link/);
    expect(highlights).not.toContain('Press S on the overlay');
    expect(details.match(/^### .+$/gm)).toEqual([
      '### New and improved',
      '### Fixes',
      '### Maintenance',
    ]);
    expect(details).toContain('Press S on the overlay');
    expect(details).toContain(
      'https://raw.githubusercontent.com/ashleylamont/smashclub-seeding/v0.3.0/apps/web/public/changelog/obs-twitch-link.png',
    );
    expect(details).toContain(`*8 November 2026 · [#247](${repo}/pull/247) · [build `);
    expect(notes).not.toContain('### Minor Changes');
    expect(notes).not.toContain('## 0.2.11');
    expect(notes.match(/Stream operators could add a Twitch channel link/g)).toHaveLength(1);
  });

  it('keeps the legacy release build inside the GitHub disclosure', () => {
    const [highlights, details] = publishedNotes('0.1.0').split(disclosure);
    expect(highlights).toMatch(/^Nemesis introduced numbered releases/);
    expect(highlights).not.toContain('release build');
    expect(details).toMatch(/^Released 8 November 2026 · \[release build cecd3d4\]/);
  });

  describe('GitHub release note fallbacks', () => {
    let fixture: string;
    const noHighlights = '### Patch Changes\n\n> A historical note with no summary or list.';

    beforeAll(() => {
      fixture = mkdtempSync(join(tmpdir(), 'nemesis-release-highlights-'));
      mkdirSync(join(fixture, 'scripts'));
      mkdirSync(join(fixture, 'apps/web/src/lib'), { recursive: true });
      for (const file of ['scripts/release-notes.mjs', 'apps/web/src/lib/changelog.mjs']) {
        copyFileSync(file, join(fixture, file));
      }
      writeFileSync(
        join(fixture, 'apps/web/CHANGELOG.md'),
        [
          '# Nemesis changelog',
          '## 9.1.0',
          '### Patch Changes',
          `- 8 November 2026 · **Maintenance** · Verify recorded scores. ${source}`,
          '- **Maintenance** · Test the packaged app.',
          '## 9.0.0',
          noHighlights,
        ].join('\n\n'),
      );
    });

    afterAll(() => {
      if (fixture) rmSync(fixture, { recursive: true, force: true });
    });

    it('opens a maintenance-only release with one concrete change', () => {
      const [highlights, details] = publishedNotes('9.1.0', fixture).split(disclosure);
      expect(highlights).toBe('- Verify recorded scores.');
      expect(details).toContain('### Maintenance');
      expect(details).toContain(`*8 November 2026 · ${source}*`);
      expect(details).toContain('- Test the packaged app.');
    });

    it('shows the full Markdown directly when it has no usable opening', () => {
      expect(publishedNotes('9.0.0', fixture)).toBe(`${noHighlights}\n`);
    });
  });
});
