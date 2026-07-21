"""
BioCheck Python minutiae extractor + matcher.

Why this exists (read before assuming this is SourceAFIS):
The originally authored sidecar (`sidecar-fingerprint/`, Java + SourceAFIS
3.18.1) has never been compiled or run anywhere — see
`docs/FINGERPRINT_BUILD_STATUS.md`. Building it requires a JDK 17 + Maven
toolchain; this build environment has no root access (cannot install system
packages) and its network egress allowlist blocks both Maven Central and
Eclipse Adoptium, so that toolchain cannot be assembled here either.

This module is a from-scratch, classical (non-learned) minutiae-based
fingerprint matcher implemented entirely with numpy / OpenCV / scikit-image,
all of which were installable in this environment. It speaks the exact same
wire contract as the Java sidecar (see `providers/fingerprint.py` in the
engine), so it is a drop-in alternative provider, not a patch to the engine.

Algorithm (classical, well-established techniques — not a novel or learned
model, and NOT SourceAFIS):
  1. CLAHE contrast normalisation + Otsu binarisation of ridge structure.
  2. Skeletonisation (skimage.morphology.skeletonize).
  3. Minutiae extraction via the crossing-number method on the skeleton
     (ridge endings: CN==1, bifurcations: CN==3), with border/edge pruning.
  4. Per-minutia orientation from the local gradient-based ridge
     orientation field (block-wise least-squares of squared gradients —
     the standard approach used in most fingerprint literature).
  5. Matching: alignment search over candidate (dx, dy, dtheta) implied by
     each minutia pair across the two templates (a simplified, unranked
     analogue of the classic Bozorth3 approach), scoring by counting
     inlier minutiae pairs under the best-fitting rigid transform.

Explicitly NOT included, and NOT claimed:
  - No presentation-attack detection (PAD). Liveness is hardware-dependent
    and cannot be produced in software alone; `pad` is always returned as
    null, exactly like the (unbuilt) Java sidecar's documented behaviour.
  - No NFIQ2-standard quality scoring — `quality.score` is the same
    transparent proxy (`min(1, minutiae_count / 40)`) already documented
    for the Java sidecar, carried over for consistency, not because it is
    validated.
  - No calibration against any real fingerprint dataset (NIST SD, FVC, or
    otherwise). The score returned by /v1/compare is a bounded [0,1]
    similarity coefficient from this specific algorithm; it has no known
    correspondence to industry FMR/FNMR figures until a real calibration
    pass is run against a real validation set. Treat it exactly like the
    Java sidecar's own placeholder score mapping: internal, provisional,
    not a certified accuracy claim.
  - No scanner/capture-device integration. This service only ever receives
    image bytes that something else captured; it has no opinion on how.

Classification per PRODUCT_REALITY_MATRIX.md: this upgrades the fingerprint
*matching software* from "authored but never compiled or run" to "compiled,
running, and passing its own conformance tests" (see test_conformance.py).
It does NOT upgrade fingerprint verification to "enterprise grade" or
"production" — real scanner hardware, PAD, threshold calibration on a real
dataset, and independent evaluation are all still outstanding, and none of
them can be produced inside a software sandbox with no hardware access.
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from skimage.morphology import skeletonize

MODEL_ID = "biocheck-py-minutiae-v1"
MATCHER_MODEL_ID = "biocheck-py-minutiae-v1-matcher"

# Matching tolerances (documented, not "calibrated" — see module docstring).
_DIST_TOL_PX = 12.0
_ANGLE_TOL_RAD = math.radians(20.0)
_BLOCK = 16  # orientation-field block size, px


def model_sha256() -> str:
    """Hash of this module's own source — pins the exact deployed algorithm,
    same discipline as the Java sidecar hashing its SourceAFIS jar."""
    src = Path(__file__).read_bytes()
    return hashlib.sha256(src).hexdigest()


@dataclass(frozen=True)
class Minutia:
    x: int
    y: int
    theta: float  # radians, ridge direction at the minutia
    kind: str  # "ending" | "bifurcation"


# --------------------------------------------------------------------- image

def _normalise(gray: np.ndarray) -> np.ndarray:
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(gray)


def _foreground_mask(gray: np.ndarray) -> np.ndarray:
    """Local-variance segmentation: fingerprint ridges have much higher
    local variance than blank background/paper."""
    blk = 16
    h, w = gray.shape
    var_map = np.zeros((h // blk + 1, w // blk + 1), dtype=np.float32)
    for by in range(0, h, blk):
        for bx in range(0, w, blk):
            block = gray[by : by + blk, bx : bx + blk]
            var_map[by // blk, bx // blk] = block.var()
    thresh = max(var_map.max() * 0.08, 25.0)
    mask_small = (var_map > thresh).astype(np.uint8)
    mask = cv2.resize(mask_small, (w, h), interpolation=cv2.INTER_NEAREST)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    return mask.astype(bool)


def _orientation_field(gray: np.ndarray, block: int = _BLOCK) -> np.ndarray:
    """Block-wise ridge orientation via the standard gradient-squares method."""
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    h, w = gray.shape
    bh, bw = h // block + 1, w // block + 1
    orient = np.zeros((bh, bw), dtype=np.float32)
    for by in range(bh):
        for bx in range(bw):
            y0, y1 = by * block, min((by + 1) * block, h)
            x0, x1 = bx * block, min((bx + 1) * block, w)
            vx = gx[y0:y1, x0:x1]
            vy = gy[y0:y1, x0:x1]
            gxx = float(np.sum(vx * vx - vy * vy))
            gxy = float(np.sum(2 * vx * vy))
            orient[by, bx] = 0.5 * math.atan2(gxy, gxx)
    return orient


def _binarise(gray: np.ndarray, mask: np.ndarray) -> np.ndarray:
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    _, otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    otsu[~mask] = 0
    return otsu


def _crossing_number_minutiae(skel: np.ndarray, mask: np.ndarray, orient: np.ndarray) -> list[Minutia]:
    h, w = skel.shape
    binimg = (skel > 0).astype(np.uint8)
    minutiae: list[Minutia] = []
    margin = 4
    for y in range(margin, h - margin):
        row_mask = mask[y]
        for x in range(margin, w - margin):
            if not binimg[y, x] or not row_mask[x]:
                continue
            neigh = [
                binimg[y - 1, x], binimg[y - 1, x + 1], binimg[y, x + 1], binimg[y + 1, x + 1],
                binimg[y + 1, x], binimg[y + 1, x - 1], binimg[y, x - 1], binimg[y - 1, x - 1],
            ]
            cn = sum(abs(int(neigh[i]) - int(neigh[(i + 1) % 8])) for i in range(8)) // 2
            if cn == 1:
                kind = "ending"
            elif cn == 3:
                kind = "bifurcation"
            else:
                continue
            # require full local ROI support (avoids border/mask-edge artefacts)
            if not mask[max(0, y - margin) : y + margin, max(0, x - margin) : x + margin].all():
                continue
            by, bx = min(y // _BLOCK, orient.shape[0] - 1), min(x // _BLOCK, orient.shape[1] - 1)
            theta = float(orient[by, bx])
            minutiae.append(Minutia(int(x), int(y), theta, kind))
    return minutiae


def _suppress_close(minutiae: list[Minutia], min_dist: float = 6.0) -> list[Minutia]:
    """Greedy non-max suppression so dense skeleton noise doesn't inflate counts."""
    kept: list[Minutia] = []
    for m in minutiae:
        if all((m.x - k.x) ** 2 + (m.y - k.y) ** 2 >= min_dist * min_dist for k in kept):
            kept.append(m)
    return kept


