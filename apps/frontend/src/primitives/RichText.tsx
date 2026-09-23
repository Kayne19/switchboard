import type { ReactNode } from 'react';
import type { RichSegment } from '../controller/types';
import { parseBlocks, parseInline, type Block, type Inline } from './markdown';

function renderInlines(inlines: Inline[], keyBase: string): ReactNode[] {
  return inlines.map((node, index) => {
    const key = `${keyBase}.${index}`;
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'strong':
        return <strong key={key}>{renderInlines(node.children, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInlines(node.children, key)}</em>;
      case 'code':
        return <code className="rich-text__code" key={key}>{node.text}</code>;
      case 'break':
        return <br key={key} />;
    }
  });
}

function renderBlock(block: Block, key: string): ReactNode {
  if (block.kind === 'paragraph') {
    return <p className="rich-text__paragraph" key={key}>{renderInlines(block.inlines, key)}</p>;
  }
  const items = block.items.map((item, index) => <li key={index}>{renderInlines(item, `${key}.${index}`)}</li>);
  return block.ordered
    ? <ol className="rich-text__list" key={key}>{items}</ol>
    : <ul className="rich-text__list" key={key}>{items}</ul>;
}

function segmentClass(segment: RichSegment): string | undefined {
  return [segment.accent ? 'accent' : '', segment.semantic ? `semantic-${segment.semantic}` : ''].filter(Boolean).join(' ') || undefined;
}

// One segment is free text from a speaker and may carry paragraphs and lists.
// Several segments are an authored run of styled phrases and are read inline,
// each keeping its own accent and semantic colour. Keys are positional so an
// update to the text patches the same elements instead of remounting them.
export function RichText({ segments }: { segments: RichSegment[] }) {
  if (segments.length === 1) {
    const [segment] = segments;
    const blocks = parseBlocks(segment.text);
    if (blocks.length === 1 && blocks[0].kind === 'paragraph') {
      const content = renderInlines(blocks[0].inlines, 'text');
      return <span className={segmentClass(segment)}>{segment.bold ? <strong>{content}</strong> : content}</span>;
    }
    const className = ['rich-text', segmentClass(segment)].filter(Boolean).join(' ');
    return <div className={className}>{blocks.map((block, index) => renderBlock(block, `block.${index}`))}</div>;
  }
  return <>{segments.map((segment, index) => {
    const content = renderInlines(parseInline(segment.text), `segment.${index}`);
    return <span className={segmentClass(segment)} key={index}>{segment.bold ? <strong>{content}</strong> : content}</span>;
  })}</>;
}
