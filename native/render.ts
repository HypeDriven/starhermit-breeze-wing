// The storybook sky on starhermit:scene, ported from the browser build's
// three.js render layer (js/render.js before the port): the procedural bird
// (sphere body and head, cone beak, eyes with catch-lights, tapered wing pods
// kicked by each flap), the terracotta gate pillars with their glowing trims
// (the next gate's brighter, with a slow shimmer), floating islands and soft
// clouds in parallax, the sky dome and the sea, the sun disc and its halo,
// burst particles and ambient motes, the predicted-arc ghost dots, the
// damped camera follow and shake, and the look per graphics level from
// quality.ts. It consumes rules snapshots and never mutates rules state.
//
// What changed from three.js, and why:
// - The sky dome's and the sea's GLSL ShaderMaterials are WGSL (the same
//   noise, cirrus, stars, aurora and glints); the glazed pillars'
//   onBeforeCompile tile courses are a WGSL surface hook.
// - Image-based lighting: the browser build rendered a sky-only scene
//   (its sky ShaderMaterial and an HDR sun disc) through
//   PMREMGenerator.fromScene; fromScene draws no custom programs, so the
//   same theme gradient and HDR sun are written into a small
//   latitude-longitude image and prefiltered with fromEquirectangular.
//   Each standard material gets it as its own envMap at the page's
//   envMapIntensity (r160 scaled scene.environment per material; the
//   engine, like r163+, does not).
// - flatShading (islands, plain clouds) is non-indexed geometry with face
//   normals; IcosahedronGeometry (cloud puffs) is a low-segment sphere;
//   MeshPhysicalMaterial's sheen is not drawn (its clearcoat is).
// - The EffectComposer chain (UnrealBloom, OutputPass, the grade
//   ShaderPass, SMAA / FXAA / canvas MSAA) is renderer.bloom / grade /
//   antialias; the grade's GLSL is the built-in display-space grade with
//   the same curve, saturation, tints and vignette.
// - Lights, the key light's fitted orthographic shadow box and its biases
//   are the page's own (three r160 units, engine.minor 28). The particles'
//   soft dot is a DataTexture (sRGB, as the page's CanvasTexture).
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, CircleGeometry, Color,
  ConeGeometry, CylinderGeometry, DataTexture, DirectionalLight, FloatType, Fog, Group, HemisphereLight, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, OrthographicCamera, PMREMGenerator,
  PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, RGBAFormat, ShaderMaterial, SphereGeometry, Sprite,
  SRGBColorSpace, SpriteMaterial, Vector3, renderer, scene,
} from "starhermit:scene";
import type { Material, MaterialHooks, Texture } from "starhermit:scene";
import { WORLD, gateGapY, currentGapHalf, currentSpeed, SIM_DT, createRng } from "../js/rules.js";
import { THEMES } from "../js/content.js";
import { MOTE_MAX, POOL_MAX, type Look } from "./quality.ts";

type Theme = (typeof THEMES)["day"];
interface Gate { i: number; x: number; baseY: number; oscPhase: number; passed: boolean }
export interface State {
  tick: number; phase: string; bird: { y: number; vy: number }; gates: Gate[]; gatesPassed: number;
  config: { params: { lift: number; gravity: number }; [k: string]: unknown }; terminal: { reason: string } | null;
}
export interface RulesEvent { type: string; gate?: number; centered?: boolean; reason?: string; streak?: number }

/** Framing constants (exposed, not magic offsets). */
export const FRAMING = { fov: 38, cameraZ: 17.5, cameraX: 3.2, lookAheadX: 1.4, followStiffness: 6.5, shakeMax: 0.22 };
const KEY_DIR = new Vector3(6, 12, 8).normalize();
const PI = Math.PI;
const SUN_POS = new Vector3(-30, 26, -120);

const camera = new PerspectiveCamera(FRAMING.fov, 16 / 9, 0.1, 220);
let look: Look | null = null;
let theme: Theme = THEMES.day;
let built = false;
let reducedMotion = false;
let assistArc = true;
let time = 0;
let shake = 0;
let camY = 0;
let flapKick = 0;
let flapPhase = 0;
let envSeed = 1;
let fxSeed = 22222;

// --- lights ---------------------------------------------------------------------------
const keyLight = new DirectionalLight(0xffffff, 2.2);
{
  const sc = keyLight.shadow.camera as OrthographicCamera;
  sc.left = -15; sc.right = 15; sc.top = 13; sc.bottom = -13; sc.near = 10; sc.far = 80;
  sc.updateProjectionMatrix();
}
keyLight.shadow.bias = -0.0006;
keyLight.shadow.normalBias = 0.02;
const hemi = new HemisphereLight(0xbfd8ff, 0x8a7a68, 0.9);

