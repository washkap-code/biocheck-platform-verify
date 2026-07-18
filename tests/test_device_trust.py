from biocheck_engine.device_trust import (AttestationVerdict, DeviceAttestation,
                                          DeviceTrustLevel, DeviceTrustPolicy,
                                          DeviceTrustService)


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


def attestation(clock, verdict=AttestationVerdict.PASSED, age_s=0):
    return DeviceAttestation(verdict, "play-integrity", int((clock.now - age_s) * 1000))


def test_first_sighting_is_unknown_even_with_attestation():
    clock = Clock()
    svc = DeviceTrustService(clock=clock)
    signal = svc.observe("t1", "s1", "dev-a", attestation(clock))
    assert signal.level == DeviceTrustLevel.UNKNOWN
    assert signal.reason_code == "DEVICE_FIRST_SEEN"


def test_known_after_repeat_sightings():
    clock = Clock()
    svc = DeviceTrustService(clock=clock)
    svc.observe("t1", "s1", "dev-a")
    signal = svc.observe("t1", "s1", "dev-a")
    assert signal.level == DeviceTrustLevel.KNOWN and signal.sightings == 2


def test_trusted_requires_fresh_attestation_and_history():
    clock = Clock()
    svc = DeviceTrustService(clock=clock)
    svc.observe("t1", "s1", "dev-a")
    signal = svc.observe("t1", "s1", "dev-a", attestation(clock))
    assert signal.level == DeviceTrustLevel.TRUSTED


def test_stale_attestation_downgrades_to_known():
    clock = Clock()
    svc = DeviceTrustService(clock=clock)
    svc.observe("t1", "s1", "dev-a")
    signal = svc.observe("t1", "s1", "dev-a", attestation(clock, age_s=700))
    assert signal.level == DeviceTrustLevel.KNOWN


def test_failed_attestation_blocks():
    clock = Clock()
    svc = DeviceTrustService(clock=clock)
    svc.observe("t1", "s1", "dev-a")
    signal = svc.observe("t1", "s1", "dev-a",
                         attestation(clock, AttestationVerdict.FAILED))
    assert signal.level == DeviceTrustLevel.BLOCKED
    assert signal.reason_code == "ATTESTATION_FAILED"


def test_operator_block_and_unblock():
    clock = Clock()
    svc = DeviceTrustService(clock=clock)
    svc.observe("t1", "s1", "dev-a")
    svc.block("t1", "s1", "dev-a")
    assert svc.observe("t1", "s1", "dev-a").level == DeviceTrustLevel.BLOCKED
    svc.unblock("t1", "s1", "dev-a")
    assert svc.observe("t1", "s1", "dev-a").level == DeviceTrustLevel.KNOWN


def test_missing_device_ref_fails_closed():
    svc = DeviceTrustService()
    signal = svc.observe("t1", "s1", "")
    assert signal.level == DeviceTrustLevel.UNKNOWN
    assert signal.reason_code == "DEVICE_REF_MISSING"


def test_devices_are_tenant_and_subject_scoped():
    clock = Clock()
    svc = DeviceTrustService(clock=clock)
    svc.observe("t1", "s1", "dev-a")
    svc.observe("t1", "s1", "dev-a")
    # Same device ref under a different tenant/subject is unknown.
    assert svc.observe("t2", "s1", "dev-a").level == DeviceTrustLevel.UNKNOWN
    assert svc.observe("t1", "s2", "dev-a").level == DeviceTrustLevel.UNKNOWN
