import type { DocumentData } from '../controller/types';
import { MarkdownBlocks } from './RichText';
import { TechFrame } from './TechFrame';

// Each paragraph is agent prose and may carry the same Markdown subset as the
// conversation surfaces: headings, emphasis, inline code, lists and fenced
// code. It is never HTML, and links show their label only.
export function DocumentViewport({data,focused=false}:{data:DocumentData;focused?:boolean}){
  return <div className={`document-viewport${focused?' document-viewport--focused':''}`} data-testid="document"><TechFrame variant="document"/><div className="document-viewport__inner"><div className="document-viewport__meta tech micro"><span>{data.source??'DOCUMENT'}</span><span>{data.from?`FROM / ${data.from}`:''}</span><span>{data.timestamp}</span></div><h1>{data.subject}</h1><div className="document-viewport__body" tabIndex={0}>{data.paragraphs.map((paragraph,index)=><MarkdownBlocks key={index} text={paragraph}/>)}</div></div></div>;
}
