/* ============================================================
   Printability — a PURE (params + bounds, no geometry) per-pattern
   printability rating for the Surface Studio meter. Cheap enough to
   recompute on every control change, so it stays live and regen-free.
   ============================================================ */

const SPAN_MAX = 8;      // mm — unsupported span flagged for TPE above this
const FEAT_FACTOR = 1.5; // min feature must be >= 1.5 × nozzle
const fin = (v, d) => (Number.isFinite(v) ? v : d);

export const PATTERN_LABEL = {
  rib: "Rib Knit", mesh: "Sine / interlock mesh", hex: "Hex mesh",
  circle: "Circular array", voronoi: "Voronoi organic", auxetic: "Auxetic",
  lattice: "Lattice-matched", gyroid: "Gyroid-matched", node: "Node shell",
  solid: "Solid skin", none: "No skin",
};

/* Pre-vetted aesthetically-pleasing, printable combos for "Surprise me". */
export const SURPRISE_TABLE = [
  { "shell-style": "rib", "rib-width": "0.8", "rib-gap": "1.0", "rib-angle": "0", "min-wall": "0.5" },
  { "shell-style": "rib", "rib-width": "1.4", "rib-gap": "2.6", "rib-angle": "20", "min-wall": "0.8" },
  { "shell-style": "hex", "hole-size": "4", "hole-pitch": "9", "min-wall": "1.2" },
  { "shell-style": "mesh", "mesh-angle": "45", "mesh-strand": "0.9", "mesh-opening": "3.5" },
  { "shell-style": "voronoi", "hole-size": "5", "hole-pitch": "11", "seed-jitter": "0.45" },
  { "shell-style": "auxetic", "aux-cell-w": "7", "aux-cell-h": "10", "aux-reentrant": "0.32", "aux-wall": "1.2" },
];

/**
 * @returns {{score, maxUnsupportedSpanMm, minFeatureMm, recommendedSpeedMmS, supports, warnings}}
 */
export function runPatternPrintability(pattern, p, bounds) {
  const nozzle = fin(p.nozzle, 0.4), lw = fin(p.lineWidth, 0.45), minWall = fin(p.minWall, 1.2);
  let span = 0, feat = lw;
  const warn = [];

  switch (pattern) {
    case "rib":
      span = fin(p.ribGap, 2.0); feat = fin(p.ribWidth, 1.2);
      warn.push("✅ Rib knit: vertical ribs print clean, near-zero stringing");
      break;
    case "mesh":
      span = fin(p.meshOpening, 3.0); feat = fin(p.meshStrand, 0.8);
      warn.push("ℹ Mesh: bonds best with 30% slowdown at strand crossings");
      break;
    case "woven": {
      // unsupported span ≈ warp spacing (perimeter / warp count); estimate the
      // perimeter from the model footprint when bounds are available.
      const perim = bounds ? Math.PI * (bounds.size[0] + bounds.size[1]) / 2 : 0;
      const warpGap = perim > 0 ? perim / Math.max(3, fin(p.warpCount, 24)) : fin(p.weftPitch, 4);
      span = Math.max(fin(p.weftPitch, 4), warpGap);
      feat = fin(p.strandDiameter, 0.8);
      warn.push("ℹ 3D woven: weft rings bridge between warp — 100% fan, slow weft");
      warn.push("✅ Warp strands print vertical and clean");
      break;
    }
    case "auxetic":
      span = fin(p.auxCellH, 8) * (1 - 2 * fin(p.auxReentrant, 0.3)); feat = fin(p.auxWall, 1.2);
      warn.push("✅ Auxetic: steep re-entrant walls, low stringing risk");
      break;
    case "hex": case "circle": case "voronoi": case "lattice":
      span = fin(p.holeSize, 4) * 2; feat = minWall;
      break;
    case "gyroid": case "node":
      span = fin(p.holeSize, 4) * 1.4; feat = Math.max(lw, fin(p.gyroidWall, minWall));
      break;
    default: // solid / none
      span = 0; feat = Math.max(lw, minWall);
  }

  let score = 100;
  if (span > SPAN_MAX) {
    score -= Math.min(55, (span - SPAN_MAX) * 8);
    warn.unshift(`⚠ Unsupported span ${span.toFixed(1)} mm > ${SPAN_MAX} mm — bridge fan 100%, slow down`);
  }
  if (feat < FEAT_FACTOR * nozzle) {
    score -= Math.min(45, (FEAT_FACTOR * nozzle - feat) * 70);
    warn.unshift(`⚠ Feature ${feat.toFixed(2)} mm < ${(FEAT_FACTOR * nozzle).toFixed(2)} mm (1.5× nozzle) — thicken it`);
  }
  if (feat < lw) warn.unshift(`✕ Feature ${feat.toFixed(2)} mm thinner than line width — will not print`);

  const recommendedSpeedMmS = span > 6 ? 12 : pattern === "rib" || pattern === "auxetic" ? 20 : 16;
  const supports = span > SPAN_MAX * 1.6 ? "moderate" : span > SPAN_MAX ? "minimal" : "none";
  return {
    score: Math.max(0, Math.round(score)),
    maxUnsupportedSpanMm: span, minFeatureMm: feat,
    recommendedSpeedMmS, supports, warnings: warn,
  };
}
