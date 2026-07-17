#!/usr/bin/env python3
"""FP-002: generate model-registry cards for a *running* fingerprint sidecar.

Queries the sidecar's /healthz, which reports the SHA-256 of the exact
SourceAFIS jar inside the deployed image, and emits the two ModelCard entries
(extraction + matching) ready to merge into VERIFY_CORE_APPROVED_MODELS_JSON.

This keeps a human in the loop deliberately: the operator runs the script,
reviews the output, and sets the env var. The engine's registry gate then
refuses any sidecar whose jar hash differs from what was approved.

Usage:
    python scripts/register_fp_sidecar.py --url http://localhost:8081 \
        --approved-by "Washington" [--expires 2027-12-31] [--merge-env]

    --merge-env  also prints the full VERIFY_CORE_APPROVED_MODELS_JSON value,
                 merging with the current environment value if present.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

LICENCE_EVAL_REF = (
    "SourceAFIS, Apache-2.0 (commercial use permitted). Vendor-reported accuracy: "
    "FVC-onGoing public results via https://sourceafis.machinezoo.com/ . "
    "BioCheck calibration evidence: pending FP-006 (until then, thresholds are placeholders)."
)


def fetch_health(url: str) -> dict:
    with urllib.request.urlopen(url.rstrip("/") + "/healthz", timeout=8) as r:
        health = json.load(r)
    for field in ("model_id", "matcher_model_id", "model_sha256"):
        if not health.get(field):
            raise SystemExit(f"Sidecar /healthz is missing '{field}' — refusing to emit cards.")
    if len(health["model_sha256"]) != 64:
        raise SystemExit("Sidecar reported an invalid SHA-256 — refusing to emit cards.")
    return health


def build_cards(health: dict, approved_by: str, expires: str) -> list[dict]:
    common = {
        "sha256": health["model_sha256"],
        "commercial_use_approved": True,
        "independent_report_ref": LICENCE_EVAL_REF,
        "approved_by": approved_by,
        "expires_on": expires,
    }
    return [
        {"model_id": health["model_id"], "purpose": "fingerprint_extraction", **common},
        {"model_id": health["matcher_model_id"], "purpose": "fingerprint_matching", **common},
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="fingerprint sidecar base URL")
    ap.add_argument("--approved-by", required=True,
                    help="name of the human approving these cards (recorded in the registry)")
    ap.add_argument("--expires", default="2027-12-31")
    ap.add_argument("--merge-env", action="store_true",
                    help="print the merged VERIFY_CORE_APPROVED_MODELS_JSON value")
    args = ap.parse_args()

    cards = build_cards(fetch_health(args.url), args.approved_by, args.expires)

    if args.merge_env:
        existing = json.loads(os.environ.get("VERIFY_CORE_APPROVED_MODELS_JSON", "[]"))
        replaced_ids = {c["model_id"] for c in cards}
        merged = [c for c in existing if c.get("model_id") not in replaced_ids] + cards
        print(json.dumps(merged, indent=2))
        print("\n# Set the above (minified) as VERIFY_CORE_APPROVED_MODELS_JSON", file=sys.stderr)
    else:
        print(json.dumps(cards, indent=2))


if __name__ == "__main__":
    main()
