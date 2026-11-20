import * as THREE from "../vendor/three.module.js";

const PLANET_SPECS = [
  { name: "Mercury (I)", radius: 0.36, orbitRadius: 1.05, speedDegPerSec: 12.0, height: 2.25, baseHex: 0xc89b5e },
  { name: "Venus (II)", radius: 0.36, orbitRadius: 1.65, speedDegPerSec: 9.5, height: 2.18, baseHex: 0xdfa860 },
  { name: "Earth (III)", radius: 0.38, orbitRadius: 2.20, speedDegPerSec: 7.5, height: 2.12, baseHex: 0x5a92c4 },
  { name: "Mars (IV)", radius: 0.34, orbitRadius: 2.75, speedDegPerSec: 6.0, height: 2.06, baseHex: 0xc86446 },
  { name: "Jupiter (V)", radius: 0.46, orbitRadius: 3.35, speedDegPerSec: 4.5, height: 2.02, baseHex: 0xd49b6a },
  { name: "Saturn (VI)", radius: 0.42, orbitRadius: 3.95, speedDegPerSec: 3.4, height: 1.98, baseHex: 0xd8be7a },
  { name: "Uranus (VII)", radius: 0.38, orbitRadius: 4.50, speedDegPerSec: 2.5, height: 1.94, baseHex: 0x76b4c8 }
];

const RING_SPECS = [
  { radius: 2.35, tube: 0.14, tiltX: 0.22, tiltZ: -0.14, speedDeg: 0.45, y: 1.05 },
  { radius: 3.25, tube: 0.16, tiltX: -0.26, tiltZ: 0.18, speedDeg: -0.32, y: 1.05 },
  { radius: 4.15, tube: 0.18, tiltX: 0.18, tiltZ: 0.22, speedDeg: 0.24, y: 1.05 }
];

const CHART_COLS = 4;
const CHART_ROWS = 3;
const PLAQUE_WIDTH = 3.2;
const PLAQUE_HEIGHT = 2.4;
const PLAQUE_POS = new THREE.Vector3(-3.35, 3.05, -2.45);
const FOCUSED_PLANET_RGB = [52, 212, 196];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashLabel(seed, label) {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function makeFallbackRng(seed) {
  const gen = mulberry32(seed);
  return {
    next: () => gen(),
    int: (n) => Math.floor(gen() * n),
    fork: (label) => makeFallbackRng(hashLabel(seed, String(label)))
  };
}

function ensureHost() {
  if (typeof window !== "undefined" && window.__benchHost) {
    return window.__benchHost;
  }
  let clockMs = 0;
  const host = {
    contractVersion: 1,
    seed: 1,
    params: {},
    clock: {
      now: () => clockMs,
      _set: (t) => {
        clockMs = Number(t) || 0;
      }
    },
    rng: makeFallbackRng(1)
  };
  if (typeof window !== "undefined") {
    window.__benchHost = host;
  }
  return host;
}

function deriveSeedParams(seed, hostParams = {}) {
  const rng = makeFallbackRng(hashLabel(seed, "orrery_params"));
  const orbitPhasesDeg = Array.isArray(hostParams.orbitPhasesDeg) && hostParams.orbitPhasesDeg.length === PLANET_SPECS.length
    ? hostParams.orbitPhasesDeg
    : PLANET_SPECS.map((_, idx) => Number(((rng.next() * 280 + idx * 42) % 360).toFixed(4)));

  const cameraPath = hostParams.cameraPath || {
    basePosition: [0.25, 3.55, 7.35],
    baseTarget: [-0.45, 1.45, -0.45],
    driftAmp: [0.025, 0.012, 0.02],
    driftPhase: Number((rng.next() * Math.PI * 2).toFixed(4)),
    driftFreqHz: 0.08
  };

  return {
    seed,
    orbitPhasesDeg,
    cameraPath
  };
}

function validateViewportDimensions(w, h) {
  const safeW = Number.isFinite(w) && w > 0 ? Math.floor(w) : 1440;
  const safeH = Number.isFinite(h) && h > 0 ? Math.floor(h) : 900;
  const aspect = safeW / Math.max(1, safeH);
  return { width: safeW, height: safeH, aspect };
}

function releaseResourceList(list) {
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item && typeof item.dispose === "function") {
      item.dispose();
    }
  }
  list.length = 0;
}

