import { describe, expect, it } from 'vitest';
import { characterPortraitPack } from '../src/lib/resultGraphicPortraitPack';

const imageFile = (name: string, type = 'image/png') => new File(['artwork'], name, { type });

describe('local result character artwork filenames', () => {
  it('indexes the exact roster slug and accepts ordinary filename casing', () => {
    const mario = imageFile('Mario.PNG');
    const gameAndWatch = imageFile('mr-game-and-watch.webp', 'image/webp');
    expect([...characterPortraitPack([mario, gameAndWatch])]).toEqual([
      ['mario', mario],
      ['mr-game-and-watch', gameAndWatch],
    ]);
  });

  it('rejects an unknown slug, duplicate slug and unsupported file', () => {
    expect(() => characterPortraitPack([imageFile('made-up.png')])).toThrow(/character filename/);
    expect(() =>
      characterPortraitPack([imageFile('mario.png'), imageFile('MARIO.JPG', 'image/jpeg')]),
    ).toThrow('Choose only one artwork file for mario.');
    expect(() => characterPortraitPack([imageFile('mario.png', 'image/svg+xml')])).toThrow(
      /Choose a PNG, JPEG or WebP portrait/,
    );
  });
});
