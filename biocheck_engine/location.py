"""Location context.

Evaluates where a verification is happening against tenant policy and
recent history. Design rules:

- Location inputs are caller-supplied signals (GPS, network, site
  terminal). They are advisory CONTEXT, not proof — client-side location
  can be spoofed, and this module never claims otherwise.
- Output is a risk level with reason codes; it never approves anything on
  its own. DENY (embargoed country / blocked site) forces rejection
  upstream; elevated risk forces step-up or review.
- Impossible-travel uses great-circle speed between consecutive
  observations for the same subject.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import Enum


class LocationRisk(str, Enum):
    NORMAL = "normal"
    ELEVATED = "elevated"
    DENY = "deny"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class LocationObservation:
    latitude: float
    longitude: float
    country_code: str | None = None      # ISO 3166-1 alpha-2, if resolved
    source: str = "unspecified"          # "gps" | "network" | "site-terminal" | ...
    observed_at_ms: int | None = None


@dataclass(frozen=True)
class GeoFence:
    name: str
    latitude: float
    longitude: float
    radius_metres: float


@dataclass(frozen=True)
class LocationSignal:
    risk: LocationRisk
    reason_code: str
    matched_fence: str | None = None
    computed_speed_kmh: float | None = None


@dataclass(frozen=True)
class LocationPolicy:
    policy_id: str = "biocheck-location-v1"
    allowed_countries: tuple[str, ...] = ()   # empty = no country restriction
    denied_countries: tuple[str, ...] = ()
    fences: tuple[GeoFence, ...] = ()         # if set, inside-any-fence is expected
    require_fence: bool = False               # outside all fences => ELEVATED
    max_travel_speed_kmh: float = 900.0       # ~ airliner; faster => impossible travel
    missing_location_risk: LocationRisk = LocationRisk.ELEVATED


EARTH_RADIUS_M = 6_371_000.0


def haversine_metres(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


class LocationService:
    """In-memory prototype; production persists last observations per
    tenant+subject with the same semantics."""

    def __init__(self, policy: LocationPolicy | None = None, clock=time.time) -> None:
        self.policy = policy or LocationPolicy()
        self._clock = clock
        self._last: dict[tuple[str, str], LocationObservation] = {}

    def evaluate(self, tenant_id: str, subject_ref: str,
                 observation: LocationObservation | None) -> LocationSignal:
        policy = self.policy
        if observation is None:
            return LocationSignal(policy.missing_location_risk, "LOCATION_MISSING")

        now_ms = observation.observed_at_ms or int(self._clock() * 1000)
        observation = LocationObservation(observation.latitude, observation.longitude,
                                          observation.country_code, observation.source, now_ms)

        # Country checks (hard deny wins over everything).
        cc = (observation.country_code or "").upper() or None
        if cc and cc in {c.upper() for c in policy.denied_countries}:
            return LocationSignal(LocationRisk.DENY, "COUNTRY_DENIED")
        if policy.allowed_countries:
            if cc is None:
                return LocationSignal(LocationRisk.ELEVATED, "COUNTRY_UNRESOLVED")
            if cc not in {c.upper() for c in policy.allowed_countries}:
                return LocationSignal(LocationRisk.DENY, "COUNTRY_NOT_ALLOWED")

        # Impossible travel vs previous observation.
        key = (tenant_id, subject_ref)
        previous = self._last.get(key)
        speed_kmh: float | None = None
        if previous is not None and previous.observed_at_ms is not None:
            dt_s = max((now_ms - previous.observed_at_ms) / 1000.0, 1.0)
            dist_m = haversine_metres(previous.latitude, previous.longitude,
                                      observation.latitude, observation.longitude)
            speed_kmh = (dist_m / dt_s) * 3.6
            if speed_kmh > policy.max_travel_speed_kmh:
                self._last[key] = observation
                return LocationSignal(LocationRisk.ELEVATED, "IMPOSSIBLE_TRAVEL",
                                      computed_speed_kmh=round(speed_kmh, 1))
        self._last[key] = observation

        # Geo-fence checks.
        matched: str | None = None
        for fence in policy.fences:
            if haversine_metres(fence.latitude, fence.longitude,
                                observation.latitude, observation.longitude) <= fence.radius_metres:
                matched = fence.name
                break
        if policy.require_fence and matched is None:
            return LocationSignal(LocationRisk.ELEVATED, "OUTSIDE_APPROVED_SITES",
                                  computed_speed_kmh=speed_kmh)
        return LocationSignal(LocationRisk.NORMAL,
                              "WITHIN_APPROVED_SITE" if matched else "LOCATION_OK",
                              matched, speed_kmh)
