/**
 * Verify Lab — exercise the real enrol/verify pipeline from the console.
 * Requires a console sign-in; all pipeline calls are authorised by a tenant
 * API key held server-side (HttpOnly cookie), never exposed to the browser.
 */
import { getAuthContext } from "@/server/runtime";
import { VerifyLabClient } from "./VerifyLabClient";

export const dynamic = "force-dynamic";

export default async function VerifyLabPage() {
  const ctx = await getAuthContext();

  // Dev-only image upload: strictly never in production builds/environments.
  const allowImageUpload =
    process.env.NODE_ENV !== "production" &&
    (process.env.APP_ENV ?? "").toLowerCase() !== "production";

  return (
    <div className="console-shell">
      <header className="console-header">
        <strong style={{ fontFamily: "var(--font-manrope)", letterSpacing: "0.04em" }}>BIOCHECK</strong>
        <span style={{ fontSize: 12, color: "var(--slate)" }}>Console</span>
        <span className="eyebrow">Verify Lab</span>
      </header>
      <main className="console-main">
        <h1>Verify Lab</h1>
        <p className="sub">
          Runs the real pipeline — capture sessions, policy, model governance, audit — against a
          development or staging environment. Nothing here is simulated: without a camera,
          scanner agent, or (in development) an image file, no verification happens. Fingerprint
          matching requires the fingerprint sidecar to be configured; without it, attempts fail
          closed to human review, which you will see reported honestly below.
        </p>
        {ctx ? <VerifyLabClient allowImageUpload={allowImageUpload} /> : (
          <p className="empty">Sign in to use the Verify Lab.</p>
        )}
      </main>
    </div>
  );
}
