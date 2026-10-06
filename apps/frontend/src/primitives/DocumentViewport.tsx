import type { DocumentData } from '../controller/types';
import type { Noun } from './countText';
import { ListViewport } from './ListViewport';
import { MarkdownBlocks } from './RichText';
import { TechFrame } from './TechFrame';

// What the rims count a document's blocks as: its paragraphs, a list or a
// code block among them standing as one.
const PARAGRAPH: Noun = ['PARAGRAPH', 'PARAGRAPHS'];

// Each paragraph is agent prose and may carry the same Markdown subset as the
// conversation surfaces: headings, emphasis, inline code, lists and fenced
// code. It is never HTML, and links show their label only. A body that
// outgrows the frame scrolls in the list viewport, which counts the
// paragraphs past each edge and pages it by the keys every scroller takes.
export function DocumentViewport({data,focused=false}:{data:DocumentData;focused?:boolean}){
  return <div className={`document-viewport${focused?' document-viewport--focused':''}`} data-testid="document"><TechFrame variant="document"/><div className="document-viewport__inner"><div className="document-viewport__meta tech micro"><span>{data.source??'DOCUMENT'}</span><span>{data.from?`FROM / ${data.from}`:''}</span><span>{data.timestamp}</span></div><h1>{data.subject}</h1><ListViewport noun={PARAGRAPH} countSelector=":scope > *" className="document-viewport__reader" scrollClassName="document-viewport__body" label={data.subject}>{data.paragraphs.map((paragraph,index)=><MarkdownBlocks key={index} text={paragraph}/>)}</ListViewport></div></div>;
}
