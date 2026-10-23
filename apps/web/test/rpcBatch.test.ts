import { describe, expect, it } from 'vitest';
import { rpcProcedures, rpcReadDelivery, rpcResponse, rpcValue } from '../test-support/rpcBatch';

const read = 'eventOps.guests.matches';
const mutation = 'eventOps.guests.submit';
const url = (procedures: string[], batch = true) =>
  `http://localhost/api/trpc/${procedures.join(',')}${batch ? '?batch=1' : ''}`;
const stale = { result: { data: { revision: 0 } } };
const fresh = { result: { data: { revision: 1 } } };
const receipt = { result: { data: { reportId: 'committed-once', status: 'approved' } } };

describe('recovery transport interception', () => {
  it.each([
    [read, mutation],
    [mutation, read],
  ])(
    'reads the mutation conflict within a mixed %s,%s HTTP 207 response',
    async (...procedures) => {
      const conflict = { error: { message: 'Match changed', data: { httpStatus: 409 } } };
      const response = {
        url: () => url(procedures),
        json: async () => procedures.map((name) => (name === mutation ? conflict : fresh)),
      };
      const result = await rpcResponse(response, mutation);
      expect(result.status()).toBe(409);
      expect(await result.json()).toEqual(conflict);
      expect((await rpcResponse(response, read)).status()).toBe(200);
    },
  );

  it.each([
    [read, mutation],
    [mutation, read],
  ])('keeps a poll stale without hiding or changing a %s,%s mutation', (...procedures) => {
    const delivery = rpcReadDelivery([read]);
    delivery.deliver(url([read]), [stale]);
    delivery.delay();
    const inputs = Object.fromEntries(
      procedures.map((name, index) => [index, name === mutation ? { requestId: 'retry' } : {}]),
    );
    const replies = procedures.map((name) => (name === mutation ? receipt : fresh));
    const requestUrl = url(procedures);
    expect(rpcProcedures(requestUrl)).toEqual(procedures);
    expect(rpcValue(requestUrl, inputs, mutation)).toEqual({ requestId: 'retry' });
    const delivered = delivery.deliver(requestUrl, replies);
    expect(rpcValue(requestUrl, delivered, read)).toEqual(stale);
    expect(rpcValue(requestUrl, delivered, mutation)).toEqual(receipt);
    expect(rpcValue(requestUrl, replies, read)).toEqual(fresh);
    delivery.resume();
    expect(delivery.deliver(requestUrl, replies)).toEqual(replies);
  });

  it('handles unbatched calls and refuses to invent a snapshot or select an absent procedure', () => {
    const delivery = rpcReadDelivery([read]);
    expect(() => delivery.delay()).toThrow('Observe every real read first');
    const requestUrl = url([read], false);
    expect(delivery.deliver(requestUrl, stale)).toBe(stale);
    delivery.delay();
    expect(delivery.deliver(requestUrl, fresh)).toBe(stale);
    expect(rpcValue(requestUrl, { planId: 'night' }, read)).toEqual({ planId: 'night' });
    expect(() => rpcValue(requestUrl, stale, mutation)).toThrow(mutation);
  });
});
