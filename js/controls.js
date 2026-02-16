import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG } from './config.js';

/**
 * Controls manager: handles tabletop and immersive view modes.
 *
 * Tabletop: terrain scaled down in a Group, positioned at waist height.
 *   Desktop: OrbitControls. VR: left stick rotates model.
 * Immersive: terrain at 1:1 scale, user walks on surface.
 *   Desktop: WASD movement. VR: left stick locomotion, right stick snap turn.
 */
export class Controls {
  constructor(vrSetup, inputManager, terrainData, scene) {
    this.vr = vrSetup;
    this.input = inputManager;
    this.terrainData = terrainData;
    this.scene = scene;

    this.mode = 'tabletop';  // 'tabletop' or 'immersive'

    const meta = terrainData.meta;
    const gridSize = meta.grid_size;
    const cellSizeM = meta.cell_size_m;
    this.terrainWorldSize = gridSize * cellSizeM;

    // --- Tabletop setup ---
    // Wrap terrain in a group for scaling/positioning
    this.tabletopGroup = new THREE.Group();
    this.tabletopGroup.add(terrainData.terrainMesh);

    // Calculate scale to fit terrain into ~1.5m
    const tabletopTargetSize = 1.5;
    this.tabletopScale = tabletopTargetSize / this.terrainWorldSize;
    this.tabletopGroup.scale.setScalar(this.tabletopScale);
    this.tabletopGroup.position.set(0, CONFIG.TABLETOP_HEIGHT, -CONFIG.TABLETOP_DISTANCE);

    scene.add(this.tabletopGroup);

    // Terrain edge skirt (thin walls around edges)
    this._createSkirt(terrainData, gridSize, cellSizeM);

    // (grid lines removed — terrain colors provide sufficient reference)

    // --- Desktop OrbitControls ---
    this.orbitControls = new OrbitControls(vrSetup.camera, vrSetup.renderer.domElement);
    this.orbitControls.target.copy(this.tabletopGroup.position);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.1;
    this.orbitControls.minDistance = 0.3;
    this.orbitControls.maxDistance = 5;

    // Position camera for nice initial view
    vrSetup.camera.position.set(0.5, CONFIG.TABLETOP_HEIGHT + 1.0, 0.8);
    this.orbitControls.update();

    // --- Immersive mode state ---
    this.immersiveActive = false;
    this.moveSpeed = 20; // m/s in immersive mode

    // Snap turn state
    this._snapTurnReady = true;
    this.SNAP_ANGLE = Math.PI / 6; // 30 degrees
  }

  getTerrainGroup() {
    return this.tabletopGroup;
  }

  getMode() {
    return this.mode;
  }

  toggleMode() {
    if (this.mode === 'tabletop') {
      this._enterImmersive();
    } else {
      this._enterTabletop();
    }
  }

  _enterTabletop() {
    this.mode = 'tabletop';
    this.immersiveActive = false;

    // Restore tabletop scale and position
    this.tabletopGroup.scale.setScalar(this.tabletopScale);
    this.tabletopGroup.position.set(0, CONFIG.TABLETOP_HEIGHT, -CONFIG.TABLETOP_DISTANCE);

    // Reset dolly
    this.vr.dolly.position.set(0, 0, 0);
    this.vr.dolly.rotation.set(0, 0, 0);

    // Reset camera for desktop
    if (!this.vr.isInVR()) {
      this.vr.camera.position.set(0.5, CONFIG.TABLETOP_HEIGHT + 1.0, 0.8);
      this.orbitControls.target.copy(this.tabletopGroup.position);
      this.orbitControls.enabled = true;
      this.orbitControls.update();
    }

    // Remove fog
    this.scene.fog = null;

    console.log('[Controls] Switched to tabletop mode');
  }

  _enterImmersive() {
    this.mode = 'immersive';
    this.immersiveActive = true;

    // Set terrain to 1:1 scale at origin
    this.tabletopGroup.scale.setScalar(1);
    this.tabletopGroup.position.set(0, 0, 0);

    // Position player at center of terrain, at ground level
    const centerHeight = this._getTerrainHeight(0, 0);
    this.vr.dolly.position.set(0, centerHeight, 0);

    // Desktop: disable orbit controls
    if (!this.vr.isInVR()) {
      this.orbitControls.enabled = false;
    }

    // Add fog for depth cueing
    this.scene.fog = new THREE.Fog(0x4a5868, this.terrainWorldSize * 0.3, this.terrainWorldSize * 0.8);

    console.log('[Controls] Switched to immersive mode');
  }

  _getTerrainHeight(x, z) {
    const meta = this.terrainData.meta;
    const gridSize = meta.grid_size;
    const cellSizeM = meta.cell_size_m;
    const halfSize = (gridSize - 1) * cellSizeM / 2;

    // Convert world coords to grid coords
    const col = Math.round((x + halfSize) / cellSizeM);
    const row = Math.round((z + halfSize) / cellSizeM);

    if (col < 0 || col >= gridSize || row < 0 || row >= gridSize) {
      return 0;
    }

    return this.terrainData.heightmap[row * gridSize + col];
  }

