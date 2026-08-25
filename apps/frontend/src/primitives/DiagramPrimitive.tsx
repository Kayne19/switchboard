import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiagramData, DiagramEdge, DiagramNode, Semantic } from '../controller/types';
import { useElementSize } from '../hooks/useElementSize';

const colors: Record<Semantic,string> = { red:'var(--red)',orange:'var(--orange)',green:'var(--green)',cyan:'var(--cyan)',amber:'var(--amber)',paper:'var(--paper)',muted:'var(--muted)' };
type PositionedNode = DiagramNode & { x:number; y:number; layer:number; indexInLayer:number };

let mermaidSequence = 0;

function MermaidDiagram({data,focused}:{data:DiagramData;focused:boolean}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    const source = data.source?.trim();
    if (!host || !source) return;
    let active = true;
    const style = getComputedStyle(document.documentElement);
    const color = (name:string, fallback:string) => style.getPropertyValue(name).trim() || fallback;
    const render = async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'antiscript',
          flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: true },
          themeVariables: {
            darkMode: true,
            background: '#000000',
            primaryColor: '#000000',
            primaryBorderColor: color('--paper', '#ece8df'),
            primaryTextColor: color('--paper', '#ece8df'),
            secondaryColor: '#080808',
            tertiaryColor: '#000000',
            lineColor: color('--cyan', '#65d7e8'),
            textColor: color('--paper', '#ece8df'),
            edgeLabelBackground: '#000000',
            fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
            fontSize: '14px',
          },
        });
        const id = `switchboard-mermaid-${++mermaidSequence}`;
        const parsed = await mermaid.parse(source, { suppressErrors: true });
        if (!parsed) throw new Error('Mermaid source did not parse');
        const result = await mermaid.render(id, source);
        if (!active || !hostRef.current) return;
        const documentSvg = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
        const parserError = documentSvg.querySelector('parsererror');
        if (parserError) throw new Error('Rendered SVG did not parse');
        const svg = document.adoptNode(documentSvg.documentElement);
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', data.title ?? 'System diagram');
        hostRef.current.replaceChildren(svg);
        result.bindFunctions?.(hostRef.current);
        setError('');
      } catch (caught) {
        if (!active) return;
        host.replaceChildren();
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void render();
    return () => { active = false; };
  }, [data.source, data.title]);

  return <div className={`diagram-primitive diagram-primitive--mermaid${focused?' diagram-primitive--focused':''}`} data-testid="diagram">
    <div ref={hostRef} className="diagram-primitive__mermaid" />
    {error ? <div className="diagram-primitive__error tech micro">DIAGRAM FAULT / {error}</div> : null}
  </div>;
}

function createLayers(nodes:DiagramNode[],edges:DiagramEdge[]):DiagramNode[][]{
  const incoming=new Map(nodes.map(node=>[node.id,0]));
  const outgoing=new Map(nodes.map(node=>[node.id,[] as string[]]));
  for(const edge of edges){incoming.set(edge.to,(incoming.get(edge.to)??0)+1);outgoing.get(edge.from)?.push(edge.to);}
  const roots=nodes.filter(node=>(incoming.get(node.id)??0)===0).map(node=>node.id);
  const depth=new Map<string,number>();
  const queue=roots.map(id=>({id,depth:0}));
  while(queue.length){const item=queue.shift();if(!item)break;if((depth.get(item.id)??-1)>=item.depth)continue;depth.set(item.id,item.depth);for(const child of outgoing.get(item.id)??[])queue.push({id:child,depth:item.depth+1});}
  for(const node of nodes)if(!depth.has(node.id))depth.set(node.id,0);
  const maxDepth=Math.max(0,...depth.values());
  return Array.from({length:maxDepth+1},(_,layer)=>nodes.filter(node=>depth.get(node.id)===layer));
}
function edgePath(from:PositionedNode,to:PositionedNode,portrait:boolean,nodeWidth:number,nodeHeight:number){
  if(portrait){const startY=from.y+nodeHeight/2,endY=to.y-nodeHeight/2,midY=(startY+endY)/2;return `M ${from.x} ${startY} V ${midY} H ${to.x} V ${endY}`;}
  const startX=from.x+nodeWidth/2,endX=to.x-nodeWidth/2,midX=(startX+endX)/2;return `M ${startX} ${from.y} H ${midX} V ${to.y} H ${endX}`;
}

