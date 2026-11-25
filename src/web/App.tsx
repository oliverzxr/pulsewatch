import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Activity, CircleCheck, Globe2, LogOut, Plus, Search, Trash2, X } from 'lucide-react';
import type { Monitor, MonitorSummary, Period, SessionUser } from '../shared/contracts.ts';
import type { DataSource } from './api.ts';
import { ErrorMessage } from './ErrorMessage.tsx';
import { checkDetail, format } from './format.ts';
import { LatencyChart, Metrics, MonitorHealth, PeriodPicker, Status } from './Visuals.tsx';
import { MonitorPage } from './MonitorPage.tsx';

export type MonitorDialog = { kind: 'create' } | { kind: 'remove'; monitor: Monitor };
type Account = { user: SessionUser; onLogout: () => Promise<void> };
interface Management extends Account {
  verifyMonitor: (id: number) => Promise<void>;
  renderDialog: (dialog: MonitorDialog, close: () => void, done: (message: string) => void) => ReactNode;
}
const subscribeRoute = (change: () => void) => {
  window.addEventListener('hashchange', change);
  return () => window.removeEventListener('hashchange', change);
};
const currentHash = () => window.location.hash.slice(1);

function AppHeader({ account }: { account?: Account }) {
  return <header className={account ? 'app-header' : 'app-header app-header-demo'}>
    <div className="app-header-inner workspace-frame">
      <a className="brand" href="#/" aria-label="PulseWatch, visão geral">
        <span className="brand-icon"><Activity size={18} strokeWidth={2} /></span>
        <span>PulseWatch</span>
      </a>
      {account ? <AccountControl {...account} /> : <div className="demo-context">
        <strong>Dados demonstrativos simulados</strong><span>Somente leitura</span>
      </div>}
    </div>
  </header>;
}

function AccountControl({ user, onLogout }: Account) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  async function logout() {
    setLoggingOut(true);
    setLogoutError('');
    try { await onLogout(); }
    catch { setLogoutError('Não foi possível sair da conta.'); }
    finally { setLoggingOut(false); }
  }

  return <div className="account-control">
    <div className="account-identity"><strong title={user.name}>{user.name}</strong><span title={user.email}>{user.email}</span></div>
    <button type="button" className="icon-button" aria-label="Sair da conta" title="Sair da conta" disabled={loggingOut} onClick={() => void logout()}>
      <LogOut size={16} />
    </button>
    {logoutError && <span role="alert" className="logout-error">{logoutError}</span>}
  </div>;
}

function Monitors({ monitors, error, onAdd, onRemove }: {
  monitors?: MonitorSummary[]; error: boolean; onAdd?: () => void; onRemove?: (monitor: Monitor) => void;
}) {
  const [search, setSearch] = useState('');
  const term = monitors?.length ? search.trim().toLocaleLowerCase('pt-BR') : '';
  const filtered = monitors?.filter(({ name, url }) => `${name} ${url}`.toLocaleLowerCase('pt-BR').includes(term));
  return <section className="panel monitor-panel" aria-labelledby="monitors-title">
    <div className="panel-heading">
      <div><h2 id="monitors-title">Monitores {monitors && <span className="monitor-count">{monitors.length}</span>}</h2>
      </div>
      {!!monitors?.length && <label className="monitor-search"><Search size={17} /><input type="search" aria-label="Buscar monitores"
        placeholder="Buscar monitores" value={search} onChange={(event) => setSearch(event.target.value)} /></label>}
    </div>
    {filtered?.length ? <table className={`monitor-table${onRemove ? '' : ' read-only-table'}`} role="table" aria-labelledby="monitors-title">
      <colgroup><col className="col-monitor" /><col className="col-status" /><col className="col-result" />
        <col className="col-latency" /><col className="col-time" />{onRemove && <col className="col-actions" />}</colgroup>
      <thead role="rowgroup"><tr role="row"><th scope="col">Monitor</th><th scope="col">Estado</th>
        <th scope="col">Resultado</th><th scope="col" className="align-number">Latência</th>
        <th scope="col">Última verificação</th>{onRemove && <th scope="col"><span className="sr-only">Ações</span></th>}</tr></thead>
      <tbody role="rowgroup">{filtered.map((monitor) => <tr key={monitor.id} className="monitor-row" role="row">
        <th className="row-monitor" scope="row" role="rowheader"><div className="monitor-identity">
          <Globe2 size={15} aria-hidden="true" /><div>
            <a className="monitor-name" href={`#/monitores/${monitor.id}`}>{monitor.name}</a>
            <span className="monitor-url" title={monitor.url}>{monitor.url}</span>
          </div>
        </div></th>
        <td className="row-status" role="cell"><Status status={monitor.latest?.status} checking={monitor.checking} /></td>
        <td className="row-result" role="cell"><span className={monitor.latest?.httpStatus != null ? 'result-code' : undefined}
          title={monitor.latest ? checkDetail(monitor.latest) : undefined}>{monitor.latest ? checkDetail(monitor.latest) : '—'}</span></td>
        <td className="row-latency align-number" role="cell">{format.latency(monitor.latest?.responseMs)}</td>
        <td className="row-time" role="cell">{monitor.latest ? <time dateTime={new Date(monitor.latest.checkedAt).toISOString()}>
          {format.dateTime(monitor.latest.checkedAt)}</time> : '—'}</td>
        {onRemove && <td role="cell" className="row-actions-cell"><div className="row-actions">
          <button type="button" className="icon-button delete-button" title="Remover monitor" aria-label={`Remover ${monitor.name}`} onClick={() => onRemove(monitor)}><Trash2 size={15} /></button>
        </div></td>}
      </tr>)}</tbody>
    </table> : <div className="monitors-empty">
      {!monitors ? <strong>{error ? 'Monitores indisponíveis' : 'Carregando monitores…'}</strong>
        : term ? <><strong>Nenhum monitor encontrado</strong><button type="button" className="text-button" onClick={() => setSearch('')}>Limpar busca</button></>
        : <><strong>Nenhum monitor cadastrado</strong>{onAdd && <><p>Adicione um endereço público para começar.</p>
          <button type="button" className="text-button" onClick={onAdd}><Plus size={16} /> Adicionar primeiro monitor</button></>}</>}
    </div>}
  </section>;
}

