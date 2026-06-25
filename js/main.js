/* ============================================================
   main.js — application orchestration.

   Wires the UI to the four modules:
     STLParser  -> parse dropped files
     MeshUtils  -> bounds / volume / inside-test sampler
     LatticeGenerator -> build the strut network (live preview)
     GCodeWriter -> emit TPE-optimized G-code
     Renderer   -> Three.js viewport
   ============================================================ */

import { parseSTL } from "./STLParser.js";
import { MeshSampler, computeVolume } from "./MeshUtils.js";
import {
  generateLattice, densityToDiameter, diameterToDensity, recolorBuffer,
} from "./LatticeGenerator.js";
import { generateGCode, generatePATestGcode } from "./GCodeWriter.js";
import { Renderer } from "./Renderer.js";
import * as Presets from "./PresetManager.js";
import { makeForm } from "./Forms.js";
import { runPatternPrintability, SURPRISE_TABLE } from "./Printability.js";
import { pathsToOBJ } from "./ObjExporter.js";

/* ---------------- DOM helpers ---------------- */
const $ = (id) => document.getElementById(id);
const num = (id) => parseFloat($(id).value);

/* ---------------- app state ---------------- */
const state = {
  sampler: null,
  bounds: null,
  positions: null,
  fileName: "model",
  lastResult: null,
  currentGcode: "",
};

const renderer = new Renderer($("viewport"));

/* ============================================================
   Read every control into a single params object shared by the
   lattice generator and the G-code writer.
   ============================================================ */
function readParams() {
  const latType = $("lat-type").value;
  return {
    // lattice — 'gyroid-skeletal' normalizes to type 'gyroid' + gyroidMode 'skeletal'
    type: latType.startsWith("gyroid") ? "gyroid" : latType,
    gyroidMode: latType === "gyroid-skeletal" ? "skeletal" : "sheet",
    cellSize: num("lat-cell"),
    strutDiameter: num("lat-strut"),
    density: num("lat-density"),
    bottomLayers: Math.round(num("lat-bottom")),
    topLayers: Math.round(num("lat-top")),
    rotX: num("lat-rotx"), rotY: num("lat-roty"), rotZ: num("lat-rotz"),

    // gyroid (sheet + skeletal)
    gyroidPeriod: num("gyroid-period"),
    gyroidWall: num("gyroid-wall"),
    isoOffset: num("gyroid-iso"),
    phaseX: num("gyroid-px"), phaseY: num("gyroid-py"), phaseZ: num("gyroid-pz"),
    gyroidGrad: num("gyroid-grad"),
    nodeBall: num("gyroid-node"),
    strutTaper: $("gyroid-taper").value,
    crossSection: $("gyroid-xsection").value,
    densityGradient: $("gyroid-densgrad").value,

    // perforated outer shell
    shellStyle: $("shell-style").value,        // alias kept for generateLattice guard
    shellPattern: $("shell-style").value,
    shellPerims: Math.round(num("shell-perims")),
    holeSize: num("hole-size"),
    holePitch: num("hole-pitch"),
    holeShape: $("hole-shape").value,
    minWall: num("min-wall"),
    holeTaper: num("hole-taper"),
    patternRotation: num("pattern-rotation"),
    holeScaleCenter: num("hole-scale-center"),
    holeScaleEdge: num("hole-scale-edge"),
    holeScaleHeight: num("hole-scale-height"),
    seedJitter: num("seed-jitter"),
    mergeIntensity: num("merge-intensity"),
    holeDensity: num("hole-density"),

    // textile surface-skin pattern params
    ribWidth: num("rib-width"), ribGap: num("rib-gap"), ribAngle: num("rib-angle"),
    meshAngle: num("mesh-angle"), meshStrand: num("mesh-strand"), meshOpening: num("mesh-opening"),
    auxCellW: num("aux-cell-w"), auxCellH: num("aux-cell-h"),
    auxReentrant: num("aux-reentrant"), auxWall: num("aux-wall"),

    // 3D woven surface
    warpCount: num("warp-count"), weftPitch: num("weft-pitch"),
    strandDiameter: num("strand-d"), weaveDepth: num("weave-depth"),
    weavePattern: $("weave-pattern").value,

    // shared print geometry
    layerHeight: num("ps-layer"),
    lineWidth: num("ps-linewidth"),
    filamentDiameter: num("ps-filament"),
    flow: num("ps-flow"),
    nozzle: num("ps-nozzle"),

    // speeds / temps
    printSpeed: num("ps-print"),
    travelSpeed: num("ps-travel"),
    temp: Math.round(num("ps-temp")),
    bed: Math.round(num("ps-bed")),

    // retraction / PA / zhop
    retractDistance: num("ps-retract"),
    retractSpeed: num("ps-retract-speed"),
    pressureAdvance: num("ps-pa"),
    zHop: num("ps-zhop"),

    // TPE / stringing tuning
    baseFan: num("ps-fan-base"),
    bridgeFan: num("ps-fan-bridge"),
    horizAngleDeg: num("ps-horiz-angle"),
    horizSpeedMult: num("ps-horiz-mult"),
    extraRetract: num("ps-extra-retract"),
    wipeDistance: num("ps-wipe"),
    combingMax: num("ps-combing"),
    nearestNeighbor: $("ps-nn").checked,

    // surface quality
    seamMode: $("ps-seam-mode").value,
    extPerimSpeed: num("ps-extperim-speed"),
    coastLength: num("ps-coast"),
    outerAccel: num("ps-outer-accel"),
    windowRetract: $("ps-window-retract").checked,
    firstLayerSpeed: num("ps-first-speed"),
    firstLayerFan: num("ps-fan-first"),
    wallFan: num("ps-fan-wall"),
    smallFeatureMult: num("ps-small-mult"),
    smallFeatureLen: num("ps-small-len"),
    jerk: num("ps-jerk"),
  };
}

