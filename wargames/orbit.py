"""Keplerian TLE propagator (stdlib) for Space Sector.

Good enough for a CRT ground-track: a few tens of km vs SGP4 on a fresh TLE.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

MU = 398600.4418  # km^3/s^2
RE = 6378.137  # km WGS84
F_WGS = 1.0 / 298.257223563
DEG = math.pi / 180.0


def _parse_epoch(line1: str) -> datetime:
    yy = int(line1[18:20])
    year = 2000 + yy if yy < 57 else 1900 + yy
    doy = float(line1[20:32])
    day = int(doy)
    frac = doy - day
    start = datetime(year, 1, 1, tzinfo=timezone.utc)
    return datetime.fromtimestamp(start.timestamp() + (day - 1) * 86400 + frac * 86400, tz=timezone.utc)


def parse_tle(name: str, line1: str, line2: str) -> dict[str, Any]:
    e = float("0." + line2[26:33].strip())
    n = float(line2[52:63])  # rev/day
    return {
        "name": name.strip() or f"NORAD {line2[2:7].strip()}",
        "norad": line2[2:7].strip(),
        "epoch": _parse_epoch(line1),
        "incl": float(line2[8:16]) * DEG,
        "raan": float(line2[17:25]) * DEG,
        "ecc": e,
        "argp": float(line2[34:42]) * DEG,
        "m0": float(line2[43:51]) * DEG,
        "n": n * 2.0 * math.pi / 86400.0,  # rad/s
        "line1": line1.strip(),
        "line2": line2.strip(),
    }


def parse_tle_block(text: str) -> list[dict[str, Any]]:
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    out: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        if lines[i].startswith("1 ") and i + 1 < len(lines) and lines[i + 1].startswith("2 "):
            name = f"NORAD {lines[i][2:7].strip()}"
            out.append(parse_tle(name, lines[i], lines[i + 1]))
            i += 2
            continue
        if i + 2 < len(lines) and lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
            out.append(parse_tle(lines[i], lines[i + 1], lines[i + 2]))
            i += 3
            continue
        i += 1
    return out


def _kepler(M: float, e: float) -> float:
    E = M
    for _ in range(12):
        E = M + e * math.sin(E)
    return E


def _gmst(t: datetime) -> float:
    # IAU-ish GMST from unix seconds
    jd = t.timestamp() / 86400.0 + 2440587.5
    t_ut = (jd - 2451545.0) / 36525.0
    gmst_deg = (
        280.46061837
        + 360.98564736629 * (jd - 2451545.0)
        + 0.000387933 * t_ut * t_ut
        - t_ut * t_ut * t_ut / 38710000.0
    ) % 360.0
    return gmst_deg * DEG


def propagate(tle: dict[str, Any], when: datetime) -> tuple[float, float, float, float]:
    """Return (lat_deg, lon_deg, alt_km, vel_kms)."""
    dt = (when - tle["epoch"]).total_seconds()
    n = tle["n"]
    e = tle["ecc"]
    a = (MU / (n * n)) ** (1.0 / 3.0)
    M = (tle["m0"] + n * dt) % (2.0 * math.pi)
    E = _kepler(M, e)
    cos_E, sin_E = math.cos(E), math.sin(E)
    nu = math.atan2(math.sqrt(1 - e * e) * sin_E, cos_E - e)
    r = a * (1 - e * cos_E)
    u = tle["argp"] + nu
    i = tle["incl"]
    O = tle["raan"]
    cos_u, sin_u = math.cos(u), math.sin(u)
    cos_O, sin_O = math.cos(O), math.sin(O)
    cos_i, sin_i = math.cos(i), math.sin(i)
    x = r * (cos_O * cos_u - sin_O * sin_u * cos_i)
    y = r * (sin_O * cos_u + cos_O * sin_u * cos_i)
    z = r * (sin_u * sin_i)
    # inertial velocity magnitude from vis-viva
    vel = math.sqrt(max(0.0, MU * (2.0 / r - 1.0 / a)))
    # ECI -> ECEF
    theta = _gmst(when)
    ct, st = math.cos(theta), math.sin(theta)
    xe = ct * x + st * y
    ye = -st * x + ct * y
    ze = z
    lon = math.atan2(ye, xe)
    hyp = math.hypot(xe, ye)
    lat = math.atan2(ze, hyp)
    # iterate geodetic lat
    e2 = F_WGS * (2 - F_WGS)
    for _ in range(4):
        sin_lat = math.sin(lat)
        N = RE / math.sqrt(1 - e2 * sin_lat * sin_lat)
        lat = math.atan2(ze + e2 * N * sin_lat, hyp)
    sin_lat = math.sin(lat)
    N = RE / math.sqrt(1 - e2 * sin_lat * sin_lat)
    alt = hyp / max(1e-9, math.cos(lat)) - N
    return lat / DEG, lon / DEG, alt, vel


def ecef_from_llh(lat_deg: float, lon_deg: float, alt_km: float) -> tuple[float, float, float]:
    lat, lon = lat_deg * DEG, lon_deg * DEG
    e2 = F_WGS * (2 - F_WGS)
    sin_lat = math.sin(lat)
    N = RE / math.sqrt(1 - e2 * sin_lat * sin_lat)
    x = (N + alt_km) * math.cos(lat) * math.cos(lon)
    y = (N + alt_km) * math.cos(lat) * math.sin(lon)
    z = (N * (1 - e2) + alt_km) * sin_lat
    return x, y, z


def look_angles(
    sat_lat: float, sat_lon: float, sat_alt: float,
    obs_lat: float, obs_lon: float, obs_alt: float = 0.15,
) -> tuple[float, float, float]:
    """Azimuth deg, elevation deg, range km from observer."""
    sx, sy, sz = ecef_from_llh(sat_lat, sat_lon, sat_alt)
    ox, oy, oz = ecef_from_llh(obs_lat, obs_lon, obs_alt)
    dx, dy, dz = sx - ox, sy - oy, sz - oz
    rng = math.sqrt(dx * dx + dy * dy + dz * dz)
    lat, lon = obs_lat * DEG, obs_lon * DEG
    sl, cl = math.sin(lat), math.cos(lat)
    so, co = math.sin(lon), math.cos(lon)
    south = sl * co * dx + sl * so * dy - cl * dz
    east = -so * dx + co * dy
    up = cl * co * dx + cl * so * dy + sl * dz
    az = (math.atan2(east, south) / DEG + 360.0) % 360.0
    el = math.atan2(up, math.hypot(east, south)) / DEG
    return az, el, rng


def ground_track(tle: dict[str, Any], when: datetime, minutes: float = 92.0, step_s: float = 45.0) -> list[list[float]]:
    pts = []
    t0 = when.timestamp()
    n = int(minutes * 60 / step_s) + 1
    for i in range(n):
        t = datetime.fromtimestamp(t0 + i * step_s, tz=timezone.utc)
        lat, lon, _, _ = propagate(tle, t)
        pts.append([round(lat, 3), round(lon, 3)])
    return pts
