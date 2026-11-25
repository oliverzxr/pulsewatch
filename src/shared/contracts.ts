export type CheckError = 'http' | 'timeout' | 'dns' | 'network' | 'blocked' | 'redirect';

export interface SessionUser { id: string; name: string; email: string }

export interface BrowserSession { user: SessionUser | null; registrationEnabled: boolean }

export interface CheckResult {
  status: 'up' | 'down';
  httpStatus: number | null;
  responseMs: number | null;
  error: CheckError | null;
  checkedAt: number;
}

export interface Check extends CheckResult {
  id: number;
}

export interface Monitor {
  id: number;
  name: string;
  url: string;
  createdAt: number;
}

export interface MonitorSummary extends Monitor {
  latest: Check | null;
  checking: boolean;
}

export interface ChartBucket {
  start: number;
  total: number;
  up: number;
  responseMs: number | null;
}

export type Period = '24h' | '7d';

export interface Telemetry {
  generatedAt: number;
  metrics: { total: number; up: number; responseMs: number | null };
  buckets: ChartBucket[];
}

export interface DashboardData extends Telemetry {
  monitors: MonitorSummary[];
  intervalMs: number;
}

export interface Incident {
  startedAt: number;
  recoveredAt: number | null;
}

export interface MonitorDetails extends Telemetry {
  monitor: MonitorSummary;
  intervalMs: number;
  checks: Check[];
  incidents: Incident[];
}
