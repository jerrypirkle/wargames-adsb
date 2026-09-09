"""NORAD TLE catalog for Space Sector (ISS, CSS, Hubble, NOAA-19)."""

from __future__ import annotations

import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

from orbit import ground_track, look_angles, parse_tle_block, propagate

UA = "wargames-adsb/1.0 (+https://github.com/jerrypirkle/wargames-adsb)"
KEEP = {
    "25544": "ISS",
    "48274": "CSS TIANHE",
    "20580": "HUBBLE",
    "33591": "NOAA 19",
}
URLS = [
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=TLE",
    "https://celestrak.org/NORAD/elements/gp.php?CATNR=20580&FORMAT=TLE",
    "https://celestrak.org/NORAD/elements/gp.php?CATNR=33591&FORMAT=TLE",
]


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=12) as resp:
        return resp.read().decode("ascii", "replace")


def fetch_tles() -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for url in URLS:
        try:
            text = _get(url)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            continue
        for tle in parse_tle_block(text):
            nid = str(tle.get("norad") or "")
            if nid in KEEP and nid not in found:
                tle["name"] = KEEP[nid]
                found[nid] = tle
    return [found[k] for k in KEEP if k in found]


def snapshot_objects(tles: list[dict[str, Any]], lat: float, lon: float) -> list[dict[str, Any]]:
    when = datetime.now(timezone.utc)
    out = []
    for tle in tles:
        slat, slon, alt, vel = propagate(tle, when)
        az, el, rng = look_angles(slat, slon, alt, lat, lon)
        nid = tle["norad"]
        track = ground_track(tle, when) if nid in ("25544", "48274") else []
        out.append({
            "id": nid,
            "name": tle["name"],
            "lat": round(slat, 4),
            "lon": round(slon, 4),
            "alt_km": round(alt, 1),
            "vel_kms": round(vel, 3),
            "az": round(az, 1),
            "el": round(el, 1),
            "range_km": round(rng, 0),
            "aos": el > 0,
            "track": track,
        })
    return out


def space_loop(store: Any, stop: threading.Event) -> None:
    tles: list[dict[str, Any]] = []
    last_fetch = 0.0
    while not stop.is_set():
        now = time.time()
        if now - last_fetch > 6 * 3600 or not tles:
            got = fetch_tles()
            if got:
                tles = got
                last_fetch = now
        if tles:
            rx = store.rx
            objs = snapshot_objects(tles, float(rx["lat"]), float(rx["lon"]))
            with store.lock:
                store.space = {
                    "source": "norad-tle",
                    "objects": objs,
                    "updated": time.time(),
                }
        stop.wait(2.0 if tles else 8.0)