/* ============================================================
   File loading
   ============================================================ */
/** Shared entry for both STL import and generated forms. */
function loadPositions(positions, name) {
  state.fileName = name.replace(/\.stl$/i, "");
  state.rawPositions = positions;               // un-rotated master copy
  state.modelVolume = computeVolume(positions); // rotation-invariant

  $("info-name").textContent = name;
  $("info-tris").textContent = (positions.length / 9).toLocaleString();
  $("info-volume").textContent = `${(state.modelVolume / 1000).toFixed(1)} cm³`;
  $("model-info").classList.remove("hidden");
  $("dims-badge").classList.remove("hidden");
  $("legend").classList.remove("hidden");
  $("btn-generate").disabled = false;
  $("btn-export").disabled = false;
  $("btn-export-obj").disabled = false;

  syncDensityFromDiameter();
  applyModelRotation(); // builds sampler/bounds (current orientation), renders, regenerates
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const { positions } = parseSTL(e.target.result);
      loadPositions(positions, file.name);
    } catch (err) {
      alert("Failed to load STL: " + err.message);
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

/** Generate a parametric cushion form and load it like an imported model. */
function createForm() {
  const shape = $("form-shape").value;
  const w = num("form-w"), d = num("form-d"), h = num("form-h");
  // NaN > 0 is false, so a blank Depth is rejected for oval/rect (disc ignores d).
  if (!(w > 0 && h > 0 && (shape === "disc" || d > 0))) { setPresetStatus("Enter W / D / H for the form."); return; }
  // reset orientation so the freshly-built form sits flat
  ["model-rot-x", "model-rot-y", "model-rot-z"].forEach((id) => { $(id).value = "0"; });
  const positions = makeForm(shape, w, shape === "disc" ? w : d, h);
  const label = shape === "disc" ? `disc Ø${w}×${h}` : shape === "oval" ? `oval ${w}×${d}×${h}` : `rect ${w}×${d}×${h}`;
  loadPositions(positions, label);
}

/* Rotate a flat positions array by Z·Y·X Euler degrees (about the origin —
   setMesh re-centres on the bed afterwards). */
function rotatePositions(raw, rx, ry, rz) {
  const dr = Math.PI / 180;
  const cx = Math.cos(rx * dr), sx = Math.sin(rx * dr);
  const cy = Math.cos(ry * dr), sy = Math.sin(ry * dr);
  const cz = Math.cos(rz * dr), sz = Math.sin(rz * dr);
  const m = [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy,     cy * sx,                cy * cx,
  ];
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const x = raw[i], y = raw[i + 1], z = raw[i + 2];
    out[i]     = m[0] * x + m[1] * y + m[2] * z;
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z;
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z;
  }
  return out;
}

