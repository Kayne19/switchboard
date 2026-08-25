import type { RichSegment } from '../controller/types';
export function RichText({ segments }: { segments: RichSegment[] }) {
  return <>{segments.map((segment,index) => {
    const className = [segment.accent ? 'accent' : '', segment.semantic ? `semantic-${segment.semantic}` : ''].filter(Boolean).join(' ');
    const content = segment.bold ? <strong>{segment.text}</strong> : segment.text;
    return <span className={className || undefined} key={`${index}-${segment.text.slice(0,12)}`}>{content}</span>;
  })}</>;
}
