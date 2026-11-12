import { formatMoney } from '@trades/shared';
import { Banner, Loading, StatusPill, useApi, useData } from '../lib';

const QUEUE_LINKS: Array<[string, string, string]> = [
  ['pending_verifications', 'Providers awaiting verification', '#/providers'],
  ['open_disputes', 'Open disputes', '#/disputes'],
  ['disputes_sla_breached', 'Disputes past SLA', '#/disputes'],
  ['admin_assist', 'Urgent requests needing manual assist', '#/requests?assist=1'],
  ['payouts_due_24h', 'Payouts due in 24h', '#/payouts'],
  ['payouts_held', 'Payouts on hold', '#/payouts?status=held'],
  ['payouts_stuck', 'Payouts stuck in processing', '#/payouts?status=processing'],
  ['manual_refunds', 'Refunds awaiting bank transfer', '#/refunds'],
  ['fraud_open', 'Open fraud signals', '#/trust'],
  ['notifications_dead_24h', 'Undelivered notifications (24h)', '#/trust'],
  ['invalid_webhooks_24h', 'Rejected payment webhooks (24h)', '#/audit'],
];
const ALERTING = new Set(['disputes_sla_breached', 'payouts_stuck', 'invalid_webhooks_24h', 'admin_assist']);

export function Dashboard() {
  const api = useApi();
  const { data, error, loading } = useData(() => api.admin.dashboard(), []);
  if (loading) return <Loading />;
  if (error || !data) return <Banner tone="danger">{error}</Banner>;
  const k = data.kpi ?? {};
  const revenue = (data.ledger ?? []).filter((l: any) => ['platform_fee_revenue', 'platform_commission_revenue'].includes(l.account)).reduce((s: number, l: any) => s + Number(l.balance), 0);
  const payable = (data.ledger ?? []).find((l: any) => l.account === 'provider_payable')?.balance ?? 0;
  const maxReq = Math.max(1, ...data.daily.map((d: any) => d.requests));
  return (
    <>
      <div className="topbar"><div><h1>Dashboard</h1><span className="muted">Live operational view across markets</span></div></div>
      <div className="grid k4">
        <div className="card kpi"><div className="label">Requests (24h)</div><div className="value">{k.requests_24h}</div></div>
        <div className="card kpi"><div className="label">Bookings (24h)</div><div className="value">{k.bookings_24h}</div></div>
        <div className="card kpi"><div className="label">GMV (30d)</div><div className="value">{formatMoney(k.gmv_30d, 'MUR')}</div></div>
        <div className="card kpi"><div className="label">Platform revenue (all time)</div><div className="value">{formatMoney(revenue, 'MUR')}</div></div>
        <div className="card kpi"><div className="label">Held for providers</div><div className="value">{formatMoney(payable, 'MUR')}</div></div>
        <div className="card kpi"><div className="label">Providers online</div><div className="value">{k.providers_online}</div></div>
        <div className="card kpi"><div className="label">Fulfilment rate (30d)</div><div className="value">{k.fulfilment_rate_pct ?? '—'}%</div></div>
        <div className="card kpi"><div className="label">Urgent: time to first quote</div><div className="value">{k.urgent_first_quote_min ?? '—'} min</div></div>
      </div>
      <div className="grid c3" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Last 14 days — requests</h2>
          <div className="bars" style={{ marginBottom: 24 }}>
            {data.daily.map((d: any) => (
              <div key={d.day} className="bar" style={{ height: `${(d.requests / maxReq) * 100}%` }} title={`${d.day}: ${d.requests} requests, ${d.paid_bookings} paid, ${formatMoney(d.revenue, 'MUR')} revenue`}>
                <span>{String(d.day).slice(5, 10)}</span>
              </div>
            ))}
          </div>
          <h2 style={{ marginTop: 16 }}>Top categories (30d)</h2>
          <table><thead><tr><th>Category</th><th className="num">Requests</th><th className="num">Bookings</th><th className="num">Conversion</th></tr></thead>
            <tbody>{data.topCategories.map((c: any) => <tr key={c.name}><td>{c.name}</td><td className="num">{c.requests}</td><td className="num">{c.bookings}</td><td className="num">{c.requests ? Math.round((c.bookings / c.requests) * 100) : 0}%</td></tr>)}</tbody>
          </table>
        </div>
        <div>
          <div className="card">
            <h2>Work queues</h2>
            <table><tbody>
              {QUEUE_LINKS.map(([key, label, href]) => {
                const v = data.queues[key] ?? 0;
                return <tr key={key}><td><a href={href}>{label}</a></td><td className="num">{v > 0 && ALERTING.has(key) ? <span className="pill danger">{v}</span> : v}</td></tr>;
              })}
            </tbody></table>
          </div>
          <div className="card">
            <h2>Bookings by status</h2>
            <table><tbody>{data.bookingsByStatus.map((s: any) => <tr key={s.status}><td><StatusPill s={s.status} /></td><td className="num">{s.n}</td></tr>)}</tbody></table>
          </div>
        </div>
      </div>
    </>
  );
}
