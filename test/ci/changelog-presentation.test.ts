import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { formatChangelog, groupReleaseNotes } from '../../apps/web/src/lib/changelog.mjs';

const repo = 'https://github.com/ashleylamont/smashclub-seeding';
const build = `[build abcdef1](${repo}/commit/abcdef1234567890abcdef1234567890abcdef12)`;
const source = `[#42](${repo}/pull/42) · ${build}`;
const archive = '## Before versioned releases\n\n### 20 October 2025\n\n- Older entry.\n';

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

  it('generates GitHub notes with the exact version screenshot URL and no neighboring release', () => {
    const notes = execFileSync(process.execPath, ['scripts/release-notes.mjs', '0.3.0'], {
      encoding: 'utf8',
    });
    expect(notes.match(/^### .+$/gm)).toEqual([
      '### New and improved',
      '### Fixes',
      '### Maintenance',
    ]);
    expect(notes).toContain('Press S on the overlay');
    expect(notes).toContain(
      'https://raw.githubusercontent.com/ashleylamont/smashclub-seeding/v0.3.0/apps/web/public/changelog/obs-twitch-link.png',
    );
    expect(notes).toContain(`*8 November 2026 · [#247](${repo}/pull/247) · [build `);
    expect(notes).not.toContain('### Minor Changes');
    expect(notes).not.toContain('## 0.2.11');
  });
});
