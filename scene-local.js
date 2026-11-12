(function(){
const THREE=window.THREE;

const canvas = document.getElementById('studio-canvas');
const stage = document.querySelector('.story-stage');
const sticky = document.querySelector('.material-sticky');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const omega = 24;
const listeners = new Set();
const state = {
  q: 0, v: 0, p: 0, lastTime: null, running: false,
  frameId: 0, available: false, ready: false, renderCount: 0,
  width: 0, height: 620, progress: 0
};

const clamp01 = value => Math.max(0, Math.min(1, value));
const mix = (a, b, t) => a + (b - a) * t;
const renderBleed = 48;

function createJShape() {
  const shape = new THREE.Shape();
  const x = value => value - 320;
  const y = value => 320 - value;
  shape.moveTo(x(128), y(82));
  shape.lineTo(x(489), y(82));
  shape.lineTo(x(489), y(372));
  shape.bezierCurveTo(x(489), y(521), x(399), y(605), x(269), y(605));
  shape.bezierCurveTo(x(145), y(605), x(66), y(530), x(66), y(421));
  shape.bezierCurveTo(x(66), y(372), x(82), y(330), x(112), y(294));
  shape.lineTo(x(213), y(340));
  shape.bezierCurveTo(x(192), y(365), x(181), y(390), x(181), y(418));
  shape.bezierCurveTo(x(181), y(478), x(216), y(513), x(272), y(513));
  shape.bezierCurveTo(x(338), y(513), x(379), y(473), x(379), y(371));
  shape.lineTo(x(379), y(198));
  shape.lineTo(x(128), y(198));
  shape.closePath();
  return shape;
}

function sourceGroupAt(groups, vertexStart) {
  return groups.find(group => vertexStart >= group.start && vertexStart < group.start + group.count);
}

function buildExtrusion() {
  const depth = 30;
  let geometry = new THREE.ExtrudeGeometry(createJShape(), {
    depth,
    steps: 1,
    curveSegments: 64,
    bevelEnabled: true,
    bevelSegments: 5,
    bevelThickness: 2.5,
    bevelSize: 2
  });
  if (geometry.index) geometry = geometry.toNonIndexed();

  const position = geometry.getAttribute('position');
  const sourceGroups = geometry.groups.slice();
  const faceMaterials = [];
  for (let start = 0; start < position.count; start += 3) {
    const source = sourceGroupAt(sourceGroups, start);
    let materialIndex = source?.materialIndex ?? 0;
    if (materialIndex === 1) {
      const a = new THREE.Vector3().fromBufferAttribute(position, start);
      const b = new THREE.Vector3().fromBufferAttribute(position, start + 1);
      const c = new THREE.Vector3().fromBufferAttribute(position, start + 2);
      const normal = b.sub(a).cross(c.sub(a)).normalize();
      materialIndex = Math.abs(normal.z) > 0.08 ? 1 : 2;
    }
    faceMaterials.push(materialIndex);
  }

  geometry.clearGroups();
  let runStart = 0;
  let runMaterial = faceMaterials[0] ?? 0;
  for (let face = 1; face <= faceMaterials.length; face += 1) {
    const next = faceMaterials[face];
    if (next === runMaterial) continue;
    geometry.addGroup(runStart * 3, (face - runStart) * 3, runMaterial);
    runStart = face;
    runMaterial = next;
  }

  const backShearX = 20;
  const backShearY = 20;
  for (let i = 0; i < position.count; i += 1) {
    const z = position.getZ(i) - depth;
    const back = clamp01(-z / depth);
    position.setXYZ(i,
      position.getX(i) + backShearX * back,
      position.getY(i) - backShearY * back,
      z);
  }
  position.needsUpdate = true;

  geometry.computeVertexNormals();
  const normal = geometry.getAttribute('normal');
  const smoothNormals = new Map();
  const keyAt = i => `${position.getX(i).toFixed(3)},${position.getY(i).toFixed(3)},${position.getZ(i).toFixed(3)}`;
  for (let i = 0; i < position.count; i += 1) {
    if (faceMaterials[Math.floor(i / 3)] === 0) continue;
    const key = keyAt(i);
    const sum = smoothNormals.get(key) ?? new THREE.Vector3();
    sum.x += normal.getX(i);
    sum.y += normal.getY(i);
    sum.z += normal.getZ(i);
    smoothNormals.set(key, sum);
  }
  for (let i = 0; i < position.count; i += 1) {
    if (faceMaterials[Math.floor(i / 3)] === 0) continue;
    const averaged = smoothNormals.get(keyAt(i)).normalize();
    normal.setXYZ(i, averaged.x, averaged.y, averaged.z);
  }
  normal.needsUpdate = true;
  geometry.computeBoundingSphere();
  geometry.userData.bevelSegments = 5;
  geometry.userData.bevelThickness = 2.5;
  return geometry;
}

let renderer;
let scene;
let camera;
let jGroup;
let jMesh;
let ball;
let resizeObserver;
let failed = false;

const jFront = new THREE.MeshPhysicalMaterial({
  color: 0x28b7cd,
  metalness: 0.22,
  roughness: 0.34,
  clearcoat: 0.1,
  clearcoatRoughness: 0.4
});
const jBevel = new THREE.MeshPhysicalMaterial({
  color: 0x2789b4,
  metalness: 0.18,
  roughness: 0.38,
  clearcoat: 0.08,
  clearcoatRoughness: 0.42
});
const jSide = new THREE.MeshPhysicalMaterial({
  color: 0x2366b0,
  metalness: 0.22,
  roughness: 0.38,
  clearcoat: 0.08,
  clearcoatRoughness: 0.42
});
const ballMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xf17820,
  metalness: 0.08,
  roughness: 0.48,
  clearcoat: 0,
  clearcoatRoughness: 0.46
});

