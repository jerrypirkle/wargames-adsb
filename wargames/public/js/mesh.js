/** Parse MeshCore contact exports and infer a local RF graph. */

import { haversineNm } from "./map.js";

export const MESH_ROLES = {
  1: "COMPANION",
  2: "REPEATER",
  3: "ROOM",
};

export const MESH_COLOR = {
  1: "#ffd24a",
  2: "#5ce8ff",
  3: "#ff4fa8",
};

const STORE_KEY = "wargames.meshcore.v1";
const RPT_LINK_NM = 18;
const CLIENT_LINK_NM = 12;

export function parseMeshExport(raw) {
  let data = raw;
  if (typeof raw === "string") data = JSON.parse(raw);
  const contacts = Array.isArray(data) ? data : (data.contacts || []);
  const nodes = [];
  for (const c of contacts) {
    const key = String(c.public_key || "").toLowerCase();
    if (!key) continue;
    const lat = parseFloat(c.latitude);
    const lon = parseFloat(c.longitude);
    const hasPos = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) > 0.01 && Math.abs(lon) > 0.01;
    const type = Number(c.type) || 1;
    nodes.push({
      hex: `MC${key.slice(0, 12)}`,
      kind: "mesh",
      key,
      name: String(c.custom_name || c.name || "UNKNOWN").trim(),
      type,
      role: MESH_ROLES[type] || "NODE",
      lat: hasPos ? lat : null,
      lon: hasPos ? lon : null,
      last_advert: Number(c.last_advert) || 0,
      flags: Number(c.flags) || 0,
    });
  }
  return { nodes, links: inferLinks(nodes), loadedAt: Date.now() };
}

export function inferLinks(nodes) {
  const placed = nodes.filter((n) => n.lat != null);
  const rpts = placed.filter((n) => n.type === 2);
  const others = placed.filter((n) => n.type !== 2);
  const links = [];
  const seen = new Set();
  function add(a, b, nm) {
    const k = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
    if (seen.has(k)) return;
    seen.add(k);
    links.push({ a: a.hex, b: b.hex, nm: Math.round(nm * 10) / 10 });
  }
  for (let i = 0; i < rpts.length; i++) {
    for (let j = i + 1; j < rpts.length; j++) {
      const nm = haversineNm(rpts[i].lat, rpts[i].lon, rpts[j].lat, rpts[j].lon);
      if (nm > 0 && nm <= RPT_LINK_NM) add(rpts[i], rpts[j], nm);
    }
  }
  for (const n of others) {
    let best = null, bestNm = CLIENT_LINK_NM;
    for (const r of rpts) {
      const nm = haversineNm(n.lat, n.lon, r.lat, r.lon);
      if (nm < bestNm) {
        best = r;
        bestNm = nm;
      }
    }
    if (best) add(n, best, bestNm);
  }
  return links;
}

export function loadStoredMesh() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.contacts || data.nodes)) {
      if (data.nodes) {
        return { nodes: data.nodes, links: data.links || inferLinks(data.nodes), loadedAt: data.loadedAt };
      }
      return null;
    }
    return parseMeshExport(data);
  } catch {
    return null;
  }
}

export function storeMeshRaw(obj) {
  localStorage.setItem(STORE_KEY, JSON.stringify(obj));
}

export function clearStoredMesh() {
  localStorage.removeItem(STORE_KEY);
}

export function advertAge(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
