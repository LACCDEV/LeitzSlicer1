/* ============================================================
   WovenSurface — a genuinely 3-D woven textile skin.

   Unlike the planar hole-field shell (which can only deposit/skip in
   the (arc, height) plane), a real weave needs strands that pass OVER
   and UNDER each other. We model that with two strand families that
   oscillate along the surface NORMAL:

     • WARP strands run vertically (one per arc slot), printing clean.
     • WEFT rings run around the perimeter at each pitch, bridging
       between warp crossings.

   At every crossing the two families are anti-phase (cos), with the
   oscillation amplitude ≈ a strand radius, so warp and weft just touch
   and bond — and which one is "outside" alternates by the weave
   pattern (plain / twill / basket) for an authentic interlaced look.

   Strands are emitted as PATHs (kind 'shell', woven flag) and flow
   through the normal ordering / G-code pipeline.
   ============================================================ */

import { sliceAtZ, stitch, resampleLoop, arcParam, pointAtArc } from "./Slicer.js";

const fin = (v, d) => (Number.isFinite(v) ? v : d);
const MAX_SLICES = 900;

export function generateWovenSurface(positions, bounds, params, out) {
  const N = Math.max(3, Math.round(fin(params.warpCount, 24)));
  const weftPitch = Math.max(1, fin(params.weftPitch, 4));
  const strandD = Math.max(0.3, fin(params.strandDiameter, fin(params.meshStrand, 0.8)));
  const amp = Math.max(0.1, fin(params.weaveDepth, strandD * 0.6));
  const layerHeight = fin(params.layerHeight, 0.2);
  const pattern = params.weavePattern || "plain";
  const area = Math.PI * (strandD / 2) ** 2;

  const z0 = bounds.min[2] + layerHeight;
  const z1 = bounds.max[2] - layerHeight;
  if (z1 <= z0) return { woven: true, warp: 0, note: "Part too short for a weave." };

  // Keep dz = weftPitchUsed / subdivUsed so weft levels always land on slices
  // (frac=0 there) and warp/weft stay anti-phase even after capping a tall part.
  const subdiv = 6;
  let weftPitchUsed = weftPitch, subdivUsed = subdiv;
  let dz = weftPitchUsed / subdivUsed;
  let nSteps = Math.ceil((z1 - z0) / dz);
  if (nSteps > MAX_SLICES) {
    subdivUsed = Math.max(1, Math.floor(MAX_SLICES / ((z1 - z0) / weftPitchUsed)));
    dz = weftPitchUsed / subdivUsed; nSteps = Math.ceil((z1 - z0) / dz);
    if (nSteps > MAX_SLICES) { weftPitchUsed = ((z1 - z0) / MAX_SLICES) * subdivUsed; dz = weftPitchUsed / subdivUsed; nSteps = Math.ceil((z1 - z0) / dz); }
  }

  // weave sign: which family is "outside" at crossing (j, k).
  const sgn = (j, k) => {
    if (pattern === "twill") return (((((j + k) % 3) + 3) % 3) === 0) ? -1 : 1;
    if (pattern === "basket") return ((((j >> 1) + (k >> 1)) & 1)) ? 1 : -1;
    return (((j + k) & 1)) ? 1 : -1; // plain
  };
  // Smooth C0 interpolation between adjacent crossing extremes (works for ALL
  // patterns + odd warp counts, unlike a raw sgn·cos which kinks/snaps).
  const smooth = (frac) => 0.5 * (1 - Math.cos(Math.PI * frac));

  // Pre-slice the model into resampled contour rings with centroids.
  const slices = [];
  for (let s = 0; s <= nSteps; s++) {
    const z = z0 + s * dz;
    let loops; try { loops = stitch(sliceAtZ(positions, z)); } catch { slices.push(null); continue; }
    let best = null, bestP = 0;
    for (const lp of loops) {
      const r = resampleLoop(lp, 0.8); const ap = arcParam(r);
      if (ap.P > bestP) { bestP = ap.P; best = { r, cum: ap.cum, P: ap.P }; }
    }
    if (!best || best.P < 1) { slices.push(null); continue; }
    let cx = 0, cy = 0; for (const p of best.r) { cx += p[0]; cy += p[1]; }
    best.cx = cx / best.r.length; best.cy = cy / best.r.length; best.z = z;
    slices.push(best);
  }

  // radial unit (outward) at a contour point, plus the woven offset.
  const place = (sl, px, py, off) => {
    let nx = px - sl.cx, ny = py - sl.cy; const nl = Math.hypot(nx, ny) || 1;
    return [px + (nx / nl) * off, py + (ny / nl) * off, sl.z];
  };

  let produced = 0;
  const flushWarp = (pts) => { if (pts.length >= 2) { out.push({ pts, kind: "shell", role: "outer", area, closed: false, woven: true }); produced++; } };

  // ---- WARP strands (vertical), split at any contour-less (null) slice ----
  for (let j = 0; j < N; j++) {
    const u = j / N;
    let pts = [];
    for (const sl of slices) {
      if (!sl) { flushWarp(pts); pts = []; continue; } // don't bridge across gaps
      const zr = (sl.z - z0) / weftPitchUsed, k = Math.floor(zr), frac = zr - k;
      const p = pointAtArc(sl.r, sl.cum, sl.P, u);
      // interpolate between this crossing's extreme (+amp·sgn(j,k)) and the next
      const off = amp * (sgn(j, k) * (1 - smooth(frac)) + sgn(j, k + 1) * smooth(frac));
      pts.push(place(sl, p[0], p[1], off));
    }
    flushWarp(pts);
  }

  // ---- WEFT rings (around the perimeter, every pitch) ----
  for (let s = 0; s < slices.length; s += subdivUsed) {
    const sl = slices[s]; if (!sl) continue;
    const k = Math.round((sl.z - z0) / weftPitchUsed);
    const pts = [];
    for (let i = 0; i < sl.r.length; i++) {
      const u = sl.cum[i] / sl.P, jf = u * N, jSlot = Math.floor(jf), fracU = jf - jSlot;
      // anti-phase with warp; slot indices mod N so the closed ring joins cleanly.
      const sA = sgn(((jSlot % N) + N) % N, k), sB = sgn(((jSlot + 1) % N + N) % N, k);
      const off = -amp * (sA * (1 - smooth(fracU)) + sB * smooth(fracU));
      pts.push(place(sl, sl.r[i][0], sl.r[i][1], off));
    }
    if (pts.length >= 3) { out.push({ pts, kind: "shell", role: "outer", area, closed: true, woven: true, bridge: true }); produced++; }
  }

  return { woven: true, warp: N, produced };
}
