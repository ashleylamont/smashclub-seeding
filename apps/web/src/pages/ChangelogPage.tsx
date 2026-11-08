import { Children, type ComponentProps } from 'react';
import { Markdown } from 'markdown-to-jsx';
import changelog from '../../CHANGELOG.md?raw';
import { PageHeader } from '../components/ui/PageHeader';
import './ChangelogPage.css';

function ReleaseHeading({ children, ...props }: ComponentProps<'h2'>) {
  const [text] = Children.toArray(children);
  const version = typeof text === 'string' && /^\d+\.\d+\.\d+$/.test(text) ? text : null;
  return (
    <h2 {...props}>
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
          overrides: { h1: () => null, h2: ReleaseHeading, img: Screenshot },
        }}
      >
        {changelog}
      </Markdown>
    </div>
  );
}
