/* ============================================================
   LatticeGenerator — fills the model with a printable network of
   PATHS (see PathUtils). Everything downstream (rendering + G-code)
   consumes the unified path list.

     path = { pts:[[x,y,z],...], kind, role, area, closed, bridge? }

   Lattice types:
     cubic  — axis struts along X/Y/Z cell edges
     bcc    — 8 body-diagonal struts from corners to cell centre
     fcc    — face-diagonal struts from face centres to corners
     gyroid — TPMS surface sliced into per-layer contour struts

   Plus solid top/bottom raster caps and, when enabled, a grid-based
   outer SHELL (GridShell.js) wrapping the whole part.
   ============================================================ */

import { generateGyroid } from "./Gyroid.js";
import { sliceAtZ } from "./Slicer.js";
import { generateShell } from "./ShellGenerator.js";
import { generateWovenSurface } from "./WovenSurface.js";
import { makeSeg, segCount, segments, dist3 } from "./PathUtils.js";

// Approximate strut-length-per-cell coefficient k (length per unit
// volume = k / cellSize²), used to link density <-> strut diameter.
const LENGTH_COEFF = { cubic: 3, bcc: 4 * Math.sqrt(3), fcc: 12 / Math.SQRT2, kelvin: 6 * Math.SQRT2 };

/* ---------- density <-> diameter linkage (physical, not magic) ---------- */

export function densityToDiameter(densityPct, cellSize, type) {
  const k = LENGTH_COEFF[type] || LENGTH_COEFF.bcc;
  const volFrac = Math.max(0.001, densityPct / 100);
  const d = 2 * Math.sqrt((volFrac * cellSize * cellSize) / (Math.PI * k));
  return Math.min(3, Math.max(0.4, d));
}

export function diameterToDensity(diameter, cellSize, type) {
  const k = LENGTH_COEFF[type] || LENGTH_COEFF.bcc;
  const volFrac = (k / (cellSize * cellSize)) * Math.PI * (diameter / 2) ** 2;
  return Math.min(100, Math.max(1, volFrac * 100));
}

/* ---------- rotation helpers ---------- */

function rotationMatrix(rx, ry, rz) {
  const dr = Math.PI / 180;
  const [cx, sx] = [Math.cos(rx * dr), Math.sin(rx * dr)];
  const [cy, sy] = [Math.cos(ry * dr), Math.sin(ry * dr)];
  const [cz, sz] = [Math.cos(rz * dr), Math.sin(rz * dr)];
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy,     cy * sx,                cy * cx,
  ];
}

function applyRot(m, p, center) {
  const x = p[0] - center[0], y = p[1] - center[1], z = p[2] - center[2];
  return [
    center[0] + m[0] * x + m[1] * y + m[2] * z,
    center[1] + m[3] * x + m[4] * y + m[5] * z,
    center[2] + m[6] * x + m[7] * y + m[8] * z,
  ];
}

/* ---------- strut clipping against the model ---------- */

function clipStrut(a, b, sampler, wall, kind, area, out, opts) {
  const len = dist3(a, b);
  if (len < 1e-4) return;
  const step = 0.8;
  const n = Math.max(2, Math.ceil(len / step));
  let runStart = -1;
  const inside = (i) => {
    const t = i / n;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    return wall > 0 ? sampler.isDeepInside(x, y, z, wall) : sampler.isInside(x, y, z);
  };
  const pointAt = (i) => {
    const t = i / n;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };

  // Per-sub-segment area modulation:
  //  - merge transition: thicken near-surface segments (shell fusion)
  //  - taperProfile: vary strut thickness along its length
  //      uniform   = constant
  //      hourglass = thin in the middle (flexible feel)
  //      bone      = thick at the ends (stiff joints, soft span)
  const transition = opts?.transition || 0;
  const taperBoost = opts?.taperBoost || 0;
  const taperProfile = opts?.taperProfile;
  const minArea = opts?.minArea || 0;
  const profileFn = (t) => {
    if (taperProfile === "hourglass") return 1 - 0.45 * (1 - Math.abs(2 * t - 1));
    if (taperProfile === "bone") return 0.7 + 0.45 * Math.abs(2 * t - 1);
    return 1;
  };
  const split = transition > 0 || (taperProfile && taperProfile !== "uniform");
  const emitRun = (pa, pb) => {
    if (!split) { out.push(makeSeg(pa, pb, kind, kind, area)); return; }
    const segs = Math.max(1, opts.taperSegs || 4);
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs, t1 = (s + 1) / segs, tMid = (s + 0.5) / segs;
      const p0 = [pa[0] + (pb[0] - pa[0]) * t0, pa[1] + (pb[1] - pa[1]) * t0, pa[2] + (pb[2] - pa[2]) * t0];
      const p1 = [pa[0] + (pb[0] - pa[0]) * t1, pa[1] + (pb[1] - pa[1]) * t1, pa[2] + (pb[2] - pa[2]) * t1];
      let segArea = area * profileFn(tMid);
      if (transition > 0) {
        const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2, mz = (p0[2] + p1[2]) / 2;
        if (!sampler.isDeepInside(mx, my, mz, transition)) segArea *= (1 + taperBoost);
      }
      out.push(makeSeg(p0, p1, kind, kind, Math.max(minArea, segArea)));
    }
  };

  for (let i = 0; i <= n; i++) {
    if (inside(i)) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - 1 > runStart) emitRun(pointAt(runStart), pointAt(i - 1));
      runStart = -1;
    }
  }
  if (runStart >= 0 && n > runStart) emitRun(pointAt(runStart), pointAt(n));
}