/* Re-orient the imported object: rotate the master positions, rebuild the
   sampler/bounds, re-render and regenerate. */
function applyModelRotation() {
  if (!state.rawPositions) return;
  const rx = num("model-rot-x"), ry = num("model-rot-y"), rz = num("model-rot-z");
  const positions = (rx || ry || rz) ? rotatePositions(state.rawPositions, rx, ry, rz) : state.rawPositions.slice();
  state.positions = positions;
  state.sampler = new MeshSampler(positions);
  state.bounds = state.sampler.bounds;

  const s = state.bounds.size;
  $("info-size").textContent = `${s[0].toFixed(1)} × ${s[1].toFixed(1)} × ${s[2].toFixed(1)}`;
  $("dims-badge").textContent = `${s[0].toFixed(1)} × ${s[1].toFixed(1)} × ${s[2].toFixed(1)} mm`;

  renderer.setMesh(positions, state.bounds);
  applyView();
  regenerate();
}

let orientTimer = null;
function scheduleModelRotation() {
  clearTimeout(orientTimer);
  orientTimer = setTimeout(applyModelRotation, 160);
}

/* ============================================================
   Lattice + G-code regeneration (the live-preview heartbeat)
   ============================================================ */
let regenTimer = null;
function scheduleRegen() {
  updatePrintabilityMeter(); // instant, regen-free feedback
  clearTimeout(regenTimer);
  regenTimer = setTimeout(regenerate, 180); // debounce slider drags
}

/* Live per-pattern printability meter (params-only, no geometry). */
function updatePrintabilityMeter() {
  const p = readParams();
  const r = runPatternPrintability(p.shellPattern, p, state.bounds);
  $("ps-meter-score").textContent = `${r.score} / 100`;
  const fill = $("ps-meter-fill");
  fill.style.width = `${r.score}%`;
  fill.style.background = r.score >= 70 ? "var(--green)" : r.score >= 45 ? "var(--amber)" : "var(--danger)";
  $("ps-meter-sub").textContent =
    `span ${r.maxUnsupportedSpanMm.toFixed(1)} mm · feature ${r.minFeatureMm.toFixed(2)} mm · ~${r.recommendedSpeedMmS} mm/s · supports: ${r.supports}`;
  const glyph = (m) => (m[0] === "✕" || m[0] === "⚠" || m[0] === "✅" || m[0] === "ℹ") ? m : "ℹ " + m;
  $("ps-warnings").innerHTML = r.warnings.map((m) => {
    const sev = m[0] === "✕" ? "error" : m[0] === "⚠" ? "warn" : m[0] === "✅" ? "ok" : "info";
    return `<div class="pc ${sev}"><span>${glyph(m).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</span></div>`;
  }).join("");
}

function regenerate() {
  if (!state.sampler) return;
  showBusy("Generating lattice…");
  // Defer so the browser can paint the busy overlay before we block.
  // Use setTimeout (not rAF) so generation still runs in a background /
  // throttled tab where requestAnimationFrame may never fire.
  setTimeout(doRegenerate, 30);
}

