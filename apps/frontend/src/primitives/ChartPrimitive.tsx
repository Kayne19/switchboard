import { motion, useReducedMotion } from 'motion/react';
import { useId, useMemo } from 'react';
import type { ChartData, ChartSeries, Semantic } from '../controller/types';
import {
  CHART_LEGEND_KEY_WIDTH,
  CHART_LEGEND_ROW_HEIGHT,
  CHART_LEGEND_TEXT_X,
  CHART_PAD,
  CHART_VIEW_HEIGHT,
  CHART_VIEW_WIDTH,
  chartLegendLayout,
  chartPad,
  chartScales,
  chartSeriesPoint,
  chartTraces,
} from './chartGeometry';

const semanticColor: Record<Semantic,string> = {
  red:'var(--red)',orange:'var(--orange)',green:'var(--green)',cyan:'var(--cyan)',amber:'var(--amber)',paper:'var(--paper)',muted:'var(--muted)'
};

const fallbackSeriesSemantics: Semantic[] = ['green', 'orange', 'cyan', 'amber', 'paper', 'muted'];

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

export function ChartPrimitive({
  data,
  focused = false,
}: {
  data: ChartData;
  focused?: boolean;
}) {
  const reduced = useReducedMotion();
  const clipId = useId().replace(/:/g,'');
  const width=CHART_VIEW_WIDTH,height=CHART_VIEW_HEIGHT;
  // The legend can wrap onto further rows than a one-row chart needs, so the
  // plot's own top padding grows to clear it; `CHART_PAD` (below, for the
  // legend's own anchor) never does -- its rows grow downward from there
  // instead, and the padding grows to keep the last of them off the plot.
  const pad=chartPad(data);
  const plotWidth=width-pad.left-pad.right;
  const scales=chartScales(data);
  const {yMin,yMax,xMax,xAtEpoch,yAt}=scales;
  const legend=useMemo(()=>chartLegendLayout(data,plotWidth),[data,plotWidth]);
  const seriesPaths=useMemo(()=>{
    const traces=chartTraces(data);
    return data.series.map((series,index)=>({...series,path:traces[index].map((point,pointIndex)=>`${pointIndex===0?'M':'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')}));
  },[data]);
  const xTicks=chartXTicks(xMax);
  // The plot's right edge keeps its gridline even when no round value lands
  // on it, so the grid stays closed; it is labelled only when one does.
  const xGrid=xMax>0 && xTicks[xTicks.length-1]<xMax ? [...xTicks,xMax] : xTicks;
  // A marker is a ring on the point it names, on the drawn line itself: the
  // same interpolated point a note's leader reaches. It draws no guide of its
  // own -- a full-height dashed rule read as a stray line through the plot,
  // and ran on past the point beneath any leader that met it there.
  const markerPoint=data.marker ? chartSeriesPoint(data,data.marker.x,data.marker.series,scales) : undefined;

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
      </defs>
      <g className="chart-grid">
        {niceTicks(yMin,yMax).map(tick=><g key={tick}><line x1={pad.left} y1={yAt(tick)} x2={width-pad.right} y2={yAt(tick)}/><text x={pad.left-14} y={yAt(tick)+4} textAnchor="end">{tick.toFixed(2)}</text></g>)}
        {xGrid.map(value=>{const x=xAtEpoch(value);return <g key={value}><line x1={x} y1={pad.top} x2={x} y2={height-pad.bottom}/>{xTicks.includes(value)?<text x={x} y={height-20} textAnchor="middle">{formatXTick(value)}</text>:null}</g>;})}
      </g>
      <g clipPath={`url(#${clipId})`}>
        {seriesPaths.map((series,index)=><g key={series.name} clipPath={`url(#${clipId}-trace-${index})`}><motion.path className="chart-series" d={series.path} fill="none" stroke={chartSeriesColor(series, index)} strokeWidth={focused?3:2.3} vectorEffect="non-scaling-stroke" initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{duration:.3,delay:index*.08}}/></g>)}
        {markerPoint ? (
          <motion.g className="chart-marker" initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{delay:.42}}>
            <circle className="chart-marker__point" cx={markerPoint.x} cy={markerPoint.y} r={focused?7:5} fill="#000" stroke="var(--orange)" strokeWidth="2"/>
          </motion.g>
        ) : null}
      </g>
      <text className="chart-axis-label" x={width/2} y={height-2} textAnchor="middle">{data.xLabel ?? 'X'}</text>
      <text className="chart-axis-label" transform={`translate(17 ${height/2}) rotate(-90)`} textAnchor="middle">{data.yLabel ?? 'Y'}</text>
      {/* Rows grow downward from the one-row anchor (`CHART_PAD`, not the
          possibly-grown `pad`): `chartPad` already grew the plot's own top
          padding to keep the last row clear of it. */}
      <g className="chart-legend" transform={`translate(${CHART_PAD.left+8} ${CHART_PAD.top+12})`}>{legend.items.map((item,index)=><g transform={`translate(${item.x} ${item.row*CHART_LEGEND_ROW_HEIGHT})`} key={item.name}><line className="chart-legend__key" x1="0" y1="0" x2={CHART_LEGEND_KEY_WIDTH} y2="0" stroke={chartSeriesColor(data.series[index], index)} strokeWidth="2"/><text x={CHART_LEGEND_TEXT_X} y="4">{item.text}</text>{item.truncated?<title>{item.name}</title>:null}</g>)}</g>
    </svg>
  </div>;
}
