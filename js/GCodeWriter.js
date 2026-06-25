/* ============================================================
   GCodeWriter — turns the unified PATH network into TPE-optimized,
   surface-quality G-code for a Prusa XL.

   QUALITY MODEL
   -------------
   • Each closed loop (wall / shell ring) prints as ONE continuous
     extrusion with a SINGLE, placeable seam — no per-segment
     retract/blob. This is the biggest single surface-quality win.
   • Paths are ordered bottom-up by Z band; within a band inner
     perimeters print first and the visible OUTER skin prints LAST,
     slower (extPerimSpeed), so inner scarring is buried.
   • Seam control: aligned (rear), nearest, or random per loop.
   • Coast: stop extruding for the last `coastLength` mm of a loop so
     residual nozzle pressure closes the seam without a blob.
   • Bridge handling: shell ring bands that span open grid windows
     (and near-horizontal lattice struts) print slower with full fan.
   • First layer: own speed + fan regardless of geometry.
   • Anti-stringing for TPE: wipe-before-retract, short retracts,
     combing on short hops, forced retract + lift across open windows,
     pressure advance (M572), and smoothing accel/jerk (M204/M205).

   All extrusion is RELATIVE (M83): each move emits only its E delta.
   ============================================================ */

import { minZ, centroid, pathLength, rotateLoop, dist3 } from "./PathUtils.js";

const BED = { x: 360, y: 360, z: 360 };

/* ---------- formatting ---------- */
const f3 = (n) => (Object.is(n, -0) ? 0 : n).toFixed(3);
const f5 = (n) => (Object.is(n, -0) ? 0 : n).toFixed(5);
const mmMin = (v) => Math.round(v * 60);
const pct255 = (p) => Math.round((Math.max(0, Math.min(100, p)) / 100) * 255);

/* ---------- path ordering ---------- */
// Lower rank prints first; outer skin prints LAST within a Z band.
function roleRank(path) {
  switch (path.role) {
    case "inner":  return 0;
    case "solid":  return 1;
    case "gyroid": return 2;
    case "lattice":return 3;
    default:       return 4; // outer
  }
}
// Z used for band bucketing. Planar paths (rings, ribs, solid) use their
// height; an open multi-band lattice strut uses its MIDPOINT so it doesn't
// get printed entirely in its lowest band (ahead of higher bands' outer walls).
function bandZ(path) {
  if (path.closed) return minZ(path);
  let lo = Infinity, hi = -Infinity;
  for (const q of path.pts) { if (q[2] < lo) lo = q[2]; if (q[2] > hi) hi = q[2]; }
  return (lo + hi) / 2;
}
const pathAnchor = (path) => (path.closed ? centroid(path) : path.pts[0]);
const distToPath = (cur, path) =>
  path.closed ? dist3(cur, centroid(path))
              : Math.min(dist3(cur, path.pts[0]), dist3(cur, path.pts[path.pts.length - 1]));

/** Choose the seam (start) vertex of a closed loop. */
function seamIndex(path, mode, cur) {
  const pts = path.pts;
  if (mode === "nearest") {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) { const d = dist3(cur, pts[i]); if (d < bd) { bd = d; bi = i; } }
    return bi;
  }
  if (mode === "random") {
    // Seed with the loop's start X/Y/Z so co-planar loops scatter their
    // seams instead of all hashing to the same index per layer.
    const seed = pts[0][0] * 12.9898 + pts[0][1] * 78.233 + pts[0][2] * 37.719;
    const h = Math.abs(Math.sin(seed) * 43758.5453) % 1;
    return Math.floor(h * pts.length);
  }
  // aligned (default): rear-most vertex (max Y) -> seam hidden at back
  let bi = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][1] > pts[bi][1] || (pts[i][1] === pts[bi][1] && pts[i][0] > pts[bi][0])) bi = i;
  }
  return bi;
}

/** Orient a path for printing from the current cursor (returns a copy). */
function orient(path, cur, p) {
  if (path.closed) {
    const idx = seamIndex(path, p.seamMode, cur);
    return { ...path, pts: rotateLoop(path.pts, idx) };
  }
  const a = path.pts[0], b = path.pts[path.pts.length - 1];
  if (dist3(cur, b) < dist3(cur, a)) return { ...path, pts: path.pts.slice().reverse() };
  return path;
}
const endOf = (path) => (path.closed ? path.pts[0] : path.pts[path.pts.length - 1]);

