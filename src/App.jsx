import { useEffect, useRef, useState } from 'react';
import { Chart, registerables } from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import 'hammerjs';
import {
  useConfig,
  useEditorPanelConfig,
  useElementData,
  useElementColumns,
} from '@sigmacomputing/plugin';

Chart.register(...registerables, zoomPlugin, ChartDataLabels);

const DEFAULT_COLOR    = '#3c79c8';
const DEFAULT_FONTSIZE = '11';
const DEFAULT_MAXCHARS = '30';
const DEFAULT_TICKAREA = '120';
const DEFAULT_GRAD_LOW = '#c8dff8';

// ── Date helpers ──────────────────────────────────────────────────────────────
function toJsDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') {
    const ms = v < 1e10 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  return null;
}

function toCivilDate(v) {
  const d = toJsDate(v);
  if (!d) return null;
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60 * 1000);
}

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC',
});

function formatCivil(v) {
  const d = toCivilDate(v);
  return d ? DATE_FMT.format(d) : String(v);
}

// ── Color helpers ─────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = (hex || '').trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (full.length !== 6) return [0, 100, 200];
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function lerpColor(lowHex, highHex, t) {
  const [lr, lg, lb] = hexToRgb(lowHex);
  const [hr, hg, hb] = hexToRgb(highHex);
  return `rgb(${Math.round(lr + t * (hr - lr))},${Math.round(lg + t * (hg - lg))},${Math.round(lb + t * (hb - lb))})`;
}

function dimColor(color) {
  if (!color) return 'rgba(0,0,0,0.15)';
  if (color.startsWith('#')) return color + '33';
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', ',0.2)');
  return color;
}

