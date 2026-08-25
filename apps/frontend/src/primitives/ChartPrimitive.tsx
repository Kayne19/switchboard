import { motion, useReducedMotion } from 'motion/react';
import { useId, useMemo } from 'react';
import type { ChartData, Semantic } from '../controller/types';

const semanticColor: Record<Semantic,string> = {
  red:'var(--red)',orange:'var(--orange)',green:'var(--green)',cyan:'var(--cyan)',amber:'var(--amber)',paper:'var(--paper)',muted:'var(--muted)'
};

function niceTicks(min:number,max:number,count=4){return Array.from({length:count},(_,i)=>max-((max-min)*i)/(count-1));}

export function ChartPrimitive({ data, focused = false }: { data: ChartData; focused?: boolean }) {
  const reduced = useReducedMotion();
  const clipId = useId().replace(/:/g,'');
  const width=1000,height=500,pad={left:74,right:28,top:34,bottom:54};
  const yMin=data.yMin ?? Math.min(...data.series.flatMap(series=>series.values));
  const yMax=data.yMax ?? Math.max(...data.series.flatMap(series=>series.values));
  const maxCount=Math.max(2,...data.series.map(series=>series.values.length));
  const xMax=data.xMax ?? maxCount-1;
  const xAtEpoch=(epoch:number)=>pad.left+(epoch/xMax)*(width-pad.left-pad.right);
  const xAtIndex=(index:number,length:number)=>pad.left+(index/Math.max(1,length-1))*(width-pad.left-pad.right);
  const yAt=(value:number)=>pad.top+(1-(value-yMin)/Math.max(.000001,yMax-yMin))*(height-pad.top-pad.bottom);
  const seriesPaths=useMemo(()=>data.series.map(series=>({...series,path:series.values.map((value,index)=>`${index===0?'M':'L'} ${xAtIndex(index,series.values.length).toFixed(2)} ${yAt(value).toFixed(2)}`).join(' ')})),[data.series,yMin,yMax]);
  const markerSeries=data.marker ? data.series.find(series=>series.name===data.marker?.series) ?? data.series[0] : undefined;
  const markerIndex=data.marker && markerSeries ? Math.round((data.marker.x/xMax)*Math.max(0,markerSeries.values.length-1)) : 0;
  const markerValue=markerSeries?.values[Math.min((markerSeries?.values.length ?? 1)-1,markerIndex)];

  return <div className={`chart-primitive${focused?' chart-primitive--focused':''}`} data-testid="chart">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={data.title ?? 'Chart'}>
      <defs><clipPath id={clipId}><rect x={pad.left} y={pad.top} width={width-pad.left-pad.right} height={height-pad.top-pad.bottom}/></clipPath></defs>
      <g className="chart-grid">
        {niceTicks(yMin,yMax).map(tick=><g key={tick}><line x1={pad.left} y1={yAt(tick)} x2={width-pad.right} y2={yAt(tick)}/><text x={pad.left-14} y={yAt(tick)+4} textAnchor="end">{tick.toFixed(2)}</text></g>)}
        {[0,.25,.5,.75,1].map(ratio=>{const x=pad.left+ratio*(width-pad.left-pad.right);return <g key={ratio}><line x1={x} y1={pad.top} x2={x} y2={height-pad.bottom}/><text x={x} y={height-20} textAnchor="middle">{Math.round(ratio*xMax)}</text></g>;})}
      </g>
      <g clipPath={`url(#${clipId})`}>
        {seriesPaths.map((series,index)=><motion.path key={series.name} d={series.path} fill="none" stroke={semanticColor[series.semantic ?? (index===0?'green':'orange')]} strokeWidth={focused?3:2.3} vectorEffect="non-scaling-stroke" initial={reduced?undefined:{pathLength:0,opacity:0}} animate={{pathLength:1,opacity:1}} transition={{duration:.62,delay:index*.08,ease:[.22,.61,.36,1]}}/>)}
        {data.marker && markerValue != null ? <motion.g initial={{opacity:0}} animate={{opacity:1}} transition={{delay:.42}}><line x1={xAtEpoch(data.marker.x)} y1={pad.top} x2={xAtEpoch(data.marker.x)} y2={height-pad.bottom} stroke="rgba(var(--orange-rgb),.34)" strokeDasharray="6 8"/><circle cx={xAtEpoch(data.marker.x)} cy={yAt(markerValue)} r={focused?7:5} fill="#000" stroke="var(--orange)" strokeWidth="2"/></motion.g> : null}
      </g>
      <text className="chart-axis-label" x={width/2} y={height-2} textAnchor="middle">{data.xLabel ?? 'X'}</text>
      <text className="chart-axis-label" transform={`translate(17 ${height/2}) rotate(-90)`} textAnchor="middle">{data.yLabel ?? 'Y'}</text>
      <g className="chart-legend" transform={`translate(${pad.left+8} ${pad.top+12})`}>{data.series.map((series,index)=><g transform={`translate(${index*178} 0)`} key={series.name}><line x1="0" y1="0" x2="24" y2="0" stroke={semanticColor[series.semantic ?? 'paper']} strokeWidth="2"/><text x="34" y="4">{series.name}</text></g>)}</g>
    </svg>
  </div>;
}
