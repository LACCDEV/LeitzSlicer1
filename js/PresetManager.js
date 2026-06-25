/* ============================================================
   PresetManager — capture / restore the full left-panel control
   set, built-in + user presets (localStorage), JSON import/export,
   a printability checker, and per-control tooltips.

   Presets are stored SPARSE (only the keys that differ from the page
   defaults) as raw DOM id -> value, and applied by dispatching the
   normal input/change events so the density↔diameter linkage and the
   debounced regenerate fire naturally. `lat-strut` is applied LAST so
   the diameter wins over density in the linkage.
   ============================================================ */

const LS_KEY = "leitz.slicer.presets.v1";
const FORMAT = "leitz-slicer-preset";

/* ---------- capture / restore ---------- */

function controlEls() {
  // Exclude the preset picker, file input, the object-orientation sliders
  // (presets must stay orientation-agnostic) and the transition macro.
  const skip = new Set(["preset-select", "model-rot-x", "model-rot-y", "model-rot-z", "transition"]);
  return Array.from(document.querySelectorAll("#left-panel input, #left-panel select"))
    .filter((el) => el.id && el.type !== "file" && !skip.has(el.id));
}

/** Snapshot every left-panel control by id. */
export function captureControls() {
  const snap = {};
  for (const el of controlEls()) snap[el.id] = el.type === "checkbox" ? el.checked : el.value;
  return snap;
}

function setOne(id, val) {
  const el = document.getElementById(id);
  if (!el) return false;
  if (el.type === "checkbox") el.checked = !!val;
  else el.value = val;
  const evt = el.tagName === "SELECT" ? "change" : (el.type === "checkbox" ? "change" : "input");
  el.dispatchEvent(new Event(evt, { bubbles: true }));
  return true;
}

/**
 * Apply a (possibly sparse) preset. Returns the list of ids that were
 * not found (so the UI can report drift from older presets).
 */
export function applyControls(snap) {
  const missing = [];
  for (const id of Object.keys(snap)) {
    if (id === "lat-strut") continue;            // applied last
    if (!setOne(id, snap[id])) missing.push(id);
  }
  if ("lat-strut" in snap && !setOne("lat-strut", snap["lat-strut"])) missing.push("lat-strut");
  return missing;
}

/* ---------- built-in presets (sparse) ---------- */

