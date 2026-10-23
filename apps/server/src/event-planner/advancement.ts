// Compatibility exports for existing planner consumers. Rules live in the pure engine.
export {
  winnersCount,
  consolationQualifiers,
  buildConsolationBracket,
  standardBracketOrder,
  championshipQualifiers,
} from '@smashclub/engine';

export type { PoolFinisher, ConsolationEntrant, ConsolationBracket } from '@smashclub/engine';
