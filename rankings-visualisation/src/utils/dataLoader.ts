import Papa from 'papaparse';
import type { PlayerRanking, MatchHistoryRow } from '../types';

export async function loadRankings(): Promise<PlayerRanking[]> {
  const response = await fetch('/glicko_exports/glicko_rankings.json');
  const data = await response.json();
  
  return data;
}

export async function loadMatchHistory(): Promise<MatchHistoryRow[]> {
  const response = await fetch('/glicko_exports/glicko_match_history.csv');
  const text = await response.text();
  
  return new Promise((resolve, reject) => {
    Papa.parse<MatchHistoryRow>(text, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (results) => {
        resolve(results.data);
      },
      error: (error: Error) => {
        reject(error);
      },
    });
  });
}
