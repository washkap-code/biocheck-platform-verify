/**
 * Developer portal — rendered from the REAL OpenAPI document (single source
 * of truth), not hand-written parallel docs. Examples are copyable and
 * redacted; no accuracy/certification claims anywhere.
 */
import { openApiDocument } from "@/server/api/openapi";
import { Container } from "@/components/ui/Container";

export const metadata = { title: "Developers" };

const TS_QUICKSTART = `// 1. Create a capture session (server-side; never expose your API key in a browser)
const res = await fetch("https://api.biochecktech.com/v1/capture-sessions", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.BIOCHECK_API_KEY}\`, // bck_sandbox_… (redacted)
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({ purpose: "verification" }),
});
const { captureSessionId, clientToken, challenge } = await res.json();
// 2. Hand clientToken to your capture UI; it is single-use and expires in 10 minutes.`;

const PY_QUICKSTART = `import os, uuid, requests

resp = requests.post(
    "https://api.biochecktech.com/v1/verifications",
    headers={
        "Authorization": f"Bearer {os.environ['BIOCHECK_API_KEY']}",  # never hard-code
        "Idempotency-Key": str(uuid.uuid4()),
    },
    json={
        "subjectRef": "member-0042",          # your opaque reference — never a national ID number
        "captureSessionToken": client_token,   # from the capture UI hand-off
        "imageB64": image_b64,
    },
    timeout=15,
)
outcome = resp.json()   # decision: approved | review | rejected + reasonCode`;

const WEBHOOK_VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyBioCheckWebhook(secret: string, headers: Headers, rawBody: string): boolean {
  const timestamp = headers.get("X-BioCheck-Timestamp") ?? "";
  const signature = headers.get("X-BioCheck-Signature") ?? "";
  // 1. Reject stale timestamps (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  // 2. Recompute HMAC-SHA256 over "<timestamp>.<body>"
  const expected = "v1=" + createHmac("sha256", secret).update(\`\${timestamp}.\${rawBody}\`).digest("hex");
  if (expected.length !== signature.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
  // 3. Deduplicate on X-BioCheck-Event-Id — delivery is at-least-once.
  return true;
}`;

export default function DevelopersPage() {
  const paths = Object.entries(openApiDocument.paths as Record<string, Record<string, { summary?: string; description?: string }>>);
  return (
    <div className="section-light">
      <Container className="py-16 md:py-24">
        <p className="eyebrow">BioAPI — developer platform</p>
        <h1 className="mt-3 font-display text-4xl font-extrabold md:text-5xl">Build with BioVerify</h1>
        <p className="mt-4 max-w-2xl text-slate">
          Consent-led 1:1 verification over a small, predictable REST API. Everything on this page is generated
          from the live OpenAPI schema — <a className="text-cyan underline" href="/api/v1/openapi.json">openapi.json</a>.
        </p>

        <h2 className="mt-14 font-display text-2xl font-bold">API reference</h2>
        <div className="mt-6 space-y-4">
          {paths.map(([path, methods]) =>
            Object.entries(methods).map(([method, op]) => (
              <details key={`${method} ${path}`} className="rounded border border-line bg-white p-4 shadow-card">
                <summary className="cursor-pointer font-mono text-sm">
                  <span className="mr-2 rounded bg-midnight px-2 py-0.5 text-xs uppercase text-cyan">{method}</span>
                  {path}
                  <span className="ml-3 font-sans text-slate">{op.summary}</span>
                </summary>
                <p className="mt-3 text-sm text-graphite">{op.description ?? op.summary}</p>
              </details>
            )),
          )}
        </div>

        <h2 className="mt-14 font-display text-2xl font-bold">Quick starts</h2>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="font-mono text-sm uppercase tracking-widest text-slate">TypeScript</h3>
            <pre className="mt-2 overflow-x-auto rounded bg-midnight p-4 text-xs leading-relaxed text-cloud"><code>{TS_QUICKSTART}</code></pre>
          </div>
          <div>
            <h3 className="font-mono text-sm uppercase tracking-widest text-slate">Python</h3>
            <pre className="mt-2 overflow-x-auto rounded bg-midnight p-4 text-xs leading-relaxed text-cloud"><code>{PY_QUICKSTART}</code></pre>
          </div>
        </div>

        <h2 className="mt-14 font-display text-2xl font-bold">Verifying webhooks</h2>
        <p className="mt-3 max-w-2xl text-sm text-graphite">
          Deliveries are signed with your endpoint's secret (shown once at creation). Always verify the signature,
          reject stale timestamps and deduplicate on the event id.
        </p>
        <pre className="mt-4 overflow-x-auto rounded bg-midnight p-4 text-xs leading-relaxed text-cloud"><code>{WEBHOOK_VERIFY}</code></pre>

        <h2 className="mt-14 font-display text-2xl font-bold">Idempotency</h2>
        <p className="mt-3 max-w-2xl text-sm text-graphite">
          Send an <span className="font-mono">Idempotency-Key</span> header on every create. Replays with the same
          key and body return the original response (<span className="font-mono">Idempotency-Replayed: true</span>);
          the same key with a different body is rejected with <span className="font-mono">422 IDEMPOTENCY_CONFLICT</span>.
        </p>

        <h2 className="mt-14 font-display text-2xl font-bold">Sandbox test personas</h2>
        <p className="mt-3 max-w-2xl text-sm text-graphite">
          The sandbox environment runs against a deterministic simulation — no biometric data is processed. Send
          these JSON fixtures as <span className="font-mono">imageB64</span> (base64-encoded) to exercise each outcome:
        </p>
        <div className="mt-4 overflow-x-auto rounded border border-line bg-white shadow-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line font-mono text-xs uppercase tracking-widest text-slate">
                <th className="p-3">Fixture</th><th className="p-3">Outcome</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              <tr className="border-b border-line"><td className="p-3">{`{"person":"demo-alice"}`}</td><td className="p-3">approved (after enrolling the same persona)</td></tr>
              <tr className="border-b border-line"><td className="p-3">{`{"person":"demo-alice","live":false}`}</td><td className="p-3">rejected · LIVENESS_FAILED</td></tr>
              <tr className="border-b border-line"><td className="p-3">{`{"person":"demo-alice","quality":0.4}`}</td><td className="p-3">review · CAPTURE_QUALITY_INSUFFICIENT</td></tr>
              <tr><td className="p-3">{`{"person":"someone-else"}`}</td><td className="p-3">rejected · MATCH_NOT_CONFIRMED</td></tr>
            </tbody>
          </table>
        </div>
      </Container>
    </div>
  );
}
