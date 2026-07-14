/**
 * Organisation dashboard — live aggregates from the metrics service.
 * Empty/loading/error states handled; no static charts pretending to be data.
 */
import { getAuthContext, getDb } from "@/server/runtime";
import { getOrgDashboard, type OrgDashboard } from "@/server/console/metrics";
import { AuthorizationError } from "@/server/authz/policy";

export const dynamic = "force-dynamic";

export default async function ConsolePage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const params = await searchParams;
  const ctx = await getAuthContext();
  if (!ctx) return shell(<p className="empty">Sign in to view your organisation dashboard.</p>);
  if (!params.org) return shell(<p className="empty">Select an organisation (org=…).</p>);

  let data: OrgDashboard;
  try {
    data = await getOrgDashboard(await getDb(), ctx, params.org);
  } catch (err) {
    if (err instanceof AuthorizationError) return shell(<p className="empty">You are not a member of this organisation.</p>);
    throw err;
  }

  const maxDay = Math.max(1, ...data.dailyVolumes.map((d) => d.count));

  return shell(
    <>
      <div className="kpi-row" role="list" aria-label="Verification totals, last 14 days">
        <Kpi label="Verifications" value={data.totals.attempts} />
        <Kpi label="Approved" value={data.totals.approved} suffix={fmtPct(data.rates.approvalPct)} tone="ok" />
        <Kpi label="In review" value={data.totals.review} suffix={fmtPct(data.rates.reviewPct)} tone="warn" />
        <Kpi label="Rejected" value={data.totals.rejected} suffix={fmtPct(data.rates.rejectPct)} tone="bad" />
        <Kpi label="Open reviews" value={data.pendingReviews.total} suffix={data.pendingReviews.overdue > 0 ? `${data.pendingReviews.overdue} overdue` : undefined} tone={data.pendingReviews.overdue > 0 ? "bad" : undefined} />
      </div>

      <section className="sec-card" aria-labelledby="vol-h" style={{ marginTop: 16 }}>
        <h2 id="vol-h">Daily volumes (14 days)</h2>
        {data.dailyVolumes.length === 0 ? (
          <p className="empty">No verification activity yet. Create a capture session via the API to get started.</p>
        ) : (
          <div className="bars" role="img" aria-label={`Daily verification counts, peaking at ${maxDay}`}>
            {data.dailyVolumes.map((d) => (
              <div key={d.day} className="bar-col" title={`${d.day}: ${d.count}`}>
                <div className="bar" style={{ height: `${Math.max(4, (d.count / maxDay) * 90)}px` }} />
                <span className="bar-label">{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="sec-grid" style={{ marginTop: 16 }}>
        <section className="sec-card" aria-labelledby="cq-h">
          <h2 id="cq-h">Capture quality issues</h2>
          {data.captureQualityIssues.length === 0 ? <p className="empty">None in this window.</p> : (
            <ul>{data.captureQualityIssues.map((q) => <li key={q.reasonCode}><span className="mono">{q.reasonCode}</span> ×{q.count}</li>)}</ul>
          )}
        </section>
        <section className="sec-card" aria-labelledby="wh-h">
          <h2 id="wh-h">Webhook health</h2>
          {data.webhookHealth.length === 0 ? <p className="empty">No deliveries yet.</p> : (
            <ul>{data.webhookHealth.map((w) => <li key={w.status}>{w.status}: {w.count} {w.status === "dead" && w.count > 0 && <strong className="sec-alert">ATTENTION</strong>}</li>)}</ul>
          )}
        </section>
        <section className="sec-card" aria-labelledby="pol-h">
          <h2 id="pol-h">Active policy versions</h2>
          <ul>{data.activePolicies.map((p, i) => <li key={i}>{p.projectName} · {p.environmentKind}: <span className="mono">{p.name} v{p.version}</span></li>)}</ul>
          <p className="sub" style={{ marginTop: 8 }}>Review SLA: {data.slaMinutes} minutes</p>
        </section>
        <section className="sec-card" aria-labelledby="mod-h">
          <h2 id="mod-h">Model versions</h2>
          <ul>{data.activeModels.map((m, i) => <li key={i}><span className="mono">{m.modelId}</span> · {m.purpose} · {m.status} · expires {m.expiresOn}</li>)}</ul>
        </section>
      </div>
    </>,
  );
}

function fmtPct(v: number | null): string | undefined {
  return v === null ? undefined : `${v}%`;
}

function Kpi({ label, value, suffix, tone }: { label: string; value: number; suffix?: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="kpi" role="listitem">
      <span className="kpi-label">{label}</span>
      <span className={`kpi-value ${tone ?? ""}`}>{value.toLocaleString()}</span>
      {suffix && <span className="kpi-suffix">{suffix}</span>}
    </div>
  );
}

function shell(children: React.ReactNode) {
  return (
    <div className="console-shell">
      <header className="console-header">
        <strong style={{ fontFamily: "var(--font-manrope)", letterSpacing: "0.04em" }}>BIOCHECK</strong>
        <span style={{ fontSize: 12, color: "var(--slate)" }}>Console</span>
        <span className="eyebrow">Overview</span>
      </header>
      <main className="console-main">
        <h1>Organisation dashboard</h1>
        <p className="sub">Privacy-preserving aggregates over the last 14 days. Figures come from live operational tables.</p>
        {children}
      </main>
    </div>
  );
}
