from biocheck_engine.stepup import StepUpPolicy, StepUpService, StepUpStatus


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


def make():
    clock = Clock()
    return StepUpService(StepUpPolicy(), clock), clock


def test_otp_issue_and_confirm():
    svc, clock = make()
    issued = svc.issue_otp("t1", "s1")
    assert issued.status == StepUpStatus.PENDING and issued.challenge_id
    result = svc.verify_otp(issued.challenge_id, svc.last_issued_otp)
    assert result.status == StepUpStatus.SATISFIED and result.reason_code == "OTP_CONFIRMED"


def test_otp_wrong_then_correct():
    svc, clock = make()
    issued = svc.issue_otp("t1", "s1")
    assert svc.verify_otp(issued.challenge_id, "000000").reason_code == "OTP_INCORRECT"
    assert svc.verify_otp(issued.challenge_id, svc.last_issued_otp).status == StepUpStatus.SATISFIED


def test_otp_replay_denied():
    svc, clock = make()
    issued = svc.issue_otp("t1", "s1")
    otp = svc.last_issued_otp
    assert svc.verify_otp(issued.challenge_id, otp).status == StepUpStatus.SATISFIED
    replay = svc.verify_otp(issued.challenge_id, otp)
    assert replay.status == StepUpStatus.DENIED and replay.reason_code == "CHALLENGE_REPLAYED"


def test_otp_expiry_fails_closed():
    svc, clock = make()
    issued = svc.issue_otp("t1", "s1")
    clock.now += 301
    result = svc.verify_otp(issued.challenge_id, svc.last_issued_otp)
    assert result.status == StepUpStatus.DENIED and result.reason_code == "CHALLENGE_EXPIRED"


def test_otp_attempts_exhausted_locks_out():
    svc, clock = make()
    issued = svc.issue_otp("t1", "s1")
    for _ in range(3):
        svc.verify_otp(issued.challenge_id, "999999")
    result = svc.verify_otp(issued.challenge_id, svc.last_issued_otp)
    assert result.status == StepUpStatus.DENIED
    # Lockout blocks new issuance for the same subject.
    clock.now += 60  # past resend cooldown, still inside lockout
    assert svc.issue_otp("t1", "s1").reason_code == "STEPUP_LOCKED_OUT"
    clock.now += 900
    assert svc.issue_otp("t1", "s1").status == StepUpStatus.PENDING


def test_resend_cooldown():
    svc, clock = make()
    assert svc.issue_otp("t1", "s1").status == StepUpStatus.PENDING
    assert svc.issue_otp("t1", "s1").reason_code == "STEPUP_RESEND_TOO_SOON"
    clock.now += 31
    assert svc.issue_otp("t1", "s1").status == StepUpStatus.PENDING


def test_unknown_challenge_denied():
    svc, _ = make()
    assert svc.verify_otp("nope", "123456").reason_code == "CHALLENGE_UNKNOWN"


def test_pin_enrol_and_verify():
    svc, _ = make()
    svc.enrol_pin("t1", "s1", "4821")
    assert svc.verify_pin("t1", "s1", "4821").status == StepUpStatus.SATISFIED
    assert svc.verify_pin("t1", "s1", "0000").reason_code == "PIN_INCORRECT"
    assert svc.verify_pin("t1", "s2", "4821").reason_code == "PIN_NOT_ENROLLED"


def test_pin_policy_rejected():
    svc, _ = make()
    for bad in ("12", "abcd"):
        try:
            svc.enrol_pin("t1", "s1", bad)
            assert False, "should have raised"
        except ValueError:
            pass


def test_pins_stored_hashed_not_clear():
    svc, _ = make()
    svc.enrol_pin("t1", "s1", "4821")
    salt, digest_bytes = svc._pins[("t1", "s1")]
    assert b"4821" not in salt + digest_bytes
