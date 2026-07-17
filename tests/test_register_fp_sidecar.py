"""FP-002: the registration script's cards must satisfy the registry gate."""
import importlib.util
import sys
from pathlib import Path

import pytest

from biocheck_engine.model_registry import ModelCard, ModelRegistry

_spec = importlib.util.spec_from_file_location(
    "register_fp_sidecar", Path(__file__).resolve().parents[1] / "scripts" / "register_fp_sidecar.py")
reg_script = importlib.util.module_from_spec(_spec)
sys.modules["register_fp_sidecar"] = reg_script
_spec.loader.exec_module(reg_script)

HEALTH = {
    "model_id": "sourceafis-java-3.18.1",
    "matcher_model_id": "sourceafis-java-3.18.1-matcher",
    "model_sha256": "a" * 64,
}


def test_cards_pass_registry_approval_and_gate():
    cards = reg_script.build_cards(HEALTH, approved_by="test-operator", expires="2027-12-31")
    registry = ModelRegistry()
    for card in cards:
        registry.approve(ModelCard(**card))
    # exactly what the engine client asserts on every call:
    registry.assert_allowed("sourceafis-java-3.18.1", "a" * 64, "fingerprint_extraction")
    registry.assert_allowed("sourceafis-java-3.18.1-matcher", "a" * 64, "fingerprint_matching")


def test_cards_use_distinct_ids_per_purpose():
    cards = reg_script.build_cards(HEALTH, approved_by="op", expires="2027-12-31")
    assert len({c["model_id"] for c in cards}) == 2
    assert {c["purpose"] for c in cards} == {"fingerprint_extraction", "fingerprint_matching"}


def test_wrong_hash_is_refused_by_gate():
    cards = reg_script.build_cards(HEALTH, approved_by="op", expires="2027-12-31")
    registry = ModelRegistry()
    for card in cards:
        registry.approve(ModelCard(**card))
    with pytest.raises(PermissionError):
        registry.assert_allowed("sourceafis-java-3.18.1", "b" * 64, "fingerprint_extraction")


def test_purpose_swap_is_refused_by_gate():
    cards = reg_script.build_cards(HEALTH, approved_by="op", expires="2027-12-31")
    registry = ModelRegistry()
    for card in cards:
        registry.approve(ModelCard(**card))
    with pytest.raises(PermissionError):
        registry.assert_allowed("sourceafis-java-3.18.1", "a" * 64, "fingerprint_matching")
