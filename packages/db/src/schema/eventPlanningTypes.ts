export interface HistoricalAdoptionBracket {
  division: 'upper' | 'lower';
  stage: 'main' | 'consolation';
  tournamentId: string;
  name: string;
  slug: string;
  participantCount: number;
  previousSlug: string | null;
}
export interface HistoricalAdoptionDifferences {
  plannedOnly: { name: string; playerId: string | null }[];
  actualOnly: { name: string; playerId: string | null }[];
  divisionChanges: {
    name: string;
    playerId: string;
    plannedDivision: 'upper' | 'lower';
    actualDivision: 'upper' | 'lower';
  }[];
}
export interface HistoricalAdoptionRecord {
  adoptedAt: string;
  adoptedBy: string;
  previousStatus: string;
  previousBrackets: {
    division: 'upper' | 'lower';
    stage: 'main' | 'consolation';
    tournamentId: string | null;
    challongeSlug: string | null;
  }[];
  brackets: HistoricalAdoptionBracket[];
  differences: HistoricalAdoptionDifferences;
  warnings: string[];
}
export interface HistoricalAdoption extends HistoricalAdoptionRecord {
  history: HistoricalAdoptionRecord[];
}
