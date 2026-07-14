/**
 * OpenAPI 3.1 document for the BioCheck /v1 API. This object is the source the
 * developer portal renders from — it is generated code, not marketing copy.
 * No accuracy, certification or compliance claims belong in here.
 */
export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "BioCheck Verify API",
    version: "1.0.0-beta",
    description:
      "Consent-led 1:1 biometric verification. All create operations accept an Idempotency-Key header. " +
      "Authentication: project/environment API key as a Bearer token. Webhooks are HMAC-SHA256 signed " +
      "(X-BioCheck-Signature: v1=<hex>, over '<timestamp>.<body>'); consumers should reject stale timestamps " +
      "and deduplicate on X-BioCheck-Event-Id.",
  },
  servers: [{ url: "https://api.biochecktech.com" }],
  components: {
    securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "Project API key (bck_<env>_...)" } },
    schemas: {
      Error: {
        type: "object",
        properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } },
      },
      Consent: {
        type: "object",
        required: ["noticeVersion", "purpose", "lawfulBasis"],
        properties: {
          noticeVersion: { type: "string" }, purpose: { type: "string" }, lawfulBasis: { type: "string" },
          retentionExpiresAt: { type: "string", format: "date-time" }, evidenceRef: { type: "string" },
        },
      },
      CaptureSession: {
        type: "object",
        properties: {
          captureSessionId: { type: "string", format: "uuid" },
          clientToken: { type: "string", description: "Single-use, expires in 10 minutes. Shown once." },
          challenge: { type: "string", description: "Active liveness challenge instruction id." },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
      VerificationOutcome: {
        type: "object",
        properties: {
          verificationId: { type: "string", format: "uuid" },
          decision: { type: "string", enum: ["approved", "review", "rejected"] },
          reasonCode: { type: "string" },
          message: { type: "string", description: "Human-safe message for the end user." },
          reviewCaseId: { type: "string", format: "uuid" },
        },
      },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    "/v1/capture-sessions": {
      post: {
        summary: "Create a capture session",
        description: "Short-lived, one-use, nonce-bound. Requires scope verification:create.",
        parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["purpose"], properties: { purpose: { type: "string", enum: ["enrolment", "verification"] } } } } },
        },
        responses: {
          "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/CaptureSession" } } } },
          "401": { description: "Missing/invalid API key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/v1/subjects/{subjectRef}/enrolments": {
      post: {
        summary: "Enrol a reference template",
        description: "Consent object is mandatory. Requires scope enrolment:create. The capture image is analysed and discarded; only an encrypted template is stored.",
        parameters: [
          { name: "subjectRef", in: "path", required: true, schema: { type: "string" }, description: "Tenant-scoped opaque reference. Never a national ID number." },
          { name: "Idempotency-Key", in: "header", schema: { type: "string" } },
        ],
        requestBody: {
          content: { "application/json": { schema: {
            type: "object", required: ["captureSessionToken", "imageB64", "consent"],
            properties: {
              captureSessionToken: { type: "string" }, imageB64: { type: "string" },
              consent: { $ref: "#/components/schemas/Consent" },
              sourceType: { type: "string", enum: ["live_capture", "document_portrait"] },
            },
          } } },
        },
        responses: {
          "201": { description: "Enrolled" },
          "409": { description: "Capture session invalid/used" },
          "422": { description: "Quality/liveness insufficient or consent missing" },
        },
      },
    },
    "/v1/verifications": {
      post: {
        summary: "Verify a subject (1:1)",
        description: "Requires scope verification:create. Fail-closed: provider outage or unknown model routes to review, never approval.",
        parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }],
        requestBody: {
          content: { "application/json": { schema: {
            type: "object", required: ["subjectRef", "captureSessionToken", "imageB64"],
            properties: { subjectRef: { type: "string" }, captureSessionToken: { type: "string" }, imageB64: { type: "string" } },
          } } },
        },
        responses: { "201": { description: "Outcome", content: { "application/json": { schema: { $ref: "#/components/schemas/VerificationOutcome" } } } } },
      },
    },
    "/v1/verifications/{id}": {
      get: {
        summary: "Fetch a verification",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Verification" }, "404": { description: "Not found" } },
      },
    },
    "/v1/verifications/{id}/review": {
      post: {
        summary: "Decide a review case (human only)",
        description: "Requires a signed-in reviewer with reviews:decide. API keys cannot decide reviews. A written reason is mandatory.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          content: { "application/json": { schema: {
            type: "object", required: ["organisationId", "outcome", "reason"],
            properties: { organisationId: { type: "string" }, outcome: { type: "string", enum: ["approved", "rejected"] }, reason: { type: "string" } },
          } } },
        },
        responses: { "200": { description: "Decided" }, "401": { description: "No reviewer session" }, "404": { description: "No open review case" } },
      },
    },
    "/v1/consents/{id}/withdraw": {
      post: {
        summary: "Withdraw consent",
        description: "Idempotent. Revokes active templates for the consent and emits consent.withdrawn.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "Withdrawn" }, "404": { description: "Not found" } },
      },
    },
  },
} as const;
