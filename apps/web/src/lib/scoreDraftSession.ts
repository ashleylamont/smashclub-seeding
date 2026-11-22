import { useEffect, useState } from 'react';
import {
  isCharacterSlug,
  MAX_CHARACTERS_PER_SET_PLAYER,
  type SetCharacterPick,
} from '@smashclub/shared';
import type { ScoreInputValue } from '../components/ScoreFields';
import type { Session } from './auth';

type OwnerKind = 'account' | 'guest';
export type DraftOwner = `${OwnerKind}:${string}`;

export type SavedScoreDraft = {
  score1: ScoreInputValue;
  score2: ScoreInputValue;
  revision: number;
  requestId: string;
  confirmationId: string;
  picks: SetCharacterPick[];
  editing: boolean;
  retryRejected: boolean;
  attemptedRequestId: string | null;
  touchedAt: number;
};

type DraftEntry = [string, SavedScoreDraft];
type EventDrafts = { planId: string; owner: DraftOwner; entries: DraftEntry[] };

const key = 'nemesis:score-drafts:v1';
const maximumAge = 12 * 60 * 60 * 1000;
const maximumEvents = 4;
const maximumDrafts = 16;
const maximumStorageLength = 64_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ownerFormat = /^(account|guest):[0-9a-f]{64}$/;
let initialized = false;

function tabStorage() {
  const storage = window.sessionStorage;
  if (!initialized) {
    const navigation = (
      performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    )?.type;
    // Chromium can clone tab storage through a fresh history document with no opener.
    // A same-document history traversal never reinitializes this module.
    if (navigation === 'back_forward' || (window.opener && navigation !== 'reload'))
      storage.removeItem(key);
    initialized = true;
  }
  return storage;
}

export function accountDraftSource(session: Session, unresolved: boolean) {
  return unresolved
    ? undefined
    : session
      ? JSON.stringify([session.user.id, session.session.id])
      : null;
}

/** The source is an already authenticated account or guest session identifier. */
export function useScoreDraftOwner(kind: OwnerKind, source: string | null | undefined) {
  const [resolved, setResolved] = useState<{ source: string; owner: DraftOwner }>();
  useEffect(() => {
    if (!source) return;
    let active = true;
    const bytes = new TextEncoder().encode(`nemesis:score-draft-owner:v1:${kind}:${source}`);
    void crypto.subtle?.digest('SHA-256', bytes).then(
      (buffer) => {
        if (active) {
          const digest = Array.from(new Uint8Array(buffer), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join('');
          setResolved({ source, owner: `${kind}:${digest}` });
        }
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [kind, source]);
  return source == null ? source : resolved?.source === source ? resolved.owner : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function score(value: unknown): value is ScoreInputValue {
  return (
    value === '' ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5)
  );
}

function parsePicks(value: unknown): SetCharacterPick[] | undefined {
  if (!Array.isArray(value) || value.length > 4) return;
  const result: SetCharacterPick[] = [];
  for (const pick of value) {
    if (!record(pick)) return;
    const { playerId, characters } = pick;
    if (
      typeof playerId !== 'string' ||
      !uuid.test(playerId) ||
      result.some((item) => item.playerId === playerId) ||
      !Array.isArray(characters) ||
      !characters.length ||
      characters.length > MAX_CHARACTERS_PER_SET_PLAYER ||
      new Set(characters).size !== characters.length ||
      !characters.every((item) => typeof item === 'string' && isCharacterSlug(item))
    )
      return;
    result.push({ playerId, characters });
  }
  return result;
}

function parseDraft(value: unknown, now: number): SavedScoreDraft | undefined {
  if (!record(value)) return;
  const {
    score1,
    score2,
    revision,
    requestId,
    confirmationId,
    editing,
    retryRejected,
    attemptedRequestId,
    touchedAt,
  } = value;
  const picks = parsePicks(value.picks);
  if (
    !score(score1) ||
    !score(score2) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof requestId !== 'string' ||
    !uuid.test(requestId) ||
    typeof confirmationId !== 'string' ||
    !uuid.test(confirmationId) ||
    typeof editing !== 'boolean' ||
    typeof retryRejected !== 'boolean' ||
    (attemptedRequestId !== null &&
      attemptedRequestId !== requestId &&
      attemptedRequestId !== confirmationId) ||
    typeof touchedAt !== 'number' ||
    !Number.isSafeInteger(touchedAt) ||
    touchedAt > now ||
    touchedAt <= now - maximumAge ||
    !picks
  )
    return;
  return {
    score1,
    score2,
    revision,
    requestId,
    confirmationId,
    picks,
    editing,
    retryRejected,
    attemptedRequestId,
    touchedAt,
  };
}

function read(): EventDrafts[] {
  try {
    const raw = tabStorage().getItem(key);
    if (!raw || raw.length > maximumStorageLength) return [];
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored) || stored.length > maximumEvents) return [];
    const now = Date.now();
    return stored.flatMap((item) => {
      if (
        !record(item) ||
        typeof item.planId !== 'string' ||
        !uuid.test(item.planId) ||
        typeof item.owner !== 'string' ||
        !ownerFormat.test(item.owner) ||
        !Array.isArray(item.entries) ||
        item.entries.length > maximumDrafts
      )
        return [];
      const entries = item.entries.flatMap((entry): DraftEntry[] => {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          entry[0].length > 512
        )
          return [];
        const draft = parseDraft(entry[1], now);
        return draft ? [[entry[0], draft]] : [];
      });
      return entries.length
        ? [{ planId: item.planId, owner: item.owner as DraftOwner, entries }]
        : [];
    });
  } catch {
    return [];
  }
}

function write(records: EventDrafts[]) {
  try {
    const storage = tabStorage();
    let serialized = JSON.stringify(records);
    while (serialized.length > maximumStorageLength) {
      // The entries of each event are newest first. Discard the oldest edit
      // across events so a new edit can still replace the previous snapshot.
      const oldest = records.reduce((previous, record) =>
        record.entries.at(-1)![1].touchedAt <= previous.entries.at(-1)![1].touchedAt
          ? record
          : previous,
      );
      oldest.entries.pop();
      records = records.filter((record) => record.entries.length);
      serialized = JSON.stringify(records);
    }
    if (!records.length) storage.removeItem(key);
    else if (storage.getItem(key) !== serialized) storage.setItem(key, serialized);
  } catch {
    // Reporting still works in memory when storage is unavailable.
  }
}

export function storedScoreDraftOwner(planId: string) {
  return read().find((item) => item.planId === planId)?.owner;
}

export function readScoreDrafts(planId: string, owner: DraftOwner) {
  return read().find((record) => record.planId === planId && record.owner === owner)?.entries ?? [];
}

export function saveScoreDrafts(planId: string, owner: DraftOwner, entries: DraftEntry[]) {
  const now = Date.now();
  const valid = entries.flatMap(([key, value]): DraftEntry[] => {
    const draft = parseDraft(value, now);
    return draft && key.length <= 512 ? [[key, draft]] : [];
  });
  const latest = valid.sort((a, b) => b[1].touchedAt - a[1].touchedAt).slice(0, maximumDrafts);
  const events = read().filter((item) => item.planId !== planId);
  write(
    (latest.length ? [{ planId, owner, entries: latest }, ...events] : events).slice(
      0,
      maximumEvents,
    ),
  );
}

export function clearScoreDrafts(planId?: string) {
  write(planId ? read().filter((item) => item.planId !== planId) : []);
}

export function clearOtherAccountScoreDrafts(owner: DraftOwner | null) {
  write(read().filter((item) => !item.owner.startsWith('account:') || item.owner === owner));
}
