"use client";

/**
 * Verify Lab — internal testing surface for the real enrol/verify pipeline.
 * No simulation anywhere: face uses the browser camera; fingerprint requires
 * the Capture Agent (or the dev-only image upload where the server allows it).
 */
import { useState } from "react";
import { CaptureFlow } from "../../verify/CaptureFlow";
import { FingerprintFlow } from "../../verify/FingerprintFlow";

const NOTICE_VERSION = "lab-2026-07";
const NOTICE_TEXT =
  "You are using the BioCheck Verify Lab. Your capture is processed by the real verification " +
  "pipeline for testing purposes: it is used once, only a protected template may be stored (for " +
  "enrolments), and the image is discarded after analysis. Only test with your own biometrics or " +
  "with the explicit consent of the person being enrolled.";

type Modality = "face" | "fingerprint";
type Purpose = "enrolment" | "verification";

interface SessionInfo { clientToken: string; challenge: string; expiresAt: string }

export function VerifyLabClient({ allowImageUpload }: { allowImageUpload: boolean }) {
  const [configured, setConfigured] = useState<{ environmentKind: string; projectId: string } | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [modality, setModality] = useState<Modality>("fingerprint");
  const [purpose, setPurpose] = useState<Purpose>("enrolment");
  const [subjectRef, setSubjectRef] = useState("lab-subject-1");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/console/verify-lab", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok) throw new Error(data.error?.message ?? "Request failed.");
    return data;
  };

  const configure = async () => {
    setBusy(true); setError(null);
    try {
      const data = await post({ action: "configure", apiKey: keyInput });
      setConfigured({ environmentKind: String(data.environmentKind), projectId: String(data.projectId) });
      setKeyInput(""); // never keep the key in client state
    } catch (e) {
      setError(e instanceof Error ? e.message : "Configuration failed.");
    } finally {
      setBusy(false);
    }
  };

  const startSession = async () => {
    setBusy(true); setError(null); setSession(null);
    try {
      const data = await post({ action: "session", purpose, modality });
      setSession({ clientToken: String(data.clientToken), challenge: String(data.challenge), expiresAt: String(data.expiresAt) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create a capture session.");
    } finally {
      setBusy(false);
    }
  };

  if (!configured) {
    return (
      <section className="sec-card" aria-labelledby="vl-config-h">
        <h2 id="vl-config-h">Configure the lab</h2>
        <p className="sub">
          Paste a <strong>development or staging</strong> project API key. It is stored in an
          HttpOnly cookie for two hours and re-checked on every call. Production keys are refused.
        </p>
        <label>
          API key{" "}
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            autoComplete="off"
            aria-label="Project API key"
          />
        </label>
        <div className="capture-actions">
          <button className="btn" onClick={configure} disabled={busy || !keyInput}>
            {busy ? "Checking…" : "Use this key"}
          </button>
        </div>
        {error && <p role="alert" className="sec-alert">{error}</p>}
      </section>
    );
  }

  return (
    <>
      <section className="sec-card" aria-labelledby="vl-setup-h">
        <h2 id="vl-setup-h">Session setup</h2>
        <p className="sub">
          Environment: <span className="mono">{configured.environmentKind}</span> · Project:{" "}
          <span className="mono">{configured.projectId}</span>{" "}
          <button
            className="btn secondary"
            onClick={async () => { await post({ action: "reset" }).catch(() => undefined); setConfigured(null); setSession(null); }}
          >
            Forget key
          </button>
        </p>
        <div className="capture-actions" role="group" aria-label="Lab session options">
          <label>
            Modality{" "}
            <select value={modality} onChange={(e) => { setModality(e.target.value as Modality); setSession(null); }}>
              <option value="fingerprint">Fingerprint</option>
              <option value="face">Face</option>
            </select>
          </label>
          <label>
            Purpose{" "}
            <select value={purpose} onChange={(e) => { setPurpose(e.target.value as Purpose); setSession(null); }}>
              <option value="enrolment">Enrolment</option>
              <option value="verification">Verification</option>
            </select>
          </label>
          <label>
            Subject reference{" "}
            <input value={subjectRef} onChange={(e) => { setSubjectRef(e.target.value); setSession(null); }} aria-label="Subject reference" />
          </label>
          <button className="btn" onClick={startSession} disabled={busy || !subjectRef}>
            {busy ? "Creating…" : session ? "New capture session" : "Start capture session"}
          </button>
        </div>
        {error && <p role="alert" className="sec-alert">{error}</p>}
      </section>

      {session && modality === "face" && (
        <section className="sec-card" style={{ marginTop: 16 }}>
          <CaptureFlow
            key={session.clientToken}
            clientToken={session.clientToken}
            challenge={session.challenge}
            purpose={purpose}
            subjectRef={subjectRef}
            submitUrl="/api/console/verify-lab/submit"
            noticeVersion={NOTICE_VERSION}
            noticeText={NOTICE_TEXT}
          />
        </section>
      )}

      {session && modality === "fingerprint" && (
        <section className="sec-card" style={{ marginTop: 16 }}>
          <FingerprintFlow
            key={session.clientToken}
            clientToken={session.clientToken}
            purpose={purpose}
            subjectRef={subjectRef}
            submitUrl="/api/console/verify-lab/submit"
            noticeVersion={NOTICE_VERSION}
            noticeText={NOTICE_TEXT}
            allowImageUpload={allowImageUpload}
          />
        </section>
      )}
    </>
  );
}
