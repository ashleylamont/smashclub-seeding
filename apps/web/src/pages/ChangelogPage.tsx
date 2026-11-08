import Markdown from 'markdown-to-jsx';
import changelog from '../../CHANGELOG.md?raw';
import { PageHeader } from '../components/ui/PageHeader';
import './ChangelogPage.css';

export function ChangelogPage() {
  return (
    <div className="page changelog-page">
      <PageHeader title="Nemesis changelog" />
      <Markdown options={{ disableParsingRawHTML: true, overrides: { h1: () => null } }}>
        {changelog}
      </Markdown>
    </div>
  );
}