export const BUILTIN_PRESETS = {
  "TPE cushion · airy": {
    "lat-type": "bcc", "lat-cell": "20", "lat-strut": "0.9",
    "shell-style": "voronoi", "shell-perims": "1", "hole-size": "5.5", "hole-pitch": "11",
    "hole-shape": "circle", "min-wall": "1.2", "hole-scale-center": "1.4", "hole-scale-edge": "0.8",
    "seed-jitter": "0.4", "merge-intensity": "0.5", "ps-print": "18", "ps-fan-base": "15",
  },
  "TPE cushion · dense": {
    "lat-type": "bcc", "lat-cell": "12", "lat-strut": "1.3",
    "shell-style": "lattice", "shell-perims": "2", "hole-size": "3.0", "hole-pitch": "6",
    "hole-shape": "hex", "min-wall": "1.0", "hole-scale-center": "1.1", "hole-scale-edge": "0.9",
    "merge-intensity": "0.8", "ps-print": "20",
  },
  "Design object": {
    "lat-type": "gyroid", "lat-cell": "14",
    "shell-style": "circle", "shell-perims": "1", "hole-size": "3.5", "hole-pitch": "9",
    "hole-shape": "hex", "min-wall": "1.0", "hole-taper": "0.2",
    "ps-extperim-speed": "12", "ps-seam-mode": "aligned",
  },
  "Solid skin": {
    "lat-type": "bcc", "lat-cell": "16", "lat-strut": "1.2",
    "shell-style": "solid", "shell-perims": "2", "merge-intensity": "0.2",
    "ps-print": "16", "ps-retract": "2.0", "ps-retract-speed": "30",
    "ps-extra-retract": "0.6", "ps-wipe": "1.2", "ps-pa": "0.06", "ps-fan-base": "20",
  },
  "Cloud Pillow": {
    "lat-type": "gyroid", "gyroid-period": "25", "gyroid-wall": "0.8",
    "gyroid-iso": "0", "gyroid-grad": "0.4",
    "shell-style": "gyroid", "hole-density": "1", "min-wall": "1.0",
    "ps-print": "18", "ps-fan-base": "15",
  },
  "Crystal Cushion": {
    "lat-type": "gyroid-skeletal", "gyroid-period": "15", "gyroid-node": "2.5",
    "gyroid-taper": "bone", "gyroid-xsection": "round",
    "shell-style": "node", "hole-density": "1.3", "min-wall": "1.0",
    "ps-print": "20",
  },
  "TPE Safe Print": {
    "lat-type": "gyroid", "gyroid-period": "18", "gyroid-wall": "0.9", "gyroid-iso": "0",
    "shell-style": "gyroid", "hole-density": "0.8", "min-wall": "1.2",
    "ps-print": "16", "ps-retract": "1.5", "ps-extra-retract": "0.5", "ps-wipe": "1.2",
  },
  "Design Object (gyroid)": {
    "lat-type": "gyroid-skeletal", "gyroid-period": "14", "gyroid-densgrad": "radial",
    "gyroid-node": "4.0", "gyroid-taper": "bone",
    "shell-style": "node", "hole-density": "1.5",
    "ps-extperim-speed": "12",
  },
  // ---- textile-skin / wearable combos ----
  "Knit Pillow": {
    "lat-type": "gyroid", "gyroid-period": "24", "gyroid-wall": "0.8",
    "shell-style": "rib", "rib-width": "0.9", "rib-gap": "1.1", "rib-angle": "0",
    "min-wall": "0.5", "merge-intensity": "0.6",
    "ps-print": "16", "ps-layer": "0.15", "ps-pa": "0.05", "ps-fan-base": "60",
  },
  "Sport Pad": {
    "lat-type": "gyroid-skeletal", "gyroid-period": "15",
    "shell-style": "hex", "hole-size": "1.8", "hole-pitch": "4.5", "min-wall": "0.7",
    "merge-intensity": "0.7", "ps-print": "18",
  },
  "Bio Cushion": {
    "lat-type": "gyroid", "gyroid-period": "18",
    "shell-style": "voronoi", "hole-size": "4", "hole-pitch": "9", "seed-jitter": "0.5",
    "merge-intensity": "0.5", "ps-print": "18",
  },
  "Tech Object (auxetic)": {
    "lat-type": "gyroid-skeletal", "gyroid-period": "14",
    "shell-style": "auxetic", "aux-cell-w": "7", "aux-cell-h": "10", "aux-reentrant": "0.32",
    "aux-wall": "1.0", "min-wall": "0.6", "merge-intensity": "0.5", "ps-print": "18",
  },
  "Foam Pad (Kelvin)": {
    "lat-type": "kelvin", "lat-cell": "10", "lat-strut": "0.6",
    "shell-style": "rib", "rib-width": "0.9", "rib-gap": "1.3", "min-wall": "0.5",
    "merge-intensity": "0.5", "ps-print": "16", "ps-layer": "0.15",
  },
};

/* ---------- user presets (localStorage) ---------- */

function readStore() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
}
function writeStore(obj) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); return true; } catch { return false; }
}
export function listUserPresets() { return Object.keys(readStore()); }
export function getUserPreset(name) { return readStore()[name] || null; }
export function saveUserPreset(name) {
  const store = readStore(); store[name] = captureControls();
  return writeStore(store);
}
export function deleteUserPreset(name) {
  const store = readStore(); delete store[name]; return writeStore(store);
}

/* ---------- JSON import / export ---------- */

export function exportPresetBlob(name) {
  const payload = { format: FORMAT, version: 1, name: name || "preset", values: captureControls() };
  return new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
}
export function parseImportedPreset(text) {
  const obj = JSON.parse(text);
  if (obj.format !== FORMAT) throw new Error("Not a LEITZ Slicer preset file.");
  if (!obj.values || typeof obj.values !== "object") throw new Error("Preset has no values.");
  return obj;
}

/* ---------- printability check ---------- */

/**
 * @returns {Array<{sev:'error'|'warn'|'info'|'ok', msg:string}>}
 * Only physically-impossible cases are errors; quality concerns are
 * warn/info so experimentation is never blocked.
 */
