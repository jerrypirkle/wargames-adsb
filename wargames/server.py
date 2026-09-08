#!/usr/bin/env python3
"""Wargames ADS-B console — dump1090 bridge + static UI server.

Talks to dump1090-fa via:
  - --write-json aircraft.json (preferred; has RSSI / stats)
  - SBS BaseStation TCP :30003 (works with a stock `--net` dump1090)

If neither is available, serves a DFW-area simulation so the CRT still runs.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import socket
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DEFAULT_CONFIG = ROOT / "config.json"

DEG = math.pi / 180.0


def load_config(path: Path) -> dict[str, Any]:
    cfg = {
        "lat": 32.9,
        "lon": -97.0,
        "port": 8090,
        "title": "DFW SECTOR",
        "callsign": "NORTEX",
        "sbs_host": "127.0.0.1",
        "sbs_port": 30003,
        "json_dir": "run",
    }
    if path.is_file():
        cfg.update(json.loads(path.read_text()))
    return cfg


def nm_step(lat: float, lon: float, track: float, nm: float) -> tuple[float, float]:
    rad = track * DEG
    lat2 = lat + (nm * math.cos(rad)) / 60.0
    lon2 = lon + (nm * math.sin(rad)) / (60.0 * max(0.2, math.cos(lat * DEG)))
    return lat2, lon2


def _float(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _alt(v: Any) -> int | None:
    if v is None or v == "":
        return None
    if isinstance(v, str) and v.lower() == "ground":
        return 0
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


class Store:
    def __init__(self, lat: float, lon: float, title: str, callsign: str):
        self.lock = threading.Lock()
        self.rx = {"lat": lat, "lon": lon}
        self.title = title
        self.callsign = callsign
        self.aircraft: dict[str, dict[str, Any]] = {}
        self.messages = 0
        self.msg_rate = 0.0
        self._msg_tick = (time.time(), 0)
        self.mode = "demo"  # demo | live
        self.source = "demo"  # demo | json | sbs
        self.connected = False
        self.last_data = 0.0
        self.dump1090 = False
        self.started = time.time()
        self.force_demo = False
        self.history_loaded = False

    def snapshot(self) -> dict[str, Any]:
        now = time.time()
        with self.lock:
            stale_after = 60.0 if self.mode == "live" else 120.0
            live = []
            drop = []
            for hexid, ac in self.aircraft.items():
                seen = now - ac.get("_ts", now)
                if seen > stale_after:
                    drop.append(hexid)
                    continue
                row = {k: v for k, v in ac.items() if not k.startswith("_")}
                row["seen"] = round(seen, 1)
                if ac.get("_pos_ts"):
                    row["seen_pos"] = round(now - ac["_pos_ts"], 1)
                live.append(row)
            for hexid in drop:
                self.aircraft.pop(hexid, None)
            if self.mode == "live" and self.last_data and (now - self.last_data) > 8:
                self.connected = False
            return {
                "now": now,
                "mode": self.mode,
                "source": self.source,
                "connected": self.connected,
                "dump1090": self.dump1090,
                "rx": dict(self.rx),
                "title": self.title,
                "callsign": self.callsign,
                "messages": self.messages,
                "rate": round(self.msg_rate, 1),
                "uptime": int(now - self.started),
                "aircraft": live,
            }

    def mark_messages(self, total: int | None = None, increment: int = 0) -> None:
        now = time.time()
        if total is not None:
            self.messages = total
        else:
            self.messages += increment
        t0, m0 = self._msg_tick
        dt = now - t0
        if dt >= 1.5:
            self.msg_rate = max(0.0, (self.messages - m0) / dt)
            self._msg_tick = (now, self.messages)

    def ingest_json_list(self, rows: list[dict[str, Any]], messages: int | None) -> None:
        now = time.time()
        with self.lock:
            if self.force_demo:
                return
            if self.mode != "live":
                self.aircraft.clear()
            self.mode = "live"
            self.source = "json"
            self.connected = True
            self.dump1090 = True
            self.last_data = now
            if messages is not None:
                self.mark_messages(total=messages)
            seen_hex = set()
            for raw in rows:
                ac = normalize_json(raw, now)
                if not ac:
                    continue
                hexid = ac["hex"]
                seen_hex.add(hexid)
                prev = self.aircraft.get(hexid, {})
                merged = {**prev, **{k: v for k, v in ac.items() if v is not None}}
                if ac.get("lat") is not None:
                    merged["_pos_ts"] = now
                merged["_ts"] = now
                self.aircraft[hexid] = merged
            # drop anything dump1090 no longer lists
            for hexid in list(self.aircraft):
                if hexid not in seen_hex:
                    self.aircraft.pop(hexid, None)

    def ingest_sbs(self, fields: list[str]) -> None:
        if len(fields) < 10 or fields[0] != "MSG":
            return
        hexid = (fields[4] or "").strip().lower()
        if not hexid:
            return
        now = time.time()
        with self.lock:
            if self.force_demo:
                return
            if self.source == "json" and (now - self.last_data) < 3:
                # JSON is richer; ignore SBS while JSON is healthy
                return
            if self.mode != "live":
                self.aircraft.clear()
            self.mode = "live"
            self.source = "sbs"
            self.connected = True
            self.dump1090 = True
            self.last_data = now
            self.mark_messages(increment=1)
            ac = self.aircraft.get(hexid, {"hex": hexid})
            ac["_ts"] = now
            try:
                mtype = int(fields[1])
            except ValueError:
                mtype = 0
            if len(fields) > 10 and fields[10].strip():
                ac["flight"] = fields[10].strip()
            if len(fields) > 11 and fields[11].strip():
                ac["alt"] = _alt(fields[11])
            if len(fields) > 12 and fields[12].strip():
                ac["gs"] = _float(fields[12])
            if len(fields) > 13 and fields[13].strip():
                ac["track"] = _float(fields[13])
            if len(fields) > 15 and fields[14].strip() and fields[15].strip():
                lat, lon = _float(fields[14]), _float(fields[15])
                if lat is not None and lon is not None and abs(lat) <= 90 and abs(lon) <= 180:
                    ac["lat"], ac["lon"] = lat, lon
                    ac["_pos_ts"] = now
            if len(fields) > 16 and fields[16].strip():
                ac["vr"] = _int(fields[16])
            if len(fields) > 17 and fields[17].strip():
                ac["squawk"] = fields[17].strip()
            if len(fields) > 21 and fields[21].strip():
                ac["on_ground"] = fields[21].strip() == "1"
            if mtype:
                ac["msgs"] = int(ac.get("msgs") or 0) + 1
            self.aircraft[hexid] = ac

    def ingest_demo(self, rows: list[dict[str, Any]]) -> None:
        now = time.time()
        with self.lock:
            if self.mode == "live" and not self.force_demo:
                return
            self.mode = "demo"
            self.source = "demo"
            self.connected = False
            self.dump1090 = False
            self.aircraft = {r["hex"]: {**r, "_ts": now, "_pos_ts": now} for r in rows}
            self.mark_messages(increment=len(rows))


def normalize_json(raw: dict[str, Any], now: float) -> dict[str, Any] | None:
    hexid = (raw.get("hex") or "").strip().lower()
    if not hexid:
        return None
    flight = (raw.get("flight") or "").strip() or None
    alt = raw.get("alt_baro")
    if alt is None:
        alt = raw.get("altitude")
    on_ground = False
    if isinstance(alt, str) and alt.lower() == "ground":
        alt = 0
        on_ground = True
    alt = _alt(alt)
    gs = _float(raw.get("gs", raw.get("speed")))
    track = _float(raw.get("track"))
    vr = _int(raw.get("baro_rate", raw.get("vert_rate", raw.get("vr"))))
    lat = _float(raw.get("lat"))
    lon = _float(raw.get("lon"))
    squawk = raw.get("squawk")
    if squawk is not None:
        squawk = str(squawk).strip() or None
    rssi = _float(raw.get("rssi"))
    emergency = raw.get("emergency")
    if emergency in (None, "none", ""):
        emergency = None
    return {
        "hex": hexid,
        "flight": flight,
        "lat": lat,
        "lon": lon,
        "alt": alt,
        "gs": gs,
        "track": track,
        "vr": vr,
        "squawk": squawk,
        "rssi": rssi,
        "msgs": _int(raw.get("messages")) or 0,
        "on_ground": bool(raw.get("on_ground") or on_ground),
        "emergency": emergency,
        "category": raw.get("category"),
        "type": raw.get("type"),
    }


# ---------------------------------------------------------------------------
# dump1090 readers
# ---------------------------------------------------------------------------

def json_reader(store: Store, json_dir: Path, stop: threading.Event) -> None:
    aircraft_path = json_dir / "aircraft.json"
    receiver_path = json_dir / "receiver.json"
    while not stop.is_set():
        try:
            if receiver_path.is_file():
                meta = json.loads(receiver_path.read_text())
                lat, lon = meta.get("lat"), meta.get("lon")
                if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
                    with store.lock:
                        store.rx = {"lat": float(lat), "lon": float(lon)}
            if aircraft_path.is_file():
                age = time.time() - aircraft_path.stat().st_mtime
                if age < 5:
                    payload = json.loads(aircraft_path.read_text())
                    store.ingest_json_list(
                        payload.get("aircraft") or [],
                        payload.get("messages"),
                    )
        except Exception:
            pass
        stop.wait(0.5)


def sbs_reader(store: Store, host: str, port: int, stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            with socket.create_connection((host, port), timeout=3) as sock:
                sock.settimeout(1.0)
                buf = b""
                while not stop.is_set():
                    try:
                        chunk = sock.recv(4096)
                    except socket.timeout:
                        continue
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        text = line.decode("ascii", "ignore").strip()
                        if text:
                            store.ingest_sbs(text.split(","))
        except OSError:
            stop.wait(2.0)


# ---------------------------------------------------------------------------
# demo traffic (DFW arrivals / regionals / heavies)
# ---------------------------------------------------------------------------

def _seed_fleet() -> list[dict[str, Any]]:
    # Positions loosely around DFW matching the user's live snapshot.
    return [
        {"hex": "a11c40", "flight": "AAL1824", "lat": 32.97, "lon": -97.02, "alt": 3500, "gs": 210, "track": 175, "vr": -700, "squawk": "4312", "rssi": -12.4},
        {"hex": "aabc11", "flight": "SWA4117", "lat": 32.82, "lon": -96.80, "alt": 2600, "gs": 180, "track": 310, "vr": -500, "squawk": "2641", "rssi": -15.1},
        {"hex": "a0e365", "flight": "ENY3658", "lat": 32.84, "lon": -97.18, "alt": 4200, "gs": 200, "track": 88, "vr": -400, "squawk": "3511", "rssi": -18.0},
        {"hex": "a0e388", "flight": "ENY3887", "lat": 33.05, "lon": -96.88, "alt": 6100, "gs": 230, "track": 195, "vr": -800, "squawk": "3522", "rssi": -16.6},
        {"hex": "a0a680", "flight": "AAL680", "lat": 32.70, "lon": -97.15, "alt": 9000, "gs": 280, "track": 10, "vr": 1200, "squawk": "1733", "rssi": -14.2},
        {"hex": "a26520", "flight": "AAL2652", "lat": 33.12, "lon": -97.22, "alt": 11000, "gs": 310, "track": 155, "vr": -1100, "squawk": "1745", "rssi": -19.8},
        {"hex": "a52790", "flight": "JIA5279", "lat": 32.88, "lon": -96.70, "alt": 5000, "gs": 220, "track": 250, "vr": -300, "squawk": "6120", "rssi": -21.0},
        {"hex": "a0100a", "flight": "AAL100", "lat": 32.55, "lon": -97.40, "alt": 35000, "gs": 470, "track": 85, "vr": 0, "squawk": "2644", "rssi": -24.0},
        {"hex": "aa6801", "flight": "AAL265", "lat": 33.30, "lon": -96.55, "alt": 37000, "gs": 490, "track": 250, "vr": 64, "squawk": "1132", "rssi": -26.5},
        {"hex": "ab1234", "flight": "UAL1891", "lat": 32.40, "lon": -96.40, "alt": 36000, "gs": 455, "track": 310, "vr": 0, "squawk": "2261", "rssi": -28.0},
        {"hex": "a0d123", "flight": "DAL998", "lat": 33.40, "lon": -97.50, "alt": 39000, "gs": 505, "track": 120, "vr": -50, "squawk": "3410", "rssi": -27.2},
        {"hex": "a88821", "flight": "SWA1204", "lat": 32.78, "lon": -97.05, "alt": 14000, "gs": 330, "track": 45, "vr": 1800, "squawk": "2730", "rssi": -13.5},
        {"hex": "a44aa1", "flight": "FFT1812", "lat": 32.95, "lon": -96.55, "alt": 16000, "gs": 340, "track": 265, "vr": -1400, "squawk": "4521", "rssi": -22.0},
        {"hex": "a77c01", "flight": "NKS441", "lat": 33.18, "lon": -97.05, "alt": 8000, "gs": 260, "track": 180, "vr": -900, "squawk": "5102", "rssi": -17.4},
        {"hex": "c07ba0", "flight": "BAW191", "lat": 32.20, "lon": -97.80, "alt": 38000, "gs": 480, "track": 75, "vr": 0, "squawk": "3301", "rssi": -29.5},
        {"hex": "a08001", "flight": "AAL2499", "lat": 32.90, "lon": -97.10, "alt": 2100, "gs": 160, "track": 174, "vr": -400, "squawk": "4310", "rssi": -9.8},
        {"hex": "a0b111", "flight": "SKW3699", "lat": 33.25, "lon": -96.95, "alt": 12000, "gs": 300, "track": 200, "vr": -1000, "squawk": "1620", "rssi": -20.1},
        {"hex": "a03111", "flight": "ASH3341", "lat": 32.60, "lon": -96.90, "alt": 7000, "gs": 250, "track": 330, "vr": 600, "squawk": "1477", "rssi": -18.8},
        {"hex": "a0c0de", "flight": "RPA3522", "lat": 32.85, "lon": -97.55, "alt": 9500, "gs": 270, "track": 95, "vr": -200, "squawk": "7011", "rssi": -23.3},
        {"hex": "ab0007", "flight": "FDX137", "lat": 33.00, "lon": -97.70, "alt": 32000, "gs": 460, "track": 110, "vr": -300, "squawk": "1200", "rssi": -25.0},
        {"hex": "a01077", "flight": "GTI8521", "lat": 32.35, "lon": -97.10, "alt": 28000, "gs": 430, "track": 355, "vr": 0, "squawk": "0461", "rssi": -27.8},
        {"hex": "a5e001", "flight": "N907QS", "lat": 32.93, "lon": -96.92, "alt": 4500, "gs": 190, "track": 140, "vr": 200, "squawk": "1200", "rssi": -11.2},
    ]


class DemoWorld:
    def __init__(self, store: Store):
        self.store = store
        self.fleet = _seed_fleet()
        for ac in self.fleet:
            ac.setdefault("on_ground", False)
            ac.setdefault("msgs", 20)
            ac.setdefault("vr", 0)

    def step(self, dt: float) -> None:
        if self.store.mode == "live" and not self.store.force_demo:
            return
        rows = []
        for ac in self.fleet:
            gs = float(ac.get("gs") or 200)
            track = float(ac.get("track") or 0)
            alt = float(ac.get("alt") or 5000)
            vr = float(ac.get("vr") or 0)
            lat, lon = float(ac["lat"]), float(ac["lon"])
            lat, lon = nm_step(lat, lon, track, gs * dt / 3600.0)
            alt = max(0, alt + vr * dt / 60.0)
            # keep demo traffic in a DFW box; turn heavies around at the edge
            if lat > 33.7 or lat < 32.0 or lon < -98.2 or lon > -96.0:
                track = (track + 140 + (hash(ac["hex"]) % 40)) % 360
            # arrivals descend toward DFW, then bounce back up
            if alt < 800 and vr < 0:
                vr = 900
                track = (track + 60) % 360
            if alt > 41000 and vr > 0:
                vr = -200
            ac.update(lat=round(lat, 5), lon=round(lon, 5), alt=int(alt), track=round(track, 1), vr=int(vr))
            ac["msgs"] = int(ac.get("msgs") or 0) + 1
            seed = int(ac["hex"], 16) if ac.get("hex") else 0
            ac["rssi"] = round(-12 - (seed % 16) + 1.4 * math.sin(time.time() * 0.6 + seed), 1)
            rows.append(dict(ac))
        self.store.ingest_demo(rows)


def demo_loop(world: DemoWorld, stop: threading.Event) -> None:
    last = time.time()
    while not stop.is_set():
        now = time.time()
        world.step(min(1.0, now - last))
        last = now
        stop.wait(0.5)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    store: Store

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        blob = " ".join(str(a) for a in args)
        if "/api/" in blob:
            return
        try:
            super().log_message(fmt, *args)
        except Exception:
            return

    def send_error(self, code, message=None, explain=None):
        # Avoid the stock HTML error page (and log_message type bugs) for
        # missing favicons / junk requests.
        try:
            self.send_response(code, message)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except Exception:
            pass

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("/api/aircraft", "/api/status"):
            payload = self.store.snapshot()
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if parsed.path == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                while True:
                    raw = json.dumps(self.store.snapshot()).encode("utf-8")
                    self.wfile.write(b"data: " + raw + b"\n\n")
                    self.wfile.flush()
                    time.sleep(0.4)
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                return
        if parsed.path in ("/", "/index.html"):
            self.path = "/index.html"
        if parsed.path in (
            "/favicon.ico",
            "/apple-touch-icon.png",
            "/apple-touch-icon-precomposed.png",
        ):
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()


def main() -> None:
    cfg = load_config(DEFAULT_CONFIG)
    parser = argparse.ArgumentParser(description="Wargames ADS-B CRT console")
    parser.add_argument("--port", type=int, default=int(cfg["port"]))
    parser.add_argument("--lat", type=float, default=float(cfg["lat"]))
    parser.add_argument("--lon", type=float, default=float(cfg["lon"]))
    parser.add_argument("--sbs-host", default=str(cfg["sbs_host"]))
    parser.add_argument("--sbs-port", type=int, default=int(cfg["sbs_port"]))
    parser.add_argument("--json-dir", default=str(cfg["json_dir"]))
    parser.add_argument("--demo", action="store_true", help="Force simulated DFW traffic")
    parser.add_argument("--title", default=str(cfg["title"]))
    args = parser.parse_args()

    json_dir = Path(args.json_dir)
    if not json_dir.is_absolute():
        json_dir = ROOT / json_dir
    json_dir.mkdir(parents=True, exist_ok=True)

    store = Store(args.lat, args.lon, args.title, str(cfg.get("callsign") or "NORTEX"))
    store.force_demo = bool(args.demo)
    Handler.store = store

    stop = threading.Event()
    threads = []
    if not args.demo:
        threads.append(threading.Thread(target=json_reader, args=(store, json_dir, stop), daemon=True))
        threads.append(threading.Thread(target=sbs_reader, args=(store, args.sbs_host, args.sbs_port, stop), daemon=True))
    world = DemoWorld(store)
    threads.append(threading.Thread(target=demo_loop, args=(world, stop), daemon=True))
    for t in threads:
        t.start()

    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True
    print(f"Wargames console  http://127.0.0.1:{args.port}")
    print(f"  origin {args.lat:.4f} {args.lon:.4f}   SBS {args.sbs_host}:{args.sbs_port}")
    print(f"  json   {json_dir}")
    if args.demo:
        print("  mode   DEMO (forced)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutdown")
    finally:
        stop.set()
        httpd.server_close()


if __name__ == "__main__":
    main()
