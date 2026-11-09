import { readResultPortrait } from './resultGraphicPortrait';

// Vite emits URLs for the full portraits only. Browsers fetch the PNGs used by
// a preview. The URL query keeps files out of the JavaScript bundle.
const fullPortraits = import.meta.glob<string>(
  '/node_modules/smash-ultimate-assets/portraits/full/*.png',
  { eager: true, exhaustive: true, import: 'default', query: '?url&no-inline' },
);

export function bundledResultPortraitUrl(slug: string) {
  const filename = slug.replaceAll('-', '_');
  return fullPortraits[`/node_modules/smash-ultimate-assets/portraits/full/${filename}.png`];
}

export async function loadBundledResultPortrait(slug: string, signal: AbortSignal) {
  const url = bundledResultPortraitUrl(slug);
  if (!url || signal.aborted) return;
  try {
    const source = new URL(url, window.location.href);
    if (source.origin !== window.location.origin) return;
    const response = await fetch(source, { signal, redirect: 'error' });
    if (!response.ok || signal.aborted) return;
    const blob = await response.blob();
    return await readResultPortrait(new File([blob], `${slug}.png`, { type: blob.type }));
  } catch {
    // Missing, unreadable and interrupted artwork leave the original tag panel.
    return undefined;
  }
}