/* ---------- lattice unit-cell strut builders (local frame) ---------- */

function buildAxisStruts(bounds, cell, push) {
  const c = bounds.center;
  const half = 0.5 * Math.hypot(...bounds.size) + cell;
  const count = Math.ceil(half / cell) + 1;
  const node = (i, j, k) => [c[0] + i * cell, c[1] + j * cell, c[2] + k * cell];
  for (let k = -count; k <= count; k++)
    for (let j = -count; j <= count; j++)
      for (let i = -count; i <= count; i++) {
        push(node(i, j, k), node(i + 1, j, k));
        push(node(i, j, k), node(i, j + 1, k));
        push(node(i, j, k), node(i, j, k + 1));
      }
}

function buildBccStruts(bounds, cell, push) {
  const c = bounds.center;
  const half = 0.5 * Math.hypot(...bounds.size) + cell;
  const count = Math.ceil(half / cell) + 1;
  for (let k = -count; k <= count; k++)
    for (let j = -count; j <= count; j++)
      for (let i = -count; i <= count; i++) {
        const base = [c[0] + i * cell, c[1] + j * cell, c[2] + k * cell];
        const ctr = [base[0] + cell / 2, base[1] + cell / 2, base[2] + cell / 2];
        for (let dz = 0; dz <= 1; dz++)
          for (let dy = 0; dy <= 1; dy++)
            for (let dx = 0; dx <= 1; dx++)
              push([base[0] + dx * cell, base[1] + dy * cell, base[2] + dz * cell], ctr);
      }
}

function buildFccStruts(bounds, cell, push) {
  const c = bounds.center;
  const half = 0.5 * Math.hypot(...bounds.size) + cell;
  const count = Math.ceil(half / cell) + 1;
  const node = (i, j, k) => [c[0] + i * cell, c[1] + j * cell, c[2] + k * cell];
  for (let k = -count; k <= count; k++)
    for (let j = -count; j <= count; j++)
      for (let i = -count; i <= count; i++) {
        let ctr = [c[0] + (i + 0.5) * cell, c[1] + (j + 0.5) * cell, c[2] + k * cell];
        push(node(i, j, k), ctr); push(node(i + 1, j, k), ctr);
        push(node(i, j + 1, k), ctr); push(node(i + 1, j + 1, k), ctr);
        ctr = [c[0] + (i + 0.5) * cell, c[1] + j * cell, c[2] + (k + 0.5) * cell];
        push(node(i, j, k), ctr); push(node(i + 1, j, k), ctr);
        push(node(i, j, k + 1), ctr); push(node(i + 1, j, k + 1), ctr);
        ctr = [c[0] + i * cell, c[1] + (j + 0.5) * cell, c[2] + (k + 0.5) * cell];
        push(node(i, j, k), ctr); push(node(i, j + 1, k), ctr);
        push(node(i, j, k + 1), ctr); push(node(i, j + 1, k + 1), ctr);
      }
}

/* ---------- Kelvin cell (truncated octahedron tiling) ----------

   The closest space-filling polyhedron to an open-cell foam. We tile
   truncated octahedra on a BCC arrangement (corner grid + body-centre
   grid): with the cage scaled to cell/4, the square faces meet axis
   neighbours and the hexagonal faces meet body-centre neighbours, so
   the cages tile exactly. We emit the shared edge network, deduped.   */

