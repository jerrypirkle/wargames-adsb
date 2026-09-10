const DEG = Math.PI / 180;
const NM = 1852;

export function haversineNm(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const p1 = lat1 * DEG, p2 = lat2 * DEG;
  const dp = (lat2 - lat1) * DEG;
  const dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return (2 * r * Math.asin(Math.min(1, Math.sqrt(a)))) / NM;
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

export function destNm(lat, lon, track, nm) {
  const rad = track * DEG;
  const lat2 = lat + (nm * Math.cos(rad)) / 60;
  const lon2 = lon + (nm * Math.sin(rad)) / (60 * Math.max(0.2, Math.cos(lat * DEG)));
  return [lat2, lon2];
}

export function altColor(alt, selected) {
  if (selected) return "#ff4fa8";
  if (alt == null) return "#5a7a88";
  if (alt < 50) return "#6a9a7a";
  if (alt < 3000) return "#ff8a2b";
  if (alt < 10000) return "#ffd24a";
  if (alt < 25000) return "#5ce8ff";
  return "#e8fbff";
}

/** ADS-B emitter category B6 is UAV. Callsign heuristics catch some that omit category. */
export function isUas(ac) {
  if (!ac) return false;
  if (ac.uas) return true;
  const cat = String(ac.category || "").toUpperCase();
  if (cat === "B6") return true;
  const f = String(ac.flight || "").toUpperCase();
  return /(?:^|[^A-Z])(UAS|UAV|DRONE)/.test(f);
}

export const CAT_LABEL = {
  A0: "NO INFO", A1: "LIGHT", A2: "SMALL", A3: "LARGE", A4: "HIGH VORTEX",
  A5: "HEAVY", A6: "HIGH PERF", A7: "ROTORCRAFT",
  B0: "NO INFO", B1: "GLIDER", B2: "LTA", B3: "PARACHUTE", B4: "ULTRALIGHT",
  B6: "UAS", B7: "SPACE",
  C1: "EMERG VEH", C2: "SERVICE VEH", C3: "POINT OBS",
};

export function categoryLabel(cat) {
  if (!cat) return "—";
  const code = String(cat).toUpperCase();
  const name = CAT_LABEL[code];
  return name ? `${name}  ${code}` : code;
}

function glowStroke(ctx, color, width, blur = 10) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(0.6, width * 0.45);
  ctx.stroke();
}

