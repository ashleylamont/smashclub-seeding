import { authClient, useMyClaims } from './auth';

export function useCharacterReporter() {
  const { data: session } = authClient.useSession();
  const claims = useMyClaims(session?.user.id);
  return {
    identity: session?.user.id,
    playerIds: new Set(
      session
        ? claims.data?.filter((claim) => claim.status === 'approved').map((claim) => claim.playerId)
        : [],
    ),
  };
}
