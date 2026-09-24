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

/**
 * Where the note card that annotates this chart sits, in the chart's viewBox
 * units, as the scene measured it: its left and right edges, its bottom edge,
 * and how many viewBox units one screen pixel spans at the chart's drawn size.
 */
export interface ChartNoteCard {
  left: number;
  right: number;
  bottom: number;
  unitsPerPx: number;
}

export function chartSeriesColor(series: ChartSeries, index: number): string {
  return semanticColor[series.semantic ?? fallbackSeriesSemantics[index % fallbackSeriesSemantics.length]];
}

function niceTicks(min:number,max:number,count=4){return Array.from({length:count},(_,i)=>max-((max-min)*i)/(count-1));}

// The x axis is labelled at round values of its domain -- steps of 1, 2, 2.5
// or 5 times a power of ten, at most five of them -- and each label is the
// value its gridline sits at. Evenly spaced quarters labelled with rounded
// values put "1" at 1.25 and "3" at 2.5 on a five-cycle chart, so the points
// read as falling between the cycles they belong to.
export function chartXTicks(xMax: number): number[] {
  if (!(xMax > 0) || !Number.isFinite(xMax)) return [0];
  const raw = xMax / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw * (1 - 1e-9)) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let index = 0; index * step <= xMax * (1 + 1e-9); index += 1) ticks.push(Number((index * step).toPrecision(12)));
  return ticks;
}

