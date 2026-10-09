import * as Primitive from '@radix-ui/react-tabs';
import { useEffect, useRef, type ComponentProps } from 'react';

export function Tabs(props: ComponentProps<typeof Primitive.Root>) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = root.current?.querySelector<HTMLElement>('.ui-tab-list');
    const active = strip?.querySelector<HTMLElement>('[data-state="active"]');
    if (!strip || !active) return;
    const revealActive = () => {
      const left =
        active.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
      if (
        left < strip.scrollLeft ||
        left + active.offsetWidth > strip.scrollLeft + strip.clientWidth
      ) {
        strip.scrollTo({ left: Math.max(0, left - 8), behavior: 'auto' });
      }
    };
    revealActive();
    const observer = new ResizeObserver(revealActive);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [props.value]);
  return <Primitive.Root activationMode="manual" {...props} ref={root} />;
}

export function TabList({ className = '', ...props }: ComponentProps<typeof Primitive.List>) {
  return <Primitive.List {...props} className={`ui-tab-list ${className}`} />;
}

export function Tab({ className = '', ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return <Primitive.Trigger {...props} className={`ui-tab ${className}`} />;
}

/** Keep edits while switching destinations. Inactive panels are hidden in ui.css. */
export function TabPanel({ className = '', ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Content forceMount {...props} className={`ui-tab-panel ${className}`} />;
}
