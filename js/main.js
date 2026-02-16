console.log('%c[Flood Sim] Loaded', 'color: #4a9eda; font-size: 14px;');

import * as THREE from 'three';
import { VRSetup } from './vr-setup.js';
import { InputManager } from './input.js';
import { Controls } from './controls.js';
import { loadTerrain } from './terrain-loader.js';
import { WaterSim } from './water-sim.js';
import { WaterMesh } from './water-mesh.js';
import { StormManager } from './storm.js';
import { CONFIG } from './config.js';

// Debug mode
const DEBUG = new URLSearchParams(window.location.search).has('debug');

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x4a5868);
scene.fog = null;

// VR Setup
const vr = new VRSetup();
vr.init();
scene.add(vr.dolly);

// Input
const input = new InputManager(vr);

// Lighting
const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(50, 100, 30);
sunLight.castShadow = false;
scene.add(sunLight);

const ambientLight = new THREE.AmbientLight(0x6688aa, 0.6);
scene.add(ambientLight);

// DOM refs
const infoEl = document.getElementById('info');
const hudRain = document.getElementById('hud-rain');
const hudDepth = document.getElementById('hud-depth');
const hudTime = document.getElementById('hud-time');
const hudLocation = document.getElementById('hud-location');

// State
let terrainData = null;
let waterSim = null;
let waterMesh = null;
let stormManager = null;
let controls = null;
let simElapsed = 0;
let simSpeed = 10;  // time multiplier (substeps per frame)

// --- VR HUD (CanvasTexture sprites attached to camera) ---
const vrHudCanvas = document.createElement('canvas');
vrHudCanvas.width = 512;
vrHudCanvas.height = 128;
const vrHudCtx = vrHudCanvas.getContext('2d');
const vrHudTex = new THREE.CanvasTexture(vrHudCanvas);
const vrHudMat = new THREE.SpriteMaterial({
  map: vrHudTex,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  fog: false,
});
const vrHudSprite = new THREE.Sprite(vrHudMat);
vrHudSprite.scale.set(0.20, 0.05, 1);
vrHudSprite.position.set(0, -0.08, -0.3);
vrHudSprite.visible = false;
vr.camera.add(vrHudSprite);

let _lastVrHudText = '';
function updateVrHud(lines) {
  const text = lines.join(' | ');
  if (text === _lastVrHudText) return;
  _lastVrHudText = text;
  vrHudCtx.clearRect(0, 0, 512, 128);
  vrHudCtx.fillStyle = 'rgba(0,0,0,0.5)';
  vrHudCtx.roundRect(0, 0, 512, 128, 8);
  vrHudCtx.fill();
  vrHudCtx.fillStyle = '#ffffff';
  vrHudCtx.font = 'bold 24px monospace';
  vrHudCtx.textAlign = 'center';
  vrHudCtx.textBaseline = 'middle';
  vrHudCtx.fillText(text, 256, 64);
  vrHudTex.needsUpdate = true;
}

// --- Debug FPS counter ---
let fpsFrames = 0;
let fpsTime = 0;
let fpsDisplay = 0;
const fpsEl = document.createElement('div');
if (DEBUG) {
  fpsEl.style.cssText = 'position:fixed;top:12px;right:12px;color:#0f0;font:14px monospace;z-index:100;text-shadow:0 1px 3px #000';
  document.body.appendChild(fpsEl);
}

// --- Load terrain and initialize systems ---
async function init() {
  try {
    terrainData = await loadTerrain(CONFIG.DATA_PATH);
    // terrainMesh will be added to tabletopGroup by Controls (not directly to scene)

    const meta = terrainData.meta;
    const gridSize = meta.grid_size;
    const cellSizeM = meta.cell_size_m;

    // Water simulation (use real terrain heights, not exaggerated)
    const vertExag = meta.vertical_exaggeration || 1;
    waterSim = new WaterSim(terrainData.heightmap, gridSize, cellSizeM, vertExag);

    // Water mesh (exaggerate water depth to match terrain)
    waterMesh = new WaterMesh(gridSize, cellSizeM, terrainData.heightmap, vertExag);
    scene.add(waterMesh.mesh);

    // Storm manager
    stormManager = new StormManager(scene, terrainData, waterSim, gridSize, cellSizeM);

    // Controls (desktop + VR)
    controls = new Controls(vr, input, terrainData, scene);

    // Warmup: simulate sustained rain so water naturally collects
    // in valleys and drainage channels before the user sees the scene.
    // Phase 1: heavy rain with low edge drain — lets water accumulate in valleys
    // Phase 2: no rain, normal drain — excess water drains off, rivers remain
    infoEl.querySelector('p').textContent = 'Simulating initial conditions...';

    const warmupDt = CONFIG.SIM_DT;
    const savedEdgeDrain = waterSim.edgeDrainRate;

    // Phase 1: fill valleys (low edge drain so water accumulates)
    waterSim.edgeDrainRate = 0.1;
    const fillSteps = 5000;  // 100s sim time
    const fillRainRate = 0.0005;  // 1800 mm/hr
    console.log(`[Flood Sim] Warmup phase 1: filling valleys (${fillSteps} steps)...`);
    for (let i = 0; i < fillSteps; i++) {
      waterSim.addRainGlobal(fillRainRate * warmupDt);
      waterSim.step(warmupDt);
    }
    console.log(`[Flood Sim] Phase 1 done: max depth ${waterSim.getMaxDepth().toFixed(2)}m`);

    // Phase 2: drain excess (normal edge drain, no rain)
    waterSim.edgeDrainRate = savedEdgeDrain;
    const drainSteps = 3000;  // 60s sim time
    console.log(`[Flood Sim] Warmup phase 2: draining excess (${drainSteps} steps)...`);
    for (let i = 0; i < drainSteps; i++) {
      waterSim.step(warmupDt);
    }

    simElapsed = (fillSteps + drainSteps) * warmupDt;
    console.log(`[Flood Sim] Warmup complete: ${(simElapsed/60).toFixed(1)} min sim time, ` +
      `max depth ${waterSim.getMaxDepth().toFixed(2)}m, ` +
      `volume ${waterSim.getTotalVolume().toFixed(0)}m³`);

    // Update HUD
    if (meta.location_name) {
      hudLocation.textContent = meta.location_name;
    }

    infoEl.style.display = 'none';
    console.log('[Flood Sim] Terrain loaded:', meta);

    // Expose for console debugging
    window.floodSim = { waterSim, waterMesh, stormManager, terrainData, controls, scene, vr };
  } catch (err) {
    console.error('[Flood Sim] Init failed:', err);
    infoEl.querySelector('p').textContent = 'Failed to load terrain. Run the pipeline first.';
  }
}

