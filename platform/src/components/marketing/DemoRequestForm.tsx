"use client";

/**
 * Qualified demo-request form (Phase 6). Posts to /api/demo-requests.
 * Explicit consent checkbox is required; nothing is stored without it.
 * Includes a honeypot field ("website") that real users never see.
 */
import { useState } from "react";
import { usePathname } from "next/navigation";

const SECTORS = [
  ["healthcare", "Healthcare"],
  ["insurance", "Medical aid & insurance"],
  ["government", "Government"],
  ["workforce", "Workforce management"],
  ["financial-services", "Financial services"],
  ["elections", "Elections"],
  ["education", "Education"],
  ["telecommunications", "Telecommunications"],
  ["other", "Other"],
] as const;

const inputClass =
  "w-full rounded-lg border border-cloud/15 bg-cloud/5 px-4 py-3 text-cloud placeholder:text-cloud/35 " +
  "focus:border-cyan/60 focus:outline-none focus:ring-1 focus:ring-cyan/40";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

export function DemoRequestForm() {
  const pathname = usePathname();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/demo-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: data.get("fullName"),
          workEmail: data.get("workEmail"),
          organisation: data.get("organisation"),
          sector: data.get("sector"),
          country: data.get("country") || undefined,
          message: data.get("message") || undefined,
          consentedToContact: data.get("consent") === "on",
          website: data.get("website") || "",
          sourcePath: pathname,
        }),
      });
      if (res.ok) {
        setStatus({ kind: "sent" });
        form.reset();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setStatus({
        kind: "error",
        message: body?.error?.message ?? "Something went wrong. Please try again or email hello@biochecktech.com.",
      });
    } catch {
      setStatus({
        kind: "error",
        message: "We could not reach the server. Please try again or email hello@biochecktech.com.",
      });
    }
  }

  if (status.kind === "sent") {
    return (
      // Cyan, not green: the brand system reserves green for successful verification only.
      <div className="rounded-2xl border border-cyan/30 bg-cyan/10 p-8" role="status">
        <h2 className="font-display text-2xl font-bold text-cloud">Request received.</h2>
        <p className="mt-3 leading-relaxed text-cloud/70">
          Thank you — our team will come back to you at the work email you provided
          to arrange a tailored demonstration.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-5" noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="grid gap-2 text-sm text-cloud/70">
          Full name *
          <input name="fullName" required maxLength={120} autoComplete="name" className={inputClass} />
        </label>
        <label className="grid gap-2 text-sm text-cloud/70">
          Work email *
          <input name="workEmail" type="email" required maxLength={254} autoComplete="email" className={inputClass} />
        </label>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="grid gap-2 text-sm text-cloud/70">
          Organisation *
          <input name="organisation" required maxLength={160} autoComplete="organization" className={inputClass} />
        </label>
        <label className="grid gap-2 text-sm text-cloud/70">
          Sector *
          <select name="sector" required defaultValue="" className={inputClass}>
            <option value="" disabled>Select your sector</option>
            {SECTORS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="grid gap-2 text-sm text-cloud/70">
        Country
        <input name="country" maxLength={80} autoComplete="country-name" className={inputClass} />
      </label>
      <label className="grid gap-2 text-sm text-cloud/70">
        What do you need to verify?
        <textarea
          name="message" rows={4} maxLength={2000} className={inputClass}
          placeholder="e.g. member check-in across 12 clinics; workforce attendance at two sites"
        />
      </label>

      {/* Honeypot — hidden from real users, bots tend to fill it. */}
      <div className="hidden" aria-hidden="true">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <label className="flex items-start gap-3 text-sm leading-relaxed text-cloud/70">
        <input name="consent" type="checkbox" required className="mt-1 h-4 w-4 accent-cyan" />
        <span>
          I agree that BioCheck Technologies may store these details and contact
          me about this request. Your details are used for nothing else and are
          deleted on request. *
        </span>
      </label>

      {status.kind === "error" ? (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200" role="alert">
          {status.message}
        </p>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={status.kind === "sending"}
          className="rounded-lg bg-cyan px-8 py-3 font-semibold text-midnight shadow-glow transition
                     hover:bg-cyan/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status.kind === "sending" ? "Sending…" : "Request a demo"}
        </button>
      </div>
    </form>
  );
}
