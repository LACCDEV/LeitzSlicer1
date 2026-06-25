/* ============================================================
   ShellGenerator — parametric PERFORATED outer shell.

   Replaces the grid shell with a hole-field model: the surface is
   sliced layer-by-layer (planar, so every bead is supported), and a
   single signed `holeField` decides, at each sampled point around a
   ring, whether material is deposited (wall) or skipped (hole).

   Patterns (field shapes):
     solid    — no holes (clean continuous skin)
     circle   — round holes on a coherent grid
     hex      — hexagonally-packed holes
     voronoi  — organic cells: deposit only near Voronoi edges
     lattice  — holes locked to the inner lattice cells, so struts
                land on the wall web between holes (merged look)

   Shell↔lattice MERGE (gated by mergeIntensity):
     • every point within `weld` of a strut-surface hit is forced to
       WALL, so inner struts always connect to the skin (never float
       into a hole) — the structural merge
     • small node-ball blend loops are emitted at strut hits — the
       visual fillet that makes shell + lattice read as one structure

   Output: pushes PATHs into `out`. A hole-free ring is ONE closed
   loop (single clean seam); a perforated ring becomes open wall arcs.
   ============================================================ */

import { sliceAtZ, stitch, offsetInward, resampleLoop, arcParam } from "./Slicer.js";

const MAX_SHELL_PATHS = 300000;
const MAX_NODE_BALLS = 6000;

/* deterministic 0..1 hash for coherent jitter */
function hash2(i, j) {
  const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
/* shortest wrapped distance between two arc coords on a perimeter P */
function wrapDist(a, b, P) {
  let d = Math.abs(a - b) % P;
  return Math.min(d, P - d);
}
/* 2-D point-to-segment distance (for the auxetic bowtie walls) */
function ptSeg2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - ax) * dx + (pz - az) * dz) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
/* hole-shape distance metric in the unrolled (a, z) plane */
function metric(da, dz, shape) {
  da = Math.abs(da); dz = Math.abs(dz);
  if (shape === "diamond") return da + dz;
  if (shape === "hex") return Math.max(da, da * 0.5 + dz * 0.8660254);
  return Math.hypot(da, dz); // circle
}

/* Collect 3-D points where lattice struts reach the surface (used for
   the merge weld + node balls). A clipped strut endpoint is a surface
   hit if it is inside but not DEEP inside. Bucketed by Z band. */
function collectStrutHits(out, sampler, bandH, margin) {
  const byBand = new Map();
  const seen = new Set();
  const balls = [];
  const add = (p) => {
    if (sampler.isDeepInside(p[0], p[1], p[2], margin)) return; // interior node, not a skin hit
    const key = Math.round(p[2] / bandH);
    let arr = byBand.get(key); if (!arr) { arr = []; byBand.set(key, arr); }
    arr.push(p);
    const dk = Math.round(p[0] / 2) + "_" + Math.round(p[1] / 2) + "_" + key;
    if (!seen.has(dk) && balls.length < MAX_NODE_BALLS) { seen.add(dk); balls.push(p); }
  };
  for (const path of out) {
    if (path.kind !== "lattice") continue;
    add(path.pts[0]); add(path.pts[path.pts.length - 1]);
  }
  return { byBand, balls };
}

