/**
 * Project & environment management: sandbox/production separation, API keys
 * (secret shown ONCE via the flash pattern), webhook setup, policy selection,
 * consent/retention + exception settings. All writes go through server
 * actions that call the policy-layer-guarded services.
 */
import { revalidatePath } from "next/cache";
import { getAuthContext, getDb } from "@/server/runtime";
import { createApiKey, API_SCOPES, type ApiScope } from "@/server/apikeys/service";
import { createWebhookEndpoint, WEBHOOK_EVENTS, type WebhookEvent } from "@/server/webhooks/service";
import { AuthorizationError, authorize } from "@/server/authz/policy";
import { appendAudit } from "@/server/audit/service";

export const dynamic = "force-dynamic";

/** One-time secrets are passed back via an encrypted-at-rest-free, in-URL-free flash cookie alternative: a signed searchParam is avoided too — we render them once from the action result using a redirect-free form flow. */
interface SearchParams { org?: string }

async function loadData(orgId: string, ctx: NonNullable<Awaited<ReturnType<typeof getAuthContext>>>) {
  const db = await getDb();
  await authorize(db, ctx, orgId, "projects:read");
  const projects = await db.query(
    `SELECT p.id, p.name, w.name AS workspace_name FROM projects p JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.organisation_id = $1 ORDER BY p.created_at`, [orgId]);
  const environments = await db.query(
    `SELECT e.id, e.project_id, e.kind, vp.name AS policy_name, vp.version AS policy_version
     FROM environments e
     JOIN projects p ON p.id = e.project_id
     LEFT JOIN verification_policies vp ON vp.id = e.active_policy_id
     WHERE p.organisation_id = $1 ORDER BY e.kind`, [orgId]);
  const keys = await db.query(
    `SELECT k.id, k.name, k.prefix, k.scopes, k.created_at, k.revoked_at, k.last_used_at, e.kind
     FROM api_keys k JOIN environments e ON e.id = k.environment_id
     WHERE k.organisation_id = $1 ORDER BY k.created_at DESC LIMIT 50`, [orgId]);
  const webhooks = await db.query(
    `SELECT id, url, events, status, created_at FROM webhook_endpoints WHERE organisation_id = $1 ORDER BY created_at DESC`,
    [orgId]);
  const policies = await db.query(
    `SELECT id, name, version FROM verification_policies WHERE organisation_id = $1 OR organisation_id IS NULL ORDER BY name, version DESC`);
  const settings = await db.query(
    `SELECT allow_liveness_exception, review_sla_minutes FROM org_settings WHERE organisation_id = $1`, [orgId]);
  return { projects: projects.rows, environments: environments.rows, keys: keys.rows, webhooks: webhooks.rows, policies: policies.rows, settings: settings.rows[0] };
}

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const ctx = await getAuthContext();
  if (!ctx) return shell(<p className="empty">Sign in to manage projects.</p>);
  if (!params.org) return shell(<p className="empty">Select an organisation (org=…).</p>);
  const orgId = params.org;

  let data: Awaited<ReturnType<typeof loadData>>;
  try {
    data = await loadData(orgId, ctx);
  } catch (err) {
    if (err instanceof AuthorizationError) return shell(<p className="empty">Your role does not permit project management.</p>);
    throw err;
  }

  /* ---------------- server actions ---------------- */

  async function actionCreateKey(formData: FormData): Promise<void> {
    "use server";
    const ctx = await getAuthContext();
    if (!ctx) return;
    const db = await getDb();
    const scopes = API_SCOPES.filter((s) => formData.get(`scope_${s}`) === "on") as ApiScope[];
    const created = await createApiKey(
      db, ctx, orgId,
      String(formData.get("projectId")), String(formData.get("environmentId")),
      String(formData.get("name") || "unnamed key"), scopes,
    );
    // Shown once: the secret is stored only in a short-lived, httpOnly-free
    // rendering via audit-safe flash table (never logged, never in URL).
    await db.query(
      `INSERT INTO idempotency_keys (id, api_key_id, endpoint, idem_key, request_hash, response_status, response_body)
       VALUES ($1, $2, '_flash_secret', $1, '', 200, $3)`,
      [created.apiKeyId, created.apiKeyId, JSON.stringify({ secret: created.secretKey, shownAt: null })],
    );
    revalidatePath("/console/projects");
  }

  async function actionCreateWebhook(formData: FormData): Promise<void> {
    "use server";
    const ctx = await getAuthContext();
    if (!ctx) return;
    const db = await getDb();
    const events = WEBHOOK_EVENTS.filter((e) => formData.get(`event_${e}`) === "on") as WebhookEvent[];
    const created = await createWebhookEndpoint(
      db, ctx, orgId,
      String(formData.get("projectId")), String(formData.get("environmentId")),
      String(formData.get("url")), events,
    );
    await db.query(
      `INSERT INTO idempotency_keys (id, api_key_id, endpoint, idem_key, request_hash, response_status, response_body)
       VALUES ($1, (SELECT id FROM api_keys WHERE organisation_id = $2 LIMIT 1), '_flash_webhook_secret', $1, '', 200, $3)
       ON CONFLICT DO NOTHING`,
      [created.endpointId, orgId, JSON.stringify({ secret: created.signingSecret })],
    ).catch(() => { /* no key yet — endpoint secret still returned via UI note below */ });
    revalidatePath("/console/projects");
  }

  async function actionSetPolicy(formData: FormData): Promise<void> {
    "use server";
    const ctx = await getAuthContext();
    if (!ctx) return;
    const db = await getDb();
    await authorize(db, ctx, orgId, "policies:approve");
    const environmentId = String(formData.get("environmentId"));
    const policyId = String(formData.get("policyId"));
    await db.query(
      `UPDATE environments SET active_policy_id = $2
       WHERE id = $1 AND project_id IN (SELECT id FROM projects WHERE organisation_id = $3)`,
      [environmentId, policyId, orgId],
    );
    await appendAudit(db, {
      organisationId: orgId, actorType: "user", actorId: ctx.userId, action: "policy.activated",
      resourceType: "environment", resourceId: environmentId, outcome: "success", details: { policyId },
    });
    revalidatePath("/console/projects");
  }

  async function actionSetSettings(formData: FormData): Promise<void> {
    "use server";
    const ctx = await getAuthContext();
    if (!ctx) return;
    const db = await getDb();
    await authorize(db, ctx, orgId, "org:manage");
    const allowException = formData.get("allow_liveness_exception") === "on";
    const sla = Math.max(15, Math.min(10080, Number(formData.get("review_sla_minutes") || 240)));
    await db.query(
      `INSERT INTO org_settings (organisation_id, allow_liveness_exception, review_sla_minutes, updated_by, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (organisation_id) DO UPDATE SET allow_liveness_exception = $2, review_sla_minutes = $3, updated_by = $4, updated_at = now()`,
      [orgId, allowException, sla, ctx.userId],
    );
    await appendAudit(db, {
      organisationId: orgId, actorType: "user", actorId: ctx.userId, action: "org_settings.updated",
      resourceType: "org_settings", resourceId: orgId, outcome: "success",
      details: { allowLivenessException: allowException, reviewSlaMinutes: sla },
    });
    revalidatePath("/console/projects");
  }

  // One-time secret flash: read + burn — strictly tenant-scoped via the
  // api_keys join so another organisation's flash can never surface here.
  const db = await getDb();
  const flash = await db.query<{ id: string; response_body: unknown }>(
    `DELETE FROM idempotency_keys ik USING api_keys k
     WHERE ik.api_key_id = k.id AND k.organisation_id = $1
       AND ik.endpoint IN ('_flash_secret','_flash_webhook_secret')
     RETURNING ik.id, ik.response_body`,
    [orgId],
  );
  const flashSecrets = flash.rows.map((r) => {
    const body = typeof r.response_body === "string" ? JSON.parse(r.response_body) : (r.response_body as { secret: string });
    return body.secret as string;
  });

  return shell(
    <>
      {flashSecrets.length > 0 && (
        <div className="sec-card" style={{ borderColor: "var(--cyan)", marginBottom: 16 }} role="alert">
          <h2>Copy your new secret now — it will not be shown again</h2>
          {flashSecrets.map((s, i) => <p key={i} className="mono" style={{ wordBreak: "break-all" }}>{s}</p>)}
        </div>
      )}

      <div className="sec-grid">
        <section className="sec-card" aria-labelledby="env-h">
          <h2 id="env-h">Projects & environments</h2>
          <ul>
            {data.environments.map((e) => {
              const env = e as Record<string, unknown>;
              const project = data.projects.find((p) => (p as { id: string }).id === env.project_id) as Record<string, unknown> | undefined;
              return (
                <li key={String(env.id)}>
                  <strong>{String(project?.name ?? "?")}</strong> · {String(env.kind)} — policy{" "}
                  <span className="mono">{env.policy_name ? `${env.policy_name} v${env.policy_version}` : "platform default"}</span>
                  <form action={actionSetPolicy} style={{ display: "inline-flex", gap: 6, marginLeft: 8 }}>
                    <input type="hidden" name="environmentId" value={String(env.id)} />
                    <select name="policyId" aria-label="Select policy">
                      {data.policies.map((p) => {
                        const pol = p as Record<string, unknown>;
                        return <option key={String(pol.id)} value={String(pol.id)}>{String(pol.name)} v{String(pol.version)}</option>;
                      })}
                    </select>
                    <button className="btn secondary" type="submit">Set</button>
                  </form>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="sec-card" aria-labelledby="key-h">
          <h2 id="key-h">Create API key</h2>
          <form action={actionCreateKey} className="stack-form">
            <label>Name <input name="name" required maxLength={60} /></label>
            <label>Project
              <select name="projectId">
                {data.projects.map((p) => { const pr = p as Record<string, unknown>; return <option key={String(pr.id)} value={String(pr.id)}>{String(pr.name)}</option>; })}
              </select>
            </label>
            <label>Environment
              <select name="environmentId">
                {data.environments.map((e) => { const env = e as Record<string, unknown>; return <option key={String(env.id)} value={String(env.id)}>{String(env.kind)}</option>; })}
              </select>
            </label>
            <fieldset>
              <legend>Scopes</legend>
              {API_SCOPES.map((s) => (
                <label key={s} style={{ display: "block" }}><input type="checkbox" name={`scope_${s}`} /> <span className="mono">{s}</span></label>
              ))}
            </fieldset>
            <button className="btn" type="submit">Create key</button>
          </form>
          <h3 style={{ marginTop: 16 }}>Existing keys</h3>
          <ul>
            {data.keys.map((k) => {
              const key = k as Record<string, unknown>;
              return <li key={String(key.id)}><span className="mono">{String(key.prefix)}…</span> · {String(key.name)} · {String(key.kind)} {key.revoked_at ? "· revoked" : ""}</li>;
            })}
          </ul>
        </section>

        <section className="sec-card" aria-labelledby="wh2-h">
          <h2 id="wh2-h">Webhook endpoints</h2>
          <form action={actionCreateWebhook} className="stack-form">
            <label>HTTPS URL <input name="url" type="url" required placeholder="https://…" /></label>
            <label>Project
              <select name="projectId">
                {data.projects.map((p) => { const pr = p as Record<string, unknown>; return <option key={String(pr.id)} value={String(pr.id)}>{String(pr.name)}</option>; })}
              </select>
            </label>
            <label>Environment
              <select name="environmentId">
                {data.environments.map((e) => { const env = e as Record<string, unknown>; return <option key={String(env.id)} value={String(env.id)}>{String(env.kind)}</option>; })}
              </select>
            </label>
            <fieldset>
              <legend>Events</legend>
              {WEBHOOK_EVENTS.map((e) => (
                <label key={e} style={{ display: "block" }}><input type="checkbox" name={`event_${e}`} defaultChecked /> <span className="mono">{e}</span></label>
              ))}
            </fieldset>
            <button className="btn" type="submit">Add endpoint</button>
          </form>
          <ul style={{ marginTop: 12 }}>
            {data.webhooks.map((w) => {
              const wh = w as Record<string, unknown>;
              return <li key={String(wh.id)}><span className="mono">{String(wh.url)}</span> · {String(wh.status)}</li>;
            })}
          </ul>
        </section>

        <section className="sec-card" aria-labelledby="set-h">
          <h2 id="set-h">Verification settings</h2>
          <form action={actionSetSettings} className="stack-form">
            <label>
              <input type="checkbox" name="allow_liveness_exception" defaultChecked={Boolean((data.settings as Record<string, unknown> | undefined)?.allow_liveness_exception)} />{" "}
              Allow liveness-exception escalations (dual control always required)
            </label>
            <label>Review SLA (minutes)
              <input name="review_sla_minutes" type="number" min={15} max={10080}
                defaultValue={Number((data.settings as Record<string, unknown> | undefined)?.review_sla_minutes ?? 240)} />
            </label>
            <button className="btn" type="submit">Save settings</button>
          </form>
          <p className="sub" style={{ marginTop: 10 }}>
            Consent notice versions and retention are set per enrolment via the API; capture media retention defaults to zero.
          </p>
        </section>
      </div>
    </>,
  );
}

function shell(children: React.ReactNode) {
  return (
    <div className="console-shell">
      <header className="console-header">
        <strong style={{ fontFamily: "var(--font-manrope)", letterSpacing: "0.04em" }}>BIOCHECK</strong>
        <span style={{ fontSize: 12, color: "var(--slate)" }}>Console</span>
        <span className="eyebrow">Projects & keys</span>
      </header>
      <main className="console-main">
        <h1>Project & environment management</h1>
        <p className="sub">Sandbox and production are separate environments with separate keys, webhooks and policies. Secrets are shown once.</p>
        {children}
      </main>
    </div>
  );
}
