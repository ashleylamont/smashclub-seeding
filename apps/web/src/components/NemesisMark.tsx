import { NEMESIS_MARK_PATHS } from '../lib/nemesisMark';

/** Shared club mark, used on the event screens and main navigation. */
export function NemesisMark() {
  return (
    <svg className="nemesis-mark" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
      <path d={NEMESIS_MARK_PATHS[0]} />
      <path d={NEMESIS_MARK_PATHS[1]} opacity=".45" />
    </svg>
  );
}
