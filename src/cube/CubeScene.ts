import * as THREE from 'three';
import { RubiksCube, ForceCubieSnapshot } from './RubiksCube';
import { CubeInteraction } from './CubeInteraction';
import { CubeStateData, createSolvedState, MoveType, inverseMove, FaceKey } from './CubeState';

const FORCE_STORAGE_KEY = 'cubemix_force_snapshot';

export class CubeScene {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private cube: RubiksCube;
  private cubeGroup: THREE.Group;
  private interaction: CubeInteraction;
  private animFrameId: number = 0;
  private container: HTMLElement;
  private ro: ResizeObserver | null = null;

  // Force mode (continuous / always-on once a snapshot exists)
  private forceSnapshot: ForceCubieSnapshot[] | null = null;
  private forceModeActive = false; // true whenever a snapshot exists and force is running
  // Tracks which faces were hidden on the previous frame so we only re-apply
  // force to faces that have just become hidden (cheap, no per-frame rebuild).
  private prevHiddenFaces: Set<FaceKey> = new Set();
  private faceNormals: Record<FaceKey, THREE.Vector3> = {
    U: new THREE.Vector3(0, 1, 0),
    D: new THREE.Vector3(0, -1, 0),
    F: new THREE.Vector3(0, 0, 1),
    B: new THREE.Vector3(0, 0, -1),
    L: new THREE.Vector3(-1, 0, 0),
    R: new THREE.Vector3(1, 0, 0),
  };

  onForceActiveChange?: (active: boolean) => void;
  /** Fires for every executed move (drag, button, scramble, solve). */
  onUserMove?: (move: MoveType) => void;

  constructor(container: HTMLElement) {
    this.container = container;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = null;

    // Camera — aspect will be corrected on first resize
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 0, 13.0);

    // Renderer — let CSS control the canvas size (width/height 100% in CSS).
    // We pass 1×1 initially and call onResize() immediately after mount so the
    // camera aspect + renderer drawingBuffer match the CSS-computed size.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    });
    this.renderer.setSize(1, 1, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    // Lighting
    this.setupLights();

    // Cube group (for whole-cube rotation by dragging)
    this.cubeGroup = new THREE.Group();
    this.scene.add(this.cubeGroup);

    // Initial isometric-like tilt
    this.cubeGroup.rotation.x = 0.35;
    this.cubeGroup.rotation.y = 0.65;
    // Offset cube upward slightly to compensate for the x-tilt visual shift
    this.cubeGroup.position.y = 0.35;

    // Create cube
    const initialState = createSolvedState();
    this.cube = new RubiksCube(this.scene, this.cubeGroup, initialState);

    // Interaction
    this.interaction = new CubeInteraction(
      this.cube,
      this.camera,
      this.renderer,
      this.cubeGroup
    );

    // Connect force trigger (kept for backwards-compat; force is now automatic)
    this.interaction.onForceTrigger = () => this.activateForceMode();

    // Connect move listener
    this.cube.setOnMove((move) => this.handleMoveExecuted(move));

    // Restore a previously saved Force snapshot so the force works permanently,
    // without the user having to set it up again on every load.
    this.loadPersistedSnapshot();

    // Resize handler
    window.addEventListener('resize', this.onResize);
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.container);

    // Sync camera + renderer to the CSS-computed canvas size right away
    // (deferred one frame so the browser has finished layout)
    requestAnimationFrame(() => this.onResize());