  _createSkirt(terrainData, gridSize, cellSizeM) {
    const heightmap = terrainData.heightmap;
    const halfSize = (gridSize - 1) * cellSizeM / 2;
    const skirtDepth = 5; // meters below minimum

    const positions = [];
    const colors = [];
    const indices = [];

    const edges = [
      // [startCol, startRow, dCol, dRow, count]
      [0, 0, 1, 0, gridSize],                  // top edge
      [0, gridSize - 1, 1, 0, gridSize],        // bottom edge
      [0, 0, 0, 1, gridSize],                  // left edge
      [gridSize - 1, 0, 0, 1, gridSize],       // right edge
    ];

    for (const [startC, startR, dC, dR, count] of edges) {
      const baseIdx = positions.length / 3;
      for (let i = 0; i < count; i++) {
        const c = startC + dC * i;
        const r = startR + dR * i;
        const x = c * cellSizeM - halfSize;
        const z = r * cellSizeM - halfSize;
        const y = heightmap[r * gridSize + c];

        // Top vertex (at terrain edge)
        positions.push(x, y, z);
        colors.push(0.25, 0.2, 0.15);

        // Bottom vertex (skirt)
        positions.push(x, -skirtDepth, z);
        colors.push(0.15, 0.12, 0.08);

        if (i > 0) {
          const v = baseIdx + (i - 1) * 2;
          indices.push(v, v + 1, v + 2);
          indices.push(v + 2, v + 1, v + 3);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshPhongMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    const skirtMesh = new THREE.Mesh(geo, mat);
    this.tabletopGroup.add(skirtMesh);
  }

  _createGridLines(gridSize, cellSizeM) {
    const halfSize = (gridSize - 1) * cellSizeM / 2;
    const step = Math.ceil(gridSize / 16) * cellSizeM; // ~16 lines per axis

    const points = [];
    for (let x = -halfSize; x <= halfSize; x += step) {
      points.push(new THREE.Vector3(x, 0.5, -halfSize));
      points.push(new THREE.Vector3(x, 0.5, halfSize));
    }
    for (let z = -halfSize; z <= halfSize; z += step) {
      points.push(new THREE.Vector3(-halfSize, 0.5, z));
      points.push(new THREE.Vector3(halfSize, 0.5, z));
    }

    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.08 });
    this._gridLines = new THREE.LineSegments(geo, mat);
    this.tabletopGroup.add(this._gridLines);
  }

  update(dt) {
    // Toggle view mode
    if (this.input.toggleViewPressed) {
      this.toggleMode();
    }

    if (this.mode === 'tabletop') {
      this._updateTabletop(dt);
    } else {
      this._updateImmersive(dt);
    }
  }

  _updateTabletop(dt) {
    if (this.vr.isInVR()) {
      // VR tabletop: left stick rotates the model
      if (Math.abs(this.input.leftStick.x) > 0) {
        this.tabletopGroup.rotation.y += this.input.leftStick.x * dt * 2;
      }
    } else {
      // Desktop: OrbitControls handle it
      this.orbitControls.update();
    }
  }

  _updateImmersive(dt) {
    if (this.vr.isInVR()) {
      // VR immersive: left stick locomotion
      const speed = this.moveSpeed * dt;
      const dir = new THREE.Vector3(this.input.leftStick.x, 0, this.input.leftStick.y);
      if (dir.lengthSq() > 0.01) {
        // Move relative to dolly facing direction
        dir.applyQuaternion(this.vr.dolly.quaternion);
        dir.y = 0;
        dir.normalize().multiplyScalar(speed);
        this.vr.dolly.position.add(dir);

        // Follow terrain height
        const h = this._getTerrainHeight(this.vr.dolly.position.x, this.vr.dolly.position.z);
        this.vr.dolly.position.y = h;
      }

      // Right stick snap turn
      if (Math.abs(this.input.rightStick.x) > 0.5) {
        if (this._snapTurnReady) {
          const angle = this.input.rightStick.x > 0 ? -this.SNAP_ANGLE : this.SNAP_ANGLE;
          this.vr.dolly.rotation.y += angle;
          this._snapTurnReady = false;
        }
      } else {
        this._snapTurnReady = true;
      }
    } else {
      // Desktop immersive: WASD movement
      const speed = this.moveSpeed * dt;
      const dir = new THREE.Vector3(this.input.leftStick.x, 0, this.input.leftStick.y);
      if (dir.lengthSq() > 0.01) {
        dir.normalize().multiplyScalar(speed);
        // Move relative to camera facing
        const cameraDir = new THREE.Vector3();
        this.vr.camera.getWorldDirection(cameraDir);
        cameraDir.y = 0;
        cameraDir.normalize();
        const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), cameraDir).negate();

        this.vr.camera.position.x += cameraDir.x * (-dir.z) + right.x * dir.x;
        this.vr.camera.position.z += cameraDir.z * (-dir.z) + right.z * dir.x;

        // Follow terrain
        const h = this._getTerrainHeight(this.vr.camera.position.x, this.vr.camera.position.z);
        this.vr.camera.position.y = h + CONFIG.EYE_HEIGHT;
      }
    }
  }
}
