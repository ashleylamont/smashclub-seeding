import { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { PlayerRanking, MatchHistoryRow } from '../types';
import './PlayerProfile.css';

interface PlayerProfileProps {
  player: PlayerRanking;
  matchHistory: MatchHistoryRow[];
  onClose: () => void;
}

export function PlayerProfile({ player, matchHistory, onClose }: PlayerProfileProps) {
  const playerMatches = useMemo(() => {
    // Match on name; company may differ between rankings (resolved) and match history (raw)
    return matchHistory
      .filter(m => m.player_name === player.name)
      .sort((a, b) => a.processing_index - b.processing_index);
  }, [matchHistory, player]);

  const ratingHistory = useMemo(() => {
    return playerMatches.map((m, idx) => ({
      match: idx + 1,
      date: m.date,
      tournament: m.tournament,
      opponent: m.opponent_name,
      result: m.won ? 'W' : 'L',
      rating: m.post_rating,
      conservative: m.post_rating - 2 * m.post_rd,
      rd: m.post_rd,
    }));
  }, [playerMatches]);

  const wins = playerMatches.filter(m => m.won === 1).length;
  const total = playerMatches.length;
  const winRate = total > 0 ? (wins / total * 100).toFixed(1) : '0';

  const confidenceExplainer = useMemo(() => {
    const s = player.score;
    if (!player.has_history) return 'No match history available.';
    const parts: string[] = [];
    parts.push(`Based on ${s.num_tournaments} event(s), ${s.unique_opponent_count} unique opponent(s), and ${s.match_count} total match(es).`);
    if (s.rookie_ratio > 0) {
      parts.push(`${(s.rookie_ratio * 100).toFixed(0)}% of matches are in rookie brackets.`);
      if (s.isolation_factor > 0) {
        parts.push(`Isolation factor: ${(s.isolation_factor * 100).toFixed(0)}% (rookie-only players with less main bracket exposure have higher uncertainty).`);
      }
    }
    return parts.join(' ');
  }, [player]);

  return (
    <div className="player-profile-overlay" onClick={onClose}>
      <div className="player-profile" onClick={(e) => e.stopPropagation()}>
        <div className="profile-header">
          <div>
            <h2>{player.name}</h2>
            <p className="company-tag">{player.company}</p>
          </div>
          <button onClick={onClose} className="close-btn">×</button>
        </div>

        <div className="profile-stats">
          <div className="stat-card">
            <div className="stat-label">Conservative Rating</div>
            <div className="stat-value">
              {player.score.conservative_rating != null
                ? player.score.conservative_rating.toFixed(0)
                : '-'}
            </div>
            <div className="stat-detail">
              {player.score.rating != null && player.score.rd != null
                ? `Rating ${player.score.rating.toFixed(0)} − 2×RD ${player.score.rd.toFixed(0)}`
                : ''}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Record</div>
            <div className="stat-value">{player.score.wins}-{player.score.losses}</div>
            <div className="stat-detail">
              {total > 0 ? `${winRate}% win rate` : 'No matches'}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Events</div>
            <div className="stat-value">{player.score.num_tournaments}</div>
            <div className="stat-detail">
              {player.score.main_match_count} main / {player.score.rookie_match_count} rookie sets
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Confidence</div>
            <div className="stat-value">
              {player.score.sample_confidence != null
                ? (player.score.sample_confidence * 100).toFixed(0) + '%'
                : '-'}
            </div>
            <div className="stat-detail">{confidenceExplainer}</div>
          </div>
        </div>

        {ratingHistory.length > 0 && (
          <div className="rating-chart">
            <h3>Rating History</h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={ratingHistory}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="match" label={{ value: 'Match #', position: 'insideBottom', offset: -5 }} />
                <YAxis label={{ value: 'Rating', angle: -90, position: 'insideLeft' }} />
                <Tooltip 
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      return (
                        <div className="custom-tooltip">
                          <p><strong>{data.tournament}</strong></p>
                          <p>{data.date} — {data.result} vs {data.opponent}</p>
                          <p>Rating: {data.rating.toFixed(0)}</p>
                          <p>Conservative: {data.conservative.toFixed(0)}</p>
                          <p>RD: {data.rd.toFixed(1)}</p>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Legend />
                <Line type="monotone" dataKey="rating" stroke="#3498db" name="Rating" dot={{ r: 3 }} />
                <Line type="monotone" dataKey="conservative" stroke="#e74c3c" name="Conservative Rating" strokeDasharray="5 5" dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="match-history">
          <h3>Match History ({playerMatches.length} sets)</h3>
          {playerMatches.length === 0 ? (
            <p className="no-matches">No match history available for this player.</p>
          ) : (
            <div className="match-history-scroll">
              <table className="match-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Tournament</th>
                    <th>Format</th>
                    <th>Opponent</th>
                    <th>Result</th>
                    <th>Rating Change</th>
                  </tr>
                </thead>
                <tbody>
                  {playerMatches.map((match, idx) => {
                    const ratingChange = match.post_rating - match.pre_rating;
                    const isDecay = match.is_decay_snapshot === 1;
                    const rdChange = match.post_rd - match.pre_rd;
                    return (
                      <tr key={idx} className={`${isDecay ? 'decay' : match.won ? 'win' : 'loss'}`}>
                        <td>{match.date}</td>
                        <td>{match.tournament}</td>
                        <td>{match.format}</td>
                        <td>
                          {isDecay ? (
                            <em>Inactivity decay</em>
                          ) : (
                            `${match.opponent_name} (${match.opponent_company})`
                          )}
                        </td>
                        <td className={isDecay ? 'result-decay' : match.won ? 'result-win' : 'result-loss'}>
                          {isDecay ? '—' : match.won ? 'W' : 'L'}
                        </td>
                        <td className={ratingChange >= 0 ? 'rating-up' : 'rating-down'}>
                          {ratingChange >= 0 ? '+' : ''}{ratingChange.toFixed(1)}
                          {isDecay && rdChange > 0 && <span className="rd-decay"> (RD +{rdChange.toFixed(1)})</span>}
                          {!isDecay && match.rating_change_weight && match.rating_change_weight < 0.99 && (
                            <span className="weight-indicator" title={`Match weight: ${(match.rating_change_weight * 100).toFixed(0)}%`}>
                              {' '}×{(match.rating_change_weight).toFixed(2)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
