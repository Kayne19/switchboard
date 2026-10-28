import type { CodeData } from '../controller/types';
import type { ReactNode } from 'react';
import { ListViewport } from './ListViewport';
import type { Slot } from './slot';
import { TechFrame } from './TechFrame';

const typePattern=/\b([A-Z][A-Za-z0-9_]*)\b/g;
const numberPattern=/\b(\d+(?:\.\d+)?)\b/g;
const stringPattern=/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

// A source's `language` picks its reading. A comment rule is a regex source
// whose `comment` group is the comment; `lead` is what must precede it and
// goes back to the plain text. A shell reads `#` as a comment only at the
// start of a word, so `$#` and `${#a[@]}` stay code.
const SLASHES='(?<comment>//.*$)';
const DASHES='(?<comment>--.*$)';
const HASH='(?<comment>#.*$)';
const WORD_HASH='(?<lead>^|[\\s;|&(<>])(?<comment>#.*$)';
// Every language shares this keyword set until each has a set of its own.
const JS_KEYWORDS=['export','async','function','const','let','var','if','else','return','await','new','true','false','null','undefined','type','interface','class','extends','import','from'];
type Language={names:readonly string[];comment:string;keywords:readonly string[]};
const C_FAMILY:Language={names:['c','h','cc','cpp','cxx','c++','hpp','cs','csharp','c#','dart','go','golang','groovy','java','javascript','js','jsx','jsonc','kotlin','kt','php','proto','protobuf','rust','rs','scala','swift','ts','tsx','typescript','zig'],comment:SLASHES,keywords:JS_KEYWORDS};
const LANGUAGES:readonly Language[]=[
  C_FAMILY,
  {names:['bash','fish','sh','shell','zsh','perl','pl'],comment:WORD_HASH,keywords:JS_KEYWORDS},
  {names:['cmake','conf','crystal','dockerfile','elixir','ex','exs','julia','jl','make','makefile','nim','nix','powershell','ps1','py','python','r','rb','ruby','tcl','toml','yaml','yml'],comment:HASH,keywords:JS_KEYWORDS},
  {names:['ada','elm','haskell','hs','lua','mysql','plsql','postgres','postgresql','psql','sql','sqlite'],comment:DASHES,keywords:JS_KEYWORDS},
];
type Reading={line:RegExp;keywords:RegExp};
// A string, or a comment that starts outside every string: one left-to-right
// pass, so `"a//b"` stays a string and a `//` after it is still a comment.
const readingOf=(language:Language):Reading=>({line:new RegExp(`${stringPattern.source}|${language.comment}`,'g'),keywords:new RegExp(`\\b(${language.keywords.join('|')})\\b`,'g')});
const READINGS=new Map(LANGUAGES.flatMap((language)=>{const reading=readingOf(language);return language.names.map((name)=>[name,reading] as const);}));
// No language is read as C-family; a language the table does not name is plain text.
const DEFAULT_READING=readingOf(C_FAMILY);
const readingFor=(language:string|undefined):Reading|undefined=>language===undefined?DEFAULT_READING:READINGS.get(language.trim().toLowerCase());
function highlightPlainSegment(text:string,keyBase:string,keywordPattern:RegExp):ReactNode[]{
  const pieces:ReactNode[]=[];let cursor=0;const tokens:Array<{start:number;end:number;className:string}>=[];
  for(const match of text.matchAll(keywordPattern))tokens.push({start:match.index,end:match.index+match[0].length,className:'tok-keyword'});
  for(const match of text.matchAll(typePattern))tokens.push({start:match.index,end:match.index+match[0].length,className:'tok-type'});
  for(const match of text.matchAll(numberPattern))tokens.push({start:match.index,end:match.index+match[0].length,className:'tok-number'});
  tokens.sort((a,b)=>a.start-b.start||b.end-a.end);let consumed=-1;
  for(const token of tokens){if(token.start<consumed)continue;if(token.start>cursor)pieces.push(text.slice(cursor,token.start));pieces.push(<span className={token.className} key={`${keyBase}-${token.start}`}>{text.slice(token.start,token.end)}</span>);cursor=token.end;consumed=token.end;}
  if(cursor<text.length)pieces.push(text.slice(cursor));return pieces;
}
function highlightLine(line:string,lineIndex:number,reading:Reading|undefined):ReactNode[]{
  if(reading===undefined)return [line];
  const nodes:ReactNode[]=[];let cursor=0;
  for(const match of line.matchAll(reading.line)){const comment=match.groups?.comment!==undefined,start=match.index+(match.groups?.lead?.length??0);if(start>cursor)nodes.push(...highlightPlainSegment(line.slice(cursor,start),`${lineIndex}-${cursor}`,reading.keywords));nodes.push(comment?<span className="tok-comment" key={`${lineIndex}-comment`}>{line.slice(start,match.index+match[0].length)}</span>:<span className="tok-string" key={`${lineIndex}-str-${start}`}>{match[0]}</span>);cursor=match.index+match[0].length;}
  if(cursor<line.length)nodes.push(...highlightPlainSegment(line.slice(cursor),`${lineIndex}-${cursor}`,reading.keywords));return nodes;
}

// Source in the interrupted-rails frame, clipped to its inside. Source that
// outgrows the frame scrolls in the list viewport, which pages it by the
// keys every scroller takes. `highlight` names lines counted from 1.
export function CodeViewport({data,slot='primary'}:{data:CodeData;slot?:Slot}){
  const lines=data.source.text.split('\n'),highlighted=new Set(data.source.highlight??[]),reading=readingFor(data.source.language);
  return <div className={`code-viewport${slot==='focus'?' code-viewport--focused':''}`} data-testid="code"><TechFrame variant="code"/><div className="code-viewport__mask"><ListViewport scrollClassName="code-viewport__scroll" label={data.title??'Source'}><pre>{lines.map((line,index)=>{const lineNumber=index+1;return <span className={`code-line${highlighted.has(lineNumber)?' code-line--hot':''}`} key={lineNumber}><span className="code-line__number">{lineNumber}</span><span className="code-line__source">{highlightLine(line,index,reading)}</span></span>;})}</pre></ListViewport></div></div>;
}
