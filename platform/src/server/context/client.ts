/**
 * Client for verify-core's context & document endpoints
 * (/v1/context/*, /v1/documents/mrz — biocheck_engine/api_context.py).
 *
 * Same discipline as VerifyCoreProvider: fail closed on any transport error,
 * timeout or malformed response (ProviderUnavailableError → callers route to
 * REVIEW, never approve); bearer auth; HTTPS enforced outside local dev;
 * request bodies never logged.
 *
 * Honesty notes mirrored from the engine:
 * - Orchestration context can never upgrade a failed/review biometric.
 * - MRZ results prove internal consistency only, not document genuineness.
 * - OTP delivery (SMS/e-mail) is not integrated; dev fixtures may return a
 *   dev_otp field which MUST NOT be surfaced to end users.
 */
import {
  ProviderUnavailableError,
  type VerifyCoreConfig,
} from "../verification/providers";

export type StepUpStatus = "satisfied" | "pending" | "denied";
export type DeviceTrustLevel = "trusted" | "known" | "unknown" | "blocked";
export type LocationRisk = "normal" | "elevated" | "deny" | "unknown";
export type OrchestratedOutcome = "approved" | "step_up_required" | "review" | "rejected";
export type MrzStatus = "passed" | "review" | "failed";

export interface StepUpResponse {
  status: StepUpStatus;
  reasonCode: string;
  challengeId: string | null;
  method: string | null;
}

export interface DeviceObservation {
  tenantId: string;
  subjectRef: string;
  deviceRef: string;
  attestation?: { verdict: "passed" | "failed" | "unavailable"; mechanism: string; attestedAtMs: number };
}

export interface DeviceSignalResponse {
  level: DeviceTrustLevel;
  reasonCode: string;
  sightings: number;
}

export interface LocationInput {
  latitude: number;
  longitude: number;
  countryCode?: string | null;
  source?: string;
  observedAtMs?: number | null;
}

export interface LocationSignalResponse {
  risk: LocationRisk;
  reasonCode: string;
  matchedFence: string | null;
  computedSpeedKmh: number | null;
}

export interface ModalityOutcomeInput {
  modality: "face" | "fingerprint";
  decision: "approved" | "review" | "rejected";
  reasonCode: string;
  correlationId?: string | null;
}

export interface OrchestrateInput {
  tenantId: string;
  subjectRef: string;
  modalities: ModalityOutcomeInput[];
  device?: DeviceObservation;
  location?: LocationInput;
  stepUp?: { status: StepUpStatus; reasonCode: string };
  requiredModalities?: string[];
}

export interface OrchestratedDecisionResponse {
  outcome: OrchestratedOutcome;
  reasonCodes: string[];
  policyId: string;
  correlationId: string;
  auditHash: string;
  signals: Record<string, string>;
}

export interface MrzResponse {
  status: MrzStatus;
  reasonCodes: string[];
  format: string | null;
  documentType: string | null;
  issuingState: string | null;
  documentNumber: string | null;
  nationality: string | null;
  birthDate: string | null;
  expiryDate: string | null;
  sex: string | null;
  surname: string | null;
  givenNames: string | null;
  checks: string[];
  /** Always present, always honest: consistency only, not genuineness. */
  note: string;
}

export class VerifyCoreContextClient {
  private readonly timeoutMs: number;
  private readonly transport: (url: string, init: RequestInit) => Promise<Response>;

