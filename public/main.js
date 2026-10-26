/* Wonder Meadow — the 3D world, twilight edition.
 * A floating island at dusk: gloomy but comforting. Deterministic world gen
 * (same island for everyone), fake blob shadows and Lambert materials keep it
 * light enough for mobile GPUs.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ---------------------------------------------------------------- constants
const ISLAND_R = 120;            // radius of the floating island disc
const FOLD_START = 110;          // where the ground curls down into the cliff
const WALKABLE_R = 102;
const PAN_LIMIT = 95;
const POLL_MS = 4000;
const WALK_SPEED = 1.15;         // everyone wanders slowly now
const RIVER_WIDTH = 7;

// River path: cliff waterfall pool (west) winding out over the island's edge (east).
const RIVER_POINTS = [
  new THREE.Vector3(-88, 0, -22),
  new THREE.Vector3(-60, 0, -34),
  new THREE.Vector3(-25, 0, -22),
  new THREE.Vector3(10, 0, -38),
  new THREE.Vector3(48, 0, -30),
  new THREE.Vector3(85, 0, -40),
  new THREE.Vector3(118, 0, -36),
];
const riverCurve = new THREE.CatmullRomCurve3(RIVER_POINTS);
const riverSamples = riverCurve.getSpacedPoints(80);

// ------------------------------------------------------------ tiny helpers
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function distToRiver(x, z) {
  let min = Infinity;
  for (const p of riverSamples) {
    const dx = p.x - x, dz = p.z - z;
    const d = dx * dx + dz * dz;
    if (d < min) min = d;
  }
  return Math.sqrt(min);
}
function segsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const o = (px, pz, qx, qz, rx, rz) => Math.sign((qx - px) * (rz - pz) - (qz - pz) * (rx - px));
  return (
    o(ax, az, bx, bz, cx, cz) !== o(ax, az, bx, bz, dx, dz) &&
    o(cx, cz, dx, dz, ax, az) !== o(cx, cz, dx, dz, bx, bz)
  );
}
function crossesRiver(a, b) {
  for (let i = 0; i < riverSamples.length - 1; i++) {
    const p = riverSamples[i], q = riverSamples[i + 1];
    if (segsIntersect(a.x, a.z, b.x, b.z, p.x, p.z, q.x, q.z)) return true;
  }
  return false;
}
const easeInOut = (t) => t * t * (3 - 2 * t);
const easeInCubic = (t) => t * t * t;

// hills used by both the ground mesh and heightAt() so feet stay on the grass
const HILL_BUMPS = (() => {
  const rng = mulberry32(11);
  const bumps = [];
  for (let i = 0; i < 22; i++) {
    const a = rng() * Math.PI * 2;
    const r = 72 + rng() * 30;
    bumps.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, r: 13 + rng() * 20, h: 1.5 + rng() * 4 });
  }
  return bumps;
})();

function heightAt(x, z) {
  const r = Math.hypot(x, z);
  const band = THREE.MathUtils.smoothstep(r, 62, 84) * (1 - THREE.MathUtils.smoothstep(r, 100, FOLD_START));
  if (band <= 0) return 0;
  const suppress = THREE.MathUtils.smoothstep(distToRiver(x, z), 5, 16);
  let y = 0;
  for (const b of HILL_BUMPS) {
    const d = Math.hypot(x - b.x, z - b.z);
    if (d < b.r) y += Math.cos((d / b.r) * Math.PI * 0.5) * b.h;
  }
  return y * band * suppress;
}

// keep-out circles for scattering props (filled in as landmarks are built)
const KEEP_OUT = [{ x: -97, z: -22, r: 20 }]; // waterfall cliff
function inKeepOut(x, z) {
  return KEEP_OUT.some((k) => Math.hypot(x - k.x, z - k.z) < k.r);
}
function isWalkable(x, z) {
  return (
    Math.hypot(x, z) < WALKABLE_R &&
    distToRiver(x, z) > RIVER_WIDTH / 2 + 2.5 &&
    Math.hypot(x + 97, z + 22) > 20
  );
}

// --------------------------------------------------------------- renderer
const canvas = document.getElementById('world');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x565080, 130, 420);

const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 1100);
camera.position.set(30, 26, 54);

// opening fly-in: start far above the clouds and descend to the meadow.
// A tap skips it; controls stay off until the descent lands.
const intro = {
  t: 0,
  dur: 4.6,
  from: new THREE.Vector3(-160, 300, 260),
  to: camera.position.clone(),
  active: true,
};
camera.position.copy(intro.from);

const controls = new OrbitControls(camera, canvas);
controls.enabled = false; // handed back when the fly-in lands
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.minDistance = 12;
controls.maxDistance = 150;
controls.maxPolarAngle = Math.PI * 0.58; // allowed to peek below the horizon — it IS a floating island
controls.minPolarAngle = Math.PI * 0.06;
controls.target.set(0, 0, 0);

// Smooth wheel / trackpad zoom. OrbitControls applies every wheel event instantly, and a
// Mac trackpad flick (or a pinch, which arrives as ctrl+wheel) fires a burst of events,
// so the camera slammed from max to min in one gesture. Instead, wheel input moves a
// target distance (in log space, so it feels the same near and far) and the camera eases
// toward it every frame. The target may only run so far ahead of the camera, so momentum
// scrolling keeps zooming at a steady pace instead of piling up. Touch pinch is left to
// OrbitControls: it follows your fingers, so it was never snappy.
const ZOOM = { perPixel: 0.0008, maxStep: 0.15, maxLead: 0.25, ease: 6 };
const zoom = { target: null, gestureFrom: 0 };
function zoomBy(logStep) {
  const now = camera.position.distanceTo(controls.target);
  const from = zoom.target ?? now;
  const lead = THREE.MathUtils.clamp(Math.log(from / now) + logStep, -ZOOM.maxLead, ZOOM.maxLead);
  zoom.target = THREE.MathUtils.clamp(now * Math.exp(lead), controls.minDistance, controls.maxDistance);
}
// capture on window runs before OrbitControls' own listener on the canvas
window.addEventListener('wheel', (e) => {
  if (e.target !== canvas) return;
  e.preventDefault();
  e.stopPropagation();
  if (!controls.enabled || focus.tween) return;
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;               // lines -> px
  else if (e.deltaMode === 2) dy *= innerHeight; // pages -> px
  if (e.ctrlKey) dy *= 3;                        // pinch deltas are tiny
  zoomBy(THREE.MathUtils.clamp(dy * ZOOM.perPixel, -ZOOM.maxStep, ZOOM.maxStep));
}, { passive: false, capture: true });
// Safari reports a trackpad pinch as gesture events (and would zoom the whole page)
canvas.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  zoom.gestureFrom = zoom.target ?? camera.position.distanceTo(controls.target);
});
canvas.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (!controls.enabled || focus.tween || !e.scale) return;
  const now = camera.position.distanceTo(controls.target);
  zoomBy(Math.log(zoom.gestureFrom / e.scale / (zoom.target ?? now)));
});
function updateZoom(rawDt) {
  if (zoom.target == null) return;
  if (!controls.enabled || focus.tween) { zoom.target = null; return; } // a fly-in owns the camera
  const offset = _zv.copy(camera.position).sub(controls.target);
  const now = offset.length();
  const next = now + (zoom.target - now) * Math.min(1, rawDt * ZOOM.ease);
  camera.position.copy(controls.target).addScaledVector(offset, next / now);
  if (Math.abs(zoom.target - next) < 0.01) zoom.target = null;
}
const _zv = new THREE.Vector3();

// The camera may not dip under the grass, through the hills, or into the
// waterfall cliff. Same surface the ground mesh uses (hills + rim fold),
// plus a bump for the west cliff rocks, which heightAt() knows nothing about.
function cameraSurfaceY(x, z) {
  const r = Math.hypot(x, z);
  const fold = THREE.MathUtils.smoothstep(r, FOLD_START, ISLAND_R);
  let y = heightAt(x, z) - fold * fold * 34;
  const dCliff = Math.hypot(x + 92, z + 22);
  y += 15 * (1 - THREE.MathUtils.smoothstep(dCliff, 6, 24));
  return y;
}
function keepCameraAboveGround() {
  const c = camera.position;
  if (Math.hypot(c.x, c.z) >= ISLAND_R) return; // off the island's edge, the sky is all yours
  const minY = cameraSurfaceY(c.x, c.z) + 1.4;
  if (c.y < minY) c.y = minY;
}

// ------------------------------------------------------------------ light
const hemiLight = new THREE.HemisphereLight(0x8a86c9, 0x2e4a3f, 0.85);
scene.add(hemiLight);
const ambientLight = new THREE.AmbientLight(0x4a4670, 0.4); // lift the shadows into soft purple instead of black
scene.add(ambientLight);
const moonLight = new THREE.DirectionalLight(0xb8c4ff, 0.55);
moonLight.position.set(-70, 90, -40);
scene.add(moonLight);

// sky dome — one set of vertex colours per mood (top, horizon, below); the mood
// cross-fade blends between them
const SKY = {
  limbo: [0x1f2350, 0x9a86d4, 0x35305e], // twilight
  cozy: [0x7d78c4, 0xffc6a2, 0xb393b8],  // golden hour: periwinkle above, peach at the horizon
};
const skyCols = {};
let skyGeo;
{
  const geo = new THREE.SphereGeometry(520, 24, 14);
  const pos = geo.attributes.position;
  const c = new THREE.Color();
  for (const [name, [topHex, horizonHex, belowHex]] of Object.entries(SKY)) {
    const top = new THREE.Color(topHex), horizon = new THREE.Color(horizonHex), below = new THREE.Color(belowHex);
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) / 520; // -1..1
      if (t >= 0) c.copy(horizon).lerp(top, easeInOut(Math.min(1, t * 1.6)));
      else c.copy(horizon).lerp(below, easeInOut(Math.min(1, -t * 2.2)));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    skyCols[name] = colors;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(skyCols.limbo.slice(), 3));
  skyGeo = geo;
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })));
}

// stars
let starsMat;
{
  const n = 450;
  const pts = new Float32Array(n * 3);
  const rng = mulberry32(99);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const y = rng() * 0.85 + 0.08;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    pts[i * 3] = Math.cos(a) * rr * 480;
    pts[i * 3 + 1] = y * 480;
    pts[i * 3 + 2] = Math.sin(a) * rr * 480;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  starsMat = new THREE.PointsMaterial({
    color: 0xdde4ff, size: 2.2, sizeAttenuation: false, transparent: true,
    opacity: 0.85, fog: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.Points(geo, starsMat));
}

// soft moon (it warms into a low sun in the cozy mood)
let moonSprite;
{
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  g.addColorStop(0, 'rgba(235,240,255,1)');
  g.addColorStop(0.25, 'rgba(210,220,255,0.9)');
  g.addColorStop(1, 'rgba(200,210,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), fog: false, depthWrite: false }));
  sprite.scale.setScalar(90);
  sprite.position.set(-260, 190, -260);
  scene.add(sprite);
  moonSprite = sprite;
}

// ------------------------------------------------------------------ ground
function makeGrassTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#54815c';
  ctx.fillRect(0, 0, 256, 256);
  const rng = mulberry32(7);
  for (let i = 0; i < 2600; i++) {
    const shade = rng();
    ctx.fillStyle = shade < 0.5 ? 'rgba(62,105,72,0.5)' : shade < 0.85 ? 'rgba(103,150,105,0.5)' : 'rgba(126,168,120,0.55)';
    ctx.fillRect(rng() * 256, rng() * 256, 2 + rng() * 3, 2 + rng() * 3);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

{
  // a square plane elliptically mapped into a disc, so the island is round
  const geo = new THREE.PlaneGeometry(ISLAND_R * 2, ISLAND_R * 2, 84, 84);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = [];
  const grassTint = new THREE.Color(0xffffff);
  const cliffTint = new THREE.Color(0x5a4a63); // dusky rock where the ground folds over
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / ISLAND_R, v = pos.getZ(i) / ISLAND_R;
    const x = u * Math.sqrt(1 - (v * v) / 2) * ISLAND_R;
    const z = v * Math.sqrt(1 - (u * u) / 2) * ISLAND_R;
    const r = Math.hypot(x, z);
    let y = heightAt(x, z);
    if (distToRiver(x, z) < RIVER_WIDTH / 2 + 1.5) y -= 0.9; // river bed carve
    const fold = THREE.MathUtils.smoothstep(r, FOLD_START, ISLAND_R);
    y -= fold * fold * 34; // the rim curls down into the island's side
    pos.setXYZ(i, x, y, z);
    c.copy(grassTint).lerp(cliffTint, fold);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: makeGrassTexture(), vertexColors: true }));
  mesh.name = 'ground';
  scene.add(mesh);
}

// the island's rocky underside — an inverted jagged cone
{
  const geo = new THREE.ConeGeometry(ISLAND_R + 1, 72, 42, 5, true);
  geo.rotateX(Math.PI); // apex points down
  geo.translate(0, -32 - 36, 0); // base ring ≈ y -32, apex ≈ y -104
  const pos = geo.attributes.position;
  const rng = mulberry32(41);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const depth = THREE.MathUtils.clamp((-32 - y) / 72, 0, 1); // 0 at rim, 1 at apex
    const jag = depth * 9;
    pos.setX(i, pos.getX(i) + (rng() - 0.5) * jag);
    pos.setZ(i, pos.getZ(i) + (rng() - 0.5) * jag);
    pos.setY(i, y + (rng() - 0.5) * depth * 6);
  }
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x5d5172, flatShading: true })));
}

// --------------------------------------------------------------- the river
const waterMat = (() => {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#41689c';
  ctx.fillRect(0, 0, 128, 128);
  const rng = mulberry32(21);
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = rng() < 0.5 ? 'rgba(200,215,255,0.35)' : 'rgba(120,160,230,0.5)';
    ctx.lineWidth = 1 + rng() * 2;
    const y = rng() * 128;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(40, y + rng() * 8 - 4, 90, y + rng() * 8 - 4, 128, y);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: tex, transparent: true, opacity: 0.88 });
})();

function ribbonAlongCurve(width, y, uRepeat) {
  const pts = riverCurve.getSpacedPoints(60);
  const positions = [], uvs = [], indices = [];
  const foldDrop = (x, z) => {
    const f = THREE.MathUtils.smoothstep(Math.hypot(x, z), FOLD_START, ISLAND_R);
    return f * f * 34; // same curl as the ground, so the water pours over the lip
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const t = i / (pts.length - 1);
    const tangent = riverCurve.getTangentAt(t);
    const nx = -tangent.z, nz = tangent.x;
    const ax = p.x + nx * width / 2, az = p.z + nz * width / 2;
    const bx = p.x - nx * width / 2, bz = p.z - nz * width / 2;
    positions.push(ax, y - foldDrop(ax, az), az);
    positions.push(bx, y - foldDrop(bx, bz), bz);
    uvs.push(t * uRepeat, 0, t * uRepeat, 1);
    if (i > 0) {
      const a = (i - 1) * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

scene.add(new THREE.Mesh(ribbonAlongCurve(RIVER_WIDTH + 3.5, 0.04, 1), new THREE.MeshLambertMaterial({ color: 0x8a7a6a })));
const riverMesh = new THREE.Mesh(ribbonAlongCurve(RIVER_WIDTH, 0.14, 14), waterMat);
scene.add(riverMesh);

// ----------------------------------------------------------- the waterfalls
const waterfallMats = [];
const mistSprites = [];
const mistTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(220,225,255,0.9)');
  g.addColorStop(1, 'rgba(220,225,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();
function addMist(x, y, z, count, spread) {
  for (let i = 0; i < count; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, transparent: true, opacity: 0.4, depthWrite: false }));
    s.position.set(x + (Math.random() - 0.5) * spread, y, z + (Math.random() - 0.5) * spread);
    s.userData = { seed: Math.random() * Math.PI * 2, base: s.position.clone() };
    s.scale.setScalar(2 + Math.random() * 3);
    scene.add(s);
    mistSprites.push(s);
  }
}
const fallTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(95,120,175,0.8)';
  ctx.fillRect(0, 0, 64, 128);
  const rng = mulberry32(31);
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(175,195,240,0.85)' : 'rgba(75,105,165,0.8)';
    ctx.fillRect(rng() * 64, rng() * 128, 2 + rng() * 3, 10 + rng() * 26);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();
function makeFallMat(opacity, repeatY) {
  const tex = fallTex.clone();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, repeatY);
  const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  waterfallMats.push(mat);
  return mat;
}

// west cliff waterfall
{
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x6e6480, flatShading: true });
  const rng = mulberry32(31);
  const cliff = new THREE.Group();
  for (let i = 0; i < 14; i++) {
    const r = 4 + rng() * 4;
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), rockMat);
    rock.position.set(-101 + rng() * 8, rng() * 10, -34 + rng() * 24);
    rock.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    rock.scale.y = 0.7 + rng() * 0.5;
    cliff.add(rock);
  }
  scene.add(cliff);

  for (let layer = 0; layer < 2; layer++) {
    const fall = new THREE.Mesh(new THREE.PlaneGeometry(8 - layer * 1.5, 13), makeFallMat(layer ? 0.5 : 0.85, 2));
    fall.position.set(-84.5 + layer * 0.8, 6.5, -22);
    fall.rotation.y = Math.PI / 2;
    scene.add(fall);
  }

  const pool = new THREE.Mesh(new THREE.CircleGeometry(8.5, 24), waterMat.clone());
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(-82, 0.16, -22);
  scene.add(pool);

  addMist(-84, 0.5, -23, 10, 7);
}

// east rim waterfall — the river curls over the lip and pours off into the sky
{
  const end = riverCurve.getPointAt(1);
  const tan = riverCurve.getTangentAt(1).normalize();
  const fall = new THREE.Mesh(new THREE.PlaneGeometry(RIVER_WIDTH, 34), makeFallMat(0.6, 4));
  fall.position.set(end.x + tan.x * 1.5, -45, end.z + tan.z * 1.5);
  fall.lookAt(fall.position.clone().add(new THREE.Vector3(tan.x, 0, tan.z)));
  scene.add(fall);
  addMist(end.x + tan.x * 2, -60, end.z + tan.z * 2, 8, 6);
}

// ---------------------------------------------------------------- landmarks
const woodMat = new THREE.MeshLambertMaterial({ color: 0x6b4d38 });
const woodDarkMat = new THREE.MeshLambertMaterial({ color: 0x54402f });
const glowLampMat = new THREE.MeshBasicMaterial({ color: 0xffc978 });

function addLantern(parent, x, y, z, intensity = 12, range = 14) {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 2.2, 6), woodDarkMat);
  post.position.set(x, y + 1.1, z);
  parent.add(post);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), glowLampMat);
  bulb.position.set(x, y + 2.25, z);
  parent.add(bulb);
  const light = new THREE.PointLight(0xffb066, intensity, range);
  light.position.set(x, y + 2.3, z);
  parent.add(light);
  return light;
}

// activity spots the wanderers can visit
// { pos, yaw, kind, height?, approach? } — height/approach for decks (dock, bridge)
const activitySpots = [];

// --- the camp ---
let fireLight, flameGroup;
{
  const CAMP = { x: 34, z: 30 };
  KEEP_OUT.push({ x: CAMP.x, z: CAMP.z, r: 14 });
  const camp = new THREE.Group();
  camp.position.set(CAMP.x, 0, CAMP.z);

  const tentColors = [0x8f5f86, 0x5a6d9c];
  for (let i = 0; i < 2; i++) {
    const tent = new THREE.Mesh(
      new THREE.ConeGeometry(2.5, 2.8, 4),
      new THREE.MeshLambertMaterial({ color: tentColors[i], flatShading: true })
    );
    tent.position.set(i === 0 ? -4.5 : 3.5, 1.4, i === 0 ? -3 : -5);
    tent.rotation.y = Math.PI / 4 + i * 0.5;
    camp.add(tent);
  }

  // campfire: stone ring, crossed logs, flickering flames
  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x7d7590, flatShading: true });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 0), stoneMat);
    stone.position.set(Math.cos(a) * 1.1, 0.2, Math.sin(a) * 1.1);
    camp.add(stone);
  }
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.6, 6), woodMat);
    log.rotation.z = Math.PI / 2;
    log.rotation.y = i * 1.05;
    log.position.y = 0.25;
    camp.add(log);
  }
  flameGroup = new THREE.Group();
  const flameColors = [0xff8c42, 0xffb25e, 0xffe08a];
  for (let i = 0; i < 3; i++) {
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.5 - i * 0.13, 1.1 - i * 0.25, 6),
      new THREE.MeshBasicMaterial({ color: flameColors[i], transparent: true, opacity: 0.85 })
    );
    flame.position.y = 0.55 + i * 0.18;
    flameGroup.add(flame);
  }
  camp.add(flameGroup);
  fireLight = new THREE.PointLight(0xff9c50, 26, 26);
  fireLight.position.set(0, 1.4, 0);
  camp.add(fireLight);

  // log benches
  for (const [bx, bz, ry] of [[2.6, 1.8, 0.6], [-2.4, 2.2, -0.5]]) {
    const bench = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.4, 7), woodDarkMat);
    bench.rotation.z = Math.PI / 2;
    bench.rotation.y = ry;
    bench.position.set(bx, 0.3, bz);
    camp.add(bench);
  }
  scene.add(camp);

  // warming-by-the-fire spots, facing the flames
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const px = CAMP.x + Math.cos(a) * 2.9, pz = CAMP.z + Math.sin(a) * 2.9;
    activitySpots.push({
      pos: new THREE.Vector3(px, 0, pz),
      yaw: Math.atan2(CAMP.x - px, CAMP.z - pz),
      kind: 'campfire',
      occupant: null,
    });
  }
}

// --- the crop farm ---
{
  const FARM = { x: -38, z: 32 };
  KEEP_OUT.push({ x: FARM.x, z: FARM.z, r: 14 });
  const farm = new THREE.Group();
  farm.position.set(FARM.x, 0, FARM.z);

  const soil = new THREE.Mesh(new THREE.BoxGeometry(15, 0.5, 10), new THREE.MeshLambertMaterial({ color: 0x453349 }));
  soil.position.y = 0.25;
  farm.add(soil);

  const cropMats = [
    new THREE.MeshLambertMaterial({ color: 0x5f8f4e, flatShading: true }),
    new THREE.MeshLambertMaterial({ color: 0x7fa252, flatShading: true }),
  ];
  const rng = mulberry32(55);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 7; col++) {
      const crop = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35 + rng() * 0.2, 0), cropMats[(row + col) % 2]);
      crop.position.set(-6 + col * 2, 0.75, -3.6 + row * 2.4);
      crop.scale.y = 1.2;
      farm.add(crop);
    }
  }
  // fence posts + rails
  const half = { x: 8.5, z: 6 };
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 1.1, 5), woodDarkMat);
    post.position.set(sx * half.x, 0.55, sz * half.z);
    farm.add(post);
  }
  for (const [w, d, px, pz] of [[17, 0.12, 0, -6], [17, 0.12, 0, 6], [0.12, 12, -8.5, 0], [0.12, 12, 8.5, 0]]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), woodMat);
    rail.position.set(px, 0.85, pz);
    farm.add(rail);
  }
  addLantern(farm, 9.5, 0, -6.5, 10, 13);
  scene.add(farm);

  // tending-the-crops spots
  for (const [px, pz, fx, fz] of [[-44, 40, 0, -1], [-32, 40, 0, -1], [-38, 24, 0, 1]]) {
    activitySpots.push({
      pos: new THREE.Vector3(px, 0, pz),
      yaw: Math.atan2(fx, fz),
      kind: 'farm',
      occupant: null,
    });
  }
}

// --- bridges over the river ---
const bridges = [];
function buildBridge(t) {
  const p = riverCurve.getPointAt(t);
  const tan = riverCurve.getTangentAt(t);
  const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
  const half = RIVER_WIDTH / 2 + 3.2;
  const a = p.clone().addScaledVector(n, half); a.y = 0;
  const b = p.clone().addScaledVector(n, -half); b.y = 0;

  const g = new THREE.Group();
  const span = a.distanceTo(b);
  const planks = 9;
  for (let i = 0; i < planks; i++) {
    const q = (i + 0.5) / planks;
    const pt = a.clone().lerp(b, q);
    const arch = Math.sin(q * Math.PI) * 1.0;
    const plank = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.18, span / planks + 0.12), woodMat);
    plank.position.set(pt.x, 0.25 + arch, pt.z);
    plank.lookAt(b.x, 0.25 + Math.sin(Math.min(1, q + 0.06) * Math.PI) * 1.0, b.z);
    g.add(plank);
    if (i % 2 === 0) {
      for (const side of [-1, 1]) {
        const baluster = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 5), woodDarkMat);
        const off = new THREE.Vector3(b.z - a.z, 0, a.x - b.x).normalize().multiplyScalar(side * 1.1);
        baluster.position.set(pt.x + off.x, 0.7 + arch, pt.z + off.z);
        g.add(baluster);
      }
    }
  }
  for (const side of [-1, 1]) {
    const off = new THREE.Vector3(b.z - a.z, 0, a.x - b.x).normalize().multiplyScalar(side * 1.1);
    const railGeo = new THREE.BufferGeometry();
    // simple arched rail out of segments
    const railPts = [];
    for (let i = 0; i <= 12; i++) {
      const q = i / 12;
      const pt = a.clone().lerp(b, q);
      railPts.push(new THREE.Vector3(pt.x + off.x, 1.15 + Math.sin(q * Math.PI) * 1.0, pt.z + off.z));
    }
    const rail = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts), 12, 0.08, 5),
      woodMat
    );
    g.add(rail);
    railGeo.dispose?.();
  }
  scene.add(g);

  KEEP_OUT.push({ x: a.x, z: a.z, r: 5 }, { x: b.x, z: b.z, r: 5 });
  const bridge = { a, b, mid: a.clone().lerp(b, 0.5).setY(0) };
  bridges.push(bridge);
  return bridge;
}
{
  const b1 = buildBridge(0.40);
  const b2 = buildBridge(0.76);
  // gazing-from-the-bridge spot (mid-span, facing downstream)
  const tan = riverCurve.getTangentAt(0.76);
  activitySpots.push({
    pos: b2.mid.clone(),
    yaw: Math.atan2(tan.x, tan.z),
    kind: 'bridge',
    height: 1.25,
    approach: b2.a.clone(),
    occupant: null,
  });
  void b1;
}

// --- the fishing dock ---
{
  const t = 0.58;
  const p = riverCurve.getPointAt(t);
  const tan = riverCurve.getTangentAt(t);
  let n = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
  if (n.z > 0) n.negate(); // dock reaches in from the south bank
  const bank = p.clone().addScaledVector(n, RIVER_WIDTH / 2 + 2); bank.y = 0;
  const tip = p.clone().addScaledVector(n, -0.5); tip.y = 0;
  KEEP_OUT.push({ x: bank.x, z: bank.z, r: 8 });

  const dock = new THREE.Group();
  const dir = tip.clone().sub(bank);
  const len = dir.length();
  dir.normalize();
  const planks = 5;
  for (let i = 0; i < planks; i++) {
    const q = (i + 0.5) / planks;
    const pt = bank.clone().addScaledVector(dir, q * len);
    const plank = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, len / planks - 0.15), woodMat);
    plank.position.set(pt.x, 0.55, pt.z);
    plank.lookAt(tip.x, 0.55, tip.z);
    dock.add(plank);
  }
  for (const q of [0.15, 0.9]) {
    for (const side of [-1, 1]) {
      const off = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(side * 1.0);
      const pt = bank.clone().addScaledVector(dir, q * len);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 1.6, 6), woodDarkMat);
      post.position.set(pt.x + off.x, 0.05, pt.z + off.z);
      dock.add(post);
    }
  }
  addLantern(dock, tip.x - dir.x, 0.62, tip.z - dir.z, 14, 15);
  scene.add(dock);

  // fishing spots at the dock's end, gazing over the water
  for (const side of [-0.7, 0.7]) {
    const off = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(side);
    activitySpots.push({
      pos: new THREE.Vector3(tip.x + off.x - dir.x * 0.6, 0, tip.z + off.z - dir.z * 0.6),
      yaw: Math.atan2(dir.x, dir.z),
      kind: 'fishing',
      height: 0.62,
      approach: bank.clone(),
      occupant: null,
    });
  }
}

// --- a quiet stargazing hill ---
{
  for (const [px, pz] of [[62, 58], [66, 53]]) {
    activitySpots.push({
      pos: new THREE.Vector3(px, 0, pz),
      yaw: Math.atan2(px, pz), // facing out over the edge, at the sky
      kind: 'stargaze',
      occupant: null,
    });
  }
}

// --- lonely ledges on the island's rim (frowning wanderers only) ---
// Not part of activitySpots: nobody picks these while making their rounds.
// Once in a while a frowning wanderer drifts out here to sit alone at the
// edge, knees up, and stare at the sky below the island.
const edgeSitSpots = [];
{
  const EDGE_R = 110; // right where the ground starts to curl over the rim
  for (const a of [0.6, 1.9, 2.7, -1.5, -2.3]) { // spread apart, away from the river mouth and the waterfall
    const x = Math.cos(a) * EDGE_R, z = Math.sin(a) * EDGE_R;
    edgeSitSpots.push({
      pos: new THREE.Vector3(x, 0, z),
      yaw: Math.atan2(x, z),  // facing out over the void
      kind: 'edgesit',
      height: -0.22,          // settled onto the lip, not standing on it
      approach: new THREE.Vector3(x, 0, z).multiplyScalar(100 / EDGE_R),
      occupant: null,
    });
  }
}

// ------------------------------------------------------- trees, rocks, etc.
const worldRng = mulberry32(1337);
function scatterSpot(minRiverDist, maxR = ISLAND_R - 16) {
  for (let tries = 0; tries < 40; tries++) {
    const a = worldRng() * Math.PI * 2;
    const r = Math.sqrt(worldRng()) * maxR;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (distToRiver(x, z) > minRiverDist && !inKeepOut(x, z)) return { x, z };
  }
  return null;
}

{
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5d4433 });
  const leafColors = [0x3f7a52, 0x35694a, 0x2f5e45, 0x467f4f];
  for (let i = 0; i < 42; i++) {
    const spot = scatterSpot(9);
    if (!spot) continue;
    const tree = new THREE.Group();
    const h = 2.2 + worldRng() * 2.4;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, h, 6), trunkMat);
    trunk.position.y = h / 2;
    tree.add(trunk);
    const leafMat = new THREE.MeshLambertMaterial({ color: leafColors[Math.floor(worldRng() * leafColors.length)], flatShading: true });
    const blobs = 2 + Math.floor(worldRng() * 2);
    for (let b = 0; b < blobs; b++) {
      const r = 1.6 + worldRng() * 1.6;
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leafMat);
      leaf.position.set((worldRng() - 0.5) * 1.6, h + b * r * 0.9, (worldRng() - 0.5) * 1.6);
      tree.add(leaf);
    }
    tree.position.set(spot.x, heightAt(spot.x, spot.z), spot.z);
    tree.rotation.y = worldRng() * Math.PI * 2;
    scene.add(tree);
  }

  const rockMat = new THREE.MeshLambertMaterial({ color: 0x776f8c, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const spot = scatterSpot(2);
    if (!spot) continue;
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6 + worldRng() * 1.8, 0), rockMat);
    rock.position.set(spot.x, heightAt(spot.x, spot.z) + 0.2, spot.z);
    rock.scale.y = 0.55 + worldRng() * 0.4;
    rock.rotation.y = worldRng() * Math.PI * 2;
    scene.add(rock);
  }

  // pale night flowers
  const flowerColors = [0xd9d4ff, 0xbfd8ff, 0xffffff, 0xe8c8ef];
  const flowerGeo = new THREE.SphereGeometry(0.16, 5, 4);
  for (const color of flowerColors) {
    const inst = new THREE.InstancedMesh(flowerGeo, new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.25 }), 60);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 60; i++) {
      const spot = scatterSpot(5) || { x: 0, z: 0 };
      m.makeTranslation(spot.x, heightAt(spot.x, spot.z) + 0.18, spot.z);
      inst.setMatrixAt(i, m);
    }
    scene.add(inst);
  }

  // grass tufts
  const tuftGeo = new THREE.ConeGeometry(0.22, 0.85, 4);
  const tuftInst = new THREE.InstancedMesh(tuftGeo, new THREE.MeshLambertMaterial({ color: 0x3f6b4a }), 220);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 220; i++) {
    const spot = scatterSpot(5) || { x: 0, z: 0 };
    m.makeRotationY(worldRng() * Math.PI).setPosition(spot.x, heightAt(spot.x, spot.z) + 0.4, spot.z);
    tuftInst.setMatrixAt(i, m);
  }
  scene.add(tuftInst);
}

// dusky clouds
const clouds = [];
let cloudMat;
{
  cloudMat = new THREE.MeshLambertMaterial({ color: 0x8b84b8, transparent: true, opacity: 0.55, flatShading: true });
  for (let i = 0; i < 7; i++) {
    const cloud = new THREE.Group();
    const puffs = 3 + Math.floor(worldRng() * 3);
    for (let p = 0; p < puffs; p++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(3 + worldRng() * 4, 1), cloudMat);
      puff.position.set(p * 4.5 - puffs, worldRng() * 2, worldRng() * 3);
      puff.scale.y = 0.6;
      cloud.add(puff);
    }
    cloud.position.set((worldRng() * 2 - 1) * 200, 45 + worldRng() * 35, (worldRng() * 2 - 1) * 200);
    cloud.userData.speed = 0.5 + worldRng() * 0.7;
    scene.add(cloud);
    clouds.push(cloud);
  }
}

// small floating rock islets drifting around the big island
const floaters = [];
{
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x5a4d68, flatShading: true });
  const capMat = new THREE.MeshLambertMaterial({ color: 0x4c7355, flatShading: true });
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Group();
    const r = 3 + worldRng() * 4;
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), rockMat);
    rock.scale.y = 1.15;
    g.add(rock);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.02, r * 1.14, r * 0.35, 8), capMat);
    cap.position.y = r * 0.68; // sits down over the rock like a grassy crown
    g.add(cap);
    const a = worldRng() * Math.PI * 2;
    const dist = 145 + worldRng() * 55;
    g.position.set(Math.cos(a) * dist, -15 + worldRng() * 45, Math.sin(a) * dist);
    g.userData = { seed: worldRng() * Math.PI * 2, baseY: g.position.y, spin: (worldRng() - 0.5) * 0.1 };
    scene.add(g);
    floaters.push(g);
  }
  // a couple of rocks hanging beneath the island
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Group();
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(4 + worldRng() * 5, 0), rockMat);
    g.add(rock);
    const a = worldRng() * Math.PI * 2;
    g.position.set(Math.cos(a) * (40 + worldRng() * 50), -55 - worldRng() * 30, Math.sin(a) * (40 + worldRng() * 50));
    g.userData = { seed: worldRng() * Math.PI * 2, baseY: g.position.y, spin: (worldRng() - 0.5) * 0.06 };
    scene.add(g);
    floaters.push(g);
  }
}

// fireflies
let fireflyGeo, fireflyData;
{
  const n = 55;
  const pts = new Float32Array(n * 3);
  fireflyData = [];
  const rng = mulberry32(77);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * 95;
    const d = {
      bx: Math.cos(a) * r, by: 0.8 + rng() * 2.2, bz: Math.sin(a) * r,
      sx: 0.3 + rng() * 0.5, sy: 0.5 + rng() * 0.8, sz: 0.3 + rng() * 0.5,
      px: rng() * Math.PI * 2, py: rng() * Math.PI * 2, pz: rng() * Math.PI * 2,
    };
    fireflyData.push(d);
    pts[i * 3] = d.bx; pts[i * 3 + 1] = d.by; pts[i * 3 + 2] = d.bz;
  }
  fireflyGeo = new THREE.BufferGeometry();
  fireflyGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const flies = new THREE.Points(fireflyGeo, new THREE.PointsMaterial({
    map: mistTex, color: 0xffd97a, size: 0.8, transparent: true, opacity: 0.9,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(flies);
}

// --------------------------------------------------- rain (a private shower)
// A small curtain of drizzle that follows the camera around — the rest of the
// island stays dry, so the gloom sits exactly where you are looking. Drops
// live in world space and wrap into a camera-centred box, so orbiting the
// meadow doesn't drag the rain sideways with the view.
const RAIN_COUNT = 420;
const RAIN_RADIUS = 26;   // half-size of the box around the camera, in XZ
const RAIN_TOP = 19;      // vertical span, relative to the camera
const RAIN_BOTTOM = -15;
const RAIN_SPEED = 30;
const RAIN_WIND_X = 1.6, RAIN_WIND_Z = 1.1; // a light slant, matching the drifting clouds
let rainGeo, rainHeads, rainSpeeds, rain;
{
  rainHeads = new Float32Array(RAIN_COUNT * 3);
  rainSpeeds = new Float32Array(RAIN_COUNT);
  for (let i = 0; i < RAIN_COUNT; i++) {
    rainHeads[i * 3] = camera.position.x + (Math.random() * 2 - 1) * RAIN_RADIUS;
    rainHeads[i * 3 + 1] = camera.position.y + RAIN_BOTTOM + Math.random() * (RAIN_TOP - RAIN_BOTTOM);
    rainHeads[i * 3 + 2] = camera.position.z + (Math.random() * 2 - 1) * RAIN_RADIUS;
    rainSpeeds[i] = 0.65 + Math.random() * 0.5;
  }
  rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_COUNT * 6), 3));
  rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
    color: 0xa8b4dd, transparent: true, opacity: 0.34, depthWrite: false,
  }));
  rain.frustumCulled = false; // the box always straddles the camera anyway
  scene.add(rain);
}

function updateRain(dt) {
  const p = rainGeo.attributes.position.array;
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  const span = RAIN_TOP - RAIN_BOTTOM, size = RAIN_RADIUS * 2;
  const wrap = (v, lo, range) => lo + ((((v - lo) % range) + range) % range);
  for (let i = 0; i < RAIN_COUNT; i++) {
    const s = rainSpeeds[i];
    const x = wrap(rainHeads[i * 3] + RAIN_WIND_X * s * dt, cx - RAIN_RADIUS, size);
    const y = wrap(rainHeads[i * 3 + 1] - RAIN_SPEED * s * dt, cy + RAIN_BOTTOM, span);
    const z = wrap(rainHeads[i * 3 + 2] + RAIN_WIND_Z * s * dt, cz - RAIN_RADIUS, size);
    rainHeads[i * 3] = x; rainHeads[i * 3 + 1] = y; rainHeads[i * 3 + 2] = z;
    const k = 0.028 * s; // streak stretched back along the fall direction
    p[i * 6] = x; p[i * 6 + 1] = y; p[i * 6 + 2] = z;
    p[i * 6 + 3] = x - RAIN_WIND_X * s * k;
    p[i * 6 + 4] = y + RAIN_SPEED * s * k;
    p[i * 6 + 5] = z - RAIN_WIND_Z * s * k;
  }
  rainGeo.attributes.position.needsUpdate = true;
}

// ------------------------------------------------------------- characters
function makeMarkTexture(char, color) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 96px "Avenir Next", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 12;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.strokeText(char, 64, 70);
  ctx.fillStyle = color;
  ctx.fillText(char, 64, 70);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const QUESTION_MARK_TEX = makeMarkTexture('?', '#ff9f43');
const SPARKLE_TEX = makeMarkTexture('✦', '#f6b93b');
const COLOR_KEEPER = 0x8b8f99; // the keeper's own wanderer is a quiet grey, with the same golden glow as everyone
const KEEPER_GLOW = 0.6; // the keeper's wanderer always glows like a mostly-ripe one

// ---- how a ripening wanderer looks ------------------------------------------
// Every tunable lives here so the look is easy to restyle (e.g. per mood) later.
// "ripeness" runs 0..1 = answers so far / answers needed.
const RIPE = {
  glow: 0.35,         // body self-glow (in its own colour) at full ripeness; ascension then goes gold
  haloOpacity: 0.55,  // additive golden halo behind them at full ripeness
  haloScale: 5.2,     // halo size in world units at full ripeness
  maxSparks: 5,       // one orbiting ✦ per answer, up to this many
  pulse: 0.3,         // extra flash when a new answer lands
};
const HALO_TEX = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,214,110,0.95)');
  g.addColorStop(0.4, 'rgba(255,190,80,0.35)');
  g.addColorStop(1, 'rgba(255,180,70,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
})();

// what the server says about the rules (updated on every poll)
const world = { rules: { maxAnswers: 3, windowMs: 24 * 60 * 60 * 1000 } };

// two colours only: feminine pink, masculine blue
const COLOR_FEMININE = 0xe35aa8;
const COLOR_MASCULINE = 0x58a8f0;

// blocky bodies — geometries are shared by every wanderer
const CHAR_GEO = {
  head: new RoundedBoxGeometry(1.15, 1.0, 0.95, 4, 0.22),
  body: new RoundedBoxGeometry(0.95, 0.85, 0.62, 4, 0.18),
  arm: new RoundedBoxGeometry(0.24, 0.52, 0.24, 3, 0.09),
  leg: new RoundedBoxGeometry(0.32, 0.32, 0.34, 3, 0.1),
  eye: new THREE.SphereGeometry(0.062, 8, 8),
  mouth: new THREE.TorusGeometry(0.21, 0.062, 8, 14, Math.PI), // half-ring: ∩ frown, flipped ∪ smile
};

const blobShadowTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  g.addColorStop(0, 'rgba(10,15,30,0.4)');
  g.addColorStop(1, 'rgba(10,15,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();

const characters = new Map(); // id -> char record
const charactersGroup = new THREE.Group();
scene.add(charactersGroup);

function makePerson(question) {
  const seed = hashString(question.id);
  const rng = mulberry32(seed);

  const group = new THREE.Group();
  const isF = question.color ? question.color === 'f' : seed % 2 === 0;
  const bodyColor = question.keeper ? COLOR_KEEPER : isF ? COLOR_FEMININE : COLOR_MASCULINE;
  const bodyMat = new THREE.MeshLambertMaterial({
    color: bodyColor, transparent: true,
    // glows in its OWN colour as answers arrive (gold would wash pink/blue out to beige);
    // the gold comes from the halo + sparkles, and from the ascension itself
    emissive: bodyColor, emissiveIntensity: 0,
  });
  const faceMat = new THREE.MeshLambertMaterial({ color: 0x3a3630, transparent: true });

  // stubby legs
  const legs = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(CHAR_GEO.leg, bodyMat);
    leg.position.set(side * 0.24, 0.16, 0);
    group.add(leg);
    legs.push(leg);
  }

  const body = new THREE.Mesh(CHAR_GEO.body, bodyMat);
  body.position.y = 0.68;
  group.add(body);

  const arms = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(CHAR_GEO.arm, bodyMat);
    arm.position.set(side * 0.59, 0.72, 0);
    arm.rotation.z = side * 0.08;
    group.add(arm);
    arms.push(arm);
  }

  // big blocky head, in its own group so it can tilt up to look at the camera
  const headGroup = new THREE.Group();
  headGroup.position.y = 1.6;
  group.add(headGroup);
  const head = new THREE.Mesh(CHAR_GEO.head, bodyMat);
  headGroup.add(head);

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(CHAR_GEO.eye, faceMat);
    eye.position.set(side * 0.25, 0.09, 0.46);
    headGroup.add(eye);
  }
  const mouth = new THREE.Mesh(CHAR_GEO.mouth, faceMat);
  mouth.position.set(0, -0.15, 0.45);
  mouth.scale.z = 0.5; // embossed on the face, not poking through it
  if ((question.expression || 'smile') === 'smile') mouth.rotation.z = Math.PI; // ∩ → ∪
  headGroup.add(mouth);

  const mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: QUESTION_MARK_TEX, transparent: true, depthWrite: false }));
  mark.scale.setScalar(1.35);
  mark.position.y = 3.05;
  group.add(mark);

  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.8),
    new THREE.MeshBasicMaterial({ map: blobShadowTex, transparent: true, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.05;
  group.add(blob);

  // deterministic spawn spot per question id
  let x = 0, z = 0;
  for (let i = 0; i < 60; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * 92;
    x = Math.cos(a) * r;
    z = Math.sin(a) * r;
    if (isWalkable(x, z)) break;
  }
  group.position.set(x, heightAt(x, z), z);
  group.scale.setScalar(0.01); // pops in

  const rec = {
    id: question.id,
    text: question.text,
    group, mark, blob, rng, headGroup,
    body, legs, arms,
    isFrown: (question.expression || 'smile') === 'frown',
    keeper: !!question.keeper, // the keeper's own wanderer: it never ripens on a timer and only ascends when the keeper says so
    home: new THREE.Vector3(x, 0, z),
    state: 'idle',
    stateTime: rng() * 3,
    waypoints: [],
    legFrom: null, legFromY: 0, legLen: 1,
    baseY: heightAt(x, z),
    activity: null,        // spot currently claimed (traveling to or busy at)
    actTime: 0,
    gazeT: 0,              // seconds left of staring at the camera
    gazeCool: 4 + rng() * 18,
    bobSeed: rng() * Math.PI * 2,
    spawnT: 0,
    ascending: null,
    // ripening: answers so far, eased 0..1 look, flash on a new answer, glow right now
    answerCount: 0, ripe: 0, ripeTarget: 0, ripePulse: 0, glowNow: 0, fxFade: 1,
    fx: { halo: null, sparks: [] },
    materials: [bodyMat, faceMat, mark.material, blob.material],
    meshes: [head, body, ...arms, ...legs],
  };
  charactersGroup.add(group);
  characters.set(question.id, rec);

  // golden halo behind them (hidden until there is a first answer); taps pass through it
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: HALO_TEX, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
  }));
  halo.position.y = 1.3;
  halo.visible = false;
  halo.renderOrder = -1; // drawn before the body, so it glows BEHIND them instead of washing them out
  halo.raycast = () => {};
  group.add(halo);
  rec.fx.halo = halo;
  setRipeness(rec, question.answerCount || 0, true);
  return rec;
}

// ---- ripening visuals -------------------------------------------------------
// Set how many answers a wanderer has. `instant` skips the easing/flash (first sighting).
function setRipeness(rec, count, instant = false) {
  const prev = rec.answerCount;
  rec.answerCount = count;
  // the keeper's wanderer has no answer cap to fill, so it just glows steadily
  rec.ripeTarget = rec.keeper ? KEEPER_GLOW : Math.min(1, count / Math.max(1, world.rules.maxAnswers));
  while (rec.fx.sparks.length < Math.min(count, RIPE.maxSparks)) { // one orbiting ✦ per answer
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: SPARKLE_TEX, transparent: true, depthWrite: false }));
    s.scale.setScalar(0.42);
    s.raycast = () => {};
    rec.group.add(s);
    rec.fx.sparks.push(s);
  }
  if (instant) rec.ripe = rec.ripeTarget;
  else if (count > prev) rec.ripePulse = 1; // a little flash when a new answer lands
}

// called every frame for every wanderer (including while ascending)
function updateRipeFx(rec, dt, elapsed) {
  rec.ripe += (rec.ripeTarget - rec.ripe) * Math.min(1, dt * 2.2);
  rec.ripePulse = Math.max(0, rec.ripePulse - dt * 1.4);
  const k = rec.ripe, pulse = rec.ripePulse, fade = rec.fxFade;
  rec.glowNow = k * RIPE.glow + pulse * RIPE.pulse;
  if (!rec.ascending) rec.materials[0].emissiveIntensity = rec.glowNow; // body paint (ascension takes over with clones)

  const halo = rec.fx.halo;
  halo.visible = (k > 0.01 || pulse > 0.01) && fade > 0.01;
  if (halo.visible) {
    halo.material.opacity = (RIPE.haloOpacity * k + pulse * 0.35) * fade * (0.85 + 0.15 * Math.sin(elapsed * 2 + rec.bobSeed));
    halo.scale.setScalar(RIPE.haloScale * (0.8 + 0.4 * k) * (1 + pulse * 0.25));
  }
  const n = rec.fx.sparks.length;
  for (let i = 0; i < n; i++) {
    const s = rec.fx.sparks[i];
    const ang = elapsed * 0.9 + (i * Math.PI * 2) / n;
    s.position.set(Math.cos(ang) * 0.95, 2.15 + Math.sin(elapsed * 1.3 + i * 1.7) * 0.15, Math.sin(ang) * 0.95);
    s.material.opacity = 0.9 * fade;
  }
}

// tuck into a hunched, knees-up sit — or back out of it
function setSitPose(rec, sitting) {
  for (const leg of rec.legs) {
    leg.position.y = sitting ? 0.24 : 0.16;
    leg.position.z = sitting ? 0.3 : 0;
  }
  for (const arm of rec.arms) arm.rotation.x = sitting ? -0.55 : 0; // wrapped around the knees
  rec.body.rotation.x = sitting ? 0.12 : 0; // a small hunch
}

function releaseSpot(rec) {
  if (rec.activity && rec.activity.occupant === rec.id) rec.activity.occupant = null;
  if (rec.activity?.kind === 'edgesit') setSitPose(rec, false);
  rec.activity = null;
}

// waypoint routing — cross the river politely, via a bridge
function routeWaypoints(from, dest) {
  const wps = [];
  if (crossesRiver(from, dest) && bridges.length) {
    let best = null;
    for (const br of bridges) {
      const d1 = from.distanceTo(br.a) + br.a.distanceTo(br.b) + br.b.distanceTo(dest);
      const d2 = from.distanceTo(br.b) + br.b.distanceTo(br.a) + br.a.distanceTo(dest);
      const [near, far, total] = d1 <= d2 ? [br.a, br.b, d1] : [br.b, br.a, d2];
      if (!best || total < best.total) best = { near, far, total };
    }
    wps.push({ pos: best.near.clone() });
    wps.push({ pos: best.far.clone(), bridge: true });
  }
  wps.push({ pos: dest.clone() });
  return wps;
}

function startLeg(rec) {
  const wp = rec.waypoints[0];
  rec.legFrom = rec.group.position.clone();
  rec.legFromY = rec.baseY;
  rec.legLen = Math.max(0.001, Math.hypot(wp.pos.x - rec.legFrom.x, wp.pos.z - rec.legFrom.z));
}

function beginStroll(rec) {
  for (let i = 0; i < 25; i++) {
    const a = rec.rng() * Math.PI * 2;
    const r = 5 + rec.rng() * 18;
    const x = rec.home.x + Math.cos(a) * r;
    const z = rec.home.z + Math.sin(a) * r;
    if (isWalkable(x, z) && !crossesRiver(rec.group.position, new THREE.Vector3(x, 0, z))) {
      rec.waypoints = [{ pos: new THREE.Vector3(x, 0, z) }];
      rec.state = 'walk';
      startLeg(rec);
      return;
    }
  }
  rec.state = 'idle';
  rec.stateTime = 2 + rec.rng() * 3;
}

function beginActivityTrip(rec) {
  const free = activitySpots.filter((s) => !s.occupant);
  if (!free.length) return false;
  // prefer nearby-ish spots so the slow walk stays reasonable
  free.sort((s1, s2) => s1.pos.distanceTo(rec.group.position) - s2.pos.distanceTo(rec.group.position));
  const spot = free[Math.floor(rec.rng() * Math.min(free.length, 4))];
  spot.occupant = rec.id;
  rec.activity = spot;
  const wps = routeWaypoints(rec.group.position, spot.approach ? spot.approach : spot.pos);
  if (spot.approach) wps.push({ pos: spot.pos.clone(), height: spot.height || 0 });
  rec.waypoints = wps;
  rec.state = 'walk';
  startLeg(rec);
  return true;
}

// frowning wanderers only: walk out to a lonely ledge on the rim
function beginEdgeSitTrip(rec) {
  const free = edgeSitSpots.filter((s) => !s.occupant);
  if (!free.length) return false;
  const spot = free[Math.floor(rec.rng() * free.length)];
  spot.occupant = rec.id;
  rec.activity = spot;
  const wps = routeWaypoints(rec.group.position, spot.approach);
  wps.push({ pos: spot.pos.clone(), height: spot.height });
  rec.waypoints = wps;
  rec.state = 'walk';
  startLeg(rec);
  return true;
}

function beginActivity(rec) {
  const spot = rec.activity;
  rec.state = 'activity';
  rec.actTime = 9 + rec.rng() * 16;
  if (spot.kind === 'edgesit') {
    rec.actTime = 24 + rec.rng() * 20; // a long, quiet sit
    setSitPose(rec, true);
  }
  rec.baseY = spot.height ?? heightAt(spot.pos.x, spot.pos.z);
  rec.group.position.set(spot.pos.x, rec.baseY, spot.pos.z);
}

function endActivity(rec) {
  const spot = rec.activity;
  releaseSpot(rec);
  if (spot?.approach) {
    // walk back off the dock/bridge before roaming again
    rec.home.copy(spot.approach);
    rec.waypoints = [{ pos: spot.approach.clone(), height: 0 }];
    rec.state = 'walk';
    startLeg(rec);
  } else {
    rec.home.set(rec.group.position.x, 0, rec.group.position.z);
    rec.state = 'idle';
    rec.stateTime = 1.5 + rec.rng() * 3;
  }
}

function startAscension(rec) {
  if (rec.ascending) return;
  if (ui.activeRec === rec && ui.minimized) {
    // the question we minimized just got answered by someone else
    ui.activeRec = null;
    ui.minimized = false;
    ui.toast('A kind stranger reached them first 💫');
  }
  releaseSpot(rec);
  rec.spawnT = 1;
  rec.group.scale.setScalar(1); // in case they were answered mid pop-in
  rec.ascending = { t: 0, baseY: rec.group.position.y, glowFrom: rec.glowNow || 0 }; // keep the glow they already have
  const oldMarkMat = rec.mark.material;
  rec.mark.material = new THREE.SpriteMaterial({ map: SPARKLE_TEX, transparent: true, depthWrite: false });
  rec.materials[rec.materials.indexOf(oldMarkMat)] = rec.mark.material;

  const light = new THREE.PointLight(0xffe08a, 0, 18);
  light.position.y = 1.5;
  rec.group.add(light);
  rec.ascending.light = light;
  rec.ascending.lightMax = 28;

  for (const mesh of rec.meshes) {
    mesh.material = mesh.material.clone();
    mesh.material.emissive = new THREE.Color(0xffc94d);
    mesh.material.emissiveIntensity = rec.glowNow || 0;
    rec.materials.push(mesh.material);
  }
  rec.glowMats = rec.meshes.map((m) => m.material);

  const sparkGeo = new THREE.BufferGeometry();
  const n = 24;
  const pts = new Float32Array(n * 3);
  const vel = [];
  for (let i = 0; i < n; i++) {
    pts[i * 3] = (Math.random() - 0.5) * 0.6;
    pts[i * 3 + 1] = 1 + Math.random();
    pts[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
    vel.push(new THREE.Vector3((Math.random() - 0.5) * 2.4, Math.random() * 2.2 + 0.6, (Math.random() - 0.5) * 2.4));
  }
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
    map: SPARKLE_TEX, size: 0.55, transparent: true, depthWrite: false, color: 0xffd76e,
  }));
  rec.group.add(sparks);
  rec.ascending.sparks = sparks;
  rec.ascending.sparkVel = vel;
}

function removeCharacter(rec) {
  releaseSpot(rec);
  charactersGroup.remove(rec.group);
  // body geometries are shared across all wanderers — only per-character GPU
  // objects (materials, spark burst) get disposed
  if (rec.ascending?.sparks) rec.ascending.sparks.geometry.dispose();
  for (const m of rec.materials) m.dispose?.();
  rec.fx.halo?.material.dispose();
  for (const s of rec.fx.sparks) s.material.dispose(); // (shared textures stay)
  characters.delete(rec.id);
}

function updateCharacter(rec, dt, elapsed) {
  const g = rec.group;

  // the ? bobs and sways in every state
  rec.mark.position.y = 3.05 + Math.sin(elapsed * 2.4 + rec.bobSeed) * 0.16;
  rec.mark.material.rotation = Math.sin(elapsed * 1.8 + rec.bobSeed) * 0.14;

  // golden glow, halo and orbiting ✦ that grow with every answer
  updateRipeFx(rec, dt, elapsed);

  // occasionally they look up, straight at the camera — as if they can see you
  if (!rec.ascending) {
    rec.gazeCool -= dt;
    if (ui.activeRec === rec) {
      rec.gazeT = Math.max(rec.gazeT, 0.4); // they hold your gaze while you write to them
    } else if (rec.gazeT <= 0 && rec.gazeCool <= 0 && rec.rng() < dt * 0.06) {
      rec.gazeT = 2.5 + rec.rng() * 2.5;
      rec.gazeCool = 14 + rec.rng() * 24;
    }
    rec.gazeT -= dt;
    let pitchTo = 0, headYawTo = 0;
    if (rec.gazeT > 0) {
      const dx = camera.position.x - g.position.x;
      const dz = camera.position.z - g.position.z;
      const yawToCam = Math.atan2(dx, dz);
      let dYaw = yawToCam - g.rotation.y;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      headYawTo = THREE.MathUtils.clamp(dYaw, -0.65, 0.65);
      const dy = camera.position.y - (g.position.y + 1.65);
      pitchTo = -THREE.MathUtils.clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.3, 0.95);
      if (rec.state === 'idle') g.rotation.y += dYaw * Math.min(1, dt * 2.5); // turn to face you too
    } else if (rec.state === 'activity' && rec.activity?.kind === 'edgesit') {
      pitchTo = 0.34; // head bowed, gazing into the sky below the island
    }
    rec.headGroup.rotation.x += (pitchTo - rec.headGroup.rotation.x) * Math.min(1, dt * 5);
    rec.headGroup.rotation.y += (headYawTo - rec.headGroup.rotation.y) * Math.min(1, dt * 5);
  }

  if (rec.spawnT < 1) {
    rec.spawnT = Math.min(1, rec.spawnT + dt * 1.8);
    if (!rec.ascending) g.scale.setScalar((0.01 + easeInOut(rec.spawnT) * 0.99) * (1 + Math.sin(rec.spawnT * Math.PI) * 0.18));
  }

  if (rec.ascending) {
    const a = rec.ascending;
    a.t += dt;
    const glow = Math.min(1, a.t / 0.7);
    a.light.intensity = glow * a.lightMax;
    if (rec.glowMats) for (const m of rec.glowMats) m.emissiveIntensity = a.glowFrom + (0.9 - a.glowFrom) * glow;

    if (a.sparks) {
      const p = a.sparks.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        p.setXYZ(i, p.getX(i) + a.sparkVel[i].x * dt, p.getY(i) + a.sparkVel[i].y * dt, p.getZ(i) + a.sparkVel[i].z * dt);
      }
      p.needsUpdate = true;
      a.sparks.material.opacity = Math.max(0, 1 - a.t / 2.2);
    }

    if (a.t > 0.7) {
      const riseT = a.t - 0.7;
      g.position.y = a.baseY + easeInCubic(Math.min(1, riseT / 3.4)) * 46;
      g.rotation.y += dt * (0.6 + riseT * 0.25);
      g.position.x += Math.sin(elapsed * 1.7 + rec.bobSeed) * dt * 0.4;
      rec.blob.material.opacity = Math.max(0, 0.9 - riseT * 0.8);
      const fade = THREE.MathUtils.clamp((g.position.y - a.baseY - 26) / 18, 0, 1);
      for (const m of rec.materials) m.opacity = 1 - fade;
      rec.fxFade = 1 - fade; // halo + orbiting sparkles fade out with them
      a.light.intensity = a.lightMax * (1 - fade);
      if (fade >= 1) removeCharacter(rec);
    }
    return;
  }

  if (rec.state === 'idle') {
    rec.stateTime -= dt;
    rec.baseY = heightAt(g.position.x, g.position.z);
    g.position.y = rec.baseY + Math.sin(elapsed * 1.6 + rec.bobSeed) * 0.03;
    if (rec.gazeT <= 0) g.rotation.y += Math.sin(elapsed * 0.7 + rec.bobSeed) * dt * 0.35; // curious looking around
    g.rotation.z = 0;
    if (rec.stateTime <= 0) {
      // frowning wanderers sometimes drift to the rim to sit alone for a while
      if (rec.isFrown && rec.rng() < 0.07 && beginEdgeSitTrip(rec)) return;
      // sometimes head off to do something — fish, warm up, tend crops, gaze
      if (rec.rng() < 0.4 && beginActivityTrip(rec)) return;
      beginStroll(rec);
    }
    return;
  }

  if (rec.state === 'activity') {
    rec.actTime -= dt;
    const spot = rec.activity;
    // settle into facing the activity
    let delta = spot.yaw - g.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    g.rotation.y += delta * Math.min(1, dt * 4);
    // gentle, kind-specific idle motion
    const sway = Math.sin(elapsed * 0.9 + rec.bobSeed);
    if (spot.kind === 'farm') {
      g.rotation.x = (Math.sin(elapsed * 1.3 + rec.bobSeed) * 0.5 + 0.5) * 0.22; // bowing over the crops
    } else if (spot.kind === 'campfire') {
      g.rotation.x = 0.08 + sway * 0.02; // leaning into the warmth
    } else {
      g.rotation.x = sway * 0.03;
    }
    g.position.y = rec.baseY + Math.sin(elapsed * 1.8 + rec.bobSeed) * 0.03;
    if (rec.actTime <= 0) {
      g.rotation.x = 0;
      endActivity(rec);
    }
    return;
  }

  // state === 'walk': follow waypoints
  const wp = rec.waypoints[0];
  if (!wp) {
    rec.state = 'idle';
    rec.stateTime = 1 + rec.rng() * 3;
    return;
  }
  const dir = new THREE.Vector3(wp.pos.x - g.position.x, 0, wp.pos.z - g.position.z);
  const dist = dir.length();
  if (dist < Math.max(0.35, WALK_SPEED * dt * 1.2)) { // never overshoot-orbit a waypoint on slow frames
    rec.waypoints.shift();
    if (rec.waypoints.length) {
      startLeg(rec);
    } else if (rec.activity && rec.activity.occupant === rec.id) {
      beginActivity(rec);
    } else {
      rec.state = 'idle';
      rec.stateTime = 1.5 + rec.rng() * 4;
    }
    return;
  }
  dir.normalize();
  const desired = Math.atan2(dir.x, dir.z);
  let delta = desired - g.rotation.y;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  g.rotation.y += delta * Math.min(1, dt * 4);
  g.position.addScaledVector(dir, WALK_SPEED * dt);

  // base height: bridges arch, decks lerp, plain ground follows the hills
  const p = THREE.MathUtils.clamp(1 - dist / rec.legLen, 0, 1);
  if (wp.bridge) {
    rec.baseY = Math.sin(p * Math.PI) * 1.25;
  } else if (wp.height !== undefined) {
    rec.baseY = THREE.MathUtils.lerp(rec.legFromY, wp.height, easeInOut(p));
  } else {
    rec.baseY = heightAt(g.position.x, g.position.z);
  }
  g.position.y = rec.baseY + Math.abs(Math.sin(elapsed * 6 + rec.bobSeed)) * 0.1; // unhurried waddle
  g.rotation.z = Math.sin(elapsed * 6 + rec.bobSeed) * 0.04;
}

// ---------------------------------------------------------- camera focus
// Tap a wanderer (or ask/search) and the camera flies in and follows them.
const focus = { rec: null, tween: null };
const _fv1 = new THREE.Vector3(), _fv2 = new THREE.Vector3(), _fv3 = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function focusOn(rec) {
  const dir = _fv1.copy(camera.position).sub(rec.group.position);
  dir.y = 0;
  if (dir.lengthSq() < 0.01) dir.set(0.6, 0, 0.8);
  dir.normalize();
  focus.rec = rec;
  focus.tween = {
    t: 0, dur: 1.3,
    fromCam: camera.position.clone(),
    fromTarget: controls.target.clone(),
    dir: dir.clone(), dist: 9.5, elev: 4.2,
  };
  rec.gazeT = Math.max(rec.gazeT, 3.5); // they notice you arriving
}

function releaseFocus() {
  focus.rec = null;
  focus.tween = null;
}

function updateFocus(rawDt) {
  if (!focus.rec) return;
  if (!characters.has(focus.rec.id)) { releaseFocus(); return; } // they've ascended and faded
  const p = focus.rec.group.position;
  const desired = _fv1.set(p.x, p.y + 1.4, p.z);
  // nudge them off-center while the answer card is up, so it doesn't cover them
  if (ui.activeRec === focus.rec && !ui.minimized && window.innerWidth > 620 &&
      !$('modal-answer').classList.contains('hidden')) {
    const camDir = _fv2.copy(controls.target).sub(camera.position).normalize();
    _fv3.crossVectors(camDir, WORLD_UP).normalize();
    desired.addScaledVector(_fv3, 2.4);
  }
  const tw = focus.tween;
  if (tw) {
    tw.t += rawDt;
    const k = easeInOut(Math.min(1, tw.t / tw.dur));
    _fv2.set(desired.x + tw.dir.x * tw.dist, desired.y + tw.elev, desired.z + tw.dir.z * tw.dist);
    camera.position.lerpVectors(tw.fromCam, _fv2, k);
    controls.target.lerpVectors(tw.fromTarget, desired, k);
    if (tw.t >= tw.dur) focus.tween = null; // hand the orbit back to the user, target keeps following
  } else {
    // travel WITH them: the camera moves by exactly as much as the target does, so the
    // angle and zoom you picked stay the same while they stroll (you can still orbit)
    _fv3.copy(controls.target);
    controls.target.lerp(desired, Math.min(1, rawDt * 4));
    camera.position.add(_fv3.subVectors(controls.target, _fv3));
  }
}

function updateChips() {
  const anyOverlay = !!document.querySelector('.overlay:not(.hidden)');
  $('min-chip').classList.toggle('hidden', !ui.minimized);
  $('follow-chip').classList.toggle('hidden', !(focus.rec && !anyOverlay && !ui.minimized));
  const chipText = idle.active ? '✨ Drifting with the wanderers — tap to explore yourself' : '👁 Following a wanderer — tap to stop';
  if ($('follow-chip').textContent !== chipText) $('follow-chip').textContent = chipText;
}

// ---------------------------------------------------------------- idle tour
// Leave the meadow alone for IDLE_START_S seconds without picking anyone and the camera
// goes visiting on its own: it follows a random wanderer, slowly circling them, and
// hops to another one every IDLE_HOP_S seconds. Any tap, drag, scroll or key ends the
// tour (the camera stays with whoever it was visiting; tap empty meadow to roam free).
const IDLE_START_S = 10;
const IDLE_HOP_S = 10;
const idle = { quietFor: 0, active: false, hopIn: 0, rec: null };

function noteActivity() {
  idle.quietFor = 0;
  if (idle.active) stopIdle();
}
for (const type of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
  window.addEventListener(type, noteActivity, { capture: true, passive: true });
}

function stopIdle() {
  idle.active = false;
  idle.rec = null;
  controls.autoRotate = false;
}

function idleHop() {
  const pool = [...characters.values()].filter((rec) => !rec.ascending && rec !== idle.rec);
  if (!pool.length) { idle.hopIn = 2; return; } // nobody (else) around yet — look again soon
  idle.rec = pool[Math.floor(Math.random() * pool.length)];
  focusOn(idle.rec);
  idle.hopIn = IDLE_HOP_S;
}

function updateIdle(rawDt) {
  const busy = intro.active || !controls.enabled || ui.minimized || !!document.querySelector('.overlay:not(.hidden)');
  if (busy) { idle.quietFor = 0; if (idle.active) stopIdle(); return; }
  if (!idle.active) {
    if (focus.rec) { idle.quietFor = 0; return; } // you picked someone yourself: leave you be
    idle.quietFor += rawDt;
    if (idle.quietFor < IDLE_START_S) return;
    idle.active = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5; // one slow lap every ~2 minutes
    idleHop();
    return;
  }
  if (focus.rec !== idle.rec) { // they ascended and faded, or something else took the camera
    if (!focus.rec) idleHop(); else stopIdle();
    return;
  }
  idle.hopIn -= rawDt;
  if (idle.hopIn <= 0) idleHop();
}

// ------------------------------------------------------------ github stars
// "★ 12" next to the GitHub mark; until the count is known (or if GitHub is unreachable) it just says "Star".
fetch('/api/stars').then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (d && Number.isFinite(d.stars)) $('gh-stars').textContent = d.stars.toLocaleString();
}).catch(() => { /* the plain "Star" label is fine */ });

