import type { LiveMatch } from './eventDisplay';
import { finalsFieldLabel } from './qualification';

type CaptionFacts = Pick<
  LiveMatch,
  | 'division'
  | 'stage'
  | 'label'
  | 'labelFromStructure'
  | 'nativeBracketId'
  | 'sourceKey'
  | 'sourceSetId'
>;

/** Remove only the prefix added by prepare() to an imported final. The suffix belongs to the source. */
export function linkedFinalCaption(match: CaptionFacts) {
  const { division, stage, label, sourceKey, sourceSetId } = match;
  if (
    !sourceSetId ||
    sourceKey !== `set:${sourceSetId}` ||
    match.nativeBracketId ||
    match.labelFromStructure ||
    (division !== 'upper' && division !== 'lower') ||
    (stage !== 'main' && stage !== 'consolation')
  )
    return null;
  const prefix = `${division} ${stage} · `;
  if (!label.startsWith(prefix)) return null;
  const identifier = label.slice(prefix.length);
  if (!identifier.trim()) return null;
  const context = finalsFieldLabel({ division, stage });
  return { context, identifier, text: `${context} · ${identifier}` };
}
