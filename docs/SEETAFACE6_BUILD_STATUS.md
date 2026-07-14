# SeetaFace6 acquisition and native-build status

## Completed and verified — 14 July 2026

- Official source retrieved from `https://github.com/SeetaFace6Open/index` at
  commit `a32e2faa0694c0f841ace4df9ead0407b78363c6`, including pinned submodules.
- The initially unresolved TenniS submodule is now pinned at
  `ef6c8332809a021d0eb5842c0f9d32a7f0b07f96`.
- Official model archive and light-recognizer file were downloaded from the
  Dropbox URLs linked by the upstream project itself.
- `model-manifest/seetaface6-official-2026-07-14.json` records the SHA-256
  values. `scripts/verify_model_manifest.py` passed for the six required v1
  modules: detector, five-point alignment, recognition, two PAD stages and
  quality assessment.

## Native-build result in this environment

The build starts successfully with CMake 3.30.5 and GCC 13.3 but upstream
TenniS fails because `src/memory/orz/pot.cpp` calls `std::malloc` and
`std::free` without including `<cstdlib>`. The minimal compatibility patch is
`native-patches/0001-tennis-gcc13-cstdlib.patch`.

Long-running native compilation is forcibly terminated by this hosted workspace
before the build can finish. This is an infrastructure constraint, not a model
or source-integrity failure. No production binary has been produced and no live
BioCheck connection has been made.

## Reproducible build on a Linux builder

Use Ubuntu 22.04 or 24.04 with GCC, Make and CMake installed. In a clean clone:

```bash
git clone --recursive https://github.com/SeetaFace6Open/index.git SeetaFace6Open
cd SeetaFace6Open
git checkout a32e2faa0694c0f841ace4df9ead0407b78363c6
git submodule update --init --recursive
git -C TenniS checkout ef6c8332809a021d0eb5842c0f9d32a7f0b07f96
git apply /path/to/0001-tennis-gcc13-cstdlib.patch
```

Build the dependencies, then the v1 modules in this order:

```bash
for unit in TenniS OpenRoleZoo SeetaAuthorize FaceBoxes Landmarker FaceRecognizer6 FaceAntiSpoofingX6 QualityAssessor3; do
  (cd "$unit" && bash craft/build.linux.x64.sh)
done
```

Before starting the sidecar, run:

```bash
python scripts/verify_model_manifest.py model-manifest/seetaface6-official-2026-07-14.json /secure/models
```

The container must mount `/secure/models` read-only, expose no public port, use
mTLS from the BioCheck API and disable capture-body logging.

## Still required before pilot

1. Build the native sidecar on the designated isolated Linux builder and record
   binary hashes, compiler version and OS image digest.
2. Register the exact model hashes with a test-only BioCheck model registry.
3. Obtain signed adult-volunteer consents and collect the pseudonymised capture
   set under `testing/PILOT_PROTOCOL.md`.
4. Run the pilot, retain only results metadata, review all false accepts/rejects
   and produce a signed pilot report.
5. Obtain explicit release approval before any production connection.
