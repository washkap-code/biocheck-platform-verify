# Verify-core deployment runbook

The verify-core facade is the private Python service in `biocheck_engine/api.py`.
It implements the platform contract:

- `POST /v1/analyse`
- `POST /v1/templates`
- `POST /v1/compare`
- `POST /v1/fingerprint/analyse`
- `POST /v1/fingerprint/templates`
- `POST /v1/fingerprint/compare`
- `GET /health`

It is not the SeetaFace6 sidecar. The facade sits between the platform and the
native sidecar, enforces approved model hashes, creates one-use capture refs,
encrypts templates, and fails closed.

## Image build

Build from the repository root:

```bash
docker build -f Dockerfile.verify-core -t biocheck-verify-core:staging .
```

The image installs only the Python package and API dependencies. It does not
copy `platform/`, model weights, `.env` files, native builds or test data.

## Local contract smoke test

For local development only:

```bash
export BIOCHECK_MASTER_KEY_B64="$(python -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')"
docker run --rm -p 8080:8080 \
  -e APP_ENV=development \
  -e VERIFY_CORE_DEV_FIXTURES=true \
  -e VERIFY_CORE_API_KEY=dev-only-contract-key \
  -e BIOCHECK_MASTER_KEY_B64="$BIOCHECK_MASTER_KEY_B64" \
  biocheck-verify-core:staging
```

Then smoke check:

```bash
curl -fsS http://localhost:8080/health
```

The dev fixture adapter consumes JSON fixtures, not real biometrics, and refuses
`APP_ENV=production`.

## Staging configuration

Run the facade on a private Linux host or private container service. Required
environment:

```bash
APP_ENV=staging
PORT=8080
VERIFY_CORE_API_KEY=<long random platform-to-facade secret>
VERIFY_CORE_SIDECAR_URL=https://seetaface-sidecar.internal
VERIFY_CORE_SIDECAR_API_KEY=<facade-to-sidecar secret>
VERIFY_CORE_APPROVED_MODELS_JSON='[
  {
    "model_id": "seetaface6-recognition-...",
    "sha256": "...",
    "purpose": "face_embedding",
    "commercial_use_approved": true,
    "evaluation_report_ref": "PILOT-...",
    "supplier": "SeetaFace6Open",
    "expires_on": "2027-..."
  },
  {
    "model_id": "seetaface6-pad-...",
    "sha256": "...",
    "purpose": "passive_pad",
    "commercial_use_approved": true,
    "evaluation_report_ref": "PILOT-...",
    "supplier": "SeetaFace6Open",
    "expires_on": "2027-..."
  }
]'
BIOCHECK_MASTER_KEY_B64=<dev/staging only until KMS/HSM adapter is wired>
```

Expose the service only through private networking plus HTTPS/mTLS. Set the
platform's `VERIFY_CORE_URL` to that private URL and set the platform's
`VERIFY_CORE_API_KEY` to the same value as the facade.

## Production restrictions

Do not run production with `VERIFY_CORE_DEV_FIXTURES=true`.

Before `APP_ENV=production`, the release record must include:

- SeetaFace6 sidecar binary hashes, compiler version and OS image digest.
- SHA-256 hashes of every deployed recognition, PAD, quality and detection
  model file.
- Approved model cards and independent evaluation references.
- KMS/HSM decision for template encryption.
- mTLS gateway configuration showing request bodies are not logged.
- Signed controlled-pilot report and penetration-test disposition.

The facade intentionally raises at startup if no face adapter is configured. A
broken or missing sidecar must stop the service rather than silently falling
back to a fixture provider.