function doRegenerate() {
  try {
    const params = readParams();
    const t0 = performance.now();

    const result = generateLattice(params, state.sampler, state.bounds);
    state.lastResult = result;

    renderer.setLattice(result.linePositions, result.lineColors);
    renderer.setGyroidMesh(result.gyroidPositions);

    setStatus(`${result.stats.segmentCount.toLocaleString()} segments · ` +
      `${(result.stats.totalLength / 1000).toFixed(1)} m · ${Math.round(performance.now() - t0)} ms`);

    // Warn if a shell was requested but produced nothing (e.g. a
    // non-watertight STL that yields no closed contours).
    if (result.shellMeta && result.shellMeta.note) {
      setStatus("⚠ " + result.shellMeta.note);
    } else if (params.shellStyle !== "none" && params.type !== "gyroid") {
      const shellPaths = result.paths.filter((p) => p.kind === "shell").length;
      if (shellPaths === 0) {
        setStatus("⚠ Shell produced no contours — STL may not be watertight.");
      } else if (result.shellMeta && result.shellMeta.capped) {
        setStatus(`${result.stats.segmentCount.toLocaleString()} segments · shell layers capped (tall model)`);
      }
    }

    // Auto-generate the G-code preview so the right panel stays live.
    generateGcodePreview(params);

    // Re-apply current view settings (colour mode / opacity / clip) to
    // the freshly built geometry, and refresh the stats panel.
    applyView();
    computeViewStats(params);
  } catch (err) {
    setStatus("Error: " + err.message);
    console.error(err);
  } finally {
    hideBusy();
  }
}

/* ============================================================
   G-code
   ============================================================ */
function generateGcodePreview(params) {
  if (!state.lastResult || state.lastResult.paths.length === 0) {
    $("gcode-output").textContent = "Nothing generated — adjust the lattice / shell parameters.";
    return;
  }
  const { gcode, stats } = generateGCode(state.lastResult.paths, state.bounds, params);
  state.currentGcode = gcode;
  state.lastGcodeStats = stats;

  $("gc-lines").textContent = stats.lines.toLocaleString();
  $("gc-filament").textContent = `${stats.filamentM.toFixed(2)} m`;
  $("gc-time").textContent = formatTime(stats.timeSec);
  $("gc-struts").textContent = stats.segmentCount.toLocaleString();

  // Cap the on-screen preview for performance; the export keeps it all.
  const lines = gcode.split("\n");
  const CAP = 1500;
  let preview = lines.slice(0, CAP).join("\n");
  if (lines.length > CAP) {
    preview += `\n\n; … ${(lines.length - CAP).toLocaleString()} more lines (full file in export) …`;
  }
  $("gcode-output").textContent = preview;

  if (stats.oversize) {
    setStatus("⚠ Model exceeds the 360 mm Prusa XL bed — it will be clipped on the printer.");
  }
}

