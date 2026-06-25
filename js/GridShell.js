/* ============================================================
   GridShell — visually-appealing, printable grid-based outer shells.

   APPROACH (chosen for clean prints on ARBITRARY surfaces):
   The model is sliced layer-by-layer (planar — so every deposited
   line is supported by the layer below and prints cleanly). For each
   layer's contour loop we compute a normalised arc coordinate u in
   [0,1) around it, then a per-layer "keep mask" decides which arcs
   of the ring are actually printed:

     • solid   — whole ring every layer (continuous clean skin)
     • rings   — full "ring bands" every `ringPitch`, and in between
                 only narrow vertical RIBS at `ribCount` arc slots,
                 leaving rectangular windows the lattice shows through
     • diamond — two rib families whose slots drift with Z in opposite
                 directions, crossing into a diamond grid
     • hex     — rib slots stagger half a slot on alternating bands
                 (a printable planar "honeycomb"/brick grid)

   Ribs are real on-surface arcs deposited EVERY layer, so they hug
   any surface and never become unsupported steep diagonals (which
   print badly in TPE). Rings span the windows between ribs and are
   flagged `bridge` so the G-code writer can cool + slow them.

   Output: pushes PATH objects (see PathUtils) into `out`.
   Returns { capped, layers } for status reporting.
   ============================================================ */

import { sliceAtZ, stitch, offsetInward, resampleLoop, arcParam, pointAtArc, extractArc } from "./Slicer.js";

const MAX_SHELL_PATHS = 300000; // safety backstop against runaway grids

/** Arc coordinate of the rear-most (max-Y) vertex — a stable anchor
 *  so rib slots line up vertically across layers of varying size. */
function anchorU(loop, cum, P) {
  let bi = 0;
  for (let i = 1; i < loop.length; i++) {
    if (loop[i][1] > loop[bi][1] ||
        (loop[i][1] === loop[bi][1] && loop[i][0] < loop[bi][0])) bi = i;
  }
  return cum[bi] / (P || 1);
}

/** Normalise [a,b] into [0,1], splitting any wrap across the seam. */
function pushInterval(list, a, b) {
  a = ((a % 1) + 1) % 1;
  b = ((b % 1) + 1) % 1;
  if (Math.abs(b - a) < 1e-6) return;
  if (a <= b) list.push([a, b]);
  else { list.push([a, 1]); list.push([0, b]); }
}

/** Sort + merge overlapping arc intervals. */
function mergeIntervals(list) {
  if (!list.length) return list;
  list.sort((x, y) => x[0] - y[0]);
  const m = [list[0].slice()];
  for (let i = 1; i < list.length; i++) {
    const iv = list[i];
    if (iv[0] <= m[m.length - 1][1] + 1e-9) {
      m[m.length - 1][1] = Math.max(m[m.length - 1][1], iv[1]);
    } else m.push(iv.slice());
  }
  return m;
}

/**
 * Which arcs of this ring deposit at height z. Returns 'FULL' (whole
 * ring) or a list of [uA,uB] arc intervals (the ribs).
 */
function keepIntervals(style, z, z0, P, params, uAnchor) {
  // ribCount 0 -> no ribs at all: keep the whole ring (clean closed loop).
  if (Math.round(params.ribCount) <= 0) return "FULL";
  const families = style === "diamond" ? 2 : 1; // diamond emits 2 rib families
  const N = Math.max(1, Math.round(params.ribCount));
  const { ribWidth, ringPitch, ringBand, diagSlope, diagPitch } = params;
  const zRel = z - z0;

  // Full "ring band" layers for ring/hex styles. Clamp the band below the
  // pitch so a window gap always remains (ringBand >= ringPitch would make
  // every layer a full ring and silently erase the grid).
  if (style === "rings" || style === "hex") {
    const band = Math.min(ringBand, ringPitch * 0.9);
    if ((((zRel % ringPitch) + ringPitch) % ringPitch) < band) return "FULL";
  }

  // Rib slot centres in u-space (clamp half-width by total slot count so the
  // 2N diamond families don't merge into solid coverage).
  const half = Math.min((ribWidth / 2) / (P || 1), 0.4 / (N * families));
  const centers = [];
  if (style === "diamond") {
    const drift = (diagSlope / Math.max(0.5, diagPitch)) * zRel;
    for (let j = 0; j < N; j++) {
      centers.push(uAnchor + j / N + drift);   // +slope family
      centers.push(uAnchor + j / N - drift);   // -slope family
    }
  } else if (style === "hex") {
    const band = Math.floor(zRel / ringPitch);
    const phase = (band % 2) * (0.5 / N);       // brick stagger
    for (let j = 0; j < N; j++) centers.push(uAnchor + j / N + phase);
  } else { // rings
    for (let j = 0; j < N; j++) centers.push(uAnchor + j / N);
  }

  const intervals = [];
  for (const c of centers) pushInterval(intervals, c - half, c + half);
  return mergeIntervals(intervals);
}

