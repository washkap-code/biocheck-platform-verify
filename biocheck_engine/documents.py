"""Document verification — machine-readable zone (MRZ).

Parses and validates ICAO 9303 MRZ lines from travel documents:

- TD3 (passports): 2 lines × 44 characters
- TD1 (ID cards):  3 lines × 30 characters

Scope and honesty rules:

- Input is MRZ TEXT supplied by the caller (from OCR or manual entry).
  This module performs NO OCR and NO image processing; OCR quality is a
  capture-layer concern.
- Check-digit validation proves internal consistency of the MRZ — it
  does NOT prove the document is genuine. Chip (eMRTD/PKI) verification,
  security-feature inspection and issuer lookups are Planned and out of
  scope here; the result contract says exactly what was checked.
- Fail-closed: malformed structure, failed check digits or an expired
  document produce FAILED/REVIEW signals, never a silent pass.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from enum import Enum

_CHAR_VALUES = {c: i for i, c in enumerate("0123456789")}
_CHAR_VALUES.update({c: i + 10 for i, c in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ")})
_CHAR_VALUES["<"] = 0
_WEIGHTS = (7, 3, 1)


class DocumentCheckStatus(str, Enum):
    PASSED = "passed"      # structure + all check digits valid, not expired
    REVIEW = "review"      # parseable but with defects needing a human
    FAILED = "failed"      # structurally invalid or check digits wrong


@dataclass(frozen=True)
class MrzResult:
    status: DocumentCheckStatus
    reason_codes: tuple[str, ...]
    format: str | None = None            # "TD3" | "TD1"
    document_type: str | None = None     # e.g. "P", "I"
    issuing_state: str | None = None
    document_number: str | None = None
    nationality: str | None = None
    birth_date: str | None = None        # ISO yyyy-mm-dd where resolvable
    expiry_date: str | None = None
    sex: str | None = None
    surname: str | None = None
    given_names: str | None = None
    checks: tuple[str, ...] = ()         # which validations actually ran


def check_digit(data: str) -> int:
    total = 0
    for i, ch in enumerate(data):
        value = _CHAR_VALUES.get(ch.upper())
        if value is None:
            raise ValueError(f"Invalid MRZ character: {ch!r}")
        total += value * _WEIGHTS[i % 3]
    return total % 10


def _digit_ok(data: str, digit_char: str) -> bool:
    if digit_char == "<":  # optional field, filler allowed where spec permits
        return check_digit(data) == 0 or set(data) == {"<"}
    if not digit_char.isdigit():
        return False
    return check_digit(data) == int(digit_char)


def _parse_date(yymmdd: str, *, is_expiry: bool, today: _dt.date) -> str | None:
    if len(yymmdd) != 6 or not yymmdd.isdigit():
        return None
    yy, mm, dd = int(yymmdd[0:2]), int(yymmdd[2:4]), int(yymmdd[4:6])
    if is_expiry:
        century = 2000  # expiry dates are always interpreted forward
    else:
        century = 1900 if yy > (today.year % 100) else 2000
    try:
        return _dt.date(century + yy, mm, dd).isoformat()
    except ValueError:
        return None


def _names(field_data: str) -> tuple[str, str]:
    parts = field_data.split("<<", 1)
    surname = parts[0].replace("<", " ").strip()
    given = parts[1].replace("<", " ").strip() if len(parts) > 1 else ""
    return surname, given


def parse_mrz(lines: list[str], *, today: _dt.date | None = None) -> MrzResult:
    today = today or _dt.date.today()
    cleaned = [ln.strip().upper() for ln in lines if ln.strip()]
    if len(cleaned) == 2 and all(len(ln) == 44 for ln in cleaned):
        return _parse_td3(cleaned, today)
    if len(cleaned) == 3 and all(len(ln) == 30 for ln in cleaned):
        return _parse_td1(cleaned, today)
    return MrzResult(DocumentCheckStatus.FAILED, ("MRZ_STRUCTURE_INVALID",))


def _finalise(reasons: list[str], checks: list[str], expiry_iso: str | None,
              today: _dt.date, **fields) -> MrzResult:
    if expiry_iso is not None:
        checks.append("expiry")
        if _dt.date.fromisoformat(expiry_iso) < today:
            reasons.append("DOCUMENT_EXPIRED")
    hard = [r for r in reasons if r.endswith("_CHECK_FAILED") or r == "MRZ_STRUCTURE_INVALID"]
    if hard:
        status = DocumentCheckStatus.FAILED
    elif reasons:
        status = DocumentCheckStatus.REVIEW
    else:
        status = DocumentCheckStatus.PASSED
        reasons.append("MRZ_CONSISTENT")
    return MrzResult(status, tuple(reasons), checks=tuple(checks), **fields)


def _parse_td3(lines: list[str], today: _dt.date) -> MrzResult:
    l1, l2 = lines
    reasons: list[str] = []
    checks = ["structure", "doc_number_check", "birth_check", "expiry_check", "composite_check"]

    doc_number, doc_cd = l2[0:9], l2[9]
    birth, birth_cd = l2[13:19], l2[19]
    expiry, expiry_cd = l2[21:27], l2[27]
    personal_number, personal_cd = l2[28:42], l2[42]
    composite_cd = l2[43]

    try:
        if not _digit_ok(doc_number, doc_cd):
            reasons.append("DOC_NUMBER_CHECK_FAILED")
        if not _digit_ok(birth, birth_cd):
            reasons.append("BIRTH_DATE_CHECK_FAILED")
        if not _digit_ok(expiry, expiry_cd):
            reasons.append("EXPIRY_DATE_CHECK_FAILED")
        if personal_number.strip("<"):
            checks.append("personal_number_check")
            if not _digit_ok(personal_number, personal_cd):
                reasons.append("PERSONAL_NUMBER_CHECK_FAILED")
        composite = doc_number + doc_cd + birth + birth_cd + expiry + expiry_cd + personal_number + personal_cd
        if not _digit_ok(composite, composite_cd):
            reasons.append("COMPOSITE_CHECK_FAILED")
    except ValueError:
        return MrzResult(DocumentCheckStatus.FAILED, ("MRZ_STRUCTURE_INVALID",))

    surname, given = _names(l1[5:44])
    return _finalise(reasons, checks, _parse_date(expiry, is_expiry=True, today=today), today,
                     format="TD3", document_type=l1[0:2].rstrip("<"),
                     issuing_state=l1[2:5].rstrip("<") or None,
                     document_number=doc_number.rstrip("<") or None,
                     nationality=l2[10:13].rstrip("<") or None,
                     birth_date=_parse_date(birth, is_expiry=False, today=today),
                     expiry_date=_parse_date(expiry, is_expiry=True, today=today),
                     sex=l2[20] if l2[20] in ("M", "F") else None,
                     surname=surname or None, given_names=given or None)


def _parse_td1(lines: list[str], today: _dt.date) -> MrzResult:
    l1, l2, l3 = lines
    reasons: list[str] = []
    checks = ["structure", "doc_number_check", "birth_check", "expiry_check", "composite_check"]

    doc_number, doc_cd = l1[5:14], l1[14]
    birth, birth_cd = l2[0:6], l2[6]
    expiry, expiry_cd = l2[8:14], l2[14]
    composite_cd = l2[29]

    try:
        if not _digit_ok(doc_number, doc_cd):
            reasons.append("DOC_NUMBER_CHECK_FAILED")
        if not _digit_ok(birth, birth_cd):
            reasons.append("BIRTH_DATE_CHECK_FAILED")
        if not _digit_ok(expiry, expiry_cd):
            reasons.append("EXPIRY_DATE_CHECK_FAILED")
        composite = l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29]
        if not _digit_ok(composite, composite_cd):
            reasons.append("COMPOSITE_CHECK_FAILED")
    except ValueError:
        return MrzResult(DocumentCheckStatus.FAILED, ("MRZ_STRUCTURE_INVALID",))

    surname, given = _names(l3)
    return _finalise(reasons, checks, _parse_date(expiry, is_expiry=True, today=today), today,
                     format="TD1", document_type=l1[0:2].rstrip("<"),
                     issuing_state=l1[2:5].rstrip("<") or None,
                     document_number=doc_number.rstrip("<") or None,
                     nationality=l2[15:18].rstrip("<") or None,
                     birth_date=_parse_date(birth, is_expiry=False, today=today),
                     expiry_date=_parse_date(expiry, is_expiry=True, today=today),
                     sex=l2[7] if l2[7] in ("M", "F") else None,
                     surname=surname or None, given_names=given or None)
