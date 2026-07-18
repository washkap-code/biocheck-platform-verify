from biocheck_engine.device_trust import DeviceTrustLevel, DeviceTrustSignal
from biocheck_engine.location import LocationRisk, LocationSignal
from biocheck_engine.orchestration import (ModalityOutcome, OrchestratedOutcome,
                                           OrchestrationPolicy, Orchestrator)
from biocheck_engine.stepup import StepUpResult, StepUpStatus
from biocheck_engine.types import Decision


def face(decision=Decision.APPROVED, reason="MATCH_CONFIRMED"):
    return ModalityOutcome("face", decision, reason)


def device(level=DeviceTrustLevel.TRUSTED, reason="DEVICE_ATTESTED"):
    return DeviceTrustSignal(level, reason, "dev-a", 0, 3)


def location(risk=LocationRisk.NORMAL, reason="LOCATION_OK"):
    return LocationSignal(risk, reason)


def test_all_factors_good_approves():
    orch = Orchestrator()
    d = orch.decide("t1", "s1", [face()], device(), location())
    assert d.outcome == OrchestratedOutcome.APPROVED
    assert d.reason_codes == ("ALL_FACTORS_SATISFIED",)
    assert d.audit_hash and orch.audit.verify()


def test_biometric_reject_always_rejects():
    orch = Orchestrator()
    d = orch.decide("t1", "s1", [face(Decision.REJECTED, "LIVENESS_FAILED")],
                    device(), location(),
                    StepUpResult(StepUpStatus.SATISFIED, "OTP_CONFIRMED"))
    assert d.outcome == OrchestratedOutcome.REJECTED
    assert any(r.startswith("FACE_REJECTED") for r in d.reason_codes)


def test_step_up_never_upgrades_biometric_review():
    orch = Orchestrator()
    d = orch.decide("t1", "s1", [face(Decision.REVIEW, "MATCH_REQUIRES_HUMAN_REVIEW")],
                    device(DeviceTrustLevel.UNKNOWN, "DEVICE_FIRST_SEEN"), location(),
                    StepUpResult(StepUpStatus.SATISFIED, "OTP_CONFIRMED"))
    assert d.outcome == OrchestratedOutcome.REVIEW


def test_blocked_device_rejects():
    orch = Orchestrator()
    d = orch.decide("t1", "s1", [face()], device(DeviceTrustLevel.BLOCKED, "DEVICE_BLOCKED"))
    assert d.outcome == OrchestratedOutcome.REJECTED


def test_denied_location_rejects():
    orch = Orchestrator()
    d = orch.decide("t1", "s1", [face()], device(),
                    location(LocationRisk.DENY, "COUNTRY_NOT_ALLOWED"))
    assert d.outcome == OrchestratedOutcome.REJECTED


def test_unknown_device_requires_step_up():
    orch = Orchestrator()
    d = orch.decide("t1", "s1", [face()],
                    device(DeviceTrustLevel.UNKNOWN, "DEVICE_FIRST_SEEN"), location())
    assert d.outcome == OrchestratedOutcome.STEP_UP_REQUIRED
    assert "DEVICE_UNKNOWN_STEP_UP" in d.reason_codes


def test_elevated_location_requires_step_up():
    orch = Orchestrator()
    d = orch.decide("t1", "s1", [face()], device(),
                    location(LocationRisk.ELEVATED, "IMPOSSIBLE_TRAVEL"))
    assert d.outcome == OrchestratedOutcome.STEP_UP_REQUIRED


def test_satisfied_step_up_clears_context_requirement():
    orch = Orchestrator()
    d = orch.decide("t1", "s1", [face()],
                    device(DeviceTrustLevel.UNKNOWN, "DEVICE_FIRST_SEEN"), location(),
                    StepUpResult(StepUpStatus.SATISFIED, "OTP_CONFIRMED"))
    assert d.outcome == OrchestratedOutcome.APPROVED
    assert any(r.startswith("STEP_UP_SATISFIED") for r in d.reason_codes)


def test_denied_step_up_forces_review():
    orch = Orchestrator()
    d = orch.decide("t1", "s1", [face()],
                    device(DeviceTrustLevel.UNKNOWN, "DEVICE_FIRST_SEEN"), location(),
                    StepUpResult(StepUpStatus.DENIED, "STEPUP_ATTEMPTS_EXHAUSTED"))
    assert d.outcome == OrchestratedOutcome.REVIEW


def test_missing_required_modality_reviews():
    orch = Orchestrator()
    d = orch.decide("t1", "s1", [], device(), location())
    assert d.outcome == OrchestratedOutcome.REVIEW
    assert "REQUIRED_MODALITY_MISSING:face" in d.reason_codes


def test_multi_modal_policy():
    orch = Orchestrator(OrchestrationPolicy(required_modalities=("face", "fingerprint")))
    d = orch.decide("t1", "s1",
                    [face(), ModalityOutcome("fingerprint", Decision.APPROVED, "MATCH_CONFIRMED")],
                    device(), location())
    assert d.outcome == OrchestratedOutcome.APPROVED
    d2 = orch.decide("t1", "s1", [face()], device(), location())
    assert d2.outcome == OrchestratedOutcome.REVIEW


def test_audit_chain_tamper_detection():
    orch = Orchestrator()
    orch.decide("t1", "s1", [face()], device(), location())
    orch.decide("t1", "s2", [face()], device(), location())
    assert orch.audit.verify()
    orch.audit.events[0]["orchestration"]["outcome"] = "approved-tampered"
    assert not orch.audit.verify()
