import * as THREE from 'three';
import { CONFIG } from './config.js';

/**
 * Water surface mesh with flow-driven animated shader.
 * Per-frame: vertex Y from sim, flow velocity as vertex attribute,
 * shader scrolls ripple pattern along flow direction.
 */
export class WaterMesh {
  constructor(gridSize, cellSizeM, terrainHeights, vertExag = 1) {
    this.gridSize = gridSize;
    this.cellSize = cellSizeM;
    this.terrain = terrainHeights;  // scene-space (exaggerated)
    this.vertExag = vertExag;

    const terrainWidth = (gridSize - 1) * cellSizeM;
    const count = gridSize * gridSize;

    // PlaneGeometry matching the simulation grid
    this.geometry = new THREE.PlaneGeometry(
      terrainWidth, terrainWidth,
      gridSize - 1, gridSize - 1
    );
    this.geometry.rotateX(-Math.PI / 2);

    // Vertex colors (depth-encoded)
    const colors = new Float32Array(count * 3);
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Flow velocity attribute (vx, vz per vertex)
    const velocity = new Float32Array(count * 2);
    this.velAttr = new THREE.BufferAttribute(velocity, 2);
    this.geometry.setAttribute('aVelocity', this.velAttr);

    // Time uniform for shader animation
    this._timeUniform = { value: 0 };

    // Material with custom flow shader
    this.material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      side: THREE.DoubleSide,
      shininess: 80,
      specular: new THREE.Color(0.2, 0.25, 0.3),
    });

    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this._timeUniform;

      // Vertex shader: pass velocity + world position to fragment
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        attribute vec2 aVelocity;
        varying vec2 vFlow;
        varying vec3 vWorldPos;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vFlow = aVelocity;
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

      // Fragment shader: scrolling ripple pattern driven by flow
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        varying vec2 vFlow;
        varying vec3 vWorldPos;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `// Flow-driven ripple pattern
        float speed = length(vFlow);
        vec2 flowDir = speed > 0.001 ? normalize(vFlow) : vec2(0.0);

        // UV in world space, scrolled by flow
        vec2 uv = vWorldPos.xz * 0.15;
        vec2 flowOffset = flowDir * uTime * speed * 0.3;

        // Layer 1: broad flow streaks
        float streaks = sin((uv.x + uv.y) * 2.0 - flowOffset.x * 8.0 - flowOffset.y * 8.0) * 0.5 + 0.5;
        streaks *= sin((uv.x - uv.y * 0.7) * 3.5 - flowOffset.x * 12.0 + flowOffset.y * 4.0) * 0.5 + 0.5;

        // Layer 2: fine ripples
        float ripples = sin((uv.x * 1.3 + uv.y * 0.8) * 7.0 - flowOffset.x * 20.0 - flowOffset.y * 15.0) * 0.5 + 0.5;
        ripples *= sin((uv.x * 0.6 - uv.y * 1.5) * 5.0 + flowOffset.x * 10.0 - flowOffset.y * 18.0) * 0.5 + 0.5;

        // Layer 3: slow ambient shimmer (even still water gets this)
        float shimmer = sin(uv.x * 1.8 + uv.y * 0.9 + uTime * 0.4) * 0.5 + 0.5;
        shimmer *= sin(uv.x * 0.7 - uv.y * 2.1 + uTime * 0.3) * 0.5 + 0.5;

        // Blend: flow patterns scale with speed, shimmer always present
        float flowIntensity = clamp(speed * 0.5, 0.0, 1.0);
        float pattern = mix(shimmer * 0.08, (streaks * 0.5 + ripples * 0.5) * 0.15, flowIntensity);

        // Apply as brightness variation
        gl_FragColor.rgb += pattern;

        // Specular highlight boost on fast-flowing water
        gl_FragColor.rgb += vec3(0.04, 0.06, 0.08) * flowIntensity;

        #include <dithering_fragment>`
      );
    };

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = 1;

    // Velocity buffer for sim to write into
    this._velBuffer = new Float32Array(count * 2);
  }

  /**
   * Update water mesh from simulation state.
   * @param {Float32Array} waterHeights - water depth per cell
   * @param {THREE.Group} terrainGroup - terrain container (for transform matching)
   * @param {WaterSim} waterSim - simulation (for velocity extraction)
   * @param {number} dt - frame delta time
   */
  update(waterHeights, terrainGroup, waterSim, dt) {
    const positions = this.geometry.attributes.position.array;
    const colors = this.geometry.attributes.color.array;
    const velArray = this.velAttr.array;
    const N = this.gridSize;
    const minDepth = CONFIG.MIN_RENDER_DEPTH;

    // Get velocities from sim
    if (waterSim) {
      waterSim.getVelocities(this._velBuffer);
    }

    let hasWater = false;

    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const idx = r * N + c;
        const vertIdx = r * N + c;
        const posOff = vertIdx * 3;
        const colOff = vertIdx * 3;
        const velOff = vertIdx * 2;

        const waterDepth = waterHeights[idx];

        if (waterDepth > minDepth) {
          hasWater = true;
          positions[posOff + 1] = this.terrain[idx] + waterDepth;

          // Depth color: shallow cyan -> deep navy (use real depth for color)
          const dn = Math.min(waterDepth / 5.0, 1.0);
          colors[colOff]     = 0.4  - dn * 0.35;
          colors[colOff + 1] = 0.75 - dn * 0.65;
          colors[colOff + 2] = 0.9  - dn * 0.55;

          // Pass velocity
          velArray[velOff]     = this._velBuffer[idx * 2];
          velArray[velOff + 1] = this._velBuffer[idx * 2 + 1];
        } else {
          // Place dry vertices at terrain surface (not -9999)
          // so adjacent triangles don't stretch into long artifacts
          positions[posOff + 1] = this.terrain[idx] - 0.1;
          // Black + zero velocity = invisible under terrain
          colors[colOff] = colors[colOff + 1] = colors[colOff + 2] = 0;
          velArray[velOff] = velArray[velOff + 1] = 0;
        }
      }
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.velAttr.needsUpdate = true;
    this.mesh.visible = hasWater;

    // Advance shader time
    this._timeUniform.value += dt;

    // Match terrain group transform
    if (terrainGroup) {
      this.mesh.position.copy(terrainGroup.position);
      this.mesh.rotation.copy(terrainGroup.rotation);
      this.mesh.scale.copy(terrainGroup.scale);
    }
  }
}
