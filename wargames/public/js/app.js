import {
  VectorMap,
  destNm,
  formatAlt,
  fmtLat,
  fmtLon,
  fmtLatLong,
  haversineNm,
  bearingDeg,
  isUas,
  categoryLabel,
} from "./map.js";
import {
  parseMeshExport,
  loadStoredMesh,
  storeMeshRaw,
  advertAge,
} from "./mesh.js";

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
  mesh: null,
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
  if (map.layer === "space") sectorName.textContent = "SPACE SECTOR";
  else if (map.layer === "mesh") sectorName.textContent = "MESHCORE";
  else if (snap.title) sectorName.textContent = snap.title;
  const live = snap.mode === "live";
  linkState.textContent = live ? (snap.connected ? "LIVE LINK" : "LINK LOST") : "SIMULATION";
  linkState.className = live && snap.connected ? "live" : "sim";
  map.spaceObjects = ((snap.space && snap.space.objects) || []).map((s) => ({
    ...s,
    hex: `SAT${s.id}`,
    kind: "sat",
  }));
  if (state.mesh) {
    map.meshNodes = state.mesh.nodes;
    map.meshLinks = state.mesh.links;
  }
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
      const ac = list.find((a) => a.hex === state.selected)
        || map.spaceObjects.find((s) => s.hex === state.selected)
        || map.meshNodes.find((s) => s.hex === state.selected);
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
  const uasEl = document.getElementById("f-uas");
  if (uasEl) uasEl.textContent = String(list.filter(isUas).length);
  document.getElementById("f-rate").textContent = (snap.rate || 0).toFixed(1);
  document.getElementById("f-msgs").textContent = fmtNum(snap.messages || 0);
  document.getElementById("f-src").textContent = (snap.source || "—").toUpperCase();
  const rx = snap.rx || map.rx;
  document.getElementById("f-rx").innerHTML =
    `RX <strong>${fmtLat(rx.lat)}  ${fmtLon(rx.lon)}</strong>`;

  if (map.layer === "space") {
    const iss = map.spaceObjects.find((s) => s.id === "25544");
    hudTl.innerHTML =
      `NORAD  /  SPACE SECTOR<br>` +
      `ORIGIN  ${fmtLatLong(rx.lat, rx.lon)}<br>` +
      `EPHEM   NORAD TLE<br>` +
      (iss ? `ISS EL  ${iss.el.toFixed(1)}°  ${iss.aos ? "AOS" : "LOS"}<br>` : "") +
      (state.follow ? "FOLLOW  ON<br>" : "");
    renderSpaceTable(map.spaceObjects);
    const sel = map.spaceObjects.find((s) => s.hex === state.selected)
      || list.find((a) => a.hex === state.selected);
    if (sel && sel.kind === "sat") renderSatDetail(sel, rx);
    else renderDetail(sel, rx);
  } else if (map.layer === "mesh") {
    const nodes = state.mesh ? state.mesh.nodes : [];
    const links = state.mesh ? state.mesh.links : [];
    const withPos = nodes.filter((n) => n.lat != null);
    document.getElementById("f-n").textContent = String(nodes.length);
    document.getElementById("f-pos").textContent = String(withPos.length);
    document.getElementById("f-src").textContent = "MESH";
    if (uasEl) uasEl.textContent = String(links.length);
    hudTl.innerHTML =
      `MESHCORE  /  DFW ORIGIN<br>` +
      `NODES   ${nodes.length}   LINKS  ${links.length}<br>` +
      `SCALE   ${map.ppm.toFixed(2)} PX/NM<br>` +
      (state.follow ? "FOLLOW  ON<br>" : "");
    renderMeshTable(nodes, rx);
    const sel = nodes.find((n) => n.hex === state.selected);
    if (sel) renderMeshDetail(sel, rx, links);
    else renderMeshEmpty();
  } else {
    hudTl.innerHTML =
      `${snap.callsign || "NORTEX"} / ${snap.title || "DFW SECTOR"}<br>` +
      `ORIGIN  ${fmtLatLong(rx.lat, rx.lon)}<br>` +
      `SCALE   ${map.ppm.toFixed(2)} PX/NM<br>` +
      (state.follow ? "FOLLOW  ON<br>" : "");
    renderTable(list, rx);
    renderDetail(list.find((a) => a.hex === state.selected), rx);
  }

  hudBr.textContent = state.cursor
    ? `${fmtLatLong(state.cursor.lat, state.cursor.lon)}`
    : "";
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
    const uas = isUas(ac);
    const cls = [
      ac.hex === state.selected ? "sel" : "",
      (ac.seen_pos ?? ac.seen ?? 0) > 20 ? "stale" : "",
      ac.emergency && ac.emergency !== "none" ? "emerg" : "",
      uas ? "uas" : "",
    ].filter(Boolean).join(" ");
    const altMax = ac.alt != null && ac.alt === maxAlt;
    const gsMax = ac.gs != null && ac.gs === maxGs;
    html += `<tr data-hex="${ac.hex}" class="${cls}">
      <td>${uas ? '<span class="tag-uas">UAS</span> ' : ""}${esc(call)}</td>
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

function renderMeshTable(nodes, rx) {
  if (!nodes.length) {
    tracksEl.innerHTML = `<div class="mesh-empty">
      <div>NO MESHCORE EXPORT LOADED</div>
      <button type="button" id="mesh-load-btn">LOAD EXPORT</button>
    </div>`;
    return;
  }
  const rows = [...nodes].sort((a, b) => {
    const ra = rngOf(a, rx), rb = rngOf(b, rx);
    if (ra == null && rb == null) return a.name.localeCompare(b.name);
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
  let html = `<table><thead><tr>
    <th>NODE</th><th>ROLE</th><th class="num">NM</th><th class="num">HEARD</th></tr></thead><tbody>`;
  for (const n of rows) {
    const rng = rngOf(n, rx);
    const cls = n.hex === state.selected ? "sel" : "";
    html += `<tr data-hex="${n.hex}" class="${cls}">
      <td>${esc(n.name)}</td>
      <td>${n.role}</td>
      <td class="num">${rng != null ? rng.toFixed(1) : "—"}</td>
      <td class="num">${advertAge(n.last_advert)}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  const top = tracksEl.scrollTop;
  tracksEl.innerHTML = html;
  tracksEl.scrollTop = top;
}