def extract_minutiae(image_bytes: bytes) -> list[Minutia]:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    gray = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise ValueError("image_undecodable")
    if gray.shape[0] < 32 or gray.shape[1] < 32:
        raise ValueError("image_too_small")
    norm = _normalise(gray)
    mask = _foreground_mask(norm)
    if mask.sum() < 0.02 * mask.size:
        return []  # no plausible fingerprint content
    orient = _orientation_field(norm)
    binimg = _binarise(norm, mask)
    skel = skeletonize(binimg > 0)
    raw = _crossing_number_minutiae(skel, mask, orient)
    return _suppress_close(raw)


# ------------------------------------------------------------------ template

def serialise_template(minutiae: list[Minutia]) -> bytes:
    payload = {
        "v": 1,
        "algo": MODEL_ID,
        "minutiae": [[m.x, m.y, round(m.theta, 4), m.kind] for m in minutiae],
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def deserialise_template(blob: bytes) -> list[Minutia]:
    payload = json.loads(blob.decode("utf-8"))
    if payload.get("v") != 1:
        raise ValueError("template_version_unsupported")
    return [Minutia(int(x), int(y), float(t), str(k)) for x, y, t, k in payload["minutiae"]]


# --------------------------------------------------------------------- match

def _angle_diff(a: float, b: float) -> float:
    d = (a - b + math.pi) % (2 * math.pi) - math.pi
    return abs(d)


def compare_templates(a: list[Minutia], b: list[Minutia]) -> float:
    """Alignment-search minutiae matching. Returns a bounded [0,1] similarity
    coefficient (Dice-style overlap under the best rigid alignment found).
    Not calibrated against any external accuracy standard — see module
    docstring."""
    if not a or not b:
        return 0.0

    best_inliers = 0
    # Candidate transforms: every (pair from a, pair from b) of matching kind
    # implies a rigid rotation + translation. This is a simplified, unranked
    # analogue of Bozorth3's compatible-pair search, not an exact port.
    for ma in a:
        for mb in b:
            if ma.kind != mb.kind:
                continue
            dtheta = mb.theta - ma.theta
            cos_t, sin_t = math.cos(dtheta), math.sin(dtheta)

            def transform(m: Minutia) -> tuple[float, float, float]:
                rx = m.x * cos_t - m.y * sin_t
                ry = m.x * sin_t + m.y * cos_t
                return rx, ry, (m.theta + dtheta) % (2 * math.pi)

            ax0, ay0, _ = transform(ma)
            dx, dy = mb.x - ax0, mb.y - ay0

            inliers = 0
            used_b = set()
            for m in a:
                rx, ry, rtheta = transform(m)
                rx, ry = rx + dx, ry + dy
                best_j, best_d = -1, _DIST_TOL_PX + 1
                for j, mb2 in enumerate(b):
                    if j in used_b or mb2.kind != m.kind:
                        continue
                    d = math.hypot(rx - mb2.x, ry - mb2.y)
                    if d <= _DIST_TOL_PX and _angle_diff(rtheta, mb2.theta) <= _ANGLE_TOL_RAD and d < best_d:
                        best_j, best_d = j, d
                if best_j >= 0:
                    used_b.add(best_j)
                    inliers += 1
            best_inliers = max(best_inliers, inliers)

    denom = (len(a) + len(b)) / 2.0
    return max(0.0, min(1.0, best_inliers / denom)) if denom else 0.0
