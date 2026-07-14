import base64
import os

import numpy as np

from .service import VerificationService
from .types import CaptureQuality, FaceSample, LivenessResult


def main() -> None:
    os.environ.setdefault("BIOCHECK_MASTER_KEY_B64", base64.urlsafe_b64encode(b"b" * 32).decode())
    engine = VerificationService()
    vector = np.ones(512, dtype=np.float32)
    quality = CaptureQuality(True, 0.95, 3.0, 0.02)
    sample = FaceSample(vector, quality, "approved-onnx-model", "replace-with-real-model-sha256")
    engine.enrol("demo-bank", "customer-123", sample, "consent-receipt-001")
    result = engine.verify("demo-bank", "customer-123", sample, LivenessResult(True, 0.99))
    print(result.decision.value, result.reason_code, f"similarity={result.similarity:.3f}")


if __name__ == "__main__":
    main()