// ------------------------------------------------------------- interaction
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;

canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
});
canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  const heldMs = performance.now() - downAt.t;
  downAt = null;
  if (moved > 9 || heldMs > 600) return; // that was a drag, not a tap

  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(charactersGroup.children, true);
  if (!hits.length) {
    releaseFocus(); // tapping empty meadow lets the camera roam free again
    return;
  }
  let obj = hits[0].object;
  while (obj.parent && obj.parent !== charactersGroup) obj = obj.parent;
  for (const rec of characters.values()) {
    if (rec.group === obj && !rec.ascending) {
      focusOn(rec);
      ui.openAnswer(rec);
      break;
    }
  }
});

// ---------------------------------------------------------------- syncing
const locallyAnswered = new Set(); // questions WE just closed (no "someone helped" toast for those)

// which wanderers has this browser already answered? (the server enforces it too; this just
// saves a pointless round trip and lets the card say so)
const ANSWERED_KEY = 'meadow-answered-ids';
function loadAnswered() {
  try { return new Set(JSON.parse(localStorage.getItem(ANSWERED_KEY) || '[]')); } catch { return new Set(); }
}
const hasAnswered = (id) => loadAnswered().has(id);
function markAnswered(id) {
  const ids = [...loadAnswered(), id].slice(-200);
  try { localStorage.setItem(ANSWERED_KEY, JSON.stringify(ids)); } catch { /* private mode: fine */ }
}

