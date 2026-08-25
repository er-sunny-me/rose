import { useEffect, useState } from 'react';
import { Activity, DollarSign, Gauge, Server, TrendingDown, Zap } from 'lucide-react';
import { authHeaders } from '../api';

const BASE = `${(typeof window !== 'undefined' && window.location?.origin) || ''}/api/v1`;

async function getJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

type HealthRow = { componentType: string; componentId: string; state: string };
type Slo = { id?: string; name?: string; targetValue?: number; [k: string]: any };
type CostSummary = {
  totalsByTargetType: Record<string, number>;
  records: Array<{ id: string; targetType: string; targetId: string; costAmount: number; currency: string; timestamp: number }>;
  budgets: Array<{ id?: string; limit?: number; status?: { spent: number; remaining: number; percentageUsed: number } }>;
};
type PerfBaselines = Record<string, { latency?: number; cpu?: number; memory?: number; cost?: number }>;

const stateColor = (s: string) =>
  s === 'healthy' ? 'var(--accent-green, #2fbf71)' :
  s === 'degraded' ? 'var(--accent-yellow, #f5a623)' : '#e5484d';

function Widget({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      border: '1px solid var(--border-color, #2c2c33)', borderRadius: 10,
      padding: 16, background: 'var(--bg-primary, #1b1b1f)', minWidth: 260, flex: '1 1 300px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontWeight: 600 }}>
        {icon}<span>{title}</span>
      </div>
      {children}
    </div>
  );
}

/** Tiny inline sparkline — no chart dependency needed for phase-36 scope. */
function Spark({ values, color = 'var(--accent-red, #e5484d)' }: { values: number[]; color?: string }) {
  if (!values.length) return <div style={{ opacity: 0.5, fontSize: 12 }}>No data yet</div>;
  const w = 220, h = 48;
  const max = Math.max(...values), min = Math.min(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - ((v - min) / range) * h}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

export default function Observability() {
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [slos, setSlos] = useState<Slo[]>([]);
  const [costs, setCosts] = useState<CostSummary | null>(null);
  const [perf, setPerf] = useState<PerfBaselines>({});
  const [capacity, setCapacity] = useState<any>(null);
  const [bottleneck, setBottleneck] = useState<any>(null);
  const [tick, setTick] = useState(0);

  // Live mode: poll every 5 s instead of full reloads (§67).
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void (async () => {
      const h = await getJson<{ [k: string]: HealthRow }>('/health/system', {});
      setHealth(Object.values(h ?? {}));
      const s = await getJson<{ slos: Slo[] }>('/slo', { slos: [] });
      setSlos(s.slos ?? []);
      setCosts(await getJson<CostSummary>('/costs', null as any));
      setPerf(await getJson<PerfBaselines>('/performance', {}));
      setCapacity(await getJson<any>('/capacity', null));
      const b = await getJson<{ bottleneck: any }>('/bottlenecks', { bottleneck: null });
      setBottleneck(b.bottleneck);
    })();
  }, [tick]);

  const costSeries = (costs?.records ?? [])
    .slice(-40)
    .map(r => r.costAmount);

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
      <Widget title="System Health" icon={<Server size={16} />}>
        {(health.length ? health : [{ componentType: 'runtime', componentId: '-', state: 'healthy' }]).map((h, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13 }}>
            <span style={{ width: 9, height: 9, borderRadius: 9, background: stateColor(h.state) }} />
            <span style={{ opacity: 0.85 }}>{h.componentType}</span>
            <span style={{ marginLeft: 'auto', opacity: 0.5 }}>{h.state}</span>
          </div>
        ))}
      </Widget>

      <Widget title="Cost" icon={<DollarSign size={16} />}>
        <Spark values={costSeries} />
        <div style={{ marginTop: 8, fontSize: 13 }}>
          {Object.entries(costs?.totalsByTargetType ?? {}).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ opacity: 0.7 }}>{k}</span><span>${v.toFixed(4)}</span>
            </div>
          ))}
          {Object.keys(costs?.totalsByTargetType ?? {}).length === 0 && (
            <div style={{ opacity: 0.5 }}>No spend recorded this window</div>
          )}
        </div>
      </Widget>

      <Widget title="SLO" icon={<Gauge size={16} />}>
        {(slos.length ? slos : []).map((s, i) => (
          <div key={i} style={{ padding: '3px 0', fontSize: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{s.name || s.id}</span>
              <span>{s.targetValue != null ? `target ${s.targetValue}` : ''}</span>
            </div>
          </div>
        ))}
        {slos.length === 0 && <div style={{ opacity: 0.5 }}>No SLOs registered</div>}
      </Widget>

      <Widget title="Performance (baselines)" icon={<Zap size={16} />}>
        {Object.keys(perf).length === 0 && <div style={{ opacity: 0.5 }}>No baselines recorded</div>}
        {Object.entries(perf).map(([op, v]) => (
          <div key={op} style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
            <span style={{ opacity: 0.75 }}>{op}</span>
            <span>{v.latency != null ? `${v.latency.toFixed(0)} ms` : '—'}</span>
          </div>
        ))}
      </Widget>

      <Widget title="Capacity Forecast" icon={<TrendingDown size={16} />}>
        {capacity?.forecast ? (
          <>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{Number(capacity.forecast.growthRatePerHour).toFixed(2)}/hr</div>
            <div style={{ opacity: 0.6, fontSize: 12 }}>{capacity.forecast.resource}</div>
            {capacity.forecast.estimatedSaturationHours && (
              <div style={{ marginTop: 6, color: 'var(--accent-yellow)' }}>
                saturation ≈ {Number(capacity.forecast.estimatedSaturationHours).toFixed(1)} h
              </div>
            )}
          </>
        ) : <div style={{ opacity: 0.5 }}>Waiting for data…</div>}
      </Widget>

      <Widget title="Top Bottleneck" icon={<Activity size={16} />}>
        {bottleneck ? (
          <>
            <div style={{ fontWeight: 700 }}>{String(bottleneck.primaryBottleneck)}</div>
            <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
              {(bottleneck.secondarySymptoms || []).join(', ')}
            </div>
          </>
        ) : <div style={{ opacity: 0.5 }}>None detected 🎉</div>}
      </Widget>
    </div>
  );
}