// 24 vertices = all (x,y,z) whose magnitudes are a permutation of {0,1,2}.
const TO_VERTS = (() => {
  const v = [];
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
    const a = [Math.abs(x), Math.abs(y), Math.abs(z)].sort();
    if (a[0] === 0 && a[1] === 1 && a[2] === 2) v.push([x, y, z]);
  }
  return v;
})();
// 36 edges = vertex pairs at squared distance 2 (the polyhedron edge length).
const TO_EDGES = (() => {
  const e = [];
  for (let i = 0; i < TO_VERTS.length; i++)
    for (let j = i + 1; j < TO_VERTS.length; j++) {
      const a = TO_VERTS[i], b = TO_VERTS[j];
      if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 === 2) e.push([i, j]);
    }
  return e;
})();

function buildKelvinStruts(bounds, cell, push) {
  const c = bounds.center;
  const s = cell / 4; // cage scale so square/hex faces meet neighbours
  const half = 0.5 * Math.hypot(...bounds.size) + cell;
  const count = Math.ceil(half / cell) + 1;
  const seen = new Set();
  const key = (p, q) => {
    // dedupe shared edges by rounded midpoint + direction
    const mx = Math.round((p[0] + q[0]) * 5), my = Math.round((p[1] + q[1]) * 5), mz = Math.round((p[2] + q[2]) * 5);
    return mx + "_" + my + "_" + mz;
  };
  const cage = (cx, cy, cz) => {
    for (const [vi, vj] of TO_EDGES) {
      const A = [cx + TO_VERTS[vi][0] * s, cy + TO_VERTS[vi][1] * s, cz + TO_VERTS[vi][2] * s];
      const B = [cx + TO_VERTS[vj][0] * s, cy + TO_VERTS[vj][1] * s, cz + TO_VERTS[vj][2] * s];
      const k = key(A, B);
      if (seen.has(k)) continue;
      seen.add(k);
      push(A, B);
    }
  };
  for (let k = -count; k <= count; k++)
    for (let j = -count; j <= count; j++)
      for (let i = -count; i <= count; i++) {
        cage(c[0] + i * cell, c[1] + j * cell, c[2] + k * cell);                       // corner grid
        cage(c[0] + (i + 0.5) * cell, c[1] + (j + 0.5) * cell, c[2] + (k + 0.5) * cell); // body centre
      }
}

/* ---------- solid raster layers (top / bottom caps) ---------- */

function addSolidLayer(z, bounds, sampler, lineWidth, alongX, area, out) {
  const [minx, miny] = bounds.min;
  const [maxx, maxy] = bounds.max;
  const span = alongX ? maxy - miny : maxx - minx;
  const lines = Math.ceil(span / lineWidth);
  const step = 0.8;
  for (let li = 0; li <= lines; li++) {
    const fixed = (alongX ? miny : minx) + li * lineWidth;
    const a0 = alongX ? minx : miny;
    const a1 = alongX ? maxx : maxy;
    const total = a1 - a0;
    const n = Math.max(2, Math.ceil(total / step));
    let runStart = -1;
    const at = (i) => {
      const v = a0 + (total * i) / n;
      return alongX ? [v, fixed, z] : [fixed, v, z];
    };
    for (let i = 0; i <= n; i++) {
      const p = at(i);
      if (sampler.isInside(p[0], p[1], p[2])) {
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        if (i - 1 > runStart) out.push(makeSeg(at(runStart), at(i - 1), "solid", "solid", area));
        runStart = -1;
      }
    }
    if (runStart >= 0 && n > runStart) out.push(makeSeg(at(runStart), at(n), "solid", "solid", area));
  }
}

/* ---------- gyroid contour struts ---------- */

