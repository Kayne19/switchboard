import type { ReactNode } from 'react';
import type { RichSegment } from '../controller/types';
import { parseBlocks, parseInline, type Block, type Inline } from './markdown';

function renderInlines(inlines: Inline[], keyBase: string, allowLinks = false): ReactNode[] {
  return inlines.map((node, index) => {
    const key = `${keyBase}.${index}`;
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'strong':
        return <strong key={key}>{renderInlines(node.children, key, allowLinks)}</strong>;
      case 'em':
        return <em key={key}>{renderInlines(node.children, key, allowLinks)}</em>;
      case 'code':
        return <code className="rich-text__code" key={key}>{node.text}</code>;
      case 'link':
        return allowLinks
          ? <a href={node.href} target="_blank" rel="noopener noreferrer" key={key}>{renderInlines(node.children, key, allowLinks)}</a>
          : renderInlines(node.children, key, allowLinks);
      case 'break':
        return <br key={key} />;
    }
  });
}

function renderBlock(block: Block, key: string, allowLinks: boolean): ReactNode {
  if (block.kind === 'paragraph') {
    return <p className="rich-text__paragraph" key={key}>{renderInlines(block.inlines, key, allowLinks)}</p>;
  }
  if (block.kind === 'code') {
    return <pre className="rich-text__code-block" key={key}><code>{block.text}</code></pre>;
  }
  const items = block.items.map((item, index) => <li key={index}>{renderInlines(item, `${key}.${index}`, allowLinks)}</li>);
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
export function RichText({ segments, allowLinks = false }: { segments: RichSegment[]; allowLinks?: boolean }) {
  if (segments.length === 1) {
    const [segment] = segments;
    const blocks = parseBlocks(segment.text);
    if (blocks.length === 1 && blocks[0].kind === 'paragraph') {
      const content = renderInlines(blocks[0].inlines, 'text', allowLinks);
      return <span className={segmentClass(segment)}>{segment.bold ? <strong>{content}</strong> : content}</span>;
    }
    const className = ['rich-text', segmentClass(segment)].filter(Boolean).join(' ');
    return <div className={className}>{blocks.map((block, index) => renderBlock(block, `block.${index}`, allowLinks))}</div>;
  }
  return <>{segments.map((segment, index) => {
    const content = renderInlines(parseInline(segment.text), `segment.${index}`, allowLinks);
    return <span className={segmentClass(segment)} key={index}>{segment.bold ? <strong>{content}</strong> : content}</span>;
  })}</>;
}