// --- the sky dome and the sea (WGSL ports of SKY_FRAG / SEA_FRAG) ------------------------
const NOISE = `
fn bw_hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn bw_noise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bw_hash(i), bw_hash(i + vec2f(1.0, 0.0)), f.x),
             mix(bw_hash(i + vec2f(0.0, 1.0)), bw_hash(i + vec2f(1.0, 1.0)), f.x), f.y);
}
fn bw_fbm(p0: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var p = p0;
  for (var i = 0; i < 4; i++) { v = v + a * bw_noise(p); p = p * 2.03; a = a * 0.5; }
  return v;
}
// Pre-compensate for ACES so the theme's sky hues stay saturated on screen.
fn bw_sky_comp(c: vec3f) -> vec3f {
  let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return mix(vec3f(lum), c, 1.3) * 0.92;
}
fn bw_sky_at(b: vec3f, t: vec3f, h: f32) -> vec3f { return bw_sky_comp(mix(b, t, smoothstep(-0.25, 0.45, h))); }
`;
const skyUniforms = {
  topColor: { value: new Color(0x4f9fe0) }, bottomColor: { value: new Color(0xeaf7ff) },
  sunColor: { value: new Color(0xffffff) }, cloudColor: { value: new Color(0xffffff) },
  sunDir: { value: SUN_POS.clone().normalize() },
  uTime: { value: 0 }, uDetail: { value: 0 }, uNight: { value: 0 }, uAurora: { value: 0 },
};
const SKY_FRAGMENT = `${NOISE}
fn fragment(f: Fragment) -> vec4f {
  let d = normalize(f.world);
  let h = d.y;
  var col = bw_sky_at(uniforms.bottomColor, uniforms.topColor, h);
  if (uniforms.uDetail > 0.5) {
    let sd = max(dot(d, uniforms.sunDir), 0.0);
    col = col + uniforms.sunColor * (pow(sd, 10.0) * 0.1 + pow(sd, 90.0) * 0.35);
    let uv = d.xz / (max(h, 0.03) + 0.35);
    let n = bw_fbm(vec2f(uv.x * 0.9 + uniforms.uTime * 0.012, uv.y * 2.6));
    let band = smoothstep(0.02, 0.2, h) * (1.0 - smoothstep(0.5, 0.9, h));
    col = mix(col, uniforms.cloudColor, smoothstep(0.52, 0.86, n) * band * 0.42 * (1.0 - 0.6 * uniforms.uNight));
    if (uniforms.uNight > 0.0) {
      let g = vec2f(atan2(d.z, d.x) * 90.0, h * 90.0);
      let id = floor(g);
      let r = bw_hash(id);
      let star = step(0.982, r) * max(0.0, 1.0 - length(fract(g) - 0.5) * 2.6);
      let tw = 0.65 + 0.35 * sin(uniforms.uTime * 2.2 + r * 60.0);
      col = col + vec3f(1.4, 1.35, 1.2) * star * tw * uniforms.uNight * smoothstep(0.06, 0.35, h);
    }
    if (uniforms.uAurora > 0.0) {
      let w = bw_fbm(vec2f(d.x * 3.0 + uniforms.uTime * 0.02, h * 4.0));
      let a = sin(d.x * 9.0 + w * 4.0 + uniforms.uTime * 0.08 + 1.3);
      var ribbon = pow(max(a, 0.0), 5.0) * smoothstep(0.1, 0.24, h) * (1.0 - smoothstep(0.55, 0.9, h));
      ribbon = ribbon * (0.55 + 0.45 * bw_noise(vec2f(d.x * 30.0, h * 3.0 - uniforms.uTime * 0.05)));
      let aur = mix(vec3f(0.05, 0.75, 0.35), vec3f(0.35, 0.2, 0.85), smoothstep(0.3, 0.7, h));
      col = mix(col, aur, clamp(ribbon * 0.75 * uniforms.uAurora, 0.0, 1.0));
    }
  }
  return vec4f(col, 1.0);
}`;
const skyDome = new Mesh(new SphereGeometry(160, 32, 20), new ShaderMaterial({
  uniforms: skyUniforms, fragmentShader: SKY_FRAGMENT, side: BackSide, depthWrite: false, fog: false,
}));
skyDome.renderOrder = -10;
skyDome.frustumCulled = false;
skyDome.noAO = true;

const seaUniforms = {
  nearColor: { value: new Color() }, skyBottom: { value: new Color() }, skyTop: { value: new Color() },
  glintColor: { value: new Color(0xffffff) }, uTime: { value: 0 }, uDetail: { value: 0 },
};
const SEA_FRAGMENT = `${NOISE}
fn fragment(f: Fragment) -> vec4f {
  let cam = camera_position();
  let dist = length(f.world.xz - cam.xz);
  let k = smoothstep(15.0, 120.0, dist);
  // Far edge matches the sky just below the horizon, so there is no seam.
  var col = mix(bw_sky_comp(uniforms.nearColor), bw_sky_at(uniforms.skyBottom, uniforms.skyTop, -0.06), k);
  if (uniforms.uDetail > 0.5) {
    let w = bw_noise(f.world.xz * vec2f(0.22, 0.6) + vec2f(uniforms.uTime * 0.25, uniforms.uTime * 0.07));
    let w2 = bw_noise(f.world.xz * vec2f(0.5, 1.3) - vec2f(uniforms.uTime * 0.18, 0.0));
    col = col + uniforms.glintColor * smoothstep(0.72, 0.95, w * 0.6 + w2 * 0.4) * 0.55 * (1.0 - k);
  }
  let alpha = 0.92 * (1.0 - smoothstep(95.0, 150.0, dist));
  return vec4f(col, alpha);
}`;
const sea = new Mesh(new PlaneGeometry(420, 320).rotateX(-PI / 2), new ShaderMaterial({
  uniforms: seaUniforms, fragmentShader: SEA_FRAGMENT, transparent: true, depthWrite: false, fog: false,
}));
sea.position.set(0, WORLD.floorY - 8, -100);
sea.renderOrder = -5;
sea.noAO = true;

// --- the sun disc and its halo -----------------------------------------------------------
let dotTex: DataTexture | null = null;
/** The soft round dot (the browser build's radial-gradient canvas: 1 → 0.85 at 35 % → 0). */
function dotTexture(): DataTexture {
  if (dotTex) return dotTex;
  const n = 64;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.min(1, Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2));
      const a = d < 0.35 ? 1 - (0.15 * d) / 0.35 : 0.85 * (1 - (d - 0.35) / 0.65);
      const o = (y * n + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = 255;
      px[o + 3] = Math.round(Math.max(0, a) * 255);
    }
  }
  dotTex = new DataTexture(px, n, n);
  dotTex.colorSpace = SRGBColorSpace;
  return dotTex;
}
const sunMat = new MeshBasicMaterial({ color: 0xfff6d8, fog: false, transparent: true, opacity: 0.9 });
const sun = new Mesh(new CircleGeometry(6, 40), sunMat);
sun.position.copy(SUN_POS);
sun.noAO = true;
const haloMat = new SpriteMaterial({ map: dotTexture(), color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false, fog: false, blending: AdditiveBlending });
const sunHalo = new Sprite(haloMat);
sunHalo.scale.set(22, 22, 1);
sunHalo.position.set(0, 0, -0.5);
sun.add(sunHalo);

