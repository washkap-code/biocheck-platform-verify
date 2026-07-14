/**
 * Document verification provider contract — modular, staged.
 *
 * IMPORTANT DISTINCTION (kept everywhere in UI/API copy): selfie-to-document
 * face matching does NOT by itself prove a document is genuine. Document
 * authenticity is assessed by these separate stages, and the synthetic local
 * provider validates NOTHING about real passports or IDs — it exists so the
 * workflow, storage and review paths can be built and tested without any
 * licensed document dataset.
 */

export type StageStatus = "pass" | "warn" | "fail" | "skipped";

export interface DocumentAnalysis {
  providerId: string;
  stages: {
    captureQuality: StageStatus;
    classification: StageStatus;
    ocrMrz: StageStatus;
    expiry: StageStatus;
    tamper: StageStatus;
    portrait: StageStatus;
  };
  documentClass: "passport" | "national_id" | "driver_licence" | "unknown";
  issuingCountry: string | null;
  /** FULL document number — consumed and masked by the service, never stored. */
  documentNumber: string | null;
  expiryDate: string | null;         // ISO date
  tamperSignals: string[];
  /** Opaque handle to the extracted reference portrait (provider boundary). */
  portraitCaptureRef: string | null;
}

export interface DocumentVerificationProvider {
  readonly providerId: string;
  analyseDocument(imageBytes: Uint8Array): Promise<DocumentAnalysis>;
}

/**
 * SYNTHETIC TEST PROVIDER — local development and automated tests only.
 * Fixtures are JSON documents pretending to be document photos:
 *   {"docClass":"passport","country":"ZW","number":"AB123456","expiry":"2030-01-01",
 *    "person":"alice","tamper":[],"quality":0.95}
 * It performs no real OCR and validates no real documents; it refuses to
 * instantiate in production, exactly like FakeProvider.
 */
export class SyntheticDocumentProvider implements DocumentVerificationProvider {
  readonly providerId = "synthetic-fixtures";
  /** portrait handles this provider has issued, readable by FakeProvider-compatible flows */
  readonly portraits = new Map<string, { person: string }>();

  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SyntheticDocumentProvider must never be instantiated in production.");
    }
  }

  async analyseDocument(imageBytes: Uint8Array): Promise<DocumentAnalysis> {
    let fixture: Record<string, unknown>;
    try {
      fixture = JSON.parse(Buffer.from(imageBytes).toString("utf8"));
    } catch {
      // Unreadable input: classification fails, everything downstream skipped.
      return {
        providerId: this.providerId,
        stages: { captureQuality: "fail", classification: "fail", ocrMrz: "skipped", expiry: "skipped", tamper: "skipped", portrait: "skipped" },
        documentClass: "unknown", issuingCountry: null, documentNumber: null,
        expiryDate: null, tamperSignals: [], portraitCaptureRef: null,
      };
    }

    const quality = Number(fixture.quality ?? 0.95);
    const tamperSignals = Array.isArray(fixture.tamper) ? (fixture.tamper as string[]) : [];
    const docClass = (["passport", "national_id", "driver_licence"].includes(String(fixture.docClass))
      ? String(fixture.docClass) : "unknown") as DocumentAnalysis["documentClass"];
    const expiry = typeof fixture.expiry === "string" ? fixture.expiry : null;
    const expired = expiry !== null && new Date(expiry) < new Date();
    const person = typeof fixture.person === "string" ? fixture.person : null;

    let portraitCaptureRef: string | null = null;
    if (person) {
      portraitCaptureRef = `docport_${Math.random().toString(36).slice(2)}`;
      this.portraits.set(portraitCaptureRef, { person });
    }

    return {
      providerId: this.providerId,
      stages: {
        captureQuality: quality >= 0.7 ? "pass" : "fail",
        classification: docClass === "unknown" ? "fail" : "pass",
        ocrMrz: fixture.number ? "pass" : "warn",
        expiry: expiry === null ? "warn" : expired ? "fail" : "pass",
        tamper: tamperSignals.length === 0 ? "pass" : "fail",
        portrait: portraitCaptureRef ? "pass" : "fail",
      },
      documentClass: docClass,
      issuingCountry: typeof fixture.country === "string" ? fixture.country.toUpperCase() : null,
      documentNumber: typeof fixture.number === "string" ? fixture.number : null,
      expiryDate: expiry,
      tamperSignals,
      portraitCaptureRef,
    };
  }
}

/** Masks a document number to its last 4 characters. The full value must not outlive the request. */
export function maskDocumentNumber(full: string | null): string | null {
  if (!full) return null;
  const tail = full.slice(-4);
  return `${"*".repeat(Math.max(full.length - 4, 2))}${tail}`;
}
