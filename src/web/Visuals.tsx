import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import type { ChartBucket, MonitorSummary, Period, Telemetry } from '../shared/contracts.ts';
import { format } from './format.ts';

export function Status({ status, checking = false }: { status?: 'up' | 'down'; checking?: boolean }) {
  return <span className={`status ${checking ? 'checking' : status ?? 'pending'}`}>
    <span className="status-dot" />
    {checking ? 'Verificando' : status === 'up' ? 'Disponível' : status === 'down' ? 'Indisponível' : 'Pendente'}
  </span>;
}

export function Metric({ label, value }: { label: string; value: ReactNode }) {
  return <div className="metric"><dt>{label}</dt><dd className="metric-value">{value}</dd></div>;
}

export function Metrics({ data, monitorCount }: {
  data?: Telemetry; monitorCount?: number;
}) {
  const metrics = data?.metrics;
  return <dl className="metrics" aria-label="Indicadores de monitoramento">
    <Metric label="Monitores ativos" value={monitorCount ?? '—'} />
    <Metric label="Disponibilidade"
      value={metrics ? format.percent(metrics.up, metrics.total) : '—'} />
    <Metric label="Latência média"
      value={metrics?.responseMs == null ? '—' : <>{format.number(metrics.responseMs)} <small>ms</small></>} />
    <Metric label="Verificações" value={metrics ? format.number(metrics.total) : '—'} />
  </dl>;
}

export function PeriodPicker({ period, onChange }: { period: Period; onChange: (period: Period) => void }) {
  return <div className="segmented" role="group" aria-label="Período das medições">
    {(['24h', '7d'] as const).map((item) => <button key={item} type="button" aria-pressed={period === item}
      onClick={() => onChange(item)}>{item === '24h' ? '24 horas' : '7 dias'}</button>)}
  </div>;
}

function drawLatency(canvas: HTMLCanvasElement, buckets: ChartBucket[], max: number) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const { clientWidth: width, clientHeight: height } = canvas;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.scale(ratio, ratio);
  const x = (index: number) => (index + 0.5) * width / buckets.length;
  const y = (value: number) => height - 3 - (height - 6) * value / max;
  const tokens = getComputedStyle(canvas);
  const accent = tokens.getPropertyValue('--accent').trim() || '#eb8da8';
  const fill = context.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, tokens.getPropertyValue('--chart-fill').trim() || '#be456731');
  fill.addColorStop(1, 'transparent');

  context.fillStyle = fill;
  let first = -1;
  for (let index = 0; index <= buckets.length; index += 1) {
    if (buckets[index]?.responseMs != null) {
      if (first < 0) first = index;
      continue;
    }
    if (first >= 0 && index - first > 1) {
      context.beginPath();
      context.moveTo(x(first), height);
      for (let point = first; point < index; point += 1) {
        context.lineTo(x(point), y(buckets[point].responseMs!));
      }
      context.lineTo(x(index - 1), height);
      context.closePath();
      context.fill();
    }
    first = -1;
  }

  context.beginPath();
  context.strokeStyle = accent;
  context.lineWidth = 1.65;
  context.lineJoin = 'round';
  let continuous = false;
  buckets.forEach((bucket, index) => {
    if (bucket.responseMs === null) { continuous = false; return; }
    if (continuous) context.lineTo(x(index), y(bucket.responseMs));
    else context.moveTo(x(index), y(bucket.responseMs));
    continuous = true;
  });
  context.stroke();
  context.fillStyle = accent;
  context.strokeStyle = tokens.getPropertyValue('--surface').trim();
  buckets.forEach((bucket, index) => {
    if (bucket.responseMs === null) return;
    context.beginPath();
    context.arc(x(index), y(bucket.responseMs), 3.6, 0, 2 * Math.PI);
    context.fill();
    context.stroke();
  });
}

function bucketLabel(start: number, period: Period) {
  const end = start + (period === '24h' ? 1 : 6) * 3600000;
  return `${format.dateTime(start)} até ${format.dateTime(end)}`;
}

