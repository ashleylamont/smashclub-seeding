/** tRPC batches share one URL and keep input/response slots in procedure order. */
export function rpcProcedures(url: string): string[] {
  return decodeURIComponent(new URL(url).pathname.split('/api/trpc/')[1] ?? '').split(',');
}

export function rpcValue<T>(url: string, payload: unknown, procedure: string): T {
  const index = rpcProcedures(url).indexOf(procedure);
  if (index < 0) throw new Error(`RPC request does not contain ${procedure}`);
  return (
    new URL(url).searchParams.has('batch') ? (payload as Record<number, unknown>)[index] : payload
  ) as T;
}

/** A mixed success/conflict batch has HTTP 207; inspect the selected RPC's status. */
export async function rpcResponse(
  response: { url(): string; json(): Promise<unknown> },
  procedure: string,
) {
  const reply = rpcValue<{ error?: { message: string; data: { httpStatus: number } } }>(
    response.url(),
    await response.json(),
    procedure,
  );
  return {
    status: () => reply.error?.data.httpStatus ?? 200,
    json: async () => reply,
  };
}

/** Keep real read envelopes stale while preserving every mutation's real reply. */
export function rpcReadDelivery(procedures: string[]) {
  const cached = new Map<string, unknown>();
  let delayed = false;
  return {
    get size() {
      return cached.size;
    },
    delay() {
      if (cached.size !== procedures.length) throw new Error('Observe every real read first');
      delayed = true;
    },
    resume() {
      delayed = false;
    },
    deliver(url: string, payload: unknown) {
      const batched = new URL(url).searchParams.has('batch');
      const replies = batched ? [...(payload as unknown[])] : [payload];
      rpcProcedures(url).forEach((procedure, index) => {
        if (!procedures.includes(procedure)) return;
        if (delayed) {
          if (!cached.has(procedure)) throw new Error(`No observed reply for ${procedure}`);
          replies[index] = cached.get(procedure);
        } else cached.set(procedure, replies[index]);
      });
      return batched ? replies : replies[0];
    },
  };
}
