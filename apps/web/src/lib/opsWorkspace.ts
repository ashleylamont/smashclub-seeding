import { useNavigate, useSearch } from '@tanstack/react-router';
import { jumpToOpsControl } from './opsAttention';

export const OPS_SECTIONS = [
  { value: 'run', label: 'Run matches' },
  { value: 'players', label: 'Players' },
  { value: 'draw', label: 'Standings / draw' },
  { value: 'broadcast', label: 'Broadcast' },
  { value: 'history', label: 'History' },
  { value: 'settings', label: 'Settings' },
] as const;
export type OpsSection = (typeof OPS_SECTIONS)[number]['value'];

export function opsSection(value: unknown): OpsSection {
  return OPS_SECTIONS.find((section) => section.value === value)?.value ?? 'run';
}

export function useOpsWorkspace() {
  const search = useSearch({ strict: false }) as { view?: string };
  const navigate = useNavigate();
  const section = opsSection(search.view);
  const changeSection = (value: string) =>
    navigate({
      to: '.',
      search: (previous) => ({ ...previous, view: opsSection(value) }),
      resetScroll: false,
    });
  const openControl = async (id: string, value: OpsSection = 'run') => {
    await changeSection(value);
    requestAnimationFrame(() => jumpToOpsControl(id));
  };
  return { section, changeSection, openControl };
}
