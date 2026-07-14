/**
 * Review-operations console. Reviewer-permission roles only.
 * Queue ordered by risk → SLA → age; masked identifiers only. Evidence is
 * never inlined here — the masked side-by-side view is a separate authorised
 * fetch, and document numbers appear only in masked form.
 */
import { getAuthContext, getDb } from "@/server/runtime";
import { getReviewQueue, getCaptureFeedbackSummary } from "@/server/reviews/service";
import { AuthorizationError } from "@/server/authz/policy";

export const dynamic = "force-dynamic";

interface SearchParams { org?: string; risk?: string; reason?: string; overdue?: string }

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const ctx = await getAuthContext();
  if (!ctx) return shell(<p className="empty">Sign in to view the review queue.</p>);
  if (!params.org) return shell(<p className="empty">Select an organisation (org=…).</p>);

  let queue: Awaited<ReturnType<typeof getReviewQueue>> = [];
  let feedback: Awaited<ReturnType<typeof getCaptureFeedbackSummary>> = [];
  try {
    const db = await getDb();
    queue = await getReviewQueue(db, ctx, params.org, {
      riskLevel: params.risk === "high" || params.risk === "standard" ? params.risk : undefined,
      reasonCode: params.reason || undefined,
      overdueOnly: params.overdue === "1",
    });
    feedback = await getCaptureFeedbackSummary(db, ctx, params.org);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return shell(<p className="empty">Your role does not permit review operations.</p>);
    }
    throw err;
  }

  return shell(
    <>
      <form className="filters" method="get">
        <input type="hidden" name="org" value={params.org} />
        <label>
          Risk
          <select name="risk" defaultValue={params.risk ?? ""}>
            <option value="">Any</option>
            <option value="high">high</option>
            <option value="standard">standard</option>
          </select>
        </label>
        <label>
          Reason code
          <input name="reason" defaultValue={params.reason ?? ""} placeholder="e.g. MODEL_NOT_APPROVED" />
        </label>
        <label>
          Overdue only
          <select name="overdue" defaultValue={params.overdue ?? ""}>
            <option value="">No</option>
            <option value="1">Yes</option>
          </select>
        </label>
        <button className="btn" type="submit">Filter</button>
      </form>

      {queue.length === 0 ? (
        <p className="empty">No open review cases match these filters.</p>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>Case</th><th>Subject</th><th>Reason</th><th>Risk</th>
              <th>Dual control</th><th>SLA</th><th>Age</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((r) => {
              const row = r as Record<string, unknown>;
              const age = Number(row.age_seconds ?? 0);
              return (
                <tr key={String(row.id)}>
                  <td className="mono">{String(row.id).slice(0, 8)}…</td>
                  <td className="mono">{String(row.subject_ref)}</td>
                  <td>{String(row.reason_code_at_open)}</td>
                  <td>
                    <span className={`outcome ${row.risk_level === "high" ? "failure" : "denied"}`}>
                      {String(row.risk_level)}
                    </span>
                  </td>
                  <td>
                    {row.requires_dual_control
                      ? row.first_approval_by
                        ? "awaiting 2nd reviewer"
                        : "2 reviewers required"
                      : "single"}
                  </td>
                  <td className="mono">{row.overdue ? <strong className="sec-alert">OVERDUE</strong> : row.sla_due_at ? new Date(String(row.sla_due_at)).toISOString().slice(11, 16) : "—"}</td>
                  <td className="mono">{age > 3600 ? `${Math.floor(age / 3600)}h` : `${Math.floor(age / 60)}m`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 32, fontFamily: "var(--font-manrope)" }}>Capture quality feedback (7 days)</h2>
      <p className="sub">Non-approved outcomes by reason, with the safe retry tip shown to end users.</p>
      {feedback.length === 0 ? (
        <p className="empty">No failed or reviewed captures this week.</p>
      ) : (
        <table className="audit-table">
          <thead><tr><th>Reason</th><th>Count</th><th>End-user retry tip</th></tr></thead>
          <tbody>
            {feedback.map((f) => (
              <tr key={f.reasonCode}>
                <td className="mono">{f.reasonCode}</td>
                <td className="mono">{f.count}</td>
                <td>{f.retryTip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
  );
}

function shell(children: React.ReactNode) {
  return (
    <div className="console-shell">
      <header className="console-header">
        <strong style={{ fontFamily: "var(--font-manrope)", letterSpacing: "0.04em" }}>BIOCHECK</strong>
        <span style={{ fontSize: 12, color: "var(--slate)" }}>Console</span>
        <span className="eyebrow">Review operations</span>
      </header>
      <main className="console-main">
        <h1>Review queue</h1>
        <p className="sub">
          Ordered by risk, then SLA, then age. High-risk cases require two different reviewers.
          A confirmed liveness failure is final unless your organisation has explicitly enabled the exception policy.
        </p>
        {children}
      </main>
    </div>
  );
}