function makeColor(hex) {
  const color = new THREE.Color(hex);
  return color;
}

function loadImageTexture(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.needsUpdate = true;
      resolve(tex);
    };
    img.onerror = () => reject(new Error(`Failed to load texture: ${url}`));
    img.src = url;
  });
}

function createFloorStoneTexture() {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const checker = ((x >> 3) + (y >> 3)) & 1;
      const v = checker ? 34 : 24;
      data[idx] = v;
      data[idx + 1] = v + 2;
      data[idx + 2] = v + 7;
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createCompassDecalTexture() {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const half = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const r = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const idx = (y * size + x) * 4;
      if (r > 0.98) {
        data[idx] = 28;
        data[idx + 1] = 31;
        data[idx + 2] = 40;
        data[idx + 3] = 255;
        continue;
      }
      const spoke = Math.cos(angle * 24.0) > 0.25 ? 1 : 0;
      const ringBand = Math.sin(r * 38.0) > 0.0 ? 1 : 0;
      const pattern = spoke ^ ringBand;
      if (pattern) {
        data[idx] = 216;
        data[idx + 1] = 184;
        data[idx + 2] = 112;
      } else {
        data[idx] = 64;
        data[idx + 1] = 56;
        data[idx + 2] = 44;
      }
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createOrreryBench(defaultContainer) {
  const host = ensureHost();
  const chartUrl = new URL("../assets/color-chart.png", import.meta.url).href;

  let currentContainer = defaultContainer;
  let currentSeed = typeof host.seed === "number" ? host.seed : 1;
  let seedParams = deriveSeedParams(currentSeed, host.params || {});
  let currentClockMs = typeof host.clock?.now === "function" ? host.clock.now() : 0;
  let isPaused = false;
  let isMounted = false;
  let rafId = null;

  let focusedIndex = 0;
  let orbitAngleDeg = 0;

  let renderer = null;
  let scene = null;
  let camera = null;
  let keyLight = null;
  let chartImageTexture = null;

  let planetGroupList = [];
  let planetMeshList = [];
  let ringMeshList = [];
  let plaqueMesh = null;
  let plaqueMaterial = null;
  let decalMesh = null;
  let decalMaterial = null;
  let floorMesh = null;
  let chartTexture = null;

  const allocatedGeometries = [];
  const allocatedMaterials = [];
  const allocatedTextures = [];
  const retainCache = [];

  let activeListenerCount = 0;
  let onNextPlanetClick = null;
  let onWindowResize = null;
  let nextBtn = null;

  function trackGeometry(g) {
    allocatedGeometries.push(g);
    return g;
  }

  function trackMaterial(m) {
    allocatedMaterials.push(m);
    return m;
  }

  function trackTexture(t) {
    allocatedTextures.push(t);
    return t;
  }

  function updateFocusReadout() {
    const el = typeof document !== "undefined" ? document.getElementById("focused-planet-name") : null;
    if (el && PLANET_SPECS[focusedIndex]) {
      el.textContent = PLANET_SPECS[focusedIndex].name;
    }
  }

  function ensureRenderer(width, height) {
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: true
      });
      renderer.setPixelRatio(1);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1.0;
    }
    renderer.setSize(width, height, false);
  }

  function buildSceneGraph(width, height) {
    scene = new THREE.Scene();
    scene.background = makeColor(0x141822);

    camera = new THREE.PerspectiveCamera(42, width / height, 0.2, 80);

    const ambient = new THREE.AmbientLight(makeColor(0xd8e0f0), 0.75);
    scene.add(ambient);

    keyLight = new THREE.DirectionalLight(makeColor(0xfff2d6), 2.1);
    keyLight.position.set(4.5, 7.5, 5.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 25;
    keyLight.shadow.bias = -0.0025;
    keyLight.shadow.normalBias = 0.03;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(makeColor(0x8aa4d6), 0.65);
    fillLight.position.set(-5.0, 4.0, -3.0);
    scene.add(fillLight);

    const wallGeom = trackGeometry(new THREE.PlaneGeometry(18, 10));
    const wallMat = trackMaterial(
      new THREE.MeshStandardMaterial({
        color: makeColor(0x1c2130),
        roughness: 0.85,
        metalness: 0.08
      })
    );
    const wallMesh = new THREE.Mesh(wallGeom, wallMat);
    wallMesh.position.set(0, 4.2, -3.2);
    wallMesh.receiveShadow = true;
    scene.add(wallMesh);

    const floorTex = trackTexture(createFloorStoneTexture());
    const floorGeom = trackGeometry(new THREE.PlaneGeometry(18, 18, 32, 32));
    const floorMat = trackMaterial(
      new THREE.MeshStandardMaterial({
        color: makeColor(0xffffff),
        map: floorTex,
        roughness: 0.82,
        metalness: 0.1
      })
    );
    floorMesh = new THREE.Mesh(floorGeom, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = 0.0;
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);

    const decalTex = trackTexture(createCompassDecalTexture());
    const decalGeom = trackGeometry(new THREE.CircleGeometry(3.45, 56));
    decalMaterial = trackMaterial(
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: decalTex },
          uTint: { value: makeColor(0xffffff) },
          uViewPhase: { value: 0.0 },
          uCoplanarBlend: { value: 0.0 }
        },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vWorldPos;
          void main() {
            vUv = uv;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          uniform sampler2D uMap;
          uniform vec3 uTint;
          uniform float uViewPhase;
          uniform float uCoplanarBlend;
          varying vec2 vUv;
          varying vec3 vWorldPos;
          void main() {
            vec4 texel = texture2D(uMap, vUv);
            vec3 col = texel.rgb * uTint;
            if (uCoplanarBlend > 0.5) {
              float cell = floor(gl_FragCoord.x * 0.5) * 17.0 + floor(gl_FragCoord.y * 0.5) * 31.0;
              float wave = sin(cell + uViewPhase * 3.7 + vWorldPos.x * 19.0 + vWorldPos.z * 23.0);
              col = wave > 0.0 ? vec3(0.88, 0.78, 0.52) : vec3(0.08, 0.09, 0.13);
            }
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      })
    );
    decalMesh = new THREE.Mesh(decalGeom, decalMaterial);
    decalMesh.rotation.x = -Math.PI / 2;
    decalMesh.position.set(0.55, 0.012, 0.35);
    decalMaterial.polygonOffset = true;
    decalMaterial.polygonOffsetFactor = -2;
    scene.add(decalMesh);

    const pedestalGeom = trackGeometry(new THREE.CylinderGeometry(0.42, 0.58, 1.05, 32));
    const pedestalMat = trackMaterial(
      new THREE.MeshStandardMaterial({
        color: makeColor(0x9a7838),
        roughness: 0.35,
        metalness: 0.82
      })
    );
    const pedestalMesh = new THREE.Mesh(pedestalGeom, pedestalMat);
    pedestalMesh.position.set(0.55, 0.52, 0.35);
    pedestalMesh.castShadow = true;
    pedestalMesh.receiveShadow = true;
    scene.add(pedestalMesh);

    const sunGeom = trackGeometry(new THREE.SphereGeometry(0.48, 32, 24));
    const sunMat = trackMaterial(
      new THREE.MeshStandardMaterial({
        color: makeColor(0xf6c453),
        emissive: makeColor(0x986818),
        roughness: 0.25,
        metalness: 0.4
      })
    );
    const sunMesh = new THREE.Mesh(sunGeom, sunMat);
    sunMesh.position.set(0.55, 1.24, 0.35);
    scene.add(sunMesh);

    ringMeshList = [];
    for (let i = 0; i < RING_SPECS.length; i++) {
      const rs = RING_SPECS[i];
      const ringGeom = trackGeometry(new THREE.TorusGeometry(rs.radius, rs.tube, 24, 96));
      const ringMat = trackMaterial(
        new THREE.ShaderMaterial({
          uniforms: {
            uBaseColor: { value: makeColor(0xd4a84f) },
            uDarkColor: { value: makeColor(0x58421a) },
            uDepthBias: { value: keyLight.shadow.bias },
            uSlopeBias: { value: keyLight.shadow.normalBias }
          },
          vertexShader: `
            varying vec3 vNormal;
            varying vec3 vWorldPos;
            void main() {
              vNormal = normalize(normalMatrix * normal);
              vec4 wp = modelMatrix * vec4(position, 1.0);
              vWorldPos = wp.xyz;
              gl_Position = projectionMatrix * viewMatrix * wp;
            }
          `,
          fragmentShader: `
            uniform vec3 uBaseColor;
            uniform vec3 uDarkColor;
            uniform float uDepthBias;
            uniform float uSlopeBias;
            varying vec3 vNormal;
            varying vec3 vWorldPos;
            void main() {
              vec3 lightDir = normalize(vec3(0.55, 0.85, 0.62));
              float ndl = max(0.15, dot(vNormal, lightDir));
              vec3 col = mix(uDarkColor, uBaseColor, ndl);
              vec3 viewDir = normalize(vec3(0.0, 0.35, 1.0));
              vec3 halfDir = normalize(lightDir + viewDir);
              float spec = pow(max(0.0, dot(vNormal, halfDir)), 28.0) * 0.38;
              col += vec3(spec);
              if (uDepthBias >= -0.0001 && uSlopeBias < 0.005) {
                float fringe = sin(gl_FragCoord.x * 2.25 + gl_FragCoord.y * 0.35);
                float modFactor = fringe > 0.0 ? 1.38 : 0.22;
                col *= modFactor;
              }
              gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
            }
          `
        })
      );
      const ringMesh = new THREE.Mesh(ringGeom, ringMat);
      ringMesh.position.set(0.55, rs.y, 0.35);
      ringMesh.rotation.x = Math.PI * 0.5 + rs.tiltX;
      ringMesh.rotation.z = rs.tiltZ;
      ringMesh.castShadow = true;
      ringMesh.receiveShadow = true;
      scene.add(ringMesh);
      ringMeshList.push(ringMesh);
    }

    planetGroupList = [];
    planetMeshList = [];
    for (let i = 0; i < PLANET_SPECS.length; i++) {
      const ps = PLANET_SPECS[i];
      const pivot = new THREE.Group();
      pivot.position.set(0.55, 0.0, 0.35);

      const armGeom = trackGeometry(new THREE.CylinderGeometry(0.025, 0.025, ps.orbitRadius, 12));
      const armMat = trackMaterial(
        new THREE.MeshStandardMaterial({
          color: makeColor(0x8c6f36),
          roughness: 0.4,
          metalness: 0.78
        })
      );
      const armMesh = new THREE.Mesh(armGeom, armMat);
      armMesh.rotation.z = Math.PI * 0.5;
      armMesh.position.set(ps.orbitRadius * 0.5, 0.72 + (i % 3) * 0.06, 0);
      pivot.add(armMesh);

      const planetGeom = trackGeometry(new THREE.SphereGeometry(ps.radius, 40, 32));
      const planetMat = trackMaterial(
        new THREE.MeshBasicMaterial({
          color: makeColor(ps.baseHex),
          toneMapped: false
        })
      );
      const planetMesh = new THREE.Mesh(planetGeom, planetMat);
      planetMesh.position.set(ps.orbitRadius, ps.height, 0);
      pivot.add(planetMesh);

      scene.add(pivot);
      planetGroupList.push(pivot);
      planetMeshList.push(planetMesh);
    }

    chartTexture = chartImageTexture ? chartImageTexture.clone() : new THREE.DataTexture(new Uint8Array(16), 2, 2);
    chartTexture.needsUpdate = true;
    trackTexture(chartTexture);
    chartTexture.colorSpace = THREE.SRGBColorSpace;
    chartTexture.minFilter = THREE.NearestFilter;
    chartTexture.magFilter = THREE.NearestFilter;
    chartTexture.generateMipmaps = false;

    const frameGeom = trackGeometry(new THREE.BoxGeometry(PLAQUE_WIDTH + 0.24, PLAQUE_HEIGHT + 0.24, 0.08));
    const frameMat = trackMaterial(
      new THREE.MeshStandardMaterial({
        color: makeColor(0xa6833c),
        roughness: 0.38,
        metalness: 0.8
      })
    );
    const frameMesh = new THREE.Mesh(frameGeom, frameMat);
    frameMesh.position.copy(PLAQUE_POS).add(new THREE.Vector3(0, 0, -0.05));
    scene.add(frameMesh);

    const plaqueGeom = trackGeometry(new THREE.PlaneGeometry(PLAQUE_WIDTH, PLAQUE_HEIGHT));
    plaqueMaterial = trackMaterial(
      new THREE.ShaderMaterial({
        uniforms: {
          uChart: { value: chartTexture },
          uTransferMode: { value: 1.0 },
          uAmbientLift: { value: 0.0 }
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D uChart;
          uniform float uTransferMode;
          uniform float uAmbientLift;
          varying vec2 vUv;
          vec3 linearToSrgb(vec3 lin) {
            vec3 lo = 12.92 * lin;
            vec3 hi = 1.055 * pow(max(lin, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
            return mix(lo, hi, step(vec3(0.0031308), lin));
          }
          void main() {
            vec4 tex = texture2D(uChart, vUv);
            vec3 srgb = linearToSrgb(tex.rgb);
            if (uTransferMode < 0.5) {
              srgb = pow(max(srgb, vec3(0.0)), vec3(2.2));
            }
            if (uAmbientLift > 0.5) {
              srgb = linearToSrgb(srgb);
            }
            gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
          }
        `,
        toneMapped: false
      })
    );
    plaqueMesh = new THREE.Mesh(plaqueGeom, plaqueMaterial);
    plaqueMesh.position.copy(PLAQUE_POS);
    scene.add(plaqueMesh);

    retainCache.push(new Float64Array(160000));
  }

  function updatePlanetFocusVisuals() {
    for (let i = 0; i < planetMeshList.length; i++) {
      const mesh = planetMeshList[i];
      if (!mesh) continue;
      if (i === focusedIndex) {
        const focusHex = (FOCUSED_PLANET_RGB[0] << 16) | (FOCUSED_PLANET_RGB[1] << 8) | FOCUSED_PLANET_RGB[2];
        mesh.material.color.copy(makeColor(focusHex));
        mesh.scale.set(1.22, 1.22, 1.22);
      } else {
        mesh.material.color.copy(makeColor(PLANET_SPECS[i].baseHex));
        mesh.scale.set(1.0, 1.0, 1.0);
      }
    }
    updateFocusReadout();
  }

  function updateSceneAtTime(tMs) {
    if (!scene || !camera) return;
    const tSec = tMs / 1000.0;

    for (let i = 0; i < PLANET_SPECS.length; i++) {
      const spec = PLANET_SPECS[i];
      const phase0 = seedParams.orbitPhasesDeg[i] || 0;
      const rawDeg = phase0 + tSec * spec.speedDegPerSec;
      const wrappedDeg = ((rawDeg % 360) + 360) % 360;
      if (i === 0) {
        orbitAngleDeg = Number(wrappedDeg.toFixed(4));
      }
      const rad = (wrappedDeg * Math.PI) / 180.0;
      if (planetGroupList[i]) {
        planetGroupList[i].rotation.y = rad;
      }
    }

    for (let i = 0; i < ringMeshList.length; i++) {
      const rs = RING_SPECS[i];
      const ring = ringMeshList[i];
      if (ring) {
        ring.rotation.y = ((tSec * rs.speedDeg) * Math.PI) / 180.0;
        ring.material.uniforms.uDepthBias.value = keyLight.shadow.bias;
        ring.material.uniforms.uSlopeBias.value = keyLight.shadow.normalBias;
      }
    }

    if (decalMesh && decalMaterial) {
      const coplanar =
        Math.abs(decalMesh.position.y - floorMesh.position.y) < 0.001 &&
        (!decalMaterial.polygonOffset || decalMaterial.polygonOffsetFactor >= 0) &&
        camera.near < 0.01;
      decalMaterial.uniforms.uCoplanarBlend.value = coplanar ? 1.0 : 0.0;
      decalMaterial.uniforms.uViewPhase.value = tMs * 0.06;
      decalMaterial.depthTest = !coplanar;
    }

    if (plaqueMaterial && chartTexture) {
      plaqueMaterial.uniforms.uTransferMode.value = chartTexture.colorSpace === THREE.SRGBColorSpace ? 1.0 : 0.0;
      const bgSample = makeColor(0x141822);
      plaqueMaterial.uniforms.uAmbientLift.value = bgSample.r > 0.12 ? 1.0 : 0.0;
    }

    const cp = seedParams.cameraPath;
    const freq = cp.driftFreqHz || 0.22;
    const phase = cp.driftPhase || 0.0;
    const arg = 2.0 * Math.PI * freq * tSec + phase;
    const dx = Math.sin(arg) * (cp.driftAmp?.[0] ?? 0.16);
    const dy = Math.cos(arg * 0.85) * (cp.driftAmp?.[1] ?? 0.08);
    const dz = Math.sin(arg * 0.65 + 0.7) * (cp.driftAmp?.[2] ?? 0.14);

    camera.position.set(
      cp.basePosition[0] + dx,
      cp.basePosition[1] + dy,
      cp.basePosition[2] + dz
    );
    camera.lookAt(cp.baseTarget[0], cp.baseTarget[1], cp.baseTarget[2]);
    camera.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
  }

  function getViewportSize() {
    if (currentContainer && currentContainer.clientWidth > 0 && currentContainer.clientHeight > 0) {
      return {
        width: currentContainer.clientWidth,
        height: currentContainer.clientHeight
      };
    }
    if (typeof window !== "undefined" && window.innerWidth > 0 && window.innerHeight > 0) {
      return {
        width: window.innerWidth,
        height: window.innerHeight
      };
    }
    return { width: 1440, height: 900 };
  }

  function handleResize() {
    if (!renderer || !camera) return;
    const { width, height } = getViewportSize();
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    updateSceneAtTime(currentClockMs);
    renderer.render(scene, camera);
  }

  function projectWorldToPixel(worldVec) {
    if (!camera || !renderer) return { x: 0, y: 0 };
    const size = new THREE.Vector2();
    renderer.getSize(size);
    const v = worldVec.clone().project(camera);
    const x = Math.round((v.x * 0.5 + 0.5) * size.x);
    const y = Math.round((-v.y * 0.5 + 0.5) * size.y);
    return { x, y };
  }

  function computeChartPatchCenters() {
    if (!plaqueMesh || !camera || !renderer) return [];
    plaqueMesh.updateMatrixWorld(true);
    const patches = [];
    for (let row = 0; row < CHART_ROWS; row++) {
      for (let col = 0; col < CHART_COLS; col++) {
        const u = (col + 0.5) / CHART_COLS;
        const vTop = (row + 0.5) / CHART_ROWS;
        const localX = (u - 0.5) * PLAQUE_WIDTH;
        const localY = (0.5 - vTop) * PLAQUE_HEIGHT;
        const worldPt = new THREE.Vector3(localX, localY, 0.0).applyMatrix4(plaqueMesh.matrixWorld);
        patches.push(projectWorldToPixel(worldPt));
      }
    }
    return patches;
  }

  function computeFocusedPlanetCenter() {
    const mesh = planetMeshList[focusedIndex];
    if (!mesh || !camera || !renderer) return { x: 720, y: 450 };
    mesh.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3();
    mesh.getWorldPosition(worldPos);
    return projectWorldToPixel(worldPos);
  }

  function computeFocusedMaskColor() {
    const mesh = planetMeshList[focusedIndex];
    if (!mesh) return FOCUSED_PLANET_RGB;
    const c = mesh.material.color.clone().convertLinearToSRGB();
    return [
      Math.round(Math.min(255, Math.max(0, c.r * 255))),
      Math.round(Math.min(255, Math.max(0, c.g * 255))),
      Math.round(Math.min(255, Math.max(0, c.b * 255)))
    ];
  }

  function tick() {
    if (!isMounted) return;
    if (!isPaused) {
      currentClockMs = host.clock.now();
      updateSceneAtTime(currentClockMs);
      renderer.render(scene, camera);
    }
    rafId = requestAnimationFrame(tick);
  }

  async function mount(containerEl = currentContainer) {
    if (containerEl) {
      const stageChild =
        containerEl.id === "orrery-stage"
          ? containerEl
          : typeof containerEl.querySelector === "function"
            ? containerEl.querySelector("#orrery-stage")
            : null;
      currentContainer = stageChild || containerEl;
    }
    if (!chartImageTexture) {
      chartImageTexture = await loadImageTexture(chartUrl);
    }
    const { width, height } = getViewportSize();
    ensureRenderer(width, height);
    buildSceneGraph(width, height);
    updatePlanetFocusVisuals();

    if (currentContainer && renderer.domElement.parentNode !== currentContainer) {
      const oldCanvases = typeof currentContainer.querySelectorAll === "function"
        ? currentContainer.querySelectorAll("canvas")
        : [];
      for (const c of oldCanvases) {
        if (c.parentNode) c.parentNode.removeChild(c);
      }
      currentContainer.appendChild(renderer.domElement);
    }

    nextBtn = typeof document !== "undefined" ? document.querySelector('[data-bench="next-planet"]') : null;
    onNextPlanetClick = () => {
      focusedIndex = (focusedIndex + 1) % PLANET_SPECS.length;
      updatePlanetFocusVisuals();
      updateSceneAtTime(currentClockMs);
      if (renderer && scene && camera) {
        renderer.render(scene, camera);
      }
    };
    if (nextBtn) {
      nextBtn.addEventListener("click", onNextPlanetClick);
      activeListenerCount += 1;
    }

    onWindowResize = () => handleResize();
    if (typeof window !== "undefined") {
      window.addEventListener("resize", onWindowResize);
      activeListenerCount += 1;
    }

    isMounted = true;
    updateSceneAtTime(currentClockMs);
    renderer.render(scene, camera);

    if (rafId !== null) {
      cancelAnimationFrame(rafId);
    }
    rafId = requestAnimationFrame(tick);
  }

  async function unmount() {
    isMounted = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    if (nextBtn && onNextPlanetClick) nextBtn.removeEventListener("click", onNextPlanetClick);
    if (typeof window !== "undefined" && onWindowResize) window.removeEventListener("resize", onWindowResize);
    activeListenerCount = 0;
    onNextPlanetClick = null;

    for (const geom of allocatedGeometries) geom.dispose();
    for (const mat of allocatedMaterials) mat.dispose();
    for (const tex of allocatedTextures) tex.dispose();
    if (keyLight && keyLight.shadow && keyLight.shadow.map) keyLight.shadow.map.dispose();
    allocatedGeometries.length = 0;
    allocatedMaterials.length = 0;
    allocatedTextures.length = 0;
    retainCache.length = 0;

    if (renderer && renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  }

  const readyPromise = mount(defaultContainer);

  return {
    version: 1,
    ready: readyPromise,
    setSeed(seed) {
      currentSeed = Number(seed) || 1;
      seedParams = deriveSeedParams(currentSeed, host.params || {});
      focusedIndex = 0;
      updatePlanetFocusVisuals();
      updateSceneAtTime(currentClockMs);
      if (renderer && scene && camera) {
        renderer.render(scene, camera);
      }
    },
    seek(tMs) {
      isPaused = true;
      currentClockMs = Number(tMs) || 0;
      if (typeof host.clock?._set === "function") {
        host.clock._set(currentClockMs);
      }
      updateSceneAtTime(currentClockMs);
    },
    resume() {
      isPaused = false;
      if (isMounted) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
        rafId = requestAnimationFrame(tick);
      }
    },
    async renderFrame() {
      await readyPromise;
      if (!renderer || !scene || !camera) return;
      updateSceneAtTime(currentClockMs);
      renderer.render(scene, camera);
    },
    state() {
      const cp = seedParams.cameraPath;
      const pos = camera
        ? [Number(camera.position.x.toFixed(4)), Number(camera.position.y.toFixed(4)), Number(camera.position.z.toFixed(4))]
        : cp.basePosition;
      return {
        focusedIndex,
        orbitAngleDeg,
        chartPatches: computeChartPatchCenters(),
        focusedCenter: computeFocusedPlanetCenter(),
        focusedMaskColor: computeFocusedMaskColor(),
        camera: {
          position: pos,
          target: [...cp.baseTarget]
        },
        route: "orrery"
      };
    },
    stats() {
      const mem = renderer?.info?.memory || { geometries: 0, textures: 0 };
      const ren = renderer?.info?.render || { calls: 0, triangles: 0 };
      const progs = renderer?.info?.programs ? renderer.info.programs.length : 0;
      return {
        drawCalls: ren.calls || 0,
        triangles: ren.triangles || 0,
        geometries: mem.geometries || 0,
        textures: mem.textures || 0,
        programs: progs,
        listeners: activeListenerCount
      };
    },
    mount,
    unmount
  };
}
