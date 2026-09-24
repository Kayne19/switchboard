import { motion, useReducedMotion } from 'motion/react';
import { useId, useMemo } from 'react';
import type { ChartData, ChartSeries, Semantic } from '../controller/types';

const semanticColor: Record<Semantic,string> = {
  red:'var(--red)',orange:'var(--orange)',green:'var(--green)',cyan:'var(--cyan)',amber:'var(--amber)',paper:'var(--paper)',muted:'var(--muted)'
};

const fallbackSeriesSemantics: Semantic[] = ['green', 'orange', 'cyan', 'amber', 'paper', 'muted'];

// The chart's viewBox is a fixed geometry that the annotation leader maps
// through, so the scene and the primitive share the constants instead of
// re-declaring them.
export const CHART_VIEW_WIDTH = 1000;
export const CHART_VIEW_HEIGHT = 500;

export function chartSeriesColor(series: ChartSeries, index: number): string {
  return semanticColor[series.semantic ?? fallbackSeriesSemantics[index % fallbackSeriesSemantics.length]];
}

function niceTicks(min:number,max:number,count=4){return Array.from({length:count},(_,i)=>max-((max-min)*i)/(count-1));}

export function ChartPrimitive({
  data,
  focused = false,
  annotation,
}: {
  data: ChartData;
  focused?: boolean;
  annotation?: { x?: number; series?: string; cardEdge?: { x: number; y: number } };
}) {
  const reduced = useReducedMotion();
  const clipId = useId().replace(/:/g,'');
  const width=CHART_VIEW_WIDTH,height=CHART_VIEW_HEIGHT,pad={left:74,right:28,top:34,bottom:54};
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

  const hasAnnotation = annotation?.x !== undefined;
  const pointerSeries = hasAnnotation
    ? (annotation.series ? data.series.find((series) => series.name === annotation.series) ?? data.series[0] : data.series[0])
    : undefined;
  // The pointer lands on the drawn line: x is held inside the chart's domain
  // (an out-of-range x points at the nearest end rather than off the plot),
  // and the value is interpolated between the samples either side of it, the
  // same straight segment the series path draws there.
  const pointerEpoch = hasAnnotation ? Math.min(xMax, Math.max(0, annotation.x!)) : 0;
  let pointerValue: number | undefined;
  if (pointerSeries && pointerSeries.values.length > 0 && xMax > 0) {
    const last = pointerSeries.values.length - 1;
    const position = (pointerEpoch / xMax) * last;
    const lower = Math.floor(position);
    const upper = Math.min(last, lower + 1);
    pointerValue = pointerSeries.values[lower] + (pointerSeries.values[upper] - pointerSeries.values[lower]) * (position - lower);
  }
  const pointerX = xAtEpoch(pointerEpoch);
  const pointerY = pointerValue != null ? Math.min(height - pad.bottom, Math.max(pad.top, yAt(pointerValue))) : undefined;
  // The annotation's leader starts at the note card's measured edge (viewBox
  // units, supplied by the scene) so the stem always leaves the card and
  // reaches the point; it is drawn outside the plot clip, so a card that
  // sits above the plot still meets its leader. Until the card is measured,
  // it starts at the plot top, never at the frame's outer border.
  const stemStartX = annotation?.cardEdge?.x ?? pointerX;
  const stemStartY = annotation?.cardEdge?.y ?? pad.top;
  // The pointer takes over the marker's point only when it lands on that
  // exact x and series; any other annotation leaves the marker circle up so
  // the progress point is never hidden behind the note's leader.
  const annotationOnMarker =
    hasAnnotation &&
    annotation.x === data.marker?.x &&
    pointerSeries != null &&
    pointerSeries.name === markerSeries?.name;

  return <div className={`chart-primitive${focused?' chart-primitive--focused':''}`} data-testid="chart">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={data.title ?? 'Chart'}>
      <defs><clipPath id={clipId}><rect x={pad.left} y={pad.top} width={width-pad.left-pad.right} height={height-pad.top-pad.bottom}/></clipPath></defs>
      <g className="chart-grid">
        {niceTicks(yMin,yMax).map(tick=><g key={tick}><line x1={pad.left} y1={yAt(tick)} x2={width-pad.right} y2={yAt(tick)}/><text x={pad.left-14} y={yAt(tick)+4} textAnchor="end">{tick.toFixed(2)}</text></g>)}
        {[0,.25,.5,.75,1].map(ratio=>{const x=pad.left+ratio*(width-pad.left-pad.right);return <g key={ratio}><line x1={x} y1={pad.top} x2={x} y2={height-pad.bottom}/><text x={x} y={height-20} textAnchor="middle">{Math.round(ratio*xMax)}</text></g>;})}
      </g>
      <g clipPath={`url(#${clipId})`}>
        {seriesPaths.map((series,index)=><motion.path className="chart-series" key={series.name} d={series.path} fill="none" stroke={chartSeriesColor(series, index)} strokeWidth={focused?3:2.3} vectorEffect="non-scaling-stroke" initial={reduced?undefined:{pathLength:0,opacity:0}} animate={{pathLength:1,opacity:1}} transition={{duration:.62,delay:index*.08,ease:[.22,.61,.36,1]}}/>)}
        {data.marker && markerValue != null ? (
          <motion.g initial={{opacity:0}} animate={{opacity:1}} transition={{delay:.42}}>
            <line x1={xAtEpoch(data.marker.x)} y1={pad.top} x2={xAtEpoch(data.marker.x)} y2={height-pad.bottom} stroke="rgba(var(--orange-rgb),.34)" strokeDasharray="6 8"/>
            {annotationOnMarker ? null : <circle className="chart-marker__point" cx={xAtEpoch(data.marker.x)} cy={yAt(markerValue)} r={focused?7:5} fill="#000" stroke="var(--orange)" strokeWidth="2"/>}
          </motion.g>
        ) : null}
      </g>
      {hasAnnotation && pointerY != null ? (
        <motion.g className="chart-pointer" initial={reduced ? undefined : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
          <line
            className="chart-pointer__stem"
            x1={stemStartX}
            y1={stemStartY}
            x2={pointerX}
            y2={pointerY}
            stroke="rgba(var(--orange-rgb), 0.75)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          <circle
            className="chart-pointer__marker"
            cx={pointerX}
            cy={pointerY}
            r={focused ? 7 : 5}
            fill="#000"
            stroke="var(--orange)"
            strokeWidth="2"
          />
        </motion.g>
      ) : null}
      <text className="chart-axis-label" x={width/2} y={height-2} textAnchor="middle">{data.xLabel ?? 'X'}</text>
      <text className="chart-axis-label" transform={`translate(17 ${height/2}) rotate(-90)`} textAnchor="middle">{data.yLabel ?? 'Y'}</text>
      <g className="chart-legend" transform={`translate(${pad.left+8} ${pad.top+12})`}>{data.series.map((series,index)=><g transform={`translate(${index*178} 0)`} key={series.name}><line className="chart-legend__key" x1="0" y1="0" x2="24" y2="0" stroke={chartSeriesColor(series, index)} strokeWidth="2"/><text x="34" y="4">{series.name}</text></g>)}</g>
    </svg>
  </div>;
}