function addGyroidStruts(gyroidPositions, bounds, params, out) {
  // Finite-guard: a blank Print Settings field yields NaN (parseFloat), which
  // would otherwise zero the layer loop (empty infill) or write NaN extrusion.
  const fin = (v, d) => (Number.isFinite(v) ? v : d);
  const layerHeight = fin(params.layerHeight, 0.2), lineWidth = fin(params.lineWidth, 0.45);
  // The sheet wall is printed as a single bead; its width is the gyroid wall
  // thickness (default to line width). A thickness gradient thickens the base
  // and thins the top (stiffer base / softer surface).
  const wall = Math.max(lineWidth, fin(params.gyroidWall, lineWidth));
  const grad = Math.max(0, Math.min(1, fin(params.gyroidGrad, 0)));
  const z0 = bounds.min[2] + layerHeight / 2;
  const z1 = bounds.max[2];
  const span = Math.max(1e-6, z1 - z0);
  const maxLayers = 600;
  const nLayers = Math.min(maxLayers, Math.max(1, Math.floor((z1 - z0) / layerHeight)));
  const dz = (z1 - z0) / Math.max(1, nLayers);
  for (let l = 0; l <= nLayers; l++) {
    const z = z0 + l * dz;
    // bead width: thicker at the bottom, thinner at the top, scaled by grad.
    const w = wall * (1 + grad * (1 - 2 * (z - z0) / span));
    const area = Math.max(lineWidth, w) * layerHeight;
    let segs;
    try { segs = sliceAtZ(gyroidPositions, z); } catch { continue; }
    for (const s of segs) {
      out.push(makeSeg([s.a[0], s.a[1], z], [s.b[0], s.b[1], z], "gyroid", "gyroid", area));
    }
  }
}

/* ---------- skeletal gyroid (strut network of the channel medial axis) ----------

   The medial axis of a gyroid channel is the srs (Laves) net. We extract it
   numerically: sample the gyroid field, take its local maxima inside one
   channel (f > skelCore) as NODES, then connect each node to its nearest
   in-channel neighbours (degree ~3, angular-spread filtered). Robust, phase-
   and gradient-aware, and clips/integrates through the existing strut path.   */