// "●●○" for 2 of 3
const pips = (n, max) => '●'.repeat(Math.min(n, max)) + '○'.repeat(Math.max(0, max - n));
// "about 3h 20m" / "12 min" / "under a minute"
function fmtLeft(ms) {
  const m = Math.ceil(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

async function poll() {
  try {
    const res = await fetch('/api/questions');
    if (!res.ok) return;
    const { questions, rules } = await res.json();
    if (rules) world.rules = rules;
    const seen = new Set();
    for (const q of questions) {
      seen.add(q.id);
      // closed = its wanderer ascends (older servers only sent `answered`, which meant the same)
      const closed = q.closedAt != null || q.answered === true;
      let rec = characters.get(q.id);
      if (!rec && !closed) rec = makePerson(q);
      if (rec && !closed && !rec.ascending && (q.answerCount || 0) !== rec.answerCount) {
        setRipeness(rec, q.answerCount || 0); // someone added an answer: glow a little brighter
      }
      if (rec && closed && !rec.ascending) {
        if (!locallyAnswered.has(q.id)) ui.toast('✨ Somewhere in the meadow, a question just ripened and ascended');
        startAscension(rec);
      }
    }
    for (const rec of [...characters.values()]) {
      if (!seen.has(rec.id) && !rec.ascending && !locallyAnswered.has(rec.id)) {
        startAscension(rec);
      }
    }
  } catch {
    /* offline blip — the meadow forgives */
  }
}
setInterval(poll, POLL_MS);

// --------------------------------------------------------------------- UI
const $ = (id) => document.getElementById(id);
const ui = {
  activeRec: null,
  minimized: false,

  toast(msg, ms = 3200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(ui._toastTimer);
    ui._toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  },

  open(id) { $(id).classList.remove('hidden'); },
  closeAll() {
    document.querySelectorAll('.overlay').forEach((o) => o.classList.add('hidden'));
    ui.activeRec = null;
    ui.minimized = false;
  },

  openAnswer(rec) {
    ui.activeRec = rec;
    ui.minimized = false;
    $('answer-question').textContent = rec.text;
    $('answer-alias').value = localStorage.getItem('meadow-alias') || '';
    $('answer-text').value = '';
    $('answer-count').textContent = '0 / 500';
    // how ripe are they? and have WE already answered this one?
    const n = rec.answerCount || 0, max = world.rules.maxAnswers, mine = hasAnswered(rec.id);
    $('answer-ripen-note').textContent = mine
      ? "You've already answered this wanderer — thank you 💛"
      : rec.keeper
        ? `🩶 This is the keeper's own wanderer — it keeps listening until it hears an answer that truly helps${n ? ` (${n} so far)` : ''} 🌱`
      : n === 0
        ? 'Nobody has answered yet — be the first 🌱'
        : `${pips(n, max)}  ${n} of ${max} answers so far — add yours 🌱`;
    $('answer-submit').disabled = mine;
    ui.open('modal-answer');
    setTimeout(() => ($('answer-alias').value ? $('answer-text') : $('answer-alias')).focus(), 50);
  },
};

document.querySelectorAll('[data-close]').forEach((el) =>
  el.addEventListener('click', ui.closeAll)
);

// minimize the answer card to watch the wanderer while you think
$('answer-min').addEventListener('click', () => {
  if (!ui.activeRec) return;
  ui.minimized = true;
  $('modal-answer').classList.add('hidden');
  const t = ui.activeRec.text;
  $('min-chip').textContent = `💭 “${t.length > 30 ? t.slice(0, 30) + '…' : t}” — tap to answer`;
});
$('min-chip').addEventListener('click', () => {
  ui.minimized = false;
  if (ui.activeRec) ui.open('modal-answer');
});
$('follow-chip').addEventListener('click', () => releaseFocus());
document.querySelectorAll('.overlay').forEach((o) =>
  o.addEventListener('click', (e) => { if (e.target === o) ui.closeAll(); })
);

// segmented pickers (wanderer colour + mood)
function segSetup(id) {
  const el = $(id);
  el.querySelectorAll('.seg-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      el.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    })
  );
  return {
    get: () => el.querySelector('.seg-btn.active')?.dataset.value,
    set: (v) => el.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.value === v)),
  };
}
const askColor = segSetup('ask-color');
const askExpression = segSetup('ask-expression');