// --- groups -------------------------------------------------------------------------------
const envGroup = new Group();
const gateGroup = new Group();
const birdGroup = new Group();
const ghostGroup = new Group();

// --- materials ------------------------------------------------------------------------------
type Lit = MeshStandardMaterial | MeshLambertMaterial;
interface StdParams { color: number | Color; roughness?: number; metalness?: number; emissive?: number | Color; emissiveIntensity?: number; vertexColors?: boolean; envMapIntensity?: number }
/** Lit material for the preset budget: Lambert on Low, PBR Standard above (as js/render.js _std/_env). */
/** The page's per-material reflections: the sky environment as the material's own envMap. */
function withEnv<M extends MeshStandardMaterial>(m: M): M {
  m.envMap = look?.reflections ? envTex : null;
  return m;
}
function std(p: StdParams): Lit {
  if (look!.budget.material !== "lambert") return withEnv(new MeshStandardMaterial({ envMapIntensity: 0.4, ...p }));
  const { roughness: _r, metalness: _m, envMapIntensity: _e, ...rest } = p;
  void _r; void _m; void _e;
  return new MeshLambertMaterial(rest);
}
/** Faceted (three.js flatShading): every triangle its own vertices and face normal. */
function flat(geo: BufferGeometry): BufferGeometry {
  const g = geo.toNonIndexed();
  g.computeVertexNormals();
  return g;
}

// --- the bird ---------------------------------------------------------------------------------
let birdMat: Lit | null = null;
let wingMat: Lit | null = null;
let wingL: Group = new Group();
let wingR: Group = new Group();
function disposeTree(o: { traverse(cb: (o: unknown) => void): void }): void {
  o.traverse((x) => {
    const m = x as Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) m.material.dispose();
  });
}
function buildBird(): void {
  for (const c of [...birdGroup.children]) { birdGroup.remove(c); disposeTree(c); }
  const t = theme;
  const detailed = look!.detailed;
  const physical = detailed && look!.budget.material !== "lambert";
  if (physical) {
    // The browser build's feather sheen (not drawn here) over a soft PBR body.
    birdMat = withEnv(new MeshPhysicalMaterial({ color: t.bird, roughness: 0.55, metalness: 0, envMapIntensity: 0.45 }));
    wingMat = withEnv(new MeshPhysicalMaterial({ color: t.wing, roughness: 0.5, metalness: 0, envMapIntensity: 0.45 }));
  } else {
    birdMat = std({ color: t.bird, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.4 });
    wingMat = std({ color: t.wing, roughness: 0.55, metalness: 0.05, envMapIntensity: 0.4 });
  }
  const shadowed = (m: Mesh): Mesh => { m.castShadow = true; m.receiveShadow = true; return m; };
  const body = shadowed(new Mesh(new SphereGeometry(0.5, detailed ? 32 : 24, detailed ? 24 : 18), birdMat));
  body.scale.set(1.15, 0.95, 0.9);
  const head = shadowed(new Mesh(new SphereGeometry(0.3, 18, 14), birdMat));
  head.position.set(0.38, 0.24, 0);
  const beakMat: Material = physical
    ? withEnv(new MeshPhysicalMaterial({ color: 0xff9d3c, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.25, envMapIntensity: 0.6 }))
    : std({ color: 0xff9d3c, roughness: 0.5, envMapIntensity: 0.4 });
  const beak = new Mesh(new ConeGeometry(0.11, 0.3, 10), beakMat);
  beak.rotation.z = -PI / 2;
  beak.position.set(0.72, 0.22, 0);
  const eyeMat = new MeshBasicMaterial({ color: 0x222831 });
  const eye = (z: number): Mesh => {
    const e = new Mesh(new SphereGeometry(0.06, 8, 8), eyeMat);
    e.position.set(0.52, 0.34, z);
    if (detailed) {
      // Catch-light: a tiny glint that reads as a living eye.
      const glint = new Mesh(new SphereGeometry(0.02, 6, 6), new MeshBasicMaterial({ color: 0xffffff }));
      glint.position.set(0.03, 0.025, 0.035 * Math.sign(z));
      e.add(glint);
    }
    return e;
  };
  // Wings: flattened tapered pods, pivot at the shoulder; the right one mirrored.
  const wing = (side: number): Group => {
    const g = new Group();
    const geo = new SphereGeometry(0.5, detailed ? 20 : 14, detailed ? 14 : 10);
    geo.scale(0.6, 0.18, 1.05);
    const w = shadowed(new Mesh(geo, wingMat!));
    w.position.set(-0.12, 0, 0.55 * side);
    g.add(w);
    g.position.set(-0.05, 0.12, 0.1 * side);
    return g;
  };
  wingL = wing(1);
  wingR = wing(-1);
  birdGroup.add(body, head, beak, eye(0.2), eye(-0.2), wingL, wingR);
}

