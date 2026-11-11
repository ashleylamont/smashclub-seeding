import type { RecapFact } from './recap';

const ordinal = (n: number): string => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
};

/** "in the winners final" / "" — stages read as a trailing clause or vanish. */
const inStage = (stage: string | null): string => (stage ? ` in ${stage}` : '');

/**
 * Fact copy, kept beside the facts themselves so the page, the share image and
 * any future chat post all say the same thing about the same night.
 *
 * The voice to hold: say what happened the way someone who was there would
 * retell it, with the numbers as evidence rather than as the sentence. "The
 * ratings gave them one chance in eight" lands; "probability 0.12" does not.
 */
export function formatFact(fact: RecapFact): { headline: string; detail: string } {
  switch (fact.kind) {
    case 'podium': {
      const [first, second, third] = fact.places;
      const runnersUp = [second, third].filter(Boolean).map((p) => p!.player.name);
      return {
        headline: first ? `${first.player.name} takes it` : 'Podium',
        detail:
          (first?.seed != null ? `Seeded ${ordinal(first.seed)}. ` : '') +
          (runnersUp.length > 0 ? `Ahead of ${runnersUp.join(' and ')}.` : ''),
      };
    }
    case 'seed_upset': {
      // A four-fold seed gap reads as a shock; anything less is a scalp.
      const shock = fact.winnerSeed >= fact.loserSeed * 4;
      return {
        headline: shock
          ? `${fact.winner.name} shocks ${fact.loser.name}`
          : `${fact.winner.name} takes down ${fact.loser.name}`,
        detail: `In as the ${ordinal(fact.winnerSeed)} seed against the ${ordinal(fact.loserSeed)}${inStage(fact.stage)}${fact.score ? ` — won ${fact.score}` : ''}.`,
      };
    }
    case 'rating_upset': {
      const oneIn = Math.max(2, Math.round(1 / Math.max(fact.probability, 0.01)));
      return {
        headline: `${fact.winner.name} beats the odds`,
        detail: `The ratings gave them one chance in ${oneIn} against ${fact.loser.name} — ${Math.round(fact.ratingGap)} points apart${inStage(fact.stage)}${fact.score ? `. Won ${fact.score}` : ''}.`,
      };
    }
    case 'losers_run':
      return {
        headline: `${fact.player.name}'s long road back`,
        detail: `Sent to the losers bracket, then won ${fact.wins} straight elimination sets${fact.finalRank != null ? ` to finish ${ordinal(fact.finalRank)}` : ''}.`,
      };
    case 'pool_tie':
      return poolTieCopy(fact);
    case 'pool_sweep':
      return {
        headline: `${fact.player.name} swept their pool`,
        detail: `Won all ${fact.wins} played sets.`,
      };
    case 'pool_deciders':
      return {
        headline: `${fact.closeSets} of ${fact.totalSets} pool sets had a one-game margin`,
        detail: '',
      };
    case 'runback':
      return {
        headline: `${fact.winner.name} gets the runback`,
        detail: `After losing to ${fact.loser.name} earlier tonight, they won the rematch${fact.score ? ` ${fact.score}` : ''}.`,
      };
    case 'overperformer':
      return {
        headline: `${fact.player.name} outruns the seeding`,
        detail: `In as the ${ordinal(fact.seed)} seed, out in ${ordinal(fact.finalRank)} — ${fact.placesGained} places clear of expectations.`,
      };
    case 'nailbiter':
      return {
        headline: `${fact.winner.name} holds off ${fact.loser.name}`,
        detail: `${fact.score}${inStage(fact.stage)}, down to the last game.`,
      };
    case 'clean_sweep':
      return {
        headline: `${fact.player.name} drops nothing`,
        detail: `${fact.sets} sets, not a single game lost, bracket closed.`,
      };
    case 'biggest_climb':
      return {
        headline: `${fact.player.name} owns the night`,
        detail: `Up ${Math.round(fact.gained)} rating in one evening, ${Math.round(fact.from)} → ${Math.round(fact.to)} — the biggest move on the board.`,
      };
    case 'mover':
      return {
        headline: `${fact.player.name} climbs to #${fact.rank}`,
        detail: `Up ${fact.placesGained} ${fact.placesGained === 1 ? 'place' : 'places'} from #${fact.previousRank} on tonight's games.`,
      };
    case 'rivalry': {
      const level = fact.aWins === fact.bWins;
      return {
        headline: `${fact.a.name} vs ${fact.b.name}, chapter ${fact.meetings}`,
        detail: level
          ? `${fact.a.name} took tonight's meeting, and the series is level at ${fact.aWins}–${fact.bWins}.`
          : `${fact.a.name} took tonight's meeting; ${fact.aWins > fact.bWins ? fact.a.name : fact.b.name} leads the series ${fact.aWins}–${fact.bWins}.`,
      };
    }
    case 'breakthrough':
      return {
        headline: `${fact.winner.name} finally gets one`,
        detail: `${fact.priorLosses} career losses to ${fact.loser.name} and never a win — until tonight${inStage(fact.stage)}${fact.score ? `, ${fact.score}` : ''}.`,
      };
    case 'debut':
      return {
        headline:
          fact.players.length === 1
            ? `First night for ${fact.players[0]!.name}`
            : `${fact.players.length} first-timers in the bracket`,
        detail:
          fact.players.length === 1
            ? 'Welcome to the club.'
            : `First club night for ${fact.players.map((p) => p.name).join(', ')}.`,
      };
    case 'milestone':
      if (fact.milestone === 'peak_rating') {
        return {
          headline: `${fact.player.name} has never been rated higher`,
          detail: `A new career-high rating of ${Math.round(fact.value)}.`,
        };
      }
      if (fact.milestone === 'events') {
        return {
          headline: `${fact.player.name}'s ${ordinal(fact.value)} club night`,
          detail: `${fact.value} evenings of showing up.`,
        };
      }
      return {
        headline: `${fact.player.name}'s ${ordinal(fact.value)} career set`,
        detail: `Crossed ${fact.value} sets played tonight.`,
      };
    case 'turnout': {
      const tied = fact.previousBest != null && fact.entrants === fact.previousBest;
      return {
        headline: fact.isRecord
          ? 'The biggest night the club has run'
          : `${fact.entrants} in the building`,
        detail:
          fact.previousBest == null
            ? ''
            : fact.isRecord
              ? `${fact.entrants} entrants — past the old record of ${fact.previousBest}.`
              : tied
                ? `Ties the club's best night.`
                : `Best turnout is still ${fact.previousBest}.`,
      };
    }
    case 'grand_finals': {
      const run =
        fact.gamesDropped != null && fact.gamesDropped > 0
          ? ` Played ${fact.runSets} sets on the way, with ${fact.gamesDropped} ${fact.gamesDropped === 1 ? 'game' : 'games'} dropped along the way.`
          : '';
      return {
        headline: `${fact.winner.name} wins the bracket`,
        detail: `${fact.bracketReset ? 'It took a bracket reset. ' : ''}Beat ${fact.loser.name}${fact.score ? ` ${fact.score}` : ''} in the decider.${run}`,
      };
    }
  }
}

function poolTieCopy(fact: Extract<RecapFact, { kind: 'pool_tie' }>) {
  return {
    headline: `${fact.teams.length} pairs tied on ${fact.setWins} pool ${fact.setWins === 1 ? 'win' : 'wins'}`,
    detail: [
      `${fact.poolName ?? 'Pool'} finishing order: ${fact.teams.map((team) => team.name).join(' → ')}.`,
      fact.circular ? 'Each pair went 1–1 against the other two.' : '',
      fact.splitFinals ? 'The tie spanned championship and consolation qualifiers.' : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}
