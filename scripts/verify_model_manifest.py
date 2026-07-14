"""Verify a downloaded SeetaFace release against BioCheck's pinned manifest."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: verify_model_manifest.py MANIFEST.json UNPACKED_MODEL_DIRECTORY")
        return 2
    manifest = json.loads(Path(sys.argv[1]).read_text())
    root = Path(sys.argv[2])
    failed = []
    for model in manifest["models"]:
        actual = sha256(root / model["path"])
        if actual != model["sha256"]:
            failed.append(model["path"])
        print(f"{model['path']}: {'OK' if actual == model['sha256'] else 'MISMATCH'}")
    if failed:
        print("REFUSING RELEASE: " + ", ".join(failed))
        return 1
    print("MODEL MANIFEST VERIFIED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
