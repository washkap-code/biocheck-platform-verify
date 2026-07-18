"""Device trust context.

Binds verifications to known devices and turns platform attestation
verdicts into a trust signal for orchestration. Design rules:

- Attestation verdicts (Play Integrity / App Attest / WebAuthn) come from
  the platform layer and are never synthesised here. Absence of
  attestation is a distinct, weaker state — fail-closed to UNKNOWN.
- A device is identified by an opaque, caller-supplied device_ref (in
  production: a hash of a platform-issued binding key, never a raw
  hardware identifier).
- Trust levels only provide CONTEXT. They never approve a verification on
  their own and a BLOCKED device always forces rejection upstream.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum


class AttestationVerdict(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    UNAVAILABLE = "unavailable"


class DeviceTrustLevel(str, Enum):
    TRUSTED = "trusted"      # known device + passing attestation
    KNOWN = "known"          # seen before, no current attestation
    UNKNOWN = "unknown"      # first sighting for this subject
    BLOCKED = "blocked"      # explicitly blocked by tenant/operator


@dataclass(frozen=True)
class DeviceAttestation:
    verdict: AttestationVerdict
    mechanism: str  # e.g. "play-integrity", "app-attest", "webauthn", "none"
    attested_at_ms: int


@dataclass(frozen=True)
class DeviceTrustSignal:
    level: DeviceTrustLevel
    reason_code: str
    device_ref: str
    first_seen_ms: int | None
    sightings: int


@dataclass(frozen=True)
class DeviceTrustPolicy:
    policy_id: str = "biocheck-device-v1"
    attestation_max_age_seconds: int = 600
    sightings_for_known: int = 2  # sightings needed before a device counts as known


@dataclass
class _DeviceRecord:
    device_ref: str
    first_seen_ms: int
    sightings: int = 0
    blocked: bool = False


class DeviceTrustService:
    """In-memory prototype; production persists device records per tenant
    with the same semantics."""

    def __init__(self, policy: DeviceTrustPolicy | None = None, clock=time.time) -> None:
        self.policy = policy or DeviceTrustPolicy()
        self._clock = clock
        self._devices: dict[tuple[str, str, str], _DeviceRecord] = {}

    def _key(self, tenant_id: str, subject_ref: str, device_ref: str) -> tuple[str, str, str]:
        return (tenant_id, subject_ref, device_ref)

    def block(self, tenant_id: str, subject_ref: str, device_ref: str) -> None:
        key = self._key(tenant_id, subject_ref, device_ref)
        record = self._devices.setdefault(
            key, _DeviceRecord(device_ref, int(self._clock() * 1000)))
        record.blocked = True

    def unblock(self, tenant_id: str, subject_ref: str, device_ref: str) -> None:
        record = self._devices.get(self._key(tenant_id, subject_ref, device_ref))
        if record:
            record.blocked = False

    def observe(self, tenant_id: str, subject_ref: str, device_ref: str,
                attestation: DeviceAttestation | None = None) -> DeviceTrustSignal:
        """Record a sighting and return the trust signal for this interaction."""
        if not device_ref:
            return DeviceTrustSignal(DeviceTrustLevel.UNKNOWN, "DEVICE_REF_MISSING", "", None, 0)
        now_ms = int(self._clock() * 1000)
        key = self._key(tenant_id, subject_ref, device_ref)
        record = self._devices.get(key)
        first_sighting = record is None
        if record is None:
            record = self._devices[key] = _DeviceRecord(device_ref, now_ms)
        record.sightings += 1

        if record.blocked:
            return DeviceTrustSignal(DeviceTrustLevel.BLOCKED, "DEVICE_BLOCKED",
                                     device_ref, record.first_seen_ms, record.sightings)

        if attestation is not None:
            if attestation.verdict == AttestationVerdict.FAILED:
                return DeviceTrustSignal(DeviceTrustLevel.BLOCKED, "ATTESTATION_FAILED",
                                         device_ref, record.first_seen_ms, record.sightings)
            age = (now_ms - attestation.attested_at_ms) / 1000.0
            if (attestation.verdict == AttestationVerdict.PASSED
                    and 0 <= age <= self.policy.attestation_max_age_seconds
                    and not first_sighting):
                return DeviceTrustSignal(DeviceTrustLevel.TRUSTED, "DEVICE_ATTESTED",
                                         device_ref, record.first_seen_ms, record.sightings)

        if first_sighting or record.sightings < self.policy.sightings_for_known:
            return DeviceTrustSignal(DeviceTrustLevel.UNKNOWN, "DEVICE_FIRST_SEEN",
                                     device_ref, record.first_seen_ms, record.sightings)
        return DeviceTrustSignal(DeviceTrustLevel.KNOWN, "DEVICE_KNOWN",
                                 device_ref, record.first_seen_ms, record.sightings)
