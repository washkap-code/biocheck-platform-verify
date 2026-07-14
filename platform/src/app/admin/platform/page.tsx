/**
 * Platform super-admin: tenant onboarding view, model registry governance
 * and support-safe impersonation (explicit reason, fully audited, no silent
 * access). platform_super_admin / platform_security_admin only.
 */
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { getAuthContext, getDb } from "@/server/runtime";
import { appendAudit } from "@/server/audit/service";

export const dynamic = "force-dynamic";

export default async function PlatformAdminPage() {
  const ctx = await getAuthContext();
  if (!ctx || !ctx.platformRole) {
    return shell(<p className="empty">This area is restricted to platform administrators.</p>);
  }
  const canWrite = ctx.platformRole === "platform_super_admin";
  const db = await getDb();

  const tenants = await db.query(
    `SELECT o.id, o.name, o.slug, o.status, o.created_at,
       (SELECT COUNT(*) FROM memberships m WHERE m.organisation_id = o.id AND m.status = 'active')::int AS members,
       (SELECT COUNT(*) FROM projects p WHERE p.organisation_id = o.id)::int AS projects
     FROM organisations o ORDER BY o.created_at DESC LIMIT 100`,
  );
  const models = await db.query(
    `SELECT id, model_id, sha256, purpose, status, commercial_use_approved, independent_report_ref, approved_by, expires_on
     FROM model_registry ORDER BY created_at DESC`,
  );
  const health = await db.query<{ dead: string; open_reviews: string; blocked_deletions: string }>(
    `SELECT
       (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'dead')::text AS dead,
       (SELECT COUNT(*) FROM review_cases WHERE status = 'open')::text AS open_reviews,
       (SELECT COUNT(*) FROM subject_requests WHERE status = 'blocked_legal_hold')::text AS blocked_deletions`,
  );

  async function actionApproveModel(formData: FormData): Promise<void> {
    "use server";
    const ctx = await getAuthContext();
    if (ctx?.platformRole !== "platform_super_admin") return;
    const db = await getDb();
    const modelId = String(formData.get("model_id")).trim();
    const sha256 = String(formData.get("sha256")).trim().toLowerCase();
    const purpose = String(formData.get("purpose"));
    const report = String(formData.get("report")).trim();
    if (!/^[0-9a-f]{64}$/.test(sha256) || !modelId || !report) return;
    await db.query(
      `INSERT INTO model_registry (id, model_id, sha256, purpose, commercial_use_approved, independent_report_ref, approved_by, expires_on)
       VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7) ON CONFLICT (model_id, sha256, purpose) DO NOTHING`,
      [randomUUID(), modelId, sha256, purpose, report, ctx.userId, String(formData.get("expires_on"))],
    );
    await appendAudit(db, {
      organisationId: null, actorType: "user", actorId: ctx.userId, action: "model.approved",
      resourceType: "model_registry", resourceId: modelId, outcome: "success", details: { purpose },
    });
    revalidatePath("/admin/platform");
  }

  async function actionRevokeModel(formData: FormData): Promise<void> {
    "use server";
    const ctx = await getAuthContext();
    if (ctx?.platformRole !== "platform_super_admin") return;
    const db = await getDb();
    const id = String(formData.get("id"));
    await db.query(`UPDATE model_registry SET status = 'revoked' WHERE id = $1`, [id]);
    await appendAudit(db, {
      organisationId: null, actorType: "user", actorId: ctx.userId, action: "model.revoked",
      resourceType: "model_registry", resourceId: id, outcome: "success",
    });
    // In-flight verifications now fail closed to review automatically.
    revalidatePath("/admin/platform");
  }

  async function actionImpersonate(formData: FormData): Promise<void> {
    "use server";
    const ctx = await getAuthContext();
    if (ctx?.platformRole !== "platform_super_admin") return;
    const db = await getDb();
    const orgId = String(formData.get("organisationId"));
    const reason = String(formData.get("reason") ?? "").trim();
    if (reason.length < 10) return; // explicit reason is mandatory
    await appendAudit(db, {
      organisationId: orgId, actorType: "user", actorId: ctx.userId,
      action: "support.impersonation_started", resourceType: "organisation", resourceId: orgId,
      outcome: "success", details: { reason },
    });
    revalidatePath("/admin/platform");
  }

  return shell(
    <>
      <div className="kpi-row">
        <div className="kpi"><span className="kpi-label">Tenants</span><span className="kpi-value">{tenants.rows.length}</span></div>
        <div className="kpi"><span className="kpi-label">Dead webhooks</span><span className={`kpi-value ${Number(health.rows[0].dead) > 0 ? "bad" : ""}`}>{health.rows[0].dead}</span></div>
        <div className="kpi"><span className="kpi-label">Open reviews (all)</span><span className="kpi-value">{health.rows[0].open_reviews}</span></div>
        <div className="kpi"><span className="kpi-label">Deletions on legal hold</span><span className="kpi-value">{health.rows[0].blocked_deletions}</span></div>
      </div>

      <section className="sec-card" style={{ marginTop: 16 }} aria-labelledby="tenants-h">
        <h2 id="tenants-h">Tenants</h2>
        <table className="audit-table">
          <thead><tr><th>Name</th><th>Slug</th><th>Status</th><th>Members</th><th>Projects</th><th>Support access</th></tr></thead>
          <tbody>
            {tenants.rows.map((t) => {
              const org = t as Record<string, unknown>;
              return (
                <tr key={String(org.id)}>
                  <td>{String(org.name)}</td>
                  <td className="mono">{String(org.slug)}</td>
                  <td>{String(org.status)}</td>
                  <td className="mono">{String(org.members)}</td>
                  <td className="mono">{String(org.projects)}</td>
                  <td>
                    {canWrite && (
                      <form action={actionImpersonate} style={{ display: "flex", gap: 6 }}>
                        <input type="hidden" name="organisationId" value={String(org.id)} />
                        <input name="reason" placeholder="Reason (required, audited)" minLength={10} required style={{ fontSize: 12 }} />
                        <button className="btn secondary" type="submit">Start</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="sec-card" style={{ marginTop: 16 }} aria-labelledby="models-h">
        <h2 id="models-h">Model registry</h2>
        <table className="audit-table">
          <thead><tr><th>Model</th><th>Purpose</th><th>SHA-256</th><th>Report</th><th>Expires</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {models.rows.map((m) => {
              const model = m as Record<string, unknown>;
              return (
                <tr key={String(model.id)}>
                  <td className="mono">{String(model.model_id)}</td>
                  <td>{String(model.purpose)}</td>
                  <td className="mono">{String(model.sha256).slice(0, 12)}…</td>
                  <td className="mono">{String(model.independent_report_ref)}</td>
                  <td className="mono">{String(model.expires_on)}</td>
                  <td><span className={`outcome ${model.status === "active" ? "success" : "failure"}`}>{String(model.status)}</span></td>
                  <td>
                    {canWrite && model.status === "active" && (
                      <form action={actionRevokeModel}>
                        <input type="hidden" name="id" value={String(model.id)} />
                        <button className="btn secondary" type="submit">Revoke</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {canWrite && (
          <>
            <h3 style={{ marginTop: 16 }}>Approve a model version</h3>
            <p className="sub">Requires the exact file SHA-256, an independent evaluation report reference and an expiry. An unknown or changed hash always routes verifications to review.</p>
            <form action={actionApproveModel} className="stack-form" style={{ maxWidth: 480 }}>
              <label>Model ID <input name="model_id" required placeholder="seetaface6-recognition-…" /></label>
              <label>File SHA-256 <input name="sha256" required pattern="[0-9a-fA-F]{64}" /></label>
              <label>Purpose
                <select name="purpose">
                  <option value="face_embedding">face_embedding</option>
                  <option value="passive_pad">passive_pad</option>
                  <option value="face_detection">face_detection</option>
                  <option value="capture_quality">capture_quality</option>
                </select>
              </label>
              <label>Independent report ref <input name="report" required placeholder="LAB-2026-…" /></label>
              <label>Expires on <input name="expires_on" type="date" required /></label>
              <button className="btn" type="submit">Approve</button>
            </form>
          </>
        )}
      </section>
    </>,
  );
}

function shell(children: React.ReactNode) {
  return (
    <div className="console-shell">
      <header className="console-header">
        <strong style={{ fontFamily: "var(--font-manrope)", letterSpacing: "0.04em" }}>BIOCHECK</strong>
        <span style={{ fontSize: 12, color: "var(--slate)" }}>Platform admin</span>
        <span className="eyebrow">Governance</span>
      </header>
      <main className="console-main">
        <h1>Platform administration</h1>
        <p className="sub">Tenant onboarding, model governance and system health. Support impersonation requires a written reason and is always audited.</p>
        {children}
      </main>
    </div>
  );
}