$('btn-ask').addEventListener('click', () => {
  $('ask-text').value = '';
  $('ask-count').textContent = '0 / 280';
  askColor.set(Math.random() < 0.5 ? 'f' : 'm'); // a random wanderer awaits — change them if you like
  askExpression.set(Math.random() < 0.5 ? 'smile' : 'frown');
  ui.open('modal-ask');
  setTimeout(() => $('ask-text').focus(), 50);
});
$('btn-lookup').addEventListener('click', () => {
  $('lookup-code').value = '';
  $('lookup-result').classList.add('hidden');
  $('lookup-result').innerHTML = '';
  ui.open('modal-lookup');
  setTimeout(() => $('lookup-code').focus(), 50);
});

$('ask-text').addEventListener('input', (e) => {
  $('ask-count').textContent = `${e.target.value.length} / 280`;
});
$('answer-text').addEventListener('input', (e) => {
  $('answer-count').textContent = `${e.target.value.length} / 500`;
});

$('ask-submit').addEventListener('click', async () => {
  const text = $('ask-text').value.trim();
  if (text.length < 3) return ui.toast('Give your question at least 3 characters 🌱');
  const btn = $('ask-submit');
  btn.disabled = true;
  try {
    const res = await fetch('/api/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, color: askColor.get(), expression: askExpression.get() }),
    });
    const data = await res.json();
    if (!res.ok) return ui.toast(data.error || 'The meadow hiccuped. Try again?');
    ui.closeAll();
    $('code-value').textContent = data.code;
    ui.lastAsk = { text, color: askColor.get(), expression: askExpression.get(), code: data.code };
    ui.open('modal-code');
    await poll(); // spawn the new wanderer right away…
    const rec = characters.get(data.id);
    if (rec) focusOn(rec); // …and fly the camera to meet them
  } catch {
    ui.toast('Could not reach the meadow — check your connection 🌧️');
  } finally {
    btn.disabled = false;
  }
});

