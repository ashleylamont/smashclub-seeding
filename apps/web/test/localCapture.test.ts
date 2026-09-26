import { describe, expect, it, vi } from 'vitest';
import { LocalCapture, captureError } from '../src/lib/localCapture';
function source() {
  const listeners = new Map<string, () => void>();
  const track = { readyState: 'live', stop: vi.fn(), addEventListener: vi.fn((name: string, handler: () => void) => listeners.set(name, handler)), removeEventListener: vi.fn((name: string) => listeners.delete(name)) };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream, track, end: () => listeners.get('ended')?.() };
}
describe('local overlay capture lifecycle', () => {
  it('releases a permission response that arrives after cancellation', async () => {
    const sourceA = source();
    const changed = vi.fn();
    const capture = new LocalCapture(changed);
    let resolve!: (stream: MediaStream) => void;
    const pending = capture.start(() => new Promise(done => { resolve = done; }));
    capture.stop();
    resolve(sourceA.stream);
    expect(await pending).toBe(false);
    expect(sourceA.track.stop).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalledWith(sourceA.stream);
  });
  it('releases replaced and unmounted streams, including outstanding prompts', async () => {
    const a = source(), b = source(), late = source();
    const changed = vi.fn();
    const capture = new LocalCapture(changed);
    await capture.start(async () => a.stream);
    await capture.start(async () => b.stream);
    expect(a.track.stop).toHaveBeenCalledOnce();
    let resolve!: (stream: MediaStream) => void;
    const pending = capture.start(() => new Promise(done => { resolve = done; }));
    expect(b.track.stop).toHaveBeenCalledOnce();
    capture.dispose();
    changed.mockClear();
    resolve(late.stream);
    await pending;
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });
  it('releases every track and clears the display when browser sharing ends', async () => {
    const item = source();
    const changed = vi.fn();
    const capture = new LocalCapture(changed);
    await capture.start(async () => item.stream);
    item.end();
    expect(item.track.stop).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(item.track.removeEventListener).toHaveBeenCalled();
  });
  it('explains permission and busy-device failures without leaking browser internals', () => {
    expect(captureError(new DOMException('secret', 'NotAllowedError'))).toContain('permission was denied');
    expect(captureError(new DOMException('secret', 'NotReadableError'))).toContain('Close other apps');
  });
});
