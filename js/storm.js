import * as THREE from 'three';
import { CONFIG } from './config.js';

/**
 * Storm manager: regional rain (whole grid) by default,
 * click to place a localized storm instead.
 * R key / right A button toggles between regional and localized.
 */
export class StormManager {
  constructor(scene, terrainData, waterSim, gridSize, cellSizeM) {
    this.scene = scene;
    this.terrainData = terrainData;
    this.waterSim = waterSim;
    this.gridSize = gridSize;
    this.cellSize = cellSizeM;
    this.halfSize = (gridSize - 1) * cellSizeM / 2;

    // Rain state
    this.active = true;              // rain is on by default
    this.mode = 'regional';          // 'regional' or 'localized'
    this.rainRate = CONFIG.STORM_DEFAULT_RAIN_RATE;

    // Localized storm position (used when mode === 'localized')
    this.stormCol = gridSize / 2;
    this.stormRow = gridSize / 2;
    this.stormRadius = CONFIG.STORM_DEFAULT_RADIUS_CELLS;

    // Storm indicator mesh - translucent cylinder (only visible in localized mode)
    const indicatorRadius = this.stormRadius * cellSizeM;
    const indicatorHeight = 50;
    this.indicatorGeo = new THREE.CylinderGeometry(
      indicatorRadius, indicatorRadius, indicatorHeight, 32, 1, true
    );
    this.indicatorMat = new THREE.MeshBasicMaterial({
      color: 0x4466aa,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.indicator = new THREE.Mesh(this.indicatorGeo, this.indicatorMat);
    this.indicator.visible = false;

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this._tempVec2 = new THREE.Vector2();
    this._time = 0;
  }

  _worldToGrid(point, terrainGroup) {
    const local = point.clone();
    const invMatrix = new THREE.Matrix4().copy(terrainGroup.matrixWorld).invert();
    local.applyMatrix4(invMatrix);
    const col = (local.x + this.halfSize) / this.cellSize;
    const row = (local.z + this.halfSize) / this.cellSize;
    return { col, row };
  }

  _getTerrainMeshes(terrainGroup) {
    const meshes = [];
    terrainGroup.traverse((child) => {
      if (child.isMesh && child !== this.indicator) {
        meshes.push(child);
      }
    });
    return meshes;
  }

  /**
   * Handle input and update visuals (call once per frame).
   */
  update(dt, input, controls, vr) {
    this._time += dt;
    const terrainGroup = controls.getTerrainGroup();

    // Ensure indicator is in the terrain group
    if (this.indicator.parent !== terrainGroup) {
      terrainGroup.add(this.indicator);
    }

    // --- Rain rate adjustment ( +/- keys / VR grip+stick) ---
    if (input.rainAdjust !== 0) {
      const factor = input.rainAdjust > 0 ? 1.3 : 0.7;
      this.rainRate = Math.max(0,
        Math.min(CONFIG.STORM_MAX_RAIN_RATE, this.rainRate * factor));
    }
    if (vr.isInVR() && input.rightGrip && Math.abs(input.rightStick.y) > 0.1) {
      const adjust = -input.rightStick.y * dt * CONFIG.STORM_MAX_RAIN_RATE;
      this.rainRate = Math.max(0,
        Math.min(CONFIG.STORM_MAX_RAIN_RATE, this.rainRate + adjust));
    }

    // --- Click places localized storm ---
    if (vr.isInVR()) {
      this._handleVRInput(dt, input, controls, vr, terrainGroup);
    } else {
      this._handleDesktopInput(dt, input, controls, vr, terrainGroup);
    }

    // --- Update indicator visual ---
    if (this.active) {
      if (this.mode === 'regional') {
        this.indicator.visible = false;
      } else {
        this.indicator.visible = true;
        const worldX = this.stormCol * this.cellSize - this.halfSize;
        const worldZ = this.stormRow * this.cellSize - this.halfSize;
        const r = Math.round(this.stormRow);
        const c = Math.round(this.stormCol);
        const idx = Math.max(0, Math.min(this.gridSize * this.gridSize - 1, r * this.gridSize + c));
        const terrainH = this.terrainData.heightmap[idx] || 0;
        this.indicator.position.set(worldX, terrainH + 25, worldZ);

        const baseOpacity = 0.08 + (this.rainRate / CONFIG.STORM_MAX_RAIN_RATE) * 0.2;
        const pulse = Math.sin(this._time * 3) * 0.03;
        this.indicatorMat.opacity = baseOpacity + pulse;
      }
    } else {
      this.indicator.visible = false;
    }
  }

  /**
   * Apply rain for one simulation substep (call per substep in the sim loop).
   */
  applyRain(dt) {
    if (!this.active) return;
    const amount = this.rainRate * dt;
    if (this.mode === 'regional') {
      this.waterSim.addRainGlobal(amount);
    } else {
      this.waterSim.addRain(this.stormCol, this.stormRow, this.stormRadius, amount);
    }
  }

  _handleDesktopInput(dt, input, controls, vr, terrainGroup) {
    if (input.consumeClick()) {
      this._tempVec2.set(input.mouseX, input.mouseY);
      this.raycaster.setFromCamera(this._tempVec2, vr.camera);

      const meshes = this._getTerrainMeshes(terrainGroup);
      const hits = this.raycaster.intersectObjects(meshes, true);

      if (hits.length > 0) {
        const { col, row } = this._worldToGrid(hits[0].point, terrainGroup);
        if (col >= 0 && col < this.gridSize && row >= 0 && row < this.gridSize) {
          this.stormCol = col;
          this.stormRow = row;
          this.mode = 'localized';
          this.active = true;
          console.log(`[Storm] Localized at grid (${col.toFixed(1)}, ${row.toFixed(1)})`);
        }
      }
    }
  }

  _handleVRInput(dt, input, controls, vr, terrainGroup) {
    if (input.rightTrigger) {
      const controller = vr.controllers[1];
      if (!controller) return;

      const tempMatrix = new THREE.Matrix4();
      tempMatrix.identity().extractRotation(controller.matrixWorld);
      const rayDir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix);
      const rayOrigin = new THREE.Vector3();
      controller.getWorldPosition(rayOrigin);

      this.raycaster.set(rayOrigin, rayDir);

      const meshes = this._getTerrainMeshes(terrainGroup);
      const hits = this.raycaster.intersectObjects(meshes, true);

      if (hits.length > 0) {
        const { col, row } = this._worldToGrid(hits[0].point, terrainGroup);
        if (col >= 0 && col < this.gridSize && row >= 0 && row < this.gridSize) {
          this.stormCol = col;
          this.stormRow = row;
          this.mode = 'localized';
          this.active = true;
        }
      }
    }
  }
}