// --- Render loop ---
let lastTime = 0;

function animate(timestamp) {
  const now = timestamp / 1000;
  let dt = now - lastTime;
  lastTime = now;
  if (dt > 0.1) dt = 0.1;

  // Input
  input.update();

  if (waterSim && stormManager && controls) {
    // Controls (camera, mode toggle)
    controls.update(dt);

    // Sim speed adjustment: [ and ] keys
    if (input.simSlower) {
      simSpeed = Math.max(CONFIG.SIM_SPEED_MIN, Math.round(simSpeed * 0.7));
    }
    if (input.simFaster) {
      simSpeed = Math.min(CONFIG.SIM_SPEED_MAX, Math.round(simSpeed * 1.4));
    }

    // Storm input handling (once per frame)
    stormManager.update(dt, input, controls, vr);

    // Simulation substeps: rain + flow interleaved at same timescale
    for (let i = 0; i < simSpeed; i++) {
      stormManager.applyRain(CONFIG.SIM_DT);
      waterSim.step(CONFIG.SIM_DT);
    }
    simElapsed += CONFIG.SIM_DT * simSpeed;

    // Update water mesh (with velocity for flow shader)
    waterMesh.update(waterSim.getWaterHeights(), controls.getTerrainGroup(), waterSim, dt);

    // Reset water (B key or B button)
    if (input.resetPressed) {
      waterSim.reset();
      simElapsed = 0;
    }

    // Update HUD
    const rainRate = stormManager.active ? stormManager.rainRate : 0;
    const rainMmHr = Math.round(rainRate * 3600 * 1000);
    const maxDepth = waterSim.getMaxDepth().toFixed(2);
    const modeLabel = stormManager.mode === 'regional' ? 'Regional' : 'Local';

    // Human-readable rain intensity
    const rainLabel = rainMmHr === 0 ? 'Off'
      : rainMmHr < 3 ? `${rainMmHr} mm/hr (drizzle)`
      : rainMmHr < 10 ? `${rainMmHr} mm/hr (light)`
      : rainMmHr < 25 ? `${rainMmHr} mm/hr (moderate)`
      : rainMmHr < 50 ? `${rainMmHr} mm/hr (heavy)`
      : rainMmHr < 100 ? `${rainMmHr} mm/hr (intense)`
      : rainMmHr < 250 ? `${rainMmHr} mm/hr (severe)`
      : `${rainMmHr} mm/hr (extreme)`;

    const simHours = (simElapsed / 3600).toFixed(1);
    const simMins = Math.floor(simElapsed / 60);

    hudRain.textContent = `Rain: ${rainLabel}${rainMmHr > 0 ? ' ' + modeLabel : ''}`;
    hudDepth.textContent = `Max Depth: ${maxDepth}m`;
    hudTime.textContent = `Sim: ${simMins < 60 ? simMins + 'min' : simHours + 'hr'} (${simSpeed}x)`;

    // VR HUD
    if (vr.isInVR()) {
      vrHudSprite.visible = true;
      updateVrHud([
        `${rainLabel}`,
        `Depth: ${maxDepth}m`,
        `${simMins < 60 ? simMins + 'min' : simHours + 'hr'} ${simSpeed}x`,
      ]);
    } else {
      vrHudSprite.visible = false;
    }
  }

  // Debug FPS
  if (DEBUG) {
    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 1) {
      fpsDisplay = fpsFrames;
      fpsFrames = 0;
      fpsTime = 0;
      const vol = waterSim ? waterSim.getTotalVolume().toFixed(0) : 0;
      fpsEl.textContent = `${fpsDisplay} FPS | Vol: ${vol}m³`;
    }
  }

  vr.renderer.render(scene, vr.camera);
}

vr.renderer.setAnimationLoop(animate);

// Start
init();