export function runPrintabilityCheck(p, bounds) {
  const out = [];
  const nozzle = p.nozzle || 0.4;
  const perforated = p.shellPattern && p.shellPattern !== "solid" && p.shellPattern !== "none";

  if (p.lineWidth < nozzle)
    out.push({ sev: "error", msg: `Line width ${p.lineWidth} mm < nozzle ${nozzle} mm — a wall can't be thinner than the nozzle.` });
  if (p.shellPattern !== "none" && p.shellPerims * p.lineWidth < nozzle)
    out.push({ sev: "error", msg: `Shell wall (${p.shellPerims}×${p.lineWidth} mm) < nozzle — add a perimeter or widen the line.` });
  if (p.layerHeight < 0.05)
    out.push({ sev: "error", msg: `Layer height ${p.layerHeight} mm is too small to print.` });
  else if (p.layerHeight > 0.8 * nozzle)
    out.push({ sev: "warn", msg: `Layer height ${p.layerHeight} mm > 0.8×nozzle — layers may bond poorly.` });
  if (bounds && (bounds.size[0] > 360 || bounds.size[1] > 360 || bounds.size[2] > 360))
    out.push({ sev: "error", msg: `Model exceeds the 360 mm Prusa XL bed — scale down or split.` });

  if (p.type !== "gyroid" && p.strutDiameter < 2 * p.lineWidth)
    out.push({ sev: "warn", msg: `Strut Ø ${p.strutDiameter} mm < 2× line width — a single thin thread, weak in TPE.` });
  if (perforated && p.holeSize < nozzle)
    out.push({ sev: "warn", msg: `Hole size ${p.holeSize} mm is near the nozzle — holes may blob shut.` });
  if (perforated && p.minWall < nozzle)
    out.push({ sev: "warn", msg: `Min wall ${p.minWall} mm < nozzle — wall bands may not extrude cleanly.` });
  if (perforated && p.minWall > p.holePitch * 0.5)
    out.push({ sev: "warn", msg: `Min wall is large vs hole pitch — pattern collapses toward solid.` });
  if (p.type === "cubic")
    out.push({ sev: "warn", msg: `Simple cubic has horizontal struts that bridge in air — BCC/FCC print cleaner in TPE.` });
  if (p.horizAngleDeg < 10)
    out.push({ sev: "info", msg: `Horizontal angle ${p.horizAngleDeg}° is low — few struts get the slow+fan overhang treatment.` });
  if (p.flow < 0.8 || p.flow > 1.3)
    out.push({ sev: "warn", msg: `Flow ${p.flow}× is unusual — keep ~0.95–1.1.` });
  if (p.retractDistance > 3)
    out.push({ sev: "info", msg: `Retract ${p.retractDistance} mm is high for direct-drive TPE — try 1–2 mm + wipe.` });

  if (out.length === 0) out.push({ sev: "ok", msg: "No printability issues found." });
  return out;
}

/* ---------- tooltips ---------- */

export const TOOLTIPS = {
  "lat-type": "Lattice topology. BCC (diagonal struts) prints best in TPE; gyroid is a smooth TPMS surface.",
  "lat-cell": "Unit cell size. Bigger = airier/softer; smaller = denser/firmer. For lattice-matched shells, set hole pitch near this.",
  "lat-strut": "Strut thickness. Thicker = stronger + stiffer but heavier and slower.",
  "lat-density": "Target volume fraction — linked to strut diameter at the current cell size.",
  "shell-style": "Outer-skin perforation. Voronoi = organic cells; lattice-matched aligns holes to struts (merged look); solid = clean closed skin.",
  "hole-size": "Hole radius. Larger holes = airier, lighter, but weaker rim.",
  "hole-pitch": "Centre-to-centre hole spacing (voronoi seed spacing). For the lattice pattern this follows the cell size.",
  "hole-shape": "Outline of each hole — circle, hexagon or diamond.",
  "min-wall": "Printability floor: wall bands thinner than this are removed and tiny holes closed.",
  "shell-perims": "Number of stacked perimeter walls — more = thicker, stronger skin.",
  "hole-taper": "Funnels holes wider on inner perimeters. 0 = straight tube.",
  "merge-intensity": "Welds struts to the skin and thickens infill into the wall so shell + lattice read as one structure.",
  "pattern-rotation": "Rotates the hole grid around the part.",
  "seed-jitter": "Organic randomness of the voronoi/grid (coherent across layers).",
  "hole-scale-center": "Hole-size multiplier at the centre — airier middle.",
  "hole-scale-edge": "Hole-size multiplier at the rim — denser, stronger edge.",
  "hole-scale-height": "Holes grow (+) or shrink (−) with height.",
  "ps-print": "Lattice print speed. TPE flows slowly — keep it low for clean struts.",
  "ps-extperim-speed": "Visible outer-wall speed — slower = smoother surface.",
  "ps-pa": "Pressure advance (M572) — tames ooze/stringing. Calibrate for your TPE.",
  "ps-retract": "Retraction distance. Flexible TPE prefers short retracts + wipe.",
  "ps-temp": "Hotend temperature for TPE/TPU.",
  "ps-nozzle": "Nozzle diameter — reference for the printability ‘× nozzle’ checks.",
  "ps-seam-mode": "Where the loop seam is placed. Aligned hides it at the rear.",
  "ps-coast": "Stops extrusion just before the seam so residual pressure closes it cleanly.",
};

export function applyTooltips() {
  for (const [id, text] of Object.entries(TOOLTIPS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.title = text;
    const field = el.closest(".field, .field-slider");
    if (field) { const lbl = field.querySelector("label, span"); if (lbl) lbl.title = text; }
  }
}