export class VectorMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.w = 1;
    this.h = 1;
    this.dpr = 1;
    this.center = { lat: 32.9, lon: -97.0 };
    this.rx = { lat: 32.9, lon: -97.0 };
    this.ppm = 8; // pixels per nautical mile
    this.geo = null;
    this.world = null;
    this.places = null;
    this.view = "sector";
    this.layer = "air"; // air | space | mesh
    this.spaceObjects = [];
    this.meshNodes = [];
    this.meshLinks = [];
    this.showGrid = true;
    this.showSweep = true;
    this.showSpikes = false;
    this.sweep = 0;
    this.selected = null;
    this.hover = null;
    this.aircraft = [];
    this.trails = new Map(); // hex -> [{lat,lon,t}]
    this._geoDirty = true;
    this._geoCanvas = document.createElement("canvas");
    this._geoCtx = this._geoCanvas.getContext("2d");
  }

  setData(geo, places, world) {
    this.geo = geo;
    this.places = places;
    if (world) this.world = world;
    this._geoDirty = true;
  }

  setRx(lat, lon) {
    if (lat == null || lon == null) return;
    this.rx = { lat, lon };
    this._geoDirty = true;
  }

  setView(lat, lon, ppm) {
    this.center = { lat, lon };
    if (ppm) this.ppm = ppm;
    this._geoDirty = true;
  }

  preset(name) {
    const { lat, lon } = this.rx;
    const map = {
      metro: { lat, lon, ppm: 14 },
      sector: { lat, lon, ppm: 6 },
      texas: { lat: 31.4, lon: -99.2, ppm: 1.15 },
      conus: { lat: 39.5, lon: -98.0, ppm: 0.38 },
      space: { lat, lon, ppm: 0.078 },
    };
    const v = map[name] || map.sector;
    this.view = name || "sector";
    this.setView(v.lat, v.lon, v.ppm);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this._geoCanvas.width = this.canvas.width;
    this._geoCanvas.height = this.canvas.height;
    this._geoDirty = true;
  }

  lonDelta(lon) {
    let d = lon - this.center.lon;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }

  project(lat, lon) {
    const nmN = (lat - this.center.lat) * 60;
    const nmE = this.lonDelta(lon) * 60 * Math.cos(this.center.lat * DEG);
    return [this.w / 2 + nmE * this.ppm, this.h / 2 - nmN * this.ppm];
  }

  unproject(x, y) {
    const nmE = (x - this.w / 2) / this.ppm;
    const nmN = (this.h / 2 - y) / this.ppm;
    const lat = this.center.lat + nmN / 60;
    let lon = this.center.lon + nmE / (60 * Math.cos(this.center.lat * DEG));
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    return { lat, lon };
  }

  zoomAt(x, y, factor) {
    const before = this.unproject(x, y);
    this.ppm = Math.max(0.045, Math.min(48, this.ppm * factor));
    const after = this.unproject(x, y);
    this.center.lat += before.lat - after.lat;
    this.center.lon += before.lon - after.lon;
    this._geoDirty = true;
  }

  panPx(dx, dy) {
    this.center = this.unproject(this.w / 2 - dx, this.h / 2 - dy);
    this._geoDirty = true;
  }

  follow(ac) {
    if (!ac || ac.lat == null) return;
    this.center = { lat: ac.lat, lon: ac.lon };
    this._geoDirty = true;
  }

  rememberTrails(list, now) {
    const keep = new Set();
    for (const ac of list) {
      if (ac.lat == null || ac.lon == null) continue;
      keep.add(ac.hex);
      let t = this.trails.get(ac.hex);
      if (!t) {
        t = [];
        this.trails.set(ac.hex, t);
      }
      const last = t[t.length - 1];
      if (!last || haversineNm(last.lat, last.lon, ac.lat, ac.lon) > 0.15) {
        if (last && haversineNm(last.lat, last.lon, ac.lat, ac.lon) > 40) t.length = 0;
        t.push({ lat: ac.lat, lon: ac.lon, t: now });
        if (t.length > 240) t.shift();
      }
      while (t.length && now - t[0].t > 8 * 60) t.shift();
    }
    for (const hex of this.trails.keys()) {
      if (!keep.has(hex)) this.trails.delete(hex);
    }
  }

  hit(x, y) {
    let best = null, bestD = 18;
    const pool = this.layer === "space"
      ? [...this.spaceObjects, ...this.aircraft]
      : this.layer === "mesh"
        ? this.meshNodes
        : this.aircraft;
    for (const ac of pool) {
      if (ac.lat == null) continue;
      const [ax, ay] = this.project(ac.lat, ac.lon);
      const d = Math.hypot(ax - x, ay - y);
      if (d < bestD) {
        best = ac;
        bestD = d;
      }
    }
    return best;
  }

  draw(now) {
    if (this._geoDirty) this._drawGeo();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this._geoCanvas, 0, 0, this.w, this.h);

    if (this.layer === "space") {
      this._drawSatellites(ctx);
      this._drawAircraft(ctx);
    } else if (this.layer === "mesh") {
      if (this.showSweep) this._drawSweep(ctx, now);
      this._drawMesh(ctx);
    } else {
      if (this.showSpikes) this._drawSpikes(ctx);
      this._drawTrails(ctx, now);
      if (this.showSweep) this._drawSweep(ctx, now);
      this._drawAircraft(ctx);
    }
  }

  _prepare(ctx) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#010308";
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
  }

  _drawGeo() {
    const ctx = this._geoCtx;
    this._prepare(ctx);
    if (this.showGrid) this._drawGrid(ctx);
    if (this.layer === "space") {
      this._drawWorld(ctx);
      this._drawRx(ctx);
      this._drawZoneTitle(ctx);
    } else {
      this._drawStates(ctx);
      this._drawLakes(ctx);
      this._drawHighways(ctx);
      this._drawRangeRings(ctx);
      this._drawPlaces(ctx);
      this._drawRx(ctx);
      this._drawZoneTitle(ctx);
    }
    this._geoDirty = false;
  }

  _drawWorld(ctx) {
    if (!this.world) return;
    for (const f of this.world.features || []) {
      const g = f.geometry;
      if (!g) continue;
      const rings = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      ctx.beginPath();
      for (const poly of rings) {
        for (const ring of poly) this._pathRing(ctx, ring);
      }
      ctx.fillStyle = "rgba(18, 70, 100, 0.16)";
      ctx.fill();
      ctx.strokeStyle = "rgba(92,232,255,0.42)";
      ctx.lineWidth = 0.9;
      ctx.shadowColor = "rgba(92,232,255,0.35)";
      ctx.shadowBlur = 5;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  _drawSatellites(ctx) {
    for (const sat of this.spaceObjects) {
      if (sat.track && sat.track.length > 1) {
        ctx.beginPath();
        let started = false, px = 0;
        for (const p of sat.track) {
          const [x, y] = this.project(p[0], p[1]);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
            px = x;
            continue;
          }
          if (Math.abs(x - px) > this.w * 0.5) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          px = x;
        }
        ctx.strokeStyle = sat.id === "25544" ? "rgba(255,79,168,0.55)" : "rgba(92,232,255,0.28)";
        ctx.lineWidth = sat.id === "25544" ? 1.6 : 1.0;
        ctx.shadowColor = sat.id === "25544" ? "#ff4fa8" : "#5ce8ff";
        ctx.shadowBlur = sat.id === "25544" ? 8 : 4;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      if (sat.lat == null) continue;
      const [x, y] = this.project(sat.lat, sat.lon);
      if (sat.aos && sat.range_km) {
        const r = (sat.range_km / 1.852) * this.ppm * 0.35;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(8, Math.min(r, this.w)), 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(60,255,154,0.35)";
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const sel = this.selected === sat.hex;
      const col = sat.aos ? "#3cff9a" : (sat.id === "25544" ? "#ff8ad4" : "#ffd24a");
      drawStar(ctx, x, y, sel ? 11 : 8, col);
      ctx.fillStyle = col;
      ctx.font = "11px 'Share Tech Mono', monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
      ctx.fillText(sat.name, x + 12, y - 2);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(200,244,255,0.75)";
      ctx.textBaseline = "top";
      ctx.fillText(`${Math.round(sat.alt_km)} KM`, x + 12, y + 2);
      if (sel) {
        ctx.beginPath();
        ctx.arc(x, y, 18, 0, Math.PI * 2);
        ctx.strokeStyle = "#ff4fa8";
        ctx.stroke();
      }
    }
  }

  _drawMesh(ctx) {
    const byHex = new Map(this.meshNodes.map((n) => [n.hex, n]));
    ctx.lineCap = "round";
    for (const ln of this.meshLinks) {
      const a = byHex.get(ln.a), b = byHex.get(ln.b);
      if (!a || a.lat == null || !b || b.lat == null) continue;
      const [x0, y0] = this.project(a.lat, a.lon);
      const [x1, y1] = this.project(b.lat, b.lon);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = "rgba(92,232,255,0.32)";
      ctx.lineWidth = 1.15;
      ctx.shadowColor = "#5ce8ff";
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    const colors = { 1: "#ffd24a", 2: "#5ce8ff", 3: "#ff4fa8" };
    const labelAll = this.ppm > 7 || this.meshNodes.length < 28;
    for (const n of this.meshNodes) {
      if (n.lat == null) continue;
      const [x, y] = this.project(n.lat, n.lon);
      const sel = this.selected === n.hex;
      const col = sel ? "#ff4fa8" : (colors[n.type] || "#5ce8ff");
      const r = n.type === 2 ? 6 : 4.2;
      ctx.save();
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = sel ? 14 : 8;
      ctx.beginPath();
      if (n.type === 2) {
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
      } else if (n.type === 3) {
        ctx.rect(x - r, y - r, r * 2, r * 2);
      } else {
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
      if (sel) {
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.strokeStyle = "#ff4fa8";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      if (sel || labelAll || this.hover === n.hex) {
        ctx.font = "10px 'Share Tech Mono', monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = 6;
        ctx.fillText(n.name, x + 9, y - 3);
        ctx.shadowBlur = 0;
      }
    }
  }

  _drawZoneTitle(ctx) {
    ctx.save();
    ctx.font = "13px Orbitron, 'Share Tech Mono', sans-serif";
    ctx.fillStyle = "#5ce8ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.shadowColor = "#5ce8ff";
    ctx.shadowBlur = 12;
    const title = this.layer === "space" ? "SPACE SURVEILLANCE  //  DFW ORIGIN"
      : this.layer === "mesh" ? "MESHCORE  //  DFW ORIGIN"
      : (this.ppm < 1.6 || this.ppm > 22) ? "" : "DFW AIR DEFENSE ZONE";
    if (title) ctx.fillText(title, this.w / 2, this.h - 22);
    ctx.restore();
  }

  _drawGrid(ctx) {
    const step = this.ppm > 10 ? 0.1 : this.ppm > 4 ? 0.25 : this.ppm > 1.2 ? 1 : this.ppm > 0.2 ? 5 : 15;
    const nw = this.unproject(0, 0);
    const se = this.unproject(this.w, this.h);
    const lat0 = Math.floor(Math.min(nw.lat, se.lat) / step) * step;
    const lat1 = Math.ceil(Math.max(nw.lat, se.lat) / step) * step;
    const lon0 = Math.floor(Math.min(nw.lon, se.lon) / step) * step;
    const lon1 = Math.ceil(Math.max(nw.lon, se.lon) / step) * step;
    ctx.beginPath();
    for (let lat = lat0; lat <= lat1 + 1e-9; lat = +(lat + step).toFixed(4)) {
      const [x0, y] = this.project(lat, lon0);
      const [x1] = this.project(lat, lon1);
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    for (let lon = lon0; lon <= lon1 + 1e-9; lon = +(lon + step).toFixed(4)) {
      const [x, y0] = this.project(lat0, lon);
      const [, y1] = this.project(lat1, lon);
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    ctx.strokeStyle = "rgba(92,232,255,0.10)";
    ctx.lineWidth = 1;
    ctx.shadowBlur = 0;
    ctx.stroke();

    ctx.fillStyle = "rgba(92,232,255,0.35)";
    ctx.font = "10px 'Share Tech Mono', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (let lat = lat0; lat <= lat1 + 1e-9; lat = +(lat + step).toFixed(4)) {
      const [, y] = this.project(lat, this.center.lon);
      if (y > 8 && y < this.h - 8) ctx.fillText(fmtLat(lat), 6, y + 2);
    }
    ctx.textAlign = "center";
    for (let lon = lon0; lon <= lon1 + 1e-9; lon = +(lon + step).toFixed(4)) {
      const [x] = this.project(this.center.lat, lon);
      if (x > 40 && x < this.w - 40) ctx.fillText(fmtLon(lon), x, this.h - 14);
    }
  }

  _pathRing(ctx, ring) {
    let started = false;
    let px = 0, py = 0, wrapped = false;
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      const [x, y] = this.project(lat, lon);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
        px = x;
        py = y;
        continue;
      }
      if (Math.abs(x - px) > this.w * 0.55) {
        wrapped = true;
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      px = x;
      py = y;
    }
    if (!wrapped) ctx.closePath();
  }

  _drawStates(ctx) {
    if (!this.geo) return;
    const features = this.geo.features || [];
    for (const f of features) {
      const name = f.properties?.name;
      const g = f.geometry;
      if (!g) continue;
      const rings = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      ctx.beginPath();
      for (const poly of rings) {
        for (const ring of poly) this._pathRing(ctx, ring);
      }
      const texas = name === "Texas";
      let color = "rgba(92,232,255,0.55)";
      if (texas) color = "#7af0ff";
      else if (firstLon(g) > -95) color = "rgba(60,255,154,0.55)";
      if (texas) {
        ctx.fillStyle = "rgba(20, 80, 110, 0.16)";
        ctx.fill();
      }
      glowStroke(ctx, color, texas ? 1.8 : 1.05, texas ? 14 : 7);
    }
  }

  _drawLakes(ctx) {
    if (!this.places || this.ppm < 4) return;
    for (const lake of this.places.lakes || []) {
      ctx.beginPath();
      lake.ring.forEach((p, i) => {
        const [x, y] = this.project(p[0], p[1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(40, 160, 200, 0.10)";
      ctx.fill();
      glowStroke(ctx, "rgba(92,232,255,0.45)", 1.1, 6);
    }
  }

  _drawHighways(ctx) {
    if (!this.places || this.ppm < 1.4) return;
    ctx.beginPath();
    for (const hw of this.places.highways || []) {
      hw.pts.forEach((p, i) => {
        const [x, y] = this.project(p[0], p[1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
    }
    glowStroke(ctx, "rgba(255,138,43,0.45)", 1.15, 6);
  }

  _drawRangeRings(ctx) {
    const rings = [10, 25, 50, 100, 150, 200, 300];
    const [cx, cy] = this.project(this.rx.lat, this.rx.lon);
    ctx.font = "10px 'Share Tech Mono', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const nm of rings) {
      const r = nm * this.ppm;
      if (r < 18 || r > Math.max(this.w, this.h) * 1.2) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(92,232,255,0.22)";
      ctx.lineWidth = 1;
      ctx.setLineDash(nm % 50 === 0 ? [] : [3, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(92,232,255,0.55)";
      ctx.fillText(`${nm} NM`, cx + r + 6, cy);
    }
  }

  _drawPlaces(ctx) {
    if (!this.places) return;
    const ppm = this.ppm;
    ctx.textBaseline = "bottom";

    if (ppm < 1.1) {
      ctx.font = "11px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      for (const z of this.places.artcc || []) {
        const [x, y] = this.project(z.lat, z.lon);
        if (x < 0 || y < 0 || x > this.w || y > this.h) continue;
        ctx.fillStyle = z.id === "ZFW" ? "#ff4fa8" : "rgba(92,232,255,0.55)";
        ctx.fillText(z.id, x, y);
      }
    }

    for (const c of this.places.cities || []) {
      const need = c.rank === 0 ? 0.25 : c.rank === 1 ? 1.1 : c.rank === 2 ? 4 : 8;
      if (ppm < need) continue;
      const [x, y] = this.project(c.lat, c.lon);
      if (x < -40 || y < -20 || x > this.w + 40 || y > this.h + 20) continue;
      ctx.beginPath();
      ctx.arc(x, y, c.rank === 0 ? 2.4 : 1.8, 0, Math.PI * 2);
      ctx.fillStyle = "#c8f4ff";
      ctx.shadowColor = "#5ce8ff";
      ctx.shadowBlur = 6;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = c.rank <= 1 ? "#e8fbff" : "rgba(200,244,255,0.75)";
      ctx.font = `${c.rank === 0 ? 12 : 10}px 'Share Tech Mono', monospace`;
      ctx.textAlign = "left";
      ctx.fillText(c.name, x + 6, y - 2);
    }

    for (const a of this.places.airports || []) {
      const need = a.rank === 1 ? 2.2 : a.rank === 2 ? 6 : 10;
      if (ppm < need) continue;
      const [x, y] = this.project(a.lat, a.lon);
      if (x < -50 || y < -50 || x > this.w + 50 || y > this.h + 50) continue;
      const mil = !!a.military;
      const col = mil ? "#ff4fa8" : "#5ce8ff";
      if (ppm > 8 && a.runways) {
        for (const rw of a.runways) {
          const lenNm = (rw.len_ft || 6000) / 6076;
          const [lat1, lon1] = destNm(rw.lat, rw.lon, rw.hdg, lenNm / 2);
          const [lat2, lon2] = destNm(rw.lat, rw.lon, rw.hdg + 180, lenNm / 2);
          const [x1, y1] = this.project(lat1, lon1);
          const [x2, y2] = this.project(lat2, lon2);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          glowStroke(ctx, col, Math.max(1.5, ppm * 0.12), 8);
        }
      }
      ctx.beginPath();
      ctx.arc(x, y, mil || a.id === "DFW" ? 22 : 14, 0, Math.PI * 2);
      ctx.strokeStyle = mil ? "rgba(255,79,168,0.7)" : "rgba(92,232,255,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = mil ? "#ff8ad4" : "#5ce8ff";
      ctx.font = "11px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(a.id, x, y - (mil || a.id === "DFW" ? 24 : 16));
    }

    for (const m of this.places.military || []) {
      const need = m.rank === 0 ? 0.28 : 1.6;
      if (ppm < need) continue;
      const [x, y] = this.project(m.lat, m.lon);
      if (x < 0 || y < 0 || x > this.w || y > this.h) continue;
      if (m.star) {
        drawStar(ctx, x, y, 9, "#ffd24a");
        ctx.fillStyle = "#ffd24a";
        ctx.font = "11px 'Share Tech Mono', monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(m.name, x + 12, y);
      } else if (ppm > 1.4) {
        ctx.fillStyle = "#ff4fa8";
        ctx.font = "10px 'Share Tech Mono', monospace";
        ctx.textAlign = "left";
        ctx.fillText(m.name, x + 8, y);
      }
    }
  }

  _drawRx(ctx) {
    const [x, y] = this.project(this.rx.lat, this.rx.lon);
    drawStar(ctx, x, y, 10, "#ffd24a");
    ctx.fillStyle = "#ffd24a";
    ctx.font = "11px 'Share Tech Mono', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("RX", x + 12, y + 4);
  }

  _drawTrails(ctx, now) {
    for (const ac of this.aircraft) {
      const trail = this.trails.get(ac.hex);
      if (!trail || trail.length < 2) continue;
      const sel = ac.hex === this.selected;
      const col = altColor(ac.alt, sel);
      ctx.beginPath();
      trail.forEach((p, i) => {
        const [x, y] = this.project(p.lat, p.lon);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (ac.lat != null) {
        const [x, y] = this.project(ac.lat, ac.lon);
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = col;
      ctx.globalAlpha = sel ? 0.7 : 0.35;
      ctx.lineWidth = sel ? 1.8 : 1.1;
      ctx.shadowColor = col;
      ctx.shadowBlur = sel ? 10 : 4;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  _drawSpikes(ctx) {
    const [rx, ry] = this.project(this.rx.lat, this.rx.lon);
    ctx.beginPath();
    for (const ac of this.aircraft) {
      if (ac.lat == null) continue;
      const [x, y] = this.project(ac.lat, ac.lon);
      ctx.moveTo(rx, ry);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(92,232,255,0.18)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _drawSweep(ctx, now) {
    this.sweep = (now / 1000 * 24) % 360;
    const [cx, cy] = this.project(this.rx.lat, this.rx.lon);
    const r = Math.hypot(this.w, this.h);
    const a = (this.sweep - 90) * DEG;
    ctx.save();
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, "rgba(92,232,255,0.10)");
    g.addColorStop(1, "rgba(92,232,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a - 0.32, a);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.strokeStyle = "rgba(92,232,255,0.35)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  _drawAircraft(ctx) {
    const labelAll = this.aircraft.filter((a) => a.lat != null).length < 28 || this.ppm > 7;
    for (const ac of this.aircraft) {
      if (ac.lat == null || ac.lon == null) continue;
      const [x, y] = this.project(ac.lat, ac.lon);
      if (x < -30 || y < -30 || x > this.w + 30 || y > this.h + 30) continue;
      const sel = ac.hex === this.selected;
      const hov = ac.hex === this.hover;
      const stale = (ac.seen_pos ?? ac.seen ?? 0) > 20;
      const uas = isUas(ac);
      const col = ac.emergency && ac.emergency !== "none"
        ? "#ff3355"
        : (sel ? "#ff4fa8" : uas ? "#3cff9a" : altColor(ac.alt, false));
      const size = sel ? 9 : 6.5;
      ctx.save();
      ctx.globalAlpha = stale ? 0.4 : 1;
      ctx.translate(x, y);
      ctx.rotate(((ac.track || 0) * DEG));
      if (uas) {
        drawUasSymbol(ctx, size, col);
      } else {
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.lineTo(size * 0.72, size);
        ctx.lineTo(0, size * 0.42);
        ctx.lineTo(-size * 0.72, size);
        ctx.closePath();
        ctx.fillStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = sel ? 16 : 8;
        ctx.fill();
      }
      ctx.restore();

      if (sel) {
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.strokeStyle = "#ff4fa8";
        ctx.lineWidth = 1.3;
        ctx.shadowColor = "#ff4fa8";
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(x, y, 22, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,79,168,0.35)";
        ctx.stroke();
      }

      const label = sel || hov || labelAll;
      if (label) {
        const call = (ac.flight || `UNK ${ac.hex.slice(-4).toUpperCase()}`).trim();
        const alt = formatAlt(ac.alt);
        ctx.font = `${sel ? 12 : 10}px 'Share Tech Mono', monospace`;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = sel ? "#ff8ad4" : col;
        ctx.shadowColor = sel ? "#ff4fa8" : col;
        ctx.shadowBlur = 8;
        ctx.fillText(call, x + 10, y - 4);
        ctx.fillStyle = sel ? "#ffd24a" : "rgba(200,244,255,0.8)";
        ctx.shadowBlur = 0;
        ctx.textBaseline = "top";
        ctx.fillText(alt, x + 10, y + 2);
      }
    }
  }
}

function drawUasSymbol(ctx, size, color) {
  const arm = size * 1.2;
  const r = Math.max(1.4, size * 0.28);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.1, size * 0.18);
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(-arm, -arm);
  ctx.lineTo(arm, arm);
  ctx.moveTo(arm, -arm);
  ctx.lineTo(-arm, arm);
  ctx.stroke();
  for (const [px, py] of [[-arm, -arm], [arm, -arm], [arm, arm], [-arm, arm]]) {
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.42);
  ctx.lineTo(size * 0.42, 0);
  ctx.lineTo(0, size * 0.42);
  ctx.lineTo(-size * 0.42, 0);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
}

function firstLon(g) {
  let p = g.coordinates;
  while (Array.isArray(p) && Array.isArray(p[0])) p = p[0];
  return Array.isArray(p) ? p[0] : -100;
}

function drawStar(ctx, x, y, r, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.28, -r * 0.28);
  ctx.lineTo(r, 0);
  ctx.lineTo(r * 0.28, r * 0.28);
  ctx.lineTo(0, r);
  ctx.lineTo(-r * 0.28, r * 0.28);
  ctx.lineTo(-r, 0);
  ctx.lineTo(-r * 0.28, -r * 0.28);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.restore();
}

export function formatAlt(alt) {
  if (alt == null) return "-----";
  if (alt < 50) return "GND";
  if (alt >= 18000) return `FL${String(Math.round(alt / 100)).padStart(3, "0")}`;
  return String(Math.round(alt)).padStart(5, " ");
}

export function fmtLat(lat) {
  const hemi = lat >= 0 ? "N" : "S";
  return `${Math.abs(lat).toFixed(2)} ${hemi}`;
}

export function fmtLon(lon) {
  const hemi = lon >= 0 ? "E" : "W";
  return `${Math.abs(lon).toFixed(2)} ${hemi}`;
}

export function fmtLatLong(lat, lon) {
  if (lat == null || lon == null) return "NO POS";
  return `${fmtLat(lat)}  ${fmtLon(lon)}`;
}
