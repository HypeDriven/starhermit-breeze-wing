/**
 * Breeze Wing — render module.
 * Three.js presentation of immutable rules snapshots + interpolation alpha.
 * Original procedural geometry only: floating islands, soft clouds, storybook
 * sky. Quality tiers change fidelity, never rules or hazard visibility.
 *
 * Layers: 0 environment, 1 gameplay, 2 selection/ghost, 3 effects.
 * Cosmetic objects are non-interactive; picking stays on the DOM layer.
 */

import * as THREE from '../vendor/three.module.js';
import { WORLD, gateGapY, currentGapHalf, currentSpeed, SIM_DT, createRng } from './rules.js';
import { THEMES } from './content.js';

export const QUALITY_TIERS = {
  low:    { pixelRatioCap: 1,    shadows: false, clouds: 6,  islands: 6,  particles: 120,  renderScale: 0.85 },
  medium: { pixelRatioCap: 1.75, shadows: true,  clouds: 10, islands: 10, particles: 400,  renderScale: 1 },
  high:   { pixelRatioCap: 2,    shadows: true,  clouds: 16, islands: 14, particles: 900,  renderScale: 1 },
};

/** Framing constants (exposed, not magic offsets). */
export const FRAMING = {
  fov: 38,
  cameraZ: 17.5,
  cameraX: 3.2,
  lookAheadX: 1.4,
  followStiffness: 6.5,   // critically-damped-ish spring rate for camera Y
  shakeMax: 0.22,
};

