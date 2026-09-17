import { describe, expect, it } from 'vitest';
import { liveSections, overlayGeometry, type LiveMatch } from '../src/lib/eventDisplay';

describe('spectator event board', () => {
  it('keeps blocked matches out of the ready queue and counts only confirmed results', () => {
    const matches = ['ready', 'blocked', 'playing', 'complete'].map((status, index) => ({ id: String(index), status }) as LiveMatch);
    const sections = liveSections(matches);
    expect(sections.ready.map(m => m.id)).toEqual(['0']);
    expect(sections.playing.map(m => m.id)).toEqual(['2']);
    expect(sections.complete.map(m => m.id)).toEqual(['3']);
    expect(sections.total).toBe(4);
  });
  it('bounds malformed browser-source geometry while retaining a transparent centre', () => {
    expect(overlayGeometry('')).toEqual({ width: 68, height: 65 });
    expect(overlayGeometry('?captureWidth=75&captureHeight=70')).toEqual({ width: 75, height: 70 });
    expect(overlayGeometry('?captureWidth=Infinity&captureHeight=no')).toEqual({ width: 68, height: 65 });
    expect(overlayGeometry('?captureWidth=-1&captureHeight=999')).toEqual({ width: 35, height: 80 });
  });
});
