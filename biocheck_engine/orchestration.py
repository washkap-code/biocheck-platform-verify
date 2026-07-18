"""Identity orchestration.

Combines biometric modality outcomes (face, fingerprint) with context
signals (device trust, location, PIN/OTP step-up) into a single
policy-driven decision. Precedence rules, strictest first:

1. Any hard deny wins: a REJECTED biometric, a BLOCKED device, or a DENY
   location always rejects. Context can never rescue a failed biometric.
2. Step-up and context can only move a decision DOWN (toward review) or
   satisfy an explicitly required step-up — never upgrade REVIEW or
   REJECTED biometrics to approval.
3. Missing required factors fail closed to STEP_UP_REQUIRED or REVIEW.

The orchestrated decision is auditable: reason codes list every rule that
fired, and the outcome is appended to the same hash-chained audit ledger
used by single-modality verification.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Mapping

from .crypto import digest
from .device_trust import DeviceTrustLevel, DeviceTrustSignal
from .location import LocationRisk, LocationSignal
from .stepup import StepUpResult, StepUpStatus
from .types import Decision


class OrchestratedOutcome(str, Enum):
    APPROVED = "approved"
    STEP_UP_REQUIRED = "step_up_required"
    REVIEW = "review"
    REJECTED = "rejected"


@dataclass(frozen=True)
class ModalityOutcome:
    modality: str            # "face" | "fingerprint"
    decision: Decision
    reason_code: str
    correlation_id: str | None = None


@dataclass(frozen=True)
class OrchestrationPolicy:
    policy_id: str = "biocheck-orchestration-v1"
    required_modalities: tuple[str, ...] = ("face",)
    # Context handling
    step_up_on_unknown_device: bool = True
    step_up_on_elevated_location: bool = True
    # Whether a satisfied step-up may clear a step-up requirement raised by
    # context (it can NEVER clear biometric REVIEW/REJECTED).
    allow_step_up_to_clear_context: bool = True


@dataclass(frozen=True)
class OrchestratedDecision:
    outcome: OrchestratedOutcome
    reason_codes: tuple[str, ...]
    policy_id: str
    correlation_id: str
    audit_hash: str
    signals: Mapping[str, str]


class OrchestrationAudit:
    """Hash-chained ledger for orchestration events (same scheme as
    AuditChain, which is typed to single-modality VerificationResult)."""

    def __init__(self) -> None:
        self.events: list[dict] = []
        self._previous_hash = ""

    def append(self, tenant_id: str, subject_ref: str, payload: dict) -> str:
        event = {"at": int(time.time() * 1000), "tenant": tenant_id,
                 "subject": subject_ref, "orchestration": payload,
                 "previous_hash": self._previous_hash}
        event_hash = digest(event, self._previous_hash)
        event["event_hash"] = event_hash
        self.events.append(event)
        self._previous_hash = event_hash
        return event_hash

    def verify(self) -> bool:
        previous = ""
        for event in self.events:
            stored = event["event_hash"]
            copied = dict(event)
            copied.pop("event_hash")
            if copied["previous_hash"] != previous or digest(copied, previous) != stored:
                return False
            previous = stored
        return True


class Orchestrator:
    def __init__(self, policy: OrchestrationPolicy | None = None,
                 audit: OrchestrationAudit | None = None) -> None:
        self.policy = policy or OrchestrationPolicy()
        self.audit = audit or OrchestrationAudit()

    def decide(self, tenant_id: str, subject_ref: str,
               modalities: list[ModalityOutcome],
               device: DeviceTrustSignal | None = None,
               location: LocationSignal | None = None,
               step_up: StepUpResult | None = None) -> OrchestratedDecision:
        policy = self.policy
        correlation_id = str(uuid.uuid4())
        reasons: list[str] = []
        signals: dict[str, str] = {}
        by_modality = {m.modality: m for m in modalities}

        outcome = OrchestratedOutcome.APPROVED

        def cap(target: OrchestratedOutcome) -> None:
            nonlocal outcome
            order = [OrchestratedOutcome.APPROVED, OrchestratedOutcome.STEP_UP_REQUIRED,
                     OrchestratedOutcome.REVIEW, OrchestratedOutcome.REJECTED]
            if order.index(target) > order.index(outcome):
                outcome = target

        # 1. Hard denies.
        for m in modalities:
            signals[f"modality:{m.modality}"] = m.decision.value
            if m.decision == Decision.REJECTED:
                cap(OrchestratedOutcome.REJECTED)
                reasons.append(f"{m.modality.upper()}_REJECTED:{m.reason_code}")
        if device is not None:
            signals["device"] = device.level.value
            if device.level == DeviceTrustLevel.BLOCKED:
                cap(OrchestratedOutcome.REJECTED)
                reasons.append(f"DEVICE_BLOCKED:{device.reason_code}")
        if location is not None:
            signals["location"] = location.risk.value
            if location.risk == LocationRisk.DENY:
                cap(OrchestratedOutcome.REJECTED)
                reasons.append(f"LOCATION_DENIED:{location.reason_code}")

        # 2. Required modalities present and approved?
        biometric_review = False
        for required in policy.required_modalities:
            m = by_modality.get(required)
            if m is None:
                cap(OrchestratedOutcome.REVIEW)
                biometric_review = True
                reasons.append(f"REQUIRED_MODALITY_MISSING:{required}")
            elif m.decision == Decision.REVIEW:
                cap(OrchestratedOutcome.REVIEW)
                biometric_review = True
                reasons.append(f"{required.upper()}_REVIEW:{m.reason_code}")

        # 3. Context escalations (only if not already rejected/review).
        context_step_up = False
        if outcome in (OrchestratedOutcome.APPROVED, OrchestratedOutcome.STEP_UP_REQUIRED):
            if (policy.step_up_on_unknown_device and device is not None
                    and device.level == DeviceTrustLevel.UNKNOWN):
                context_step_up = True
                reasons.append("DEVICE_UNKNOWN_STEP_UP")
            if (policy.step_up_on_elevated_location and location is not None
                    and location.risk == LocationRisk.ELEVATED):
                context_step_up = True
                reasons.append(f"LOCATION_ELEVATED_STEP_UP:{location.reason_code}")
            if context_step_up:
                cap(OrchestratedOutcome.STEP_UP_REQUIRED)

        # 4. Step-up settlement — can only clear CONTEXT-raised step-up.
        if step_up is not None:
            signals["step_up"] = step_up.status.value
            if step_up.status == StepUpStatus.DENIED:
                cap(OrchestratedOutcome.REVIEW)
                reasons.append(f"STEP_UP_DENIED:{step_up.reason_code}")
            elif (step_up.status == StepUpStatus.SATISFIED and context_step_up
                  and policy.allow_step_up_to_clear_context
                  and outcome == OrchestratedOutcome.STEP_UP_REQUIRED
                  and not biometric_review):
                outcome = OrchestratedOutcome.APPROVED
                reasons.append(f"STEP_UP_SATISFIED:{step_up.reason_code}")

        if not reasons:
            reasons.append("ALL_FACTORS_SATISFIED")

        payload = {"outcome": outcome.value, "reasons": reasons, "signals": signals,
                   "policy_id": policy.policy_id, "correlation_id": correlation_id}
        audit_hash = self.audit.append(tenant_id, subject_ref, payload)
        return OrchestratedDecision(outcome, tuple(reasons), policy.policy_id,
                                    correlation_id, audit_hash, signals)
