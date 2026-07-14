from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ModelCard:
    model_id: str
    sha256: str
    purpose: str
    commercial_use_approved: bool
    independent_report_ref: str
    approved_by: str
    expires_on: str


class ModelRegistry:
    """A release gate. Production persists signed cards in a controlled registry."""
    def __init__(self) -> None:
        self._cards: dict[str, ModelCard] = {}

    @staticmethod
    def sha256_file(path: str | Path) -> str:
        hasher = hashlib.sha256()
        with Path(path).open("rb") as fh:
            for block in iter(lambda: fh.read(1024 * 1024), b""):
                hasher.update(block)
        return hasher.hexdigest()

    def approve(self, card: ModelCard) -> None:
        if not card.commercial_use_approved:
            raise ValueError("Model licence has not been approved for commercial biometric use.")
        if not card.independent_report_ref:
            raise ValueError("An independent evaluation report reference is required.")
        if len(card.sha256) != 64:
            raise ValueError("Model SHA-256 is invalid.")
        self._cards[card.model_id] = card

    def assert_allowed(self, model_id: str, sha256: str, purpose: str) -> ModelCard:
        card = self._cards.get(model_id)
        if card is None:
            raise PermissionError("Model is not in the approved registry.")
        if card.sha256 != sha256 or card.purpose != purpose:
            raise PermissionError("Model identity, hash or authorised purpose does not match registry.")
        return card
