/* ============================================================
   Forms — parametric cushion primitives so a wearable pad can be
   made without importing an STL. Each returns a watertight triangle
   soup (flat Float32Array, 9 floats per triangle) centred on the
   origin in XY, spanning z = 0..thickness — ready for MeshSampler.
   ============================================================ */

function quad(out, a, b, c, d) {
  // two triangles a-b-c, a-c-d
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  out.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
}

/** Rounded-edge box (rectangle pad). cornerR rounds the vertical corners. */
export function makeBox(w, d, h, cornerR = 0) {
  const out = [];
  const hw = w / 2, hd = d / 2;
  const r = Math.max(0, Math.min(cornerR, hw - 0.5, hd - 0.5));
  if (r <= 0.5) {
    // simple box
    const c = [
      [-hw, -hd, 0], [hw, -hd, 0], [hw, hd, 0], [-hw, hd, 0],
      [-hw, -hd, h], [hw, -hd, h], [hw, hd, h], [-hw, hd, h],
    ];
    quad(out, c[0], c[3], c[2], c[1]); // bottom
    quad(out, c[4], c[5], c[6], c[7]); // top
    quad(out, c[0], c[1], c[5], c[4]); // front
    quad(out, c[1], c[2], c[6], c[5]); // right
    quad(out, c[2], c[3], c[7], c[6]); // back
    quad(out, c[3], c[0], c[4], c[7]); // left
    return new Float32Array(out);
  }
  // rounded-corner prism: a rounded rectangle extruded
  const seg = 8;
  const pts = []; // CCW outline
  const corners = [[hw - r, hd - r, 0], [-hw + r, hd - r, Math.PI / 2], [-hw + r, -hd + r, Math.PI], [hw - r, -hd + r, 1.5 * Math.PI]];
  for (const [cx, cy, a0] of corners)
    for (let s = 0; s <= seg; s++) { const a = a0 + (s / seg) * (Math.PI / 2); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  const n = pts.length;
  // sides
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    quad(out, [p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], h], [p[0], p[1], h]);
  }
  // caps (triangle fans to centroid)
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    out.push(0, 0, 0, q[0], q[1], 0, p[0], p[1], 0);     // bottom
    out.push(0, 0, h, p[0], p[1], h, q[0], q[1], h);     // top
  }
  return new Float32Array(out);
}

/** Elliptical puck (round disc when rx==ry). */
export function makeCylinder(rx, ry, h, seg = 72) {
  const out = [];
  const ring = [];
  for (let s = 0; s < seg; s++) { const a = (s / seg) * Math.PI * 2; ring.push([rx * Math.cos(a), ry * Math.sin(a)]); }
  for (let i = 0; i < seg; i++) {
    const p = ring[i], q = ring[(i + 1) % seg];
    quad(out, [p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], h], [p[0], p[1], h]); // side
    out.push(0, 0, 0, q[0], q[1], 0, p[0], p[1], 0);   // bottom fan
    out.push(0, 0, h, p[0], p[1], h, q[0], q[1], h);   // top fan
  }
  return new Float32Array(out);
}

/** Build a named cushion form. */
export function makeForm(shape, w, d, h) {
  if (shape === "disc") return makeCylinder(w / 2, w / 2, h);
  if (shape === "oval") return makeCylinder(w / 2, d / 2, h);
  return makeBox(w, d, h, Math.min(w, d) * 0.18); // rectangle with gently rounded corners
}
