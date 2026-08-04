/*
 * Hypergate marketing site
 * Lenis smooth scroll + a WebGL liquid warp-gate + a drifting starfield.
 * All motion respects prefers-reduced-motion.
 */
import Lenis from 'lenis';
import { hydrateDownloadCtas } from './downloads';

void hydrateDownloadCtas();

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Lenis smooth scroll ──────────────────────────────────── */
const lenis = new Lenis({ autoRaf: false, lerp: 0.1 });
let scrollVelocity = 0;
lenis.on('scroll', (e: { velocity: number }) => {
  scrollVelocity = e.velocity;
  applyParallax();
});

// anchor links scroll through lenis so easing stays consistent
for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-scroll]')) {
  a.addEventListener('click', (ev) => {
    const href = a.getAttribute('href');
    if (!href?.startsWith('#')) return;
    ev.preventDefault();
    lenis.scrollTo(href === '#top' ? 0 : href, { offset: -20, duration: 1.4 });
  });
}

/* ── nav backdrop after the fold ──────────────────────────── */
const nav = document.getElementById('nav')!;
const onScrollNav = () => nav.classList.toggle('scrolled', window.scrollY > 24);
onScrollNav();

/* ── reveal on enter ──────────────────────────────────────── */
for (const el of document.querySelectorAll<HTMLElement>('.reveal, .fly')) {
  const d = el.dataset.delay;
  if (d) el.style.setProperty('--rd', `${d}ms`);
}
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }
  },
  { threshold: 0.16 },
);
for (const el of document.querySelectorAll('.reveal')) io.observe(el);

/* ── screenshot parallax ──────────────────────────────────── */
const parallaxEls = [...document.querySelectorAll<HTMLElement>('[data-parallax]')];
function applyParallax() {
  if (reduced) return;
  const vh = window.innerHeight;
  for (const el of parallaxEls) {
    const f = Number(el.dataset.parallax ?? 0);
    const r = el.getBoundingClientRect();
    const mid = r.top + r.height / 2 - vh / 2;
    el.style.transform = `translateY(${(-mid * f).toFixed(1)}px)`;
  }
}

/* ── starfield ────────────────────────────────────────────── */
const starCanvas = document.getElementById('stars') as HTMLCanvasElement;
const sCtx = starCanvas.getContext('2d')!;
type Star = { x: number; y: number; r: number; tw: number; ph: number; drift: number };
let stars: Star[] = [];

function seedStars() {
  const dpr = Math.min(window.devicePixelRatio, 2);
  starCanvas.width = innerWidth * dpr;
  starCanvas.height = innerHeight * dpr;
  sCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = Math.floor((innerWidth * innerHeight) / 6500);
  stars = Array.from({ length: n }, () => ({
    x: Math.random() * innerWidth,
    y: Math.random() * innerHeight,
    r: Math.random() * 1.2 + 0.3,
    tw: Math.random() * 0.8 + 0.2,
    ph: Math.random() * Math.PI * 2,
    drift: Math.random() * 0.16 + 0.04,
  }));
}

function drawStars(t: number) {
  sCtx.clearRect(0, 0, innerWidth, innerHeight);
  const warp = Math.min(Math.abs(scrollVelocity) * 0.02, 1.4);
  for (const s of stars) {
    const a = 0.25 + 0.55 * Math.abs(Math.sin(t * 0.0006 * s.tw + s.ph));
    sCtx.globalAlpha = a;
    if (warp > 0.08) {
      // scroll fast and the stars streak: the warp effect
      sCtx.strokeStyle = '#cdd8ff';
      sCtx.lineWidth = s.r;
      sCtx.beginPath();
      sCtx.moveTo(s.x, s.y);
      sCtx.lineTo(s.x, s.y + warp * 26 * s.drift * Math.sign(scrollVelocity));
      sCtx.stroke();
    } else {
      sCtx.fillStyle = '#cdd8ff';
      sCtx.beginPath();
      sCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      sCtx.fill();
    }
    s.y += s.drift * 0.06;
    if (s.y > innerHeight + 4) s.y = -4;
  }
  sCtx.globalAlpha = 1;
}

/* ── the gate: a WebGL liquid warp ring ───────────────────── */
const gateCanvas = document.getElementById('gate') as HTMLCanvasElement;
const gl = gateCanvas.getContext('webgl', { alpha: true, antialias: false });

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;