function renderMeshEmpty() {
  detailEl.innerHTML = `<h2>MESHCORE</h2>
    <div class="kv">
      <span class="k">STATUS</span><span class="v">NO SELECT</span>
      <span class="k">HINT</span><span class="v">LOAD AN EXPORT OR CLICK A NODE</span>
    </div>
    <button type="button" class="mesh-file-btn" id="mesh-load-detail">LOAD EXPORT</button>`;
}

function renderMeshDetail(n, rx, links) {
  const rng = rngOf(n, rx);
  const nLinks = (links || []).filter((l) => l.a === n.hex || l.b === n.hex).length;
  detailEl.innerHTML = `<h2>${esc(n.name)}</h2>
    <div class="kv">
      <span class="k">ROLE</span><span class="v hi">${n.role}</span>
      <span class="k">TYPE</span><span class="v">${n.type}</span>
      <span class="k">POS</span><span class="v">${fmtLatLong(n.lat, n.lon)}</span>
      <span class="k">RNG</span><span class="v">${rng != null ? rng.toFixed(1) + " NM" : "NO POS"}</span>
      <span class="k">LINKS</span><span class="v">${nLinks}</span>
      <span class="k">HEARD</span><span class="v">${advertAge(n.last_advert)}</span>
      <span class="k">ID</span><span class="v">${esc(n.key.slice(0, 8))}…</span>
    </div>
    <button type="button" class="mesh-file-btn" id="mesh-load-detail">LOAD EXPORT</button>`;
}

