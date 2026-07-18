from biocheck_engine.location import (GeoFence, LocationObservation, LocationPolicy,
                                      LocationRisk, LocationService, haversine_metres)

HARARE = (-17.8292, 31.0522)
BULAWAYO = (-20.1325, 28.6265)
LONDON = (51.5074, -0.1278)


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


def obs(latlon, cc="ZW", at_ms=None, source="gps"):
    return LocationObservation(latlon[0], latlon[1], cc, source, at_ms)


def test_haversine_sanity():
    d = haversine_metres(*HARARE, *BULAWAYO)
    assert 350_000 < d < 480_000  # Harare–Bulawayo ≈ 366 km


def test_missing_location_fails_closed_to_elevated():
    svc = LocationService()
    assert svc.evaluate("t1", "s1", None).risk == LocationRisk.ELEVATED


def test_denied_country_is_hard_deny():
    svc = LocationService(LocationPolicy(denied_countries=("XX",)))
    assert svc.evaluate("t1", "s1", obs(HARARE, "XX")).risk == LocationRisk.DENY


def test_allowed_countries_enforced():
    svc = LocationService(LocationPolicy(allowed_countries=("ZW", "ZA")))
    assert svc.evaluate("t1", "s1", obs(HARARE, "ZW")).risk == LocationRisk.NORMAL
    assert svc.evaluate("t1", "s1", obs(LONDON, "GB")).risk == LocationRisk.DENY
    assert svc.evaluate("t1", "s1", obs(HARARE, None)).reason_code == "COUNTRY_UNRESOLVED"


def test_geofence_match_and_require_fence():
    fence = GeoFence("HQ", *HARARE, radius_metres=500)
    svc = LocationService(LocationPolicy(fences=(fence,), require_fence=True))
    inside = svc.evaluate("t1", "s1", obs(HARARE))
    assert inside.risk == LocationRisk.NORMAL and inside.matched_fence == "HQ"
    outside = svc.evaluate("t1", "s1", obs(BULAWAYO, at_ms=1_000_000_000))
    # Bulawayo minutes later would also be impossible travel; use a fresh subject
    outside2 = svc.evaluate("t1", "s2", obs(BULAWAYO))
    assert outside2.risk == LocationRisk.ELEVATED
    assert outside2.reason_code == "OUTSIDE_APPROVED_SITES"


def test_impossible_travel_flagged():
    clock = Clock()
    svc = LocationService(clock=clock)
    svc.evaluate("t1", "s1", obs(HARARE, at_ms=int(clock.now * 1000)))
    # London 10 minutes later: ~8,200 km => tens of thousands of km/h.
    later = int((clock.now + 600) * 1000)
    signal = svc.evaluate("t1", "s1", obs(LONDON, "GB", at_ms=later))
    assert signal.risk == LocationRisk.ELEVATED
    assert signal.reason_code == "IMPOSSIBLE_TRAVEL"
    assert signal.computed_speed_kmh and signal.computed_speed_kmh > 900


def test_plausible_travel_ok():
    clock = Clock()
    svc = LocationService(clock=clock)
    svc.evaluate("t1", "s1", obs(HARARE, at_ms=int(clock.now * 1000)))
    # Bulawayo 5 hours later ≈ 73 km/h.
    later = int((clock.now + 5 * 3600) * 1000)
    assert svc.evaluate("t1", "s1", obs(BULAWAYO, at_ms=later)).risk == LocationRisk.NORMAL


def test_travel_history_is_tenant_subject_scoped():
    clock = Clock()
    svc = LocationService(clock=clock)
    svc.evaluate("t1", "s1", obs(HARARE, at_ms=int(clock.now * 1000)))
    later = int((clock.now + 600) * 1000)
    # Different subject: no history, no impossible travel.
    assert svc.evaluate("t1", "s2", obs(LONDON, "GB", at_ms=later)).risk == LocationRisk.NORMAL
