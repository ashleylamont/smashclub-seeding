import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  DoubleEliminationBracket,
  SingleEliminationBracket,
  Match,
  SVGViewer,
  createTheme,
} from '@cm3tahkuh/react-tournament-brackets';
import { fixtures, TEAM_ALIAS } from 'nemesis-probe-fixtures';
import type { Shape } from 'nemesis-probe-fixtures';
import { liveBracketSide } from 'nemesis-bracket-side';

const root = createRoot(document.getElementById('brackets')!);
function model(graph: ReturnType<typeof fixtures>[number]['graph'], explicitLabels: boolean) {
  const labels = new Map(graph.map((m) => [m.id, m.label]));
  return graph.map((m) => {
    const winnerNext = graph.find((target) =>
      ([1, 2] as const).some(
        (i) => target[`parent${i}MatchId`] === m.id && target[`parent${i}Outcome`] !== 'loser',
      ),
    );
    const loserNext = graph.find((target) =>
      ([1, 2] as const).some(
        (i) => target[`parent${i}MatchId`] === m.id && target[`parent${i}Outcome`] === 'loser',
      ),
    );
    return {
      id: m.id,
      name: m.bracketLane === 'reset' ? 'Reset final · If needed' : m.label,
      nextMatchId: winnerNext?.id ?? null,
      nextLooserMatchId: loserNext?.id,
      tournamentRoundText: String(m.bracketRound ?? m.nativeRound),
      startTime: '',
      state: m.outcome === 'bye' ? 'WALK_OVER' : m.status === 'complete' ? 'DONE' : 'SCHEDULED',
      participants: ([1, 2] as const).flatMap((i) => {
        const id = m[`player${i}Id`];
        if (!id && !explicitLabels) return [];
        const score = m[`score${i}`];
        return [
          {
            id: id ?? `${m.id}:source:${i}`,
            name: liveBracketSide(m, i === 1 ? 0 : 1, labels),
            resultText: score === null ? null : String(score),
            isWinner: Boolean(id && id === m.winnerId),
            status: id ? 'PLAYED' : null,
          },
        ];
      }),
    };
  });
}

function InstrumentedMatch(props: React.ComponentProps<typeof Match>) {
  return (
    <div
      style={{ width: '100%', height: '100%' }}
      data-match-id={props.match.id}
      data-label={props.match.name}
    >
      <Match {...props} />
    </div>
  );
}

Object.assign(window, {
  TEAM_ALIAS,
  probeRender(
    shape: Shape,
    explicitLabels = false,
    omitReset = false,
    panZoom = false,
    themeMode?: 'dark' | 'light',
  ) {
    const stages = fixtures(shape).map(({ graph, ...stage }) => ({
      ...stage,
      graph: graph.filter((match) => !omitReset || match.bracketLane !== 'reset'),
    }));
    root.render(
      stages.map(({ name, graph }, index) => {
        const all = model(graph, explicitLabels);
        const lower = all.filter((_, i) => graph[i]?.bracketLane === 'losers');
        const upper = all.filter((_, i) => graph[i]?.bracketLane !== 'losers');
        const theme =
          themeMode &&
          createTheme({
            textColor: {
              main: '#ffffff',
              highlighted: '#ffffff',
              dark: '#ffffff',
              disabled: '#ffffff',
            },
            score: {
              text: { highlightedWonColor: '#ffffff', highlightedLostColor: '#ffffff' },
              background: { wonColor: '#1f3551', lostColor: '#132034' },
            },
            matchBackground: { wonColor: '#1f3551', lostColor: '#132034' },
            disabledColor: '#192b43',
            canvasBackground: themeMode === 'dark' ? '#101417' : '#ffffff',
          });
        const options = themeMode ? { style: { boxHeight: 175 } } : undefined;
        const common = {
          matchComponent: InstrumentedMatch,
          ...(theme ? { theme, options } : {}),
          ...(panZoom
            ? {
                svgWrapper: ({ children, ...props }) => (
                  <SVGViewer width={window.innerWidth} height={600} {...props}>
                    {children}
                  </SVGViewer>
                ),
              }
            : {}),
        };
        return (
          <section
            key={`${shape}:${explicitLabels}:${omitReset}:${panZoom}:${index}`}
            aria-label={name}
            data-stage={index}
          >
            <h2>{name}</h2>
            {shape === 'de' ? (
              <DoubleEliminationBracket {...common} matches={{ upper, lower }} />
            ) : (
              <SingleEliminationBracket {...common} matches={all} />
            )}
          </section>
        );
      }),
    );
    return stages;
  },
});
