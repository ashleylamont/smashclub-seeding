import { useState, useEffect } from 'react';
import { Leaderboard } from './components/Leaderboard';
import { PlayerProfile } from './components/PlayerProfile';
import { RatingsOverTime } from './components/RatingsOverTime';
import { loadRankings, loadMatchHistory } from './utils/dataLoader';
import type { PlayerRanking, MatchHistoryRow } from './types';
import './App.css';

function App() {
  const [rankings, setRankings] = useState<PlayerRanking[]>([]);
  const [matchHistory, setMatchHistory] = useState<MatchHistoryRow[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerRanking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);
        const [rankingsData, historyData] = await Promise.all([
          loadRankings(),
          loadMatchHistory().catch(() => []), // Match history is optional
        ]);
        setRankings(rankingsData);
        setMatchHistory(historyData);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, []);

  if (loading) {
    return (
      <div className="app-loading">
        <h2>Loading Smash Club Rankings...</h2>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-error">
        <h2>Error Loading Data</h2>
        <p>{error}</p>
        <p>Make sure glicko_exports/glicko_rankings.json exists in the public folder.</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎮 Atlassian Smash Club Rankings</h1>
        <p className="subtitle">Glicko-2 based competitive rankings</p>
      </header>

      <main className="app-main">
        <Leaderboard rankings={rankings} onPlayerSelect={setSelectedPlayer} />
        <RatingsOverTime matchHistory={matchHistory} rankings={rankings} />
      </main>

      {selectedPlayer && (
        <PlayerProfile
          player={selectedPlayer}
          matchHistory={matchHistory}
          onClose={() => setSelectedPlayer(null)}
        />
      )}
    </div>
  );
}

export default App;
