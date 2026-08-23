import { divisionLabel, type PlanView } from './plans';
import type { Division } from './divisions';

/**
 * The copy-and-paste handoff to Challonge.
 *
 * This is the path that ships first and the path that must always work: every
 * bracket of the first live event can be created by hand from what this
 * produces, with no API credentials, no quota and no network. Automation (a
 * v2.1 write adapter creating the same brackets) is additive — it must never
 * become the only way to finish the night, so these payloads stay available
 * even after a remote bracket exists.
 *
 * Names exported are the player's public alias, never the pasted attendance
 * line. The alias is what every other surface calls them and what identity sync
 * will see coming back from Challonge; exporting "1 [Atlas]@foxy - maybe late"
 * would make the return trip a review-queue item for a person the club has
 * already identified.
 */

export interface BracketExport {
  division: Division;
  stage: 'main' | 'consolation';
  title: string;
  /** Newline-separated names, in seed order: Challonge's bulk-add box. */
  participants: string;
  /** `seed<TAB>name`, for checking the bracket against the plan afterwards. */
  audit: string;
  /** Setup steps that are not expressible as a participant list. */
  checklist: string[];
  /** Null unless the plan already knows the slug. */
  challongeSlug: string | null;
  suggestedSlug: string;
}

export interface PlanExports {
  eventDate: string;
  rankingSnapshotAt: string | null;
  brackets: BracketExport[];
  /** Pool cards, ready to print for a venue with no connectivity. */
  poolCards: Array<{
    division: Division;
    label: string;
    lines: string[];
  }>;
}

export function buildExports(view: PlanView): PlanExports {
  const brackets: BracketExport[] = [];
  const poolCards: PlanExports['poolCards'] = [];

  for (const division of view.divisions) {
    if (division.size === 0) continue;
    const slot = (stage: 'main' | 'consolation') =>
      view.brackets.find((bracket) => bracket.division === division.division && bracket.stage === stage);

    const seeded = division.pools
      .flatMap((pool) => pool.members)
      .sort((a, b) => a.seed - b.seed);
    const mainSlot = slot('main');
    brackets.push({
      division: division.division,
      stage: 'main',
      title: `${divisionLabel(division.division)} Main`,
      participants: seeded.map((member) => member.name).join('\n'),
      audit: seeded.map((member) => `${member.seed}\t${member.name}`).join('\n'),
      checklist: [
        'Tournament type: Two stage — group stage then single elimination.',
        `Groups: ${division.poolCount} group(s) of ${view.plan.poolSize}, round robin.`,
        'Advance: top 2 from each group into the final stage.',
        'Participants: paste the list above, in this order, then set seeds 1..n to match.',
        `Check each group against the pool cards before starting — Challonge's own ` +
          'seed-to-group allocation is not assumed to match this preview.',
        `Event date: ${view.plan.eventDate.slice(0, 10)} (all four brackets share it).`,
        'Do NOT mark this bracket as rookie — Upper and Lower are competitive divisions.',
      ],
      challongeSlug: mainSlot?.challongeSlug ?? null,
      suggestedSlug: mainSlot?.suggestedSlug ?? '',
    });

    const consolationSlot = slot('consolation');
    const consolation = division.consolation;
    brackets.push({
      division: division.division,
      stage: 'consolation',
      title: `${divisionLabel(division.division)} Consolation`,
      participants: consolation
        ? consolation.entrants
            .map((entrant) => nameFor(division, entrant.playerId))
            .join('\n')
        : '',
      audit: consolation
        ? consolation.entrants
            .map((entrant) => `${entrant.bracketSeed}\t${entrant.label}\t${nameFor(division, entrant.playerId)}`)
            .join('\n')
        : '',
      checklist: [
        // The date and the rookie warning belong on the list whether or not the
        // field is known yet: this is the bracket someone builds in a hurry
        // between pools finishing and the championship starting.
        ...(consolation
          ? [
              'Tournament type: Single elimination.',
              'Participants: paste the list above, in this order, then set seeds 1..n to match.',
              `Round one should be: ${consolation.roundOne
                .map((pair) => (pair.b ? `${pair.a.label} v ${pair.b.label}` : `${pair.a.label} (bye)`))
                .join(', ')}.`,
            ]
          : ['Confirm every pool’s 1-4 order first — the field is the third and fourth places.']),
        `Event date: ${view.plan.eventDate.slice(0, 10)} — the same as the main brackets.`,
        'Do NOT mark this bracket as rookie.',
      ],
      challongeSlug: consolationSlot?.challongeSlug ?? null,
      suggestedSlug: consolationSlot?.suggestedSlug ?? '',
    });

    for (const pool of division.pools) {
      poolCards.push({
        division: division.division,
        label: `${divisionLabel(division.division)} — Pool ${pool.label}`,
        lines: pool.members.map((member) => `#${member.seed}  ${member.name}`),
      });
    }
  }

  return {
    eventDate: view.plan.eventDate,
    rankingSnapshotAt: view.plan.rankingSnapshotAt,
    brackets,
    poolCards,
  };

  function nameFor(division: PlanView['divisions'][number], playerId: string): string {
    for (const pool of division.pools) {
      const member = pool.members.find((entry) => entry.playerId === playerId);
      if (member) return member.name;
    }
    return '?';
  }
}
