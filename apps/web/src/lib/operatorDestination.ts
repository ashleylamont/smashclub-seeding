import { opsSectionFromSearch, type OpsSection } from './opsWorkspace';
import { profileClaimSearch } from './profileClaim';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function eventId(value: unknown) {
  return typeof value === 'string' && value.length === 36 && uuid.test(value)
    ? value.toLowerCase()
    : undefined;
}

export type OperatorDestination = { operate: string; view?: OpsSection; station?: string };

export function operatorDestination(
  search: Record<string, unknown>,
): OperatorDestination | undefined {
  const operate = eventId(search.operate);
  if (!operate) return;
  const view = opsSectionFromSearch(search.view);
  const station = view === 'broadcast' ? eventId(search.station) : undefined;
  return { operate, view, station };
}

export function loginSearch(
  search: Record<string, unknown>,
): Partial<OperatorDestination> & { claim?: string } {
  const { claim } = profileClaimSearch(search);
  const operator = claim ? undefined : operatorDestination(search);
  return { claim, operate: operator?.operate, view: operator?.view, station: operator?.station };
}

export function operatorPath({ operate, view, station }: OperatorDestination) {
  const search = new URLSearchParams();
  if (view) search.set('view', view);
  if (station) search.set('station', station);
  return `/operate/${operate}${search.size ? `?${search}` : ''}`;
}
