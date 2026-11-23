import { isCharacterSlug, MAX_CHARACTERS_PER_PLAYER } from '@smashclub/shared';
import { graphicMemberKey, graphicMembers, type GraphicResult } from './resultGraphic';
import { readResultPortrait } from './resultGraphicPortrait';

export interface GraphicProfileMains {
  key: string;
  place: number;
  name: string;
  teamName: string | null;
  mains: string[];
}

export function graphicProfileMains(rows: readonly GraphicResult[]): GraphicProfileMains[] {
  return rows.flatMap((row, rowIndex) =>
    graphicMembers(row).flatMap(({ name, profileMains }, index) => {
      const mains = [...new Set(profileMains?.filter(isCharacterSlug))].slice(
        0,
        MAX_CHARACTERS_PER_PLAYER,
      );
      return mains.length < 2
        ? []
        : [
            {
              key: graphicMemberKey(row, rowIndex, index),
              place: row.place,
              name,
              teamName: row.graphic?.teamName ?? null,
              mains,
            },
          ];
    }),
  );
}

export async function loadProfileMainsIcons(
  entries: readonly GraphicProfileMains[],
  signal: AbortSignal,
) {
  const icons = new Map<string, HTMLCanvasElement>();
  if (!entries.length || signal.aborted) return icons;
  const request = new AbortController();
  const stop = () => request.abort();
  signal.addEventListener('abort', stop, { once: true });
  const timeout = window.setTimeout(stop, 6000);
  const slugs = new Set(entries.flatMap(({ mains }) => mains));
  try {
    await Promise.all(
      [...slugs].map(async (slug) => {
        try {
          const response = await fetch(`/characters/${slug}.png`, {
            signal: request.signal,
            redirect: 'error',
          });
          if (!response.ok) return;
          const blob = await response.blob();
          const icon = await readResultPortrait(
            new File([blob], `${slug}.png`, { type: blob.type }),
          );
          if (!request.signal.aborted) icons.set(slug, icon);
        } catch {
          // The appendix still draws a text label for unavailable icons.
        }
      }),
    );
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', stop);
  }
  return icons;
}
