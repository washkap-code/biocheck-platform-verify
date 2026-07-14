from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes


def _master_key() -> bytes:
    encoded = os.environ.get("BIOCHECK_MASTER_KEY_B64")
    if not encoded:
        raise RuntimeError("BIOCHECK_MASTER_KEY_B64 must be set (32-byte urlsafe base64 key).")
    key = base64.urlsafe_b64decode(encoded)
    if len(key) != 32:
        raise RuntimeError("BIOCHECK_MASTER_KEY_B64 must decode to exactly 32 bytes.")
    return key


def tenant_key(tenant_id: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=("biocheck-template-v1:" + tenant_id).encode()).derive(_master_key())


@dataclass(frozen=True)
class EncryptedBlob:
    nonce_b64: str
    ciphertext_b64: str


def encrypt_json(tenant_id: str, payload: dict) -> EncryptedBlob:
    nonce = os.urandom(12)
    plaintext = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    ciphertext = AESGCM(tenant_key(tenant_id)).encrypt(nonce, plaintext, tenant_id.encode())
    return EncryptedBlob(base64.urlsafe_b64encode(nonce).decode(), base64.urlsafe_b64encode(ciphertext).decode())


def decrypt_json(tenant_id: str, blob: EncryptedBlob) -> dict:
    plaintext = AESGCM(tenant_key(tenant_id)).decrypt(
        base64.urlsafe_b64decode(blob.nonce_b64),
        base64.urlsafe_b64decode(blob.ciphertext_b64), tenant_id.encode())
    return json.loads(plaintext)


def digest(event: dict, previous_hash: str = "") -> str:
    canonical = json.dumps(event, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(previous_hash.encode() + canonical).hexdigest()