    // Start render loop
    this.startRenderLoop();
  }

  private setupLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const dir1 = new THREE.DirectionalLight(0xffffff, 1.0);
    dir1.position.set(5, 8, 6);
    this.scene.add(dir1);

    const dir2 = new THREE.DirectionalLight(0x8899ff, 0.3);
    dir2.position.set(-4, -3, -4);
    this.scene.add(dir2);

    const dir3 = new THREE.DirectionalLight(0xffeecc, 0.2);
    dir3.position.set(0, 0, -5);
    this.scene.add(dir3);
  }

  private startRenderLoop() {
    const animate = () => {
      this.animFrameId = requestAnimationFrame(animate);

      // Smoothly interpolate any in-progress drag
      this.cube.tickDragSmoothing();

      // Continuous force: while a snapshot exists, any face that is not visible
      // always shows the force colors. Faces are forced the moment they rotate
      // out of view, so the swap is never seen on screen.
      if (this.forceSnapshot && this.forceModeActive) {
        this.enforceHiddenFaces(false);
      }

      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  private onResize = () => {
    // Read CSS-computed size of the canvas element (set by .canvas-wrap CSS)
    const el = this.renderer.domElement;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w === 0 || h === 0) return;
    // Update the WebGL drawing buffer to match the CSS size (scaled by DPR)
    const dpr = Math.min(window.devicePixelRatio, 2);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.renderer.domElement.width !== bw || this.renderer.domElement.height !== bh) {
      this.renderer.setSize(w, h, false);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  setOnStateChange(fn: (state: CubeStateData) => void) {
    this.cube.setOnStateChange(fn);
  }

  reset() {
    const solved = createSolvedState();
    this.cube.setState(solved);
    this.prevHiddenFaces.clear();
    if (this.forceSnapshot) {
      // Keep the force running after a reset — snapshot stays set.
      this.forceModeActive = true;
      this.enforceHiddenFaces(true);
      this.onForceActiveChange?.(true);
    } else {
      this.forceModeActive = false;
      this.onForceActiveChange?.(false);
    }
  }

  executeMove(move: MoveType) {
    this.cube.executeMove(move);
  }

  resetRotation() {
    this.cubeGroup.rotation.x = 0.35;
    this.cubeGroup.rotation.y = 0.65;
    this.cubeGroup.rotation.z = 0;
  }

  getState(): CubeStateData {
    return this.cube.getState();
  }

  /** Load a full cube state (e.g. a saved preset) and keep force running. */
  setState(state: CubeStateData) {
    this.cube.setState(state);
    this.prevHiddenFaces.clear();
    if (this.forceSnapshot && this.forceModeActive) {
      this.enforceHiddenFaces(true);
    }
  }

  /** Get the sequence of inverse moves that will solve the cube */
  getSolveSequence(): MoveType[] {
    const history = this.cube.getMoveHistory();
    const solution: MoveType[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      solution.push(inverseMove(history[i]));
    }
    return solution;
  }

  /** Execute a move without recording it in the history */
  executeSolveMove(move: MoveType) {
    this.cube.executeMove(move, undefined, true);
  }

  clearHistory() {
    this.cube.clearHistory();
  }

  // ─── Force Mode (continuous, always-on) ──────────────────────

  /** Restore a persisted snapshot from localStorage, if any. */
  private loadPersistedSnapshot() {
    try {
      const raw = localStorage.getItem(FORCE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ForceCubieSnapshot[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        this.forceSnapshot = parsed;
        this.forceModeActive = true;
        this.prevHiddenFaces.clear();
        this.onForceActiveChange?.(true);
      }
    } catch {
      /* ignore malformed data */
    }
  }

  /** Clear force snapshot and stop the force. */
  clearForceSnapshot() {
    this.forceSnapshot = null;
    this.forceModeActive = false;
    this.prevHiddenFaces.clear();
    try {
      localStorage.removeItem(FORCE_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    this.onForceActiveChange?.(false);
  }

  /**
   * Store a complete cube snapshot and immediately start the always-on force.
   * From this point the hidden faces will permanently show these colors —
   * no activation needed, and it survives scrambles and reloads.
   */
  setForceSnapshot() {
    this.forceSnapshot = this.cube.takeForceSnapshot();
    try {
      localStorage.setItem(FORCE_STORAGE_KEY, JSON.stringify(this.forceSnapshot));
    } catch {
      /* ignore quota errors */
    }
    this.forceModeActive = true;
    this.prevHiddenFaces.clear();
    this.enforceHiddenFaces(true);
    this.onForceActiveChange?.(true);
  }

  getForceSnapshot(): ForceCubieSnapshot[] | null {
    return this.forceSnapshot;
  }

  /**
   * Kept for backwards compatibility with the old manual trigger.
   * Force is now automatic, so this simply makes sure it is running.
   */
  activateForceMode() {
    if (!this.forceSnapshot || this.forceModeActive) return;
    this.forceModeActive = true;
    this.prevHiddenFaces.clear();
    this.enforceHiddenFaces(true);
    this.onForceActiveChange?.(true);
  }

  isForceModeActive(): boolean {
    return this.forceModeActive;
  }

  /**
   * Apply the force snapshot to every face that is currently not visible.
   *
   * @param forceAll  When true, re-force ALL currently-hidden faces (used after
   *                  a move, which may have altered a hidden face's stickers).
   *                  When false, only force faces that JUST became hidden this
   *                  frame — cheap, so it can run every render frame.
   */
  private enforceHiddenFaces(forceAll: boolean) {
    if (!this.forceSnapshot) return;
    // Never touch cubies mid-turn (drag, snap-settle or programmatic anim) —
    // wait until the layer has fully settled to avoid resetting quaternions.
    if (this.cube.isBusy()) return;

    const vis = this.computeFaceVisibility();
    const hidden = new Set<FaceKey>();
    for (const [face, isVisible] of Object.entries(vis)) {
      if (!isVisible) hidden.add(face as FaceKey);
    }

    let toForce: FaceKey[];
    if (forceAll) {
      toForce = [...hidden];
    } else {
      toForce = [...hidden].filter((f) => !this.prevHiddenFaces.has(f));
    }

    this.prevHiddenFaces = hidden;

    if (toForce.length === 0) return;

    // Apply one face at a time so a shared edge/corner cubie's quaternion is
    // never reset while it still contributes a sticker to a visible face.
    for (const face of toForce) {
      this.cube.applyForceSnapshot(this.forceSnapshot, [face]);
    }
  }

  private computeFaceVisibility(): Record<FaceKey, boolean> {
    this.camera.updateMatrixWorld(true);
    this.cubeGroup.updateMatrixWorld(true);

    const camForward = new THREE.Vector3(0, 0, -1).transformDirection(this.camera.matrixWorld).normalize();

    const result: Record<FaceKey, boolean> = {} as Record<FaceKey, boolean>;

    for (const [face, localNormal] of Object.entries(this.faceNormals)) {
      const worldNormal = localNormal.clone().transformDirection(this.cubeGroup.matrixWorld).normalize();
      result[face as FaceKey] = worldNormal.dot(camForward) < 0;
    }

    return result;
  }

  private handleMoveExecuted(move: MoveType) {
    // Notify listeners of every executed move (used for the move counter).
    this.onUserMove?.(move);

    // A move can change stickers on faces that are currently hidden (e.g. an R
    // turn alters the back face's right column). Re-force every hidden face so
    // the force is always preserved — even while scrambling / mixing.
    if (this.forceSnapshot && this.forceModeActive) {
      this.enforceHiddenFaces(true);
    }
  }

  destroy() {
    cancelAnimationFrame(this.animFrameId);
    this.interaction.destroy();
    this.ro?.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