function snapshot() {
  return {
    q: state.q,
    v: state.v,
    p: state.p,
    running: state.running,
    scrollY: window.scrollY,
    ballY: 420 * state.q * state.q,
    jTransform: {
      x: 56 * state.q,
      cssRotation: mix(-6, 2, state.q),
      scale: mix(0.94, 0.8, state.q),
      tiltX: mix(-5, -2, state.q),
      tiltY: mix(-5, 3, state.q)
    },
    renderCount: state.renderCount,
    ready: state.ready,
    webgl: state.ready,
    available: state.available,
    reducedMotion: reducedMotion.matches
  };
}

function emit() {
  if (!listeners.size) return;
  const value = snapshot();
  listeners.forEach(listener => listener(value));
}

window.__studioMotion = {
  getState: snapshot,
  getProjectedGeometry() {
    if (!state.ready || !jMesh || !ball) return null;
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const stickyRect = sticky.getBoundingClientRect();
    const renderHeight = state.height + renderBleed * 2;
    const project = (point, matrix) => {
      point.applyMatrix4(matrix).project(camera);
      return {
        x: stickyRect.left + (point.x + 1) * state.width / 2,
        y: stickyRect.top - renderBleed + (1 - point.y) * renderHeight / 2,
        depth: point.z
      };
    };
    const positions = jMesh.geometry.getAttribute('position');
    const jVertices = new Array(positions.count);
    for (let i = 0; i < positions.count; i += 1) {
      jVertices[i] = project(new THREE.Vector3().fromBufferAttribute(positions, i), jMesh.matrixWorld);
    }
    const ballCenter = project(new THREE.Vector3(0, 0, 0), ball.matrixWorld);
    const ballEdge = project(new THREE.Vector3(48, 0, 0), ball.matrixWorld);
    return {
      coordinateSpace: 'viewport-css-pixels',
      q: state.q,
      jVertices,
      jGroups: jMesh.geometry.groups.map(({ start, count, materialIndex }) => ({ start, count, materialIndex })),
      ball: {
        center: { x: ballCenter.x, y: ballCenter.y },
        radius: Math.hypot(ballEdge.x - ballCenter.x, ballEdge.y - ballCenter.y)
      }
    };
  },
  exportFallback() {
    if (!renderer || !state.ready || !jMesh || !ball) return null;
    const savedQ = state.q;
    state.q = 0;
    setScenePose();
    renderer.render(scene, camera);
    const png = canvas.toDataURL('image/png');
    state.q = savedQ;
    setScenePose();
    if (state.available && !document.hidden && !failed) renderer.render(scene, camera);
    return { png, width: canvas.width, height: canvas.height, cssWidth: state.width, cssHeight: state.height + renderBleed * 2 };
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};

// Measure layout only on initialization, resize and resume, never in the animation loop.
const layout = { top: 0, height: 1, stickyHeight: 620, inset: 100, left: 0, right: 1 };
function measureLayout() {
  const rect = sticky.getBoundingClientRect();
  layout.top = scrollY + stage.getBoundingClientRect().top;
  layout.height = stage.offsetHeight;
  layout.stickyHeight = sticky.offsetHeight;
  layout.inset = parseFloat(getComputedStyle(sticky).top) || 0;
  layout.left = rect.left;
  layout.right = rect.right;
}
function intersectsViewport() {
  const top = Math.min(Math.max(layout.top - scrollY, layout.inset),
    layout.top + layout.height - scrollY - layout.stickyHeight);
  return top + layout.stickyHeight > 0 && top < innerHeight &&
    layout.right > 0 && layout.left < innerWidth;
}
function readProgress() {
  return clamp01((scrollY - layout.top) / Math.max(1, layout.height - layout.stickyHeight));
}

function configureSize() {
  if (!renderer) return;
  const rect = sticky.getBoundingClientRect();
  state.width = Math.max(1, rect.width);
  state.height = Math.max(1, rect.height);
  const renderHeight = state.height + renderBleed * 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(state.width, renderHeight, false);
  camera.left = -state.width / 2;
  camera.right = state.width / 2;
  camera.top = renderHeight / 2;
  camera.bottom = -renderHeight / 2;
  camera.updateProjectionMatrix();
}

function setScenePose() {
  const q = state.q;
  const trackScale = state.width / 640;
  const fit = trackScale * mix(0.94, 0.8, q);
  jGroup.position.set(56 * q, -24, 0);
  jGroup.scale.setScalar(fit);
  jGroup.rotation.set(
    THREE.MathUtils.degToRad(mix(-5, -2, q)),
    THREE.MathUtils.degToRad(mix(-5, 3, q)),
    THREE.MathUtils.degToRad(mix(6, -2, q))
  );
  ball.position.set(
    state.width / 2 - 48,
    state.height / 2 - (55 + 48 + 420 * q * q),
    34
  );
}

function paint() {
  if (!state.ready || !renderer) return false;
  setScenePose();
  if (!state.available || document.hidden || failed) return false;
  try {
    renderer.render(scene, camera);
    state.renderCount += 1;
    sticky.classList.add('webgl-ready');
    return true;
  } catch (error) {
    failed = true;
    state.ready = false;
    sticky.classList.remove('webgl-ready');
    console.error('3D preview render failed; static artwork remains visible.', error);
    return false;
  }
}

function cancelFrame() {
  if (state.frameId) cancelAnimationFrame(state.frameId);
  state.frameId = 0;
  state.running = false;
  state.lastTime = null;
}

function syncDirect() {
  measureLayout();
  cancelFrame();
  state.p = readProgress();
  state.q = reducedMotion.matches ? 0 : state.p;
  state.v = 0;
  state.available = !document.hidden && intersectsViewport();
  paint();
  emit();
}

function suspend() {
  cancelFrame();
  state.available = false;
}

function frame(time) {
  state.frameId = 0;
  if (document.hidden || !intersectsViewport()) {
    suspend();
    return;
  }
  if (reducedMotion.matches) {
    syncDirect();
    return;
  }

  state.p = readProgress();
  const dt = state.lastTime === null ? 0 : Math.max(0, (time - state.lastTime) / 1000);
  state.lastTime = time;
  if (dt > 0) {
    const error = state.q - state.p;
    const c = state.v + omega * error;
    const decay = Math.exp(-omega * dt);
    const nextQ = state.p + (error + c * dt) * decay;
    const nextV = (state.v - omega * c * dt) * decay;
    state.q = nextQ;
    state.v = nextV;
    if (state.q < 0) {
      state.q = 0;
      if (state.v < 0) state.v = 0;
    } else if (state.q > 1) {
      state.q = 1;
      if (state.v > 0) state.v = 0;
    }
  }

  const ballError = Math.abs(420 * (state.q * state.q - state.p * state.p));
  const ballSpeed = Math.abs(840 * state.q * state.v);
  if (Math.abs(state.q - state.p) <= 0.001 && Math.abs(state.v) <= 0.01 &&
      ballError <= 0.05 && ballSpeed <= 0.8) {
    state.q = state.p;
    state.v = 0;
    paint();
    state.running = false;
    state.lastTime = time;
    emit();
    return;
  }

  paint();
  state.running = true;
  emit();
  state.frameId = requestAnimationFrame(frame);
}

function onScroll() {
  state.p = readProgress();
  if (reducedMotion.matches) {
    state.q = 0;
    state.v = 0;
    cancelFrame();
    state.available = !document.hidden && intersectsViewport();
    paint();
    emit();
    return;
  }
  if (document.hidden || !intersectsViewport()) {
    suspend();
    return;
  }
  if (!state.available) {
    syncDirect();
    return;
  }
  if (!state.running && Math.abs(state.q - state.p) > 0) {
    state.running = true;
    state.lastTime = performance.now();
    state.frameId = requestAnimationFrame(frame);
  }
}

function init() {
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setClearColor(0x000000, 0);

    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 310, -310, 0.1, 1600);
    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);

    const environmentCanvas = document.createElement('canvas');
    environmentCanvas.width = 1024;
    environmentCanvas.height = 512;
    const context = environmentCanvas.getContext('2d');
    const roomTone = context.createLinearGradient(0, 0, 0, environmentCanvas.height);
    roomTone.addColorStop(0, '#AAB4BC');
    roomTone.addColorStop(0.5, '#8D9CA7');
    roomTone.addColorStop(1, '#7F919D');
    context.fillStyle = roomTone;
    context.fillRect(0, 0, environmentCanvas.width, environmentCanvas.height);
    const softbox = context.createRadialGradient(270, 112, 22, 270, 112, 300);
    softbox.addColorStop(0, 'rgba(255,255,255,0.92)');
    softbox.addColorStop(0.42, 'rgba(255,255,255,0.67)');
    softbox.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = softbox;
    context.fillRect(0, 0, 600, 360);
    const environment = new THREE.CanvasTexture(environmentCanvas);
    environment.mapping = THREE.EquirectangularReflectionMapping;
    environment.colorSpace = THREE.SRGBColorSpace;
    scene.environment = environment;
    scene.environmentIntensity = 2.2;

    const key = new THREE.DirectionalLight(0xfff9f2, 2.0);
    key.position.set(-380, 430, 460);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd9eaff, 0.65);
    fill.position.set(420, 120, 300);
    scene.add(fill);
    const ambient = new THREE.HemisphereLight(0xffffff, 0x9baebb, 0.35);
    scene.add(ambient);

    jGroup = new THREE.Group();
    jMesh = new THREE.Mesh(buildExtrusion(), [jFront, jBevel, jSide]);
    jMesh.castShadow = false;
    jMesh.receiveShadow = false;
    jGroup.add(jMesh);
    scene.add(jGroup);

    ball = new THREE.Mesh(new THREE.SphereGeometry(48, 64, 48), ballMaterial);
    scene.add(ball);

    configureSize();
    state.ready = true;
    syncDirect();
    resizeObserver = new ResizeObserver(() => {
      configureSize();
      syncDirect();
    });
    resizeObserver.observe(sticky);
  } catch (error) {
    state.ready = false;
    failed = true;
    sticky.classList.remove('webgl-ready');
    console.error('3D preview could not start; static artwork remains visible.', error);
  }
}

window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', syncDirect, { passive: true });
window.addEventListener('pageshow', syncDirect, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspend();
  else syncDirect();
}, { passive: true });
reducedMotion.addEventListener?.('change', syncDirect);
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  failed = true;
  state.ready = false;
  state.available = false;
  cancelFrame();
  sticky.classList.remove('webgl-ready');
  emit();
});

init();

})();
