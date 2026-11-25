import { useState } from 'react';
import { ArrowLeft, RotateCw } from 'lucide-react';
import type { Check, Incident, Period } from '../shared/contracts.ts';
import type { DataSource } from './api.ts';
import { ErrorMessage } from './ErrorMessage.tsx';
import { checkDetail, format } from './format.ts';
import { LatencyChart, Metric, PeriodPicker, Status } from './Visuals.tsx';

function DateTime({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()}>{format.dateTime(value)}</time>;
}

function IncidentHistory({ incidents, now }: { incidents: Incident[]; now: number }) {
  return <section className="panel detail-panel" aria-labelledby="incidents-title">
    <div className="panel-heading"><div><h2 id="incidents-title">Incidentes</h2>
      <p>Da primeira falha registrada até a primeira resposta disponível.</p></div></div>
    {incidents.length ? <div className="history-scroll" tabIndex={0} role="region" aria-label="Lista de incidentes">
      <table className="history-table">
        <thead><tr><th scope="col">Início</th><th scope="col">Duração</th><th scope="col">Recuperação</th></tr></thead>
        <tbody>{incidents.map((incident, index) => <tr key={`${incident.startedAt}-${index}`}>
          <td><DateTime value={incident.startedAt} /></td>
          <td>{format.duration((incident.recoveredAt ?? now) - incident.startedAt)}</td>
          <td>{incident.recoveredAt !== null ? <DateTime value={incident.recoveredAt} /> : <span className="incident-open">Em andamento</span>}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className="history-empty">Nenhum incidente registrado no período.</p>}
  </section>;
}

function CheckHistory({ checks }: { checks: Check[] }) {
  return <section className="panel detail-panel" aria-labelledby="checks-title">
    <div className="panel-heading"><div><h2 id="checks-title">Histórico de verificações</h2><p>Até 100 resultados recentes</p></div></div>
    {checks.length ? <div className="history-scroll" tabIndex={0} role="region" aria-label="Lista de verificações">
      <table className="history-table">
        <thead><tr><th scope="col">Data e hora</th><th scope="col">Estado</th><th scope="col">Resultado</th><th scope="col">Latência</th></tr></thead>
        <tbody>{checks.map((entry) => <tr key={entry.id}><td><DateTime value={entry.checkedAt} /></td>
          <td><Status status={entry.status} /></td><td>{checkDetail(entry)}</td><td>{format.latency(entry.responseMs)}</td></tr>)}</tbody>
      </table>
    </div> : <p className="history-empty">Aguardando a primeira verificação.</p>}
  </section>;
}

export function MonitorPage({ id, source, period, onPeriodChange, verifyMonitor }: {
  id: number; source: DataSource; period: Period; onPeriodChange: (period: Period) => void;
  verifyMonitor?: (id: number) => Promise<void>;
}) {
  const { data, previous, error, refresh } = source.useMonitor(id, period);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState('');
  const current = data ?? (!error ? previous : undefined);
  const monitor = current?.monitor;
  const metrics = data?.metrics;

  async function verify(run: (id: number) => Promise<void>) {
    setStarting(true);
    setActionError('');
    try {
      await run(id);
      refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return <div className="monitor-detail">
    <a className="text-button detail-back" href="#/"><ArrowLeft size={16} /> Voltar à visão geral</a>
    <header className="detail-header">
      <div className="detail-identity"><h1>{monitor?.name ?? 'Detalhes do monitor'}</h1>
        {monitor && <p className="detail-url">{monitor.url}</p>}</div>
      {monitor && <div className="detail-actions">
        <Status status={monitor.latest?.status} checking={monitor.checking || starting} />
        {verifyMonitor && <button className="button secondary" type="button" disabled={starting || monitor.checking} onClick={() => void verify(verifyMonitor)}>
          <RotateCw size={16} />{starting || monitor.checking ? 'Verificando…' : 'Verificar agora'}
        </button>}
      </div>}
    </header>
    {current && <dl className="detail-meta">
      <div><dt>Criado em</dt><dd><DateTime value={current.monitor.createdAt} /></dd></div>
      <div><dt>Última verificação</dt><dd>{current.monitor.latest ? <DateTime value={current.monitor.latest.checkedAt} /> : '—'}</dd></div>
      <div><dt>Intervalo</dt><dd>{format.interval(current.intervalMs)}</dd></div>
    </dl>}
    {error && <ErrorMessage message={error} retry={refresh} />}
    {actionError && <ErrorMessage message={actionError} />}
    {!monitor && !error && <p className="history-empty" role="status">Carregando monitor…</p>}
    {monitor && <section aria-labelledby="monitor-telemetry">
      <div className="panel-heading performance-heading"><h2 id="monitor-telemetry">Desempenho</h2>
        <PeriodPicker period={period} onChange={onPeriodChange} /></div>
      <dl className="metrics detail-metrics" aria-label="Indicadores do monitor">
        <Metric label="Disponibilidade" value={metrics ? format.percent(metrics.up, metrics.total) : '—'} />
        <Metric label="Latência média" value={format.latency(metrics?.responseMs)} />
        <Metric label="Verificações" value={metrics ? format.number(metrics.total) : '—'} />
        <Metric label="Incidentes" value={data ? format.number(data.incidents.length) : '—'} />
      </dl>
      <LatencyChart key={period} data={data} period={period} loading={!data && !error} unavailable={Boolean(error && !data)} />
    </section>}
    {data && <><IncidentHistory incidents={data.incidents} now={data.generatedAt} /><CheckHistory checks={data.checks} /></>}
  </div>;
}
