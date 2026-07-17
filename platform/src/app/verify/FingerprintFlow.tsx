"use client";

/**
 * Fingerprint capture flow — consent-first, honest about hardware reality.
 *
 * Unlike the face flow (browser camera), fingerprint capture requires the
 * BioCheck Capture Agent: a small local application bundling the scanner
 * vendor SDK (mission FP-004 — not yet built). This component probes for the
 * agent on localhost and states plainly when it is not available. It NEVER
 * simulates a scanner.
 *
 * Development-only escape hatch: when `allowImageUpload` is set (server-side
 * decision, never in production), a clearly-labelled file upload lets the team
 * exercise the full pipeline against the SourceAFIS sidecar before the agent
 * exists. Uploaded images follow the same one-use capture session path and are
 * discarded after analysis.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Step = "notice" | "source" | "uploading" | "result" | "error";

/** Future local agent contract (FP-004). Fixed loopback port, never remote. */
const AGENT_HEALTH_URL = "http://127.0.0.1:9310/agent/health";
const AGENT_CAPTURE_URL = "http://127.0.0.1:9310/agent/capture";

export interface FingerprintFlowProps {
  /** Issued server-side via POST /v1/capture-sessions (modality=fingerprint). */
  clientToken: string;
  purpose: "enrolment" | "verification";
  subjectRef: string;
  /** Endpoint that relays to /v1 with the tenant's server-side credentials. */
  submitUrl: string;
  noticeVersion: string;
  noticeText: string;
  /** Dev/test environments only — the server page must never set this in production. */
  allowImageUpload?: boolean;
}

const REASON_HINTS: Record<string, string> = {
  PAD_UNAVAILABLE_REVIEW_REQUIRED:
    "This capture device does not provide live-finger detection, so approvals are always confirmed by a human reviewer. This is a deliberate safety rule, not an error.",
  SERVICE_UNAVAILABLE:
    "The fingerprint matching service is not available right now, so the attempt was routed to human review instead of being guessed. Nothing was lost.",
  CAPTURE_QUALITY_INSUFFICIENT:
    "The capture was not clear enough. Clean the scanner surface, press evenly with the pad (not the tip) of your finger, and try again.",
  REFERENCE_NOT_FOUND:
    "No enrolled fingerprint was found for this person. Complete enrolment first.",
};