// hash + noise + fbm: the standard trio, tuned for liquid
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i = 0; i < 5; i++){
    v += a * noise(p);
    p = p * 2.03 + vec2(17.0, 9.2);
    a *= 0.55;
  }
  return v;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  uv.y -= 0.04;

  float t = u_time * 0.00016;
  float r = length(uv);
  float ang = atan(uv.y, uv.x);

  // liquid domain warp swirling around the ring
  vec2 orbit = vec2(cos(ang), sin(ang));
  vec2 p = mix(uv * 4.0, orbit * (1.0 + r * 1.8), smoothstep(0.12, 0.28, r));
  float w1 = fbm(p * 2.2 + vec2(t * 2.4, -t * 1.1));
  float w2 = fbm(p * 3.6 - vec2(t * 1.7, t * 2.2) + w1 * 1.8);
  float liquid = fbm(p * 2.8 + vec2(w2 * 2.2, w1 * 1.6) + vec2(0.0, -t * 3.0));

  // the gate ring
  float R = 0.34;
  float d = abs(r - R - (liquid - 0.5) * 0.045);
  float ring = smoothstep(0.075, 0.0, d);
  float halo = smoothstep(0.34, 0.0, d) * 0.32;

  // event-horizon core
  float core = smoothstep(0.26, 0.0, r) * (0.5 + 0.5 * liquid) * 0.55;

  // faint nebula wash outside
  float neb = fbm(uv * 2.4 + vec2(t * 0.8, -t * 0.5)) * smoothstep(1.0, 0.35, r) * 0.10;

  vec3 violet = vec3(0.427, 0.369, 0.988);
  vec3 cyan   = vec3(0.133, 0.827, 0.933);
  vec3 ice    = vec3(0.647, 0.953, 0.988);

  vec3 col = vec3(0.0);
  vec3 ringCol = mix(violet, cyan, 0.5 + 0.5 * sin(ang + liquid * 4.0 + t * 6.0));
  col += ring * mix(ringCol, ice, pow(liquid, 3.0)) * 1.15;
  col += halo * ringCol;
  col += core * mix(cyan, ice, liquid);
  col += neb * violet;

  float alpha = clamp(ring + halo + core * 0.9 + neb, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha * 0.92);
}
`;

const VERT = `
attribute vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

let uTime: WebGLUniformLocation | null = null;
let uRes: WebGLUniformLocation | null = null;
let gateInView = true;
let starsInView = true;

function initGate(): boolean {
  if (!gl) return false;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return false;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  uTime = gl.getUniformLocation(prog, 'u_time');
  uRes = gl.getUniformLocation(prog, 'u_res');
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  return true;
}

function sizeGate() {
  if (!gl) return;
  const dpr = Math.min(window.devicePixelRatio, 1.75);
  const rect = gateCanvas.getBoundingClientRect();
  gateCanvas.width = rect.width * dpr;
  gateCanvas.height = rect.height * dpr;
  gl.viewport(0, 0, gateCanvas.width, gateCanvas.height);
}

const gateOk = initGate();
if (!gateOk) {
  // WebGL unavailable: a calm CSS gate stands in
  gateCanvas.style.background =
    'radial-gradient(circle at 50% 46%, transparent 118px, rgba(109,94,252,.5) 128px, rgba(34,211,238,.45) 148px, transparent 170px)';
}

function drawGate(t: number) {
  if (!gl || !gateOk) return;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform1f(uTime, t);
  gl.uniform2f(uRes, gateCanvas.width, gateCanvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* ── main loop ────────────────────────────────────────────── */
const canvasVisibility = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const inView = entry.isIntersecting;
      if (entry.target === gateCanvas) gateInView = inView;
      if (entry.target === starCanvas) starsInView = inView;
      if (inView && reduced) {
        if (entry.target === gateCanvas) drawGate(0);
        if (entry.target === starCanvas) drawStars(0);
      }
    }
  },
  { threshold: 0 },
);
canvasVisibility.observe(gateCanvas);
canvasVisibility.observe(starCanvas);

let frameId: number | undefined;
function frame(t: number) {
  frameId = undefined;
  if (document.visibilityState === 'hidden') return;
  lenis.raf(t);
  onScrollNav();
  if (!reduced) {
    if (starsInView) drawStars(t);
    if (gateInView) drawGate(t);
  }
  frameId = requestAnimationFrame(frame);
}

function startFrame() {
  if (document.visibilityState !== 'hidden' && frameId === undefined) {
    frameId = requestAnimationFrame(frame);
  }
}

function sizeAll() {
  seedStars();
  sizeGate();
  drawStars(0);
  drawGate(0);
  applyParallax();
}
window.addEventListener('resize', sizeAll);
sizeAll();
startFrame();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (frameId !== undefined) cancelAnimationFrame(frameId);
    frameId = undefined;
    return;
  }
  onScrollNav();
  startFrame();
});