function renderSpaceTable(sats) {
  const rows = [...sats].sort((a, b) => (b.el ?? -90) - (a.el ?? -90));
  let html = `<table><thead><tr>
    <th>OBJECT</th><th class="num">KM</th><th class="num">EL</th>
    <th class="num">AZ</th><th class="num">RNG</th><th>AOS</th></tr></thead><tbody>`;
  for (const s of rows) {
    const cls = [
      s.hex === state.selected ? "sel" : "",
      s.aos ? "uas" : "",
    ].filter(Boolean).join(" ");
    html += `<tr data-hex="${s.hex}" class="${cls}">
      <td>${esc(s.name)}</td>
      <td class="num">${Math.round(s.alt_km)}</td>
      <td class="num">${s.el.toFixed(0)}</td>
      <td class="num">${String(Math.round(s.az)).padStart(3, "0")}</td>
      <td class="num">${Math.round(s.range_km)}</td>
      <td>${s.aos ? "AOS" : "LOS"}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  const top = tracksEl.scrollTop;
  tracksEl.innerHTML = html;
  tracksEl.scrollTop = top;
}

function renderSatDetail(s, rx) {
  detailEl.innerHTML = `<h2>${esc(s.name)}</h2>
    <div class="kv">
      <span class="k">NORAD</span><span class="v hi">${s.id}</span>
      <span class="k">KIND</span><span class="v uas">SATELLITE</span>
      <span class="k">ALT</span><span class="v">${s.alt_km.toFixed(1)} KM</span>
      <span class="k">VEL</span><span class="v">${s.vel_kms.toFixed(2)} KM/S</span>
      <span class="k">POS</span><span class="v">${fmtLatLong(s.lat, s.lon)}</span>
      <span class="k">EL</span><span class="v">${s.el.toFixed(1)}°</span>
      <span class="k">AZ</span><span class="v">${s.az.toFixed(0)}°</span>
      <span class="k">RNG</span><span class="v">${Math.round(s.range_km)} KM</span>
      <span class="k">PASS</span><span class="v${s.aos ? " uas" : ""}">${s.aos ? "AOS  IN VIEW OF RX" : "LOS  BELOW HORIZON"}</span>
      <span class="k">SRC</span><span class="v">NORAD TLE</span>
    </div>`;
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
      <span class="k">KIND</span><span class="v${isUas(ac) ? " uas" : ""}">${isUas(ac) ? "UAS" : "AIRCRAFT"}</span>
      <span class="k">CAT</span><span class="v">${categoryLabel(ac.category)}${ac.type ? `  ${ac.type}` : ""}</span>
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

  const meshFile = document.getElementById("mesh-file");
  function openMeshFile() {
    if (meshFile) meshFile.click();
  }
  function applyMesh(rawObj) {
    state.mesh = parseMeshExport(rawObj);
    storeMeshRaw(rawObj);
    map.meshNodes = state.mesh.nodes;
    map.meshLinks = state.mesh.links;
    map._geoDirty = true;
  }
  if (meshFile) {
    meshFile.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        applyMesh(JSON.parse(text));
        if (map.layer !== "mesh") setView("mesh");
      } catch (err) {
        console.warn("meshcore export", err);
      }
      e.target.value = "";
    });
  }
  tracksEl.addEventListener("click", (e) => {
    if (e.target.id === "mesh-load-btn") {
      openMeshFile();
      return;
    }
    const tr = e.target.closest("tr[data-hex]");
    if (tr) {
      select(tr.dataset.hex);
      const ac = map.aircraft.find((a) => a.hex === tr.dataset.hex)
        || map.spaceObjects.find((s) => s.hex === tr.dataset.hex)
        || map.meshNodes.find((s) => s.hex === tr.dataset.hex);
      if (ac && ac.lat != null) {
        map.center = { lat: ac.lat, lon: ac.lon };
        map._geoDirty = true;
      }
    }
  });
  detailEl.addEventListener("click", (e) => {
    if (e.target.id === "mesh-load-detail") openMeshFile();
  });

  function syncViewButtons() {
    document.querySelectorAll("header button[data-view]").forEach((b) => {
      const v = b.dataset.view;
      if (v === "space") b.classList.toggle("active", map.layer === "space");
      else if (v === "mesh") b.classList.toggle("active", map.layer === "mesh");
      else if (v === "air") b.classList.toggle("active", map.layer === "air");
      else b.classList.toggle("active", map.layer !== "space" && map.view === v);
    });
  }

  function airTitle() {
    if (state.snapshot && state.snapshot.title) return state.snapshot.title;
    return "DFW SECTOR";
  }

  function setView(name) {
    state.follow = false;
    if (name === "space") {
      map.layer = "space";
      map.preset("space");
      sectorName.textContent = "SPACE SECTOR";
    } else if (name === "mesh") {
      map.layer = "mesh";
      const geo = ["metro", "sector", "texas", "conus"].includes(map.view) ? map.view : "sector";
      map.preset(geo);
      sectorName.textContent = "MESHCORE";
    } else if (name === "air") {
      map.layer = "air";
      map.preset("sector");
      sectorName.textContent = airTitle();
    } else {
      if (map.layer === "space") map.layer = "air";
      map.preset(name);
      if (map.layer === "mesh") sectorName.textContent = "MESHCORE";
      else sectorName.textContent = airTitle();
    }
    syncViewButtons();
  }

  document.querySelectorAll("header button[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  function toggleAirspace() {
    map.showAirspace = !map.showAirspace;
    map._geoDirty = true;
    const btn = document.getElementById("tog-airspace");
    if (btn) btn.classList.toggle("active", map.showAirspace);
    document.querySelectorAll(".as-leg").forEach((el) => {
      el.hidden = !map.showAirspace;
    });
  }
  const asBtn = document.getElementById("tog-airspace");
  if (asBtn) asBtn.addEventListener("click", toggleAirspace);

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
      if (map.layer === "space") setView("space");
      else if (map.layer === "mesh") setView("mesh");
      else setView("sector");
    }
    if (e.key === "g" || e.key === "G") {
      map.showGrid = !map.showGrid;
      map._geoDirty = true;
    }
    if (e.key === "a" || e.key === "A") toggleAirspace();
    if (e.key === "l" || e.key === "L") map.showSpikes = !map.showSpikes;
    if (e.key === "s" || e.key === "S") map.showSweep = !map.showSweep;
    if (e.key === "1") setView("metro");
    if (e.key === "2") setView("sector");
    if (e.key === "3") setView("texas");
    if (e.key === "4") setView("conus");
    if (e.key === "5") setView("space");
    if (e.key === "6") setView("mesh");
    const step = 80;
    if (e.key === "ArrowLeft") map.panPx(step, 0);
    if (e.key === "ArrowRight") map.panPx(-step, 0);
    if (e.key === "ArrowUp") map.panPx(0, step);
    if (e.key === "ArrowDown") map.panPx(0, -step);
  });

  syncViewButtons();
}

async function main() {
  const [geo, places, world, airspace] = await Promise.all([
    fetch("data/us-states.json").then((r) => r.json()),
    fetch("data/places.json").then((r) => r.json()),
    fetch("data/world-land.json").then((r) => r.json()),
    fetch("data/airspace.json").then((r) => r.json()),
  ]);
  map.setData(geo, places, world, airspace);
  state.mesh = loadStoredMesh();
  if (state.mesh) {
    map.meshNodes = state.mesh.nodes;
    map.meshLinks = state.mesh.links;
  }
  map.preset("sector");
  bind();
  connect();
  const qs = new URLSearchParams(location.search);
  if (qs.has("airspace")) document.getElementById("tog-airspace")?.click();
  if (qs.has("skipboot")) {
    bootEl.remove();
    consoleEl.classList.remove("hidden");
  } else {
    await boot();
  }
  map.resize();
  requestAnimationFrame(tick);
}

main();