export function FingerprintFlow(props: FingerprintFlowProps) {
  const [step, setStep] = useState<Step>("notice");
  const [consented, setConsented] = useState(false);
  const [agentState, setAgentState] = useState<"probing" | "available" | "unavailable">("probing");
  const [message, setMessage] = useState<string | null>(null);
  const [decision, setDecision] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const liveRegionRef = useRef<HTMLParagraphElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const announce = (text: string) => {
    setMessage(text);
    liveRegionRef.current?.focus();
  };

  const probeAgent = useCallback(async () => {
    setAgentState("probing");
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(AGENT_HEALTH_URL, { signal: controller.signal });
      clearTimeout(timer);
      setAgentState(res.ok ? "available" : "unavailable");
    } catch {
      setAgentState("unavailable");
    }
  }, []);

  useEffect(() => {
    if (step === "source") void probeAgent();
  }, [step, probeAgent]);

  const submitImage = useCallback(
    async (imageB64: string) => {
      setStep("uploading");
      announce("Submitting your fingerprint capture. This takes a few seconds.");
      try {
        const res = await fetch(props.submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modality: "fingerprint",
            purpose: props.purpose,
            subjectRef: props.subjectRef,
            captureSessionToken: props.clientToken,
            imageB64,
            noticeVersion: props.noticeVersion,
          }),
        });
        const data = (await res.json()) as {
          decision?: string; reasonCode?: string; message?: string; error?: { message?: string };
        };
        if (!res.ok) {
          setStep("error");
          announce(data.error?.message ?? "Something went wrong. Request a new capture session and try again.");
          return;
        }
        setDecision(data.decision ?? "submitted");
        setReasonCode(data.reasonCode ?? null);
        setStep("result");
        announce(data.message ?? "Submitted.");
      } catch {
        setStep("error");
        announce("Submission failed. Nothing was stored. Please try again with a new capture session.");
      }
    },
    [props],
  );

  const captureViaAgent = async () => {
    announce("Place your finger flat on the scanner.");
    try {
      const res = await fetch(AGENT_CAPTURE_URL, { method: "POST" });
      if (!res.ok) throw new Error("agent capture failed");
      const data = (await res.json()) as { imageB64?: string };
      if (!data.imageB64) throw new Error("agent returned no image");
      await submitImage(data.imageB64);
    } catch {
      setStep("error");
      announce("The scanner could not complete the capture. Check the device connection and try again.");
    }
  };

  const uploadDevImage = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    await submitImage(btoa(binary));
  };

  return (
    <div className="capture-flow" role="region" aria-label={`Fingerprint ${props.purpose}`}>
      <p ref={liveRegionRef} tabIndex={-1} aria-live="polite" className="capture-status">
        {message}
      </p>

      {step === "notice" && (
        <section aria-labelledby="fp-notice-heading">
          <h2 id="fp-notice-heading">Before you start</h2>
          <p>{props.noticeText}</p>
          <ul>
            <li>Your fingerprint capture is used once, for this {props.purpose} only, then deleted after analysis.</li>
            <li>Only a protected mathematical template is kept — never the fingerprint image.</li>
            <li>You can stop at any time before submitting.</li>
          </ul>
          <label>
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              aria-describedby="fp-notice-heading"
            />{" "}
            I have read the notice (version {props.noticeVersion}) and I agree.
          </label>
          <div className="capture-actions">
            <button className="btn" disabled={!consented} onClick={() => setStep("source")}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === "source" && (
        <section aria-labelledby="fp-source-heading">
          <h2 id="fp-source-heading">Connect your fingerprint scanner</h2>

          {agentState === "probing" && <p>Checking for the BioCheck Capture Agent on this computer…</p>}

          {agentState === "available" && (
            <>
              <p>Scanner agent detected. Place your finger flat on the scanner, covering the window, and hold still.</p>
              <div className="capture-actions">
                <button className="btn" onClick={captureViaAgent}>Capture fingerprint</button>
                <button className="btn secondary" onClick={() => setStep("notice")}>Back</button>
              </div>
            </>
          )}

          {agentState === "unavailable" && (
            <>
              <p>
                The BioCheck Capture Agent was not found on this computer. Fingerprint capture requires a
                supported USB fingerprint scanner and the Capture Agent application, which is currently in
                development. No scanner simulation is provided — this screen only works with real hardware.
              </p>
              <div className="capture-actions">
                <button className="btn secondary" onClick={() => void probeAgent()}>Check again</button>
                <button className="btn secondary" onClick={() => setStep("notice")}>Back</button>
              </div>
              {props.allowImageUpload && (
                <div className="dev-upload">
                  <h3>Development testing only</h3>
                  <p>
                    Submit a fingerprint image file through the real pipeline (one-use session, template
                    extraction, matching, audit). Available only in development and test environments.
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/bmp"
                    aria-label="Fingerprint image file (development testing only)"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadDevImage(f);
                    }}
                  />
                </div>
              )}
            </>
          )}
        </section>
      )}

      {step === "uploading" && (
        <section aria-labelledby="fp-uploading-heading">
          <h2 id="fp-uploading-heading">Submitting…</h2>
          <p>{message}</p>
        </section>
      )}

      {step === "result" && (
        <section aria-labelledby="fp-result-heading">
          <h2 id="fp-result-heading">
            {decision === "approved" ? "Identity verified" : decision === "review" ? "Manual review needed" : "Not approved"}
          </h2>
          <p>{message}</p>
          {reasonCode && REASON_HINTS[reasonCode] && <p className="sub">{REASON_HINTS[reasonCode]}</p>}
          {decision === "review" && <p>A trained reviewer will check this shortly. You do not need to do anything else now.</p>}
        </section>
      )}

      {step === "error" && (
        <section aria-labelledby="fp-error-heading">
          <h2 id="fp-error-heading">We couldn&apos;t complete that</h2>
          <p>{message}</p>
          <p>Captures are single-use: ask for a new session link to try again. No image was kept.</p>
        </section>
      )}
    </div>
  );
}
