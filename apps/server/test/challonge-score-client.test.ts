import { describe, expect, it } from 'vitest';
import { ChallongeScoreClient, type DeliverScoreInput } from '../src/challonge/scoreClient';
const input: DeliverScoreInput = { tournamentSlug: 'test-night', matchId: '7', participants: [
  { participantId: '1', score: 3 }, { participantId: '2', score: 1 },
] };
function match(state = 'open', ids = ['2', '1'], scores = [1, 3]) {
  return { data: { id: '7', type: 'match', attributes: { state, winner_id: state === 'complete' ? ids[1] : null,
    relationships: { player1: { data: { id: ids[0] } }, player2: { data: { id: ids[1] } } },
    points_by_participant: ids.map((participant_id, index) => ({ participant_id, scores: [scores[index]] })),
  } } };
}
function fixture(responses: Array<unknown | Error | Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ChallongeScoreClient({ apiKey: 'secret-test-key', fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return Response.json(next);
  } });
  return { calls, client };
}
describe('Challonge score delivery', () => {
  it('verifies identities, writes by ID despite reversed ordering, and confirms by GET', async () => {
    const { client, calls } = fixture([match(), {}, match('complete')]);
    expect((await client.deliverScore(input)).status).toBe('verified');
    expect(calls.map(call => call.init?.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(calls[1]!.url).toBe('https://api.challonge.com/v2.1/tournaments/test-night/matches/7.json');
    expect(calls[1]!.init!.headers).toMatchObject({ Authorization: 'secret-test-key', 'Authorization-Type': 'v1' });
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ data: { type: 'Match', attributes: { match: [
      { participant_id: '1', score_set: '3', advancing: true }, { participant_id: '2', score_set: '1' },
    ] } } });
  });
  it('acknowledges an already recorded score without writing', async () => {
    const { client, calls } = fixture([match('complete')]);
    expect((await client.deliverScore(input)).status).toBe('already_recorded');
    expect(calls).toHaveLength(1);
  });
  it('uses explicitly verified group aliases', async () => {
    const { client, calls } = fixture([match('open', ['102', '101']), {}, match('complete', ['102', '101'])]);
    await client.deliverScore({ ...input, participants: [
      { participantId: '1', aliases: ['101'], score: 3 }, { participantId: '2', aliases: ['102'], score: 1 },
    ] });
    expect(String(calls[1]!.init!.body)).toContain('"participant_id":"101"');
  });
  it('does not guess group identities from participant order', async () => {
    const { client, calls } = fixture([match('open', ['102', '101'])]);
    await expect(client.deliverScore(input)).rejects.toMatchObject({ code: 'identity_mismatch', mayHaveWritten: false });
    expect(calls).toHaveLength(1);
  });
  it('rejects ambiguous overlapping identity mappings before requests', async () => {
    const { client, calls } = fixture([]);
    await expect(client.deliverScore({ ...input, participants: [{ participantId: '1', aliases: ['2'], score: 3 }, input.participants[1]] })).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(calls).toHaveLength(0);
  });
  it('does not overwrite a different completed remote result', async () => {
    const { client, calls } = fixture([match('complete', ['2', '1'], [2, 3])]);
    await expect(client.deliverScore(input)).rejects.toMatchObject({ code: 'remote_conflict' });
    expect(calls).toHaveLength(1);
  });
  it.each([401, 404, 422, 429, 500])('never retries a failed PUT (HTTP %i)', async status => {
    const { client, calls } = fixture([match(), new Response('secret-test-key', { status })]);
    await expect(client.deliverScore(input)).rejects.toMatchObject({ status, mayHaveWritten: status >= 500 });
    expect(calls.map(call => call.init?.method)).toEqual(['GET', 'PUT']);
  });
  it('sanitizes transport errors and exposes ambiguous writes', async () => {
    const { client, calls } = fixture([match(), new Error('secret-test-key timed out')]);
    try { await client.deliverScore(input); expect.unreachable(); } catch (error) {
      expect(error).toMatchObject({ code: 'ambiguous', mayHaveWritten: true });
      expect(String(error)).not.toContain('secret-test-key');
    }
    expect(calls).toHaveLength(2);
  });
  it('marks failed verification ambiguous without a second write', async () => {
    const { client, calls } = fixture([match(), {}, match('complete', ['2', '1'], [2, 3])]);
    await expect(client.deliverScore(input)).rejects.toMatchObject({ code: 'ambiguous', mayHaveWritten: true });
    expect(calls.filter(call => call.init?.method === 'PUT')).toHaveLength(1);
  });
  it('rejects a response containing a different match ID', async () => {
    const data = match(); data.data.id = '8';
    const { client, calls } = fixture([data]);
    await expect(client.deliverScore(input)).rejects.toMatchObject({ code: 'invalid_response', mayHaveWritten: false });
    expect(calls).toHaveLength(1);
  });
  it('does not send a write when the read times out', async () => {
    const { client, calls } = fixture([new Error('secret-test-key timeout')]);
    await expect(client.deliverScore(input)).rejects.toMatchObject({ code: 'unavailable', mayHaveWritten: false });
    expect(calls).toHaveLength(1);
  });
  it('passes an abort signal and disallows redirects on credentialed requests', async () => {
    const { client, calls } = fixture([match('complete')]);
    await client.deliverScore(input);
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init!.redirect).toBe('error');
  });
  it('rejects a tie before any remote request', async () => {
    const { client, calls } = fixture([]);
    await expect(client.deliverScore({ ...input, participants: [{ participantId: '1', score: 1 }, { participantId: '2', score: 1 }] })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});
