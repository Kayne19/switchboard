import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useId, useMemo, useRef } from 'react';
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
  chartBarCallouts,
  chartBars,
  chartCategoryLabelX,
  chartClip,
  chartFrame,
  chartLeastHeight,
  chartLegendLayout,
  chartRings,
  chartScales,
  chartScrollHeight,
  type ChartAnchor,
  type ChartScales,
} from './chartGeometry';
import { SEMANTIC_COLOR } from '../design/tokens';
import { useElementSize } from '../hooks/useElementSize';
import { useLeastHeight } from '../hooks/useStageDemand';
import { ListViewport } from './ListViewport';
import type { Slot } from './slot';

const fallbackSeriesSemantics: Semantic[] = ['green', 'orange', 'cyan', 'amber', 'paper', 'muted'];

export function chartSeriesColor(series: ChartSeries, index: number): string {
  return SEMANTIC_COLOR[series.semantic ?? fallbackSeriesSemantics[index % fallbackSeriesSemantics.length]];
}

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

// A value tick is printed with its step's decimals. A tick computed down
// from the top of the domain can land a rounding error below zero, which
// would print as "-0.00".
function formatValueTick(value: number, decimals: number): string {
  return (Math.abs(value) < 1e-9 ? 0 : value).toFixed(decimals);
}

// The value gridlines: one per tick, and the domain's ends too, so the grid
// stays closed where an end the chart gives falls between round values.
function valueGridLines(scales: ChartScales): Array<{ value: number; tick: boolean }> {
  const { valueTicks, yMin, yMax } = scales;
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(yMax - yMin) * 1e-9;
  const ends = [yMax, yMin].filter((end) => !valueTicks.some((tick) => near(tick, end)));
  return [...valueTicks.map((value) => ({ value, tick: true })), ...ends.map((value) => ({ value, tick: false }))];
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
  const { plot, categories, horizontal, xMax, xAt, valueAt, kind, valueDecimals, frame } = scales;
  const valueLines = valueGridLines(scales);
  const categorical = categories.categories !== undefined;
  // Category gridlines belong to a line through the categories; bars stand
  // in their bands with no line between them.
  const categoryLines = categorical && kind !== 'bar';
  if (horizontal) {
    return <g className="chart-grid" data-axis="horizontal">
      {valueLines.map(({ value, tick }, index) => {
        const x = valueAt(value);
        return <g key={index}><line x1={x} y1={plot.top} x2={x} y2={plot.bottom}/>{tick ? <text x={x} y={plot.bottom + CHART_TICK_BASELINE} textAnchor="middle">{formatValueTick(value, valueDecimals)}</text> : null}</g>;
      })}
      <line x1={plot.left} y1={plot.top} x2={plot.right} y2={plot.top}/>
      <line x1={plot.left} y1={plot.bottom} x2={plot.right} y2={plot.bottom}/>
      {categories.ticks.map((tick) => {
        // A wrapped label's lines are centred on its row.
        const top = xAt(tick.index) + 4 - ((tick.lines.length - 1) * CHART_TICK_ROW_HEIGHT) / 2;
        return <text key={tick.index} className="chart-grid__category" data-item={tick.index} x={plot.left - 14} y={top} textAnchor="end">
          {tick.lines.length > 1 ? tick.lines.map((line, index) => <tspan key={index} x={plot.left - 14} y={top + index * CHART_TICK_ROW_HEIGHT}>{line}</tspan>) : tick.text}
          {tick.truncated || tick.lines.length > 1 ? <title>{categories.categories![tick.index]}</title> : null}
        </text>;
      })}
    </g>;
  }
  const xTicks = categorical ? [] : chartXTicks(xMax);
  // The plot's right edge keeps its gridline even when no round value lands
  // on it, so the grid stays closed; it is labelled only when one does. A
  // categorical axis closes the grid at both edges and labels neither.
  const xGrid = categorical ? [] : xMax > 0 && xTicks[xTicks.length - 1] < xMax ? [...xTicks, xMax] : xTicks;
  return <g className="chart-grid">
    {valueLines.map(({ value, tick }, index) => {
      const y = valueAt(value);
      return <g key={index}><line x1={plot.left} y1={y} x2={plot.right} y2={y}/>{tick ? <text x={plot.left - 14} y={y + 4} textAnchor="end">{formatValueTick(value, valueDecimals)}</text> : null}</g>;
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
        <text className="chart-grid__category" x={chartCategoryLabelX(x, tick.text, frame.width)} y={plot.bottom + CHART_TICK_BASELINE + tick.row * CHART_TICK_ROW_HEIGHT} textAnchor="middle">{tick.text}</text>
      </g>;
    })}
  </g>;
}