$('code-copy').addEventListener('click', async () => {
  const code = $('code-value').textContent;
  try {
    await navigator.clipboard.writeText(code);
    ui.toast('Code copied! Keep it safe 🔐');
  } catch {
    ui.toast(`Copy failed — write it down: ${code}`, 6000);
  }
});

// keepsake card — a downloadable memento holding the question, wanderer, and code
function drawKeepsake({ text, color, expression, code }) {
  const W = 1000, H = 1250;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const rr = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  // twilight sky
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#181c40');
  sky.addColorStop(0.55, '#3a3466');
  sky.addColorStop(1, '#7a68b0');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // stars + a soft moon
  const rng = mulberry32(hashString(code));
  ctx.fillStyle = 'rgba(230,235,255,0.9)';
  for (let i = 0; i < 90; i++) {
    ctx.globalAlpha = 0.25 + rng() * 0.7;
    ctx.beginPath();
    ctx.arc(rng() * W, rng() * H * 0.6, 0.8 + rng() * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const moon = ctx.createRadialGradient(830, 150, 10, 830, 150, 120);
  moon.addColorStop(0, 'rgba(235,240,255,0.95)');
  moon.addColorStop(0.3, 'rgba(210,220,255,0.35)');
  moon.addColorStop(1, 'rgba(210,220,255,0)');
  ctx.fillStyle = moon;
  ctx.fillRect(650, 0, 400, 400);

  // island silhouette
  ctx.fillStyle = '#241f45';
  ctx.beginPath();
  ctx.ellipse(W / 2, H - 30, 560, 160, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2d2a52';
  ctx.beginPath();
  ctx.ellipse(W / 2, H - 70, 460, 110, 0, 0, Math.PI * 2);
  ctx.fill();

  // the wanderer — blocky, bald, theirs
  const skin = color === 'f' ? '#e35aa8' : '#58a8f0';
  const cx = W / 2, top = 300;
  ctx.fillStyle = skin;
  rr(cx - 30, top + 184, 24, 26, 10); ctx.fill();   // legs
  rr(cx + 6, top + 184, 24, 26, 10); ctx.fill();
  rr(cx - 66, top + 128, 20, 44, 10); ctx.fill();   // arms
  rr(cx + 46, top + 128, 20, 44, 10); ctx.fill();
  rr(cx - 42, top + 118, 84, 72, 22); ctx.fill();   // body
  rr(cx - 56, top, 112, 100, 28); ctx.fill();       // head
  ctx.fillStyle = '#3a3630';                        // eyes
  ctx.beginPath(); ctx.arc(cx - 22, top + 42, 6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 22, top + 42, 6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#3a3630';                      // mouth: ∪ smile or ∩ frown
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (expression === 'frown') ctx.arc(cx, top + 78, 18, Math.PI * 1.15, Math.PI * 1.85);
  else ctx.arc(cx, top + 62, 18, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
  ctx.font = 'bold 84px Georgia, serif';            // the ? overhead
  ctx.textAlign = 'center';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.strokeText('?', cx, top - 40);
  ctx.fillStyle = '#ff9f43';
  ctx.fillText('?', cx, top - 40);

  // the question, wrapped in quiet serif
  ctx.fillStyle = 'rgba(240,238,255,0.95)';
  ctx.font = 'italic 40px Georgia, serif';
  const words = `“${text}”`.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const probe = line ? line + ' ' + w : w;
    if (ctx.measureText(probe).width > 780 && line) { lines.push(line); line = w; }
    else line = probe;
  }
  lines.push(line);
  let ty = top + 300;
  for (const l of lines.slice(0, 5)) { ctx.fillText(l, W / 2, ty); ty += 54; }

  // the code
  ty += 60;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  rr(W / 2 - 260, ty - 58, 520, 96, 20); ctx.fill();
  ctx.font = 'bold 64px "Courier New", monospace';
  ctx.fillStyle = '#ffd97a';
  ctx.fillText(code, W / 2, ty + 12);
  ctx.font = '28px Georgia, serif';
  ctx.fillStyle = 'rgba(230,228,250,0.75)';
  ctx.fillText('your one-time code — it opens the answer once, then rests forever', W / 2, ty + 90);

  // footer
  ctx.font = '30px Georgia, serif';
  ctx.fillStyle = 'rgba(240,238,255,0.85)';
  ctx.fillText('🌙 Wonder Meadow', W / 2, H - 90);
  return cv;
}

$('code-keepsake').addEventListener('click', () => {
  if (!ui.lastAsk) return ui.toast('Ask the meadow first 🌱');
  const cv = drawKeepsake(ui.lastAsk);
  cv.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wonder-meadow-${ui.lastAsk.code}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    ui.toast('Keepsake saved — your code travels with it 🖼');
  }, 'image/png');
});

$('answer-submit').addEventListener('click', async () => {
  const rec = ui.activeRec;
  if (!rec) return;
  const alias = $('answer-alias').value.trim();
  const text = $('answer-text').value.trim();
  if (!alias) return ui.toast('An alias is required — blank names are too mysterious 👻');
  if (text.length < 2) return ui.toast('Your answer needs a little more substance ✍️');
  const btn = $('answer-submit');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/questions/${rec.id}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias, text }),
    });
    const data = await res.json();
    if (!res.ok) {
      ui.toast(data.error || 'The meadow hiccuped. Try again?');
      if (data.code === 'duplicate') {
        markAnswered(rec.id); // the server says we already answered this one
        ui.closeAll();
      } else if (res.status === 409 || res.status === 404) {
        ui.closeAll();
        if (res.status === 409) { startAscension(rec); focusOn(rec); } // it closed while we were typing
        else removeCharacter(rec);
      }
      return;
    }
    localStorage.setItem('meadow-alias', alias);
    markAnswered(rec.id);
    ui.closeAll();
    if (data.closed) {
      // ours was the answer that filled the last slot: they ascend now
      locallyAnswered.add(rec.id);
      startAscension(rec);
      focusOn(rec); // stay with them as they rise
      ui.toast(`Thank you, ${alias} — you gave them the last answer they needed! ✨`);
    } else {
      // still ripening: they stay in the meadow, a little brighter
      setRipeness(rec, data.count);
      const max = world.rules.maxAnswers;
      ui.toast(data.count === 1
        ? `Thank you, ${alias} — you're the first to answer. They'll ripen as more strangers help 🌱`
        : `Thank you, ${alias} — ${data.count} of ${max} answers so far. They ascend when it's complete 🌱`);
    }
  } catch {
    ui.toast('Could not reach the meadow — check your connection 🌧️');
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------- the answered realm (heaven)
function buildHeavenClouds() {
  if (buildHeavenClouds.done) return;
  buildHeavenClouds.done = true;
  const back = $('heaven-clouds-back');
  const front = $('heaven-clouds-front');
  const rng = mulberry32(2024);
  for (let i = 0; i < 26; i++) {
    const c = document.createElement('div');
    c.className = 'cloud';
    const isFront = i % 3 === 0;
    const w = (isFront ? 200 : 120) + rng() * 260;
    c.style.width = `${w}px`;
    c.style.height = `${w * (0.28 + rng() * 0.2)}px`;
    c.style.top = `${rng() * 92}%`;
    c.style.opacity = (isFront ? 0.75 : 0.45) + rng() * 0.25;
    const dur = (isFront ? 50 : 80) + rng() * 70;
    c.style.animationDuration = `${dur}s`;
    c.style.animationDelay = `${-rng() * dur}s`; // scatter them mid-drift
    (isFront ? front : back).appendChild(c);
  }
}

function openHeaven(data) {
  buildHeavenClouds();
  // tint the ascended wanderer their chosen colour (always smiling up here)
  const skin = data.color === 'f' ? '#e35aa8' : '#58a8f0';
  document.querySelectorAll('.hw-skin').forEach((el) => el.setAttribute('fill', skin));
  $('heaven-question').textContent = `“${data.text}”`;
  $('heaven-answers').innerHTML = data.answers.map((a) => `
    <div class="heaven-answer">${escapeHtml(a.text)}
      <span class="ha-alias">— ${escapeHtml(a.alias)}, a kind stranger</span>
    </div>`).join('');
  releaseFocus();
  const h = $('heaven');
  h.classList.remove('fading');
  h.classList.add('hidden');
  void h.offsetWidth; // restart the entrance animation
  h.classList.remove('hidden');
}

$('heaven-return').addEventListener('click', () => {
  const h = $('heaven');
  h.classList.add('fading');
  setTimeout(() => {
    h.classList.add('hidden');
    h.classList.remove('fading');
  }, 1000);
});

$('lookup-submit').addEventListener('click', doLookup);
$('lookup-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLookup(); });

async function doLookup() {
  const code = $('lookup-code').value.trim();
  if (!code) return ui.toast('Enter your code first 🔑');
  const btn = $('lookup-submit');
  btn.disabled = true;
  const box = $('lookup-result');
  try {
    const res = await fetch('/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    box.classList.remove('hidden');
    if (!res.ok) {
      box.innerHTML = `<p class="lookup-waiting">😕 ${escapeHtml(data.error || 'Something went wrong.')}</p>`;
      return;
    }
    if (data.keeper) {
      // the keeper's own wanderer: read the answers any time; the code is NOT used up until it ascends
      const rec = characters.get(data.id);
      const list = (data.answers || []).map((a) =>
        `<p class="lookup-waiting">“${escapeHtml(a.text)}” <em>— ${escapeHtml(a.alias)}</em></p>`).join('');
      box.innerHTML = `
        <p class="lr-q">“${escapeHtml(data.text)}”</p>
        <p class="lookup-waiting">🩶 <strong>${(data.answers || []).length}</strong> answer${(data.answers || []).length === 1 ? '' : 's'} so far. This wanderer keeps listening until the keeper lets it ascend.<br/>
        Your code was <strong>not</strong> used up.</p>${list}
        ${rec ? '<p class="lookup-waiting">👁 The camera found them — close this window to watch them wander.</p>' : ''}`;
      if (rec) focusOn(rec);
      return;
    }
    if (data.ripening) {
      // answers are arriving but stay sealed until the question closes; the code is NOT used up
      const rec = characters.get(data.id);
      const max = world.rules.maxAnswers;
      const left = (data.closesAt || 0) - Date.now();
      box.innerHTML = `
        <p class="lr-q">“${escapeHtml(data.text)}”</p>
        <p class="lookup-waiting">🌱 <span class="pips">${pips(data.count, max)}</span> <strong>${data.count}</strong> of ${max} answers have arrived.<br/>
        They're still ripening — you'll read them all together when they ascend${left > 0 ? `, at the latest in about ${fmtLeft(left)}` : ', any moment now'}.<br/>
        Your code was <strong>not</strong> used up.</p>
        ${rec ? '<p class="lookup-waiting">👁 The camera found them — close this window to watch them glow.</p>' : ''}`;
      if (rec) focusOn(rec);
      return;
    }
    if (!data.answered) {
      const rec = characters.get(data.id);
      box.innerHTML = `
        <p class="lr-q">“${escapeHtml(data.text)}”</p>
        <p class="lookup-waiting">🚶 Still wandering the meadow — no answer yet.<br/>Your code was <strong>not</strong> used up. Come back later!</p>
        ${rec ? '<p class="lookup-waiting">👁 The camera found them — close this window to watch them wander.</p>' : ''}`;
      if (rec) focusOn(rec);
      return;
    }
    // answered: ascend to the calm white realm above the clouds
    ui.closeAll();
    openHeaven(data);
  } catch {
    ui.toast('Could not reach the meadow — check your connection 🌧️');
  } finally {
    btn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// hide the hint after a while (counted from when you actually see the meadow)
const startHintTimer = () => setTimeout(() => $('hint').classList.add('gone'), 9000);
if (window.__openerActive) window.addEventListener('meadow:enter', startHintTimer, { once: true });
else startHintTimer();

// the brand in the top bar replays the opener (mouse, touch, or keyboard)
{
  const brand = document.querySelector('.brand');
  brand?.addEventListener('click', () => window.__meadowOpener?.show());
  brand?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.__meadowOpener?.show(); }
  });
}

// ------------------------------------------------------------ ambient sound
// A gloomy-but-comforting soundscape, synthesized live (no audio files):
// a low drone, a little music-box melody that repeats forever, wind sighing
// from ear to ear, and the drizzle's soft patter. Browsers only allow audio
// after a user gesture, so it wakes on the first tap/keypress.
const sound = {
  ctx: null,
  master: null,
  started: false,
  muted: localStorage.getItem('meadow-muted') === '1',
  LEVEL: 0.5,
};

// wobble an AudioParam around `base` — the desynchronized start times keep
// the layers breathing against each other instead of in lockstep
function soundLfo(ctx, param, base, depth, periodS) {
  param.value = base;
  const osc = ctx.createOscillator();
  osc.frequency.value = 1 / periodS;
  const g = ctx.createGain();
  g.gain.value = depth;
  osc.connect(g).connect(param);
  osc.start(ctx.currentTime + Math.random() * periodS);
}

function startSound() {
  if (sound.started) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  sound.started = true;
  const ctx = new Ctx();
  sound.ctx = ctx;
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  sound.master = master;

  // one shared loop of white noise feeds both the wind and the rain
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noiseSrc = () => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.start();
    return src;
  };

  // 1. the low drone — the island humming to itself
  {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 170;
    const g = ctx.createGain();
    sound.drone = [];
    for (const [i, vol] of [0.05, 0.035, 0.028].entries()) {
      const osc = ctx.createOscillator();
      osc.frequency.value = SOUND_MOODS[mood.name].drone[i];
      sound.drone.push(osc);
      const og = ctx.createGain();
      og.gain.value = vol;
      osc.connect(og).connect(lp);
      osc.start();
    }
    lp.connect(g).connect(master);
    soundLfo(ctx, g.gain, 0.6, 0.18, 13); // quiet — it sits underneath the melody
  }

  // 2. the music box — a short, simple chain of notes that repeats forever, soft plucks
  // with long tails and lots of silence between them (think Minecraft at dusk).
  // Each mood has its own phrase; they share one clock, so a switch lands on the beat.
  {
    const NOTE = { E4: 329.63, G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25 };
    const STEP = 0.62; // seconds per step
    const pluck = (freq, t) => {
      // soft fundamental + a fainter octave up, for a music-box shimmer
      for (const [mult, vol] of [[1, 0.055], [2, 0.013]]) {
        const osc = ctx.createOscillator();
        osc.frequency.value = freq * mult;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
        osc.connect(g).connect(master);
        osc.start(t);
        osc.stop(t + 3.6);
      }
    };
    let step = 0;
    let nextT = ctx.currentTime + 2;
    setInterval(() => { // keep a little runway of scheduled notes ahead of playback
      while (nextT < ctx.currentTime + 0.8) {
        const phrase = SOUND_MOODS[mood.name].phrase;
        const name = phrase[step % phrase.length];
        if (name) pluck(NOTE[name], nextT);
        step++;
        nextT += STEP;
      }
    }, 250);
  }

  // 3. wind sighing across the meadow, drifting ear to ear
  {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.7;
    soundLfo(ctx, bp.frequency, 420, 180, 17);
    const g = ctx.createGain();
    soundLfo(ctx, g.gain, 0.05, 0.03, 11);
    sound.wind = ctx.createGain(); // the mood's share of the wind
    sound.wind.gain.value = SOUND_MOODS[mood.name].wind;
    noiseSrc().connect(bp).connect(g);
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      soundLfo(ctx, pan.pan, 0, 0.55, 29);
      g.connect(pan).connect(sound.wind).connect(master);
    } else {
      g.connect(sound.wind).connect(master);
    }
  }

  // 4. the drizzle's patter
  {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2400;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 8000;
    const g = ctx.createGain();
    soundLfo(ctx, g.gain, 0.033, 0.012, 7);
    sound.rain = ctx.createGain(); // no drizzle in the cozy mood
    sound.rain.gain.value = SOUND_MOODS[mood.name].rain;
    noiseSrc().connect(hp).connect(lp).connect(g).connect(sound.rain).connect(master);
  }

  applyMute(true);
}