// --- the ghost arc ------------------------------------------------------------------------------
const ghostDots: Mesh[] = [];
{
  const geo = new SphereGeometry(0.07, 8, 6);
  for (let i = 0; i < 12; i++) {
    // Each dot its own material: the fade sets opacity per dot.
    const d = new Mesh(geo, new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }));
    d.noAO = true;
    ghostGroup.add(d);
    ghostDots.push(d);
  }
}
function updateGhostArc(state: State): void {
  const show = state.phase !== "terminal" && !reducedMotion && assistArc;
  const p = state.config.params;
  let y = state.bird.y, vy = state.phase === "ready" ? p.lift : state.bird.vy + p.lift;
  for (let i = 0; i < ghostDots.length; i++) {
    const d = ghostDots[i]!;
    if (!show) { d.visible = false; continue; }
    d.visible = true;
    d.position.set(WORLD.birdX + 0.02 * i, y, 0);
    (d.material as MeshBasicMaterial).opacity = 0.45 * (1 - i / ghostDots.length);
    for (let k = 0; k < 4; k++) { vy -= p.gravity * SIM_DT; y += vy * SIM_DT; }
  }
}

// --- gates ---------------------------------------------------------------------------------------
// Glazed terracotta: coursed, slightly varied tiles by world height and angle
// around the pillar (the browser build's onBeforeCompile), under a clearcoat.
const TILE_HOOK: MaterialHooks = {
  vertex: `
fn vertex(v: Vertex) -> Vertex {
  var o = v;
  o.v0 = vec4f(v.position, 0.0);
  return o;
}`,
  surface: `
fn surface(s: Surface) -> Surface {
  var o = s;
  let row = floor(s.world.y * 0.85);
  let course = fract(s.world.y * 0.85);
  let ang = atan2(s.v0.z, s.v0.x);
  let cell = floor(ang * 1.6 + (row - 2.0 * floor(row * 0.5)) * 0.5);
  let h = fract(sin(row * 12.9898 + cell * 78.233) * 43758.5453);
  let grout = 1.0 - 0.16 * (1.0 - smoothstep(0.0, 0.07, course));
  o.base_color = vec4f(s.base_color.rgb * grout * (0.94 + 0.1 * h), s.base_color.a);
  return o;
}`,
};
interface GateMesh { group: Group; top: Mesh; bot: Mesh; topTrim: Mesh; botTrim: Mesh; trimMat: Lit }
const gateMeshes = new Map<number, GateMesh>();
let pillarGeo: BufferGeometry | null = null;
let trimGeo: BufferGeometry | null = null;
function gateBodyMaterial(): Material {
  const t = theme;
  if (!look!.detailed || look!.budget.material === "lambert") return std({ color: t.gate, roughness: 0.7, metalness: 0.05, envMapIntensity: 0.45 });
  const m = withEnv(new MeshPhysicalMaterial({
    color: t.gate, roughness: 0.62, metalness: 0, envMapIntensity: 0.55,
    clearcoat: look!.reflections ? 0.55 : 0, clearcoatRoughness: 0.3,
  }));
  m.hooks = TILE_HOOK;
  return m;
}
let gateBody: Material | null = null;
function makeGate(): GateMesh {
  if (!pillarGeo || !trimGeo) {
    const seg = look!.detailed ? 20 : 10;
    pillarGeo = new CylinderGeometry(0.55, 0.7, 1, seg);
    trimGeo = new CylinderGeometry(0.68, 0.68, 0.35, seg);
  }
  if (!gateBody) gateBody = gateBodyMaterial();
  const trimMat = std({ color: theme.gateTrim, roughness: 0.35, emissive: theme.gateTrim, emissiveIntensity: 0.25, envMapIntensity: 0.5 });
  const group = new Group();
  const top = new Mesh(pillarGeo, gateBody);
  const bot = new Mesh(pillarGeo, gateBody);
  const topTrim = new Mesh(trimGeo, trimMat);
  const botTrim = new Mesh(trimGeo, trimMat);
  top.castShadow = bot.castShadow = look!.shadows > 0;
  top.receiveShadow = bot.receiveShadow = topTrim.receiveShadow = botTrim.receiveShadow = true;
  group.add(top, bot, topTrim, botTrim);
  gateGroup.add(group);
  return { group, top, bot, topTrim, botTrim, trimMat };
}
function layoutGate(g: GateMesh, x: number, gapY: number, gapHalf: number): void {
  const ceil = WORLD.ceilY + 6, floor = WORLD.floorY - 6;
  const topH = ceil - (gapY + gapHalf);
  const botH = (gapY - gapHalf) - floor;
  g.top.scale.y = topH; g.top.position.set(x, gapY + gapHalf + topH / 2, 0);
  g.bot.scale.y = botH; g.bot.position.set(x, gapY - gapHalf - botH / 2, 0);
  g.topTrim.position.set(x, gapY + gapHalf + 0.1, 0);
  g.botTrim.position.set(x, gapY - gapHalf - 0.1, 0);
}
function clearGates(): void {
  for (const g of gateMeshes.values()) { gateGroup.remove(g.group); g.trimMat.dispose(); }
  gateMeshes.clear();
  gateBody?.dispose();
  gateBody = null;
  pillarGeo?.dispose(); trimGeo?.dispose();
  pillarGeo = trimGeo = null;
}

