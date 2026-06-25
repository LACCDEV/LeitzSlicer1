/* ============================================================
   Renderer — Three.js viewport.

   World is Z-up (printer convention). The imported model and its
   lattice live in a `printGroup` that is translated so the part is
   centred on the 360×360 bed and resting on Z=0 — i.e. exactly how
   the G-code will place it. The bed grid is drawn at the world
   origin so the preview matches the print.
   ============================================================ */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const BED = 360;

export class Renderer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0d12);

    // Z-up camera.
    const w = container.clientWidth, h = container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.5, 5000);
    this.camera.up.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.localClippingEnabled = true; // cross-section view
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.target.set(BED / 2, BED / 2, 30);

    this._lights();
    this._bed();

    // Group that holds the model + lattice, offset onto the bed.
    this.printGroup = new THREE.Group();
    this.scene.add(this.printGroup);

    this.mesh = null;
    this.lattice = null;
    this.gyroidMesh = null;
    this.boxHelper = null;
    this.offset = [0, 0, 0];

    // Preview state (view-only — never triggers regeneration).
    this.shellOpacity = 0.18;
    this._meshHidden = false; // explicit "Mesh" toggle state (separate from opacity)
    this.clip = { enabled: false, axis: "x", t: 1 };
    this.clipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
    this._worldBounds = null;

    this.camera.position.set(BED / 2 + 220, BED / 2 - 280, 260);
    this.controls.update();

    this._animate = this._animate.bind(this);
    this._animate();
    window.addEventListener("resize", () => this.resize());
  }

  _lights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(300, -200, 500);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
    fill.position.set(-200, 300, 200);
    this.scene.add(fill);
  }

  _bed() {
    // Grid lying in the XY plane, centred on the bed.
    const grid = new THREE.GridHelper(BED, 36, 0x39424f, 0x222a34);
    grid.rotation.x = Math.PI / 2;          // XZ -> XY
    grid.position.set(BED / 2, BED / 2, 0);
    this.scene.add(grid);

    // Bed outline.
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(BED, BED)),
      new THREE.LineBasicMaterial({ color: 0x0ba23b })
    );
    edge.position.set(BED / 2, BED / 2, 0);
    this.scene.add(edge);

    // Small RGB axes at the bed origin.
    const axes = new THREE.AxesHelper(40);
    this.scene.add(axes);
  }

  /** Load model triangle soup; returns world-space size for the UI. */
  setMesh(positions, bounds) {
    this.clearMesh();
    this.offset = [BED / 2 - bounds.center[0], BED / 2 - bounds.center[1], -bounds.min[2]];
    this.printGroup.position.set(this.offset[0], this.offset[1], this.offset[2]);
    // World-space bounds (printGroup is offset) — needed for the clip plane.
    this._worldBounds = {
      min: [bounds.min[0] + this.offset[0], bounds.min[1] + this.offset[1], bounds.min[2] + this.offset[2]],
      max: [bounds.max[0] + this.offset[0], bounds.max[1] + this.offset[1], bounds.max[2] + this.offset[2]],
    };

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x8aa0b6, metalness: 0.05, roughness: 0.85,
      transparent: true, opacity: this.shellOpacity, side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._applyClipTo(mat);
    this.mesh = new THREE.Mesh(geo, mat);
    this.printGroup.add(this.mesh);

    // Bounding box helper around the part.
    const box = new THREE.Box3().setFromArray(positions);
    this.boxHelper = new THREE.Box3Helper(box, 0x4a5563);
    this.printGroup.add(this.boxHelper);

    this._refreshClip();
    this.frame(bounds);
  }

  /** Replace the lattice line set. */
  setLattice(linePositions, lineColors) {
    this.clearLattice();
    if (!linePositions || linePositions.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(lineColors, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true });
    this._applyClipTo(mat);
    this.lattice = new THREE.LineSegments(geo, mat);
    this.printGroup.add(this.lattice);
  }

  /** Optional gyroid surface mesh overlay. */
  setGyroidMesh(positions) {
    this.clearGyroid();
    if (!positions || positions.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2dd4bf, metalness: 0.1, roughness: 0.6,
      side: THREE.DoubleSide, transparent: true, opacity: 0.92,
    });
    this._applyClipTo(mat);
    this.gyroidMesh = new THREE.Mesh(geo, mat);
    this.printGroup.add(this.gyroidMesh);
  }

  /* ---------- view-only controls (never regenerate geometry) ---------- */

  /** Live opacity of the translucent shell envelope (0-100 %). */
  setShellOpacity(pct) {
    this.shellOpacity = Math.max(0, Math.min(1, pct / 100));
    if (this.mesh) { this.mesh.material.opacity = this.shellOpacity; this._updateMeshVisible(); }
  }

  /** Mesh is shown only when not explicitly toggled off AND opacity > 0. */
  _updateMeshVisible() {
    if (this.mesh) this.mesh.visible = !this._meshHidden && this.shellOpacity > 0.001;
  }

  /** Re-fill the lattice colour buffer in place (no geometry rebuild). */
  applyLatticeColors(lineColors) {
    if (!this.lattice || !lineColors) return;
    const attr = this.lattice.geometry.getAttribute("color");
    if (!attr || attr.array.length !== lineColors.length) return;
    attr.array.set(lineColors);
    attr.needsUpdate = true;
  }

  /** Cross-section clip plane across world bounds. */
  setClip({ enabled, axis, t }) {
    const was = this.clip.enabled;
    if (enabled !== undefined) this.clip.enabled = enabled;
    if (axis !== undefined) this.clip.axis = axis;
    if (t !== undefined) this.clip.t = t;
    const ai = this.clip.axis === "y" ? 1 : this.clip.axis === "z" ? 2 : 0;
    const wb = this._worldBounds;
    const cut = wb ? wb.min[ai] + this.clip.t * (wb.max[ai] - wb.min[ai]) : 0;
    const n = [0, 0, 0]; n[ai] = -1;               // keep the side below the cut
    this.clipPlane.normal.set(n[0], n[1], n[2]);
    this.clipPlane.constant = cut;
    // Recompile materials only when the plane is switched on/off.
    this._refreshClip(was !== this.clip.enabled);
  }

  setAutoRotate(on) {
    this.controls.autoRotate = !!on;
    this.controls.autoRotateSpeed = 1.2;
  }

  _applyClipTo(mat) {
    mat.clippingPlanes = this.clip.enabled ? [this.clipPlane] : [];
  }
  _refreshClip(recompile) {
    const arr = this.clip.enabled ? [this.clipPlane] : [];
    for (const obj of [this.mesh, this.lattice, this.gyroidMesh]) {
      if (!obj) continue;
      obj.material.clippingPlanes = arr;
      if (recompile) obj.material.needsUpdate = true;
    }
  }

  clearMesh() {
    if (this.mesh) { this.printGroup.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
    if (this.boxHelper) { this.printGroup.remove(this.boxHelper); this.boxHelper = null; }
  }
  clearLattice() {
    if (this.lattice) { this.printGroup.remove(this.lattice); this.lattice.geometry.dispose(); this.lattice = null; }
    this.clearGyroid();
  }
  clearGyroid() {
    if (this.gyroidMesh) { this.printGroup.remove(this.gyroidMesh); this.gyroidMesh.geometry.dispose(); this.gyroidMesh = null; }
  }

  setMeshVisible(v) { this._meshHidden = !v; this._updateMeshVisible(); if (this.boxHelper) this.boxHelper.visible = v; }
  setLatticeVisible(v) {
    if (this.lattice) this.lattice.visible = v;
    if (this.gyroidMesh) this.gyroidMesh.visible = v;
  }

  /** Fit the camera to the part. */
  frame(bounds) {
    const cx = BED / 2, cy = BED / 2, cz = bounds.size[2] / 2;
    this.controls.target.set(cx, cy, cz);
    const r = 0.5 * Math.hypot(...bounds.size);
    const dist = Math.max(120, r / Math.tan((this.camera.fov * Math.PI) / 360) * 1.4);
    this.camera.position.set(cx + dist * 0.7, cy - dist * 0.8, cz + dist * 0.7);
    this.controls.update();
  }

  setView(view, bounds) {
    const cx = BED / 2, cy = BED / 2, cz = bounds ? bounds.size[2] / 2 : 30;
    const r = bounds ? 0.5 * Math.hypot(...bounds.size) : 120;
    const d = Math.max(150, r * 2.2);
    this.controls.target.set(cx, cy, cz);
    if (view === "top") this.camera.position.set(cx, cy, cz + d);
    else if (view === "front") this.camera.position.set(cx, cy - d, cz);
    else this.camera.position.set(cx + d * 0.6, cy - d * 0.7, cz + d * 0.6);
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate() {
    requestAnimationFrame(this._animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Force one synchronous frame — keeps the canvas current even when
   *  the rAF loop is throttled (e.g. a backgrounded tab). */
  renderOnce() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
