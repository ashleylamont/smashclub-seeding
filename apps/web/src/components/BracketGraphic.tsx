import { useEffect, useState } from 'react';
import {
  bracketGraphicPng,
  bracketPngScale,
  browserBracketGraphic,
  type BracketGraphicContext,
  type BracketGraphicImage,
} from '../lib/bracketGraphic';
import type { LiveMatch } from '../lib/eventDisplay';
import { downloadBlob } from '../lib/shareCard';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Notice } from './ui/Feedback';
import './BracketGraphic.css';

export function BracketGraphic({
  context,
  matches,
}: {
  context: BracketGraphicContext;
  matches: LiveMatch[];
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    context: BracketGraphicContext;
    image: { graphic: BracketGraphicImage; blob: Blob; url: string } | null;
  }>();
  useEffect(
    () => () => {
      if (snapshot?.image) URL.revokeObjectURL(snapshot.image.url);
    },
    [snapshot],
  );
  return (
    <Dialog
      title="Bracket graphic"
      description={`${snapshot?.context.scope ?? context.scope} · Scroll the preview to follow later rounds. The image shows recorded scores.`}
      trigger={
        <Button aria-label={`Preview bracket graphic for ${context.scope}`}>Bracket graphic</Button>
      }
      open={open}
      onOpenChange={(next) => {
        // Freeze a coherent public snapshot when the dialog opens. Polling can
        // update the live bracket behind it without replacing a download.
        if (next) {
          const graphic = browserBracketGraphic(context, matches);
          const blob = graphic && new Blob([graphic.svg], { type: 'image/svg+xml;charset=utf-8' });
          setSnapshot({
            context,
            image: graphic && blob ? { graphic, blob, url: URL.createObjectURL(blob) } : null,
          });
        } else setSnapshot(undefined);
        setOpen(next);
      }}
      wide
    >
      {open &&
        (snapshot?.image ? (
          <BracketPreview context={snapshot.context} image={snapshot.image} />
        ) : (
          <Notice tone="warning">A bracket image is unavailable for this draw.</Notice>
        ))}
    </Dialog>
  );
}

function BracketPreview({
  context,
  image,
}: {
  context: BracketGraphicContext;
  image: { graphic: BracketGraphicImage; blob: Blob; url: string };
}) {
  const { graphic } = image;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const png = bracketPngScale(graphic) >= 0.65;
  const filename = `${context.eventName}-${context.scope}`
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 84);
  const base = `nemesis-${filename || 'draw'}-bracket`;
  async function downloadPng() {
    setPending(true);
    setError(false);
    try {
      const blob = await bracketGraphicPng(graphic, image.blob);
      if (blob) downloadBlob(blob, `${base}.png`);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="bracket-graphic-preview">
      <div
        className="bracket-graphic-image"
        role="region"
        aria-label="Scrollable bracket image preview"
        tabIndex={0}
      >
        <img
          src={image.url}
          width={graphic.width}
          height={graphic.height}
          alt={`${context.eventName} · ${context.scope} bracket`}
        />
      </div>
      <div className="bracket-graphic-actions">
        {png && (
          <Button variant="primary" pending={pending} onClick={() => void downloadPng()}>
            {pending ? 'Preparing PNG…' : 'Download bracket PNG'}
          </Button>
        )}
        <Button
          variant={png ? undefined : 'primary'}
          onClick={() => downloadBlob(image.blob, `${base}.svg`)}
        >
          Download bracket SVG
        </Button>
      </div>
      {!png && (
        <p className="muted">
          This draw is too large for a readable PNG. Download the SVG to zoom in without losing
          detail.
        </p>
      )}
      {error && (
        <Notice tone="warning">
          The PNG could not be prepared. You can still download the SVG.
        </Notice>
      )}
    </div>
  );
}
