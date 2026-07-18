"""Context & orchestration HTTP endpoints for the verify-core facade.

Mounted by api.py under /v1/context and /v1/documents. Same rules as the
rest of the facade: bearer auth, fail closed, never leak internals.

State caveat (same as _CaptureStore in api.py): services are in-memory and
single-process. A multi-instance deployment needs shared storage; the
platform database is the intended production home for challenges, device
records and location history.

OTP delivery: no delivery channel (SMS/e-mail) is integrated. The issued
OTP is returned in the response ONLY when VERIFY_CORE_DEV_FIXTURES=true —
production issuance returns the challenge_id alone, and delivery
integration is tracked as Planned in the reality matrix.
"""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .device_trust import (AttestationVerdict, DeviceAttestation, DeviceTrustService)
from .documents import parse_mrz
from .location import (GeoFence, LocationObservation, LocationPolicy,
                       LocationRisk, LocationService, LocationSignal)
from .orchestration import (ModalityOutcome, OrchestrationPolicy, Orchestrator)
from .stepup import StepUpResult, StepUpService, StepUpStatus
from .types import Decision


class IssueOtpRequest(BaseModel):
    tenant_id: str
    subject_ref: str


class VerifyOtpRequest(BaseModel):
    challenge_id: str
    otp: str


class EnrolPinRequest(BaseModel):
    tenant_id: str
    subject_ref: str
    pin: str


class VerifyPinRequest(BaseModel):
    tenant_id: str
    subject_ref: str
    pin: str


class AttestationBody(BaseModel):
    verdict: str
    mechanism: str = "none"
    attested_at_ms: int = 0


class ObserveDeviceRequest(BaseModel):
    tenant_id: str
    subject_ref: str
    device_ref: str
    attestation: AttestationBody | None = None


class LocationBody(BaseModel):
    latitude: float
    longitude: float
    country_code: str | None = None
    source: str = "unspecified"
    observed_at_ms: int | None = None


class EvaluateLocationRequest(BaseModel):
    tenant_id: str
    subject_ref: str
    observation: LocationBody | None = None


class ModalityBody(BaseModel):
    modality: str
    decision: str
    reason_code: str
    correlation_id: str | None = None


class StepUpBody(BaseModel):
    status: str
    reason_code: str


class OrchestrateRequest(BaseModel):
    tenant_id: str
    subject_ref: str
    modalities: list[ModalityBody] = Field(default_factory=list)
    device: ObserveDeviceRequest | None = None
    location: LocationBody | None = None
    step_up: StepUpBody | None = None
    required_modalities: list[str] | None = None


class MrzRequest(BaseModel):
    lines: list[str]