function buildSkeletalGyroidStruts(bounds, sampler, params, paths) {
  const fin = (v, d) => (Number.isFinite(v) ? v : d);
  const period = Math.max(3, fin(params.gyroidPeriod, fin(params.cellSize, 14)));
  const dr = Math.PI / 180;
  const px = fin(params.phaseX, 0) * dr, py = fin(params.phaseY, 0) * dr, pz = fin(params.phaseZ, 0) * dr;
  const iso = fin(params.isoOffset, 0);
  const skelCore = 0.7;                       // field threshold for a channel-centre ridge
  const densGrad = params.densityGradient || "none";
  const lineWidth = fin(params.lineWidth, 0.45), layerHeight = fin(params.layerHeight, 0.2);
  const strutD = Math.max(0.4, fin(params.strutDiameter, 1.2));
  const xsMult = params.crossSection === "triangular" ? 0.7 : params.crossSection === "star" ? 0.55 : 1.0;
  const strutArea = Math.PI * (strutD / 2) ** 2 * xsMult;
  const minArea = lineWidth * layerHeight * 0.5;
  const nodeBall = fin(params.nodeBall, 0);

  const center = bounds.center, maxR = 0.5 * Math.hypot(bounds.size[0], bounds.size[1]) || 1;
  const zmin = bounds.min[2], zspan = Math.max(1e-6, bounds.size[2]);
  // Density gradient warps the local cell period (smaller = stiffer).
  const periodAt = (x, y, z) => {
    if (densGrad === "z") { const t = Math.min(1, Math.max(0, (z - zmin) / zspan)); return period * (0.7 + 0.6 * t); }
    if (densGrad === "radial") { const r = Math.min(1, Math.hypot(x - center[0], y - center[1]) / maxR); return period * (1.3 - 0.6 * r); }
    return period;
  };
  // Field with an explicit k (so a single edge can be tested at a constant
  // frequency instead of the position-varying k, which scrambles the
  // in-channel test on sloped struts in gradient mode).
  const fAtK = (x, y, z, k) => {
    const ax = k * x + px, ay = k * y + py, az = k * z + pz;
    return Math.sin(ax) * Math.cos(ay) + Math.sin(ay) * Math.cos(az) + Math.sin(az) * Math.cos(ax) - iso;
  };
  const f = (x, y, z) => fAtK(x, y, z, (2 * Math.PI) / periodAt(x, y, z));

  // --- sample the field on a grid (capped for responsiveness) ---
  const pad = period * 0.5;
  const spanx = bounds.size[0] + 2 * pad, spany = bounds.size[1] + 2 * pad, spanz = bounds.size[2] + 2 * pad;
  let h = Math.max(0.8, period / 7);
  const MAX = 90;
  if (Math.max(spanx, spany, spanz) / h > MAX) h = Math.max(spanx, spany, spanz) / MAX;
  const ox = bounds.min[0] - pad, oy = bounds.min[1] - pad, oz = bounds.min[2] - pad;
  const nx = Math.max(3, Math.ceil(spanx / h) + 1);
  const ny = Math.max(3, Math.ceil(spany / h) + 1);
  const nz = Math.max(3, Math.ceil(spanz / h) + 1);
  const fval = new Float32Array(nx * ny * nz);
  const idx = (ix, iy, iz) => ix + nx * (iy + ny * iz);
  for (let iz = 0; iz < nz; iz++)
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++)
        fval[idx(ix, iy, iz)] = f(ox + ix * h, oy + iy * h, oz + iz * h);

  // --- nodes = strict 26-neighbour local maxima in the channel, inside the model ---
  const cand = [];
  for (let iz = 1; iz < nz - 1; iz++)
    for (let iy = 1; iy < ny - 1; iy++)
      for (let ix = 1; ix < nx - 1; ix++) {
        const c = fval[idx(ix, iy, iz)];
        if (c <= skelCore) continue;
        let isMax = true;
        for (let dz = -1; dz <= 1 && isMax; dz++)
          for (let dy = -1; dy <= 1 && isMax; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy && !dz) continue;
              if (fval[idx(ix + dx, iy + dy, iz + dz)] >= c) { isMax = false; break; }
            }
        if (!isMax) continue;
        const x = ox + ix * h, y = oy + iy * h, z = oz + iz * h;
        if (!sampler.isInside(x, y, z)) continue;
        cand.push([x, y, z, c]);
      }
  if (cand.length < 2) return; // no usable network

  // --- non-max suppression via spatial hash (keep the strongest in each ~0.45p ball) ---
  cand.sort((a, b) => b[3] - a[3]);
  const cell = 0.5 * period, hash = new Map();
  const hkey = (x, y, z) => Math.floor(x / cell) + "_" + Math.floor(y / cell) + "_" + Math.floor(z / cell);
  const nmsR2 = (0.45 * period) ** 2;
  const nodes = [];
  for (const c of cand) {
    let ok = true;
    const cx = Math.floor(c[0] / cell), cy = Math.floor(c[1] / cell), cz = Math.floor(c[2] / cell);
    for (let dz = -1; dz <= 1 && ok; dz++) for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
      const arr = hash.get((cx + dx) + "_" + (cy + dy) + "_" + (cz + dz)); if (!arr) continue;
      for (const ni of arr) { const n = nodes[ni]; if ((n[0] - c[0]) ** 2 + (n[1] - c[1]) ** 2 + (n[2] - c[2]) ** 2 < nmsR2) { ok = false; break; } }
    }
    if (!ok) continue;
    const ni = nodes.length; nodes.push(c);
    const k = hkey(c[0], c[1], c[2]); let arr = hash.get(k); if (!arr) { arr = []; hash.set(k, arr); } arr.push(ni);
  }

  // --- degree-~3 edges: nearest in-channel neighbours, angular-spread filtered ---
  // Hash cell must cover the full search radius (maxLen) so a node near a cell
  // face still finds partners up to maxLen away in the ±1 window.
  const ncell = 1.05 * period, nhash = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const k = Math.floor(nodes[i][0] / ncell) + "_" + Math.floor(nodes[i][1] / ncell) + "_" + Math.floor(nodes[i][2] / ncell);
    let arr = nhash.get(k); if (!arr) { arr = []; nhash.set(k, arr); } arr.push(i);
  }
  const segInChannel = (a, b) => {
    // Evaluate the channel test at a single fixed frequency (midpoint period)
    // so gradient-mode's position-varying k can't reject a valid sloped strut.
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, mz = (a[2] + b[2]) / 2;
    const kFixed = (2 * Math.PI) / periodAt(mx, my, mz);
    for (const t of [0.25, 0.5, 0.75]) {
      if (fAtK(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, kFixed) < 0.4 * skelCore) return false;
    }
    return true;
  };
  const edgeSet = new Set();
  const degree = new Array(nodes.length).fill(0);
  const taperOpts = { taperProfile: params.strutTaper || "uniform", taperSegs: 7, minArea };
  // numeric field gradient (for ridge-following)
  const eps = Math.max(0.15, period * 0.02);
  const fGrad = (x, y, z) => [
    (f(x + eps, y, z) - f(x - eps, y, z)) / (2 * eps),
    (f(x, y + eps, z) - f(x, y - eps, z)) / (2 * eps),
    (f(x, y, z + eps) - f(x, y, z - eps)) / (2 * eps),
  ];
  // Emit a strut. Interior struts curve to follow the channel RIDGE (gradient
  // ascent perpendicular to the chord) so they read as smooth thin gyroid
  // ligaments rather than faceted chords; boundary struts stay straight+clipped.
  const pushStrut = (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    const dir = [dx / L, dy / L, dz / L];
    const interior = sampler.isDeepInside(a[0], a[1], a[2], lineWidth) &&
                     sampler.isDeepInside(b[0], b[1], b[2], lineWidth);
    if (!interior) {
      const before = paths.length;
      clipStrut(a, b, sampler, 0, "lattice", strutArea, paths, taperOpts);
      for (let q = before; q < paths.length; q++) paths[q].skeletal = true;
      return;
    }
    const K = 6, pts = [];
    const clr = Math.max(lineWidth, strutD / 2);
    for (let s = 0; s <= K; s++) {
      const t = s / K;
      let p = [a[0] + dx * t, a[1] + dy * t, a[2] + dz * t];
      if (s > 0 && s < K) {
        let step = period * 0.06;
        for (let it = 0; it < 2; it++) {
          const g = fGrad(p[0], p[1], p[2]);
          const gd = g[0] * dir[0] + g[1] * dir[1] + g[2] * dir[2];
          const qx = g[0] - gd * dir[0], qy = g[1] - gd * dir[1], qz = g[2] - gd * dir[2];
          const ql = Math.hypot(qx, qy, qz);
          if (ql < 1e-4) break;                        // already on the ridge
          const np = [p[0] + (qx / ql) * step, p[1] + (qy / ql) * step, p[2] + (qz / ql) * step];
          if (!sampler.isDeepInside(np[0], np[1], np[2], clr)) break; // never poke through the wall
          p = np; step *= 0.6;                          // damped — converge, don't overshoot
        }
      }
      pts.push(p);
    }
    paths.push({ pts, kind: "lattice", role: "lattice", area: strutArea, closed: false, skeletal: true });
  };

  const maxLen = 1.05 * period, minLen = 0.35 * period;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const ci = [Math.floor(a[0] / ncell), Math.floor(a[1] / ncell), Math.floor(a[2] / ncell)];
    const cands = [];
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const arr = nhash.get((ci[0] + dx) + "_" + (ci[1] + dy) + "_" + (ci[2] + dz)); if (!arr) continue;
      for (const j of arr) {
        if (j === i) continue;
        const b = nodes[j];
        const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (d >= minLen && d <= maxLen) cands.push([j, d]);
      }
    }
    cands.sort((p, q) => p[1] - q[1]);
    const dirs = [];
    for (const [j, d] of cands) {
      if (degree[i] >= 3) break;
      const key = i < j ? i + "_" + j : j + "_" + i;
      if (edgeSet.has(key)) continue;
      const b = nodes[j];
      const dir = [(b[0] - a[0]) / d, (b[1] - a[1]) / d, (b[2] - a[2]) / d];
      let spread = true;
      for (const e of dirs) if (e[0] * dir[0] + e[1] * dir[1] + e[2] * dir[2] > 0.906) { spread = false; break; } // <25deg
      if (!spread) continue;
      if (!segInChannel(a, b)) continue;
      edgeSet.add(key); dirs.push(dir); degree[i]++; degree[j]++;
      pushStrut([a[0], a[1], a[2]], [b[0], b[1], b[2]]);
    }
  }

  // --- node balls (sphere at junctions) as stacked mini-loops ---
  if (nodeBall >= 1.0) {
    const r = nodeBall / 2, ballArea = lineWidth * layerHeight;
    for (let i = 0; i < nodes.length; i++) {
      if (degree[i] < 2) continue;
      const c = nodes[i];
      if (!sampler.isDeepInside(c[0], c[1], c[2], r * 0.6)) continue;
      const K = Math.max(2, Math.round((2 * r) / layerHeight));
      for (let l = 0; l < K; l++) {
        const dz = -r + (l + 0.5) * ((2 * r) / K);
        const rr = Math.sqrt(Math.max(0, r * r - dz * dz));
        if (rr < lineWidth * 0.5) continue;
        const pts = [];
        for (let s = 0; s < 12; s++) { const ang = (s / 12) * Math.PI * 2; pts.push([c[0] + Math.cos(ang) * rr, c[1] + Math.sin(ang) * rr, c[2] + dz]); }
        paths.push({ pts, kind: "lattice", role: "lattice", area: ballArea, closed: true, skeletal: true, node: true });
      }
    }
  }
}

