# BioCheck certification-readiness roadmap

## Certification claim discipline

BioCheck must not say it is “certified” until it can name the exact standard,
scope, test laboratory, report date and product/model version. Certification is
not a once-off property of a neural network: a model update, new camera, changed
threshold or new deployment context can require retesting.

## Target evidence stack

| Workstream | Target evidence | Owner | Release gate |
|---|---|---|---|
| Face verification | Independent 1:1 report: TAR at defined FAR, false non-match rate, demographic and capture-condition breakdown | ML assurance | Thresholds approved |
| Liveness/PAD | Testing/reporting aligned to ISO/IEC 30107-3:2023; attack presentation coverage | Accredited PAD lab | No high-risk remote flow without pass |
| Model interoperability | ISO/IEC 19794-5 facial image data checks where applicable | Platform | Capture/export format accepted |
| Information security | ISO/IEC 27001 ISMS certification programme; threat model, secure SDLC, penetration test, vulnerability management | CISO | Critical findings closed |
| Privacy | POPIA DPIA, operator agreements, retention schedule, subject-rights workflow and cross-border transfer assessment | DPO/legal | Signed assessment |
| AI governance | ISO/IEC 42001 programme; model cards, human oversight, incident response and bias monitoring | Responsible AI lead | Governance board approval |
| External benchmarking | NIST FRTE participation for 1:1 when submission window/requirements permit; published results are not a certification | ML assurance | Submission accepted |

## Delivery phases

### Phase 0 — scope and lawful basis (weeks 1–4)

Restrict v1 to consent-led 1:1 verification for access/onboarding. Exclude public
space identification, covert collection, children and automated adverse decisions.
Complete a DPIA, threat model, data map and model-governance charter.

### Phase 1 — secure MVP (weeks 4–12)

Ship the core pattern in this repository with a licensed model adapter, device
attestation, encrypted object store for optional evidence, HSM/KMS-backed keys,
tenant RBAC, WORM audit export, rate limiting and a human-review console.

### Phase 2 — data and performance (months 3–7)

Collect only consented, documented, representative data. Split by person (never
by image) into train/validation/test sets. Test age, sex, skin tone where lawful
and appropriate, camera class, lighting, pose, occlusion, accessibility and ID
document types. Establish operating points from business risk, not marketing.

### Phase 3 — adversarial assurance (months 5–9)

Commission PAD testing covering printed photos, screen replay, injected video,
3D masks, synthetic/deepfake video and device/root/jailbreak attacks. Conduct an
external application penetration test and red-team the enrolment and recovery
flows.

### Phase 4 — independent assessment and controlled launch (months 8–12)

Commission independent verification/PAD evaluation. Complete ISO 27001 and 42001
certification programmes at organisational scope where commercially needed.
Launch with monitored pilots, documented fallback/manual review and monthly drift,
bias and attack reports.

## Key sources and standards

- ISO/IEC 30107-3:2023 supersedes the withdrawn 2017 edition and covers testing
  and reporting for biometric presentation-attack detection.
- NIST FATE PAD evaluates passive, software-based PAD algorithms; its current
  submission status should be checked before planning a submission.
- NIST FRTE is the appropriate independent benchmark family for face verification.
- Under South Africa's POPIA, biometric information is special personal
  information; processing requires a documented lawful route and safeguards.

This is an engineering roadmap, not legal advice. Each deployment country and
customer sector needs local counsel review.
