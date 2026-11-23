import { useRouterState } from '@tanstack/react-router';
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Markdown, slugify } from 'markdown-to-jsx';
import changelog from '../../CHANGELOG.md?raw';
import { Disclosure } from '../components/ui/Disclosure';
import { PageHeader } from '../components/ui/PageHeader';
import { readChangelog, releaseGroupHeadings, type ChangelogRelease } from '../lib/changelog.mjs';
import './ChangelogPage.css';

const categoryStyles = new Map([
  ['Milestone', 'milestone'],
  ['Feature', 'feature'],
  ['Improvement', 'improvement'],
  ['Fix', 'fix'],
  ['Maintenance', 'maintenance'],
]);
const releaseGroups = new Set([
  ...releaseGroupHeadings,
  'Major Changes',
  'Minor Changes',
  'Patch Changes',
]);
const archiveTitle = 'Before versioned releases';
const archiveAnchor = slugify(archiveTitle);
const olderId = 'changelog-older';
const archiveId = 'changelog-archive-notes';
const recentReleaseCount = 3;
const { releases, archive } = readChangelog(changelog);
const archiveNotes = archive.replace(/^## Before versioned releases\n+/, '');
const archiveAnchors = new Set([
  archiveAnchor,
  ...Array.from(archiveNotes.matchAll(/^#{2,6} (.+)$/gm), ([, heading]) => slugify(heading)),
]);

function GroupHeading({ children, ...props }: ComponentProps<'h3'>) {
  const [text] = Children.toArray(children);
  return (
    <h3
      {...props}
      className={
        typeof text === 'string' && releaseGroups.has(text) ? 'changelog-release-group' : undefined
      }
    >
      {children}
    </h3>
  );
}

/** Recognise only the entry prefix, optionally after a generated Changesets date. */
function withCategory(children: ReactNode): ReactNode {
  const parts = Children.toArray(children);
  const first = parts[0];
  const hasDate = typeof first === 'string' && /^\d{1,2} [A-Za-z]+ \d{4} · $/.test(first);
  const categoryIndex = hasDate ? 1 : 0;
  const category = parts[categoryIndex];
  const suffix = parts[categoryIndex + 1];
  if (
    !isValidElement<ComponentProps<'strong'>>(category) ||
    category.type !== 'strong' ||
    typeof suffix !== 'string' ||
    !suffix.startsWith(' · ')
  )
    return children;
  const labels = Children.toArray(category.props.children);
  const [label] = labels;
  const style =
    labels.length === 1 && typeof label === 'string' ? categoryStyles.get(label) : undefined;
  if (!style) return children;
  return (
    <>
      {hasDate && first}
      <strong className={`chip changelog-category changelog-category-${style}`}>{label}</strong>
      {suffix.slice(3)}
      {parts.slice(categoryIndex + 2)}
    </>
  );
}

function ChangelogEntry({ children, ...props }: ComponentProps<'li'>) {
  const [first, ...rest] = Children.toArray(children);
  // A list item that has a separate Markdown paragraph (for example, a screenshot)
  // starts with a paragraph node. Leave its remaining nodes to the Markdown renderer.
  const content =
    isValidElement<ComponentProps<'p'>>(first) && first.type === 'p'
      ? [cloneElement(first, {}, withCategory(first.props.children)), ...rest]
      : withCategory(children);
  return <li {...props}>{content}</li>;
}

function Screenshot({ src, alt }: ComponentProps<'img'>) {
  return <img src={src?.replace(/^\.\/public\//, '/')} alt={alt} loading="lazy" />;
}

const noteOverrides = { h3: GroupHeading, li: ChangelogEntry, img: Screenshot };

function releaseNotesId(anchor: string) {
  return `changelog-notes-${anchor}`;
}

function Release({ release, open }: { release: ChangelogRelease; open: boolean }) {
  const { anchor, highlights, notes, version } = release;
  return (
    <article className="changelog-release" aria-labelledby={anchor}>
      <h2 id={anchor} tabIndex={-1}>
        <a href={`https://github.com/ashleylamont/smashclub-seeding/releases/tag/v${version}`}>
          {version}
        </a>
      </h2>
      {highlights && (
        <Markdown
          className="changelog-highlights"
          options={{
            disableParsingRawHTML: true,
            forceBlock: true,
            forceWrapper: true,
            overrides: { img: () => null },
          }}
        >
          {highlights}
        </Markdown>
      )}
      <Disclosure
        id={releaseNotesId(anchor)}
        title={
          <>
            Full notes<span className="visually-hidden"> for {version}</span>
          </>
        }
        defaultOpen={open}
        mountWhenClosed={false}
      >
        <Markdown
          options={{
            disableParsingRawHTML: true,
            overrides: noteOverrides,
            slugify: (heading) => `${anchor}-${slugify(heading)}`,
          }}
        >
          {notes}
        </Markdown>
      </Disclosure>
    </article>
  );
}

function expand(id: string) {
  document.getElementById(id)?.dispatchEvent(new Event('ui:expand'));
}

export function ChangelogPage() {
  const page = useRef<HTMLDivElement>(null);
  const hash = useRouterState({ select: (state) => state.location.hash });
  const linkedRelease = releases.findIndex(({ anchor }) => anchor === hash);
  const linkedArchive = archiveAnchors.has(hash);
  const openOlder = linkedRelease >= recentReleaseCount || linkedArchive;

  useEffect(() => {
    if (!hash) return;
    if (openOlder) expand(olderId);

    // The router initially scrolls before fonts and disclosures settle.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const options = { capture: true, passive: true, signal: controller.signal };
    for (const event of ['keydown', 'pointerdown', 'wheel']) {
      window.addEventListener(event, cancel, options);
    }
    let frame = requestAnimationFrame(() => {
      if (linkedRelease >= 0) expand(releaseNotesId(hash));
      if (linkedArchive) expand(archiveId);
      void document.fonts.ready.then(() => {
        if (controller.signal.aborted) return;
        frame = requestAnimationFrame(() => {
          if (controller.signal.aborted) return;
          cancel();
          const target = document.getElementById(hash);
          if (!target || !page.current?.contains(target)) return;
          target.tabIndex = -1;
          target.focus({ preventScroll: true });
          const top = target.getBoundingClientRect().top;
          const margin = Number.parseFloat(getComputedStyle(target).scrollMarginBlockStart);
          if (top < margin - 1 || top >= window.innerHeight) target.scrollIntoView();
        });
      });
    });
    return () => {
      cancel();
      cancelAnimationFrame(frame);
    };
  }, [hash, linkedArchive, linkedRelease, openOlder]);

  return (
    <div className="page changelog-page" ref={page}>
      <PageHeader title="Nemesis changelog" />
      {releases.slice(0, recentReleaseCount).map((release) => (
        <Release key={release.version} release={release} open={release.anchor === hash} />
      ))}
      <Disclosure
        id={olderId}
        title="Older releases"
        defaultOpen={openOlder}
        mountWhenClosed={false}
      >
        {releases.slice(recentReleaseCount).map((release) => (
          <Release key={release.version} release={release} open={release.anchor === hash} />
        ))}
        {archiveNotes && (
          <section>
            <h2 className="changelog-archive" id={archiveAnchor} tabIndex={-1}>
              {archiveTitle}
            </h2>
            <Disclosure
              id={archiveId}
              title="Archive notes"
              defaultOpen={linkedArchive}
              mountWhenClosed={false}
            >
              <Markdown options={{ disableParsingRawHTML: true, overrides: noteOverrides }}>
                {archiveNotes}
              </Markdown>
            </Disclosure>
          </section>
        )}
      </Disclosure>
    </div>
  );
}