/**
 * Bottom-up Z bands; within a band, group by role (inner→outer) and
 * nearest-neighbour each group so loops/ribs are never shattered.
 */
function orderPaths(paths, p, cursor0) {
  const bandH = Math.max(2, p.cellSize || 10);
  const bands = new Map();
  for (const path of paths) {
    const key = Math.floor(bandZ(path) / bandH);
    let arr = bands.get(key); if (!arr) { arr = []; bands.set(key, arr); }
    arr.push(path);
  }
  const keys = [...bands.keys()].sort((a, b) => a - b);

  const ordered = [];
  let cursor = cursor0.slice();

  for (const key of keys) {
    const groups = new Map();
    for (const path of bands.get(key)) {
      const r = roleRank(path);
      let arr = groups.get(r); if (!arr) { arr = []; groups.set(r, arr); }
      arr.push(path);
    }
    for (const rank of [...groups.keys()].sort((a, b) => a - b)) {
      const g = groups.get(rank);
      if (!p.nearestNeighbor || g.length > 3000) {
        g.sort((s1, s2) => { const a = pathAnchor(s1), b = pathAnchor(s2); return (a[1] - b[1]) || (a[0] - b[0]); });
        for (const path of g) { const o = orient(path, cursor, p); ordered.push(o); cursor = endOf(o); }
      } else {
        const used = new Array(g.length).fill(false);
        for (let placed = 0; placed < g.length; placed++) {
          let best = -1, bestD = Infinity;
          for (let i = 0; i < g.length; i++) { if (used[i]) continue; const d = distToPath(cursor, g[i]); if (d < bestD) { bestD = d; best = i; } }
          used[best] = true;
          const o = orient(g[best], cursor, p);
          ordered.push(o); cursor = endOf(o);
        }
      }
    }
  }
  return ordered;
}

/* ---------- Prusa XL start / end G-code ---------- */
function startGcode(p, originXY) {
  return [
    "; ====== LEITZ Slicer 1 ======",
    "; Printer : Prusa XL (bed 360 x 360 x 360 mm)",
    "; Material: TPE / TPU (flexible)",
    `; Nozzle  : ${p.temp}C   Bed: ${p.bed}C   Pressure Advance: ${p.pressureAdvance}`,
    ";",
    "M83                      ; relative extrusion (E deltas per move)",
    "G90                      ; absolute XYZ",
    "M104 S" + p.temp + "             ; start heating hotend",
    "M140 S" + p.bed + "              ; start heating bed",
    "M190 S" + p.bed + "              ; wait for bed temp",
    "M109 S" + p.temp + "             ; wait for hotend temp",
    "G28                      ; home all axes",
    "G29                      ; mesh bed leveling",
    "M572 D0 S" + p.pressureAdvance + "         ; pressure advance (anti-stringing)",
    `M204 P${Math.round(p.normalAccel)}              ; print acceleration`,
    `M205 X${p.jerk} Y${p.jerk}             ; jerk / junction smoothing`,
    "M221 S100                ; flow 100% (flow baked into E)",
    "G92 E0                   ; reset extruder",
    "; --- prime line ---",
    "G1 Z0.30 F1000",
    `G1 X${f3(originXY[0] - 20)} Y${f3(originXY[1] - 40)} F${mmMin(p.travelSpeed)}`,
    `G1 X${f3(originXY[0] + 40)} Y${f3(originXY[1] - 40)} E6.0 F1200   ; prime`,
    "G92 E0",
    `M106 S${pct255(p.firstLayerFan)}                 ; first-layer fan`,
    "; ====== begin part ======",
  ].join("\n");
}
function endGcode() {
  return [
    "; ====== end ======",
    "M104 S0                  ; hotend off",
    "M140 S0                  ; bed off",
    "M107                     ; fan off",
    "G91",
    "G1 E-2 F2400             ; final retract",
    "G1 Z10 F1000             ; lift",
    "G90",
    "G1 X0 Y360 F8000         ; present print",
    "M84                      ; steppers off",
  ].join("\n");
}

/* ============================================================
   Pressure-Advance tuning tower (standalone, ignores the model).

   Prints a hollow square tower whose four walls alternate fast/slow,
   so each corner is a speed transition. The pressure-advance K-factor
   (M572) steps up every band of layers (with a comment), so after
   printing you keep the K at the height with the cleanest, most
   consistent corners (no bulge on slow-in, no gap on fast-out).
   ============================================================ */
