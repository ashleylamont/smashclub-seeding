const playerId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const mainCharactersAnchor = 'main-characters';

export function playerIdFromSearch(value: unknown) {
  return typeof value === 'string' && value.length === 36 && playerId.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function profileClaimSearch(search: Record<string, unknown>): { claim?: string } {
  return { claim: playerIdFromSearch(search.claim) };
}

export function profileAccountPath(claim?: string) {
  return claim ? `/me?${new URLSearchParams({ claim })}` : '/me';
}