  constructor(private readonly config: VerifyCoreConfig) {
    const url = new URL(config.endpoint);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(isLocal && process.env.NODE_ENV !== "production")) {
      throw new Error("verify-core endpoint must be HTTPS (mTLS) outside local development.");
    }
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.transport = config.transport ?? ((u, init) => fetch(u, init));
  }

  private async post<T>(path: string, body: object): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.transport(`${this.config.endpoint.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          "X-BioCheck-Data-Classification": "identity-sensitive",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new ProviderUnavailableError(`verify-core returned ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw err;
      throw new ProviderUnavailableError("verify-core unreachable; context evaluation must fail closed.");
    } finally {
      clearTimeout(timer);
    }
  }

  private toStepUp(data: Record<string, unknown>): StepUpResponse {
    const status = String(data.status);
    if (!["satisfied", "pending", "denied"].includes(status)) {
      throw new ProviderUnavailableError("verify-core step-up response malformed.");
    }
    return {
      status: status as StepUpStatus,
      reasonCode: String(data.reason_code ?? ""),
      challengeId: (data.challenge_id as string) ?? null,
      method: (data.method as string) ?? null,
    };
  }

  async issueOtp(tenantId: string, subjectRef: string): Promise<StepUpResponse> {
    // NOTE: never forward dev_otp to clients; it exists for dev fixtures only.
    const data = await this.post<Record<string, unknown>>("/v1/context/stepup/otp/issue", {
      tenant_id: tenantId,
      subject_ref: subjectRef,
    });
    return this.toStepUp(data);
  }

  async verifyOtp(challengeId: string, otp: string): Promise<StepUpResponse> {
    const data = await this.post<Record<string, unknown>>("/v1/context/stepup/otp/verify", {
      challenge_id: challengeId,
      otp,
    });
    return this.toStepUp(data);
  }

  async enrolPin(tenantId: string, subjectRef: string, pin: string): Promise<void> {
    const data = await this.post<Record<string, unknown>>("/v1/context/stepup/pin/enrol", {
      tenant_id: tenantId,
      subject_ref: subjectRef,
      pin,
    });
    if (data.enrolled !== true) throw new ProviderUnavailableError("verify-core PIN enrol response malformed.");
  }

  async verifyPin(tenantId: string, subjectRef: string, pin: string): Promise<StepUpResponse> {
    const data = await this.post<Record<string, unknown>>("/v1/context/stepup/pin/verify", {
      tenant_id: tenantId,
      subject_ref: subjectRef,
      pin,
    });
    return this.toStepUp(data);
  }

  async observeDevice(input: DeviceObservation): Promise<DeviceSignalResponse> {
    const data = await this.post<Record<string, unknown>>("/v1/context/device/observe", {
      tenant_id: input.tenantId,
      subject_ref: input.subjectRef,
      device_ref: input.deviceRef,
      attestation: input.attestation
        ? {
            verdict: input.attestation.verdict,
            mechanism: input.attestation.mechanism,
            attested_at_ms: input.attestation.attestedAtMs,
          }
        : null,
    });
    const level = String(data.level);
    if (!["trusted", "known", "unknown", "blocked"].includes(level)) {
      throw new ProviderUnavailableError("verify-core device response malformed.");
    }
    return {
      level: level as DeviceTrustLevel,
      reasonCode: String(data.reason_code ?? ""),
      sightings: Number(data.sightings ?? 0),
    };
  }

  async evaluateLocation(tenantId: string, subjectRef: string,
                         observation: LocationInput | null): Promise<LocationSignalResponse> {
    const data = await this.post<Record<string, unknown>>("/v1/context/location/evaluate", {
      tenant_id: tenantId,
      subject_ref: subjectRef,
      observation: observation
        ? {
            latitude: observation.latitude,
            longitude: observation.longitude,
            country_code: observation.countryCode ?? null,
            source: observation.source ?? "unspecified",
            observed_at_ms: observation.observedAtMs ?? null,
          }
        : null,
    });
    const risk = String(data.risk);
    if (!["normal", "elevated", "deny", "unknown"].includes(risk)) {
      throw new ProviderUnavailableError("verify-core location response malformed.");
    }
    return {
      risk: risk as LocationRisk,
      reasonCode: String(data.reason_code ?? ""),
      matchedFence: (data.matched_fence as string) ?? null,
      computedSpeedKmh: data.computed_speed_kmh == null ? null : Number(data.computed_speed_kmh),
    };
  }

  async orchestrate(input: OrchestrateInput): Promise<OrchestratedDecisionResponse> {
    const data = await this.post<Record<string, unknown>>("/v1/context/orchestrate", {
      tenant_id: input.tenantId,
      subject_ref: input.subjectRef,
      modalities: input.modalities.map((m) => ({
        modality: m.modality,
        decision: m.decision,
        reason_code: m.reasonCode,
        correlation_id: m.correlationId ?? null,
      })),
      device: input.device
        ? {
            tenant_id: input.device.tenantId,
            subject_ref: input.device.subjectRef,
            device_ref: input.device.deviceRef,
            attestation: input.device.attestation
              ? {
                  verdict: input.device.attestation.verdict,
                  mechanism: input.device.attestation.mechanism,
                  attested_at_ms: input.device.attestation.attestedAtMs,
                }
              : null,
          }
        : null,
      location: input.location
        ? {
            latitude: input.location.latitude,
            longitude: input.location.longitude,
            country_code: input.location.countryCode ?? null,
            source: input.location.source ?? "unspecified",
            observed_at_ms: input.location.observedAtMs ?? null,
          }
        : null,
      step_up: input.stepUp
        ? { status: input.stepUp.status, reason_code: input.stepUp.reasonCode }
        : null,
      required_modalities: input.requiredModalities ?? null,
    });
    const outcome = String(data.outcome);
    if (!["approved", "step_up_required", "review", "rejected"].includes(outcome) || !data.audit_hash) {
      throw new ProviderUnavailableError("verify-core orchestration response malformed.");
    }
    return {
      outcome: outcome as OrchestratedOutcome,
      reasonCodes: (data.reason_codes as string[]) ?? [],
      policyId: String(data.policy_id ?? ""),
      correlationId: String(data.correlation_id ?? ""),
      auditHash: String(data.audit_hash),
      signals: (data.signals as Record<string, string>) ?? {},
    };
  }

  async parseMrz(lines: string[]): Promise<MrzResponse> {
    const data = await this.post<Record<string, unknown>>("/v1/documents/mrz", { lines });
    const status = String(data.status);
    if (!["passed", "review", "failed"].includes(status)) {
      throw new ProviderUnavailableError("verify-core MRZ response malformed.");
    }
    return {
      status: status as MrzStatus,
      reasonCodes: (data.reason_codes as string[]) ?? [],
      format: (data.format as string) ?? null,
      documentType: (data.document_type as string) ?? null,
      issuingState: (data.issuing_state as string) ?? null,
      documentNumber: (data.document_number as string) ?? null,
      nationality: (data.nationality as string) ?? null,
      birthDate: (data.birth_date as string) ?? null,
      expiryDate: (data.expiry_date as string) ?? null,
      sex: (data.sex as string) ?? null,
      surname: (data.surname as string) ?? null,
      givenNames: (data.given_names as string) ?? null,
      checks: (data.checks as string[]) ?? [],
      note: String(data.note ?? "MRZ internal consistency only — not proof of document genuineness."),
    };
  }
}