// ── Number formatters ─────────────────────────────────────────────────────────
function makeFormatter(fmt) {
  switch ((fmt || '').toLowerCase().trim()) {
    case 'compact':  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
    case 'currency': return new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
    case 'percent':  return new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 });
    default:         return new Intl.NumberFormat('en');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const canvasRef   = useRef(null);
  const chartRef    = useRef(null);
  const colorsRef   = useRef([]);    // per-bar bg colours for selection dimming
  const zoomStateRef = useRef(null); // preserves zoom range across re-renders
  const [selInfo, setSelInfo] = useState('');

  // ── Editor panel fields ───────────────────────────────────────────────────
  useEditorPanelConfig([
    { name: 'source',        type: 'element' },
    { name: 'dimensionCol',  type: 'column',  source: 'source', allowedTypes: ['text', 'datetime'] },
    { name: 'measureCol',    type: 'column',  source: 'source', allowedTypes: ['number', 'integer'] },
    { name: 'barColor',      type: 'text',    defaultValue: DEFAULT_COLOR },
    { name: 'labelFontSize', type: 'text',    defaultValue: DEFAULT_FONTSIZE },
    { name: 'labelMaxChars', type: 'text',    defaultValue: DEFAULT_MAXCHARS },
    { name: 'tickAreaPx',    type: 'text',    defaultValue: DEFAULT_TICKAREA },
    { name: 'numberFormat',  type: 'text',    defaultValue: 'default' },
    { name: 'showLabels',    type: 'toggle' },
    { name: 'horizontal',    type: 'toggle' },
    { name: 'gradientMode',  type: 'toggle' },
    { name: 'gradientLow',   type: 'text',    defaultValue: DEFAULT_GRAD_LOW },
  ]);

  // ── Read config ───────────────────────────────────────────────────────────
  const config   = useConfig();
  const sourceId = config?.source;
  const dimId    = config?.dimensionCol;
  const mesId    = config?.measureCol;

  const barColor      = config?.barColor      || DEFAULT_COLOR;
  const labelFontSize = Math.max(6, Math.min(24, parseInt(config?.labelFontSize) || 11));
  const labelMaxChars = Math.max(4, parseInt(config?.labelMaxChars) || 30);
  const tickAreaPx    = Math.max(40, Math.min(400, parseInt(config?.tickAreaPx) || 120));
  const numberFormat  = config?.numberFormat  || 'default';
  const showLabels    = Boolean(config?.showLabels);
  const isHorizontal  = Boolean(config?.horizontal);
  const gradientMode  = Boolean(config?.gradientMode);
  const gradientLow   = config?.gradientLow   || DEFAULT_GRAD_LOW;

  // ── Fetch data ────────────────────────────────────────────────────────────
  const data = useElementData(sourceId);
  const cols = useElementColumns(sourceId);

  const dimIsDate   = cols?.[dimId]?.columnType === 'datetime';
  const labels      = (data?.[dimId] ?? []).map(v => dimIsDate ? formatCivil(v) : String(v));
  const values      = (data?.[mesId] ?? []).map(v => Number(v));
  const measureName = cols?.[mesId]?.name ?? 'Value';

  // ── Build chart ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current || labels.length === 0) return;

    const isDark  = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const axisCol = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
    const gridCol = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';

    // Per-bar background colours
    const min   = Math.min(...values);
    const max   = Math.max(...values);
    const range = max - min || 1;

    const bgColors = values.map(v => {
      if (gradientMode) {
        const t = (v - min) / range;
        return lerpColor(gradientLow, barColor, t);
      }
      return barColor + 'cc';
    });
    colorsRef.current = bgColors;

    const fmt      = makeFormatter(numberFormat);
    const zoomAxis = isHorizontal ? 'y' : 'x';

    const truncateTick = function(val) {
      const label = this.getLabelForValue(val);
      return typeof label === 'string' && label.length > labelMaxChars
        ? label.slice(0, labelMaxChars - 1) + '…'
        : label;
    };

    const categoryAxis = {
      ticks: {
        color:           axisCol,
        font:            { size: labelFontSize },
        maxRotation:     isHorizontal ? 0 : 90,
        minRotation:     isHorizontal ? 0 : 90,
        autoSkip:        true,
        autoSkipPadding: 4,
        callback:        truncateTick,
      },
      grid: { color: gridCol },
      afterFit(scale) {
        if (isHorizontal) scale.width  = tickAreaPx;
        else              scale.height = tickAreaPx;
      },
    };

    const valueAxis = {
      beginAtZero: true,
      ticks: {
        color:    axisCol,
        font:     { size: 11 },
        callback: v => fmt.format(v),
      },
      grid: { color: gridCol },
    };

    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label:           measureName,
          data:            values,
          backgroundColor: [...bgColors],
          borderColor:     values.map(() => barColor),
          borderWidth:     1,
          borderRadius:    3,
        }],
      },
      options: {
        indexAxis:           isHorizontal ? 'y' : 'x',
        responsive:          true,
        maintainAspectRatio: false,
        animation:           { duration: 200 },

        onClick(_evt, elements) {
          if (!elements.length) return;
          const idx = elements[0].index;
          chartRef.current.data.datasets[0].backgroundColor = colorsRef.current.map((c, i) =>
            i === idx ? c : dimColor(c)
          );
          chartRef.current.data.datasets[0].borderColor = values.map(() => barColor);
          chartRef.current.update('none');
          setSelInfo(`${labels[idx]}  ·  ${fmt.format(values[idx])}`);
        },

        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${fmt.format(ctx.parsed[isHorizontal ? 'x' : 'y'])}`,
            },
          },
          zoom: {
            pan:    { enabled: true, mode: zoomAxis },
            zoom:   { wheel: { enabled: true }, pinch: { enabled: true }, mode: zoomAxis },
            limits: { [zoomAxis]: { minRange: 3 } },
          },
          datalabels: {
            display:   showLabels,
            anchor:    'end',
            align:     'end',
            clip:      false,
            formatter: v => fmt.format(v),
            font:      { size: Math.max(8, labelFontSize - 1) },
            color:     axisCol,
          },
        },

        scales: isHorizontal
          ? { y: categoryAxis, x: valueAxis }
          : { x: categoryAxis, y: valueAxis },
      },
    });

    // Restore zoom from previous render (if same axis orientation)
    const saved = zoomStateRef.current;
    if (saved && saved.axis === zoomAxis && saved.min !== undefined) {
      chartRef.current.zoomScale(saved.axis, { min: saved.min, max: saved.max }, 'none');
    }

    return () => {
      // Save zoom state before destroying so the next render can restore it
      if (chartRef.current) {
        const scale = chartRef.current.scales[zoomAxis];
        zoomStateRef.current = scale ? { min: scale.min, max: scale.max, axis: zoomAxis } : null;
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [labels, values, barColor, measureName, labelFontSize, labelMaxChars, tickAreaPx,
      numberFormat, showLabels, isHorizontal, gradientMode, gradientLow]);

  // ── Zoom / reset ──────────────────────────────────────────────────────────
  const handleZoomIn  = () => chartRef.current?.zoom(1.4);
  const handleZoomOut = () => chartRef.current?.zoom(0.7);
  const handleReset   = () => {
    chartRef.current?.resetZoom();
    if (chartRef.current) {
      chartRef.current.data.datasets[0].backgroundColor = [...colorsRef.current];
      chartRef.current.data.datasets[0].borderColor     = values.map(() => barColor);
      chartRef.current.update('none');
    }
    setSelInfo('');
  };

  if (!dimId || !mesId) {
    return (
      <div style={placeholderStyle}>
        Open the editor panel and select a dimension and measure column.
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '12px', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: '#888' }}>
          Scroll or pinch to zoom · Drag to pan · Click bar to select
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleZoomIn}  style={btnStyle}>Zoom +</button>
          <button onClick={handleZoomOut} style={btnStyle}>Zoom −</button>
          <button onClick={handleReset}   style={btnStyle}>Reset</button>
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1 }}>
        <canvas ref={canvasRef} />
      </div>

      {selInfo && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>{selInfo}</div>
      )}
    </div>
  );
}

const btnStyle = {
  fontSize: 12,
  padding: '3px 10px',
  border: '0.5px solid #ccc',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
};

const placeholderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100vh',
  fontSize: 13,
  color: '#999',
  textAlign: 'center',
  padding: 24,
};
