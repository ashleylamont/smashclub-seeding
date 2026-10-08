import { useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';

const subscribe = (notify: () => void) => onlineManager.subscribe(notify);
const snapshot = () => onlineManager.isOnline();

/** Paused offline queries retain data without becoming errors. */
export function useOnlineStatus() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
