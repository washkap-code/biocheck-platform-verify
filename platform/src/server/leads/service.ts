/**
 * Demo-request lead capture (Phase 6).
 *
 * Public, unauthenticated input — treated accordingly: strict validation,
 * explicit consent required, rate-limited by salted IP hash at the route,
 * honeypot-filtered, and nothing beyond what the visitor typed is stored.
 * Leads are commercial contact records, NOT identity subjects: this table is
 * completely separate from subjects/consent_receipts and holds no biometrics.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";

export const LEAD_SECTORS = [
  "healthcare", "insurance", "government", "workforce",
  "financial-services", "elections", "education", "telecommunications", "other",
] as const;
export type LeadSector = (typeof LEAD_SECTORS)[number];

export class LeadValidationError extends Error {
  readonly status = 422;
  constructor(message: string, readonly code = "INVALID_LEAD") {
    super(message);
  }
}

export interface DemoRequestInput {
  fullName: string;
  workEmail: string;
  organisation: string;
  sector: string;
  country?: string;
  message?: string;
  consentedToContact: boolean;
  sourcePath?: string;
  ipHash?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanText(value: unknown, field: string, max: number, required: boolean): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw new LeadValidationError(`${field} is required.`);
    return null;
  }
  if (text.length > max) throw new LeadValidationError(`${field} must be at most ${max} characters.`);
  // Defensive: strip control characters; the DB layer is parameterised anyway.
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

export async function createDemoRequest(db: Db, input: DemoRequestInput): Promise<{ id: string }> {
  const fullName = cleanText(input.fullName, "Full name", 120, true)!;
  const workEmail = cleanText(input.workEmail, "Work email", 254, true)!.toLowerCase();
  const organisation = cleanText(input.organisation, "Organisation", 160, true)!;
  const country = cleanText(input.country, "Country", 80, false);
  const message = cleanText(input.message, "Message", 2000, false);
  const sourcePath = cleanText(input.sourcePath, "Source", 200, false);

  if (!EMAIL_RE.test(workEmail)) throw new LeadValidationError("Work email is not a valid email address.");
  if (!LEAD_SECTORS.includes(input.sector as LeadSector)) {
    throw new LeadValidationError("Sector must be one of the listed industries.");
  }
  if (input.consentedToContact !== true) {
    throw new LeadValidationError("We can only store your details with your consent to be contacted.", "CONSENT_REQUIRED");
  }

  const id = randomUUID();
  await db.query(
    `INSERT INTO demo_requests (id, full_name, work_email, organisation, sector, country, message,
       consented_to_contact, source_path, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, fullName, workEmail, organisation, input.sector, country, message,
     true, sourcePath, input.ipHash ?? null],
  );
  return { id };
}

/** Console/ops listing — aggregates and contact fields only, never ip_hash. */
export async function listDemoRequests(db: Db, status?: string) {
  const filter = status ? `WHERE status = $1` : "";
  const params = status ? [status] : [];
  const { rows } = await db.query(
    `SELECT id, full_name, work_email, organisation, sector, country, message, status, created_at
     FROM demo_requests ${filter} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  return rows;
}