function formatXTick(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

// The leader tapers from the card to the point: this wide where it leaves the
// card and this wide where it meets the line, in screen pixels at any size.
const LEADER_CARD_WIDTH_PX = 2.4;
const LEADER_POINT_WIDTH_PX = 0.8;
// It leaves the card's bottom edge straight above the point wherever the card
// spans that x, and never closer than this to one of the card's corners.
const LEADER_CARD_INSET_PX = 14;

// The leader as a thin wedge in viewBox units, so its taper holds at every
// drawn size while its ends stay exactly on the card and the point.
function leaderPolygon(from: { x: number; y: number }, to: { x: number; y: number }, unitsPerPx: number): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const start = (LEADER_CARD_WIDTH_PX / 2) * unitsPerPx;
  const end = (LEADER_POINT_WIDTH_PX / 2) * unitsPerPx;
  return [
    [from.x + nx * start, from.y + ny * start],
    [to.x + nx * end, to.y + ny * end],
    [to.x - nx * end, to.y - ny * end],
    [from.x - nx * start, from.y - ny * start],
  ].map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

export function ChartPrimitive({
  data,
  focused = false,
  annotation,
}: {
  data: ChartData;
  focused?: boolean;
  annotation?: { x?: number; series?: string; card?: ChartNoteCard };
}) {
  const reduced = useReducedMotion();
  const clipId = useId().replace(/:/g,'');
  const width=CHART_VIEW_WIDTH,height=CHART_VIEW_HEIGHT,pad={left:74,right:28,top:34,bottom:54};
  const plotWidth=width-pad.left-pad.right;
  const yMin=data.yMin ?? Math.min(...data.series.flatMap(series=>series.values));
  const yMax=data.yMax ?? Math.max(...data.series.flatMap(series=>series.values));
  const maxCount=Math.max(2,...data.series.map(series=>series.values.length));
  const xMax=data.xMax ?? maxCount-1;
  // A chart with no positive x domain draws everything at its left edge.
  const xAtEpoch=(epoch:number)=>pad.left+(xMax>0?epoch/xMax:0)*plotWidth;
  const xAtIndex=(index:number,length:number)=>pad.left+(index/Math.max(1,length-1))*plotWidth;
  const yAt=(value:number)=>pad.top+(1-(value-yMin)/Math.max(.000001,yMax-yMin))*(height-pad.top-pad.bottom);
  const seriesPaths=useMemo(()=>data.series.map(series=>({...series,path:series.values.map((value,index)=>`${index===0?'M':'L'} ${xAtIndex(index,series.values.length).toFixed(2)} ${yAt(value).toFixed(2)}`).join(' ')})),[data.series,yMin,yMax]);
  const xTicks=chartXTicks(xMax);
  // The plot's right edge keeps its gridline even when no round value lands
  // on it, so the grid stays closed; it is labelled only when one does.
  const xGrid=xMax>0 && xTicks[xTicks.length-1]<xMax ? [...xTicks,xMax] : xTicks;
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
  // The leader leaves the note card's measured bottom edge (viewBox units,
  // supplied by the scene), straight above the point wherever the card spans
  // it, and ends on the point; it is drawn outside the plot clip, so a card
  // above the plot still meets it. Until the card is measured it starts at
  // the plot top, never at the frame's outer border.
  const card = annotation?.card;
  const unitsPerPx = card && card.unitsPerPx > 0 ? card.unitsPerPx : 1;
  const cardInset = card ? Math.min(LEADER_CARD_INSET_PX * unitsPerPx, Math.max(0, (card.right - card.left) / 2)) : 0;
  const stemStart = card
    ? { x: Math.min(card.right - cardInset, Math.max(card.left + cardInset, pointerX)), y: card.bottom }
    : { x: pointerX, y: pad.top };

  return <div className={`chart-primitive${focused?' chart-primitive--focused':''}`} data-testid="chart">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={data.title ?? 'Chart'}>
      <defs>
        <clipPath id={clipId}><rect x={pad.left} y={pad.top} width={plotWidth} height={height-pad.top-pad.bottom}/></clipPath>
        {/* Each trace resolves left to right behind a widening clip. The
            strokes are non-scaling, so a path-length trace -- whose dash
            pattern is measured in user space but laid in screen space --
            would stop short of the last point whenever the chart is drawn
            larger than its viewBox. */}
        {seriesPaths.map((series,index)=><clipPath key={series.name} id={`${clipId}-trace-${index}`}>
          <motion.rect x={0} y={0} height={height} width={width} initial={reduced?false:{width:pad.left}} animate={{width}} transition={{duration:.62,delay:index*.08,ease:[.22,.61,.36,1]}}/>
        </clipPath>)}
        {hasAnnotation && pointerY != null ? (
          <linearGradient id={`${clipId}-leader`} gradientUnits="userSpaceOnUse" x1={stemStart.x} y1={stemStart.y} x2={pointerX} y2={pointerY}>
            <stop offset="0" stopColor="var(--orange)" stopOpacity="0.78"/>
            <stop offset="1" stopColor="var(--orange)" stopOpacity="0.3"/>
          </linearGradient>
        ) : null}
      </defs>
      <g className="chart-grid">
        {niceTicks(yMin,yMax).map(tick=><g key={tick}><line x1={pad.left} y1={yAt(tick)} x2={width-pad.right} y2={yAt(tick)}/><text x={pad.left-14} y={yAt(tick)+4} textAnchor="end">{tick.toFixed(2)}</text></g>)}
        {xGrid.map(value=>{const x=xAtEpoch(value);return <g key={value}><line x1={x} y1={pad.top} x2={x} y2={height-pad.bottom}/>{xTicks.includes(value)?<text x={x} y={height-20} textAnchor="middle">{formatXTick(value)}</text>:null}</g>;})}
      </g>
      <g clipPath={`url(#${clipId})`}>
        {seriesPaths.map((series,index)=><g key={series.name} clipPath={`url(#${clipId}-trace-${index})`}><motion.path className="chart-series" d={series.path} fill="none" stroke={chartSeriesColor(series, index)} strokeWidth={focused?3:2.3} vectorEffect="non-scaling-stroke" initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{duration:.3,delay:index*.08}}/></g>)}
        {data.marker && markerValue != null ? (
          <motion.g initial={{opacity:0}} animate={{opacity:1}} transition={{delay:.42}}>
            <line x1={xAtEpoch(data.marker.x)} y1={pad.top} x2={xAtEpoch(data.marker.x)} y2={height-pad.bottom} stroke="rgba(var(--orange-rgb),.34)" strokeDasharray="6 8"/>
            <circle className="chart-marker__point" cx={xAtEpoch(data.marker.x)} cy={yAt(markerValue)} r={focused?7:5} fill="#000" stroke="var(--orange)" strokeWidth="2"/>
          </motion.g>
        ) : null}
      </g>
      {hasAnnotation && pointerY != null ? (
        <motion.g className="chart-pointer" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
          <polygon className="chart-pointer__leader" points={leaderPolygon(stemStart, { x: pointerX, y: pointerY }, unitsPerPx)} fill={`url(#${clipId}-leader)`}/>
        </motion.g>
      ) : null}
      <text className="chart-axis-label" x={width/2} y={height-2} textAnchor="middle">{data.xLabel ?? 'X'}</text>
      <text className="chart-axis-label" transform={`translate(17 ${height/2}) rotate(-90)`} textAnchor="middle">{data.yLabel ?? 'Y'}</text>
      <g className="chart-legend" transform={`translate(${pad.left+8} ${pad.top+12})`}>{data.series.map((series,index)=><g transform={`translate(${index*178} 0)`} key={series.name}><line className="chart-legend__key" x1="0" y1="0" x2="24" y2="0" stroke={chartSeriesColor(series, index)} strokeWidth="2"/><text x="34" y="4">{series.name}</text></g>)}</g>
    </svg>
  </div>;
}