/* ---------- colour coding for the 3D preview ---------- */

const COL = {
  vertical:   [0.20, 0.83, 0.60], // green   — vertical lattice
  horizontal: [0.96, 0.62, 0.04], // amber   — near-horizontal lattice
  shell:      [0.38, 0.65, 0.98], // blue    — shell ring / wall
  rib:        [0.30, 0.82, 0.92], // cyan    — shell rib / window arc
  solid:      [0.65, 0.55, 0.98], // purple  — solid layer
  gyroid:     [0.18, 0.83, 0.78], // teal    — gyroid contour
};

/**
 * Per-path colour for a given preview colour MODE.
 *   stress  — by strut angle (amber=near-horizontal risk → green=safe)
 *   density — by local material proxy (short strut=dense=green → long=blue)
 *   design  — clean near-white, faint tint per element kind
 */
export function colorForMode(path, mode, params) {
  const horizAngleDeg = params?.horizAngleDeg ?? 30;
  if (mode === "design") {
    if (path.kind === "shell" || path.kind === "wall") return [0.90, 0.93, 0.97];
    if (path.kind === "solid") return [0.80, 0.82, 0.90];
    return [0.84, 0.87, 0.92];
  }
  if (mode === "printRisk") {
    // colour struts by angle from horizontal: red < 30° (stringing risk),
    // yellow 30–60°, green > 60° (safe). Non-strut paths: neutral grey.
    if (path.kind === "lattice") {
      const a = path.pts[0], b = path.pts[path.pts.length - 1];
      const len = dist3(a, b) || 1;
      const ang = (Math.asin(Math.min(1, Math.abs(b[2] - a[2]) / len)) * 180) / Math.PI;
      if (ang < 30) return [0.94, 0.30, 0.28];
      if (ang < 60) return [0.96, 0.80, 0.20];
      return [0.30, 0.82, 0.45];
    }
    return [0.50, 0.55, 0.62];
  }
  if (mode === "density") {
    if (path.kind === "shell" || path.kind === "wall") return COL.shell;
    if (path.kind === "solid") return COL.solid;
    if (path.kind === "gyroid") return COL.gyroid;
    const a = path.pts[0], b = path.pts[path.pts.length - 1];
    const len = dist3(a, b) || 1;
    const t = Math.min(1, len / (params?.cellSize || 10)); // 0 dense .. 1 sparse
    return [0.15 + 0.15 * t, 0.80 - 0.25 * t, 0.45 + 0.45 * t]; // green → blue
  }
  // stress (default)
  switch (path.kind) {
    case "shell":
    case "wall":
      return path.closed ? COL.shell : COL.rib;
    case "solid":  return COL.solid;
    case "gyroid": return COL.gyroid;
    default: {
      const a = path.pts[0], b = path.pts[path.pts.length - 1];
      const len = dist3(a, b) || 1;
      const angle = (Math.asin(Math.min(1, Math.abs(b[2] - a[2]) / len)) * 180) / Math.PI;
      return angle < horizAngleDeg ? COL.horizontal : COL.vertical;
    }
  }
}

