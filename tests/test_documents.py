import datetime as dt

from biocheck_engine.documents import DocumentCheckStatus, check_digit, parse_mrz

# ICAO Doc 9303 specimen (Utopia / ERIKSSON, ANNA MARIA)
TD3 = [
    "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
    "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
]
TD1 = [
    "I<UTOD231458907<<<<<<<<<<<<<<<",
    "7408122F1204159UTO<<<<<<<<<<<6",
    "ERIKSSON<<ANNA<MARIA<<<<<<<<<<",
]

BEFORE_EXPIRY = dt.date(2011, 1, 1)
AFTER_EXPIRY = dt.date(2026, 7, 18)


def test_check_digit_known_values():
    assert check_digit("L898902C3") == 6
    assert check_digit("740812") == 2
    assert check_digit("120415") == 9


def test_td3_specimen_parses_and_passes():
    r = parse_mrz(TD3, today=BEFORE_EXPIRY)
    assert r.status == DocumentCheckStatus.PASSED
    assert r.format == "TD3" and r.document_type == "P"
    assert r.issuing_state == "UTO" and r.nationality == "UTO"
    assert r.document_number == "L898902C3"
    assert r.surname == "ERIKSSON" and r.given_names == "ANNA MARIA"
    assert r.birth_date == "1974-08-12" and r.expiry_date == "2012-04-15"
    assert r.sex == "F"
    assert "composite_check" in r.checks


def test_td1_specimen_parses_and_passes():
    r = parse_mrz(TD1, today=BEFORE_EXPIRY)
    assert r.status == DocumentCheckStatus.PASSED
    assert r.format == "TD1" and r.document_type == "I"
    assert r.document_number == "D23145890"
    assert r.surname == "ERIKSSON" and r.given_names == "ANNA MARIA"


def test_expired_document_goes_to_review():
    r = parse_mrz(TD3, today=AFTER_EXPIRY)
    assert r.status == DocumentCheckStatus.REVIEW
    assert "DOCUMENT_EXPIRED" in r.reason_codes


def test_tampered_document_number_fails():
    tampered = [TD3[0], "L898902C46" + TD3[1][10:]]  # altered number, stale check digit
    r = parse_mrz(tampered, today=BEFORE_EXPIRY)
    assert r.status == DocumentCheckStatus.FAILED
    assert "DOC_NUMBER_CHECK_FAILED" in r.reason_codes


def test_tampered_birth_date_fails_composite_too():
    l2 = TD3[1][:13] + "750812" + TD3[1][19:]
    r = parse_mrz([TD3[0], l2], today=BEFORE_EXPIRY)
    assert r.status == DocumentCheckStatus.FAILED
    assert "BIRTH_DATE_CHECK_FAILED" in r.reason_codes
    assert "COMPOSITE_CHECK_FAILED" in r.reason_codes


def test_structure_invalid_fails_closed():
    assert parse_mrz(["SHORT", "LINES"]).status == DocumentCheckStatus.FAILED
    assert parse_mrz([]).status == DocumentCheckStatus.FAILED
    assert parse_mrz([TD3[0]]).status == DocumentCheckStatus.FAILED
    assert parse_mrz([TD3[0], TD3[1][:-1] + "?"]).status == DocumentCheckStatus.FAILED


def test_result_reports_which_checks_ran():
    r = parse_mrz(TD3, today=BEFORE_EXPIRY)
    for expected in ("structure", "doc_number_check", "birth_check",
                     "expiry_check", "composite_check", "expiry"):
        assert expected in r.checks
