import type { DocumentData } from '../controller/types';
import type { Noun } from './countText';
import { ListViewport } from './ListViewport';
import { MarkdownBlocks } from './RichText';
import type { Slot } from './slot';
import { TechFrame } from './TechFrame';

// What the rims count a document's blocks as: its paragraphs (a heading is
// drawn as a bold one), a list or a code block among them standing as one.
const PARAGRAPH: Noun = ['PARAGRAPH', 'PARAGRAPHS'];

// Each paragraph is agent prose and may carry the same Markdown subset as the
// conversation surfaces: headings, emphasis, inline code, lists and fenced
// code. It is never HTML, and links show their label only. A body that
// outgrows the frame scrolls in the list viewport, which counts the
// paragraphs past each edge and pages it by the keys every scroller takes.
export function DocumentViewport({data,slot='primary'}:{data:DocumentData;slot?:Slot}){
  return <div className={`document-viewport${slot==='focus'?' document-viewport--focused':''}`} data-testid="document"><TechFrame variant="document"/><div className="document-viewport__inner"><div className="document-viewport__meta meta-line tech micro"><span>{data.source??'DOCUMENT'}</span><span>{data.from?`FROM / ${data.from}`:''}</span><span>{data.timestamp}</span></div><h1>{data.subject}</h1><ListViewport noun={PARAGRAPH} countSelector=":scope > *" className="document-viewport__reader" scrollClassName="document-viewport__body" label={data.subject}>{data.paragraphs.map((paragraph,index)=><MarkdownBlocks key={index} text={paragraph}/>)}</ListViewport></div></div>;
}
