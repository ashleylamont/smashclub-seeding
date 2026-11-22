import { useState } from 'react';
import { APP_VERSION, BUILD_LABEL } from '../lib/build';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

const buildContext = `v${APP_VERSION} · build ${BUILD_LABEL}`;
const draftUrl = new URL('https://github.com/ashleylamont/smashclub-seeding/issues/new');
draftUrl.searchParams.set(
  'body',
  `<!-- Describe the bug or idea. For a bug, include what you expected and the steps to reproduce it. For an idea, explain what would improve. -->\n\nNemesis ${buildContext}`,
);

export function FeedbackDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Give feedback"
      description="Write and submit your feedback on GitHub. Issues are public and posting requires a GitHub account. Leave out private details."
      trigger={
        <Button variant="plain" className="link-button">
          Give feedback
        </Button>
      }
    >
      <p>Draft includes {buildContext}.</p>
      <div className="modal-actions">
        <Button asChild variant="primary">
          <a href={draftUrl.href} target="_blank" rel="noopener noreferrer">
            Open GitHub draft (new tab)
          </a>
        </Button>
      </div>
    </Dialog>
  );
}
