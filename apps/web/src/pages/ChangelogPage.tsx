import { Children, cloneElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { Markdown } from 'markdown-to-jsx';
import changelog from '../../CHANGELOG.md?raw';
import { PageHeader } from '../components/ui/PageHeader';
import './ChangelogPage.css';

const categoryStyles = new Map([
  ['Milestone', 'milestone'],
  ['Feature', 'feature'],
  ['Improvement', 'improvement'],
  ['Fix', 'fix'],
  ['Maintenance', 'maintenance'],
]);
const releaseTiers = new Set(['Major Changes', 'Minor Changes', 'Patch Changes']);

function ReleaseHeading({ children, ...props }: ComponentProps<'h2'>) {
  const [text] = Children.toArray(children);
  const version = typeof text === 'string' && /^\d+\.\d+\.\d+$/.test(text) ? text : null;
  return (
    <h2
      {...props}
      className={text === 'Before versioned releases' ? 'changelog-archive' : undefined}
    >
      {version ? (
        <a href={`https://github.com/ashleylamont/smashclub-seeding/releases/tag/v${version}`}>
          {version}
        </a>
      ) : (
        children
      )}
    </h2>
  );
}

function GroupHeading({ children, ...props }: ComponentProps<'h3'>) {
  const [text] = Children.toArray(children);
  return (
    <h3
      {...props}
      className={
        typeof text === 'string' && releaseTiers.has(text) ? 'changelog-release-tier' : undefined
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

export function ChangelogPage() {
  return (
    <div className="page changelog-page">
      <PageHeader title="Nemesis changelog" />
      <Markdown
        options={{
          disableParsingRawHTML: true,
          overrides: {
            h1: () => null,
            h2: ReleaseHeading,
            h3: GroupHeading,
            li: ChangelogEntry,
            img: Screenshot,
          },
        }}
      >
        {changelog}
      </Markdown>
    </div>
  );
}