export function LatencyChart({ data, period, loading, unavailable }: {
  data?: Telemetry; period: Period; loading: boolean; unavailable: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const targets = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [keyboardPoint, setKeyboardPoint] = useState<number | null>(null);
  const chartId = useId();
  const buckets = data?.buckets;
  const values = buckets?.flatMap(({ responseMs }) => responseMs === null ? [] : [responseMs]) ?? [];
  const highest = Math.max(0, ...values);
  const step = highest > 2000 ? 1000 : highest > 400 ? 250 : 50;
  const max = Math.max(step * 4, Math.ceil(highest / (step * 4)) * step * 4);
  const showData = values.length > 0;
  const end = data?.generatedAt ?? Date.now();
  const span = (period === '24h' ? 24 : 168) * 3600000;
  const point = active === null ? undefined : buckets?.[active];
  const pointIndices = buckets?.flatMap(({ responseMs }, index) => responseMs === null ? [] : [index]) ?? [];
  const tabStop = keyboardPoint !== null && pointIndices.includes(keyboardPoint) ? keyboardPoint : pointIndices[0];

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const current = pointIndices.indexOf(index);
    let next: number;
    switch (event.key) {
      case 'Home': next = 0; break;
      case 'End': next = pointIndices.length - 1; break;
      case 'ArrowLeft': next = Math.max(0, current - 1); break;
      case 'ArrowRight': next = Math.min(pointIndices.length - 1, current + 1); break;
      default: return;
    }
    event.preventDefault();
    targets.current?.querySelector<HTMLButtonElement>(`[data-point="${pointIndices[next]}"]`)?.focus();
  }

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element || !buckets) return;
    const redraw = () => drawLatency(element, buckets, max);
    const observer = new ResizeObserver(redraw);
    observer.observe(element);
    redraw();
    return () => observer.disconnect();
  }, [buckets, max]);

  return <article className="chart-panel" aria-busy={loading}>
    <div className="telemetry-heading">
      <div><h3 id={chartId}>Tempo de resposta</h3><p>Média das respostas HTTP {period === '24h' ? 'por hora' : 'a cada 6 horas'}</p></div>
      <span className="chart-unit" aria-label="milissegundos">ms</span>
    </div>
    <div className="chart-layout" role="group" aria-labelledby={chartId} aria-describedby={showData ? `${chartId}-keys` : undefined}>
      {showData && <p className="sr-only" id={`${chartId}-keys`}>Use as setas para navegar pelas medições.</p>}
      <div className="chart-y" aria-hidden="true">
        {[1, 0.75, 0.5, 0.25, 0].map((fraction) => <span key={fraction}>{showData ? format.number(fraction * max) : '—'}</span>)}
      </div>
      <div className="chart-plane" onPointerLeave={() => setActive(null)}>
        <canvas ref={canvas} aria-hidden="true" />
        {showData ? <div ref={targets} className="chart-targets" style={{ '--columns': buckets?.length } as CSSProperties}>
          {buckets?.map((bucket, index) => bucket.responseMs === null ? <span key={index} onPointerEnter={() => setActive(null)} /> :
            <button type="button" key={index} data-point={index} tabIndex={tabStop === index ? 0 : -1}
              className={active === index ? 'is-active' : undefined}
              onFocus={() => { setActive(index); setKeyboardPoint(index); }} onBlur={() => setActive(null)}
              onKeyDown={(event) => moveFocus(event, index)}
              onPointerEnter={() => setActive(index)} onClick={() => setActive(index)}
              aria-label={`${bucketLabel(bucket.start, period)}, latência média de ${format.latency(bucket.responseMs)}`} />)}
        </div> : <div className="chart-empty">
          <span className="chart-empty-icon"><ChartNoAxesCombined size={20} /></span>
          <strong>{loading ? 'Carregando medições' : unavailable ? 'Gráfico indisponível' : 'Sem medições no período'}</strong>
          {!loading && !unavailable && <span>O gráfico aparece quando houver respostas HTTP.</span>}
        </div>}
        {point?.responseMs != null && active !== null && buckets && <div className="chart-tooltip" aria-hidden="true"
          style={{ '--point-x': `${(active + 0.5) / buckets.length * 100}%` } as CSSProperties}>
          <strong>{format.latency(point.responseMs)}</strong><span>{format.dateTime(point.start)} – {format.time(point.start + span / buckets.length)}</span>
        </div>}
      </div>
      <div className="chart-x" aria-hidden="true">
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const value = end - span + fraction * span;
          return <span key={fraction}>{period === '24h' ? format.time(value) : format.date(value)}</span>;
        })}
      </div>
    </div>
    <AvailabilityStrip buckets={buckets} period={period} unavailable={unavailable} />
  </article>;
}

function bucketState({ total, up }: ChartBucket) {
  if (!total) return 'unmeasured';
  if (up === total) return 'available';
  return up ? 'mixed' : 'unavailable';
}

function AvailabilityStrip({ buckets, period, unavailable }: {
  buckets?: ChartBucket[]; period: Period; unavailable: boolean;
}) {
  const hasChecks = !!buckets?.some(({ total }) => total > 0);
  return <div className="availability">
    <div className="availability-heading"><h3>Disponibilidade por faixa</h3>
      <div className="strip-key" aria-hidden="true"><span><i className="available" /> Disponível</span>
        <span><i className="unavailable" /> Falhas</span><span><i className="mixed" /> Parcial</span><span><i className="unmeasured" /> Sem dados</span></div>
    </div>
    <div className="availability-track">
      {hasChecks ? <ol className="health-strip" aria-label="Disponibilidade ao longo do período">
        {buckets?.map((bucket) => {
          const label = `${bucketLabel(bucket.start, period)}, ${bucket.total ? `${bucket.up} de ${bucket.total} disponíveis` : 'sem verificações'}`;
          return <li key={bucket.start} className={bucketState(bucket)} title={label}><span className="sr-only">{label}</span></li>;
        })}
      </ol> : <div className="strip-empty">{buckets ? 'Sem verificações no período'
        : unavailable ? 'Dados do período indisponíveis' : 'Aguardando dados do período'}</div>}
    </div>
  </div>;
}

export function MonitorHealth({ monitors }: { monitors?: MonitorSummary[] }) {
  const total = monitors?.length ?? 0;
  const up = monitors?.filter(({ latest }) => latest?.status === 'up').length ?? 0;
  const down = monitors?.filter(({ latest }) => latest?.status === 'down').length ?? 0;
  const groups = [
    { status: 'up', label: 'Disponíveis', count: up },
    { status: 'down', label: 'Indisponíveis', count: down },
    { status: 'pending', label: 'Pendentes', count: total - up - down },
  ];
  return <aside className="health-panel" aria-labelledby="health-title">
    <div className="telemetry-heading"><div><h3 id="health-title">Estado dos monitores</h3><p>Último resultado por monitor</p></div></div>
    <div className="health-body">
      <div className="health-ratio" aria-hidden="true">
        {groups.filter(({ count }) => count > 0).map(({ status, count }) =>
          <span key={status} className={status} style={{ flexGrow: count }} />)}
      </div>
      <ul className="health-legend">
        {groups.map(({ status, label, count }) => <li key={status} className={status}>
          <span className="status-dot" aria-hidden="true" /><span>{label}</span><strong>{monitors ? count : '—'}</strong>
        </li>)}
      </ul>
    </div>
  </aside>;
}