export function generatePATestGcode(p) {
  const side = 30, h = p.layerHeight || 0.2, H = 30;
  const cx = BED.x / 2, cy = BED.y / 2;
  const nLayers = Math.max(10, Math.round(H / h));
  const bands = 10;
  const kStart = 0.0, kEnd = 1.0;
  const fil = Math.PI * (p.filamentDiameter / 2) ** 2;
  const bead = (p.lineWidth || 0.45) * h;
  const eFor = (len) => (len * bead) / fil * (p.flow || 1);
  const x0 = cx - side / 2, y0 = cy - side / 2, x1 = cx + side / 2, y1 = cy + side / 2;
  const fast = 60, slow = 20;

  const out = [startGcode({ ...p, firstLayerFan: p.firstLayerFan ?? 0,
    normalAccel: p.normalAccel ?? 2000, jerk: p.jerk ?? 8 }, [cx, cy])];
  out.push("; ====== Pressure Advance tuning tower ======");
  out.push(`; K steps ${kStart}..${kEnd} over ${bands} bands (alternating 60/20 mm/s walls)`);

  let z = h, lastBand = -1;
  // corners CCW; each side gets fast or slow so every corner is a transition
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const sideSpeed = [fast, slow, fast, slow];
  out.push(`G1 Z${f3(z)} F1000`);
  out.push(`G1 X${f3(x0)} Y${f3(y0)} F${mmMin(p.travelSpeed || 120)}`);

  for (let l = 0; l < nLayers; l++) {
    z = h * (l + 1);
    const band = Math.min(bands - 1, Math.floor((l / nLayers) * bands));
    if (band !== lastBand) {
      const k = (kStart + (kEnd - kStart) * (band / (bands - 1))).toFixed(3);
      out.push(`M572 D0 S${k}   ; --- band ${band}: K = ${k} (z≈${f3(z)}) ---`);
      lastBand = band;
    }
    for (let s = 0; s < 4; s++) {
      const a = corners[s], b = corners[(s + 1) % 4];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      out.push(`G1 X${f3(b[0])} Y${f3(b[1])} Z${f3(z)} E${f5(eFor(len))} F${mmMin(sideSpeed[s])}`);
    }
  }
  out.push(endGcode());
  return out.join("\n") + "\n";
}

/* ============================================================
   MAIN
   ============================================================ */
