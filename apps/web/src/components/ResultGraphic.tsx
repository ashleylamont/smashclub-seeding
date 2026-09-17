import { resultsSvg, type GraphicResult } from '../lib/resultGraphic';
export function ResultGraphic({ title, results }: { title: string; results: readonly GraphicResult[] }) {
  if (!results.length) return null;
  const download = () => {
    const url = URL.createObjectURL(new Blob([resultsSvg(title, results)], { type: 'image/svg+xml;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'smash-club-results.svg';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <button type="button" className="btn" onClick={download}>Download results graphic ↓</button>;
}