def create_context_router(require_auth_dependency) -> APIRouter:
    router = APIRouter(dependencies=[require_auth_dependency])
    step_up_service = StepUpService()
    device_service = DeviceTrustService()
    location_service = LocationService()
    orchestrator = Orchestrator()
    dev_mode = os.environ.get("VERIFY_CORE_DEV_FIXTURES", "").lower() == "true"

    def _stepup_payload(result: StepUpResult, include_dev_otp: bool = False) -> dict:
        payload = {"status": result.status.value, "reason_code": result.reason_code,
                   "challenge_id": result.challenge_id, "method": result.method}
        if include_dev_otp and dev_mode and result.status == StepUpStatus.PENDING:
            payload["dev_otp"] = step_up_service.last_issued_otp  # dev fixtures only
        return payload

    @router.post("/v1/context/stepup/otp/issue")
    async def issue_otp(body: IssueOtpRequest) -> dict:
        return _stepup_payload(step_up_service.issue_otp(body.tenant_id, body.subject_ref),
                               include_dev_otp=True)

    @router.post("/v1/context/stepup/otp/verify")
    async def verify_otp(body: VerifyOtpRequest) -> dict:
        return _stepup_payload(step_up_service.verify_otp(body.challenge_id, body.otp))

    @router.post("/v1/context/stepup/pin/enrol")
    async def enrol_pin(body: EnrolPinRequest) -> dict:
        try:
            step_up_service.enrol_pin(body.tenant_id, body.subject_ref, body.pin)
        except ValueError:
            raise HTTPException(422, "PIN does not meet policy requirements.")
        return {"enrolled": True}

    @router.post("/v1/context/stepup/pin/verify")
    async def verify_pin(body: VerifyPinRequest) -> dict:
        return _stepup_payload(step_up_service.verify_pin(body.tenant_id, body.subject_ref, body.pin))

    @router.post("/v1/context/device/observe")
    async def observe_device(body: ObserveDeviceRequest) -> dict:
        attestation = None
        if body.attestation is not None:
            try:
                verdict = AttestationVerdict(body.attestation.verdict)
            except ValueError:
                raise HTTPException(422, "attestation.verdict is not a recognised value.")
            attestation = DeviceAttestation(verdict, body.attestation.mechanism,
                                            body.attestation.attested_at_ms)
        signal = device_service.observe(body.tenant_id, body.subject_ref,
                                        body.device_ref, attestation)
        return {"level": signal.level.value, "reason_code": signal.reason_code,
                "device_ref": signal.device_ref, "sightings": signal.sightings}

    @router.post("/v1/context/location/evaluate")
    async def evaluate_location(body: EvaluateLocationRequest) -> dict:
        observation = None
        if body.observation is not None:
            o = body.observation
            observation = LocationObservation(o.latitude, o.longitude, o.country_code,
                                              o.source, o.observed_at_ms)
        signal = location_service.evaluate(body.tenant_id, body.subject_ref, observation)
        return {"risk": signal.risk.value, "reason_code": signal.reason_code,
                "matched_fence": signal.matched_fence,
                "computed_speed_kmh": signal.computed_speed_kmh}

    @router.post("/v1/context/orchestrate")
    async def orchestrate(body: OrchestrateRequest) -> dict:
        try:
            modalities = [ModalityOutcome(m.modality, Decision(m.decision),
                                          m.reason_code, m.correlation_id)
                          for m in body.modalities]
        except ValueError:
            raise HTTPException(422, "modality decision is not a recognised value.")

        device_signal = None
        if body.device is not None:
            attestation = None
            if body.device.attestation is not None:
                try:
                    verdict = AttestationVerdict(body.device.attestation.verdict)
                except ValueError:
                    raise HTTPException(422, "attestation.verdict is not a recognised value.")
                attestation = DeviceAttestation(verdict, body.device.attestation.mechanism,
                                                body.device.attestation.attested_at_ms)
            device_signal = device_service.observe(body.device.tenant_id,
                                                   body.device.subject_ref,
                                                   body.device.device_ref, attestation)

        location_signal = None
        if body.location is not None:
            o = body.location
            location_signal = location_service.evaluate(
                body.tenant_id, body.subject_ref,
                LocationObservation(o.latitude, o.longitude, o.country_code,
                                    o.source, o.observed_at_ms))

        step_up_result = None
        if body.step_up is not None:
            try:
                step_up_result = StepUpResult(StepUpStatus(body.step_up.status),
                                              body.step_up.reason_code)
            except ValueError:
                raise HTTPException(422, "step_up.status is not a recognised value.")

        active = orchestrator
        if body.required_modalities is not None:
            active = Orchestrator(
                OrchestrationPolicy(required_modalities=tuple(body.required_modalities)),
                orchestrator.audit)

        decision = active.decide(body.tenant_id, body.subject_ref, modalities,
                                 device_signal, location_signal, step_up_result)
        return {"outcome": decision.outcome.value,
                "reason_codes": list(decision.reason_codes),
                "policy_id": decision.policy_id,
                "correlation_id": decision.correlation_id,
                "audit_hash": decision.audit_hash,
                "signals": dict(decision.signals)}

    @router.post("/v1/documents/mrz")
    async def documents_mrz(body: MrzRequest) -> dict:
        if len(body.lines) > 4 or any(len(ln) > 64 for ln in body.lines):
            raise HTTPException(400, "MRZ input exceeds expected size.")
        result = parse_mrz(body.lines)
        return {"status": result.status.value,
                "reason_codes": list(result.reason_codes),
                "format": result.format,
                "document_type": result.document_type,
                "issuing_state": result.issuing_state,
                "document_number": result.document_number,
                "nationality": result.nationality,
                "birth_date": result.birth_date,
                "expiry_date": result.expiry_date,
                "sex": result.sex,
                "surname": result.surname,
                "given_names": result.given_names,
                "checks": list(result.checks),
                "note": "MRZ internal consistency only — not proof of document genuineness."}

    return router
