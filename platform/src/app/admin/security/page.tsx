/**
 * Security dashboard — role-guarded (audit:read). Counts, dates and statuses
 * only; no raw biometric content anywhere on this page by construction.
 */
import { getAuthContext, getDb } from "@/server/runtime";
import { getSecurityDashboard, type SecurityDashboard } from "@/server/security/dashboard";
import { AuthorizationError } from "@/server/authz/policy";

export const dynamic = "force-dynamic";

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const params = await searchParams;
  const ctx = await getAuthContext();
  if (!ctx) return shell(<p className="empty">Sign in to view the security dashboard.</p>);
  if (!params.org) return shell(<p className="empty">Select an organisation (org=…).</p>);

  let data: SecurityDashboard;
  try {
    data = await getSecurityDashboard(await getDb(), ctx, params.org);
  } catch (err) {
    if (err instanceof AuthorizationError) return shell(<p className="empty">Your role does not permit this view.</p>);
    throw err;
  }

  return shell(
    <div className="sec-grid">
      <section className="sec-card" aria-labelledby="sec-keys">
        <h2 id="sec-keys">Key rotation</h2>
        <ul>
          {data.keyRotation.map((k, i) => (
            <li key={i}>
              {k.organisationScope} key v{k.keyVersion} — due {new Date(k.rotateDueAt).toDateString()}{" "}
              {k.overdue && <strong className="sec-alert">OVERDUE</strong>}
            </li>
          ))}
          {data.keyRotation.length === 0 && <li>No keys provisioned yet.</li>}
        </ul>
      </section>

      <section className="sec-card" aria-labelledby="sec-policies">
        <h2 id="sec-policies">Active verification policies</h2>
        <ul>{data.activePolicies.map((p, i) => <li key={i}>{p.name} v{p.version} ({p.scope})</li>)}</ul>
      </section>

      <section className="sec-card" aria-labelledby="sec-models">
        <h2 id="sec-models">Model approvals</h2>
        <ul>
          {data.modelApprovals.map((m, i) => (
            <li key={i}>
              <span className="mono">{m.modelId}</span> · {m.purpose} · {m.status} · expires {m.expiresOn}{" "}
              {m.expiringSoon && m.status === "active" && <strong className="sec-alert">EXPIRING SOON</strong>}
            </li>
          ))}
        </ul>
      </section>

      <section className="sec-card" aria-labelledby="sec-webhooks">
        <h2 id="sec-webhooks">Webhook delivery health</h2>
        <ul>
          {data.webhookHealth.map((w, i) => (
            <li key={i}>{w.status}: {w.count} {w.status === "dead" && w.count > 0 && <strong className="sec-alert">ATTENTION</strong>}</li>
          ))}
          {data.webhookHealth.length === 0 && <li>No deliveries yet.</li>}
        </ul>
      </section>

      <section className="sec-card" aria-labelledby="sec-audit">
        <h2 id="sec-audit">High-risk audit events (7 days)</h2>
        <ul>{data.highRiskAuditEvents.map((h, i) => <li key={i}>{h.action} · {h.outcome} · ×{h.count}</li>)}</ul>
      </section>

      <section className="sec-card" aria-labelledby="sec-queues">
        <h2 id="sec-queues">Queues</h2>
        <ul>
          <li>Open review cases: <strong>{data.pendingReviewCases}</strong></li>
          <li>Deletion requests blocked by legal hold: <strong>{data.blockedDeletionRequests}</strong></li>
        </ul>
      </section>
    </div>,
  );
}

function shell(children: React.ReactNode) {
  return (
    <div className="console-shell">
      <header className="console-header">
        <strong style={{ fontFamily: "var(--font-manrope)", letterSpacing: "0.04em" }}>BIOCHECK</strong>
        <span style={{ fontSize: 12, color: "var(--slate)" }}>Console</span>
        <span className="eyebrow">Security</span>
      </header>
      <main className="console-main">
        <h1>Security dashboard</h1>
        <p className="sub">Key rotation, policy and model governance, webhook health and high-risk activity. This view never contains biometric content.</p>
        {children}
      </main>
    </div>
  );
}
