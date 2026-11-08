import { describe, expect, it } from 'vitest';
import { linkedFinalCaption } from '../src/lib/linkedFinalCaption';

const imported = {
  division: 'upper',
  stage: 'main',
  label: 'upper main · M700351 · Replay 2',
  nativeBracketId: null,
  sourceSetId: 'imported-set',
  sourceKey: 'set:imported-set',
};

describe('linked final captions', () => {
  it('keeps the original identifier and uses the published field for context', () => {
    expect(linkedFinalCaption(imported)).toEqual({
      context: 'Upper Championship',
      identifier: 'M700351 · Replay 2',
      text: 'Upper Championship · M700351 · Replay 2',
    });
    expect(
      linkedFinalCaption({
        ...imported,
        division: 'lower',
        stage: 'consolation',
        label: 'lower consolation · 17',
      }),
    ).toEqual({ context: 'Lower Consolation', identifier: '17', text: 'Lower Consolation · 17' });
    expect(
      linkedFinalCaption({ ...imported, label: 'upper main · upper main · 17' })?.identifier,
    ).toBe('upper main · 17');
  });

  it.each([
    { sourceSetId: null },
    { sourceKey: undefined },
    { sourceKey: 'set:other' },
    { nativeBracketId: 'native-draw' },
    { labelFromStructure: true as const },
    { stage: 'group', label: 'upper group · 17' },
    { label: 'Provider round · 17' },
    { label: 'lower main · 17' },
    { label: 'upper main · ' },
  ])('retains fallback for %j', (facts) => {
    expect(linkedFinalCaption({ ...imported, ...facts })).toBeNull();
  });
});
