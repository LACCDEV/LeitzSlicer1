/* ============================================================
   PathUtils — the unified "path" print primitive.

   A PATH is the single thing the generator emits and the G-code
   writer consumes:

     path = {
       pts:   [[x,y,z], ...],   // ordered points
       kind:  'lattice' | 'wall' | 'shell' | 'solid' | 'gyroid',
       role:  'outer' | 'inner' | 'lattice' | 'solid' | 'gyroid',
       area:  bead cross-section (mm²),
       closed: bool,            // loop returns to pts[0]
       bridge: bool             // (optional) spans open space -> fan+slow
     }

   A legacy 2-point strut is just an open path with two points.
   Printing a closed loop as ONE path (instead of N separate
   segments) is what gives clean, single-seam walls/shells.
   ============================================================ */

export const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Build an open 2-point segment path. */
export function makeSeg(a, b, kind, role, area) {
  return { pts: [a, b], kind, role, area, closed: false };
}

/** Number of printed segments in a path (loops wrap back to start). */
export function segCount(path) {
  return path.closed ? path.pts.length : path.pts.length - 1;
}

/** Iterate consecutive [A,B] segment pairs (wraps when closed). */
export function* segments(path) {
  const p = path.pts;
  for (let i = 0; i < p.length - 1; i++) yield [p[i], p[i + 1]];
  if (path.closed && p.length > 1) yield [p[p.length - 1], p[0]];
}

export function minZ(path) {
  let m = Infinity;
  for (const p of path.pts) if (p[2] < m) m = p[2];
  return m;
}

/** Total printed length (includes the closing segment for loops). */
export function pathLength(path) {
  let L = 0;
  for (const [a, b] of segments(path)) L += dist3(a, b);
  return L;
}

/** Average of the points (cheap loop anchor for travel ordering). */
export function centroid(path) {
  const p = path.pts;
  let x = 0, y = 0, z = 0;
  for (const q of p) { x += q[0]; y += q[1]; z += q[2]; }
  return [x / p.length, y / p.length, z / p.length];
}

/** Rotate a closed loop's points so it starts at index `idx`. */
export function rotateLoop(pts, idx) {
  if (idx <= 0) return pts;
  return pts.slice(idx).concat(pts.slice(0, idx));
}
