import { createRoot } from 'react-dom/client';
import type { ComponentProps } from 'react';
import type { EventBrackets } from './components/EventNightBoard';
const original = new URLSearchParams(location.search).get('renderer') === 'original';
const data = (
  window as unknown as {
    tip12: {
      nativeBrackets: ComponentProps<typeof EventBrackets>['brackets'];
      matches: ComponentProps<typeof EventBrackets>['matches'];
      entrants: ComponentProps<typeof EventBrackets>['entrants'];
    };
  }
).tip12;
const { EventBrackets: Board } = original
  ? await import('./components/LocalTip12Original')
  : await import('./components/EventNightBoard');
if (original) await import('./pages/LocalTip12Original.css');
else await import('./pages/EventLive.css');
createRoot(document.querySelector('#root')!).render(
  <main className="event-display event-board">
    <h1>TIP12 archived bracket</h1>
    <Board
      brackets={data.nativeBrackets}
      matches={data.matches}
      entrants={data.entrants}
      linked={[]}
    />
  </main>,
);
