import type { DatabaseSync } from 'node:sqlite';
import type { Check, CheckResult, Monitor, MonitorDetails, MonitorSummary, Period, Telemetry } from '../shared/contracts.ts';
import { groupIncidents, periodWindow, summarize } from '../shared/telemetry.ts';
import type { BucketTotals } from '../shared/telemetry.ts';

export interface MonitorStore {
  add(ownerId: string, name: string, url: string, createdAt: number, limit: number): Monitor | 'duplicate' | 'limit';
  get(ownerId: string, id: number): Monitor | undefined;
  remove(ownerId: string, id: number): boolean;
  list(ownerId: string): Omit<MonitorSummary, 'checking'>[];
  due(before: number, limit: number): Monitor[];
  record(id: number, result: CheckResult): void;
  history(ownerId: string, id: number): Check[];
  snapshot(ownerId: string, period: Period, now: number): Telemetry;
  details(ownerId: string, id: number, period: Period, now: number): Pick<MonitorDetails, 'checks' | 'incidents'> & Telemetry;
}

const checkColumns = `c.id, status, http_status AS httpStatus, response_ms AS responseMs,
  error, checked_at AS checkedAt`;
const monitorColumns = 'id, name, url, created_at AS createdAt';

export function openStore(db: DatabaseSync): MonitorStore {
  const add = db.prepare(`INSERT INTO monitors (owner_id, name, url, created_at)
    SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM monitors WHERE owner_id = ?) < ?
    ON CONFLICT(owner_id, url) DO NOTHING RETURNING ${monitorColumns}`);
  const duplicate = db.prepare('SELECT 1 FROM monitors WHERE owner_id = ? AND url = ?');
  const get = db.prepare(`SELECT ${monitorColumns} FROM monitors WHERE owner_id = ? AND id = ?`);
  const remove = db.prepare('DELETE FROM monitors WHERE owner_id = ? AND id = ?');
  const list = db.prepare(`SELECT m.id, m.name, m.url, m.created_at AS createdAt,
    c.id AS checkId, c.status, c.http_status AS httpStatus, c.response_ms AS responseMs,
    c.error, c.checked_at AS checkedAt
    FROM monitors m LEFT JOIN checks c ON c.id = (
      SELECT id FROM checks WHERE monitor_id = m.id ORDER BY checked_at DESC, id DESC LIMIT 1
    ) WHERE m.owner_id = ? ORDER BY m.created_at DESC, m.id DESC`);
  const due = db.prepare(`SELECT ${monitorColumns} FROM monitors
    WHERE NOT EXISTS (SELECT 1 FROM checks WHERE monitor_id = monitors.id AND checked_at > ?)
    ORDER BY COALESCE((SELECT checked_at FROM checks WHERE monitor_id = monitors.id
      ORDER BY checked_at DESC LIMIT 1), 0), id LIMIT ?`);
  const record = db.prepare(`INSERT INTO checks (monitor_id, status, http_status, response_ms, error, checked_at)
    SELECT id, ?, ?, ?, ?, ? FROM monitors WHERE id = ?`);
  const history = db.prepare(`SELECT ${checkColumns} FROM checks c JOIN monitors m ON m.id = c.monitor_id
    WHERE m.owner_id = ? AND c.monitor_id = ? ORDER BY c.checked_at DESC, c.id DESC LIMIT 100`);
  const bucketQuery = `SELECT CAST((checked_at - ?) / ? AS INTEGER) AS bucket, COUNT(*) AS total,
    SUM(status = 'up') AS up, COUNT(response_ms) AS measured, COALESCE(SUM(response_ms), 0) AS responseSum
    FROM checks c JOIN monitors m ON m.id = c.monitor_id
    WHERE m.owner_id = ? AND checked_at >= ? AND checked_at < ?`;
  const buckets = db.prepare(`${bucketQuery} GROUP BY bucket`);
  const monitorBuckets = db.prepare(`${bucketQuery} AND c.monitor_id = ? GROUP BY bucket`);
  const monitorChecks = `FROM checks c JOIN monitors m ON m.id = c.monitor_id WHERE m.owner_id = ? AND c.monitor_id = ?`;
  const lastBeforePeriod = db.prepare(`SELECT status ${monitorChecks} AND checked_at < ?
    ORDER BY checked_at DESC, c.id DESC LIMIT 1`);
  const lastSuccess = db.prepare(`SELECT c.id, checked_at AS checkedAt ${monitorChecks}
    AND checked_at < ? AND status = 'up' ORDER BY checked_at DESC, c.id DESC LIMIT 1`);
  const firstFailure = db.prepare(`SELECT checked_at AS checkedAt ${monitorChecks}
    AND (checked_at, c.id) > (?, ?) AND checked_at < ? ORDER BY checked_at, c.id LIMIT 1`);
  const transitions = db.prepare(`SELECT status, checkedAt FROM (
    SELECT status, checked_at AS checkedAt, c.id,
      LAG(status) OVER (ORDER BY checked_at, c.id) AS previous
    ${monitorChecks} AND checked_at >= ? AND checked_at < ?
  ) WHERE status IS NOT previous ORDER BY checkedAt, id`);

  function recentChecks(ownerId: string, id: number) {
    return history.all(ownerId, id) as unknown as Check[];
  }

  return {
    add: (ownerId, name, url, createdAt, limit) => {
      const added = add.get(ownerId, name, url, createdAt, ownerId, limit) as Monitor | undefined;
      return added ?? (duplicate.get(ownerId, url) ? 'duplicate' : 'limit');
    },
    get: (ownerId, id) => get.get(ownerId, id) as Monitor | undefined,
    remove: (ownerId, id) => remove.run(ownerId, id).changes > 0,
    list: (ownerId) => (list.all(ownerId) as unknown as (Monitor & CheckResult & { checkId: number | null })[]).map((row) => ({
      id: row.id, name: row.name, url: row.url, createdAt: row.createdAt,
      latest: row.checkId === null ? null : {
        id: row.checkId, status: row.status, httpStatus: row.httpStatus,
        responseMs: row.responseMs, error: row.error, checkedAt: row.checkedAt,
      },
    })),
    due: (before, limit) => due.all(before, limit) as unknown as Monitor[],
    record: (id, result) => {
      record.run(result.status, result.httpStatus, result.responseMs, result.error, result.checkedAt, id);
    },
    history: recentChecks,
    snapshot: (ownerId, period, now) => {
      const { start, end, interval } = periodWindow(period, now);
      return summarize(period, now, buckets.all(start, interval, ownerId, start, end) as unknown as BucketTotals[]);
    },
    details: (ownerId, id, period, now) => {
      const { start, end, interval } = periodWindow(period, now);
      const rows = monitorBuckets.all(start, interval, ownerId, start, end, id) as unknown as BucketTotals[];
      const events = transitions.all(ownerId, id, start, end) as unknown as Pick<Check, 'status' | 'checkedAt'>[];
      if (lastBeforePeriod.get(ownerId, id, start)?.status === 'down') {
        const prior = lastSuccess.get(ownerId, id, start);
        const began = firstFailure.get(ownerId, id, prior?.checkedAt ?? -1, prior?.id ?? 0, start);
        if (typeof began?.checkedAt === 'number') events.unshift({ status: 'down', checkedAt: began.checkedAt });
      }
      return { ...summarize(period, now, rows), checks: recentChecks(ownerId, id), incidents: groupIncidents(events) };
    },
  };
}
