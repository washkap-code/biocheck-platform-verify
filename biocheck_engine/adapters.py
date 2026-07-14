from __future__ import annotations

from pathlib import Path
from typing import Protocol

import numpy as np

from .model_registry import ModelRegistry
from .types import CaptureQuality, FaceSample, LivenessResult


class FaceEmbeddingProvider(Protocol):
    def extract(self, aligned_rgb: np.ndarray) -> FaceSample: ...


class LivenessProvider(Protocol):
    def assess(self, challenge_frames: list[np.ndarray]) -> LivenessResult: ...


class OnnxEmbeddingProvider:
    """Adapter for one specifically approved ONNX embedding model.

    Detection/alignment happens before this adapter. Registration checks both
    the file content hash and its authorised purpose.
    """
    def __init__(self, model_path: str | Path, model_id: str, registry: ModelRegistry):
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise RuntimeError("Install optional dependency: pip install '.[onnx]'") from exc
        self.path = Path(model_path)
        self.model_id = model_id
        self.sha256 = registry.sha256_file(self.path)
        registry.assert_allowed(model_id, self.sha256, "face_embedding")
        self.session = ort.InferenceSession(str(self.path), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

    def extract(self, aligned_rgb: np.ndarray) -> FaceSample:
        if aligned_rgb.shape != (112, 112, 3):
            raise ValueError("Expected a pre-aligned 112x112 RGB face crop.")
        image = (aligned_rgb.astype(np.float32) - 127.5) / 128.0
        tensor = np.transpose(image, (2, 0, 1))[None, ...]
        output = np.asarray(self.session.run(None, {self.input_name: tensor})[0]).reshape(-1)
        output /= max(float(np.linalg.norm(output)), 1e-12)
        return FaceSample(output, CaptureQuality(True, 1.0, 0.0, 0.0), self.model_id, self.sha256)
