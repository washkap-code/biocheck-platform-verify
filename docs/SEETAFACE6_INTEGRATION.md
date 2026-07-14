# SeetaFace6 integration — BioCheck v1

## Selected initial engine

BioCheck v1 uses SeetaFace6 behind an internal inference sidecar. The upstream
project includes face detection, landmarking, recognition, liveness and quality
assessment, is maintained by SeetaTech / the Institute of Computing Technology
at the Chinese Academy of Sciences, and is distributed under a BSD-style licence.
Its project documentation says the open edition is free for commercial and
personal use. Preserve its copyright and licence notices in every distribution.

**Do not describe BioCheck itself as SeetaFace-certified.** It is a BioCheck
deployment component, subject to BioCheck's own evaluation and release gates.

## Sidecar contract

`POST /v1/analyse` accepts a single JPEG capture and a one-time active-liveness
challenge ID. It returns no image, only the following response shape:

```json
{
  "embedding": ["512 or 1024 finite floats"],
  "model_id": "seetaface6-recognition-<release>",
  "model_sha256": "SHA-256 of the deployed recognition model",
  "quality": {"face_detected": true, "score": 0.98, "pose_degrees": 2.1, "occlusion_score": 0.03},
  "passive_pad": {
    "model_id": "seetaface6-pad-<release>",
    "model_sha256": "SHA-256 of the deployed PAD model",
    "is_live": true, "score": 0.99, "attack_type": null
  }
}
```

The Python client rejects a response when either model is absent from the
approved BioCheck registry. Model identifiers alone are never trusted.

## Build and deployment steps

1. Obtain the SeetaFace6 source and model package directly from the project's
   official links; retain the repository commit, package checksum and licence
   with the release record.
2. Build the C++ inference sidecar in a private container. Run it without public
   ingress and with read-only model files.
3. Put an mTLS API gateway between BioCheck Verify and the sidecar. Disable
   request logging of bodies and do not retain capture media.
4. Calculate the SHA-256 of each exact recognition and PAD model file, then add
   both to BioCheck's model registry with licence approval and test-report refs.
5. Run the acceptance pack: genuine-match, impostor-match, print replay, screen
   replay, video replay, injection/deepfake, low light, occlusion and all target
   device classes. Set thresholds only from the held-out test set.
6. Enable active challenge response in the mobile/web capture client. Passive
   PAD alone is not adequate for high-risk remote identity proofing.

## Fallback and independence

Run OpenCV SFace under Apache 2.0 as a second matching benchmark. Do not average
the engines in production until calibration proves it improves the defined FAR,
FRR and demographic results. It is a control against hidden regressions, not a
substitute for independent PAD testing.
