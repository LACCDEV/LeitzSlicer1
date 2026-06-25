/* ============================================================
   MeshUtils — geometry helpers used by the lattice generator.

   - computeBounds:  axis-aligned bounding box of a triangle soup
   - computeVolume:  signed-tetrahedra volume (for infill % readout)
   - MeshSampler:    fast "is this point inside the mesh?" test used
                     to clip the infinite lattice down to the model.

   The point-in-mesh test casts a ray along +X and counts how many
   triangles it crosses (odd = inside). To avoid testing every
   triangle for every query, triangles are bucketed into a 2-D grid
   over the (Y,Z) plane — the plane perpendicular to the ray — so a
   query only checks the handful of triangles in its own cell.
   ============================================================ */

/** Axis-aligned bounding box of a flat positions array. */
export function computeBounds(positions) {
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  return {
    min: [minx, miny, minz],
    max: [maxx, maxy, maxz],
    size: [maxx - minx, maxy - miny, maxz - minz],
    center: [(minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2],
  };
}

/**
 * Signed volume via the divergence theorem (sum of signed tetra
 * volumes from the origin). Returns absolute mm³. Assumes the mesh
 * is reasonably watertight; good enough for an infill % readout.
 */
export function computeVolume(positions) {
  let vol = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i],     ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    // signed volume of tetrahedron (origin, a, b, c) = (a · (b × c)) / 6
    vol += (ax * (by * cz - bz * cy)
          - ay * (bx * cz - bz * cx)
          + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(vol);
}

export class MeshSampler {
  /**
   * @param {Float32Array} positions flat triangle positions (9 per tri)
   */
  constructor(positions) {
    this.positions = positions;
    this.bounds = computeBounds(positions);
    this._buildGrid();
  }

  _buildGrid() {
    const p = this.positions;
    const triCount = p.length / 9;
    const [, miny, minz] = this.bounds.min;
    const [, maxy, maxz] = this.bounds.max;

    // Aim for ~1-4 triangles per cell on average; clamp grid size.
    const target = Math.max(1, Math.round(Math.sqrt(triCount)));
    const nY = Math.min(256, Math.max(1, target));
    const nZ = Math.min(256, Math.max(1, target));
    const spanY = (maxy - miny) || 1;
    const spanZ = (maxz - minz) || 1;

    this.grid = { nY, nZ, miny, minz, invY: nY / spanY, invZ: nZ / spanZ };
    // Each cell holds an array of triangle indices (0-based triangle number).
    const cells = new Array(nY * nZ);
    for (let i = 0; i < cells.length; i++) cells[i] = [];
    this.grid.cells = cells;

    for (let t = 0; t < triCount; t++) {
      const o = t * 9;
      const y0 = Math.min(p[o + 1], p[o + 4], p[o + 7]);
      const y1 = Math.max(p[o + 1], p[o + 4], p[o + 7]);
      const z0 = Math.min(p[o + 2], p[o + 5], p[o + 8]);
      const z1 = Math.max(p[o + 2], p[o + 5], p[o + 8]);
      const gy0 = this._cellY(y0), gy1 = this._cellY(y1);
      const gz0 = this._cellZ(z0), gz1 = this._cellZ(z1);
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          cells[gz * nY + gy].push(t);
        }
      }
    }
  }

  _cellY(y) {
    const g = this.grid;
    return Math.min(g.nY - 1, Math.max(0, Math.floor((y - g.miny) * g.invY)));
  }
  _cellZ(z) {
    const g = this.grid;
    return Math.min(g.nZ - 1, Math.max(0, Math.floor((z - g.minz) * g.invZ)));
  }

  /**
   * Point-in-mesh test. Casts a ray from p toward +X and counts the
   * triangles crossed strictly to the +X side; odd => inside.
   * @param {number} px @param {number} py @param {number} pz
   */
  isInside(px, py, pz) {
    // Quick reject against the bounding box.
    const b = this.bounds;
    if (px < b.min[0] || px > b.max[0] ||
        py < b.min[1] || py > b.max[1] ||
        pz < b.min[2] || pz > b.max[2]) return false;

    const p = this.positions;
    const cell = this.grid.cells[this._cellZ(pz) * this.grid.nY + this._cellY(py)];
    let crossings = 0;

    for (let k = 0; k < cell.length; k++) {
      const o = cell[k] * 9;
      const ax = p[o],     ay = p[o + 1], az = p[o + 2];
      const bx = p[o + 3], by = p[o + 4], bz = p[o + 5];
      const cx = p[o + 6], cy = p[o + 7], cz = p[o + 8];

      // Is (py,pz) inside the triangle projected onto the Y-Z plane?
      // Barycentric coordinates in the (Y,Z) plane.
      const d1y = by - ay, d1z = bz - az;
      const d2y = cy - ay, d2z = cz - az;
      const denom = d1y * d2z - d2y * d1z;
      if (denom === 0) continue;            // triangle parallel to X ray
      const wy = py - ay, wz = pz - az;
      const u = (wy * d2z - d2y * wz) / denom;
      const v = (d1y * wz - wy * d1z) / denom;
      if (u < 0 || v < 0 || u + v > 1) continue; // outside triangle in Y-Z

      // X coordinate where the ray pierces the triangle plane.
      const xHit = ax + u * (bx - ax) + v * (cx - ax);
      if (xHit > px) crossings++;
    }
    return (crossings & 1) === 1;
  }

  /**
   * "Deep inside" test for wall/erosion: the point must be inside AND
   * at least `margin` mm from the surface, approximated by also
   * requiring the six axis-offset neighbours to be inside.
   */
  isDeepInside(px, py, pz, margin) {
    if (!this.isInside(px, py, pz)) return false;
    if (margin <= 0) return true;
    return (
      this.isInside(px + margin, py, pz) &&
      this.isInside(px - margin, py, pz) &&
      this.isInside(px, py + margin, pz) &&
      this.isInside(px, py - margin, pz) &&
      this.isInside(px, py, pz + margin) &&
      this.isInside(px, py, pz - margin)
    );
  }
}