export function App({ source, account }: { source: DataSource; account?: Management }) {
  const readOnly = !account;
  const [period, setPeriod] = useState<Period>(readOnly ? '7d' : '24h');
  const [dialog, setDialog] = useState<MonitorDialog | null>(null);
  const [notice, setNotice] = useState('');
  const hash = useSyncExternalStore(subscribeRoute, currentHash);
  const detail = hash.startsWith('/monitores/');
  const monitorId = Number(/^\/monitores\/([1-9]\d*)$/.exec(hash)?.[1]);
  const { data, previous, error, refresh } = source.useDashboard(period, !detail);
  const dashboard = data ?? previous;
  const interval = !readOnly && dashboard ? format.interval(dashboard.intervalMs) : undefined;
  const main = useRef<HTMLElement>(null);
  const route = detail ? hash : '';
  const previousRoute = useRef(route);
  useEffect(() => {
    if (previousRoute.current !== route) {
      main.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      previousRoute.current = route;
    }
  }, [route]);
  const add = () => { setNotice(''); setDialog({ kind: 'create' }); };
  const close = () => setDialog(null);

  function done(message: string) {
    close();
    refresh();
    setNotice(message);
  }

  return <>
    <button type="button" className="skip-control" onClick={() => main.current?.focus()}>Ir ao conteúdo</button>
    <AppHeader account={account} />
    <main ref={main} className="workspace workspace-frame" tabIndex={-1}>
      {detail ? (Number.isSafeInteger(monitorId)
        ? <MonitorPage key={monitorId} id={monitorId} source={source} period={period} onPeriodChange={setPeriod}
          verifyMonitor={account?.verifyMonitor} />
        : <section className="detail-missing"><h1>Monitor não encontrado</h1><a href="#/">Voltar à visão geral</a></section>)
        : <>
        <header className="workspace-header">
          <h1>Visão geral</h1>
          {account && <button type="button" className="button primary add-monitor" onClick={add}><Plus size={16} /> Adicionar monitor</button>}
        </header>
        {error && <ErrorMessage message={error} retry={refresh} />}
        <Metrics data={data} monitorCount={dashboard?.monitors.length} />
        <section className="performance" aria-labelledby="performance-title">
          <div className="panel-heading performance-heading"><h2 id="performance-title">Desempenho</h2>
            <PeriodPicker period={period} onChange={setPeriod} /></div>
          <div className="telemetry">
            <LatencyChart key={period} data={data} period={period} loading={!data && !error} unavailable={!!error && !data} />
            <MonitorHealth monitors={dashboard?.monitors} />
          </div>
        </section>
        <Monitors monitors={dashboard?.monitors} error={Boolean(error)} onAdd={account && add}
          onRemove={account && ((monitor) => setDialog({ kind: 'remove', monitor }))} />
        {dashboard && <footer className="dashboard-meta">
          {interval && <span>Verificação a cada {interval}</span>}
          <p>{readOnly ? 'Fim do período simulado em ' : 'Dados consultados às '}
            <time dateTime={new Date(dashboard.generatedAt).toISOString()}>
              {readOnly ? format.dateTime(dashboard.generatedAt) : format.time(dashboard.generatedAt)}
            </time>
          </p>
        </footer>}
      </>}
    </main>
    {dialog && account?.renderDialog(dialog, close, done)}
    {notice && <div className="toast" role="status"><CircleCheck size={19} /><span>{notice}</span>
      <button type="button" className="icon-button" aria-label="Dispensar mensagem" onClick={() => setNotice('')}><X size={17} /></button></div>}
  </>;
}