function applyMute(firstStart = false) {
  const btn = $('btn-sound');
  btn.textContent = sound.muted ? '🔇' : '🔊';
  btn.title = sound.muted ? 'ambient sound: off' : 'ambient sound: on';
  if (!sound.master) return;
  const t = sound.ctx.currentTime;
  sound.master.gain.cancelScheduledValues(t);
  sound.master.gain.setValueAtTime(sound.master.gain.value, t);
  // fade in gently on first start; snappier when toggling
  sound.master.gain.linearRampToValueAtTime(sound.muted ? 0 : sound.LEVEL, t + (firstStart ? 5 : 0.6));
}

function wakeSound() {
  startSound();
  if (sound.ctx && sound.ctx.state === 'suspended') sound.ctx.resume();
}
window.addEventListener('pointerdown', wakeSound, { once: true });
window.addEventListener('keydown', wakeSound, { once: true });

$('btn-sound').addEventListener('click', () => {
  sound.muted = !sound.muted;
  localStorage.setItem('meadow-muted', sound.muted ? '1' : '0');
  wakeSound();
  applyMute();
});
applyMute(); // set the initial speaker icon

// ------------------------------------------------------------------- mood
// Two moods for the same meadow: limbo — the wet, sad dusk (the default) — and cozy,
// a calm, dreamlike golden hour with no rain. Every value that differs lives in
// MOODS; the world cross-fades between them over MOOD_FADE_S seconds, and your
// choice is remembered. It only touches the meadow (the opener keeps its own look).
const MOOD_KEY = 'meadow-mood';
const MOOD_FADE_S = 2.2;
const C = (hex) => new THREE.Color(hex);
const MOODS = {
  limbo: {
    fogBright: C(0x565080), fogDeep: C(0x444069), fogNear: 130, fogFar: 420,
    hemiSky: C(0x8a86c9), hemiGround: C(0x2e4a3f), hemi: 0.85,
    ambient: C(0x4a4670), ambientI: 0.4,
    sun: C(0xb8c4ff), sunI: 0.55,
    disc: C(0xffffff), discScale: 90, discY: 190,
    cloud: C(0x8b84b8), cloudOpacity: 0.55,
    stars: 1, rain: 1,
  },
  cozy: {
    fogBright: C(0xe3b9b2), fogDeep: C(0xd2a7b0), fogNear: 150, fogFar: 480,
    hemiSky: C(0xffe2c8), hemiGround: C(0x7a6a52), hemi: 1.55,
    ambient: C(0xb08a8c), ambientI: 0.6,
    sun: C(0xffc98a), sunI: 1.5,
    disc: C(0xffc98f), discScale: 140, discY: 70, // a big, low golden sun
    cloud: C(0xffd5c6), cloudOpacity: 0.72,
    stars: 0.12, rain: 0,
  },
};
const SOUND_MOODS = {
  limbo: { // A minor over an A drone
    drone: [55, 55.4, 82.41], wind: 1, rain: 1,
    phrase: [ // null = rest — the silences matter as much as the notes
      'A4', null, 'C5', null, 'E5', null, 'D5', 'C5',
      null, null, 'A4', null, 'G4', null, null, null,
      'E4', null, 'G4', null, 'A4', null, 'C5', 'B4',
      null, null, 'A4', null, null, null, null, null,
    ],
  },
  cozy: { // the same notes leaning on C major, over a C drone — the same box, just warmer
    drone: [65.41, 65.8, 98.0], wind: 0.55, rain: 0,
    phrase: [
      'E5', null, 'C5', null, 'G4', null, 'A4', 'C5',
      null, null, 'D5', null, 'E5', null, null, null,
      'C5', null, 'G4', null, 'E4', null, 'G4', 'A4',
      null, null, 'C5', null, null, null, null, null,
    ],
  },
};