const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_GHOST = 2, LAYER_FX = 3;

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.tier = opts.tier || 'medium';
    this.reducedMotion = opts.reducedMotion === true;
    this.palette = opts.palette || 'default';
    this.contextLost = false;
    this._disposed = false;
    this._time = 0;
    this._shake = 0;
    this._camY = 0;
    this._theme = THEMES.day;
    this._buildRenderer();
    this._buildScene();
    this._buildPools();
    this._lastW = 0; this._lastH = 0;
  }

  /* ----------------------------- setup ------------------------------ */

  _buildRenderer() {
    const q = QUALITY_TIERS[this.tier] || QUALITY_TIERS.medium;
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: this.tier !== 'low',
        powerPreference: 'high-performance',
      });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.contextLost = true;
      });
      this.canvas.addEventListener('webglcontextrestored', () => {
        this.contextLost = false;
        this._rebuildGpuResources();
      });
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioCap) * q.renderScale);
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  _buildScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 220);
    this.camera.position.set(FRAMING.cameraX, 0, FRAMING.cameraZ);
    this.camera.layers.enable(LAYER_GAME);
    this.camera.layers.enable(LAYER_GHOST);
    this.camera.layers.enable(LAYER_FX);

    // Lights: one dominant key, soft environment fill.
    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    this.keyLight.position.set(6, 12, 8);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.left = -20; this.keyLight.shadow.camera.right = 20;
    this.keyLight.shadow.camera.top = 20; this.keyLight.shadow.camera.bottom = -20;
    this.scene.add(this.keyLight);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x8a7a68, 0.9);
    this.scene.add(this.hemi);

    // Sky dome + fog (aerial perspective without flattening gameplay).
    this.skyGeo = new THREE.SphereGeometry(160, 24, 16);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x4f9fe0) },
        bottomColor: { value: new THREE.Color(0xeaf7ff) },
      },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 topColor; uniform vec3 bottomColor; varying vec3 vPos;
        void main(){ float h = normalize(vPos).y*0.5+0.5; gl_FragColor = vec4(mix(bottomColor, topColor, smoothstep(0.15,0.85,h)), 1.0); }`,
    });
    this.sky = new THREE.Mesh(this.skyGeo, this.skyMat);
    this.sky.layers.set(LAYER_ENV);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(0xd8f0ff, 40, 140);

    // Sun disc (decorative).
    this.sun = new THREE.Mesh(
      new THREE.CircleGeometry(6, 32),
      new THREE.MeshBasicMaterial({ color: 0xfff6d8, fog: false, transparent: true, opacity: 0.9 })
    );
    this.sun.position.set(-30, 26, -120);
    this.sun.layers.set(LAYER_ENV);
    this.scene.add(this.sun);

    // Groups.
    this.envGroup = new THREE.Group();   // islands + clouds
    this.gateGroup = new THREE.Group();  // gameplay gates
    this.birdGroup = new THREE.Group();
    this.ghostGroup = new THREE.Group(); // arc preview
    this.fxGroup = new THREE.Group();
    this.envGroup.layers.set(LAYER_ENV);
    this.scene.add(this.envGroup, this.gateGroup, this.birdGroup, this.ghostGroup, this.fxGroup);

    this._buildBird();
    this._buildGhostArc();
    this._gateMeshes = new Map(); // gate index -> group
  }

  /* ------------------------- procedural bird ------------------------ */

  _buildBird() {
    const t = this._theme;
    this.birdMat = new THREE.MeshStandardMaterial({ color: t.bird, roughness: 0.6, metalness: 0.05 });
    this.wingMat = new THREE.MeshStandardMaterial({ color: t.wing, roughness: 0.55, metalness: 0.05 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 18), this.birdMat);
    body.scale.set(1.15, 0.95, 0.9);
    body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 14), this.birdMat);
    head.position.set(0.38, 0.24, 0);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 10), new THREE.MeshStandardMaterial({ color: 0xff9d3c, roughness: 0.5 }));
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(0.72, 0.22, 0);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x222831 });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), eyeMat);
    eyeL.position.set(0.52, 0.34, 0.2);
    const eyeR = eyeL.clone(); eyeR.position.z = -0.2;
    // Wing: flattened tapered box, pivot at shoulder.
    this.wingL = new THREE.Group();
    const wingGeo = new THREE.SphereGeometry(0.5, 14, 10);
    wingGeo.scale(0.6, 0.18, 1.05);
    const wl = new THREE.Mesh(wingGeo, this.wingMat);
    wl.position.set(-0.12, 0, 0.55);
    wl.castShadow = true;
    this.wingL.add(wl);
    this.wingL.position.set(-0.05, 0.12, 0.1);
    this.wingR = this.wingL.clone();
    this.wingR.scale.z = -1;
    this.birdGroup.add(body, head, beak, eyeL, eyeR, this.wingL, this.wingR);
    this.birdGroup.traverse((o) => o.layers.set(LAYER_GAME));
    this._flapPhase = 0;
    this._flapKick = 0;
  }

  /* ------------------------ ghost arc preview ----------------------- */

  _buildGhostArc() {
    const dotGeo = new THREE.SphereGeometry(0.07, 8, 6);
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false });
    this.ghostDots = [];
    for (let i = 0; i < 12; i++) {
      // Each dot needs its own material: the fade gradient below sets opacity
      // per dot, which is impossible while all dots share one instance.
      const d = new THREE.Mesh(dotGeo, this.ghostMat.clone());
      d.layers.set(LAYER_GHOST);
      this.ghostGroup.add(d);
      this.ghostDots.push(d);
    }
  }

  /** Predict the arc from the current snapshot (cosmetic, rules-derived). */
  _updateGhostArc(state) {
    const show = state.phase !== 'terminal' && !this.reducedMotion;
    const p = state.config.params;
    let y = state.bird.y, vy = state.phase === 'ready' ? p.lift : state.bird.vy + p.lift;
    for (let i = 0; i < this.ghostDots.length; i++) {
      const d = this.ghostDots[i];
      if (!show || !this.assistArc) { d.visible = false; continue; }
      d.visible = true;
      d.position.set(WORLD.birdX + 0.02 * i, y, 0);
      d.material.opacity = 0.45 * (1 - i / this.ghostDots.length);
      for (let k = 0; k < 4; k++) { vy -= p.gravity * SIM_DT; y += vy * SIM_DT; }
    }
  }

  /* --------------------- gates (semantic meshes) -------------------- */

  _gateMaterial(kind) {
    const t = this._theme;
    if (kind === 'trim') return new THREE.MeshStandardMaterial({ color: t.gateTrim, roughness: 0.4, emissive: t.gateTrim, emissiveIntensity: 0.25 });
    return new THREE.MeshStandardMaterial({ color: t.gate, roughness: 0.7, metalness: 0.05 });
  }

  _makeGateMesh() {
    const g = new THREE.Group();
    const pillarGeo = new THREE.CylinderGeometry(0.55, 0.7, 1, 10);
    const trimGeo = new THREE.CylinderGeometry(0.68, 0.68, 0.35, 10);
    const top = new THREE.Mesh(pillarGeo, this._gateMaterial('body'));
    const bot = new THREE.Mesh(pillarGeo, this._gateMaterial('body'));
    const topTrim = new THREE.Mesh(trimGeo, this._gateMaterial('trim'));
    const botTrim = new THREE.Mesh(trimGeo, this._gateMaterial('trim'));
    top.castShadow = bot.castShadow = true;
    g.add(top, bot, topTrim, botTrim);
    g.traverse((o) => o.layers.set(LAYER_GAME));
    g.userData = { top, bot, topTrim, botTrim };
    this.gateGroup.add(g);
    return g;
  }

  _layoutGate(mesh, x, gapY, gapHalf) {
    const u = mesh.userData;
    const ceil = WORLD.ceilY + 6, floor = WORLD.floorY - 6;
    const topH = ceil - (gapY + gapHalf);
    const botH = (gapY - gapHalf) - floor;
    u.top.scale.y = topH; u.top.position.set(x, gapY + gapHalf + topH / 2, 0);
    u.bot.scale.y = botH; u.bot.position.set(x, gapY - gapHalf - botH / 2, 0);
    u.topTrim.position.set(x, gapY + gapHalf + 0.1, 0);
    u.botTrim.position.set(x, gapY - gapHalf - 0.1, 0);
  }

  /* ------------------- environment: islands + clouds ---------------- */

  _buildEnvironment(seed) {
    // Dispose previous.
    for (const c of [...this.envGroup.children]) this._disposeObject(c);
    this.envGroup.clear();
    const q = QUALITY_TIERS[this.tier] || QUALITY_TIERS.medium;
    const rng = createRng((seed ^ 0xdec0) >>> 0); // decoration stream: cosmetic only
    const t = this._theme;
    this._islands = [];
    this._clouds = [];

    const rockMat = new THREE.MeshStandardMaterial({ color: t.islandRock, roughness: 0.95, flatShading: true });
    const grassMat = new THREE.MeshStandardMaterial({ color: t.islandTop, roughness: 0.85, flatShading: true });
    for (let i = 0; i < q.islands; i++) {
      const isl = new THREE.Group();
      const s = 1.5 + rng.next() * 3.5;
      const rock = new THREE.Mesh(new THREE.ConeGeometry(s, s * 1.6, 7 + Math.floor(rng.next() * 3)), rockMat);
      rock.rotation.x = Math.PI; // point down
      rock.position.y = -s * 0.8;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(s, s * 0.92, s * 0.28, 9), grassMat);
      const tuftN = 2 + Math.floor(rng.next() * 3);
      for (let k = 0; k < tuftN; k++) {
        const tuft = new THREE.Mesh(new THREE.ConeGeometry(s * 0.12, s * 0.5, 5), grassMat);
        tuft.position.set((rng.next() - 0.5) * s * 1.2, s * 0.35, (rng.next() - 0.5) * s * 0.6);
        isl.add(tuft);
      }
      isl.add(rock, cap);
      const depth = 18 + rng.next() * 55;         // parallax distance
      isl.position.set(rng.range(-70, 70), rng.range(-26, 4), -depth);
      isl.userData = { depth, drift: rng.range(0.2, 0.9), bobPhase: rng.range(0, Math.PI * 2), bobAmp: rng.range(0.15, 0.5) };
      isl.traverse((o) => o.layers.set(LAYER_ENV));
      this.envGroup.add(isl);
      this._islands.push(isl);
    }

    const cloudMat = new THREE.MeshStandardMaterial({ color: t.cloud, roughness: 1, transparent: true, opacity: 0.85, flatShading: true });
    for (let i = 0; i < q.clouds; i++) {
      const cl = new THREE.Group();
      const puffs = 3 + Math.floor(rng.next() * 4);
      for (let k = 0; k < puffs; k++) {
        const r = 0.8 + rng.next() * 1.6;
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), cloudMat);
        puff.position.set(k * r * 1.1 - puffs * 0.5, (rng.next() - 0.5) * 0.8, (rng.next() - 0.5) * 0.8);
        cl.add(puff);
      }
      const depth = 25 + rng.next() * 70;
      cl.position.set(rng.range(-80, 80), rng.range(2, 22), -depth);
      cl.userData = { depth, speed: rng.range(0.3, 1.0) };
      cl.traverse((o) => o.layers.set(LAYER_ENV));
      this.envGroup.add(cl);
      this._clouds.push(cl);
    }

    // Sea/floor haze plane far below.
    const seaGeo = new THREE.PlaneGeometry(400, 120);
    this.seaMat = new THREE.MeshBasicMaterial({ color: t.haze, transparent: true, opacity: 0.7, fog: false });
    const sea = new THREE.Mesh(seaGeo, this.seaMat);
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, WORLD.floorY - 8, -40);
    sea.layers.set(LAYER_ENV);
    this.envGroup.add(sea);
  }

  /* --------------------------- particles ---------------------------- */

  _buildPools() {
    const q = QUALITY_TIERS[this.tier] || QUALITY_TIERS.medium;
    const max = Math.min(q.particles, 20000);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: 0.22, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, sizeAttenuation: true });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_FX);
    this.fxGroup.add(this.points);
    this._parts = [];
    for (let i = 0; i < max; i++) {
      this._parts.push({ life: 0, ttl: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1 });
    }
    this._partCursor = 0;
    this._burstColor = new THREE.Color(1, 1, 1);
  }

  _spawnParticle(x, y, z, opts = {}) {
    const p = this._parts[this._partCursor];
    this._partCursor = (this._partCursor + 1) % this._parts.length;
    p.life = 0; p.ttl = opts.ttl || 0.8;
    p.x = x; p.y = y; p.z = z;
    const spread = opts.spread ?? 2.2;
    p.vx = (opts.vx || 0) + (this._fxRng() - 0.5) * spread;
    p.vy = (opts.vy || 0) + (this._fxRng() - 0.5) * spread;
    p.vz = (opts.vz || 0) + (this._fxRng() - 0.5) * spread * 0.5;
    const c = opts.color || this._burstColor;
    p.r = c.r; p.g = c.g; p.b = c.b;
  }

  _fxRng() { return (this._fxSeed = ((this._fxSeed || 22222) * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

  burst(x, y, n, color, opts = {}) {
    const q = QUALITY_TIERS[this.tier] || QUALITY_TIERS.medium;
    if (this.reducedMotion) n = Math.min(n, 6);
    const count = Math.min(n, this._parts.length, q.particles);
    this._burstColor.set(color);
    for (let i = 0; i < count; i++) this._spawnParticle(x, y, 0.3, opts);
  }

  /* ------------------------------ API ------------------------------- */

  setTheme(themeId) {
    this._theme = THEMES[themeId] || THEMES.day;
    const t = this._theme;
    this.skyMat.uniforms.topColor.value.set(t.skyTop);
    this.skyMat.uniforms.bottomColor.value.set(t.horizon);
    this.scene.fog.color.set(t.haze);
    this.keyLight.color.set(t.keyLight);
    this.hemi.color.set(t.ambient);
    this.hemi.groundColor.set(t.islandRock);
    this.sun.material.color.set(t.sun);
    if (this.birdMat) { this.birdMat.color.set(t.bird); this.wingMat.color.set(t.wing); }
    if (this.seaMat) this.seaMat.color.set(t.haze);
    // Rebuild gate materials to match.
    for (const [, mesh] of this._gateMeshes || []) this._disposeObject(mesh);
    this._gateMeshes = new Map();
    this.gateGroup.clear();
  }

  /** (Re)build decoration for a new session. */
  prepareSession(config) {
    this.setTheme(config.theme);
    this._envSeed = config.seed;
    this._buildEnvironment(config.seed);
    this._camY = 0;
    this._fxSeed = (config.seed ^ 0xf1e1d) >>> 0;
  }

  setQuality(tier) {
    if (!QUALITY_TIERS[tier]) return;
    this.tier = tier;
    this._buildRenderer();
    this.renderer.setSize(this._lastW || this.canvas.clientWidth, this._lastH || this.canvas.clientHeight, false);
    // Rebuild environment + pools at new fidelity, keeping the session theme.
    this._buildEnvironment(this._envSeed || 1);
    this.fxGroup.remove(this.points);
    this._disposeObject(this.points);
    this._buildPools();
  }

  setReducedMotion(v) { this.reducedMotion = !!v; }
  setAssistArc(v) { this.assistArc = !!v; }

  resize(w, h) {
    if (!w || !h) return;
    this._lastW = w; this._lastH = h;
    this.camera.aspect = w / h;
    // Keep the playable vertical band visible in portrait.
    const minVisible = 21;
    const vFov = FRAMING.fov;
    const hFov = 2 * Math.atan(Math.tan((vFov * Math.PI / 180) / 2) * this.camera.aspect) * 180 / Math.PI;
    if (hFov < 62) {
      this.camera.fov = 2 * Math.atan(Math.tan((62 * Math.PI / 180) / 2) / this.camera.aspect) * 180 / Math.PI;
    } else {
      this.camera.fov = vFov;
    }
    void minVisible;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /**
   * Render one frame from an immutable snapshot + interpolation alpha.
   * prev/cur are rules states; alpha in [0,1).
   */
  render(prev, cur, alpha, dtReal) {
    if (this._disposed || this.contextLost) return;
    this._time += dtReal;
    const t = this._theme;

    // Bird: interpolate position, derive pose from velocity.
    const by = prev && prev.bird ? prev.bird.y + (cur.bird.y - prev.bird.y) * alpha : cur.bird.y;
    this.birdGroup.position.set(WORLD.birdX, by, 0);
    const tilt = Math.max(-0.9, Math.min(0.6, cur.bird.vy * 0.06));
    this.birdGroup.rotation.z = tilt;
    // Wing flap: decaying kick + glide sway.
    this._flapKick = Math.max(0, this._flapKick - dtReal * 3.2);
    this._flapPhase += dtReal * (4 + this._flapKick * 26);
    const wingAngle = Math.sin(this._flapPhase) * (0.25 + this._flapKick * 0.85);
    this.wingL.rotation.x = -wingAngle;
    this.wingR.rotation.x = wingAngle;
    if (cur.phase === 'terminal' && cur.terminal.reason !== 'cleared') {
      this.birdGroup.rotation.z = Math.max(-1.4, this.birdGroup.rotation.z - dtReal * 4);
    }

    // Gates: create/remove/position from snapshot.
    const seen = new Set();
    const gapHalf = currentGapHalf(cur.config, cur.gatesPassed);
    for (const g of cur.gates) {
      seen.add(g.i);
      let mesh = this._gateMeshes.get(g.i);
      if (!mesh) { mesh = this._makeGateMesh(); this._gateMeshes.set(g.i, mesh); }
      const prevGate = prev && prev.gates ? prev.gates.find((p) => p.i === g.i) : null;
      const gx = prevGate ? prevGate.x + (g.x - prevGate.x) * alpha : g.x;
      this._layoutGate(mesh, gx, gateGapY(cur.config, g, cur.tick), gapHalf);
      // Emphasis pulse on the nearest upcoming gate (readable without post fx).
      const near = !g.passed && g.x > WORLD.birdX - 1 && g.x < WORLD.birdX + 9;
      mesh.userData.topTrim.material.emissiveIntensity = near ? 0.5 : 0.25;
      mesh.userData.botTrim.material.emissiveIntensity = near ? 0.5 : 0.25;
    }
    for (const [i, mesh] of this._gateMeshes) {
      if (!seen.has(i)) { this.gateGroup.remove(mesh); this._disposeObject(mesh); this._gateMeshes.delete(i); }
    }

    // Ghost arc preview (assist).
    this._updateGhostArc(cur);

    // Camera: critically damped follow, no cumulative per-frame lerp drift.
    const targetY = Math.max(WORLD.floorY + 2, Math.min(WORLD.ceilY - 2, by));
    const k = FRAMING.followStiffness;
    this._camY += (targetY - this._camY) * Math.min(1, k * dtReal);
    let shakeX = 0, shakeY = 0;
    if (this._shake > 0 && !this.reducedMotion) {
      this._shake = Math.max(0, this._shake - dtReal * 2.4);
      const s = this._shake * FRAMING.shakeMax;
      shakeX = (this._fxRng() - 0.5) * s; shakeY = (this._fxRng() - 0.5) * s;
    }
    this.camera.position.set(FRAMING.cameraX + shakeX, this._camY + shakeY, FRAMING.cameraZ);
    this.camera.lookAt(FRAMING.cameraX + FRAMING.lookAheadX, this._camY * 0.92, 0);

    // Environment drift: parallax + gentle bob (paused when reduced motion).
    const scrollSpeed = currentSpeed(cur.config, cur.gatesPassed);
    const motionScale = this.reducedMotion ? 0.25 : 1;
    for (const isl of this._islands) {
      const par = 12 / isl.userData.depth;
      isl.position.x -= scrollSpeed * par * isl.userData.drift * dtReal * motionScale;
      if (isl.position.x < -85) isl.position.x += 170;
      isl.position.y += Math.sin(this._time * 0.5 + isl.userData.bobPhase) * isl.userData.bobAmp * dtReal * motionScale;
    }
    for (const cl of this._clouds) {
      const par = 8 / cl.userData.depth;
      cl.position.x -= (scrollSpeed * par + cl.userData.speed) * dtReal * motionScale;
      if (cl.position.x < -95) cl.position.x += 190;
    }

    // Particles.
    this._stepParticles(dtReal);

    // Sun follows camera gently (keeps composition stable).
    this.sun.position.x = this.camera.position.x - 34;

    this.renderer.render(this.scene, this.camera);
  }

  _stepParticles(dt) {
    const pos = this.points.geometry.attributes.position.array;
    const col = this.points.geometry.attributes.color.array;
    let alive = 0;
    for (let i = 0; i < this._parts.length; i++) {
      const p = this._parts[i];
      if (p.life >= p.ttl) { pos[i * 3 + 1] = -9999; continue; }
      p.life += dt;
      p.vy -= 6 * dt; // soft gravity on debris
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const fade = 1 - p.life / p.ttl;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      col[i * 3] = p.r * fade; col[i * 3 + 1] = p.g * fade; col[i * 3 + 2] = p.b * fade;
      alive++;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    this._aliveParticles = alive;
  }

  /** Consume logical events → cosmetic effects (event hierarchy). */
  onEvents(events, state) {
    for (const e of events) {
      switch (e.type) {
        case 'flap':
          this._flapKick = 1;
          this.burst(WORLD.birdX, state.bird.y - 0.4, 5, this._theme.wing, { vy: -1.5, spread: 1.4, ttl: 0.5 });
          break;
        case 'pass': {
          const g = state.gates.find((x) => x.i === e.gate);
          if (g) this.burst(g.x, state.bird.y, e.centered ? 26 : 12, e.centered ? 0xffe08a : this._theme.gateTrim, { ttl: 0.9 });
          break;
        }
        case 'centered':
          this._shake = Math.max(this._shake, 0.15);
          break;
        case 'terminal':
          if (e.reason === 'cleared') {
            this.burst(WORLD.birdX, state.bird.y, 60, 0xffe08a, { spread: 5, ttl: 1.4 });
          } else {
            this.burst(WORLD.birdX, state.bird.y, 40, 0xff6a4d, { spread: 4, ttl: 1.1 });
            this._shake = 1;
          }
          break;
        default: break;
      }
    }
  }

  /** Project a world point to CSS pixels for DOM label alignment. */
  projectToScreen(x, y, z = 0) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * this.canvas.clientWidth,
      y: (-v.y * 0.5 + 0.5) * this.canvas.clientHeight,
      behind: v.z > 1,
    };
  }

  /** Debug/validation captures: draw call + triangle evidence. */
  stats() {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      particles: this._aliveParticles || 0,
      tier: this.tier,
    };
  }

  _rebuildGpuResources() {
    // CPU-side descriptors are all retained; re-upload everything.
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.attributes && Object.values(o.geometry.attributes).forEach((a) => { a.needsUpdate = true; });
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
    });
  }

  _disposeObject(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
  }

  dispose() {
    this._disposed = true;
    this._disposeObject(this.scene);
    this.renderer.dispose();
  }
}
