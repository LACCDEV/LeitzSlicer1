/* ============================================================
   ObjExporter — write the print TOOLPATHS as a Wavefront .OBJ of
   filament-bead tubes, so the part can be rendered in KeyShot (or any
   DCC tool) looking like it does after printing.

   Every path (lattice strut, gyroid contour, shell wall, woven strand,
   solid raster, node ball) becomes a round tube swept along its
   polyline. The tube radius comes from the path's extrusion AREA
   (radius = sqrt(area/π)), so strut diameters and bead widths are
   faithful. A parallel-transport frame keeps the tube twist-free.
   ============================================================ */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// rotate v around unit axis k by angle (Rodrigues)
function rot(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/** Per-vertex twist-minimised frames {t,n,b} along a polyline. */
function frames(pts, closed) {
  const n = pts.length;
  const seg = [];
  for (let i = 0; i < n - 1; i++) seg.push(unit(sub(pts[i + 1], pts[i])));
  if (closed) seg.push(unit(sub(pts[0], pts[n - 1])));
  const tan = [];
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? seg[i - 1] : (closed ? seg[seg.length - 1] : seg[0]);
    const b = i < seg.length ? seg[i] : (closed ? seg[0] : seg[seg.length - 1]);
    const t = unit(add(a, b));
    tan.push(len(t) > 1e-6 ? t : (seg[0] || [0, 0, 1]));
  }
  const out = [];
  let prevT = tan[0];
  let nrm = unit(sub(Math.abs(prevT[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], scl(prevT, dot(Math.abs(prevT[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], prevT))));
  for (let i = 0; i < n; i++) {
    const t = tan[i];
    const ax = cross(prevT, t), sinA = len(ax);
    if (sinA > 1e-6) nrm = rot(nrm, scl(ax, 1 / sinA), Math.atan2(sinA, dot(prevT, t)));
    nrm = unit(sub(nrm, scl(t, dot(nrm, t)))); // re-orthogonalise
    out.push({ t, n: nrm, b: cross(t, nrm) });
    prevT = t;
  }
  // Close the frame for loops: transport once more across the closing segment,
  // measure the residual twist (holonomy) vs ring 0, and distribute -a·i/n so
  // the seam quads line up instead of shearing.
  if (closed && n > 2) {
    const t0 = out[0].t;
    const ax = cross(prevT, t0), sinA = len(ax);
    let nClose = out[n - 1].n;
    if (sinA > 1e-6) nClose = rot(nClose, scl(ax, 1 / sinA), Math.atan2(sinA, dot(prevT, t0)));
    nClose = unit(sub(nClose, scl(t0, dot(nClose, t0))));
    const a = Math.atan2(dot(cross(nClose, out[0].n), t0), dot(nClose, out[0].n));
    for (let i = 0; i < n; i++) {
      const fr = out[i];
      let nn = rot(fr.n, fr.t, (-a * i) / n);
      nn = unit(sub(nn, scl(fr.t, dot(nn, fr.t))));
      fr.n = nn; fr.b = cross(fr.t, nn);
    }
  }
  return out;
}

const f3 = (n) => (Math.round(n * 1000) / 1000);

/**
 * @param {Array} paths   the generated path list
 * @param {object} bounds  for centring the export on the origin (z=0)
 * @param {object} opts    { sides=6, minR=0.12 }
 * @returns {{obj:string, verts:number, tris:number, note?:string}}
 */
export function pathsToOBJ(paths, bounds, opts = {}) {
  let sides = Math.max(3, Math.min(16, opts.sides || 6));
  const minR = opts.minR || 0.12;
  const off = bounds
    ? [-bounds.center[0], -bounds.center[1], -bounds.min[2]]
    : [0, 0, 0];

  // Size guard: tube vertex count ≈ Σ(pts) × sides (+ caps). Keep it sane.
  let totalPts = 0;
  for (const p of paths) if (p.pts && p.pts.length >= 2) totalPts += p.pts.length;
  // Guard on the real output size: vertices AND faces are each ≈ totalPts·sides,
  // so a single string would be ~2× that many lines. Reduce detail, then abort
  // (inclusive) before the file/heap gets unmanageable.
  let note;
  if (totalPts * sides > 2_000_000 && sides > 4) { sides = 4; note = "high density — reduced tube sides to 4"; }
  if (totalPts * sides >= 3_000_000) {
    return { sections: null, verts: 0, tris: 0, note: "Too many toolpaths for OBJ — reduce part size / pattern density / interior detail." };
  }

  const V = [];           // vertex lines
  const F = [];           // face lines
  let vb = 0;             // running 0-based vertex count

  const ring = (c, fr, r) => {
    const base = vb;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
      const x = c[0] + fr.n[0] * ca + fr.b[0] * sa + off[0];
      const y = c[1] + fr.n[1] * ca + fr.b[1] * sa + off[1];
      const z = c[2] + fr.n[2] * ca + fr.b[2] * sa + off[2];
      V.push(`v ${f3(x)} ${f3(y)} ${f3(z)}`);
    }
    vb += sides;
    return base;
  };

  for (const path of paths) {
    const pts = path.pts;
    if (!pts || pts.length < 2) continue;
    const r = Math.max(minR, Math.sqrt((path.area || 0.2) / Math.PI));
    const closed = !!path.closed;
    const fr = frames(pts, closed);
    const ringBase = [];
    for (let i = 0; i < pts.length; i++) ringBase.push(ring(pts[i], fr[i], r));
    // connect consecutive rings (quads, 1-indexed)
    const link = (rA, rB) => {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        F.push(`f ${rA + s + 1} ${rA + s2 + 1} ${rB + s2 + 1} ${rB + s + 1}`);
      }
    };
    for (let i = 0; i < ringBase.length - 1; i++) link(ringBase[i], ringBase[i + 1]);
    if (closed) link(ringBase[ringBase.length - 1], ringBase[0]);
    else {
      // flat fan caps; wind oppositely so both face outward (start = -t, end = +t).
      const sRb = ringBase[0], eRb = ringBase[ringBase.length - 1];
      for (let s = 1; s < sides - 1; s++) F.push(`f ${sRb + 1} ${sRb + s + 2} ${sRb + s + 1}`);
      for (let s = 1; s < sides - 1; s++) F.push(`f ${eRb + 1} ${eRb + s + 1} ${eRb + s + 2}`);
    }
  }

  const header =
    "# LEITZ Slicer 1 — printed toolpaths as filament beads\n" +
    "# import into KeyShot to see the part as it prints\n" +
    "o leitz_toolpaths\n";
  // Return section strings (header / verts / faces) — the Blob is built from the
  // array so we never materialise one giant concatenated OBJ string.
  return { sections: [header, V.join("\n") + "\n", F.join("\n") + "\n"], verts: vb, tris: F.length, note };
}