// --- islands and clouds -------------------------------------------------------------------------
interface Drifter { obj: Group; depth: number; drift: number; bobPhase: number; bobAmp: number; speed: number }
let islands: Drifter[] = [];
let clouds: Drifter[] = [];
function tint(geo: BufferGeometry, base: Color, fn: (x: number, y: number, z: number) => number): BufferGeometry {
  const pos = geo.getAttribute("position")!.array;
  const n = pos.length / 3;
  const col = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const k = fn(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
    col[v * 3] = base.r * k; col[v * 3 + 1] = base.g * k; col[v * 3 + 2] = base.b * k;
  }
  geo.setAttribute("color", new BufferAttribute(col, 3));
  return geo;
}
function buildEnvironment(seed: number): void {
  for (const c of [...envGroup.children]) { envGroup.remove(c); disposeTree(c); }
  const b = look!.budget;
  const detailed = look!.detailed;
  const rng = createRng((seed ^ 0xdec0) >>> 0); // decoration stream: cosmetic only
  const t = theme;
  islands = [];
  clouds = [];
  const rockMat = std({ color: detailed ? 0xffffff : t.islandRock, vertexColors: detailed, roughness: 0.95, envMapIntensity: 0.3 });
  const grassMat = std({ color: detailed ? 0xffffff : t.islandTop, vertexColors: detailed, roughness: 0.85, envMapIntensity: 0.3 });
  const rockCol = new Color(t.islandRock), grassCol = new Color(t.islandTop);
  for (let i = 0; i < b.islands; i++) {
    const isl = new Group();
    const s = 1.5 + rng.next() * 3.5;
    const h = s * 1.6;
    let rockGeo = flat(new ConeGeometry(s, h, 7 + Math.floor(rng.next() * 3), detailed ? 4 : 1));
    if (detailed) {
      const jit = rng.next() * 10;
      // Strata bands + a darker tip (the tip points down once turned over).
      rockGeo = tint(rockGeo, rockCol, (_x, y) => {
        const up = (y + h / 2) / h;
        const strata = 0.9 + 0.12 * Math.sin((y / h) * 18 + jit);
        return (1.08 - up * 0.5) * strata;
      });
    }
    const rock = new Mesh(rockGeo, rockMat);
    rock.rotation.x = PI;
    rock.position.y = -s * 0.8;
    let capGeo = flat(new CylinderGeometry(s, s * 0.92, s * 0.28, detailed ? 14 : 9));
    if (detailed) capGeo = tint(capGeo, grassCol, (_x, y) => (y > 0 ? 1.12 : 0.78));
    const cap = new Mesh(capGeo, grassMat);
    const tuftN = 2 + Math.floor(rng.next() * 3) + b.tufts;
    for (let k = 0; k < tuftN; k++) {
      let tuftGeo = flat(new ConeGeometry(s * 0.12, s * 0.5, 5));
      if (detailed) tuftGeo = tint(tuftGeo, grassCol, (_x, y) => 0.8 + ((y + s * 0.25) / (s * 0.5)) * 0.45);
      const tuft = new Mesh(tuftGeo, grassMat);
      tuft.position.set((rng.next() - 0.5) * s * 1.2, s * 0.35, (rng.next() - 0.5) * s * 0.6);
      isl.add(tuft);
    }
    isl.add(rock, cap);
    const depth = 18 + rng.next() * 55; // parallax distance
    isl.position.set(rng.range(-70, 70), rng.range(-26, 4), -depth);
    envGroup.add(isl);
    islands.push({ obj: isl, depth, drift: rng.range(0.2, 0.9), bobPhase: rng.range(0, PI * 2), bobAmp: rng.range(0.15, 0.5), speed: 0 });
  }
  // Clouds: self-lit so undersides stay soft; detailed = smooth, rounder puffs.
  const cloudMat = std({ color: t.cloud, roughness: 1, emissive: t.cloud, emissiveIntensity: detailed ? 0.12 : 0.1, envMapIntensity: 0.35 });
  const puffGeo = detailed
    ? new SphereGeometry(1, 8 + b.cloudDetail * 4, 6 + b.cloudDetail * 3)
    : flat(new SphereGeometry(1, 7, 5));
  for (let i = 0; i < b.clouds; i++) {
    const cl = new Group();
    const puffs = 3 + Math.floor(rng.next() * 4);
    for (let k = 0; k < puffs; k++) {
      const r = 0.8 + rng.next() * 1.6;
      const puff = new Mesh(puffGeo, cloudMat);
      puff.scale.set(r, detailed ? r * 0.82 : r, r);
      puff.position.set(k * r * 1.1 - puffs * 0.5, (rng.next() - 0.5) * 0.8, (rng.next() - 0.5) * 0.8);
      cl.add(puff);
    }
    const depth = 25 + rng.next() * 70;
    cl.position.set(rng.range(-80, 80), rng.range(2, 22), -depth);
    envGroup.add(cl);
    clouds.push({ obj: cl, depth, drift: 0, bobPhase: 0, bobAmp: 0, speed: rng.range(0.3, 1.0) });
  }
}