export function generateGCode(paths, bounds, p) {
  // ---- resolve defaults for the newer quality params ----
  const extPerimSpeed   = p.extPerimSpeed   ?? p.printSpeed;
  const firstLayerSpeed = p.firstLayerSpeed ?? Math.max(10, p.printSpeed * 0.8);
  const firstLayerFan   = p.firstLayerFan   ?? 0;
  const wallFan         = p.wallFan         ?? p.baseFan;
  const seamMode        = p.seamMode        ?? "aligned";
  const coastLength     = p.coastLength     ?? 0;
  const outerAccel      = p.outerAccel      ?? 800;
  const normalAccel     = p.normalAccel     ?? 2000;
  const jerk            = p.jerk            ?? 8;
  const windowRetract   = p.windowRetract   ?? true;
  const smallFeatureLen = p.smallFeatureLen ?? 0;
  const smallFeatureMult= p.smallFeatureMult?? 1;
  const pp = { ...p, extPerimSpeed, firstLayerFan, normalAccel, jerk, seamMode };

  // ---- bed placement: centre + rest on Z=0 ----
  const offset = [BED.x / 2 - bounds.center[0], BED.y / 2 - bounds.center[1], -bounds.min[2]];
  const tx = (pt) => [pt[0] + offset[0], pt[1] + offset[1], pt[2] + offset[2]];
  const bedCenter = [BED.x / 2, BED.y / 2];

  const filamentArea = Math.PI * (p.filamentDiameter / 2) ** 2;
  const eFor = (len, area) => (len * area) / filamentArea * p.flow;

  const ordered = orderPaths(paths, pp, [bounds.center[0], bounds.center[1], bounds.min[2]]);

  const out = [];
  out.push(startGcode(pp, bedCenter));

  // ---- printer state ----
  let pos = [bedCenter[0] + 40, bedCenter[1] - 40, 0.3];
  let retracted = false, lastRetractAmount = 0;
  let currentFan = pct255(firstLayerFan);
  let currentAccel = normalAccel;
  let currentF = null;
  let totalE = 0, timeSec = 0, segs = 0;
  let lastPrintDir = null, prevExtraRetract = 0, prevOpenShell = false;

  const travelF = mmMin(p.travelSpeed);
  const firstLayerMaxZ = 1.5 * p.layerHeight; // model bottom maps to bed Z 0

  const setFan = (v) => { if (v !== currentFan) { out.push(v === 0 ? "M107" : `M106 S${v}`); currentFan = v; } };
  const setAccel = (a) => { if (a !== currentAccel) { out.push(`M204 P${Math.round(a)}`); currentAccel = a; } };

  const retract = (extra) => {
    if (retracted) return;
    const amt = p.retractDistance + (extra || 0);
    out.push(`G1 E-${f5(amt)} F${mmMin(p.retractSpeed)}   ; retract`);
    lastRetractAmount = amt; retracted = true; currentF = null;
    timeSec += amt / p.retractSpeed;
  };
  const unretract = () => {
    if (!retracted) return;
    out.push(`G1 E${f5(lastRetractAmount)} F${mmMin(p.retractSpeed)}  ; unretract`);
    retracted = false; currentF = null;
    timeSec += lastRetractAmount / p.retractSpeed;
  };

  // Travel move (optionally with a comment); F only emitted on change.
  const travelMove = (t, comment) => {
    let s = `G1 X${f3(t[0])} Y${f3(t[1])} Z${f3(t[2])}`;
    if (travelF !== currentF) { s += ` F${travelF}`; currentF = travelF; }
    if (comment) s += `   ; ${comment}`;
    out.push(s);
  };

  /**
   * Move (no extrusion) from pos to target: combing on short hops,
   * wipe-before-retract, retract, optional Z-hop, unretract.
   */
  const travelTo = (target, wipeDir, extraRetract, forceRetract) => {
    const d = dist3(pos, target);
    if (d < 1e-4) return;
    const comb = !forceRetract && d <= p.combingMax;

    if (!comb) {
      if (wipeDir && p.wipeDistance > 0) {
        const w = [pos[0] + wipeDir[0] * p.wipeDistance, pos[1] + wipeDir[1] * p.wipeDistance, pos[2] + wipeDir[2] * p.wipeDistance];
        travelMove(w, "wipe"); pos = w; timeSec += p.wipeDistance / p.travelSpeed;
      }
      retract(extraRetract);
    }

    const lift = forceRetract ? Math.max(p.zHop, p.layerHeight * 2) : p.zHop;
    if (!comb && lift > 0) {
      const zl = Math.max(pos[2], target[2]) + lift;
      travelMove([pos[0], pos[1], zl], "lift");
      travelMove([target[0], target[1], zl], "travel");
      travelMove([target[0], target[1], target[2]]);
    } else {
      travelMove(target, "travel");
    }
    pos = target.slice();
    timeSec += d / p.travelSpeed;
    if (!comb) unretract();
  };

  // Emit a path's extrusion (continuous), honouring coast on loops.
  const emitExtrude = (mpts, closed, speed, area, coast) => {
    const seq = closed ? mpts.concat([mpts[0]]) : mpts;
    let total = 0;
    for (let i = 1; i < seq.length; i++) total += dist3(seq[i - 1], seq[i]);
    const coastStart = total - coast;
    const F = mmMin(speed);
    let acc = 0;
    for (let i = 1; i < seq.length; i++) {
      const A = seq[i - 1], B = seq[i];
      const segLen = dist3(A, B);
      if (segLen < 1e-6) continue;

      if (acc >= coastStart - 1e-9) {
        // coasting: move without extruding so residual pressure fills it
        let s = `G1 X${f3(B[0])} Y${f3(B[1])} Z${f3(B[2])}`;
        if (F !== currentF) { s += ` F${F}`; currentF = F; }
        out.push(s);
      } else if (acc + segLen <= coastStart + 1e-9) {
        const e = eFor(segLen, area);
        let s = `G1 X${f3(B[0])} Y${f3(B[1])} Z${f3(B[2])} E${f5(e)}`;
        if (F !== currentF) { s += ` F${F}`; currentF = F; }
        out.push(s); totalE += e;
      } else {
        // split: extrude up to coastStart, coast the remainder
        const l1 = coastStart - acc, t = l1 / segLen;
        const mid = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
        const e = eFor(l1, area);
        let s = `G1 X${f3(mid[0])} Y${f3(mid[1])} Z${f3(mid[2])} E${f5(e)}`;
        if (F !== currentF) { s += ` F${F}`; currentF = F; }
        out.push(s); totalE += e;
        out.push(`G1 X${f3(B[0])} Y${f3(B[1])} Z${f3(B[2])}`);
      }
      acc += segLen; segs++; pos = B.slice();
      timeSec += segLen / speed;
      lastPrintDir = [(B[0] - A[0]) / segLen, (B[1] - A[1]) / segLen, (B[2] - A[2]) / segLen];
    }
  };

  // ---------------- main per-path loop ----------------
  for (const path of ordered) {
    const mpts = path.pts.map(tx);
    if (mpts.length < 2) continue;
    const start = mpts[0];

    const isShellArc = path.kind === "shell" && !path.closed;
    const forceRetract = !!(windowRetract && isShellArc && prevOpenShell);
    const wipeDir = lastPrintDir ? [-lastPrintDir[0], -lastPrintDir[1], -lastPrintDir[2]] : null;
    travelTo(start, wipeDir, prevExtraRetract, forceRetract);

    // First-layer only if the WHOLE path sits in the first layer — a
    // diagonal lattice strut that merely starts at z=0 is not first-layer
    // (keying off the start point alone causes fan flapping).
    let maxZ = -Infinity;
    for (const q of mpts) if (q[2] > maxZ) maxZ = q[2];
    const isFirstLayer = maxZ <= firstLayerMaxZ;
    const L = path.closed
      ? (() => { let s = 0; for (let i = 1; i < mpts.length; i++) s += dist3(mpts[i - 1], mpts[i]); return s + dist3(mpts[mpts.length - 1], mpts[0]); })()
      : (() => { let s = 0; for (let i = 1; i < mpts.length; i++) s += dist3(mpts[i - 1], mpts[i]); return s; })();

    // ---- speed / fan / extra-retract profile ----
    let speed, fan, extraNext = 0;
    if (isFirstLayer) {
      speed = firstLayerSpeed; fan = firstLayerFan;
    } else if (path.kind === "lattice") {
      // end-to-end chord so a curved (multi-point) strut classifies by its true orientation
      const a = mpts[0], b = mpts[mpts.length - 1], len = dist3(a, b) || 1;
      const ang = (Math.asin(Math.min(1, Math.abs(b[2] - a[2]) / len)) * 180) / Math.PI;
      const nearH = ang < p.horizAngleDeg;
      speed = nearH ? p.printSpeed * p.horizSpeedMult : p.printSpeed;
      fan = nearH ? p.bridgeFan : p.baseFan;
      extraNext = nearH ? p.extraRetract : 0;
    } else if (path.bridge) {                       // shell ring spanning windows
      speed = p.printSpeed * p.horizSpeedMult; fan = p.bridgeFan; extraNext = p.extraRetract;
    } else if (path.role === "outer") {             // visible skin: slow + smooth
      speed = extPerimSpeed; fan = wallFan;
    } else if (path.kind === "shell" || path.kind === "wall") {
      speed = p.printSpeed; fan = wallFan;          // inner perimeters / ribs
    } else {                                        // solid caps, gyroid
      speed = p.printSpeed; fan = p.baseFan;
    }

    // Small-feature slowdown — but never override the first-layer profile.
    if (!isFirstLayer && smallFeatureLen > 0 && L < smallFeatureLen) speed *= smallFeatureMult;
    speed = Math.max(2, speed);

    setAccel(path.role === "outer" ? outerAccel : normalAccel);
    setFan(pct255(fan));

    // Coast closes the seam on visible loops — but NOT on tiny node-ball weld
    // loops, whose whole purpose is a continuous, fully-extruded fillet.
    const coast = path.closed && !path.weld && coastLength > 0 && L > 2.5 * coastLength ? coastLength : 0;
    emitExtrude(mpts, path.closed, speed, path.area, coast);

    prevExtraRetract = extraNext;
    prevOpenShell = isShellArc;
  }

  retract(0);
  out.push(endGcode());

  const gcode = out.join("\n") + "\n";
  const stats = {
    lines: gcode.split("\n").length,
    filamentMm: totalE,
    filamentM: totalE / 1000,
    timeSec,
    pathCount: ordered.length,
    segmentCount: segs,
    printedStruts: segs,
    oversize: bounds.size[0] > BED.x || bounds.size[1] > BED.y || bounds.size[2] > BED.z,
  };
  return { gcode, stats };
}
