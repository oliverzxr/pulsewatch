import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import { App } from '../src/web/App.tsx';
import type { DataSource } from '../src/web/api.ts';
import '../src/web/styles.css';
import { demoDashboard, demoMonitor } from './fixtures.ts';

const refresh = () => {};
const source: DataSource = {
  useDashboard: (period, enabled) => {
    const data = useMemo(() => enabled ? demoDashboard(period) : undefined, [period, enabled]);
    return { data, error: '', refresh };
  },
  useMonitor: (id, period) => {
    const data = useMemo(() => demoMonitor(id, period), [id, period]);
    return { data, error: data ? '' : 'Monitor demonstrativo não encontrado.', refresh };
  },
};

createRoot(document.getElementById('root')!).render(<StrictMode><App source={source} /></StrictMode>);
