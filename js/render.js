/**
 * Breeze Wing — render module.
 * Three.js presentation of immutable rules snapshots + interpolation alpha.
 * Original procedural geometry only: floating islands, soft clouds, storybook
 * sky. Graphics settings (js/gfx.js) change fidelity, never rules or hazard
 * visibility.
 *
 * Layers: 0 environment, 1 gameplay, 2 selection/ghost, 3 effects.
 * Cosmetic objects are non-interactive; picking stays on the DOM layer.
 */

import * as THREE from '../vendor/three.module.js';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from '../vendor/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from '../vendor/addons/shaders/FXAAShader.js';
import { WORLD, gateGapY, currentGapHalf, currentSpeed, SIM_DT, createRng } from './rules.js';
import { THEMES } from './content.js';
import { detectPreset, resolve, describe, SHADOW_MAP, SCENERY, PARTICLES } from './gfx.js';

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
const KEY_DIR = new THREE.Vector3(6, 12, 8).normalize();

/* ------------------------------ shaders ------------------------------ */

const NOISE_GLSL = `
  float bwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float bwNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(bwHash(i), bwHash(i + vec2(1.0, 0.0)), f.x),
               mix(bwHash(i + vec2(0.0, 1.0)), bwHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float bwFbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * bwNoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
  // Pre-compensate for ACES so the theme's sky hues stay saturated on screen.
  vec3 bwSkyComp(vec3 c) {
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(lum), c, 1.3) * 0.92;
  }
  vec3 bwSkyAt(vec3 bottomC, vec3 topC, float h) { return bwSkyComp(mix(bottomC, topC, smoothstep(-0.25, 0.45, h))); }`;

