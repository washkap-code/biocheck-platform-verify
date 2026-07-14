/**
 * Admin audit viewer — role-guarded (audit:read via the single policy layer),
 * filterable, with CSV export for audit:export roles. Server component; no
 * client-side data fetching, no raw secrets or biometric content ever present.
 */
import { getAuthContext, getDb } from "@/server/runtime";
import { queryAudit, type AuditRow } from "@/server/audit/service";
import { AuthorizationError } from "@/server/authz/policy";

export const dynamic = "force-dynamic";

interface SearchParams {
  org?: string;
  action?: string;
  actor?: string;
  outcome?: string;
  from?: string;
  to?: string;
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const ctx = await getAuthContext();
  if (!ctx) {
    return shell(<p className="empty">Sign in to view the audit log.</p>, params);
  }
  if (!params.org) {
    return shell(<p className="empty">Select an organisation (org=…) to view its audit trail.</p>, params);
  }

  let rows: AuditRow[] = [];
  let denied = false;
  try {
    const db = await getDb();
    rows = await queryAudit(db, ctx, params.org, {
      action: params.action || undefined,
      actorId: params.actor || undefined,
      outcome: params.outcome || undefined,
      from: params.from ? new Date(params.from) : undefined,
      to: params.to ? new Date(params.to) : undefined,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) denied = true;
    else throw err;
  }

  if (denied) {
    return shell(<p className="empty">Your role does not permit viewing this organisation's audit trail.</p>, params);
  }

  const exportQuery = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v) as [string, string][],
  ).toString();

  return shell(
    <>
      <form className="filters" method="get">
        <input type="hidden" name="org" value={params.org} />
        <label>
          Action
          <input name="action" defaultValue={params.action ?? ""} placeholder="e.g. apikey.created" />
        </label>
        <label>
          Actor
          <input name="actor" defaultValue={params.actor ?? ""} placeholder="user / key id" />
        </label>
        <label>
          Outcome
          <select name="outcome" defaultValue={params.outcome ?? ""}>
            <option value="">Any</option>
            <option value="success">success</option>
            <option value="denied">denied</option>
            <option value="failure">failure</option>
          </select>
        </label>
        <label>
          From
          <input name="from" type="date" defaultValue={params.from ?? ""} />
        </label>
        <label>
          To
          <input name="to" type="date" defaultValue={params.to ?? ""} />
        </label>
        <button className="btn" type="submit">Filter</button>
        <a className="btn secondary" href={`/api/admin/audit/export?${exportQuery}`}>Export CSV</a>
      </form>

      {rows.length === 0 ? (
        <p className="empty">No audit events match these filters.</p>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>Seq</th><th>Time</th><th>Actor</th><th>Action</th>
              <th>Resource</th><th>Outcome</th><th>Event hash</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seq}>
                <td className="mono">{r.seq}</td>
                <td className="mono">{new Date(r.occurred_at).toISOString().replace("T", " ").slice(0, 19)}</td>
                <td className="mono">{r.actor_type}:{r.actor_id.slice(0, 8)}…</td>
                <td>{r.action}</td>
                <td className="mono">{r.resource_type}{r.resource_id ? `/${r.resource_id.slice(0, 8)}…` : ""}</td>
                <td><span className={`outcome ${r.outcome}`}>{r.outcome}</span></td>
                <td className="mono">{r.event_hash.slice(0, 12)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
    params,
  );
}

function shell(children: React.ReactNode, params: SearchParams) {
  return (
    <div className="console-shell">
      <header className="console-header">
        {/* Approved Concept 1 logo asset goes in /public/brand — never redrawn. */}
        <strong style={{ fontFamily: "var(--font-manrope)", letterSpacing: "0.04em" }}>BIOCHECK</strong>
        <span style={{ fontSize: 12, color: "var(--slate)" }}>Console</span>
        <span className="eyebrow">Audit trail{params.org ? ` · org ${params.org.slice(0, 8)}…` : ""}</span>
      </header>
      <main className="console-main">
        <h1>Audit events</h1>
        <p className="sub">Append-only, hash-chained record of every privileged action. Read access is role-guarded; export requires audit:export.</p>
        {children}
      </main>
    </div>
  );
}