let savedMood = null;
try { savedMood = localStorage.getItem(MOOD_KEY); } catch { /* private mode */ }
const mood = {
  name: savedMood === 'cozy' ? 'cozy' : 'limbo',
  k: savedMood === 'cozy' ? 1 : 0, // 0 = limbo, 1 = cozy; eased toward the target each frame
  shown: -1,                       // the k the sky was last painted at
};
// the blended values for this frame
const MOOD_COLORS = ['fogBright', 'fogDeep', 'hemiSky', 'hemiGround', 'ambient', 'sun', 'disc', 'cloud'];
const moodNow = Object.fromEntries(MOOD_COLORS.map((key) => [key, new THREE.Color()]));

function updateMood(rawDt) {
  const target = mood.name === 'cozy' ? 1 : 0;
  if (mood.k !== target) {
    const stepK = rawDt / MOOD_FADE_S;
    mood.k = target > mood.k ? Math.min(target, mood.k + stepK) : Math.max(target, mood.k - stepK);
  }
  const e = easeInOut(mood.k);
  const a = MOODS.limbo, b = MOODS.cozy, mix = (x, y) => x + (y - x) * e;
  for (const key of MOOD_COLORS) moodNow[key].lerpColors(a[key], b[key], e);
  moodNow.hemi = mix(a.hemi, b.hemi);
  moodNow.sunI = mix(a.sunI, b.sunI);
  moodNow.stars = mix(a.stars, b.stars);
  scene.fog.near = mix(a.fogNear, b.fogNear);
  scene.fog.far = mix(a.fogFar, b.fogFar);
  hemiLight.color.copy(moodNow.hemiSky);
  hemiLight.groundColor.copy(moodNow.hemiGround);
  ambientLight.color.copy(moodNow.ambient);
  ambientLight.intensity = mix(a.ambientI, b.ambientI);
  moonLight.color.copy(moodNow.sun);
  moonSprite.material.color.copy(moodNow.disc);
  moonSprite.scale.setScalar(mix(a.discScale, b.discScale));
  moonSprite.position.y = mix(a.discY, b.discY);
  cloudMat.color.copy(moodNow.cloud);
  cloudMat.opacity = mix(a.cloudOpacity, b.cloudOpacity);
  const rainK = mix(a.rain, b.rain);
  rain.material.opacity = 0.34 * rainK;
  rain.visible = rainK > 0.01;
  if (mood.shown !== mood.k) { // repaint the sky only while it is changing
    const col = skyGeo.attributes.color.array, from = skyCols.limbo, to = skyCols.cozy;
    for (let i = 0; i < col.length; i++) col[i] = from[i] + (to[i] - from[i]) * e;
    skyGeo.attributes.color.needsUpdate = true;
    mood.shown = mood.k;
  }
}

