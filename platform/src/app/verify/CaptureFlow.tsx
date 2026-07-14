"use client";

/**
 * Guided capture flow — accessibility-aware, consent-first.
 * Steps: notice/consent → instructions → active random challenge → capture →
 * direct upload to the short-lived endpoint → result.
 *
 * Privacy behaviour: the captured frame goes ONLY to the one-use capture
 * endpoint and is discarded after analysis (zero retention by default).
 * Nothing is stored in the browser. No accuracy or certification claims.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Step = "notice" | "instructions" | "challenge" | "capturing" | "uploading" | "result" | "error";

export interface CaptureFlowProps {
  /** Issued server-side via POST /v1/capture-sessions; never minted in the browser. */
  clientToken: string;
  challenge: string;
  purpose: "enrolment" | "verification";
  subjectRef: string;
  /** Endpoint that relays to /v1 with the tenant's server-side credentials. */
  submitUrl: string;
  noticeVersion: string;
  noticeText: string;
}

const CHALLENGE_LABELS: Record<string, string> = {
  "turn-head-left": "Slowly turn your head to the left",
  "turn-head-right": "Slowly turn your head to the right",
  "blink-twice": "Blink twice",
  "look-up": "Look up briefly, then back at the camera",
  smile: "Smile naturally",
};

export function CaptureFlow(props: CaptureFlowProps) {
  const [step, setStep] = useState<Step>("notice");
  const [consented, setConsented] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [decision, setDecision] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const liveRegionRef = useRef<HTMLParagraphElement>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const announce = (text: string) => {
    setMessage(text);
    liveRegionRef.current?.focus();
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setStep("challenge");
      announce(`Camera ready. ${CHALLENGE_LABELS[props.challenge] ?? props.challenge}.`);
    } catch {
      setStep("error");
      announce("We could not access your camera. Check permissions and try again. Your capture session has not been used.");
    }
  };

  const captureAndSubmit = async () => {
    const video = videoRef.current;
    if (!video || !streamRef.current) return;
    setStep("uploading");
    announce("Uploading your capture for verification. This takes a few seconds.");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      stopCamera();
      const blob: Blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("capture failed"))), "image/jpeg", 0.92),
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const imageB64 = btoa(binary);
      // Canvas data is not retained; the canvas leaves scope immediately.
      const res = await fetch(props.submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose: props.purpose,
          subjectRef: props.subjectRef,
          captureSessionToken: props.clientToken,
          imageB64,
          noticeVersion: props.noticeVersion,
        }),
      });
      const data = (await res.json()) as { decision?: string; message?: string; error?: { message?: string } };
      if (!res.ok) {
        setStep("error");
        announce(data.error?.message ?? "Something went wrong. You can request a new capture session and try again.");
        return;
      }
      setDecision(data.decision ?? "submitted");
      setStep("result");
      announce(data.message ?? "Submitted.");
    } catch {
      stopCamera();
      setStep("error");
      announce("Upload failed. Nothing was stored. Please try again with a new capture session.");
    }
  };

  return (
    <div className="capture-flow" role="region" aria-label={`Identity ${props.purpose}`}>
      <p ref={liveRegionRef} tabIndex={-1} aria-live="polite" className="capture-status">
        {message}
      </p>

      {step === "notice" && (
        <section aria-labelledby="capture-notice-heading">
          <h2 id="capture-notice-heading">Before you start</h2>
          <p>{props.noticeText}</p>
          <ul>
            <li>Your capture is used once, for this {props.purpose} only, then deleted after analysis.</li>
            <li>Nothing is stored on this device or in your browser.</li>
            <li>You can stop at any time before submitting.</li>
          </ul>
          <label>
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              aria-describedby="capture-notice-heading"
            />{" "}
            I have read the notice (version {props.noticeVersion}) and I agree.
          </label>
          <div className="capture-actions">
            <button className="btn" disabled={!consented} onClick={() => setStep("instructions")}>
              Continue
            </button>
          </div>
        </section>
      )}

      {step === "instructions" && (
        <section aria-labelledby="capture-instructions-heading">
          <h2 id="capture-instructions-heading">Getting a good capture</h2>
          <ul>
            <li>Find even light on your face; avoid strong backlight.</li>
            <li>Remove sunglasses and anything covering your face.</li>
            <li>Hold the device at eye level, about arm's length away.</li>
          </ul>
          <div className="capture-actions">
            <button className="btn" onClick={startCamera}>Open camera</button>
            <button className="btn secondary" onClick={() => setStep("notice")}>Back</button>
          </div>
        </section>
      )}

      {(step === "challenge" || step === "uploading") && (
        <section aria-labelledby="capture-challenge-heading">
          <h2 id="capture-challenge-heading">{CHALLENGE_LABELS[props.challenge] ?? "Follow the on-screen instruction"}</h2>
          {/* Mirrored preview; decorative — the live region carries state for screen readers. */}
          <video ref={videoRef} autoPlay playsInline muted aria-hidden="true" className="capture-video" />
          <div className="capture-actions">
            <button className="btn" onClick={captureAndSubmit} disabled={step === "uploading"}>
              {step === "uploading" ? "Uploading…" : "Capture and submit"}
            </button>
            <button
              className="btn secondary"
              onClick={() => { stopCamera(); setStep("instructions"); announce("Camera closed. Nothing was captured."); }}
              disabled={step === "uploading"}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {step === "result" && (
        <section aria-labelledby="capture-result-heading">
          <h2 id="capture-result-heading">
            {decision === "approved" ? "Identity verified" : decision === "review" ? "Manual review needed" : "Not approved"}
          </h2>
          <p>{message}</p>
          {decision === "review" && <p>A trained reviewer will check this shortly. You do not need to do anything else now.</p>}
        </section>
      )}

      {step === "error" && (
        <section aria-labelledby="capture-error-heading">
          <h2 id="capture-error-heading">We couldn't complete that</h2>
          <p>{message}</p>
          <p>Captures are single-use: ask for a new session link to try again. No image was kept.</p>
        </section>
      )}
    </div>
  );
}
