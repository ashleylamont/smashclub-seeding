import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guestSessionCurrent, readGuestSession, saveGuestSession } from '../src/lib/guestReporting';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const pass = { sessionToken: 'saved-event-reporting-pass'.repeat(2), expiresAt: null };
const key = 'nemesis:guest:event';
beforeEach(() => {
  const localStorage = storage();
  const sessionStorage = storage();
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('sessionStorage', sessionStorage);
  vi.stubGlobal('window', { localStorage, sessionStorage });
});
afterEach(() => vi.unstubAllGlobals());

describe('saved event guest access', () => {
  it('survives a new browser session and stays scoped to its event', () => {
    saveGuestSession('event', pass);
    sessionStorage.clear();
    expect(readGuestSession('event')).toEqual(pass);
    expect(readGuestSession('other-event')).toBeNull();
    expect(guestSessionCurrent(pass, Date.now() + 24 * 60 * 60_000)).toBe(true);
  });

  it('imports an existing session pass without changing its expiry', () => {
    const legacy = { ...pass, expiresAt: '2026-10-31T10:00:00.000Z' };
    sessionStorage.setItem(key, JSON.stringify(legacy));
    expect(readGuestSession('event')).toEqual(legacy);
    expect(localStorage.getItem(key)).toBe(JSON.stringify(legacy));
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(guestSessionCurrent(legacy, Date.parse(legacy.expiresAt))).toBe(false);
  });

  it('ignores malformed storage and does not interpret a missing expiry as permanent access', () => {
    for (const value of [
      'broken json',
      JSON.stringify({ sessionToken: pass.sessionToken }),
      JSON.stringify({ ...pass, expiresAt: 'not a date' }),
    ]) {
      localStorage.setItem(key, value);
      expect(readGuestSession('event')).toBeNull();
    }
    expect(guestSessionCurrent(null, Date.now())).toBe(false);
  });

  it('falls back to tab storage when durable storage is unavailable', () => {
    localStorage.setItem(key, JSON.stringify({ ...pass, sessionToken: 'old-pass'.repeat(5) }));
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });
    saveGuestSession('event', pass);
    expect(readGuestSession('event')).toEqual(pass);
    expect(sessionStorage.getItem(key)).toBe(JSON.stringify(pass));
  });
});
