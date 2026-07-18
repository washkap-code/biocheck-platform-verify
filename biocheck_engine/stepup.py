"""PIN / OTP step-up verification.

Knowledge-factor step-up used by identity orchestration when biometric
confidence alone is insufficient. Design rules:

- Secrets are never stored in clear. PINs use scrypt (stdlib); OTPs use
  HMAC-SHA256 with a per-challenge random salt.
- Verification is constant-time (hmac.compare_digest).
- Fail-closed: expired, exhausted, unknown or replayed challenges are
  DENIED with a reason code — never silently retried.
- This module provides possession/knowledge context ONLY. It is not a
  biometric factor and never upgrades a REJECTED biometric decision.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum


class StepUpStatus(str, Enum):
    SATISFIED = "satisfied"
    PENDING = "pending"
    DENIED = "denied"


@dataclass(frozen=True)
class StepUpResult:
    status: StepUpStatus
    reason_code: str
    challenge_id: str | None = None
    method: str | None = None  # "otp" | "pin"


@dataclass(frozen=True)
class StepUpPolicy:
    policy_id: str = "biocheck-stepup-v1"
    otp_length: int = 6
    otp_ttl_seconds: int = 300
    max_attempts: int = 3
    resend_cooldown_seconds: int = 30
    lockout_seconds: int = 900  # per subject after max_attempts exhausted
    pin_min_length: int = 4


@dataclass
class _Challenge:
    challenge_id: str
    tenant_id: str
    subject_ref: str
    salt: bytes
    otp_hash: bytes
    issued_at: float
    attempts: int = 0
    consumed: bool = False


def _hash_otp(otp: str, salt: bytes) -> bytes:
    return hmac.new(salt, otp.encode("utf-8"), hashlib.sha256).digest()


def hash_pin(pin: str, salt: bytes | None = None) -> tuple[bytes, bytes]:
    """scrypt-hash a PIN for storage. Returns (salt, hash)."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(pin.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return salt, digest


class StepUpService:
    """In-memory prototype of the step-up flow. Production stores challenges
    in the platform database with the same shape and rules; OTP delivery
    (SMS/e-mail/authenticator) is a delivery-provider concern, out of scope
    here — this service returns the OTP to the caller ONLY via the
    dev/test hook `last_issued_otp`, which the HTTP facade never exposes."""

    def __init__(self, policy: StepUpPolicy | None = None, clock=time.time) -> None:
        self.policy = policy or StepUpPolicy()
        self._clock = clock
        self._challenges: dict[str, _Challenge] = {}
        self._last_issue: dict[tuple[str, str], float] = {}
        self._lockout_until: dict[tuple[str, str], float] = {}
        self._pins: dict[tuple[str, str], tuple[bytes, bytes]] = {}
        self.last_issued_otp: str | None = None  # dev/test hook only

    # -- OTP -----------------------------------------------------------------

    def issue_otp(self, tenant_id: str, subject_ref: str) -> StepUpResult:
        key = (tenant_id, subject_ref)
        now = self._clock()
        locked = self._lockout_until.get(key, 0.0)
        if now < locked:
            return StepUpResult(StepUpStatus.DENIED, "STEPUP_LOCKED_OUT")
        last = self._last_issue.get(key, 0.0)
        if now - last < self.policy.resend_cooldown_seconds:
            return StepUpResult(StepUpStatus.DENIED, "STEPUP_RESEND_TOO_SOON")

        otp = "".join(secrets.choice("0123456789") for _ in range(self.policy.otp_length))
        salt = secrets.token_bytes(16)
        challenge = _Challenge(str(uuid.uuid4()), tenant_id, subject_ref, salt,
                               _hash_otp(otp, salt), now)
        self._challenges[challenge.challenge_id] = challenge
        self._last_issue[key] = now
        self.last_issued_otp = otp
        return StepUpResult(StepUpStatus.PENDING, "OTP_ISSUED", challenge.challenge_id, "otp")

    def verify_otp(self, challenge_id: str, otp: str) -> StepUpResult:
        challenge = self._challenges.get(challenge_id)
        if challenge is None:
            return StepUpResult(StepUpStatus.DENIED, "CHALLENGE_UNKNOWN", challenge_id, "otp")
        key = (challenge.tenant_id, challenge.subject_ref)
        now = self._clock()
        if challenge.consumed:
            return StepUpResult(StepUpStatus.DENIED, "CHALLENGE_REPLAYED", challenge_id, "otp")
        if now < self._lockout_until.get(key, 0.0):
            return StepUpResult(StepUpStatus.DENIED, "STEPUP_LOCKED_OUT", challenge_id, "otp")
        if now - challenge.issued_at > self.policy.otp_ttl_seconds:
            challenge.consumed = True
            return StepUpResult(StepUpStatus.DENIED, "CHALLENGE_EXPIRED", challenge_id, "otp")
        if challenge.attempts >= self.policy.max_attempts:
            challenge.consumed = True
            self._lockout_until[key] = now + self.policy.lockout_seconds
            return StepUpResult(StepUpStatus.DENIED, "STEPUP_ATTEMPTS_EXHAUSTED", challenge_id, "otp")

        challenge.attempts += 1
        if hmac.compare_digest(_hash_otp(otp, challenge.salt), challenge.otp_hash):
            challenge.consumed = True
            return StepUpResult(StepUpStatus.SATISFIED, "OTP_CONFIRMED", challenge_id, "otp")
        if challenge.attempts >= self.policy.max_attempts:
            challenge.consumed = True
            self._lockout_until[key] = now + self.policy.lockout_seconds
            return StepUpResult(StepUpStatus.DENIED, "STEPUP_ATTEMPTS_EXHAUSTED", challenge_id, "otp")
        return StepUpResult(StepUpStatus.PENDING, "OTP_INCORRECT", challenge_id, "otp")

    # -- PIN -----------------------------------------------------------------

    def enrol_pin(self, tenant_id: str, subject_ref: str, pin: str) -> None:
        if len(pin) < self.policy.pin_min_length or not pin.isdigit():
            raise ValueError("PIN does not meet policy requirements.")
        self._pins[(tenant_id, subject_ref)] = hash_pin(pin)

    def verify_pin(self, tenant_id: str, subject_ref: str, pin: str) -> StepUpResult:
        key = (tenant_id, subject_ref)
        now = self._clock()
        if now < self._lockout_until.get(key, 0.0):
            return StepUpResult(StepUpStatus.DENIED, "STEPUP_LOCKED_OUT", None, "pin")
        stored = self._pins.get(key)
        if stored is None:
            return StepUpResult(StepUpStatus.DENIED, "PIN_NOT_ENROLLED", None, "pin")
        salt, expected = stored
        _, candidate = hash_pin(pin, salt)
        if hmac.compare_digest(candidate, expected):
            return StepUpResult(StepUpStatus.SATISFIED, "PIN_CONFIRMED", None, "pin")
        return StepUpResult(StepUpStatus.DENIED, "PIN_INCORRECT", None, "pin")