/* Export the printed toolpaths as an OBJ of filament-bead tubes (for KeyShot). */
function exportObj() {
  if (!state.lastResult || !state.lastResult.paths || !state.lastResult.paths.length) {
    setStatus("Generate a part first."); return;
  }
  showBusy("Building toolpath mesh…");
  setTimeout(() => {
    try {
      const sides = Math.max(3, Math.min(16, Math.round(num("obj-sides")) || 6));
      const { sections, verts, tris, note } = pathsToOBJ(state.lastResult.paths, state.bounds, { sides });
      if (!sections) { setStatus("⚠ " + (note || "OBJ export failed.")); return; }
      const blob = new Blob(sections, { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${state.fileName || "leitz"}_toolpaths.obj`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      setStatus(`OBJ exported · ${verts.toLocaleString()} verts · ${tris.toLocaleString()} faces${note ? " · " + note : ""}`);
    } catch (err) {
      setStatus("OBJ export error: " + err.message); console.error(err);
    } finally { hideBusy(); }
  }, 30);
}

function exportGcode() {
  if (!state.currentGcode) { regenerate(); return; }
  const blob = new Blob([state.currentGcode], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.fileName}_lattice.gcode`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   View-only controls — opacity, colour mode, clip plane, rotate.
   These NEVER regenerate geometry; they retint/clip in place.
   ============================================================ */
function applyView() {
  const opacity = num("view-shell-opacity");
  const mode = $("view-color-mode").value;
  const clipOn = $("view-clip-enable").checked;
  const axis = $("view-clip-axis").value;
  const pos = num("view-clip-pos") / 100;

  renderer.setShellOpacity(opacity);
  renderer.setClip({ enabled: clipOn, axis, t: pos });
  renderer.setAutoRotate($("view-autorotate").checked);

  // Recolour the existing lattice buffer for the chosen mode (no rebuild).
  if (state.lastResult && state.lastResult.lineColors) {
    recolorBuffer(state.lastResult.paths, state.lastResult.lineColors, mode,
      { horizAngleDeg: num("ps-horiz-angle"), cellSize: num("lat-cell") });
    renderer.applyLatticeColors(state.lastResult.lineColors);
  }
  renderer.renderOnce(); // repaint immediately (also helps when tab is throttled)
}

/* ============================================================
   Stats panel: material grams, time, stringing risk, struts, hole %.
   ============================================================ */
function computeViewStats(params) {
  const res = state.lastResult, gc = state.lastGcodeStats;
  if (!res || !gc) return;

  // grams: extruded filament volume × TPE density (~1.2 g/cm³).
  const filArea = Math.PI * (num("ps-filament") / 2) ** 2;
  const grams = gc.filamentMm * filArea * 0.0012;

  // stringing risk 0-100: length-weighted near-horizontal lattice fraction
  // (the stringy bits) plus a penalty for open shell arcs (many travels).
  const horiz = params.horizAngleDeg;
  let total = 0, risky = 0, openArcs = 0;
  for (const p of res.paths) {
    if (p.kind === "shell" && !p.closed) openArcs++;
    if (p.kind !== "lattice") continue;
    const a = p.pts[0], b = p.pts[1] || p.pts[0];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 0;
    total += len;
    const ang = (Math.asin(Math.min(1, Math.abs(b[2] - a[2]) / (len || 1))) * 180) / Math.PI;
    if (ang < horiz) risky += len;
  }
  const horizFrac = total > 0 ? risky / total : 0;
  const travelPenalty = Math.min(1, openArcs / 1500);
  const risk = Math.round(Math.min(100, 70 * horizFrac + 30 * travelPenalty));

  // hole area %: deposited wall length vs full perimeter (hole-field shells only).
  const hasHolePct = res.shellMeta && typeof res.shellMeta.holePct === "number";
  const holePct = hasHolePct ? res.shellMeta.holePct : 0;

  // open volume %: how airy the cushion is (1 - material / model volume).
  const filVol = gc.filamentMm * filArea; // mm³ of deposited material
  const openPct = state.modelVolume > 0
    ? Math.max(0, Math.min(100, 100 * (1 - filVol / state.modelVolume))) : null;

  // airflow resistance 0 (open air) .. 100 (solid). Use the skin hole-area when
  // a hole-field shell reports it; otherwise (woven / strut skins / none) fall
  // back to overall openness so an obviously-open weave doesn't read as solid.
  const skinOpen = hasHolePct ? holePct : (openPct != null ? openPct : 0);
  const airflow = Math.max(0, Math.min(100, Math.round(100 - skinOpen)));

  $("vs-material").textContent = grams >= 1 ? `${grams.toFixed(1)} g` : `${(grams * 1000).toFixed(0)} mg`;
  $("vs-time").textContent = formatTime(gc.timeSec);
  $("vs-risk").textContent = `${risk} / 100`;
  $("vs-risk").style.color = risk > 60 ? "var(--danger)" : risk > 30 ? "var(--amber)" : "var(--green)";
  $("vs-struts").textContent = gc.segmentCount.toLocaleString();
  $("vs-holes").textContent = hasHolePct ? `${holePct.toFixed(0)} %` : "—";
  $("vs-open").textContent = openPct != null ? `${openPct.toFixed(0)} %` : "—";
  $("vs-airflow").textContent = `${airflow}`;
  $("vs-airflow").style.color = airflow < 25 ? "var(--green)" : airflow < 55 ? "var(--amber)" : "var(--danger)";
  $("view-stats").classList.remove("hidden");
}

/* ============================================================
   Presets + printability
   ============================================================ */
function refreshPresetDropdown() {
  const sel = $("preset-select");
  const userNames = Presets.listUserPresets();
  sel.innerHTML = '<option value="">— choose a preset —</option>';
  const add = (label, value, group) => {
    const o = document.createElement("option");
    o.textContent = label; o.value = value; if (group) o.dataset.group = group;
    sel.appendChild(o);
  };
  Object.keys(Presets.BUILTIN_PRESETS).forEach((n) => add(n, "builtin:" + n));
  userNames.forEach((n) => add("★ " + n, "user:" + n));
}

function applyPreset(value) {
  if (!value) return;
  let snap = null;
  if (value.startsWith("builtin:")) snap = Presets.BUILTIN_PRESETS[value.slice(8)];
  else if (value.startsWith("user:")) snap = Presets.getUserPreset(value.slice(5));
  if (!snap) return;
  const missing = Presets.applyControls(snap);
  setPresetStatus(missing.length ? `Applied (skipped ${missing.length} unknown setting(s))` : "Preset applied.");
}

function setPresetStatus(msg) { $("preset-status").textContent = msg || ""; }

/* Set a control's value and fire its change/input event. */
function setControl(id, val) {
  const el = $(id); if (!el) return;
  if (el.type === "checkbox") el.checked = !!val; else el.value = val;
  el.dispatchEvent(new Event(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", { bubbles: true }));
}

/* Transition macro — maps the 4 surface↔interior transition types onto the
   already-shipped merge / density-gradient / shell-pattern controls. */
function applyTransition(kind) {
  if (kind === "hard") { setControl("merge-intensity", "0"); }
  else if (kind === "gradient") { setControl("merge-intensity", "0.8"); setControl("gyroid-densgrad", "radial"); }
  else if (kind === "eruption") { setControl("shell-style", "gyroid"); setControl("merge-intensity", "0.5"); }
  else if (kind === "anchor") { setControl("shell-style", "node"); setControl("merge-intensity", "0.7"); }
}

/* Surprise me — pick a vetted printable surface and apply it. */
function surpriseMe() {
  const idx = Math.floor(Math.random() * SURPRISE_TABLE.length);
  const combo = SURPRISE_TABLE[idx];
  for (const [id, v] of Object.entries(combo)) setControl(id, v);
  setPresetStatus("🎲 Surprise surface applied.");
}

function doPrintability() {
  if (!state.sampler) { setPresetStatus("Load a model first."); return; }
  const issues = Presets.runPrintabilityCheck(readParams(), state.bounds);
  const box = $("printability-report");
  const glyph = { error: "✕", warn: "⚠", info: "ℹ", ok: "✓" };
  box.innerHTML = issues.map((i) =>
    `<div class="pc ${i.sev}"><b>${glyph[i.sev]}</b><span>${escapeHtml(i.msg)}</span></div>`).join("");
}
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

/* ============================================================
   Density <-> strut diameter linkage
   ============================================================ */
function syncDensityFromDiameter() {
  const type = $("lat-type").value;
  if (type.startsWith("gyroid")) return; // gyroid uses period/iso, not strut diameter
  const d = diameterToDensity(num("lat-strut"), num("lat-cell"), type);
  $("lat-density").value = d.toFixed(0);
  $("out-density").textContent = d.toFixed(0);
}
function syncDiameterFromDensity() {
  const type = $("lat-type").value;
  if (type.startsWith("gyroid")) return;
  const dia = densityToDiameter(num("lat-density"), num("lat-cell"), type);
  $("lat-strut").value = dia.toFixed(2);
  $("out-strut").textContent = dia.toFixed(2);
}

/* ============================================================
   UI helpers
   ============================================================ */
function showBusy(msg) { $("busy-text").textContent = msg || "Working…"; $("busy").classList.remove("hidden"); }
function hideBusy() { $("busy").classList.add("hidden"); }
function setStatus(msg) { const b = $("status-badge"); b.textContent = msg; b.classList.remove("hidden"); }

function formatTime(sec) {
  if (!isFinite(sec) || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* Bind a range input to its <output> readout. */
function bindOutput(rangeId, outId, digits) {
  const r = $(rangeId), o = $(outId);
  const update = () => { o.textContent = digits != null ? parseFloat(r.value).toFixed(digits) : r.value; };
  r.addEventListener("input", update);
  update();
}

/* ============================================================
   Event wiring
   ============================================================ */
function init() {
  // Slider readouts.
  bindOutput("lat-cell", "out-cell", 1);
  bindOutput("lat-strut", "out-strut", 2);
  bindOutput("lat-bottom", "out-bottom", 0);
  bindOutput("lat-top", "out-top", 0);
  bindOutput("lat-rotx", "out-rotx", 0);
  bindOutput("lat-roty", "out-roty", 0);
  bindOutput("lat-rotz", "out-rotz", 0);
  bindOutput("shell-perims", "out-shell-perims", 0);
  bindOutput("hole-size", "out-hole-size", 1);
  bindOutput("hole-pitch", "out-hole-pitch", 1);
  bindOutput("min-wall", "out-min-wall", 1);
  bindOutput("hole-taper", "out-hole-taper", 1);
  bindOutput("pattern-rotation", "out-pattern-rotation", 0);
  bindOutput("hole-scale-center", "out-hole-scale-center", 2);
  bindOutput("hole-scale-edge", "out-hole-scale-edge", 2);
  bindOutput("hole-scale-height", "out-hole-scale-height", 2);
  bindOutput("seed-jitter", "out-seed-jitter", 2);
  bindOutput("merge-intensity", "out-merge-intensity", 2);
  bindOutput("hole-density", "out-hole-density", 2);
  bindOutput("view-shell-opacity", "out-view-opacity", 0);
  bindOutput("view-clip-pos", "out-view-clip-pos", 0);
  bindOutput("gyroid-period", "out-gyroid-period", 1);
  bindOutput("gyroid-wall", "out-gyroid-wall", 2);
  bindOutput("gyroid-iso", "out-gyroid-iso", 2);
  bindOutput("gyroid-px", "out-gyroid-px", 0);
  bindOutput("gyroid-py", "out-gyroid-py", 0);
  bindOutput("gyroid-pz", "out-gyroid-pz", 0);
  bindOutput("gyroid-grad", "out-gyroid-grad", 2);
  bindOutput("gyroid-node", "out-gyroid-node", 1);
  bindOutput("model-rot-x", "out-mrx", 0);
  bindOutput("model-rot-y", "out-mry", 0);
  bindOutput("model-rot-z", "out-mrz", 0);
  bindOutput("rib-width", "out-rib-width", 1);
  bindOutput("rib-gap", "out-rib-gap", 1);
  bindOutput("rib-angle", "out-rib-angle", 0);
  bindOutput("mesh-angle", "out-mesh-angle", 0);
  bindOutput("mesh-strand", "out-mesh-strand", 2);
  bindOutput("mesh-opening", "out-mesh-opening", 1);
  bindOutput("aux-cell-w", "out-aux-w", 1);
  bindOutput("aux-cell-h", "out-aux-h", 1);
  bindOutput("aux-reentrant", "out-aux-re", 2);
  bindOutput("aux-wall", "out-aux-wall", 1);
  bindOutput("warp-count", "out-warp-count", 0);
  bindOutput("weft-pitch", "out-weft-pitch", 1);
  bindOutput("strand-d", "out-strand-d", 2);
  bindOutput("weave-depth", "out-weave-depth", 2);

  // Dropzone.
  const dz = $("dropzone"), fi = $("file-input");
  dz.addEventListener("click", () => fi.click());
  fi.addEventListener("change", (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f && /\.stl$/i.test(f.name)) loadFile(f);
  });
  // Allow dropping anywhere on the viewport too.
  const vp = $("viewport");
  ["dragover"].forEach((ev) => vp.addEventListener(ev, (e) => e.preventDefault()));
  vp.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && /\.stl$/i.test(f.name)) loadFile(f);
  });

  // Density / diameter / cell linkage (these recompute their siblings,
  // so they get bespoke handlers and are excluded from generic wiring).
  const SPECIAL = new Set(["lat-strut", "lat-density", "lat-cell", "lat-type", "preset-select", "preset-file",
    "model-rot-x", "model-rot-y", "model-rot-z", // rotation rebuilds the sampler, not just a regen
    "transition"]); // write-only macro over other controls
  $("lat-strut").addEventListener("input", () => { syncDensityFromDiameter(); scheduleRegen(); });
  $("lat-density").addEventListener("input", () => {
    $("out-density").textContent = $("lat-density").value;
    syncDiameterFromDensity(); scheduleRegen();
  });
  $("lat-cell").addEventListener("input", () => { syncDensityFromDiameter(); scheduleRegen(); });
  $("lat-type").addEventListener("change", () => { syncDensityFromDiameter(); scheduleRegen(); });

  // Every other control in the left panel just regenerates (lattice
  // caps, orientation, shell, print + surface-quality settings).
  document.querySelectorAll("#left-panel input, #left-panel select").forEach((el) => {
    if (!el.id || SPECIAL.has(el.id)) return;
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", scheduleRegen);
  });

  // Buttons.
  $("btn-generate").addEventListener("click", regenerate);
  $("btn-export").addEventListener("click", exportGcode);
  $("btn-export-obj").addEventListener("click", exportObj);

  // View controls.
  document.querySelectorAll(".view-controls button[data-view]").forEach((b) =>
    b.addEventListener("click", () => renderer.setView(b.dataset.view, state.bounds)));
  $("toggle-mesh").addEventListener("change", (e) => renderer.setMeshVisible(e.target.checked));
  $("toggle-lattice").addEventListener("change", (e) => renderer.setLatticeVisible(e.target.checked));

  // View panel (center, OUTSIDE #left-panel): pure view changes — these
  // must NEVER regenerate geometry, only retint / clip / spin in place.
  ["view-shell-opacity", "view-color-mode", "view-clip-enable",
   "view-clip-axis", "view-clip-pos", "view-autorotate"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", applyView);
  });

  // Presets + printability + tooltips.
  refreshPresetDropdown();
  Presets.applyTooltips();
  $("preset-select").addEventListener("change", (e) => applyPreset(e.target.value));
  $("btn-preset-save").addEventListener("click", () => {
    const name = prompt("Save preset as:");
    if (!name) return;
    if (Presets.saveUserPreset(name)) { refreshPresetDropdown(); setPresetStatus(`Saved “${name}”.`); }
    else setPresetStatus("Could not save (localStorage unavailable).");
  });
  $("btn-preset-export").addEventListener("click", () => {
    const blob = Presets.exportPresetBlob(state.fileName || "leitz-preset");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${state.fileName || "leitz"}_preset.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });
  $("btn-preset-import").addEventListener("click", () => $("preset-file").click());
  $("preset-file").addEventListener("change", (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const obj = Presets.parseImportedPreset(ev.target.result);
        Presets.applyControls(obj.values);
        setPresetStatus(`Imported “${obj.name || "preset"}”.`);
      } catch (err) { setPresetStatus("Import failed: " + err.message); }
    };
    r.readAsText(f);
    e.target.value = "";
  });
  $("btn-printability").addEventListener("click", doPrintability);
  $("btn-create-form").addEventListener("click", createForm);
  $("btn-surprise").addEventListener("click", surpriseMe);
  $("transition").addEventListener("change", (e) => { if (e.target.value !== "custom") applyTransition(e.target.value); });
  updatePrintabilityMeter();

  // Object orientation — rebuilds the sampler, so these are debounced and
  // call applyModelRotation (not the plain regen path).
  ["model-rot-x", "model-rot-y", "model-rot-z"].forEach((id) =>
    $(id).addEventListener("input", scheduleModelRotation));
  $("btn-orient-reset").addEventListener("click", () => {
    ["model-rot-x", "model-rot-y", "model-rot-z"].forEach((id) => {
      const el = $(id); el.value = "0"; el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  $("btn-pa-tower").addEventListener("click", () => {
    const gcode = generatePATestGcode(readParams());
    const blob = new Blob([gcode], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "PA_tuning_tower.gcode";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    setPresetStatus("PA tuning tower downloaded.");
  });

  // Initial density readout from the default diameter.
  syncDensityFromDiameter();
}

init();
