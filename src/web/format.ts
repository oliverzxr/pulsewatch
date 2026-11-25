import type { Check, CheckError } from '../shared/contracts.ts';

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const number = new Intl.NumberFormat('pt-BR');
const ratio = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 });

export const format = {
  dateTime: (value: number) => dateTime.format(value),
  time: (value: number) => time.format(value),
  date: (value: number) => date.format(value),
  number: (value: number) => number.format(value),
  percent: (up: number, total: number) => total ? ratio.format(up / total) : '—',
  latency: (value: number | null | undefined) => value == null ? '—' : `${number.format(value)} ms`,
  duration: (ms: number) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  },
  interval: (ms: number) => {
    if (ms % 60000 === 0) {
      const minutes = ms / 60000;
      return `${number.format(minutes)} ${minutes === 1 ? 'minuto' : 'minutos'}`;
    }
    return `${number.format(ms / 1000)} segundos`;
  },
};

export function checkDetail(check: Check) {
  if (check.httpStatus !== null) return `HTTP ${check.httpStatus}`;
  const errors: Record<CheckError, string> = {
    http: 'Resposta HTTP inválida', timeout: 'Tempo limite excedido', dns: 'Domínio não resolvido',
    network: 'Falha na conexão ou no TLS', blocked: 'Destino bloqueado', redirect: 'Redirecionamento inválido',
  };
  return check.error ? errors[check.error] : '—';
}
