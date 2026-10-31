import { useLayoutEffect, useRef, useState } from 'react';
import type { LiveMatch } from '../lib/eventDisplay';
import { eliminationLaneLayout, type EliminationLane } from '../lib/eliminationLayout';
import {
  liveBracketFeeds,
  liveBracketSide,
  liveBracketStatus,
  liveBracketWinner,
} from '../lib/eventBracket';
import { CharacterIcons } from './CharacterIcons';

/** HTML cards stay readable at full text size; only the draw scrolls on narrow screens. */
export function EventBracketLane({
  matches,
  lane,
  title,
  label,
  labels,
}: {
  matches: LiveMatch[];
  lane: EliminationLane;
  title: string;
  label: string;
  labels: Map<string, string>;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const [measurements, setMeasurements] = useState<
    Record<string, { height: number; rows: [number, number] }>
  >({});
  const height = Math.max(
    150,
    ...Object.values(measurements).map((item) => Math.ceil(item.height)),
  );
  // Names, team labels and translated feeder text can wrap to any length. Measure
  // real cards rather than truncating them or guessing a fixed line count.
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const cards = [...element.querySelectorAll<HTMLElement>('.event-bracket-match')];
      const next = Object.fromEntries(
        cards.map((card) => {
          const box = card.getBoundingClientRect();
          const rows = [...card.querySelectorAll<HTMLElement>(':scope > div')].map((row) => {
            const bounds = row.getBoundingClientRect();
            return bounds.y - box.y + bounds.height / 2;
          }) as [number, number];
          return [card.dataset.matchId!, { height: box.height, rows }];
        }),
      );
      setMeasurements((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    };
    const observer = new ResizeObserver(measure);
    element.querySelectorAll('.event-bracket-match').forEach((card) => observer.observe(card));
    measure();
    return () => observer.disconnect();
  }, [matches]);
  const geometry = {
    width: 250,
    height,
    column: 286,
    row: height + 24,
    top: 40,
    side1: height / 2,
    side2: height * 0.8,
  };
  const rounds = [...new Set(matches.map((match) => match.nativeRound ?? 1))].sort((a, b) => a - b);
  const layout = eliminationLaneLayout(
    matches,
    lane,
    {
      id: (match) => match.id,
      round: (match) =>
        lane === 'finals'
          ? match.bracketLane === 'reset'
            ? 2
            : 1
          : (match.bracketRound ?? rounds.indexOf(match.nativeRound ?? 1) + 1),
      slot: (match) => match.nativeSlot ?? 0,
      feeds: liveBracketFeeds,
      targetPort: (match, side) => measurements[match.id]?.rows[side] ?? height / 2,
      sourcePort: (match, outcome) => {
        const measured = measurements[match.id];
        const winner = liveBracketWinner(match, match.player1Id)
          ? 0
          : liveBracketWinner(match, match.player2Id)
            ? 1
            : null;
        // Pending feeds leave the card center: there is no known participant to
        // attach to. A confirmed result follows its actual winner/loser row.
        const side =
          winner === null
            ? null
            : outcome === 'winner'
              ? winner
              : match.player1Id && match.player2Id
                ? 1 - winner
                : null;
        return side === null
          ? (measured?.height ?? height) / 2
          : (measured?.rows[side] ?? height / 2);
      },
    },
    geometry,
  );
  return (
    <section className="event-bracket-lane" data-bracket-lane={lane}>
      {title && <h4>{title}</h4>}
      <div className="event-bracket-rounds" role="region" aria-label={label} tabIndex={0}>
        <div
          className="event-bracket-canvas"
          ref={canvas}
          style={{ width: layout.width, height: layout.height }}
        >
          <svg
            className="event-bracket-lines"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            {layout.edges.map((edge) => (
              <path
                key={`${edge.from}-${edge.to}-${edge.side}`}
                d={edge.path}
                data-feed-from={edge.from}
                data-feed-to={edge.to}
                data-feed-side={edge.side}
                data-feed-outcome={edge.outcome}
                className={`event-bracket-feed event-bracket-feed-${edge.outcome}`}
              />
            ))}
          </svg>
          {layout.rounds.map((round, index) => (
            <section className="event-bracket-round" key={index} style={{ left: round.x }}>
              <h4>
                {title
                  ? round.label
                  : index === layout.rounds.length - 1
                    ? 'Final'
                    : index === layout.rounds.length - 2
                      ? 'Semi-finals'
                      : round.label}
              </h4>
            </section>
          ))}
          {layout.nodes.map(({ match, x, y }) => (
            <article
              className={`event-bracket-match${match.status === 'playing' ? ' is-playing' : ''}`}
              key={match.id}
              data-match-id={match.id}
              aria-label={`${match.label}: ${liveBracketStatus(match)}`}
              style={{ left: x, top: y, width: geometry.width }}
            >
              <small>
                {match.label} · {liveBracketStatus(match)}
              </small>
              {([0, 1] as const).map((side) => {
                const id = side === 0 ? match.player1Id : match.player2Id;
                const score = side === 0 ? match.score1 : match.score2;
                const characters = side === 0 ? match.player1Characters : match.player2Characters;
                return (
                  <div
                    className={liveBracketWinner(match, id) ? 'is-winner' : ''}
                    key={side}
                    data-entrant-id={id ?? undefined}
                  >
                    <span>
                      {liveBracketSide(match, side, labels)}
                      <CharacterIcons slugs={id ? (characters ?? []) : []} />
                    </span>
                    <b aria-label={score === null ? 'No score' : `Score ${score}`}>
                      {score ?? '–'}
                    </b>
                  </div>
                );
              })}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
