"""The private-network allowance must stay narrow: explicit opt-in AND an
orchestrator-internal hostname suffix. Everything else keeps refusing HTTP."""
import pytest

from biocheck_engine.model_registry import ModelRegistry
from biocheck_engine.providers.fingerprint import FingerprintSidecar


def make(endpoint: str, **kw) -> FingerprintSidecar:
    return FingerprintSidecar(endpoint, "k", ModelRegistry(), **kw)


def test_http_public_host_refused_even_with_flag():
    with pytest.raises(ValueError):
        make("http://evil.example.com:8081", allow_private_network=True)


def test_http_flycast_refused_without_flag():
    with pytest.raises(ValueError):
        make("http://biocheck-fp-sidecar.flycast:8081")


def test_http_flycast_allowed_with_flag():
    make("http://biocheck-fp-sidecar.flycast:8081", allow_private_network=True)


def test_http_internal_allowed_with_flag():
    make("http://biocheck-fp-sidecar.internal:8081", allow_private_network=True)


def test_localhost_still_allowed_without_flag():
    make("http://localhost:8081")


def test_https_always_allowed():
    make("https://fp.biochecktech.com")