export function ChartPrimitive({
  data,
  slot = 'primary',
  named,
  led,
}: {
  data: ChartData;
  /** Where the chart is drawn: in focus its lines are heavier. */
  slot?: Slot;
  /**
   * The points the notes on this chart name: a bar chart marks each one's
   * bar as it marks its marker's; a line, area or scatter chart rings each
   * one no leader on it reaches (`led`).
   */
  named?: ChartAnchor[];
  /**
   * Of those, the points a note laid over the chart runs its leader to:
   * the leader marks such a point on a line, area or scatter chart, so the
   * chart rings only the others (their notes in the rail, the band, a focus
   * panel). None where not given: no note is laid over the chart.
   */
  led?: ChartAnchor[];
}) {
  const reduced = useReducedMotion();
  const clipId = useId().replace(/:/g,'');
  // The frame is the slot's to decide: the approved canvas where it reads,
  // else one of the slot's own shape (`chartFrame`).
  const hostRef = useRef<HTMLDivElement>(null);
  const box = useElementSize(hostRef);
  // A bar chart whose categories want a row each asks for the height.
  useLeastHeight(hostRef, useCallback((box: { width: number }) => chartLeastHeight(data, box.width), [data]));
  // A bar chart too long for its slot on its side, in a slot taller than
  // it is wide, is drawn at its least height in a canvas that scrolls in
  // the slot (`chartScrollHeight`); its frame is the canvas's, as the notes
  // laid over it read it.
  const scroll = useMemo(() => chartScrollHeight(data, box), [data, box]);
  const fit = chartFrame(scroll === null ? box : { width: box.width, height: scroll });
  const width = fit.width, height = fit.height;
  const scales=useMemo(()=>chartScales(data,{width,height}),[data,width,height]);
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
  // there. A point a note names that no leader on the chart reaches keeps
  // a ring too, hollow, so the data under it still shows (`chartRings`).
  // A bar is marked as a bar: outlined, its value printed past its end
  // (`chartBarCallouts`), not a ring on its edge.
  // Kept while what the notes name is the same: the scene builds new arrays
  // of it every render, so the memos read `named` and `led` through a key.
  const anchorsKey=(anchors?:ChartAnchor[])=>(anchors??[]).map((anchor)=>`${anchor.x}\u0000${anchor.series??''}`).join('\u0001');
  const namedKey=anchorsKey(named);
  const ledKey=anchorsKey(led);
  const callouts=useMemo(()=>chartBarCallouts(data,named,scales),[data,namedKey,scales]);
  const rings=useMemo(()=>chartRings(data,named??[],led??[],scales),[data,namedKey,ledKey,scales]);
  const grounded=kind==='bar'||kind==='area';
  const base=valueAt(baseline);
  const clip=chartClip(scales);

  const svg = (
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
            {kind==='line'||kind==='area' ? <path className="chart-series" d={series.path} fill="none" stroke={color} strokeWidth={slot==='focus'?3:2.3} vectorEffect="non-scaling-stroke"/> : null}
            {kind==='scatter' ? series.points.map((p,sample)=><circle key={sample} className="chart-point" cx={p.x} cy={p.y} r={CHART_POINT_RADIUS} fill={color}/>) : null}
            {kind==='bar' ? series.bars.map((bar)=><rect key={bar.index} className="chart-bar" x={bar.rect.left} y={bar.rect.top} width={Math.max(0.5,bar.rect.right-bar.rect.left)} height={Math.max(0.5,bar.rect.bottom-bar.rect.top)} fill={color}/>) : null}
          </motion.g>;
        })}
      </g>
      {/* The rings are drawn whole, past the plot's edge where a point sits
          on it. The marker's hides the line under it, but rings a scatter's
          point, which it stands round. They and the points keep their radius
          in focus: the notes' clearances are worked out from it, and focus
          draws the whole chart larger already. */}
      {rings.marker ? (
        <motion.g className="chart-marker" initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{delay:.42}}>
          <circle className="chart-marker__point" cx={rings.marker.x} cy={rings.marker.y} r={CHART_MARKER_RADIUS} fill={kind==='scatter'?'none':'#000'} stroke="var(--orange)" strokeWidth={CHART_MARKER_STROKE}/>
        </motion.g>
      ) : null}
      {rings.named.map((point)=>(
        <motion.circle key={`${point.x},${point.y}`} className="chart-note-ring" cx={point.x} cy={point.y} r={CHART_MARKER_RADIUS} strokeWidth={CHART_MARKER_STROKE} initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{delay:.42}}/>
      ))}
      {/* A marked bar's printed value may stand past the plot's edge, so
          only its outline is cut to the plot, as the bar is. */}
      {callouts.map((callout)=>{
        const {rect}=callout.bar;
        return <motion.g key={`${callout.bar.series}-${callout.bar.index}`} className="chart-callout" data-series={data.series[callout.bar.series]?.name} data-index={callout.bar.index} initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{delay:.42}}>
          <rect className="chart-callout__outline" clipPath={`url(#${clipId})`} x={rect.left} y={rect.top} width={Math.max(0.5,rect.right-rect.left)} height={Math.max(0.5,rect.bottom-rect.top)}/>
          <text className={`chart-callout__value${callout.value.inside?' chart-callout__value--inside':''}`} x={callout.value.x} y={callout.value.y} textAnchor={callout.value.anchor}>{callout.value.text}</text>
        </motion.g>;
      })}
      {/* The axis names follow their axes: a horizontal bar chart's
          categories run down the left and its values along the bottom. */}
      <text className="chart-axis-label" x={width/2} y={height-2} textAnchor="middle">{(horizontal ? data.yLabel : data.xLabel) ?? (horizontal ? 'Y' : 'X')}</text>
      <text className="chart-axis-label" transform={`translate(17 ${height/2}) rotate(-90)`} textAnchor="middle">{(horizontal ? data.xLabel : data.yLabel) ?? (horizontal ? 'X' : 'Y')}</text>
      {/* Rows grow downward from the one-row anchor (`CHART_PAD.top`, not
          the possibly-grown plot top): `chartPad` already grew the plot's
          own top padding to keep the last row clear of it. */}
      <g className="chart-legend" transform={`translate(${plot.left+8} ${CHART_PAD.top+12})`}>{legend.items.map((item,index)=><g transform={`translate(${item.x} ${item.row*CHART_LEGEND_ROW_HEIGHT})`} key={item.name}><LegendKey kind={kind} color={chartSeriesColor(data.series[index], index)}/><text x={CHART_LEGEND_TEXT_X} y="4">{item.text}</text>{item.truncated?<title>{item.name}</title>:null}</g>)}</g>
    </svg>
  );
  // The category a note names, or the marker's, is the row it opens on.
  const lead = [...(named ?? []), ...(data.marker ? [data.marker] : [])][0];
  const drawnScale = box.width / width;
  return <div ref={hostRef} className={`chart-primitive${slot==='focus'?' chart-primitive--focused':''}${scroll===null?'':' chart-primitive--scrolls'}`} data-testid="chart" data-kind={kind} data-orientation={horizontal?'horizontal':'upright'}>
    {scroll===null ? svg : (
      // Scrolled, it reads as a list does: the rows past each edge counted
      // there, a tap turning a page; its value axis pinned over the rows.
      <ListViewport
        noun={data.series.length > 1 ? ['GROUP', 'GROUPS'] : ['BAR', 'BARS']}
        countSelector=".chart-grid__category"
        lead={lead ? String(Math.round(lead.x)) : undefined}
        head={<ValueAxisHead scales={scales} width={width} scale={drawnScale}/>}
        least={null}
        className="chart-primitive__viewport"
        scrollClassName="chart-primitive__scroll"
        label={`${data.title ?? 'Chart'}: rows`}
      >
        <div className="chart-primitive__canvas" style={{ height: `${scroll}px` }}>{svg}</div>
      </ListViewport>
    )}
  </div>;
}

// The value axis's labels over a scrolled chart's rows, where its own run
// along the foot of its last: the same values at the same places, the
// strip drawn at the chart's scale across the same width, as deep as the
// band a chart keeps over its legend (clear of the panel's corner).
const AXIS_HEAD_UNITS = CHART_PAD.top;
function ValueAxisHead({ scales, width, scale }: { scales: ChartScales; width: number; scale: number }) {
  return <svg className="chart-primitive__axis" viewBox={`0 0 ${width} ${AXIS_HEAD_UNITS}`} style={{ height: `${AXIS_HEAD_UNITS * scale}px` }} aria-hidden="true">
    <g className="chart-grid">
      {scales.valueTicks.map((value) => <text key={value} x={scales.valueAt(value)} y={AXIS_HEAD_UNITS - 8} textAnchor="middle">{formatValueTick(value, scales.valueDecimals)}</text>)}
    </g>
  </svg>;
}
