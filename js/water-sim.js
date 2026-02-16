import { CONFIG } from './config.js';

/**
 * Pipe-model flux-based shallow water equation solver.
 *
 * Grid is row-major (row * gridSize + col).
 * Physics use real-world terrain heights (no exaggeration).
 * Water depths are in real meters.
 */
export class WaterSim {
  constructor(heightmap, gridSize, cellSizeM, vertExag = 1) {
    this.gridSize = gridSize;
    this.cellSize = cellSizeM;
    this.N = gridSize * gridSize;
    this.vertExag = vertExag;

    // Terrain heights (exaggerated) — used for physics.
    // Exaggeration compensates for coarse grid resolution,
    // producing visible flow at 20-30m cell sizes.
    this.terrain = heightmap;

    // Water depth at each cell
    this.water = new Float32Array(this.N);

    // Flux arrays (flow rate to each neighbor)
    this.fluxR = new Float32Array(this.N);
    this.fluxD = new Float32Array(this.N);
    this.fluxL = new Float32Array(this.N);
    this.fluxU = new Float32Array(this.N);

    this.g = CONFIG.SIM_GRAVITY;

    // Edge drain: fraction of water depth that flows off-edge per second.
    this.edgeDrainRate = 2.0;

    // Ground absorption: m/s of water that soaks into the ground.
    this.infiltrationRate = 0.0000006;  // ~2mm/hr
  }

  step(dt) {
    const { gridSize, terrain, water, fluxR, fluxD, fluxL, fluxU, g } = this;
    const N = gridSize;
    const A = this.cellSize;
    const flowMul = CONFIG.SIM_FLOW_MULTIPLIER;

    // 1. Update flux based on height differences
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const idx = r * N + c;
        const surfH = terrain[idx] + water[idx];

        if (c < N - 1) {
          const nIdx = idx + 1;
          const dh = surfH - terrain[nIdx] - water[nIdx];
          fluxR[idx] = Math.max(0, fluxR[idx] + dt * g * flowMul * A * dh / this.cellSize);
        } else {
          fluxR[idx] = water[idx] > 0 ? water[idx] * this.edgeDrainRate : 0;
        }

        if (r < N - 1) {
          const nIdx = idx + N;
          const dh = surfH - terrain[nIdx] - water[nIdx];
          fluxD[idx] = Math.max(0, fluxD[idx] + dt * g * flowMul * A * dh / this.cellSize);
        } else {
          fluxD[idx] = water[idx] > 0 ? water[idx] * this.edgeDrainRate : 0;
        }

        if (c > 0) {
          const nIdx = idx - 1;
          const dh = surfH - terrain[nIdx] - water[nIdx];
          fluxL[idx] = Math.max(0, fluxL[idx] + dt * g * flowMul * A * dh / this.cellSize);
        } else {
          fluxL[idx] = water[idx] > 0 ? water[idx] * this.edgeDrainRate : 0;
        }

        if (r > 0) {
          const nIdx = idx - N;
          const dh = surfH - terrain[nIdx] - water[nIdx];
          fluxU[idx] = Math.max(0, fluxU[idx] + dt * g * flowMul * A * dh / this.cellSize);
        } else {
          fluxU[idx] = water[idx] > 0 ? water[idx] * this.edgeDrainRate : 0;
        }

        // Scale outgoing flux so cell doesn't go negative
        const totalOut = fluxR[idx] + fluxD[idx] + fluxL[idx] + fluxU[idx];
        if (totalOut > 0) {
          const maxOut = water[idx] * this.cellSize * this.cellSize / dt;
          if (totalOut > maxOut) {
            const scale = maxOut / totalOut;
            fluxR[idx] *= scale;
            fluxD[idx] *= scale;
            fluxL[idx] *= scale;
            fluxU[idx] *= scale;
          }
        }
      }
    }

    // 2. Apply flux to update water heights
    const cellArea = this.cellSize * this.cellSize;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const idx = r * N + c;
        let netFlux = -(fluxR[idx] + fluxD[idx] + fluxL[idx] + fluxU[idx]);
        if (c > 0) netFlux += fluxR[idx - 1];
        if (c < N - 1) netFlux += fluxL[idx + 1];
        if (r > 0) netFlux += fluxD[idx - N];
        if (r < N - 1) netFlux += fluxU[idx + N];
        water[idx] += netFlux * dt / cellArea;
        if (water[idx] < 0) water[idx] = 0;
      }
    }

    // 3. Ground absorption
    const drain = this.infiltrationRate * dt;
    if (drain > 0) {
      for (let i = 0; i < N * N; i++) {
        if (water[i] > 0) {
          water[i] = Math.max(0, water[i] - drain);
        }
      }
    }
  }

  addRainGlobal(amountM) {
    for (let i = 0; i < this.N; i++) {
      this.water[i] += amountM;
    }
  }

  addRain(centerCol, centerRow, radiusCells, amountM) {
    const N = this.gridSize;
    const r2 = radiusCells * radiusCells;
    const rMin = Math.max(0, Math.floor(centerRow - radiusCells));
    const rMax = Math.min(N - 1, Math.ceil(centerRow + radiusCells));
    const cMin = Math.max(0, Math.floor(centerCol - radiusCells));
    const cMax = Math.min(N - 1, Math.ceil(centerCol + radiusCells));

    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const dr = r - centerRow;
        const dc = c - centerCol;
        if (dr * dr + dc * dc <= r2) {
          this.water[r * N + c] += amountM;
        }
      }
    }
  }

  reset() {
    this.water.fill(0);
    this.fluxR.fill(0);
    this.fluxD.fill(0);
    this.fluxL.fill(0);
    this.fluxU.fill(0);
  }

  getWaterHeights() {
    return this.water;
  }

  getVelocities(out) {
    const N = this.gridSize;
    const { water, fluxR, fluxD, fluxL, fluxU, cellSize } = this;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const idx = r * N + c;
        const d = water[idx];
        if (d > 0.01) {
          const fRight = fluxR[idx];
          const fLeft = c > 0 ? fluxR[idx - 1] : 0;
          const fDown = fluxD[idx];
          const fUp = r > 0 ? fluxD[idx - N] : 0;
          const vx = (fRight - fLeft) / (d * cellSize);
          const vz = (fDown - fUp) / (d * cellSize);
          out[idx * 2] = vx;
          out[idx * 2 + 1] = vz;
        } else {
          out[idx * 2] = 0;
          out[idx * 2 + 1] = 0;
        }
      }
    }
  }

  getTotalVolume() {
    let vol = 0;
    const cellArea = this.cellSize * this.cellSize;
    for (let i = 0; i < this.N; i++) {
      vol += this.water[i] * cellArea;
    }
    return vol;
  }

  getMaxDepth() {
    let max = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.water[i] > max) max = this.water[i];
    }
    return max;
  }
}
