import {
  VectorMap,
  destNm,
  formatAlt,
  fmtLat,
  fmtLon,
  fmtLatLong,
  haversineNm,
  bearingDeg,
} from "./map.js";

const bootEl = document.getElementById("boot");
const consoleEl = document.getElementById("console");
const clockEl = document.getElementById("clock");
const tracksEl = document.getElementById("tracks");
const detailEl = document.getElementById("detail");
const hudTl = document.getElementById("hud-tl");
const hudBr = document.getElementById("hud-br");
const cursorEl = document.getElementById("cursor-readout");
const helpEl = document.getElementById("help");
const linkState = document.getElementById("link-state");
const sectorName = document.getElementById("sector-name");

const map = new VectorMap(document.getElementById("map"));

const state = {
  snapshot: null,
  snapAt: 0,
  interp: new Map(),
  selected: null,
  follow: false,
  dragging: false,
  last: { x: 0, y: 0 },
  cursor: null,
  lastChrome: 0,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function typeLine(text, cls = "") {
  const line = document.createElement("div");
  line.className = `line ${cls}`;
  bootEl.appendChild(line);
  for (let i = 0; i <= text.length; i++) {
    line.textContent = text.slice(0, i) + (i < text.length ? "█" : "");
    await sleep(text.startsWith("  ") ? 8 : 14);
  }
}

async function boot() {
  const lines = [
    ["NORAD / WOPR  —  JOSHUA 3.1", "title"],
    ["AIRBORNE SURVEILLANCE DISPLAY", ""],
    ["", ""],
    ["LINKING RTL-SDR TUNER ............. ", ""],
    ["  FREQ     1090.000 MHz   ADS-B / MODE S", "ok"],
    ["  DECODER  dump1090-fa", "ok"],
    ["  ORIGIN   32.90 N  097.00 W   DFW SECTOR", "ok"],
    ["  MAP      VECTOR  /  CONUS + METRO", "ok"],
    ["", ""],
    ["SHALL WE PLAY A GAME?", "warn"],
  ];
  for (const [t, cls] of lines) {
    if (t === "") {
      const g = document.createElement("div");
      g.className = "line";
      g.innerHTML = "&nbsp;";
      bootEl.appendChild(g);
      await sleep(80);
    } else {
      await typeLine(t, cls);
    }
  }
  await sleep(700);
  bootEl.style.transition = "opacity 0.6s";
  bootEl.style.opacity = "0";
  consoleEl.classList.remove("hidden");
  await sleep(600);
  bootEl.remove();
}

const TRACK_TTL_SEC = 20 * 60;

function interpolate(list, nowMs) {
  const extra = state.snapAt ? (nowMs - state.snapAt) / 1000 : 0;
  const next = new Map();
  for (const ac of list) {
    if ((ac.seen ?? 0) + extra > TRACK_TTL_SEC) continue;
    const prev = state.interp.get(ac.hex);
    const row = { ...ac };
    if (ac.lat != null && ac.gs && ac.track != null) {
      const dt = Math.min(8, (ac.seen_pos ?? ac.seen ?? 0) + extra);
      if (dt > 0.15) {
        const [lat, lon] = destNm(ac.lat, ac.lon, ac.track, (ac.gs * dt) / 3600);
        row.lat = lat;
        row.lon = lon;
        if (ac.vr && ac.alt != null) row.alt = Math.max(0, ac.alt + (ac.vr * dt) / 60);
      }
    }
    if (prev && row.lat != null && prev.lat != null) {
      const a = 0.08;
      row.lat = prev.lat + (row.lat - prev.lat) * a;
      row.lon = prev.lon + (row.lon - prev.lon) * a;
    }
    next.set(ac.hex, row);
  }
  state.interp = next;
  return [...next.values()];
}

function applySnapshot(snap) {
  state.snapshot = snap;
  state.snapAt = performance.now();
  if (snap.rx) map.setRx(snap.rx.lat, snap.rx.lon);
  if (snap.title) sectorName.textContent = snap.title;
  const live = snap.mode === "live";
  linkState.textContent = live ? (snap.connected ? "LIVE LINK" : "LINK LOST") : "SIMULATION";
  linkState.className = live && snap.connected ? "live" : "sim";
}

function connect() {
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    try {
      applySnapshot(JSON.parse(ev.data));
    } catch {
      /* ignore truncated frames */
    }
  };
  es.onerror = () => {
    fetch("/api/aircraft")
      .then((r) => r.json())
      .then(applySnapshot)
      .catch(() => {});
  };
}

