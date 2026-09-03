/** How a tournament's recorded stages contribute to ratings and recaps. */
export type ResultsMode = 'auto' | 'final_stage_only';
export type ResultStage = 'group' | 'final';

/** Single-stage matches are final-stage matches, so Auto works for both formats. */
export function includesResultStage(mode: ResultsMode, stage: ResultStage): boolean {
  return mode !== 'final_stage_only' || stage !== 'group';
}
