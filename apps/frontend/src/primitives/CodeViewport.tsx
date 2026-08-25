import type { CodeData } from '../controller/types';
import { TechFrame } from './TechFrame';
import type { ReactNode } from 'react';

const keywordPattern=/\b(export|async|function|const|let|var|if|else|return|await|new|true|false|null|undefined|type|interface|class|extends|import|from)\b/g;
const typePattern=/\b([A-Z][A-Za-z0-9_]*)\b/g;
const numberPattern=/\b(\d+(?:\.\d+)?)\b/g;
const stringPattern=/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

function highlightPlainSegment(text:string,keyBase:string):ReactNode[]{
  const pieces:ReactNode[]=[];let cursor=0;const tokens:Array<{start:number;end:number;className:string}>=[];
  for(const match of text.matchAll(keywordPattern))tokens.push({start:match.index,end:match.index+match[0].length,className:'tok-keyword'});
  for(const match of text.matchAll(typePattern))tokens.push({start:match.index,end:match.index+match[0].length,className:'tok-type'});
  for(const match of text.matchAll(numberPattern))tokens.push({start:match.index,end:match.index+match[0].length,className:'tok-number'});
  tokens.sort((a,b)=>a.start-b.start||b.end-a.end);let consumed=-1;
  for(const token of tokens){if(token.start<consumed)continue;if(token.start>cursor)pieces.push(text.slice(cursor,token.start));pieces.push(<span className={token.className} key={`${keyBase}-${token.start}`}>{text.slice(token.start,token.end)}</span>);cursor=token.end;consumed=token.end;}
  if(cursor<text.length)pieces.push(text.slice(cursor));return pieces;
}
function highlightLine(line:string,lineIndex:number):ReactNode[]{
  const commentIndex=line.indexOf('//'),codePart=commentIndex>=0?line.slice(0,commentIndex):line,comment=commentIndex>=0?line.slice(commentIndex):'';const nodes:ReactNode[]=[];let cursor=0;
  for(const match of codePart.matchAll(stringPattern)){const start=match.index;if(start>cursor)nodes.push(...highlightPlainSegment(codePart.slice(cursor,start),`${lineIndex}-${cursor}`));nodes.push(<span className="tok-string" key={`${lineIndex}-str-${start}`}>{match[0]}</span>);cursor=start+match[0].length;}
  if(cursor<codePart.length)nodes.push(...highlightPlainSegment(codePart.slice(cursor),`${lineIndex}-${cursor}`));if(comment)nodes.push(<span className="tok-comment" key={`${lineIndex}-comment`}>{comment}</span>);return nodes;
}

export function CodeViewport({data,focused=false}:{data:CodeData;focused?:boolean}){
  const lines=data.source.text.split('\n'),highlighted=new Set(data.source.highlight??[]);
  return <div className={`code-viewport${focused?' code-viewport--focused':''}`} data-testid="code"><TechFrame variant="code"/><div className="code-viewport__mask"><div className="code-viewport__scroll" tabIndex={0}><pre>{lines.map((line,index)=>{const lineNumber=index+1;return <span className={`code-line${highlighted.has(lineNumber)?' code-line--hot':''}`} key={lineNumber}><span className="code-line__number">{lineNumber}</span><span className="code-line__source">{highlightLine(line,index)}</span></span>;})}</pre></div></div></div>;
}