function applySoundMood() {
  if (!sound.ctx) return;
  const s = SOUND_MOODS[mood.name], t = sound.ctx.currentTime, glide = MOOD_FADE_S / 3;
  sound.drone.forEach((osc, i) => osc.frequency.setTargetAtTime(s.drone[i], t, glide));
  sound.wind.gain.setTargetAtTime(s.wind, t, glide);
  sound.rain.gain.setTargetAtTime(s.rain, t, glide);
}

function paintMoodButton() {
  const cozy = mood.name === 'cozy';
  document.documentElement.dataset.mood = mood.name;
  const btn = $('btn-mood');
  btn.setAttribute('aria-checked', cozy ? 'true' : 'false');
  btn.title = cozy ? 'mood: cozy — switch to limbo' : 'mood: limbo — switch to cozy';
  btn.querySelector('.mood-knob').textContent = cozy ? '☀️' : '🌧';
  btn.querySelector('.mood-label').textContent = cozy ? 'cozy' : 'limbo';
}

function setMood(name) {
  mood.name = name;
  try { localStorage.setItem(MOOD_KEY, name); } catch { /* private mode: it just won't be remembered */ }
  paintMoodButton();
  applySoundMood();
}
$('btn-mood').addEventListener('click', () => setMood(mood.name === 'cozy' ? 'limbo' : 'cozy'));
paintMoodButton();
updateMood(0); // paint the saved mood straight away, no fade on load

// --------------------------------------------------------- post-processing
// The finishing pass that gives the meadow its dreamy look, applied to the whole
// frame after it is drawn:
//   1. bloom — bright things (the sun, lamps, the campfire, fireflies, ripening halos)
//      glow softly into their surroundings
//   2. the grade — a per-mood colour grade (limbo: cool, a little washed out; cozy:
//      warm, soft, lifted shadows), a soft vignette, a hint of colour fringing toward
//      the edges like an old lens, and a faint film grain
// ?fx=0 turns it all off (plain rendering), handy for comparing or on a weak device.
const FX_ON = new URLSearchParams(location.search).get('fx') !== '0';
const FX_MOODS = {
  limbo: { bloom: 0.38, shadowTint: [0.93, 0.95, 1.08], lightTint: [0.98, 1.0, 1.04], sat: 0.86, lift: 0.015, vignette: 0.38 },
  cozy:  { bloom: 0.55, shadowTint: [1.04, 0.96, 1.02], lightTint: [1.06, 1.01, 0.93], sat: 1.04, lift: 0.04, vignette: 0.24 },
};
const DreamGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
    uLightTint: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1 },
    uLift: { value: 0 },
    uVignette: { value: 0.4 },
    uFringe: { value: 0.012 }, // ~2px at the very corners, none in the middle
    uGrain: { value: 0.03 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uSat, uLift, uVignette, uFringe, uGrain;
    uniform vec3 uShadowTint, uLightTint;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 fromCentre = vUv - 0.5;
      float r2 = dot(fromCentre, fromCentre);
      // colour fringing: red and blue drift apart a touch, only toward the edges
      vec2 shift = fromCentre * r2 * uFringe;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv + shift).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - shift).b);
      // the scene arrives in linear light: turn it into screen colours first (three's own
      // helper), so everything below works on what you actually see
      col = sRGBTransferOETF(vec4(max(col, 0.0), 1.0)).rgb;
      // split-tone grade: shadows and highlights each lean their own way
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col *= mix(uShadowTint, uLightTint, smoothstep(0.0, 0.8, lum));
      col = mix(vec3(lum), col, uSat);
      col = col * (1.0 - uLift) + uLift; // lift the blacks into soft, milky shadows      // soft vignette
      col *= 1.0 - uVignette * smoothstep(0.12, 0.75, r2 * 2.2);
      // faint moving grain, strongest in the mid-tones
      float n = hash(vUv * 1000.0 + fract(uTime) * 97.0) - 0.5;
      col += n * uGrain * (1.0 - abs(lum - 0.5) * 1.6);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

// Performance notes (GPU time measured at 1700×900 on a Retina-sized canvas): the first
// version took ~57 ms a frame (≈17 fps); this one ~6 ms. Bloom and multisampling are what
// cost — the grade itself is nearly free. So: bloom blurs at 1/8 resolution, multisampling
// only on low-density screens (on Retina the extra pixels already hide the jaggies), the
// effects render at no more than FX_MAX_PR pixel density, and watchFxSpeed steps down on
// its own if the frame rate still sags.
const FX_MAX_PR = 1.25;
const fx = { composer: null, bloom: null, grade: null, level: 0 };
function buildFx() {
  const pr = Math.min(renderer.getPixelRatio(), FX_MAX_PR);
  const samples = renderer.getPixelRatio() >= 1.5 ? 0 : 2;
  const target = new THREE.WebGLRenderTarget(innerWidth * pr, innerHeight * pr, { type: THREE.HalfFloatType, samples });
  fx.composer = new EffectComposer(renderer, target);
  fx.composer.renderTarget2.samples = 0; // only the scene itself needs smoothing, not every pass after it
  fx.composer.setPixelRatio(pr);
  fx.composer.addPass(new RenderPass(scene, camera));
  fx.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.55, 0.82);
  const bloomSetSize = fx.bloom.setSize.bind(fx.bloom);
  fx.bloom.setSize = (w, h) => bloomSetSize(w / 4, h / 4); // a soft blur anyway: 1/8-res is plenty
  fx.composer.addPass(fx.bloom);
  // the grade also does the final linear → screen-colour step (one pass instead of two)
  fx.grade = new ShaderPass(DreamGradeShader);
  fx.composer.addPass(fx.grade);
  fx.composer.setSize(innerWidth, innerHeight);
}
if (FX_ON) buildFx();

// The safety net for slower devices: if the frame rate stays low, step down — first to
// plain pixel density, then without bloom, then no effects at all. It only ever steps
// down (no flicker back and forth), and only counts frames that were actually drawn.
const fxSpeed = { frames: 0, time: 0, last: 0 };
function watchFxSpeed(now) {
  if (!fx.composer || fx.level >= 3) return;
  const gap = (now - fxSpeed.last) / 1000;
  fxSpeed.last = now;
  if (gap <= 0 || gap > 0.25 || document.hidden) return; // paused, hidden, or just resumed
  fxSpeed.frames++;
  fxSpeed.time += gap;
  if (fxSpeed.time < 3) return;
  const fps = fxSpeed.frames / fxSpeed.time;
  fxSpeed.frames = 0;
  fxSpeed.time = 0;
  if (fps >= 48) return;
  fx.level++;
  if (fx.level === 1) { fx.composer.setPixelRatio(0.75); fx.composer.setSize(innerWidth, innerHeight); }
  else if (fx.level === 2) fx.bloom.enabled = false;
  else { fx.composer.dispose(); fx.composer = null; }
  console.info(`[meadow] effects stepped down to level ${fx.level} (${fps.toFixed(0)} fps)`);
}
const _fxA = new THREE.Vector3(), _fxB = new THREE.Vector3();
function renderFrame(elapsed) {
  watchFxSpeed(performance.now());
  if (!fx.composer) { renderer.render(scene, camera); return; }
  const e = easeInOut(mood.k), a = FX_MOODS.limbo, b = FX_MOODS.cozy, mix = (x, y) => x + (y - x) * e;
  const u = fx.grade.uniforms;
  u.uShadowTint.value.lerpVectors(_fxA.fromArray(a.shadowTint), _fxB.fromArray(b.shadowTint), e);
  u.uLightTint.value.lerpVectors(_fxA.fromArray(a.lightTint), _fxB.fromArray(b.lightTint), e);
  u.uSat.value = mix(a.sat, b.sat);
  u.uLift.value = mix(a.lift, b.lift);
  u.uVignette.value = mix(a.vignette, b.vignette);
  u.uTime.value = reduceMotion ? 0 : elapsed;
  fx.bloom.strength = mix(a.bloom, b.bloom);
  fx.composer.render();
}
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------- loop
const clock = new THREE.Clock();
window.addEventListener('pointerdown', (e) => {
  if (e.target.closest?.('#opener')) return; // the "Enter the meadow" click shouldn't skip the descent it starts
  if (intro.active) intro.t = intro.dur; // a tap skips the fly-in
});

function animate() {
  requestAnimationFrame(animate);
  const rawDt = Math.min(clock.getDelta(), 0.05);
  // the opener covers everything: don't spend the GPU on a world nobody can see. This also
  // holds the opening camera descent until you press "Enter the meadow".
  if (window.__openerActive) return;
  const dt = rawDt * (window.__timeScale ?? 1);
  const elapsed = clock.elapsedTime;

  // opening descent from above the clouds; any tap skips ahead
  if (intro.active) {
    intro.t += rawDt;
    const k = easeInOut(Math.min(1, intro.t / intro.dur));
    camera.position.lerpVectors(intro.from, intro.to, k);
    controls.target.set(0, 0, 0);
    if (k >= 1) {
      intro.active = false;
      controls.enabled = true;
    }
  }

  const panLim = focus.rec ? 108 : PAN_LIMIT; // wanderers can roam a little past the free-pan bounds
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, -panLim, panLim);
  controls.target.z = THREE.MathUtils.clamp(controls.target.z, -panLim, panLim);
  if (!focus.rec) controls.target.y += (0 - controls.target.y) * Math.min(1, rawDt * 3); // glide back to ground level
  updateZoom(rawDt);
  updateIdle(rawDt);
  controls.update();
  updateFocus(rawDt);
  keepCameraAboveGround();
  updateChips();
  if (rain.visible) updateRain(dt);

  // flowing water
  waterMat.map.offset.x -= dt * 0.3;
  for (let i = 0; i < waterfallMats.length; i++) {
    waterfallMats[i].map.offset.y += dt * (1.4 + i * 0.5);
  }
  for (const s of mistSprites) {
    const t = elapsed * 1.3 + s.userData.seed;
    s.position.y = s.userData.base.y + (Math.sin(t) * 0.5 + 0.5) * 2.2;
    s.material.opacity = 0.14 + (Math.cos(t) * 0.5 + 0.5) * 0.26;
  }

  // campfire flicker
  if (fireLight) {
    fireLight.intensity = 25 + Math.sin(elapsed * 7.3) * 4 + Math.sin(elapsed * 13.7) * 2.5;
    flameGroup.children.forEach((flame, i) => {
      flame.scale.y = 1 + Math.sin(elapsed * (6 + i * 2.3) + i) * 0.18;
      flame.rotation.y = elapsed * (1.2 + i * 0.6);
    });
  }

  // fireflies drifting
  {
    const p = fireflyGeo.attributes.position;
    for (let i = 0; i < fireflyData.length; i++) {
      const d = fireflyData[i];
      p.setXYZ(
        i,
        d.bx + Math.sin(elapsed * d.sx + d.px) * 2.6,
        d.by + Math.sin(elapsed * d.sy + d.py) * 0.8,
        d.bz + Math.cos(elapsed * d.sz + d.pz) * 2.6
      );
    }
    p.needsUpdate = true;
  }

  // the dusk breathes — an 8-minute drift so the world never feels frozen
  updateMood(rawDt);
  {
    const breath = Math.sin(elapsed * ((Math.PI * 2) / 480));
    moonLight.intensity = moodNow.sunI + breath * 0.12;
    hemiLight.intensity = moodNow.hemi + breath * 0.07;
    scene.fog.color.lerpColors(moodNow.fogBright, moodNow.fogDeep, (1 - breath) * 0.5);
    // stars twinkle softly, brighter when the dusk deepens (and fade out in the golden hour)
    starsMat.opacity = (0.72 - breath * 0.08 + Math.sin(elapsed * 0.8) * 0.14) * moodNow.stars;
  }

  for (const cloud of clouds) {
    cloud.position.x += cloud.userData.speed * dt;
    if (cloud.position.x > 240) cloud.position.x = -240;
  }

  for (const f of floaters) {
    f.position.y = f.userData.baseY + Math.sin(elapsed * 0.35 + f.userData.seed) * 2.2;
    f.rotation.y += f.userData.spin * dt;
  }

  for (const rec of [...characters.values()]) updateCharacter(rec, dt, elapsed);

  renderFrame(elapsed);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  fx.composer?.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------ start
poll().finally(() => {
  document.getElementById('loading').classList.add('gone');
});
animate();

// debug/dev handle (also handy in the console for the curious)
window.__meadow = { camera, controls, mood, setMood, idle, renderer, fx, scene, characters, ui, startAscension, setRipeness, world, poll, activitySpots, edgeSitSpots, beginEdgeSitTrip, bridges, focus, focusOn, releaseFocus, sound, drawKeepsake, intro };
