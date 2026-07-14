from __future__ import annotations

import time
from dataclasses import asdict

from .crypto import digest
from .types import VerificationResult


class AuditChain:
    """Tamper-evident event log; production writes to immutable/WORM storage."""
    def __init__(self) -> None:
        self.events: list[dict] = []
        self._previous_hash = ""

    def append(self, result: VerificationResult, tenant_id: str, subject_ref: str) -> str:
        event = {"at": int(time.time() * 1000), "tenant": tenant_id, "subject": subject_ref,
                 "result": asdict(result), "previous_hash": self._previous_hash}
        event["result"]["decision"] = result.decision.value
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