function tick(now) {
  const snap = state.snapshot;
  if (snap) {
    const list = interpolate(snap.aircraft || [], now);
    map.aircraft = list;
    map.selected = state.selected;
    map.rememberTrails(list, now / 1000);
    if (state.follow) {
      const ac = list.find((a) => a.hex === state.selected);
      if (ac) map.follow(ac);
    }
    if (now - state.lastChrome > 250) {
      renderChrome(snap, list);
      state.lastChrome = now;
    } else {
      clockEl.textContent = new Date().toISOString().slice(11, 19) + "Z";
    }
  }
  map.draw(now);
  requestAnimationFrame(tick);
}

function renderChrome(snap, list) {
  const t = new Date();
  clockEl.textContent = t.toISOString().slice(11, 19) + "Z";

  const withPos = list.filter((a) => a.lat != null);
  document.getElementById("f-n").textContent = String(list.length);
  document.getElementById("f-pos").textContent = String(withPos.length);
  document.getElementById("f-rate").textContent = (snap.rate || 0).toFixed(1);
  document.getElementById("f-msgs").textContent = fmtNum(snap.messages || 0);
  document.getElementById("f-src").textContent = (snap.source || "—").toUpperCase();
  const rx = snap.rx || map.rx;
  document.getElementById("f-rx").innerHTML =
    `RX <strong>${fmtLat(rx.lat)}  ${fmtLon(rx.lon)}</strong>`;

  hudTl.innerHTML =
    `${snap.callsign || "NORTEX"} / ${snap.title || "DFW SECTOR"}<br>` +
    `ORIGIN  ${fmtLatLong(rx.lat, rx.lon)}<br>` +
    `SCALE   ${map.ppm.toFixed(2)} PX/NM<br>` +
    (state.follow ? "FOLLOW  ON<br>" : "");

  hudBr.textContent = state.cursor
    ? `${fmtLatLong(state.cursor.lat, state.cursor.lon)}`
    : "";

  renderTable(list, rx);
  renderDetail(list.find((a) => a.hex === state.selected), rx);
}

function fmtNum(n) {
  return Intl.NumberFormat("en-US").format(n);
}

function rngOf(ac, rx) {
  if (ac.lat == null) return null;
  return haversineNm(rx.lat, rx.lon, ac.lat, ac.lon);
}