// --- particles and motes ---------------------------------------------------------------------------
interface Part { life: number; ttl: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number; g: number; b: number }
const parts: Part[] = [];
for (let i = 0; i < POOL_MAX; i++) parts.push({ life: 1, ttl: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1 });
let partCursor = 0;
let poolSize = 120;
const partPos = new Float32Array(POOL_MAX * 3);
const partCol = new Float32Array(POOL_MAX * 4);
const partGeo = new BufferGeometry();
partGeo.setAttribute("position", new BufferAttribute(partPos, 3));
partGeo.setAttribute("color", new BufferAttribute(partCol, 4));
const points = new Points(partGeo, new PointsMaterial({ size: 0.34, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true }));
points.frustumCulled = false;
const motePos = new Float32Array(MOTE_MAX * 3);
const moteSeeds: { ph: number; sp: number; amp: number }[] = [];
{
  const mrng = createRng(0x5eed1);
  for (let i = 0; i < MOTE_MAX; i++) {
    motePos[i * 3] = mrng.range(-16, 22); motePos[i * 3 + 1] = mrng.range(-10, 10); motePos[i * 3 + 2] = mrng.range(-9, 3);
    moteSeeds.push({ ph: mrng.range(0, 6.28), sp: mrng.range(0.3, 1.1), amp: mrng.range(0.1, 0.35) });
  }
}
const moteGeo = new BufferGeometry();
moteGeo.setAttribute("position", new BufferAttribute(motePos, 3));
const moteMat = new PointsMaterial({ size: 0.16, map: dotTexture(), color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true });
const motes = new Points(moteGeo, moteMat);
motes.frustumCulled = false;
function tintMotes(): void {
  const night = theme.id === "night";
  // Fireflies glow above 1.0 so bloom picks them up; day pollen stays subtle.
  moteMat.color.set(night ? 0xfff0a0 : 0xffffff).multiplyScalar(night ? 2.2 : 1);
  moteMat.opacity = night ? 0.75 : 0.3;
  moteMat.size = night ? 0.2 : 0.14;
}
function fxRng(): number { return (fxSeed = (Math.imul(fxSeed || 22222, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff; }
const burstColor = new Color(1, 1, 1);
function spawn(x: number, y: number, z: number, o: { vx?: number; vy?: number; vz?: number; spread?: number; ttl?: number; glow?: number }): void {
  const p = parts[partCursor]!;
  partCursor = (partCursor + 1) % poolSize;
  p.life = 0; p.ttl = o.ttl || 0.8;
  p.x = x; p.y = y; p.z = z;
  const spread = o.spread ?? 2.2;
  p.vx = (o.vx || 0) + (fxRng() - 0.5) * spread;
  p.vy = (o.vy || 0) + (fxRng() - 0.5) * spread;
  p.vz = (o.vz || 0) + (fxRng() - 0.5) * spread * 0.5;
  const glow = o.glow || 1;
  p.r = burstColor.r * glow; p.g = burstColor.g * glow; p.b = burstColor.b * glow;
}
function burst(x: number, y: number, n: number, color: number, o: { vx?: number; vy?: number; spread?: number; ttl?: number; glow?: number } = {}): void {
  if (!look) return;
  if (reducedMotion) n = Math.min(n, 6);
  else if (look.particles === "high") n = Math.round(n * 1.5);
  const count = Math.min(n, poolSize);
  burstColor.set(color);
  for (let i = 0; i < count; i++) spawn(x, y, 0.3, o);
}
function stepParticles(dt: number): void {
  for (let i = 0; i < poolSize; i++) {
    const p = parts[i]!;
    if (p.life >= p.ttl) { partPos[i * 3 + 1] = -9999; partCol[i * 4 + 3] = 0; continue; }
    p.life += dt;
    p.vy -= 6 * dt; // soft gravity on debris
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    const fade = Math.max(0, 1 - p.life / p.ttl);
    partPos[i * 3] = p.x; partPos[i * 3 + 1] = p.y; partPos[i * 3 + 2] = p.z;
    partCol[i * 4] = p.r; partCol[i * 4 + 1] = p.g; partCol[i * 4 + 2] = p.b; partCol[i * 4 + 3] = fade;
  }
  const pa = partGeo.getAttribute("position")!, ca = partGeo.getAttribute("color")!;
  pa.array = partPos; pa.needsUpdate = true;
  ca.array = partCol; ca.needsUpdate = true;
}
function stepMotes(dt: number, scroll: number): void {
  const n = look ? look.budget.motes : 0;
  if (!n) return;
  for (let i = 0; i < n; i++) {
    const s = moteSeeds[i]!;
    motePos[i * 3] = motePos[i * 3]! - (scroll * 0.35 + s.sp * 0.4) * dt;
    motePos[i * 3 + 1] = motePos[i * 3 + 1]! + Math.sin(time * s.sp + s.ph) * s.amp * dt;
    if (motePos[i * 3]! < -16) motePos[i * 3] = motePos[i * 3]! + 38;
  }
  motes.position.y = camY * 0.9;
  const a = moteGeo.getAttribute("position")!;
  a.array = motePos;
  a.needsUpdate = true;
}

// --- image-based lighting from the themed sky ----------------------------------------------------
let envTex: Texture | null = null;
let envKey = "";
/** The theme's sky gradient and HDR sun as a latitude-longitude image, prefiltered (the browser
 * build's sky-only PMREM scene). */
function updateEnvironment(): void {
  if (!look!.reflections) { applyEnv(); return; }
  const key = theme.id;
  if (key === envKey && envTex) { applyEnv(); return; }
  const w = 64, h = 32;
  const px = new Float32Array(w * h * 4);
  const top = new Color(theme.skyTop), bot = new Color(theme.horizon), sunC = new Color(theme.sun);
  const sd = KEY_DIR;
  const comp = (c: number, l: number): number => (l + (c - l) * 1.3) * 0.92;
  for (let row = 0; row < h; row++) {
    const lat = (0.5 - (row + 0.5) / h) * PI;
    const y = Math.sin(lat);
    const k = Math.min(1, Math.max(0, (y + 0.25) / 0.7));
    const s = k * k * (3 - 2 * k);
    for (let c = 0; c < w; c++) {
      const lon = ((c + 0.5) / w - 0.5) * 2 * PI;
      const dx = Math.cos(lat) * Math.sin(lon), dz = -Math.cos(lat) * Math.cos(lon);
      let r = bot.r + (top.r - bot.r) * s, g = bot.g + (top.g - bot.g) * s, b = bot.b + (top.b - bot.b) * s;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = comp(r, l); g = comp(g, l); b = comp(b, l);
      const dot = dx * sd.x + y * sd.y + dz * sd.z;
      if (dot > 0.985) { r = sunC.r * 6; g = sunC.g * 6; b = sunC.b * 6; }
      const o = (row * w + c) * 4;
      px[o] = Math.max(0, r); px[o + 1] = Math.max(0, g); px[o + 2] = Math.max(0, b); px[o + 3] = 1;
    }
  }
  try {
    const next = new PMREMGenerator().fromEquirectangular(new DataTexture(px, w, h, RGBAFormat, FloatType)).texture;
    envTex?.dispose();
    envTex = next;
    envKey = key;
    applyEnv();
  } catch (e) {
    console.warn("environment:", e instanceof Error ? e.message : String(e));
    envTex = null;
    applyEnv();
  }
}

function applyEnv(): void {
  scene.traverse((o) => {
    const m = (o as Mesh).material as unknown;
    for (const x of Array.isArray(m) ? m : [m]) if (x instanceof MeshStandardMaterial) withEnv(x);
  });
}

// --- building and the look --------------------------------------------------------------------------
function build(): void {
  built = true;
  scene.add(keyLight, keyLight.target, hemi, skyDome, sea, sun, envGroup, gateGroup, birdGroup, ghostGroup, points, motes);
  renderer.camera = camera;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  camera.position.set(FRAMING.cameraX, 0, FRAMING.cameraZ);
}

/** The look for the frame's graphics level; rebuilds what it changes, cheap when nothing did. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  if (!built) build();
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = next.shadows;
  skyUniforms.uDetail.value = next.skyDetailed ? 1 : 0;
  seaUniforms.uDetail.value = next.skyDetailed ? 1 : 0;
  sunHalo.visible = next.skyDetailed;
  const meshes = !prev || prev.detailed !== next.detailed || prev.reflections !== next.reflections || prev.budget.material !== next.budget.material || prev.shadows !== next.shadows;
  if (meshes) { buildBird(); clearGates(); }
  if (meshes || !prev || prev.budget.islands !== next.budget.islands || prev.budget.clouds !== next.budget.clouds || prev.budget.tufts !== next.budget.tufts || prev.budget.cloudDetail !== next.budget.cloudDetail) buildEnvironment(envSeed);
  poolSize = Math.max(16, next.budget.pool);
  if (partCursor >= poolSize) partCursor = 0;
  for (let i = poolSize; i < POOL_MAX; i++) { parts[i]!.life = parts[i]!.ttl; partPos[i * 3 + 1] = -9999; partCol[i * 4 + 3] = 0; }
  partGeo.setDrawRange(0, poolSize);
  moteGeo.setDrawRange(0, next.budget.motes);
  motes.visible = next.budget.motes > 0;
  envKey = "";
  updateEnvironment();
  // Post effects, as the browser build's composer chain per preset. High
  // threshold: only the sun, next-gate trims, sparkles and fireflies bloom.
  renderer.bloom = next.bloom ? { strength: 0.4, radius: 0.45, threshold: 0.9, resolution: 0.5 } : null;
  // The grade ShaderPass after OutputPass: 0.2 of a smoothstep S-curve, +14 %
  // saturation, warm highlights / cool shadows, vignette 0.2.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.1, saturation: 1.14,
    shadows: [0.97, 0.99, 1.04], highlights: [1.03, 1.0, 0.97], split: [0.25, 0.8],
    vignette: { amount: 0.2, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
}

export function setTheme(themeId: string): void {
  theme = (THEMES as Record<string, Theme>)[themeId] ?? THEMES.day;
  const t = theme;
  skyUniforms.topColor.value.set(t.skyTop);
  skyUniforms.bottomColor.value.set(t.horizon);
  skyUniforms.sunColor.value.set(t.sun);
  skyUniforms.cloudColor.value.set(t.cloud);
  skyUniforms.uNight.value = t.id === "night" ? 1 : t.id === "aurora" ? 0.45 : 0;
  skyUniforms.uAurora.value = t.id === "aurora" ? 1 : 0;
  scene.fog = new Fog(t.haze, 40, 140);
  keyLight.color.set(t.keyLight);
  hemi.color.set(t.ambient);
  // Lighter ground bounce so undersides of clouds and islands never go muddy.
  hemi.groundColor.set(t.islandRock).lerp(new Color(t.haze), 0.5);
  sunMat.color.set(t.sun);
  haloMat.color.set(t.sun).multiplyScalar(1.2);
  // Bright daytime skies need less halo; night moons glow more.
  haloMat.opacity = t.id === "night" || t.id === "aurora" ? 0.28 : 0.14;
  seaUniforms.skyBottom.value.set(t.horizon);
  seaUniforms.skyTop.value.set(t.skyTop);
  seaUniforms.nearColor.value.set(t.haze).lerp(new Color(t.skyTop), 0.35).multiplyScalar(0.85);
  seaUniforms.glintColor.value.set(t.sun);
  tintMotes();
  if (!look) return;
  buildBird();
  clearGates();
  updateEnvironment();
}

/** (Re)builds the decoration for a new session (or the title's idle sky). */
export function prepareSession(config: { theme: string; seed: number }): void {
  if (!look) return;
  setTheme(config.theme);
  envSeed = config.seed;
  buildEnvironment(config.seed);
  camY = 0;
  fxSeed = (config.seed ^ 0xf1e1d) >>> 0;
  for (const p of parts) p.life = p.ttl;
}

export function setReducedMotion(on: boolean): void { reducedMotion = on; }
export function setAssistArc(on: boolean): void { assistArc = on; }

/** Consumes logical events → cosmetic effects (the event hierarchy). */
export function onEvents(events: RulesEvent[], state: State): void {
  if (!look) return;
  for (const e of events) {
    switch (e.type) {
      case "flap":
        flapKick = 1;
        burst(WORLD.birdX, state.bird.y - 0.4, 5, theme.wing, { vy: -1.5, spread: 1.4, ttl: 0.5 });
        break;
      case "pass": {
        const g = state.gates.find((x) => x.i === e.gate);
        if (g) burst(g.x, state.bird.y, e.centered ? 26 : 12, e.centered ? 0xffe08a : theme.gateTrim, { ttl: 0.9, glow: e.centered ? 2.4 : 1.3 });
        break;
      }
      case "centered":
        shake = Math.max(shake, 0.15);
        break;
      case "terminal":
        if (e.reason === "cleared") burst(WORLD.birdX, state.bird.y, 60, 0xffe08a, { spread: 5, ttl: 1.4, glow: 2.2 });
        else { burst(WORLD.birdX, state.bird.y, 40, 0xff6a4d, { spread: 4, ttl: 1.1, glow: 1.4 }); shake = 1; }
        break;
      default: break;
    }
  }
}

/** One frame from an immutable snapshot pair and the interpolation alpha; `dt` the frame's (scaled) seconds. */
export function render(prev: State | null, cur: State, alpha: number, dtRaw: number, width: number, height: number): void {
  if (!built || !look) return;
  const dt = Math.min(0.1, Math.max(0, dtRaw));
  time += dt;
  const calm = reducedMotion;

  // Portrait: widen the field of view so the playable band stays visible.
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  const hFov = 2 * Math.atan(Math.tan((FRAMING.fov * PI / 180) / 2) * aspect) * 180 / PI;
  camera.fov = hFov < 62 ? 2 * Math.atan(Math.tan((62 * PI / 180) / 2) / aspect) * 180 / PI : FRAMING.fov;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();

  // Bird: interpolated position, pose from velocity.
  const by = prev ? prev.bird.y + (cur.bird.y - prev.bird.y) * alpha : cur.bird.y;
  birdGroup.position.set(WORLD.birdX, by, 0);
  birdGroup.rotation.z = Math.max(-0.9, Math.min(0.6, cur.bird.vy * 0.06));
  flapKick = Math.max(0, flapKick - dt * 3.2);
  flapPhase += dt * (4 + flapKick * 26);
  const wingAngle = Math.sin(flapPhase) * (0.25 + flapKick * 0.85);
  wingL.rotation.x = -wingAngle;
  wingR.rotation.x = wingAngle;
  if (cur.phase === "terminal" && cur.terminal && cur.terminal.reason !== "cleared") {
    birdGroup.rotation.z = Math.max(-1.4, birdGroup.rotation.z - dt * 4);
  }

  // Gates from the snapshot.
  const seen = new Set<number>();
  const cfg = cur.config as never;
  const gapHalf = currentGapHalf(cfg, cur.gatesPassed);
  // Next-gate trims glow (HDR when bloom is on so the glow halos); a slow
  // shimmer keeps them alive unless motion is reduced.
  const shimmer = calm ? 0 : Math.sin(time * 3.2) * 0.12;
  const nearGlow = (look.bloom ? 1.25 : 0.5) + shimmer;
  for (const g of cur.gates) {
    seen.add(g.i);
    let mesh = gateMeshes.get(g.i);
    if (!mesh) { mesh = makeGate(); gateMeshes.set(g.i, mesh); }
    const pg = prev ? prev.gates.find((p) => p.i === g.i) : null;
    const gx = pg ? pg.x + (g.x - pg.x) * alpha : g.x;
    layoutGate(mesh, gx, gateGapY(cfg, g, cur.tick), gapHalf);
    const near = !g.passed && g.x > WORLD.birdX - 1 && g.x < WORLD.birdX + 9;
    mesh.trimMat.emissiveIntensity = near ? nearGlow : 0.25;
  }
  for (const [i, mesh] of gateMeshes) {
    if (!seen.has(i)) { gateGroup.remove(mesh.group); mesh.trimMat.dispose(); gateMeshes.delete(i); }
  }

  updateGhostArc(cur);

  // Camera: damped follow, shake.
  const targetY = Math.max(WORLD.floorY + 2, Math.min(WORLD.ceilY - 2, by));
  camY += (targetY - camY) * Math.min(1, FRAMING.followStiffness * dt);
  let sx = 0, sy = 0;
  if (shake > 0 && !reducedMotion) {
    shake = Math.max(0, shake - dt * 2.4);
    const s = shake * FRAMING.shakeMax;
    sx = (fxRng() - 0.5) * s; sy = (fxRng() - 0.5) * s;
  }
  camera.position.set(FRAMING.cameraX + sx, camY + sy, FRAMING.cameraZ);
  camera.lookAt(FRAMING.cameraX + FRAMING.lookAheadX, camY * 0.92, 0);
  // The key light follows the play band (snapped so shadow edges do not shimmer).
  const snap = Math.round(camY * 2) / 2;
  keyLight.target.position.set(2, snap, 0);
  keyLight.position.copy(KEY_DIR).multiplyScalar(40).add(keyLight.target.position);

  // Environment drift: parallax + gentle bob (a quarter speed when motion is reduced).
  const scrollSpeed = currentSpeed(cfg, cur.gatesPassed);
  const motion = reducedMotion ? 0.25 : 1;
  for (const isl of islands) {
    const par = 12 / isl.depth;
    isl.obj.position.x -= scrollSpeed * par * isl.drift * dt * motion;
    if (isl.obj.position.x < -85) isl.obj.position.x += 170;
    isl.obj.position.y += Math.sin(time * 0.5 + isl.bobPhase) * isl.bobAmp * dt * motion;
  }
  for (const cl of clouds) {
    const par = 8 / cl.depth;
    cl.obj.position.x -= (scrollSpeed * par + cl.speed) * dt * motion;
    if (cl.obj.position.x < -95) cl.obj.position.x += 190;
  }
  // Sky / sea / motes ambient animation (frozen under reduced motion).
  if (!calm) {
    skyUniforms.uTime.value += dt;
    seaUniforms.uTime.value += dt;
    stepMotes(dt, scrollSpeed);
  }
  stepParticles(dt);
  // The sun follows the camera gently (keeps the composition stable).
  sun.position.x = camera.position.x - 34;
}
