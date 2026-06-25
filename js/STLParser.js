/* ============================================================
   STLParser — parse binary and ASCII STL files.

   Returns a flat Float32Array of triangle vertex positions:
     [ ax,ay,az, bx,by,bz, cx,cy,cz,  ax,ay,az, ... ]
   i.e. 9 floats per triangle, ready to drop into a
   THREE.BufferGeometry position attribute.
   ============================================================ */

/**
 * Decide whether an STL buffer is binary or ASCII.
 *
 * The robust trick (used by most slicers): a binary STL is exactly
 *   80-byte header + 4-byte uint32 triangle count + 50 bytes * count.
 * If the file length matches that formula it is binary. ASCII files
 * begin with the token "solid" but so can binary files, so we cannot
 * rely on that alone.
 */
function isBinarySTL(buffer) {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const triangles = view.getUint32(80, true);
  const expected = 84 + triangles * 50;
  if (expected === buffer.byteLength) return true;

  // Fallback heuristic: scan the first chunk for non-ASCII bytes.
  // A real ASCII STL is printable text; binary almost always isn't.
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 512));
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b > 127) return true; // non-ASCII byte => binary
  }
  return false;
}

/** Parse a binary STL into a Float32Array of positions. */
function parseBinary(buffer) {
  const view = new DataView(buffer);
  const triangles = view.getUint32(80, true);
  const positions = new Float32Array(triangles * 9);

  let offset = 84;        // skip 80-byte header + 4-byte count
  let p = 0;
  for (let t = 0; t < triangles; t++) {
    offset += 12;         // skip the 3-float face normal — we recompute normals later
    for (let v = 0; v < 3; v++) {
      positions[p++] = view.getFloat32(offset, true);     // x
      positions[p++] = view.getFloat32(offset + 4, true); // y
      positions[p++] = view.getFloat32(offset + 8, true); // z
      offset += 12;
    }
    offset += 2;          // skip 2-byte attribute byte count
  }
  return positions;
}

/** Parse an ASCII STL into a Float32Array of positions. */
function parseASCII(text) {
  const verts = [];
  // Match every "vertex x y z" line. Supports scientific notation.
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    verts.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  }
  return new Float32Array(verts);
}

/**
 * Main entry point.
 * @param {ArrayBuffer} buffer raw STL file bytes
 * @returns {{ positions: Float32Array, triangleCount: number }}
 */
export function parseSTL(buffer) {
  let positions;
  if (isBinarySTL(buffer)) {
    positions = parseBinary(buffer);
  } else {
    const text = new TextDecoder().decode(buffer);
    positions = parseASCII(text);
  }
  if (positions.length === 0 || positions.length % 9 !== 0) {
    throw new Error("Could not parse STL — no valid triangles found.");
  }
  return { positions, triangleCount: positions.length / 9 };
}
