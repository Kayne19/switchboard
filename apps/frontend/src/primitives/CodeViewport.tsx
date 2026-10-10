import type { CodeData } from '../controller/types';
import type { ReactNode } from 'react';
import { ListViewport } from './ListViewport';
import type { Slot } from './slot';
import { TechFrame } from './TechFrame';

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
// The line-comment marker of the source's `language`. Source with no
// language is read as C-family, as it always was; a language this table does
// not name marks no comment rather than guess one. Keywords stay the one
// JS/TS set for every language.
const LINE_COMMENT:ReadonlyArray<readonly [string,readonly string[]]>=[
  ['//',['c','h','cc','cpp','cxx','c++','hpp','cs','csharp','c#','dart','go','golang','groovy','java','javascript','js','jsx','jsonc','kotlin','kt','php','proto','protobuf','rust','rs','scala','swift','ts','tsx','typescript','zig']],
  ['#',['bash','cmake','conf','crystal','dockerfile','elixir','ex','exs','fish','julia','jl','make','makefile','nim','nix','perl','pl','powershell','ps1','py','python','r','rb','ruby','sh','shell','tcl','toml','yaml','yml','zsh']],
  ['--',['ada','elm','haskell','hs','lua','mysql','plsql','postgres','postgresql','psql','sql','sqlite']],
];
const commentMarkers=new Map(LINE_COMMENT.flatMap(([marker,names])=>names.map((name)=>[name,marker] as const)));
// A string, or a comment (the `comment` group) that starts outside every
// string: one left-to-right pass, so `"a//b"` stays a string and the `//`
// after it is still a comment.
function linePattern(language:string|undefined):RegExp{
  const marker=language===undefined?'//':commentMarkers.get(language.trim().toLowerCase());
  return marker===undefined?new RegExp(stringPattern.source,'g'):new RegExp(`${stringPattern.source}|(?<comment>${marker.replace(/[\\^$.*+?()[\]{}|/#-]/g,'\\$&')}.*$)`,'g');
}
function highlightLine(line:string,lineIndex:number,pattern:RegExp):ReactNode[]{
  const nodes:ReactNode[]=[];let cursor=0;
  for(const match of line.matchAll(pattern)){const start=match.index;if(start>cursor)nodes.push(...highlightPlainSegment(line.slice(cursor,start),`${lineIndex}-${cursor}`));nodes.push(match.groups?.comment===undefined?<span className="tok-string" key={`${lineIndex}-str-${start}`}>{match[0]}</span>:<span className="tok-comment" key={`${lineIndex}-comment`}>{match[0]}</span>);cursor=start+match[0].length;}
  if(cursor<line.length)nodes.push(...highlightPlainSegment(line.slice(cursor),`${lineIndex}-${cursor}`));return nodes;
}

// Source in the interrupted-rails frame, clipped to its inside. Source that
// outgrows the frame scrolls in the list viewport, which pages it by the
// keys every scroller takes. `highlight` names lines counted from 1.
export function CodeViewport({data,slot='primary'}:{data:CodeData;slot?:Slot}){
  const lines=data.source.text.split('\n'),highlighted=new Set(data.source.highlight??[]),pattern=linePattern(data.source.language);
  return <div className={`code-viewport${slot==='focus'?' code-viewport--focused':''}`} data-testid="code"><TechFrame variant="code"/><div className="code-viewport__mask"><ListViewport scrollClassName="code-viewport__scroll" label={data.title??'Source'}><pre>{lines.map((line,index)=>{const lineNumber=index+1;return <span className={`code-line${highlighted.has(lineNumber)?' code-line--hot':''}`} key={lineNumber}><span className="code-line__number">{lineNumber}</span><span className="code-line__source">{highlightLine(line,index,pattern)}</span></span>;})}</pre></ListViewport></div></div>;
}
