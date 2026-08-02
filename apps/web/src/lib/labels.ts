/**
 * Human labels for the enums the app used to print raw.
 *
 * A tournament row said `sync: registered` and a chip said `underway`. Both are
 * database vocabulary: `registered` means "we know about this bracket but have
 * not pulled its results in yet", which no reader was going to guess, and
 * `underway` is Challonge's word for a bracket that has started — including
 * ones that started in 2024 and were never closed. Each label therefore comes
 * with the sentence it is short for.
 *
 * Unknown values fall through to the raw string rather than to "Unknown": a
 * state this file has not been taught is still more useful printed than hidden.
 */

export interface StateLabel {
  label: string;
  hint: string;
}

/** Our own sync pipeline's state (`sync_state` in the schema). */
export function syncStateLabel(state: string | null | undefined): StateLabel {
  switch (state) {
    case 'registered':
      return { label: 'Not synced yet', hint: 'Registered here, but no results have been pulled from Challonge yet.' };
    case 'syncing':
      return { label: 'Syncing', hint: 'Pulling this bracket’s participants and sets from Challonge right now.' };
    case 'live':
      return { label: 'Live', hint: 'Polled every few seconds; new results appear on this page as they land.' };
    case 'synced':
      return { label: 'Up to date', hint: 'Results have been pulled in and counted towards ratings.' };
    case 'error':
      return { label: 'Sync failed', hint: 'The last attempt to read this bracket from Challonge did not succeed.' };
    default:
      return { label: state ?? 'Unknown', hint: 'Sync state reported by the server.' };
  }
}

/**
 * Challonge's own tournament state, as reported by their API.
 *
 * `abandoned` (see `isBracketAbandoned`) overrides the unfinished states. A
 * bracket the room ran out of time on and nobody closed reports `underway`
 * forever; calling a night from 2024 "in progress" is not a state, it is a
 * page that has not noticed what year it is.
 */
export function challongeStateLabel(
  state: string | null | undefined,
  options: { abandoned?: boolean } = {},
): StateLabel {
  if (options.abandoned) {
    return {
      label: 'Ended unfinished',
      hint: 'The night is long past and this bracket was never played out or finalised on Challonge, so it is treated as over. Results from the sets that were played still count.',
    };
  }
  switch (state) {
    case 'pending':
    case null:
    case undefined:
      return { label: 'Not started', hint: 'The bracket exists on Challonge but has not been started.' };
    case 'underway':
      return { label: 'In progress', hint: 'Challonge has this bracket started and unfinished.' };
    case 'awaiting_review':
      return { label: 'Awaiting review', hint: 'All sets are in; the organiser has not finalised the bracket yet.' };
    case 'complete':
      return { label: 'Finished', hint: 'The bracket is finalised on Challonge, with final places recorded.' };
    case 'group_stages_underway':
      return { label: 'Pools in progress', hint: 'Group stages are running; the main bracket has not started.' };
    case 'group_stages_finalized':
      return { label: 'Pools finished', hint: 'Group stages are done and the main bracket is ready to start.' };
    default:
      return { label: state, hint: 'Bracket state reported by Challonge.' };
  }
}

/** A single set's state within a bracket. */
export function setStateLabel(state: string | null | undefined): StateLabel {
  switch (state) {
    case 'complete':
      return { label: 'Played', hint: 'Reported, and counted towards ratings unless marked excluded.' };
    case 'open':
      return { label: 'Ready', hint: 'Both players are known; the set has not been reported yet.' };
    case 'pending':
      return { label: 'Waiting', hint: 'Still waiting on an earlier set to decide who plays.' };
    default:
      return { label: state ?? '—', hint: 'Set state reported by Challonge.' };
  }
}