/** Re-fill an existing lineColors buffer for a new colour mode (no
 *  geometry rebuild). Buffer length must equal sum(segCount)*6. */
export function recolorBuffer(paths, lineColors, mode, params) {
  let o = 0;
  for (const path of paths) {
    const c = colorForMode(path, mode, params);
    const segs = segCount(path);
    for (let s = 0; s < segs; s++) {
      lineColors[o] = c[0]; lineColors[o + 1] = c[1]; lineColors[o + 2] = c[2];
      lineColors[o + 3] = c[0]; lineColors[o + 4] = c[1]; lineColors[o + 5] = c[2];
      o += 6;
    }
  }
}

/* ---------- main entry point ---------- */

export function generateLattice(params, sampler, bounds) {
  const {
    type, cellSize, strutDiameter, bottomLayers, topLayers,
    rotX, rotY, rotZ, layerHeight, lineWidth, horizAngleDeg, shellStyle,
  } = params;

  const paths = [];
  let gyroidPositions = null;
  let shellMeta = null;

  // Lattice sits flush to the surface for perforated shells (so it
  // shows through and bonds to the wall); inset behind a solid shell.
  const latticeErosion =
    shellStyle === "solid" ? Math.max(0, params.shellPerims) * lineWidth : 0;

  // Merge: thicken struts as they approach the surface so the infill
  // fuses into the shell wall (one integrated structure).
  const mergeIntensity = params.mergeIntensity ?? 0;
  const mergeOpts = mergeIntensity > 0
    ? { transition: lineWidth * 2.5, taperBoost: 0.8 * mergeIntensity, taperSegs: 4 }
    : undefined;

  if (type === "gyroid" && params.gyroidMode === "skeletal") {
    buildSkeletalGyroidStruts(bounds, sampler, params, paths);
  } else if (type === "gyroid") {
    gyroidPositions = generateGyroid(bounds, sampler, params);
    addGyroidStruts(gyroidPositions, bounds, params, paths);
  } else {
    const area = Math.PI * (strutDiameter / 2) ** 2;
    const hasRot = rotX || rotY || rotZ;
    const m = hasRot ? rotationMatrix(rotX, rotY, rotZ) : null;
    const center = bounds.center;
    const push = (a, b) => {
      const ra = hasRot ? applyRot(m, a, center) : a;
      const rb = hasRot ? applyRot(m, b, center) : b;
      clipStrut(ra, rb, sampler, latticeErosion, "lattice", area, paths, mergeOpts);
    };
    if (type === "cubic") buildAxisStruts(bounds, cellSize, push);
    else if (type === "fcc") buildFccStruts(bounds, cellSize, push);
    else if (type === "kelvin") buildKelvinStruts(bounds, cellSize, push);
    else buildBccStruts(bounds, cellSize, push);
  }

  // Solid top/bottom raster caps.
  if (bottomLayers > 0 || topLayers > 0) {
    const solidArea = lineWidth * layerHeight;
    for (let l = 0; l < bottomLayers; l++) {
      const z = bounds.min[2] + (l + 0.5) * layerHeight;
      addSolidLayer(z, bounds, sampler, lineWidth, l % 2 === 0, solidArea, paths);
    }
    for (let l = 0; l < topLayers; l++) {
      const z = bounds.max[2] - (l + 0.5) * layerHeight;
      addSolidLayer(z, bounds, sampler, lineWidth, l % 2 === 0, solidArea, paths);
    }
  }

  // Perforated outer shell (runs AFTER struts so it can read strut
  // surface-hits for the lattice-matched / node patterns + merge weld).
  // Runs for gyroid interiors too (flowing shell for sheet, node shell for
  // skeletal) — only the bare gyroid SHEET with no shell skips it.
  if (shellStyle === "woven") {
    try { shellMeta = generateWovenSurface(sampler.positions, bounds, params, paths); }
    catch (e) { shellMeta = { error: String(e) }; }
  } else if (shellStyle && shellStyle !== "none") {
    try { shellMeta = generateShell(sampler.positions, bounds, params, paths, sampler); }
    catch (e) { shellMeta = { error: String(e) }; }
  }

  // ---- build render buffers + stats (one LineSegment per path segment) ----
  let segTotal = 0;
  for (const p of paths) segTotal += segCount(p);
  const linePositions = new Float32Array(segTotal * 6);
  const lineColors = new Float32Array(segTotal * 6);
  let totalLength = 0;
  let o = 0;
  for (const path of paths) {
    const c = colorForMode(path, params.colorMode || "stress", params);
    for (const [a, b] of segments(path)) {
      linePositions[o] = a[0]; linePositions[o + 1] = a[1]; linePositions[o + 2] = a[2];
      linePositions[o + 3] = b[0]; linePositions[o + 4] = b[1]; linePositions[o + 5] = b[2];
      lineColors[o] = c[0]; lineColors[o + 1] = c[1]; lineColors[o + 2] = c[2];
      lineColors[o + 3] = c[0]; lineColors[o + 4] = c[1]; lineColors[o + 5] = c[2];
      o += 6;
      totalLength += dist3(a, b);
    }
  }

  return {
    paths,
    linePositions,
    lineColors,
    gyroidPositions,
    stats: { pathCount: paths.length, segmentCount: segTotal, totalLength },
    shellMeta,
  };
}