// Sky dome: horizon → zenith gradient; "detailed" adds a sun halo, drifting
// cirrus, twinkling stars (night) and aurora ribbons (Aurora Vale).
const SKY_FRAG = `
  uniform vec3 topColor; uniform vec3 bottomColor; uniform vec3 sunColor; uniform vec3 cloudColor;
  uniform vec3 sunDir; uniform float uTime; uniform float uDetail; uniform float uNight; uniform float uAurora;
  varying vec3 vPos;
  ${NOISE_GLSL}
  void main() {
    vec3 d = normalize(vPos);
    float h = d.y;
    vec3 col = bwSkyAt(bottomColor, topColor, h);
    if (uDetail > 0.5) {
      float sd = max(dot(d, sunDir), 0.0);
      col += sunColor * (pow(sd, 10.0) * 0.1 + pow(sd, 90.0) * 0.35);
      vec2 uv = d.xz / (max(h, 0.03) + 0.35);
      float n = bwFbm(vec2(uv.x * 0.9 + uTime * 0.012, uv.y * 2.6));
      float band = smoothstep(0.02, 0.2, h) * (1.0 - smoothstep(0.5, 0.9, h));
      col = mix(col, cloudColor, smoothstep(0.52, 0.86, n) * band * 0.42 * (1.0 - 0.6 * uNight));
      if (uNight > 0.0) {
        vec2 g = vec2(atan(d.z, d.x) * 90.0, h * 90.0);
        vec2 id = floor(g);
        float r = bwHash(id);
        float star = step(0.982, r) * max(0.0, 1.0 - length(fract(g) - 0.5) * 2.6);
        float tw = 0.65 + 0.35 * sin(uTime * 2.2 + r * 60.0);
        col += vec3(1.4, 1.35, 1.2) * star * tw * uNight * smoothstep(0.06, 0.35, h);
      }
      if (uAurora > 0.0) {
        float w = bwFbm(vec2(d.x * 3.0 + uTime * 0.02, h * 4.0));
        float a = sin(d.x * 9.0 + w * 4.0 + uTime * 0.08 + 1.3);
        float ribbon = pow(max(a, 0.0), 5.0) * smoothstep(0.1, 0.24, h) * (1.0 - smoothstep(0.55, 0.9, h));
        ribbon *= 0.55 + 0.45 * bwNoise(vec2(d.x * 30.0, h * 3.0 - uTime * 0.05)); // curtain folds
        vec3 aur = mix(vec3(0.05, 0.75, 0.35), vec3(0.35, 0.2, 0.85), smoothstep(0.3, 0.7, h));
        col = mix(col, aur, clamp(ribbon * 0.75 * uAurora, 0.0, 1.0));
      }
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// Sea far below: deep near the bird, melting into the horizon colour with
// distance (no hard edge); "detailed" adds drifting glints.
const SEA_VERT = `varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const SEA_FRAG = `
  uniform vec3 nearColor; uniform vec3 skyBottom; uniform vec3 skyTop; uniform vec3 glintColor; uniform float uTime; uniform float uDetail;
  varying vec3 vWorld;
  ${NOISE_GLSL}
  void main() {
    float dist = length(vWorld.xz - cameraPosition.xz);
    float f = smoothstep(15.0, 120.0, dist);
    // Far edge matches the sky just below the horizon, so there is no seam.
    vec3 col = mix(bwSkyComp(nearColor), bwSkyAt(skyBottom, skyTop, -0.06), f);
    if (uDetail > 0.5) {
      float w = bwNoise(vWorld.xz * vec2(0.22, 0.6) + vec2(uTime * 0.25, uTime * 0.07));
      float w2 = bwNoise(vWorld.xz * vec2(0.5, 1.3) - vec2(uTime * 0.18, 0.0));
      col += glintColor * smoothstep(0.72, 0.95, w * 0.6 + w2 * 0.4) * 0.55 * (1.0 - f);
    }
    float alpha = 0.92 * (1.0 - smoothstep(95.0, 150.0, dist));
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// Colour grade + vignette, applied in display space after OutputPass.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.2);             // gentle S-curve
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.14);                                   // win back saturation ACES removes
      s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.97), smoothstep(0.25, 0.8, l)); // warm highlights, cool shadows
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

/* ------------------------------ helpers ------------------------------ */

function softDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function reducedMotionQuery() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return null; }
}

function isTouchFirst() {
  try {
    return window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches;
  } catch { return false; }
}

/* ------------------------------ renderer ----------------------------- */

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.reducedMotion = opts.reducedMotion === true;
    this.palette = opts.palette || 'default';
    this.contextLost = false;
    this._disposed = false;
    this._time = 0;
    this._shake = 0;
    this._camY = 0;
    this._theme = THEMES.day;
    this._frames = [];
    this.adaptiveScale = 1;
    this.fps = 0;
    this.pixelRatio = 1;
    this.postFailed = false;
    this.composer = null;
    this.postKey = null;
    this._gfxSaved = opts.graphics || {};
    this.gpu = '';
    this.detected = 'balanced';
    this.q = resolve(this._gfxSaved, this.detected);
    this._buildRenderer();
    this._buildScene();
    this._buildPools();
    this._lastW = 0; this._lastH = 0;
    this.setGraphics(this._gfxSaved, true);
  }

  /* ----------------------------- setup ------------------------------ */

  _buildRenderer() {
    // GPU detection needs a context; probe one so the canvas context itself
    // can be created with the right native anti-aliasing for the resolved tier.
    this.gpu = Renderer._gpuName();
    this.detected = detectPreset(this.gpu, isTouchFirst());
    const q0 = resolve(this._gfxSaved, this.detected);
    this.q = q0;
    this.nativeAA = q0.antialias === 'msaa' && !q0.post;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.nativeAA,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this._rebuildGpuResources();
    });
  }

  static _gpuName() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return '';
      let name = '';
      // Firefox exposes the real renderer on RENDERER and warns on the debug extension.
      const ext = /firefox/i.test(navigator.userAgent) ? null : gl.getExtension('WEBGL_debug_renderer_info');
      name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return name;
    } catch { return ''; }
  }

  _buildScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 220);
    this.camera.position.set(FRAMING.cameraX, 0, FRAMING.cameraZ);
    this.camera.layers.enable(LAYER_GAME);
    this.camera.layers.enable(LAYER_GHOST);
    this.camera.layers.enable(LAYER_FX);

    // Lights: one dominant key (shadow frustum fitted to the play band), soft sky fill.
    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    this.keyLight.position.copy(KEY_DIR).multiplyScalar(40);
    const sc = this.keyLight.shadow.camera;
    sc.left = -15; sc.right = 15; sc.top = 13; sc.bottom = -13; sc.near = 10; sc.far = 80;
    this.keyLight.shadow.bias = -0.0006;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight, this.keyLight.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x8a7a68, 0.9);
    this.scene.add(this.hemi);

    // Sky dome + fog (aerial perspective without flattening gameplay).
    this.skyGeo = new THREE.SphereGeometry(160, 32, 20);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x4f9fe0) },
        bottomColor: { value: new THREE.Color(0xeaf7ff) },
        sunColor: { value: new THREE.Color(0xffffff) },
        cloudColor: { value: new THREE.Color(0xffffff) },
        sunDir: { value: new THREE.Vector3(-30, 26, -120).normalize() },
        uTime: { value: 0 }, uDetail: { value: 0 }, uNight: { value: 0 }, uAurora: { value: 0 },
      },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: SKY_FRAG,
    });
    this.sky = new THREE.Mesh(this.skyGeo, this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.layers.set(LAYER_ENV);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(0xd8f0ff, 40, 140);

    // Sun disc + halo (the halo is HDR so bloom gives it a soft glow).
    this.sun = new THREE.Mesh(
      new THREE.CircleGeometry(6, 40),
      new THREE.MeshBasicMaterial({ color: 0xfff6d8, fog: false, transparent: true, opacity: 0.9 })
    );
    this.sun.position.set(-30, 26, -120);
    this.sun.layers.set(LAYER_ENV);
    this._dotTex = softDotTexture();
    this.sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._dotTex, color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending,
    }));
    this.sunHalo.scale.set(22, 22, 1);
    this.sunHalo.position.set(0, 0, -0.5);
    this.sunHalo.layers.set(LAYER_ENV);
    this.sun.add(this.sunHalo);
    this.scene.add(this.sun);

    // Sea: soft plane far below that melts into the horizon.
    this.seaMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        nearColor: { value: new THREE.Color() }, skyBottom: { value: new THREE.Color() }, skyTop: { value: new THREE.Color() },
        glintColor: { value: new THREE.Color(0xffffff) }, uTime: { value: 0 }, uDetail: { value: 0 },
      },
      vertexShader: SEA_VERT,
      fragmentShader: SEA_FRAG,
    });
    this.sea = new THREE.Mesh(new THREE.PlaneGeometry(420, 320), this.seaMat);
    this.sea.rotation.x = -Math.PI / 2;
    this.sea.position.set(0, WORLD.floorY - 8, -100);
    this.sea.renderOrder = -5;
    this.sea.layers.set(LAYER_ENV);
    this.scene.add(this.sea);

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

  /** Env intensity per material role, 0 when reflections are off. */
  _env(m, k) {
    m.envMapIntensity = k;
    return m;
  }

  /* ------------------------- procedural bird ------------------------ */

  _buildBird() {
    for (const c of [...this.birdGroup.children]) { this.birdGroup.remove(c); this._disposeObject(c); }
    const t = this._theme;
    const detailed = this.q.detail === 'detailed';
    if (detailed) {
      // Soft feather sheen + a satin wing; the beak gets a glossy clearcoat.
      this.birdMat = this._env(new THREE.MeshPhysicalMaterial({ color: t.bird, roughness: 0.55, metalness: 0, sheen: 0.8, sheenRoughness: 0.45, sheenColor: new THREE.Color(t.wing).lerp(new THREE.Color(0xffffff), 0.6) }), 0.45);
      this.wingMat = this._env(new THREE.MeshPhysicalMaterial({ color: t.wing, roughness: 0.5, metalness: 0, sheen: 0.6, sheenRoughness: 0.4, sheenColor: new THREE.Color(0xffffff) }), 0.45);
    } else {
      this.birdMat = this._env(new THREE.MeshStandardMaterial({ color: t.bird, roughness: 0.6, metalness: 0.05 }), 0.4);
      this.wingMat = this._env(new THREE.MeshStandardMaterial({ color: t.wing, roughness: 0.55, metalness: 0.05 }), 0.4);
    }
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, detailed ? 32 : 24, detailed ? 24 : 18), this.birdMat);
    body.scale.set(1.15, 0.95, 0.9);
    body.castShadow = true; body.receiveShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 14), this.birdMat);
    head.position.set(0.38, 0.24, 0);
    head.castShadow = true; head.receiveShadow = true;
    const beakMat = detailed
      ? this._env(new THREE.MeshPhysicalMaterial({ color: 0xff9d3c, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.25 }), 0.6)
      : this._env(new THREE.MeshStandardMaterial({ color: 0xff9d3c, roughness: 0.5 }), 0.4);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 10), beakMat);
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(0.72, 0.22, 0);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x222831 });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), eyeMat);
    eyeL.position.set(0.52, 0.34, 0.2);
    if (detailed) {
      // Catch-light: a tiny glint that reads as a living eye.
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      glint.position.set(0.03, 0.025, 0.035);
      eyeL.add(glint);
    }
    const eyeR = eyeL.clone(); eyeR.position.z = -0.2;
    // Wing: flattened tapered pod, pivot at shoulder.
    this.wingL = new THREE.Group();
    const wingGeo = new THREE.SphereGeometry(0.5, detailed ? 20 : 14, detailed ? 14 : 10);
    wingGeo.scale(0.6, 0.18, 1.05);
    const wl = new THREE.Mesh(wingGeo, this.wingMat);
    wl.position.set(-0.12, 0, 0.55);
    wl.castShadow = true; wl.receiveShadow = true;
    this.wingL.add(wl);
    this.wingL.position.set(-0.05, 0.12, 0.1);
    this.wingR = this.wingL.clone();
    this.wingR.scale.z = -1;
    this.birdGroup.add(body, head, beak, eyeL, eyeR, this.wingL, this.wingR);
    this.birdGroup.traverse((o) => o.layers.set(LAYER_GAME));
    this._flapPhase = this._flapPhase || 0;
    this._flapKick = this._flapKick || 0;
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
    const detailed = this.q.detail === 'detailed';
    if (kind === 'trim') {
      const m = new THREE.MeshStandardMaterial({ color: t.gateTrim, roughness: 0.35, emissive: t.gateTrim, emissiveIntensity: 0.25 });
      return this._env(m, 0.5);
    }
    if (!detailed) return this._env(new THREE.MeshStandardMaterial({ color: t.gate, roughness: 0.7, metalness: 0.05 }), 0.45);
    // Glazed terracotta: clearcoat shell over coursed, slightly varied tiles.
    const m = this._env(new THREE.MeshPhysicalMaterial({
      color: t.gate, roughness: 0.62, metalness: 0,
      clearcoat: this.q.reflections === 'on' ? 0.55 : 0, clearcoatRoughness: 0.3,
    }), 0.55);
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBwLocal; varying float vBwWorldY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBwLocal = position; vBwWorldY = (modelMatrix * vec4(position, 1.0)).y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBwLocal; varying float vBwWorldY;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float bwRow = floor(vBwWorldY * 0.85);
          float bwCourse = fract(vBwWorldY * 0.85);
          float bwAng = atan(vBwLocal.z, vBwLocal.x);
          float bwCell = floor(bwAng * 1.6 + mod(bwRow, 2.0) * 0.5);
          float bwH = fract(sin(bwRow * 12.9898 + bwCell * 78.233) * 43758.5453);
          float bwGrout = 1.0 - 0.16 * (1.0 - smoothstep(0.0, 0.07, bwCourse));
          diffuseColor.rgb *= bwGrout * (0.94 + 0.1 * bwH);`);
    };
    m.customProgramCacheKey = () => 'bw-glazed-pillar';
    return m;
  }

  _makeGateMesh() {
    const g = new THREE.Group();
    const seg = this.q.detail === 'detailed' ? 20 : 10;
    const pillarGeo = new THREE.CylinderGeometry(0.55, 0.7, 1, seg);
    const trimGeo = new THREE.CylinderGeometry(0.68, 0.68, 0.35, seg);
    const bodyMat = this._gateMaterial('body');
    const top = new THREE.Mesh(pillarGeo, bodyMat);
    const bot = new THREE.Mesh(pillarGeo, this._gateMaterial('body'));
    const topTrim = new THREE.Mesh(trimGeo, this._gateMaterial('trim'));
    const botTrim = new THREE.Mesh(trimGeo, this._gateMaterial('trim'));
    top.castShadow = bot.castShadow = true;
    top.receiveShadow = bot.receiveShadow = topTrim.receiveShadow = botTrim.receiveShadow = true;
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

  _clearGates() {
    for (const [, mesh] of this._gateMeshes || []) this._disposeObject(mesh);
    this._gateMeshes = new Map();
    this.gateGroup.clear();
  }

  /* ------------------- environment: islands + clouds ---------------- */

  _buildEnvironment(seed) {
    // Dispose previous.
    for (const c of [...this.envGroup.children]) this._disposeObject(c);
    this.envGroup.clear();
    const counts = SCENERY[this.q.scenery] || SCENERY.normal;
    const detailed = this.q.detail === 'detailed';
    const rng = createRng((seed ^ 0xdec0) >>> 0); // decoration stream: cosmetic only
    const t = this._theme;
    this._islands = [];
    this._clouds = [];

    const rockMat = this._env(new THREE.MeshStandardMaterial({ color: detailed ? 0xffffff : t.islandRock, vertexColors: detailed, roughness: 0.95, flatShading: true }), 0.3);
    const grassMat = this._env(new THREE.MeshStandardMaterial({ color: detailed ? 0xffffff : t.islandTop, vertexColors: detailed, roughness: 0.85, flatShading: true }), 0.3);
    const rockCol = new THREE.Color(t.islandRock), grassCol = new THREE.Color(t.islandTop), tmp = new THREE.Color();
    // Vertex tint: strata bands + darker tip for rock, sunlit rim for grass (cosmetic rng).
    const tint = (geo, base, fn) => {
      const pos = geo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let v = 0; v < pos.count; v++) {
        tmp.copy(base).multiplyScalar(fn(pos.getX(v), pos.getY(v), pos.getZ(v)));
        col[v * 3] = tmp.r; col[v * 3 + 1] = tmp.g; col[v * 3 + 2] = tmp.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return geo;
    };
    for (let i = 0; i < counts.islands; i++) {
      const isl = new THREE.Group();
      const s = 1.5 + rng.next() * 3.5;
      const h = s * 1.6;
      const rockGeo = new THREE.ConeGeometry(s, h, 7 + Math.floor(rng.next() * 3), detailed ? 4 : 1);
      if (detailed) {
        const jit = rng.next() * 10;
        tint(rockGeo, rockCol, (x, y) => {
          const up = (y + h / 2) / h; // 1 at the (downward) tip
          const strata = 0.9 + 0.12 * Math.sin((y / h) * 18 + jit);
          return (1.08 - up * 0.5) * strata;
        });
      }
      const rock = new THREE.Mesh(rockGeo, rockMat);
      rock.rotation.x = Math.PI; // point down
      rock.position.y = -s * 0.8;
      const capGeo = new THREE.CylinderGeometry(s, s * 0.92, s * 0.28, detailed ? 14 : 9);
      if (detailed) tint(capGeo, grassCol, (x, y) => (y > 0 ? 1.12 : 0.78));
      const cap = new THREE.Mesh(capGeo, grassMat);
      const tuftN = 2 + Math.floor(rng.next() * 3);
      for (let k = 0; k < tuftN; k++) {
        const tuftGeo = new THREE.ConeGeometry(s * 0.12, s * 0.5, 5);
        if (detailed) tint(tuftGeo, grassCol, (x, y) => 0.8 + (y + s * 0.25) / (s * 0.5) * 0.45);
        const tuft = new THREE.Mesh(tuftGeo, grassMat);
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

    // Clouds: self-lit so undersides stay soft; detailed = smooth, rounder puffs.
    const cloudMat = this._env(new THREE.MeshStandardMaterial({
      color: t.cloud, roughness: 1, flatShading: !detailed,
      emissive: t.cloud, emissiveIntensity: detailed ? 0.12 : 0.1,
    }), 0.35);
    for (let i = 0; i < counts.clouds; i++) {
      const cl = new THREE.Group();
      const puffs = 3 + Math.floor(rng.next() * 4);
      for (let k = 0; k < puffs; k++) {
        const r = 0.8 + rng.next() * 1.6;
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r, detailed ? 3 : 1), cloudMat);
        puff.position.set(k * r * 1.1 - puffs * 0.5, (rng.next() - 0.5) * 0.8, (rng.next() - 0.5) * 0.8);
        if (detailed) puff.scale.y = 0.82;
        cl.add(puff);
      }
      const depth = 25 + rng.next() * 70;
      cl.position.set(rng.range(-80, 80), rng.range(2, 22), -depth);
      cl.userData = { depth, speed: rng.range(0.3, 1.0) };
      cl.traverse((o) => o.layers.set(LAYER_ENV));
      this.envGroup.add(cl);
      this._clouds.push(cl);
    }
  }

  /* --------------------------- particles ---------------------------- */

  _buildPools() {
    const budget = PARTICLES[this.q.particles] || PARTICLES.low;
    const max = Math.min(budget.pool, 20000);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 4);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    const mat = new THREE.PointsMaterial({
      size: 0.34, map: this._dotTex, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_FX);
    this.fxGroup.add(this.points);
    this._parts = [];
    for (let i = 0; i < max; i++) {
      this._parts.push({ life: 1, ttl: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1 });
    }
    this._partCursor = 0;
    this._burstColor = new THREE.Color(1, 1, 1);

    // Ambient motes: pollen by day, fireflies by night (particles: high).
    if (this.motes) { this.fxGroup.remove(this.motes); this._disposeObject(this.motes); this.motes = null; }
    if (budget.motes > 0) {
      const n = budget.motes;
      const mg = new THREE.BufferGeometry();
      const mp = new Float32Array(n * 3);
      const mrng = createRng(0x5eed1);
      this._moteSeeds = [];
      for (let i = 0; i < n; i++) {
        mp[i * 3] = mrng.range(-16, 22); mp[i * 3 + 1] = mrng.range(-10, 10); mp[i * 3 + 2] = mrng.range(-9, 3);
        this._moteSeeds.push({ ph: mrng.range(0, 6.28), sp: mrng.range(0.3, 1.1), amp: mrng.range(0.1, 0.35) });
      }
      mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
      this.moteMat = new THREE.PointsMaterial({
        size: 0.16, map: this._dotTex, color: 0xffffff, transparent: true, opacity: 0.55,
        depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      });
      this.motes = new THREE.Points(mg, this.moteMat);
      this.motes.frustumCulled = false;
      this.motes.layers.set(LAYER_FX);
      this.fxGroup.add(this.motes);
      this._tintMotes();
    }
  }

  _tintMotes() {
    if (!this.moteMat) return;
    const night = this._theme.id === 'night';
    // Fireflies glow above 1.0 so bloom picks them up; day pollen stays subtle.
    this.moteMat.color.set(night ? 0xfff0a0 : 0xffffff).multiplyScalar(night ? 2.2 : 1);
    this.moteMat.opacity = night ? 0.75 : 0.3;
    this.moteMat.size = night ? 0.2 : 0.14;
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
    const glow = opts.glow || 1;
    p.r = c.r * glow; p.g = c.g * glow; p.b = c.b * glow;
  }

  _fxRng() { return (this._fxSeed = ((this._fxSeed || 22222) * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

  burst(x, y, n, color, opts = {}) {
    const budget = PARTICLES[this.q.particles] || PARTICLES.low;
    if (this.reducedMotion) n = Math.min(n, 6);
    else if (this.q.particles === 'high') n = Math.round(n * 1.5);
    const count = Math.min(n, this._parts.length, budget.pool);
    this._burstColor.set(color);
    for (let i = 0; i < count; i++) this._spawnParticle(x, y, 0.3, opts);
  }

  /* ------------------------------ API ------------------------------- */

  setTheme(themeId) {
    this._theme = THEMES[themeId] || THEMES.day;
    const t = this._theme;
    const u = this.skyMat.uniforms;
    u.topColor.value.set(t.skyTop);
    u.bottomColor.value.set(t.horizon);
    u.sunColor.value.set(t.sun);
    u.cloudColor.value.set(t.cloud);
    u.uNight.value = t.id === 'night' ? 1 : t.id === 'aurora' ? 0.45 : 0;
    u.uAurora.value = t.id === 'aurora' ? 1 : 0;
    this.scene.fog.color.set(t.haze);
    this.keyLight.color.set(t.keyLight);
    this.hemi.color.set(t.ambient);
    // Lighter ground bounce so undersides of clouds and islands never go muddy.
    this.hemi.groundColor.set(t.islandRock).lerp(new THREE.Color(t.haze), 0.5);
    this.sun.material.color.set(t.sun);
    this.sunHalo.material.color.set(t.sun).multiplyScalar(1.2);
    // Bright daytime skies need less halo; night moons glow more.
    this.sunHalo.material.opacity = t.id === 'night' || t.id === 'aurora' ? 0.28 : 0.14;
    if (this.birdMat) { this.birdMat.color.set(t.bird); this.wingMat.color.set(t.wing); }
    if (this.birdMat?.sheenColor) this.birdMat.sheenColor.set(t.wing).lerp(new THREE.Color(0xffffff), 0.6);
    const s = this.seaMat.uniforms;
    s.skyBottom.value.set(t.horizon);
    s.skyTop.value.set(t.skyTop);
    s.nearColor.value.set(t.haze).lerp(new THREE.Color(t.skyTop), 0.35).multiplyScalar(0.85);
    s.glintColor.value.set(t.sun);
    this._tintMotes();
    this._envDirty = true;
    // Rebuild gate materials to match.
    this._clearGates();
  }

  /** (Re)build decoration for a new session. */
  prepareSession(config) {
    this.setTheme(config.theme);
    this._envSeed = config.seed;
    this._buildEnvironment(config.seed);
    this._camY = 0;
    this._fxSeed = (config.seed ^ 0xf1e1d) >>> 0;
  }

  /**
   * Apply saved graphics settings live (no reload).
   * `saved`: { preset, render_scale, adaptive, show_fps, <category>: tier|'preset' }.
   */
  setGraphics(saved, initial = false) {
    this._gfxSaved = { ...(saved || {}) };
    const prev = initial ? null : this.q;
    const g = resolve(this._gfxSaved, this.detected);
    this.q = g;
    this.tier = g.preset;

    // Shadows.
    const size = SHADOW_MAP[g.shadows];
    const shadowsChanged = !prev || prev.shadows !== g.shadows;
    this.renderer.shadowMap.enabled = size > 0;
    this.keyLight.castShadow = size > 0;
    if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }

    // Sky / sea detail.
    this.skyMat.uniforms.uDetail.value = g.sky === 'detailed' ? 1 : 0;
    this.seaMat.uniforms.uDetail.value = g.sky === 'detailed' ? 1 : 0;
    this.sunHalo.visible = g.sky === 'detailed';

    // Geometry / material fidelity.
    const rebuildMeshes = !prev || prev.detail !== g.detail || prev.reflections !== g.reflections;
    if (rebuildMeshes && !initial) {
      this._buildBird();
      this._clearGates();
    }
    if (!initial && (rebuildMeshes || prev.scenery !== g.scenery)) this._buildEnvironment(this._envSeed || 1);
    if (initial || prev.particles !== g.particles) {
      if (!initial) { this.fxGroup.remove(this.points); this._disposeObject(this.points); }
      if (!initial || !this.points) this._buildPools();
    }

    // Image-based lighting from the themed sky.
    this._envDirty = true;

    // Materials pick up shadow-map / env changes on recompile.
    if (shadowsChanged && !initial) {
      this.scene.traverse((o) => {
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
      });
    }

    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._fpsVisible(g.showFps);
    this.canvas.dataset.gfxPreset = g.preset;
    this.canvas.dataset.gfxAuto = g.auto ? 'true' : 'false';
  }

  /** Legacy tier API (low | medium | high) → preset. */
  setQuality(tier) {
    const map = { low: 'low', medium: 'balanced', high: 'high', ultra: 'ultra', balanced: 'balanced' };
    if (!map[tier]) return;
    this.setGraphics({ preset: map[tier] });
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo(labels) {
    const w = this._lastW || this.canvas.clientWidth, h = this._lastH || this.canvas.clientHeight;
    const px = [Math.round(w * this.pixelRatio), Math.round(h * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px, labels),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
      composer: !!this.composer,
    };
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.className = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '— fps';
      document.getElementById('app')?.append(el);
    }
    if (el) el.hidden = !on;
  }

  _updateEnvironmentMap() {
    this._envDirty = false;
    if (this.q.reflections !== 'on') {
      this.scene.environment = null;
      return;
    }
    try {
      // A tiny sky-only scene (gradient + sun) → PMREM → reflections tinted by the theme.
      if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      const skyMat = this.skyMat.clone();
      skyMat.uniforms.uDetail.value = 0;
      const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 24, 12), skyMat);
      const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(this._theme.sun).multiplyScalar(6), side: THREE.DoubleSide });
      const sun = new THREE.Mesh(new THREE.CircleGeometry(7, 20), sunMat);
      sun.position.copy(KEY_DIR).multiplyScalar(40);
      sun.lookAt(0, 0, 0);
      envScene.add(sky, sun);
      const rt = this._pmrem.fromScene(envScene, 0.02, 0.1, 100);
      this._envRT?.dispose();
      this._envRT = rt;
      this.scene.environment = rt.texture;
      sky.geometry.dispose(); skyMat.dispose(); sun.geometry.dispose(); sunMat.dispose();
    } catch {
      this.scene.environment = null;
    }
  }

  setReducedMotion(v) { this.reducedMotion = !!v; }
  setAssistArc(v) { this.assistArc = !!v; }

  resize(w, h) {
    if (!w || !h) return;
    this._lastW = w; this._lastH = h;
    this.camera.aspect = w / h;
    // Keep the playable vertical band visible in portrait.
    const vFov = FRAMING.fov;
    const hFov = 2 * Math.atan(Math.tan((vFov * Math.PI / 180) / 2) * this.camera.aspect) * 180 / Math.PI;
    if (hFov < 62) {
      this.camera.fov = 2 * Math.atan(Math.tan((62 * Math.PI / 180) / 2) / this.camera.aspect) * 180 / Math.PI;
    } else {
      this.camera.fov = vFov;
    }
    this.camera.updateProjectionMatrix();
    this._sizeKey = null; // re-apply size + pixel ratio on the next frame
  }

  /* --------------------------- post chain --------------------------- */

  _wantsComposer() {
    const g = this.q;
    return g.post || (g.antialias === 'msaa' && !this.nativeAA);
  }

  _postKey(w, h) {
    const g = this.q;
    return this._wantsComposer() ? [g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    if (this.composer) {
      for (const p of this.composer.passes) p.dispose?.();
      this.composer.dispose();
    }
    this.composer = null;
    this.gradePass = null;
    if (this._wantsComposer() && !this.postFailed) this._makeComposer(w, h, g);
    this.canvas.dataset.gfxPost = this.composer ? 'on' : this.postFailed ? 'failed' : 'off';
  }

  _makeComposer(w, h, g) {
    try {
      const pr = this.pixelRatio;
      const target = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w * pr)), Math.max(1, Math.round(h * pr)), {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.bloom === 'on') {
        // High threshold: only the sun, glowing gate trims, sparkles and fireflies bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w * pr, h * pr), 0.4, 0.45, 0.9));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') {
        this.gradePass = new ShaderPass(GradeShader);
        composer.addPass(this.gradePass);
      }
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(w * pr, h * pr));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      this.postFailed = true;
      this.composer = null;
    }
  }

  /** Adaptive resolution: step the render scale down when frames are slow, back up when fast. */
  _adapt() {
    const now = performance.now();
    const dt = this._lastFrameAt ? Math.min(250, now - this._lastFrameAt) : 16;
    this._lastFrameAt = now;
    const f = this._frames;
    f.push(dt);
    if (f.length < 90) return;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) { this.adaptiveScale = 1; return; }
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
  }

  _applySize() {
    const w = this._lastW || this.canvas.clientWidth || 1, h = this._lastH || this.canvas.clientHeight || 1;
    const ratio = Math.min(4, Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale);
    const key = `${w}x${h}@${ratio}`;
    if (key !== this._sizeKey) {
      this._sizeKey = key;
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
    }
    const pk = this._postKey(w, h);
    if (pk !== this.postKey) {
      this.postKey = pk;
      this._buildPost(w, h);
    }
  }

  /**
   * Render one frame from an immutable snapshot + interpolation alpha.
   * prev/cur are rules states; alpha in [0,1).
   */
  render(prev, cur, alpha, dtReal) {
    if (this._disposed || this.contextLost) return;
    this._time += dtReal;
    this._adapt();
    if (!this._prm) this._prm = reducedMotionQuery();
    const calm = this.reducedMotion || !!this._prm?.matches;

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
    // Next-gate trims glow (HDR when bloom is on so the glow halos); a slow
    // shimmer keeps them alive unless motion is reduced.
    const shimmer = calm ? 0 : Math.sin(this._time * 3.2) * 0.12;
    const nearGlow = (this.q.bloom === 'on' && this.composer ? 1.25 : 0.5) + shimmer;
    for (const g of cur.gates) {
      seen.add(g.i);
      let mesh = this._gateMeshes.get(g.i);
      if (!mesh) { mesh = this._makeGateMesh(); this._gateMeshes.set(g.i, mesh); }
      const prevGate = prev && prev.gates ? prev.gates.find((p) => p.i === g.i) : null;
      const gx = prevGate ? prevGate.x + (g.x - prevGate.x) * alpha : g.x;
      this._layoutGate(mesh, gx, gateGapY(cur.config, g, cur.tick), gapHalf);
      // Emphasis pulse on the nearest upcoming gate (readable without post fx).
      const near = !g.passed && g.x > WORLD.birdX - 1 && g.x < WORLD.birdX + 9;
      mesh.userData.topTrim.material.emissiveIntensity = near ? nearGlow : 0.25;
      mesh.userData.botTrim.material.emissiveIntensity = near ? nearGlow : 0.25;
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

    // Shadow frustum follows the play band (snapped so edges do not shimmer).
    if (this.keyLight.castShadow) {
      const snap = Math.round(this._camY * 2) / 2;
      this.keyLight.target.position.set(2, snap, 0);
      this.keyLight.position.copy(KEY_DIR).multiplyScalar(40).add(this.keyLight.target.position);
    }

    // Environment drift: parallax + gentle bob (paused when reduced motion).
    const scrollSpeed = currentSpeed(cur.config, cur.gatesPassed);
    const motionScale = this.reducedMotion ? 0.25 : 1;
    for (const isl of this._islands || []) {
      const par = 12 / isl.userData.depth;
      isl.position.x -= scrollSpeed * par * isl.userData.drift * dtReal * motionScale;
      if (isl.position.x < -85) isl.position.x += 170;
      isl.position.y += Math.sin(this._time * 0.5 + isl.userData.bobPhase) * isl.userData.bobAmp * dtReal * motionScale;
    }
    for (const cl of this._clouds || []) {
      const par = 8 / cl.userData.depth;
      cl.position.x -= (scrollSpeed * par + cl.userData.speed) * dtReal * motionScale;
      if (cl.position.x < -95) cl.position.x += 190;
    }

    // Sky / sea / motes ambient animation (frozen under reduced motion).
    if (!calm) {
      this.skyMat.uniforms.uTime.value += dtReal;
      this.seaMat.uniforms.uTime.value += dtReal;
      this._stepMotes(dtReal, scrollSpeed);
    }

    // Particles.
    this._stepParticles(dtReal);

    // Sun follows camera gently (keeps composition stable).
    this.sun.position.x = this.camera.position.x - 34;

    if (this._envDirty) this._updateEnvironmentMap();
    this._applySize();
    if (this.composer) {
      try {
        this.composer.render(dtReal);
        return;
      } catch {
        this.postFailed = true;
        this.composer = null;
        this.canvas.dataset.gfxPost = 'failed';
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  _stepMotes(dt, scroll) {
    if (!this.motes) return;
    const pos = this.motes.geometry.attributes.position.array;
    for (let i = 0; i < this._moteSeeds.length; i++) {
      const s = this._moteSeeds[i];
      pos[i * 3] -= (scroll * 0.35 + s.sp * 0.4) * dt;
      pos[i * 3 + 1] += Math.sin(this._time * s.sp + s.ph) * s.amp * dt;
      if (pos[i * 3] < -16) pos[i * 3] += 38;
    }
    this.motes.position.y = this._camY * 0.9;
    this.motes.geometry.attributes.position.needsUpdate = true;
  }

  _stepParticles(dt) {
    const pos = this.points.geometry.attributes.position.array;
    const col = this.points.geometry.attributes.color.array;
    let alive = 0;
    for (let i = 0; i < this._parts.length; i++) {
      const p = this._parts[i];
      if (p.life >= p.ttl) { pos[i * 3 + 1] = -9999; col[i * 4 + 3] = 0; continue; }
      p.life += dt;
      p.vy -= 6 * dt; // soft gravity on debris
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const fade = Math.max(0, 1 - p.life / p.ttl);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      col[i * 4] = p.r; col[i * 4 + 1] = p.g; col[i * 4 + 2] = p.b; col[i * 4 + 3] = fade;
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
          if (g) this.burst(g.x, state.bird.y, e.centered ? 26 : 12, e.centered ? 0xffe08a : this._theme.gateTrim, { ttl: 0.9, glow: e.centered ? 2.4 : 1.3 });
          break;
        }
        case 'centered':
          this._shake = Math.max(this._shake, 0.15);
          break;
        case 'terminal':
          if (e.reason === 'cleared') {
            this.burst(WORLD.birdX, state.bird.y, 60, 0xffe08a, { spread: 5, ttl: 1.4, glow: 2.2 });
          } else {
            this.burst(WORLD.birdX, state.bird.y, 40, 0xff6a4d, { spread: 4, ttl: 1.1, glow: 1.4 });
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
      post: !!this.composer,
    };
  }

  _rebuildGpuResources() {
    // CPU-side descriptors are all retained; re-upload everything.
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.attributes && Object.values(o.geometry.attributes).forEach((a) => { a.needsUpdate = true; });
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
    });
    this._pmrem = null;
    this._envDirty = true;
    this.postKey = null;
    this._sizeKey = null;
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
    this.composer?.dispose();
    this._envRT?.dispose();
    this._pmrem?.dispose();
    this.renderer.dispose();
  }
}
