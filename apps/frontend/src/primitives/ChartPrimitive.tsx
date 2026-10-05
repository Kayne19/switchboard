import { motion, useReducedMotion } from 'motion/react';
import { useId, useMemo } from 'react';
import type { ChartData, ChartKind, ChartSeries, Semantic } from '../controller/types';
import {
  CHART_LEGEND_KEY_WIDTH,
  CHART_LEGEND_ROW_HEIGHT,
  CHART_LEGEND_TEXT_X,
  CHART_MARKER_RADIUS,
  CHART_MARKER_STROKE,
  CHART_PAD,
  CHART_POINT_RADIUS,
  CHART_TICK_BASELINE,
  CHART_TICK_ROW_HEIGHT,
  CHART_VIEW_HEIGHT,
  CHART_VIEW_WIDTH,
  chartBars,
  chartCategoryLabelX,
  chartClip,
  chartLegendLayout,
  chartScales,
  chartSeriesPoint,
  type ChartScales,
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

// A tick computed down from the top of the domain can land a rounding
// error below zero, which would print as "-0.00".
function formatValueTick(value: number): string {
  return (Math.abs(value) < 1e-9 ? 0 : value).toFixed(2);
}

const point = (p: { x: number; y: number }) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;

function linePath(points: Array<{ x: number; y: number }>): string {
  return points.map((p, index) => `${index === 0 ? 'M' : 'L'} ${point(p)}`).join(' ');
}

// The line's path closed down to the baseline and back, for the fill.
function areaPath(points: Array<{ x: number; y: number }>, baseY: number): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)} L ${last.x.toFixed(2)} ${baseY.toFixed(2)} L ${first.x.toFixed(2)} ${baseY.toFixed(2)} Z`;
}

// The legend's key for a series: the stroke of a line chart, the fill of a
// bar or an area, the dot of a scatter chart.
function LegendKey({ kind, color }: { kind: ChartKind; color: string }) {
  if (kind === 'line') return <line className="chart-legend__key" x1="0" y1="0" x2={CHART_LEGEND_KEY_WIDTH} y2="0" stroke={color} strokeWidth="2"/>;
  if (kind === 'scatter') return <circle className="chart-legend__key" cx={CHART_LEGEND_KEY_WIDTH / 2} cy="0" r={CHART_POINT_RADIUS} fill={color}/>;
  return <rect className="chart-legend__key" x="0" y="-4" width={CHART_LEGEND_KEY_WIDTH} height="8" fill={color} fillOpacity={kind === 'area' ? 0.5 : 1}/>;
}

// The gridlines and tick labels along the category (or numeric x) axis and
// the value axis, whichever way the chart runs.
function Grid({ scales }: { scales: ChartScales }) {
  const { plot, categories, horizontal, yMin, yMax, xMax, xAt, valueAt, kind } = scales;
  const valueTicks = niceTicks(yMin, yMax);
  const categorical = categories.categories !== undefined;
  // Category gridlines belong to a line through the categories; bars stand
  // in their bands with no line between them.
  const categoryLines = categorical && kind !== 'bar';
  if (horizontal) {
    return <g className="chart-grid" data-axis="horizontal">
      {valueTicks.map((tick, index) => {
        const x = valueAt(tick);
        return <g key={index}><line x1={x} y1={plot.top} x2={x} y2={plot.bottom}/><text x={x} y={plot.bottom + CHART_TICK_BASELINE} textAnchor="middle">{formatValueTick(tick)}</text></g>;
      })}
      <line x1={plot.left} y1={plot.top} x2={plot.right} y2={plot.top}/>
      <line x1={plot.left} y1={plot.bottom} x2={plot.right} y2={plot.bottom}/>
      {categories.ticks.map((tick) => <text key={tick.index} className="chart-grid__category" x={plot.left - 14} y={xAt(tick.index) + 4} textAnchor="end">{tick.text}{tick.truncated ? <title>{categories.categories![tick.index]}</title> : null}</text>)}
    </g>;
  }
  const xTicks = categorical ? [] : chartXTicks(xMax);
  // The plot's right edge keeps its gridline even when no round value lands
  // on it, so the grid stays closed; it is labelled only when one does. A
  // categorical axis closes the grid at both edges and labels neither.
  const xGrid = categorical ? [] : xMax > 0 && xTicks[xTicks.length - 1] < xMax ? [...xTicks, xMax] : xTicks;
  return <g className="chart-grid">
    {valueTicks.map((tick, index) => {
      const y = valueAt(tick);
      return <g key={index}><line x1={plot.left} y1={y} x2={plot.right} y2={y}/><text x={plot.left - 14} y={y + 4} textAnchor="end">{formatValueTick(tick)}</text></g>;
    })}
    {xGrid.map((value) => {
      const x = xAt(value);
      return <g key={value}><line x1={x} y1={plot.top} x2={x} y2={plot.bottom}/>{xTicks.includes(value) ? <text x={x} y={plot.bottom + CHART_TICK_BASELINE} textAnchor="middle">{formatXTick(value)}</text> : null}</g>;
    })}
    {categorical ? <>
      <line x1={plot.left} y1={plot.top} x2={plot.left} y2={plot.bottom}/>
      <line x1={plot.right} y1={plot.top} x2={plot.right} y2={plot.bottom}/>
    </> : null}
    {categories.ticks.map((tick) => {
      const x = xAt(tick.index);
      return <g key={tick.index}>
        {categoryLines ? <line x1={x} y1={plot.top} x2={x} y2={plot.bottom}/> : null}
        <text className="chart-grid__category" x={chartCategoryLabelX(x, tick.text)} y={plot.bottom + CHART_TICK_BASELINE + tick.row * CHART_TICK_ROW_HEIGHT} textAnchor="middle">{tick.text}</text>
      </g>;
    })}
  </g>;
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
  const scales=useMemo(()=>chartScales(data),[data]);
  const {plot,kind,horizontal,baseline,valueAt}=scales;
  // The plot's own padding grows to clear a legend that wraps, a second
  // row of category labels, and a horizontal bar chart's labels down the
  // left; the legend's own anchor (`CHART_PAD.top`) never does -- its rows
  // grow downward from there instead.
  const plotWidth=plot.right-plot.left;
  const legend=useMemo(()=>chartLegendLayout(data,plotWidth),[data,plotWidth]);
  const drawn=useMemo(()=>{
    const bars=chartBars(data,scales);
    const baseY=valueAt(baseline);
    return data.series.map((series,index)=>{
      const points=series.values.map((value,sample)=>scales.pointAt(scales.sampleX(series,sample),value));
      return {...series,points,path:linePath(points),area:areaPath(points,baseY),bars:bars.filter((bar)=>bar.series===index)};
    });
  },[data,scales,baseline,valueAt]);
  // A marker is a ring on the point it names, on the drawn series itself:
  // the same interpolated point a note's leader reaches. It draws no guide
  // of its own -- a full-height dashed rule read as a stray line through
  // the plot, and ran on past the point beneath any leader that met it
  // there.
  const markerPoint=data.marker ? chartSeriesPoint(data,data.marker.x,data.marker.series,scales) : undefined;
  const grounded=kind==='bar'||kind==='area';
  const base=valueAt(baseline);
  const clip=chartClip(scales);

  return <div className={`chart-primitive${focused?' chart-primitive--focused':''}`} data-testid="chart" data-kind={kind} data-orientation={horizontal?'horizontal':'upright'}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={data.title ?? 'Chart'}>
      <defs>
        {/* A scatter chart's points at the ends of its domain sit on the
            plot's edges, so its clip lets a point's radius through. */}
        <clipPath id={clipId}><rect x={clip.left} y={clip.top} width={clip.right-clip.left} height={clip.bottom-clip.top}/></clipPath>
        {/* Each series resolves left to right behind a widening clip: a
            line draws itself, bars and points appear in order, and a
            horizontal bar is revealed along its length. The strokes are
            non-scaling, so a path-length trace -- whose dash pattern is
            measured in user space but laid in screen space -- would stop
            short of the last point whenever the chart is drawn larger than
            its viewBox. */}
        {drawn.map((series,index)=><clipPath key={series.name} id={`${clipId}-trace-${index}`}>
          <motion.rect x={0} y={0} height={height} width={width} initial={reduced?false:{width:plot.left}} animate={{width}} transition={{duration:.62,delay:index*.08,ease:[.22,.61,.36,1]}}/>
        </clipPath>)}
      </defs>
      <Grid scales={scales}/>
      <g clipPath={`url(#${clipId})`}>
        {grounded ? (horizontal
          ? <line className="chart-baseline" x1={base} y1={plot.top} x2={base} y2={plot.bottom}/>
          : <line className="chart-baseline" x1={plot.left} y1={base} x2={plot.right} y2={base}/>) : null}
        {drawn.map((series,index)=>{
          const color=chartSeriesColor(series,index);
          return <motion.g key={series.name} className="chart-series-group" data-series={series.name} clipPath={`url(#${clipId}-trace-${index})`} initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{duration:.3,delay:index*.08}}>
            {kind==='area' ? <path className="chart-area" d={series.area} fill={color} fillOpacity={0.16} stroke="none"/> : null}
            {kind==='line'||kind==='area' ? <path className="chart-series" d={series.path} fill="none" stroke={color} strokeWidth={focused?3:2.3} vectorEffect="non-scaling-stroke"/> : null}
            {kind==='scatter' ? series.points.map((p,sample)=><circle key={sample} className="chart-point" cx={p.x} cy={p.y} r={focused?CHART_POINT_RADIUS+1:CHART_POINT_RADIUS} fill={color}/>) : null}
            {kind==='bar' ? series.bars.map((bar)=><rect key={bar.index} className="chart-bar" x={bar.rect.left} y={bar.rect.top} width={Math.max(0.5,bar.rect.right-bar.rect.left)} height={Math.max(0.5,bar.rect.bottom-bar.rect.top)} fill={color}/>) : null}
          </motion.g>;
        })}
        {markerPoint ? (
          <motion.g className="chart-marker" initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{delay:.42}}>
            <circle className="chart-marker__point" cx={markerPoint.x} cy={markerPoint.y} r={focused?CHART_MARKER_RADIUS+2:CHART_MARKER_RADIUS} fill="#000" stroke="var(--orange)" strokeWidth={CHART_MARKER_STROKE}/>
          </motion.g>
        ) : null}
      </g>
      {/* The axis names follow their axes: a horizontal bar chart's
          categories run down the left and its values along the bottom. */}
      <text className="chart-axis-label" x={width/2} y={height-2} textAnchor="middle">{(horizontal ? data.yLabel : data.xLabel) ?? (horizontal ? 'Y' : 'X')}</text>
      <text className="chart-axis-label" transform={`translate(17 ${height/2}) rotate(-90)`} textAnchor="middle">{(horizontal ? data.xLabel : data.yLabel) ?? (horizontal ? 'X' : 'Y')}</text>
      {/* Rows grow downward from the one-row anchor (`CHART_PAD.top`, not
          the possibly-grown plot top): `chartPad` already grew the plot's
          own top padding to keep the last row clear of it. */}
      <g className="chart-legend" transform={`translate(${plot.left+8} ${CHART_PAD.top+12})`}>{legend.items.map((item,index)=><g transform={`translate(${item.x} ${item.row*CHART_LEGEND_ROW_HEIGHT})`} key={item.name}><LegendKey kind={kind} color={chartSeriesColor(data.series[index], index)}/><text x={CHART_LEGEND_TEXT_X} y="4">{item.text}</text>{item.truncated?<title>{item.name}</title>:null}</g>)}</g>
    </svg>
  </div>;
}
