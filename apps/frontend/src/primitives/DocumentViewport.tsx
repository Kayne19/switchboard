import type { DocumentData } from '../controller/types';
import { TechFrame } from './TechFrame';

export function DocumentViewport({data,focused=false}:{data:DocumentData;focused?:boolean}){
  return <div className={`document-viewport${focused?' document-viewport--focused':''}`} data-testid="document"><TechFrame variant="document"/><div className="document-viewport__inner"><div className="document-viewport__meta tech micro"><span>{data.source??'DOCUMENT'}</span><span>{data.from?`FROM / ${data.from}`:''}</span><span>{data.timestamp}</span></div><h1>{data.subject}</h1><div className="document-viewport__body" tabIndex={0}>{data.paragraphs.map((paragraph,index)=>{const lines=paragraph.split('\n');return <p key={`${index}-${paragraph.slice(0,16)}`}>{lines.map((line,lineIndex)=><span key={lineIndex}>{line}{lineIndex<lines.length-1?<br/>:null}</span>)}</p>;})}</div></div></div>;
}