/** @returns {{capped,layers,produced,holes,weld}} */
export function generateShell(positions, bounds, params, out, sampler) {
  const pattern = params.shellPattern || params.shellStyle || "voronoi";
  if (pattern === "none") return { capped: false, layers: 0, produced: 0, holes: 0 };

  // Finite-guard: a blank UI field yields NaN, which the `??`/Math.max guards
  // do NOT catch (NaN ?? d === NaN), and NaN would silently drop the shell.
  const fin = (v, d) => (Number.isFinite(v) ? v : d);

  const layerHeight = fin(params.layerHeight, 0.2);
  const lineWidth = fin(params.lineWidth, 0.45);
  const perims = Math.max(1, Math.round(fin(params.shellPerims, 1)));
  const area = lineWidth * layerHeight;
  const holeShape = params.holeShape || "circle";
  const holePitch = Math.max(2, fin(params.holePitch, 8));
  const minWall = Math.max(lineWidth, fin(params.minWall, lineWidth));
  const seedJitter = fin(params.seedJitter, 0.3);
  const mergeIntensity = fin(params.mergeIntensity, 0);

  const z0 = bounds.min[2] + layerHeight / 2;
  const z1 = bounds.max[2];
  const spanZ = Math.max(layerHeight, z1 - z0);
  const rawLayers = Math.max(1, Math.floor(spanZ / layerHeight));
  const capped = rawLayers > 1200;
  const nLayers = Math.min(1200, rawLayers);
  const step = spanZ / nLayers;
  const capLayers = Math.min(4, Math.max(1, Math.round(0.6 / Math.max(0.05, layerHeight))));

  // Reference perimeter (mid-height) -> stable column count for vertical coherence.
  let Pref = 0;
  try {
    const midLoops = stitch(sliceAtZ(positions, (bounds.min[2] + bounds.max[2]) / 2));
    for (const lp of midLoops) { const { P } = arcParam(resampleLoop(lp, 1.2)); if (P > Pref) Pref = P; }
  } catch { /* ignore */ }
  if (Pref < holePitch) Pref = Math.max(holePitch * 3, 1);

  // Pattern uses the lattice cell pitch in "lattice" mode so holes line up.
  const colPitch = pattern === "lattice" ? Math.max(2, fin(params.cellSize, 10)) : holePitch;
  const nCols = Math.max(3, Math.round(Pref / colPitch));
  const colW = Pref / nCols;                                   // a-units (~mm)
  const rowPitch = (pattern === "hex" ? colPitch * 0.8660254 : colPitch);
  const latticePhase = pattern === "lattice" ? 0.5 : 0;        // holes between struts

  // gradient setup
  const cx = bounds.center[0], cy = bounds.center[1];
  const maxR = 0.5 * Math.hypot(bounds.size[0], bounds.size[1]) || 1;
  const scaleC = fin(params.holeScaleCenter, 1), scaleE = fin(params.holeScaleEdge, 1);
  const scaleH = fin(params.holeScaleHeight, 0);
  const rotA = ((fin(params.patternRotation, 0)) / 360) * Pref;
  const baseR = Math.max(0.2, fin(params.holeSize, 4));
  const wallHalf0 = Math.max(lineWidth, minWall) / 2;          // voronoi wall half-width

  // merge weld + node balls + (node shell) strut-exit holes
  const bandH = Math.max(2, params.cellSize || 10);
  const weld = mergeIntensity > 0
    ? Math.max(lineWidth, (params.strutDiameter || 1) * 0.5) * (0.6 + mergeIntensity)
    : 0;
  // Strut-surface hits are needed both for the merge weld AND the node shell.
  const needHits = mergeIntensity > 0 || pattern === "node";
  const hits = needHits ? collectStrutHits(out, sampler, bandH, lineWidth) : null;

  // The node shell punches holes at strut exits — with no strut interior
  // (e.g. sheet gyroid) there are none, and every ring would silently become
  // a solid loop. Bail out with a note rather than emit a fake-solid skin.
  if (pattern === "node" && (!hits || hits.balls.length === 0)) {
    return { capped: false, layers: 0, produced: 0, holes: 0, weld: 0, holePct: 0,
      note: "Node shell needs a skeletal/strut interior — no strut exits found, shell omitted." };
  }

  const nearHit = (x, y, z) => {
    if (!hits || weld <= 0) return false;
    const kb = Math.round(z / bandH);
    for (let k = kb - 1; k <= kb + 1; k++) {
      const arr = hits.byBand.get(k); if (!arr) continue;
      for (let m = 0; m < arr.length; m++) {
        const h = arr[m];
        if ((x - h[0]) ** 2 + (y - h[1]) ** 2 + (z - h[2]) ** 2 < weld * weld) return true;
      }
    }
    return false;
  };

  // Distance to the nearest strut-surface exit (for the NODE shell, which
  // punches a hole at each strut exit).
  const holeDensity = Math.max(0.3, fin(params.holeDensity, 1));
  const nodeHoleR = Math.max(lineWidth, (params.strutDiameter || 1.2) * 0.7) * holeDensity;
  const nearestHitDist = (x, y, z) => {
    if (!hits) return Infinity;
    const kb = Math.round(z / bandH); let best = Infinity;
    for (let k = kb - 1; k <= kb + 1; k++) {
      const arr = hits.byBand.get(k); if (!arr) continue;
      for (let m = 0; m < arr.length; m++) {
        const h = arr[m]; const d2 = (x - h[0]) ** 2 + (y - h[1]) ** 2 + (z - h[2]) ** 2;
        if (d2 < best) best = d2;
      }
    }
    return Math.sqrt(best);
  };

  // Gyroid field for the FLOWING shell (same formula as the interior gyroid,
  // so the surface pattern continues onto the skin).
  const dr = Math.PI / 180;
  const gk = (2 * Math.PI) / Math.max(2, fin(params.gyroidPeriod, fin(params.cellSize, 14)));
  const gpx = fin(params.phaseX, 0) * dr, gpy = fin(params.phaseY, 0) * dr, gpz = fin(params.phaseZ, 0) * dr;
  const giso = fin(params.isoOffset, 0);
  const gyroidF = (x, y, z) => {
    const ax = gk * x + gpx, ay = gk * y + gpy, az = gk * z + gpz;
    return Math.sin(ax) * Math.cos(ay) + Math.sin(ay) * Math.cos(az) + Math.sin(az) * Math.cos(ax) - giso;
  };
  // Dimensionless wall band of the flowing shell (higher density => thinner walls / bigger holes).
  const gyBandHalf = Math.max(0.15, Math.min(0.9, 0.42 / holeDensity));

  // --- textile surface-skin pattern params ---
  // Rib knit (vertical/diagonal ribs); period snapped to Pref for a seamless wrap.
  const ribW = Math.max(lineWidth, fin(params.ribWidth, 1.2));
  const ribGap = Math.max(lineWidth, fin(params.ribGap, 2.0));
  let ribPeriod = ribW + ribGap;
  ribPeriod = Pref / Math.max(1, Math.round(Pref / ribPeriod));
  const ribSlope = Math.tan(Math.max(-85, Math.min(85, fin(params.ribAngle, 0))) * Math.PI / 180);
  // Sine / interlock mesh (two strand families at ±angle). Snap the strand
  // period to the arc wrap (Pref·cos) so there's no seam discontinuity at a=0.
  const meshStrand = Math.max(lineWidth, fin(params.meshStrand, 0.8));
  const meshAng = fin(params.meshAngle, 45) * Math.PI / 180;
  const meshCos = Math.max(1e-6, Math.abs(Math.cos(meshAng)));
  let meshPeriod = meshStrand + Math.max(lineWidth, fin(params.meshOpening, 3));
  meshPeriod = (Pref * meshCos) / Math.max(1, Math.round((Pref * meshCos) / meshPeriod));
  // Auxetic re-entrant honeycomb.
  const auxW = Math.max(2, fin(params.auxCellW, 6));
  const auxColW = Pref / Math.max(3, Math.round(Pref / auxW));
  const auxH = Math.max(2, fin(params.auxCellH, 8));
  const auxRe = Math.max(0, Math.min(0.45, fin(params.auxReentrant, 0.3))) * auxColW;
  const auxWall = Math.max(lineWidth, fin(params.auxWall, 1.2));
  const fold = (t) => { const m = ((t % meshPeriod) + meshPeriod) % meshPeriod; return Math.min(m, meshPeriod - m); };

  // gradient-scaled hole radius at a point
  const effR = (z, radial, perimIdx) => {
    let r = baseR;
    r *= scaleC + (scaleE - scaleC) * radial;                  // centre<->edge
    r *= 1 + scaleH * ((z - z0) / spanZ);                      // height
    r += (params.holeTaper || 0) * perimIdx * lineWidth;       // funnel inner perims
    // guarantee min wall between adjacent holes, but keep a positive floor so a
    // too-large min-wall doesn't silently zero the radius (=> whole part solid).
    return Math.max(lineWidth * 0.5, Math.min(r, (colW - minWall) / 2, (rowPitch - minWall) / 2));
  };

  // signed field: >=0 wall, <0 hole
  const field = (a, z, x, y, radial, perimIdx) => {
    if (pattern === "solid") return 1;
    // NODE shell: hole at each strut-surface exit (wall everywhere else).
    if (pattern === "node") {
      return nearestHitDist(x, y, z) - (nodeHoleR + (params.holeTaper || 0) * perimIdx * lineWidth);
    }
    // FLOWING (gyroid-matched) shell: wall near the gyroid surface band, hole
    // where an interlocking channel pierces the skin — continues the interior.
    if (pattern === "gyroid" || pattern === "wave") {
      return gyBandHalf - Math.abs(gyroidF(x, y, z));
    }
    a = ((a - rotA) % Pref + Pref) % Pref;
    const rowF = (z - z0) / rowPitch;
    const r0 = Math.round(rowF);
    // RIB KNIT — vertical (or diagonal/spiral) ribs; Micro-Rib = fine width+gap.
    if (pattern === "rib") {
      const uu = ((((a - ribSlope * (z - z0)) % ribPeriod) + ribPeriod) % ribPeriod);
      return ribW / 2 - Math.abs(uu - ribPeriod / 2);
    }
    // SINE / INTERLOCK MESH — two strand families at ±angle (woven look).
    if (pattern === "mesh") {
      const t1 = a * Math.cos(meshAng) + (z - z0) * Math.sin(meshAng);
      const t2 = a * Math.cos(-meshAng) + (z - z0) * Math.sin(-meshAng);
      return Math.max(meshStrand / 2 - fold(t1), meshStrand / 2 - fold(t2));
    }
    // AUXETIC — re-entrant (bowtie) honeycomb; negative-Poisson skin.
    if (pattern === "auxetic") {
      const rowH = auxH;
      const ri = Math.round((z - z0) / rowH);
      let best = Infinity;
      const W = auxColW, H = rowH, dd = auxRe;
      const V = [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2 - dd, 0], [W / 2, H / 2], [-W / 2, H / 2], [-W / 2 + dd, 0]];
      for (let dr = -1; dr <= 1; dr++) {
        const rr = ri + dr, cz = z0 + rr * rowH, ph = (rr & 1) ? 0.5 : 0;
        const cf = a / W - ph, c0 = Math.round(cf);
        for (let dc = -1; dc <= 1; dc++) {
          const ca = (c0 + dc + ph) * W;
          let qa = a - ca; qa = (((qa + Pref / 2) % Pref) + Pref) % Pref - Pref / 2; // wrapped
          const qz = z - cz;
          for (let i = 0; i < 6; i++) {
            const p = V[i], q = V[(i + 1) % 6];
            const dseg = ptSeg2D(qa, qz, p[0], p[1], q[0], q[1]);
            if (dseg < best) best = dseg;
          }
        }
      }
      return auxWall / 2 - best;
    }
    if (pattern === "voronoi") {
      // nearest two seed distances around the neighbourhood
      let d1 = Infinity, d2 = Infinity;
      for (let ri = r0 - 1; ri <= r0 + 1; ri++) {
        const rowPhase = (ri & 1) ? 0.5 : 0;
        const cF = a / colW - rowPhase;
        const c0 = Math.round(cF);
        for (let ci = c0 - 1; ci <= c0 + 1; ci++) {
          const col = ((ci % nCols) + nCols) % nCols;
          const ja = (hash2(ri, col) - 0.5) * seedJitter * colW;
          const jz = (hash2(col, ri) - 0.5) * seedJitter * rowPitch;
          const ca = ((col + rowPhase) * colW + ja + Pref) % Pref;
          const cz = z0 + ri * rowPitch + jz;
          const d = Math.hypot(wrapDist(a, ca, Pref), z - cz);
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
      }
      let wh = wallHalf0 - (params.holeTaper || 0) * perimIdx * lineWidth * 0.5;
      wh = Math.max(lineWidth / 2, wh);
      return wh - (d2 - d1) / 2;
    }
    // circle / hex / lattice: holes at grid centres
    const er = effR(z, radial, perimIdx);
    let best = Infinity;
    for (let ri = r0 - 1; ri <= r0 + 1; ri++) {
      const rowPhase = (pattern === "hex" ? ((ri & 1) ? 0.5 : 0) : 0) + latticePhase;
      const cF = a / colW - rowPhase;
      const c0 = Math.round(cF);
      for (let ci = c0 - 1; ci <= c0 + 1; ci++) {
        const col = ((ci % nCols) + nCols) % nCols;
        const ja = (hash2(ri, col) - 0.5) * seedJitter * colW * (pattern === "lattice" ? 0.15 : 1);
        const jz = (hash2(col, ri) - 0.5) * seedJitter * rowPitch * (pattern === "lattice" ? 0.15 : 1);
        const ca = ((col + rowPhase) * colW + ja + Pref) % Pref;
        const cz = z0 + (ri + latticePhase) * rowPitch + jz;
        const d = metric(wrapDist(a, ca, Pref), z - cz, holeShape);
        if (d < best) best = d;
      }
    }
    return best - er;
  };

  let produced = 0, holesCount = 0, truncated = false;
  // For the hole-area % stat: deposited wall length vs full perimeter,
  // measured on the OUTER perimeter only.
  let depOuter = 0, fullOuter = 0;

  // Sample the ring finely enough to resolve the active pattern's finest
  // feature (Nyquist) — a fixed 0.8 mm would alias fine ribs/strands away.
  const featMin = pattern === "rib" ? ribW : pattern === "mesh" ? meshStrand
    : pattern === "auxetic" ? auxWall : Infinity;
  const sampleStep = Math.max(0.15, Math.min(0.8, featMin / 2));
  // The pitch below which a loop is too small to carry this pattern -> solid.
  const patternPitch = pattern === "rib" ? ribPeriod : pattern === "mesh" ? meshPeriod
    : pattern === "auxetic" ? auxColW : pattern === "lattice" ? Math.max(2, fin(params.cellSize, 10)) : holePitch;

  for (let l = 0; l <= nLayers; l++) {
    if (out.length > MAX_SHELL_PATHS) { truncated = true; break; }
    const z = z0 + l * step;
    const isCap = l < capLayers || l > nLayers - capLayers;
    let loops;
    try { loops = stitch(sliceAtZ(positions, z)); } catch { continue; }

    for (const loop of loops) {
      const base = resampleLoop(loop, sampleStep);
      if (base.length < 3) continue;
      const ap0 = arcParam(base);
      if (ap0.P < 1) continue;
      const forceFull = isCap || pattern === "solid" || ap0.P < patternPitch * 1.5;

      for (let pIdx = 0; pIdx < perims; pIdx++) {
        let ring, cum, P;
        if (pIdx === 0) { ring = base; cum = ap0.cum; P = ap0.P; }
        else {
          const off = offsetInward(base, pIdx * lineWidth);
          if (!off || off.length < 3) continue;
          ring = resampleLoop(off, sampleStep);
          const ap = arcParam(ring); cum = ap.cum; P = ap.P;
          if (P < 1) continue;
        }
        const role = pIdx === 0 ? "outer" : "inner";

        if (forceFull) {
          out.push({ pts: ring.map((p) => [p[0], p[1], z]), kind: "shell", role, area, closed: true });
          produced++;
          if (pIdx === 0) { fullOuter += P; depOuter += P; }
          continue;
        }

        // wall/hole flag per ring vertex
        const n = ring.length;
        const wall = new Array(n);
        let anyWall = false, allWall = true;
        for (let i = 0; i < n; i++) {
          const x = ring[i][0], y = ring[i][1];
          const radial = Math.min(1, Math.hypot(x - cx, y - cy) / maxR);
          const a = (cum[i] / P) * Pref;
          let w = field(a, z, x, y, radial, pIdx) >= 0;
          if (!w && weld > 0 && nearHit(x, y, z)) w = true; // merge weld
          wall[i] = w;
          if (w) anyWall = true; else allWall = false;
        }

        if (allWall) {
          out.push({ pts: ring.map((p) => [p[0], p[1], z]), kind: "shell", role, area, closed: true });
          produced++;
          if (pIdx === 0) { fullOuter += P; depOuter += P; }
          continue;
        }
        if (pIdx === 0) fullOuter += P;
        if (!anyWall) continue; // fully open band — lattice carries it

        // close tiny holes (< minWall of arc) so openings stay printable
        closeTinyRuns(wall, ring, false, minWall);
        // emit contiguous wall runs as open arcs
        let start = 0; while (start < n && wall[start]) start++;
        if (start === n) { // became all-wall after closing
          out.push({ pts: ring.map((p) => [p[0], p[1], z]), kind: "shell", role, area, closed: true });
          produced++; if (pIdx === 0) depOuter += P; continue;
        }
        let run = null;
        for (let k = 0; k <= n; k++) {
          const idx = (start + k) % n;
          const last = k === n;
          if (!last && wall[idx]) { if (!run) run = []; run.push(idx); }
          else if (run) {
            if (run.length >= 2) {
              let len = 0;
              for (let q = 1; q < run.length; q++) {
                const A = ring[run[q - 1]], B = ring[run[q]];
                len += Math.hypot(B[0] - A[0], B[1] - A[1]);
              }
              if (len >= lineWidth) {
                out.push({ pts: run.map((ix) => [ring[ix][0], ring[ix][1], z]), kind: "shell", role, area, closed: false });
                produced++; holesCount++;
                if (pIdx === 0) depOuter += len;
              }
            }
            run = null;
          }
        }
      }
    }
  }

  // node-ball blend loops at strut hits (the visual fillet). Snap each to the
  // nearest print layer (strut-hit Z is off-grid) so the loop sits on a real
  // layer instead of floating, and flag weld:true so it never coasts open.
  if (hits && mergeIntensity > 0) {
    const r = Math.max(lineWidth, weld * 0.7);
    for (const h of hits.balls) {
      if (out.length > MAX_SHELL_PATHS) break;
      const lz = z0 + Math.round((h[2] - z0) / step) * step;
      if (lz < z0 - 1e-6 || lz > z1 + 1e-6) continue;
      const pts = [];
      for (let s = 0; s < 8; s++) {
        const ang = (s / 8) * Math.PI * 2;
        pts.push([h[0] + Math.cos(ang) * r, h[1] + Math.sin(ang) * r, lz]);
      }
      out.push({ pts, kind: "shell", role: "inner", area, closed: true, weld: true });
    }
  }

  const holePct = fullOuter > 0
    ? Math.max(0, Math.min(100, 100 * (1 - depOuter / fullOuter))) : 0;
  return {
    capped, truncated, layers: nLayers, produced, holes: holesCount, weld, holePct,
    note: truncated ? "Shell hit the path cap — upper layers omitted. Coarsen the pattern or lower the part." : undefined,
  };
}

/* Set short hole runs (arc length < minWall) back to wall so tiny,
   unprintable openings don't appear. Operates circularly in place. */
function closeTinyRuns(wall, ring, _unused, minWall) {
  const n = wall.length;
  let start = 0; while (start < n && !wall[start]) start++;
  if (start === n) return; // all holes
  let k = 0;
  while (k < n) {
    const idx = (start + k) % n;
    if (!wall[idx]) {
      const runStart = k;
      const indices = [];
      while (k < n && !wall[(start + k) % n]) { indices.push((start + k) % n); k++; }
      let len = 0;
      for (let q = 1; q < indices.length; q++) {
        const A = ring[indices[q - 1]], B = ring[indices[q]];
        len += Math.hypot(B[0] - A[0], B[1] - A[1]);
      }
      if (len < minWall) for (const ix of indices) wall[ix] = true;
    } else k++;
  }
}
