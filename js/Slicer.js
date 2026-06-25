/* ============================================================
   Slicer — planar contour extraction.

   Given a triangle soup and a Z height, produce closed polygon
   loops (the cross-section outline). Used for:
     - solid perimeter "walls" around the lattice
     - slicing the gyroid TPMS surface into printable contours

   Pipeline:  sliceAtZ -> stitch -> (optional) offsetInward
   The inward offset is an approximate per-vertex normal offset —
   adequate for the convex-ish parts typical of these models, and
   it degrades gracefully rather than crashing on concavities.
   ============================================================ */

const EPS = 1e-5;

/**
 * Intersect a triangle soup with the plane z = `z`.
 * Returns a flat array of segments: [{a:[x,y], b:[x,y]}, ...].
 */
export function sliceAtZ(positions, z) {
  const segs = [];
  for (let i = 0; i < positions.length; i += 9) {
    const v = [
      [positions[i],     positions[i + 1], positions[i + 2]],
      [positions[i + 3], positions[i + 4], positions[i + 5]],
      [positions[i + 6], positions[i + 7], positions[i + 8]],
    ];
    // Nudge the plane off any vertex that lies exactly on it so we
    // never have to handle the degenerate "edge in plane" case.
    let zz = z;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(v[k][2] - zz) < EPS) zz += EPS * 2;
    }

    const hits = [];
    for (let e = 0; e < 3; e++) {
      const p1 = v[e], p2 = v[(e + 1) % 3];
      const d1 = p1[2] - zz, d2 = p2[2] - zz;
      if (d1 * d2 < 0) {                  // edge crosses the plane
        const t = d1 / (d1 - d2);
        hits.push([
          p1[0] + t * (p2[0] - p1[0]),
          p1[1] + t * (p2[1] - p1[1]),
        ]);
      }
    }
    if (hits.length === 2) segs.push({ a: hits[0], b: hits[1] });
  }
  return segs;
}

/** Hash a point to a string key on a tolerance grid for stitching. */
function key(p) {
  return Math.round(p[0] / EPS) + "_" + Math.round(p[1] / EPS);
}

/**
 * Stitch unordered segments into ordered polylines / closed loops.
 * Returns an array of loops, each loop an array of [x,y] points.
 * Only closed loops (start ≈ end) are returned.
 */
export function stitch(segments) {
  // Build adjacency: point-key -> list of {seg, end}
  const map = new Map();
  const add = (k, ref) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(ref);
  };
  segments.forEach((s, idx) => {
    add(key(s.a), { idx, p: s.a, other: s.b });
    add(key(s.b), { idx, p: s.b, other: s.a });
  });

  const used = new Array(segments.length).fill(false);
  const loops = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const loop = [segments[start].a.slice(), segments[start].b.slice()];
    let curr = segments[start].b;

    // Walk forward, hopping segment-to-segment by shared endpoint.
    for (let guard = 0; guard < segments.length + 2; guard++) {
      const refs = map.get(key(curr)) || [];
      let next = null;
      for (const r of refs) {
        if (!used[r.idx]) { next = r; break; }
      }
      if (!next) break;
      used[next.idx] = true;
      curr = next.other;
      loop.push(curr.slice());
      if (key(curr) === key(loop[0])) break; // closed
    }

    // Keep only loops that actually closed and have area.
    if (loop.length >= 4 && key(loop[0]) === key(loop[loop.length - 1])) {
      loop.pop(); // drop duplicated closing point
      if (Math.abs(signedArea(loop)) > 1e-3) loops.push(loop);
    }
  }
  return loops;
}

/** Signed area of a 2-D polygon (CCW positive). */
export function signedArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Offset a closed loop inward by `dist` mm using per-vertex normals.
 * "Inward" is determined from the loop's winding so it works for both
 * orientations. Returns null if the loop collapses.
 */
export function offsetInward(loop, dist) {
  const n = loop.length;
  if (n < 3) return null;
  const ccw = signedArea(loop) > 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const curr = loop[i];
    const next = loop[(i + 1) % n];

    // Edge directions in and out of the vertex.
    const e1 = norm([curr[0] - prev[0], curr[1] - prev[1]]);
    const e2 = norm([next[0] - curr[0], next[1] - curr[1]]);

    // Inward normal of each edge depends on winding direction.
    const n1 = ccw ? [-e1[1], e1[0]] : [e1[1], -e1[0]];
    const n2 = ccw ? [-e2[1], e2[0]] : [e2[1], -e2[0]];

    // Average the two edge normals (miter approximation).
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const mlen = Math.hypot(mx, my) || 1;
    mx /= mlen; my /= mlen;

    out.push([curr[0] + mx * dist, curr[1] + my * dist]);
  }
  return out;
}

function norm(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/* ============================================================
   Arc-length helpers used by the grid-shell generator. They let
   us address a position around a closed contour by a normalised
   arc coordinate u in [0,1), which is what makes vertical ribs and
   windows line up consistently across layers of varying size.
   ============================================================ */

/** Densify a closed loop so no edge is longer than `maxSeg` mm. */
export function resampleLoop(loop, maxSeg = 0.8) {
  const n = loop.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    out.push(a.slice());
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.floor(d / maxSeg);
    for (let j = 1; j < k; j++) {
      const t = j / k;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Cumulative arc length at each vertex + total perimeter P. */
export function arcParam(loop) {
  const n = loop.length;
  const cum = new Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    cum[i] = s;
    const b = loop[(i + 1) % n];
    s += Math.hypot(b[0] - loop[i][0], b[1] - loop[i][1]);
  }
  return { cum, P: s };
}

/** Interpolate the [x,y] point at normalised arc coordinate u in [0,1). */
export function pointAtArc(loop, cum, P, u) {
  const target = (((u % 1) + 1) % 1) * P;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const c0 = cum[i];
    const c1 = i + 1 < n ? cum[i + 1] : P;
    if (target >= c0 && target <= c1) {
      const segLen = c1 - c0 || 1;
      const t = (target - c0) / segLen;
      const a = loop[i], b = loop[(i + 1) % n];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  return loop[0].slice();
}

/**
 * Extract the contiguous polyline from arc coord uA to uB (uA < uB,
 * both in [0,1]) — the exact endpoints plus every interior vertex.
 * Used to cut a window arc / rib stub out of a ring.
 */
export function extractArc(loop, cum, P, uA, uB) {
  const tA = uA * P, tB = uB * P;
  const pts = [pointAtArc(loop, cum, P, uA)];
  for (let i = 0; i < loop.length; i++) {
    if (cum[i] > tA + 1e-6 && cum[i] < tB - 1e-6) pts.push(loop[i].slice());
  }
  pts.push(pointAtArc(loop, cum, P, uB));
  return pts;
}