function SemanticDiagram({data,focused}:{data:DiagramData;focused:boolean}){
  const hostRef=useRef<HTMLDivElement>(null);const size=useElementSize(hostRef);const portrait=size.height>size.width*1.05;const reduced=useReducedMotion();
  const viewBox=portrait?{width:700,height:1000}:{width:1000,height:620};const nodeWidth=portrait?244:182,nodeHeight=portrait?98:88;
  const layers=useMemo(()=>createLayers(data.nodes,data.edges),[data.nodes,data.edges]);
  const positioned=useMemo(()=>{const result:PositionedNode[]=[];const padMain=portrait?110:112;const mainSpan=(portrait?viewBox.height:viewBox.width)-padMain*2;const layerStep=layers.length<=1?0:mainSpan/(layers.length-1);layers.forEach((layerNodes,layerIndex)=>{const crossMax=portrait?viewBox.width:viewBox.height,crossPad=portrait?96:82,usable=crossMax-crossPad*2,step=layerNodes.length<=1?0:usable/(layerNodes.length-1);layerNodes.forEach((node,index)=>{const cross=layerNodes.length===1?crossMax/2:crossPad+index*step;result.push({...node,layer:layerIndex,indexInLayer:index,x:portrait?cross:padMain+layerIndex*layerStep,y:portrait?padMain+layerIndex*layerStep:cross});});});return result;},[layers,portrait,viewBox.height,viewBox.width]);
  const byId=new Map(positioned.map(node=>[node.id,node]));
  return <div ref={hostRef} className={`diagram-primitive${focused?' diagram-primitive--focused':''}`} data-testid="diagram"><svg viewBox={`0 0 ${viewBox.width} ${viewBox.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={data.title??'System diagram'}><defs><filter id="active-edge-glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g className="diagram-edges">{data.edges.map((edge,index)=>{const from=byId.get(edge.from),to=byId.get(edge.to);if(!from||!to)return null;const color=colors[edge.semantic??'paper'];const d=edgePath(from,to,portrait,nodeWidth,nodeHeight);return <g key={`${edge.from}-${edge.to}`}><motion.path d={d} fill="none" stroke={color} strokeOpacity={edge.active ? .85 : .48} strokeWidth={edge.active?2:1.25} strokeDasharray={edge.active?'10 8':undefined} vectorEffect="non-scaling-stroke" filter={edge.active?'url(#active-edge-glow)':undefined} initial={reduced?undefined:{pathLength:0,opacity:0}} animate={{pathLength:1,opacity:1,strokeDashoffset:edge.active?[0,-36]:0}} transition={{pathLength:{duration:.42,delay:index*.06},opacity:{duration:.2,delay:index*.06},strokeDashoffset:edge.active?{duration:2.2,ease:'linear',repeat:Infinity}:undefined}}/><circle cx={to.x} cy={portrait?to.y-nodeHeight/2:to.y} r="3" fill={color} opacity=".9"/></g>;})}</g><g className="diagram-nodes">{positioned.map((node,index)=>{const color=colors[node.semantic??'paper'];return <motion.g key={node.id} transform={`translate(${node.x-nodeWidth/2} ${node.y-nodeHeight/2})`} initial={reduced?undefined:{opacity:0,scale:.94}} animate={{opacity:1,scale:1}} transition={{duration:.28,delay:.12+index*.05}}><path d={`M 0 14 L 14 0 H ${nodeWidth-22} L ${nodeWidth} 22 V ${nodeHeight} H 18 L 0 ${nodeHeight-18} Z`} fill="#000" stroke={color} strokeOpacity=".64" strokeWidth="1.3" vectorEffect="non-scaling-stroke"/><line x1="16" y1="39" x2={nodeWidth-16} y2="39" stroke={color} strokeOpacity=".23" vectorEffect="non-scaling-stroke"/><text x="18" y="28" className="diagram-node-label" fill={color}>{node.label}</text><text x="18" y="58" className="diagram-node-sub">{node.sub}</text>{node.detail?<text x="18" y="76" className="diagram-node-detail">{node.detail}</text>:null}</motion.g>;})}</g></svg></div>;
}

export function DiagramPrimitive({data,focused=false}:{data:DiagramData;focused?:boolean}){
  return data.source
    ? <MermaidDiagram data={data} focused={focused}/>
    : <SemanticDiagram data={data} focused={focused}/>;
}
