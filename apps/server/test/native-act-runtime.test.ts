import { act, ConcurrencyError, InMemoryCache, InMemoryStore } from '@rotorsoft/act';
import { describe, expect, it } from 'vitest';
import { NativeTournament } from '../src/tournament/aggregate';
import { pureBaseline, envelope } from './helpers/nativeLiveFixture';

describe('pinned Act compatibility contract', () => {
  it('allows no-event idempotent actions with reactions and emits only real commits', async () => {
    const store = new InMemoryStore();
    const app = act()
      .withState(NativeTournament)
      .on('ResultsSealedV1')
      .do(async function ignoreSealedResult() {})
      .to('compatibility-test')
      .build({ scoped: { store, cache: new InMemoryCache() }, validateFoldedState: true });
    let commits = 0;
    app.on('committed', () => {
      commits++;
    });
    try {
      const baseline = pureBaseline();
      const target = { stream: 'compatibility', actor: { id: 'test', name: 'Test' } };
      await app.do('CaptureNativeBaseline', target, baseline);
      await app.do('CaptureNativeBaseline', target, baseline);
      expect(commits).toBe(1);
      expect((await app.query({ stream: target.stream })).count).toBe(1);
      const loaded = (await app.load(NativeTournament, target.stream)).state.current[0];
      expect(loaded.result).toBeNull();
      expect(loaded.publication).toBeNull();
      expect(loaded.baseline!.rankingRecomputeId).toBeNull();
    } finally {
      await app.shutdown();
      await store.dispose();
    }
  });
  it('honors an explicit expectedVersion inside a reaction-triggered domain write', async () => {
    const store = new InMemoryStore();
    let rejected = false;
    const app = act()
      .withState(NativeTournament)
      .on('BaselineCapturedV1')
      .do(async function checkReactionConcurrency(event, _stream, dispatcher) {
        const head = await dispatcher.load(NativeTournament, event.stream);
        try {
          await dispatcher.do(
            'ExecuteNativeCommand',
            {
              stream: event.stream,
              actor: { id: 'reaction', name: 'Reaction' },
              expectedVersion: head.version - 1,
            },
            envelope({ kind: 'unlock' }),
          );
        } catch (error) {
          if (!(error instanceof ConcurrencyError)) throw error;
          rejected = true;
        }
      })
      .to((event) => ({ source: event.stream, target: 'reaction-concurrency-check' }))
      .build({ scoped: { store, cache: new InMemoryCache() }, listen: false });
    try {
      await app.do(
        'CaptureNativeBaseline',
        { stream: 'reaction-test', actor: { id: 'test', name: 'Test' } },
        pureBaseline(),
      );
      await app.correlate({ after: -1, limit: 100 });
      await app.drain();
      expect(rejected).toBe(true);
      expect((await app.load(NativeTournament, 'reaction-test')).state.current[0].lifecycle).toBe(
        'locked',
      );
      expect((await app.query({ stream: 'reaction-test' })).count).toBe(1);
    } finally {
      await app.shutdown();
      await store.dispose();
    }
  });
});