export function generateGridShell(positions, bounds, params, out) {
  const { shellStyle, layerHeight, lineWidth } = params;
  const perims = Math.max(1, Math.round(params.shellPerims));
  const families = shellStyle === "diamond" ? 2 : 1; // rib families (see keepIntervals)
  const area = lineWidth * layerHeight;

  const z0 = bounds.min[2] + layerHeight / 2;
  const z1 = bounds.max[2];
  const spanZ = Math.max(layerHeight, z1 - z0);

  const rawLayers = Math.max(1, Math.floor(spanZ / layerHeight));
  const capped = rawLayers > 1200;
  const nLayers = Math.min(1200, rawLayers);
  const step = spanZ / nLayers;
  // A few fully-closed layers at the very bottom/top to cap the part.
  const capLayers = Math.min(4, Math.max(1, Math.round(0.6 / Math.max(0.05, layerHeight))));

  let produced = 0;

  for (let l = 0; l <= nLayers; l++) {
    if (out.length > MAX_SHELL_PATHS) break;
    const z = z0 + l * step;
    const isCap = l < capLayers || l > nLayers - capLayers;

    let loops;
    try { loops = stitch(sliceAtZ(positions, z)); } catch { continue; }

    for (const loop of loops) {
      const base = resampleLoop(loop, 0.8);
      if (base.length < 3) continue;
      const { cum, P } = arcParam(base);
      if (P < 1) continue;
      const uAnchor = anchorU(base, cum, P);
      // Cross-section too small to carry all the rib slots -> fall back to a
      // ring (account for diamond's doubled family count).
      const forceFull = isCap || P < params.ribCount * families * params.ribWidth * 1.2;

      for (let pIdx = 0; pIdx < perims; pIdx++) {
        let ring, rcum, rP;
        if (pIdx === 0) { ring = base; rcum = cum; rP = P; }
        else {
          const off = offsetInward(base, pIdx * lineWidth);
          if (!off || off.length < 3) continue;
          ring = resampleLoop(off, 0.8);
          const ap = arcParam(ring);
          rcum = ap.cum; rP = ap.P;
          if (rP < 1) continue;
        }
        const role = pIdx === 0 ? "outer" : "inner";

        // Whether this perimeter gets windows cut into it.
        const forced =
          forceFull || shellStyle === "solid" || (pIdx > 0 && !params.shellWindowsAll);
        // Inner rings have their own arc parameterisation (offsetInward is
        // non-uniform), so recompute the rib anchor per ring to keep windows
        // aligned with the outer wall.
        const uA = pIdx === 0 ? uAnchor : anchorU(ring, rcum, rP);
        const intervals = forced ? "FULL" : keepIntervals(shellStyle, z, z0, rP, params, uA);

        if (intervals === "FULL") {
          // One continuous closed ring (single clean seam).
          const bridge = !forced && shellStyle !== "solid"; // grid ring band over windows
          out.push({
            pts: ring.map((pt) => [pt[0], pt[1], z]),
            kind: "shell", role, area, closed: true, bridge,
          });
          produced++;
        } else {
          // Narrow rib stubs / window arcs.
          for (const [uA, uB] of intervals) {
            const arc = extractArc(ring, rcum, rP, uA, uB);
            if (arc.length < 2) continue;
            out.push({
              pts: arc.map((p) => [p[0], p[1], z]),
              kind: "shell", role, area, closed: false, bridge: false,
            });
            produced++;
          }
        }
      }
    }
  }
  return { capped, layers: nLayers, produced };
}
