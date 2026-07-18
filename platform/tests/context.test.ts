import { describe, expect, it } from "vitest";
import { ProviderUnavailableError } from "../src/server/verification/providers";
import { VerifyCoreContextClient } from "../src/server/context/client";

function clientWith(handler: (url: string, init: RequestInit) => Promise<Response>) {
  return new VerifyCoreContextClient({
    endpoint: "http://localhost:9999",
    apiKey: "test-key",
    transport: handler,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("VerifyCoreContextClient", () => {
  it("enforces HTTPS outside local development", () => {
    expect(
      () =>
        new VerifyCoreContextClient({
          endpoint: "http://engine.internal",
          apiKey: "k",
        }),
    ).toThrow(/HTTPS/);
  });

  it("sends bearer auth and maps step-up responses", async () => {
    let seenAuth = "";
    const client = clientWith(async (url, init) => {
      seenAuth = (init.headers as Record<string, string>).Authorization;
      expect(url).toContain("/v1/context/stepup/otp/issue");
      return jsonResponse({ status: "pending", reason_code: "OTP_ISSUED", challenge_id: "c1", method: "otp" });
    });
    const result = await client.issueOtp("t1", "s1");
    expect(seenAuth).toBe("Bearer test-key");
    expect(result).toEqual({ status: "pending", reasonCode: "OTP_ISSUED", challengeId: "c1", method: "otp" });
  });

  it("fails closed on transport errors", async () => {
    const client = clientWith(async () => {
      throw new Error("connection refused");
    });
    await expect(client.verifyOtp("c1", "123456")).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("fails closed on non-2xx status", async () => {
    const client = clientWith(async () => jsonResponse({ error: "nope" }, 503));
    await expect(client.evaluateLocation("t1", "s1", null)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("fails closed on malformed orchestration response", async () => {
    const client = clientWith(async () => jsonResponse({ outcome: "definitely", audit_hash: "" }));
    await expect(
      client.orchestrate({ tenantId: "t1", subjectRef: "s1", modalities: [] }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("maps a full orchestration round trip with snake_case conversion", async () => {
    let sentBody: Record<string, unknown> = {};
    const client = clientWith(async (url, init) => {
      expect(url).toContain("/v1/context/orchestrate");
      sentBody = JSON.parse(String(init.body));
      return jsonResponse({
        outcome: "step_up_required",
        reason_codes: ["DEVICE_UNKNOWN_STEP_UP"],
        policy_id: "biocheck-orchestration-v1",
        correlation_id: "corr-1",
        audit_hash: "abc123",
        signals: { device: "unknown" },
      });
    });
    const decision = await client.orchestrate({
      tenantId: "t1",
      subjectRef: "s1",
      modalities: [{ modality: "face", decision: "approved", reasonCode: "MATCH_CONFIRMED" }],
      device: { tenantId: "t1", subjectRef: "s1", deviceRef: "dev-a" },
      location: { latitude: -17.83, longitude: 31.05, countryCode: "ZW" },
    });
    expect(sentBody.tenant_id).toBe("t1");
    expect((sentBody.modalities as unknown[])[0]).toMatchObject({ modality: "face", reason_code: "MATCH_CONFIRMED" });
    expect((sentBody.location as Record<string, unknown>).country_code).toBe("ZW");
    expect(decision.outcome).toBe("step_up_required");
    expect(decision.auditHash).toBe("abc123");
  });

  it("maps device and location signals", async () => {
    const client = clientWith(async (url) => {
      if (url.includes("/device/observe")) {
        return jsonResponse({ level: "known", reason_code: "DEVICE_KNOWN", device_ref: "dev-a", sightings: 3 });
      }
      return jsonResponse({ risk: "elevated", reason_code: "IMPOSSIBLE_TRAVEL", matched_fence: null, computed_speed_kmh: 4820.5 });
    });
    const device = await client.observeDevice({ tenantId: "t1", subjectRef: "s1", deviceRef: "dev-a" });
    expect(device).toEqual({ level: "known", reasonCode: "DEVICE_KNOWN", sightings: 3 });
    const location = await client.evaluateLocation("t1", "s1", { latitude: 51.5, longitude: -0.13, countryCode: "GB" });
    expect(location.risk).toBe("elevated");
    expect(location.computedSpeedKmh).toBe(4820.5);
  });

  it("maps MRZ responses and always carries the honesty note", async () => {
    const client = clientWith(async () =>
      jsonResponse({
        status: "passed",
        reason_codes: ["MRZ_CONSISTENT"],
        format: "TD3",
        document_type: "P",
        issuing_state: "UTO",
        document_number: "L898902C3",
        nationality: "UTO",
        birth_date: "1974-08-12",
        expiry_date: "2012-04-15",
        sex: "F",
        surname: "ERIKSSON",
        given_names: "ANNA MARIA",
        checks: ["structure", "composite_check"],
        note: "MRZ internal consistency only — not proof of document genuineness.",
      }),
    );
    const mrz = await client.parseMrz(["line1", "line2"]);
    expect(mrz.status).toBe("passed");
    expect(mrz.surname).toBe("ERIKSSON");
    expect(mrz.note).toMatch(/genuineness/);
  });
});