function renderTable(list, rx) {
  const rows = [...list].sort((a, b) => {
    const ra = rngOf(a, rx), rb = rngOf(b, rx);
    if (ra == null && rb == null) return (a.flight || a.hex).localeCompare(b.flight || b.hex);
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
  let maxAlt = -Infinity;
  let maxGs = -Infinity;
  for (const ac of rows) {
    if (ac.alt != null && ac.alt > maxAlt) maxAlt = ac.alt;
    if (ac.gs != null && ac.gs > maxGs) maxGs = ac.gs;
  }
  let html = `<table><thead><tr>
    <th>TRACK</th><th class="num">ALT</th><th class="num">GS</th>
    <th class="num">HDG</th><th class="num">NM</th><th class="num">dB</th></tr></thead><tbody>`;
  for (const ac of rows) {
    const call = (ac.flight || ac.hex.slice(-6).toUpperCase()).trim();
    const rng = rngOf(ac, rx);
    const cls = [
      ac.hex === state.selected ? "sel" : "",
      (ac.seen_pos ?? ac.seen ?? 0) > 20 ? "stale" : "",
      ac.emergency && ac.emergency !== "none" ? "emerg" : "",
    ].filter(Boolean).join(" ");
    const altMax = ac.alt != null && ac.alt === maxAlt;
    const gsMax = ac.gs != null && ac.gs === maxGs;
    html += `<tr data-hex="${ac.hex}" class="${cls}">
      <td>${esc(call)}</td>
      <td class="num${altMax ? " max" : ""}">${formatAlt(ac.alt)}</td>
      <td class="num${gsMax ? " max" : ""}">${ac.gs != null ? Math.round(ac.gs) : "—"}</td>
      <td class="num">${ac.track != null ? String(Math.round(ac.track)).padStart(3, "0") : "—"}</td>
      <td class="num">${rng != null ? rng.toFixed(1) : "—"}</td>
      <td class="num">${ac.rssi != null ? ac.rssi.toFixed(0) : "—"}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  const top = tracksEl.scrollTop;
  tracksEl.innerHTML = html;
  tracksEl.scrollTop = top;
}

function renderDetail(ac, rx) {
  if (!ac) {
    detailEl.innerHTML = `<h2>TRACK FILE</h2>
      <div class="kv"><span class="k">STATUS</span><span class="v">NO SELECT</span>
      <span class="k">HINT</span><span class="v">CLICK A CONTACT</span></div>`;
    return;
  }
  const rng = rngOf(ac, rx);
  const brg = ac.lat != null ? bearingDeg(rx.lat, rx.lon, ac.lat, ac.lon) : null;
  const call = (ac.flight || "UNKNOWN").trim();
  const radar = airnavUrl(ac.flight);
  const plane = radar
    ? `<a class="airnav-link" href="${esc(radar)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(call)} on AirNav Radar">
         <img src="img/plane.png" alt="AirNav Radar" width="56" height="71">
       </a>`
    : "";
  detailEl.innerHTML = `<h2>${esc(call)}</h2>
    <div class="kv">
      <span class="k">ICAO</span><span class="v hi">${ac.hex.toUpperCase()}</span>
      <span class="k">ALT</span><span class="v">${formatAlt(ac.alt)}${ac.vr ? `  ${ac.vr > 0 ? "+" : ""}${ac.vr}` : ""}</span>
      <span class="k">GS</span><span class="v">${ac.gs != null ? Math.round(ac.gs) + " KT" : "—"}</span>
      <span class="k">HDG</span><span class="v">${ac.track != null ? Math.round(ac.track) + "°" : "—"}</span>
      <span class="k">POS</span><span class="v">${fmtLatLong(ac.lat, ac.lon)}</span>
      <span class="k">RNG</span><span class="v">${rng != null ? rng.toFixed(1) + " NM" : "—"} ${brg != null ? " / " + Math.round(brg) + "°" : ""}</span>
      <span class="k">SQK</span><span class="v">${ac.squawk || "—"}</span>
      <span class="k">RSSI</span><span class="v">${ac.rssi != null ? ac.rssi.toFixed(1) + " dBFS" : "—"}</span>
      <span class="k">SEEN</span><span class="v">${(ac.seen ?? 0).toFixed(1)}s</span>
      <span class="k">MSGS</span><span class="v">${ac.msgs ?? "—"}</span>
      <span class="k">CAT</span><span class="v">${ac.category || ac.type || "—"}</span>
    </div>
    ${plane}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ADS-B callsigns are ICAO (DAL1365). AirNav Radar flight pages use IATA (DL1365).
const ICAO_IATA = {
  AAL: "AA", DAL: "DL", UAL: "UA", SWA: "WN", FFT: "F9", NKS: "NK", JBU: "B6",
  ASA: "AS", HAL: "HA", SCX: "SY", VRD: "VX", AWE: "US",
  ENY: "MQ", SKW: "OO", JIA: "OH", RPA: "YX", ASH: "YV", QXE: "QX",
  EDV: "9E", ASQ: "EV", PDT: "PT", LOF: "YX", TCF: "YV", CPZ: "CP",
  BAW: "BA", AFR: "AF", KLM: "KL", DLH: "LH", IBE: "IB", VIR: "VS", EIN: "EI",
  UAE: "EK", QTR: "QR", ETD: "EY", SIA: "SQ", CPA: "CX", ANA: "NH", JAL: "JL",
  QFA: "QF", ACA: "AC", AMX: "AM", VOI: "Y4", VIV: "VB",
  FDX: "FX", UPS: "5X", GTI: "5Y", NCR: "N8", ATN: "8C",
  CSA: "OK", SAS: "SK", FIN: "AY", AUA: "OS", SWR: "LX", TAP: "TP",
  THY: "TK", AEE: "A3", WZZ: "W6", RYR: "FR", EZY: "U2",
  CES: "MU", CCA: "CA", CSN: "CZ", AIC: "AI", PAL: "PR", KAL: "KE", AAR: "OZ",
};

function airnavUrl(flight) {
  const cs = (flight || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!cs || cs === "UNKNOWN") return null;
  if (/^N[0-9]{1,5}[A-Z]{0,2}$/.test(cs)) {
    return `https://www.airnavradar.com/data/registration/${cs}`;
  }
  const m = cs.match(/^([A-Z]{2,3})(\d{1,4}[A-Z]?)$/);
  if (!m) return `https://www.airnavradar.com/data/flights/${encodeURIComponent(cs)}`;
  const prefix = m[1];
  const num = m[2];
  const iata = ICAO_IATA[prefix] || (prefix.length === 2 ? prefix : null);
  if (iata) return `https://www.airnavradar.com/data/flights/${iata}${num}`;
  return `https://www.airnavradar.com/data/flights/${encodeURIComponent(cs)}`;
}

function select(hex, follow = false) {
  state.selected = hex;
  map.selected = hex;
  if (follow) state.follow = true;
}

function bind() {
  map.resize();
  window.addEventListener("resize", () => map.resize());

  const canvas = map.canvas;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    state.dragging = false;
    state.last = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    state.cursor = map.unproject(x, y);
    const hit = map.hit(x, y);
    map.hover = hit ? hit.hex : null;
    cursorEl.style.left = `${x}px`;
    cursorEl.style.top = `${y}px`;
    if (state.cursor) {
      const rng = haversineNm(map.rx.lat, map.rx.lon, state.cursor.lat, state.cursor.lon);
      const brg = bearingDeg(map.rx.lat, map.rx.lon, state.cursor.lat, state.cursor.lon);
      cursorEl.textContent = `${fmtLatLong(state.cursor.lat, state.cursor.lon)}   ${rng.toFixed(1)} NM / ${Math.round(brg)}°`;
    }
    if (canvas.hasPointerCapture(e.pointerId)) {
      const dx = e.clientX - state.last.x;
      const dy = e.clientY - state.last.y;
      if (Math.hypot(dx, dy) > 3) state.dragging = true;
      if (state.dragging) {
        state.follow = false;
        map.panPx(dx, dy);
      }
      state.last = { x: e.clientX, y: e.clientY };
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    const rect = canvas.getBoundingClientRect();
    if (!state.dragging) {
      const hit = map.hit(e.clientX - rect.left, e.clientY - rect.top);
      select(hit ? hit.hex : null);
    }
  });
  canvas.addEventListener("pointerleave", () => {
    cursorEl.textContent = "";
    map.hover = null;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    map.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  tracksEl.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-hex]");
    if (tr) {
      select(tr.dataset.hex);
      const ac = map.aircraft.find((a) => a.hex === tr.dataset.hex);
      if (ac && ac.lat != null) {
        map.center = { lat: ac.lat, lon: ac.lon };
        map._geoDirty = true;
      }
    }
  });

  document.querySelectorAll("header button[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.follow = false;
      map.preset(btn.dataset.view);
      document.querySelectorAll("header button[data-view]").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      helpEl.classList.toggle("show");
      return;
    }
    if (e.key === "Escape") {
      select(null);
      helpEl.classList.remove("show");
      state.follow = false;
    }
    if (e.key === "f" || e.key === "F") {
      if (state.selected) state.follow = !state.follow;
    }
    if (e.key === "r" || e.key === "R") {
      state.follow = false;
      map.preset("sector");
    }
    if (e.key === "g" || e.key === "G") {
      map.showGrid = !map.showGrid;
      map._geoDirty = true;
    }
    if (e.key === "l" || e.key === "L") map.showSpikes = !map.showSpikes;
    if (e.key === "s" || e.key === "S") map.showSweep = !map.showSweep;
    if (e.key === "1") map.preset("metro");
    if (e.key === "2") map.preset("sector");
    if (e.key === "3") map.preset("texas");
    if (e.key === "4") map.preset("conus");
    const step = 80;
    if (e.key === "ArrowLeft") map.panPx(step, 0);
    if (e.key === "ArrowRight") map.panPx(-step, 0);
    if (e.key === "ArrowUp") map.panPx(0, step);
    if (e.key === "ArrowDown") map.panPx(0, -step);
  });
}

async function main() {
  const [geo, places] = await Promise.all([
    fetch("data/us-states.json").then((r) => r.json()),
    fetch("data/places.json").then((r) => r.json()),
  ]);
  map.setData(geo, places);
  map.preset("sector");
  document.querySelector('header button[data-view="sector"]').classList.add("active");
  bind();
  connect();
  if (new URLSearchParams(location.search).has("skipboot")) {
    bootEl.remove();
    consoleEl.classList.remove("hidden");
  } else {
    await boot();
  }
  map.resize();
  requestAnimationFrame(tick);
}

main();
