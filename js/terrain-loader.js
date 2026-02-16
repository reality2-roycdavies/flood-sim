import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Load terrain data: GLB mesh + heightmap binary + metadata JSON + optional overlay.
 * Returns { terrainMesh, heightmap (Float32Array), meta }
 */
export async function loadTerrain(dataPath) {
  const [glb, heightmapBuf, meta] = await Promise.all([
    loadGLB(`${dataPath}/terrain.glb`),
    fetch(`${dataPath}/heightmap.bin`).then(r => r.arrayBuffer()),
    fetch(`${dataPath}/heightmap_meta.json`).then(r => r.json()),
  ]);

  // Try loading overlay texture (optional)
  let overlayTexture = null;
  if (meta.has_overlay) {
    try {
      overlayTexture = await loadTexture(`${dataPath}/overlay.png`);
      overlayTexture.colorSpace = THREE.SRGBColorSpace;
      console.log('[Terrain] Overlay texture loaded');
    } catch (e) {
      console.log('[Terrain] No overlay texture found');
    }
  }

  // Extract terrain mesh from GLB
  const terrainMesh = glb.scene;

  // Apply material to all meshes
  terrainMesh.traverse((child) => {
    if (child.isMesh) {
      if (overlayTexture) {
        // Generate UVs from vertex positions (regular grid)
        addGridUVs(child.geometry);

        child.material = new THREE.MeshPhongMaterial({
          map: overlayTexture,
          vertexColors: true,
          flatShading: false,
          side: THREE.FrontSide,
        });
        // Blend: map is primary, vertex colors add subtle elevation shading
        child.material.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <color_fragment>',
            `#include <color_fragment>
            // diffuseColor = map * vColor (both set).
            // Undo the multiply, then re-blend with map dominant.
            // vColor is in vertex color attribute, map sample is in texelColor.
            // After color_fragment: diffuseColor.rgb = texelColor * vColor
            // We want mostly texelColor with light elevation tint.
            // Approximate: brighten toward the map by pushing vertex color toward white.
            diffuseColor.rgb = pow(diffuseColor.rgb, vec3(0.55));`
          );
        };
      } else {
        child.material = new THREE.MeshPhongMaterial({
          vertexColors: true,
          flatShading: false,
          side: THREE.FrontSide,
        });
      }
      child.material.needsUpdate = true;
    }
  });

  // Parse heightmap
  const heightmap = new Float32Array(heightmapBuf);

  console.log(`[Terrain] Loaded: ${meta.grid_size}x${meta.grid_size}, ` +
    `elev ${meta.elev_min}-${meta.elev_max}m, cell ${meta.cell_size_m}m`);

  return { terrainMesh, heightmap, meta };
}

/**
 * Generate UV coordinates from vertex positions for a regular grid mesh.
 * Maps X -> U, Z -> V based on the mesh bounding box.
 */
function addGridUVs(geometry) {
  const pos = geometry.attributes.position;
  const count = pos.count;
  const uvs = new Float32Array(count * 2);

  // Find bounds
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const rangeX = maxX - minX || 1;
  const rangeZ = maxZ - minZ || 1;

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    uvs[i * 2] = (x - minX) / rangeX;
    uvs[i * 2 + 1] = 1.0 - (z - minZ) / rangeZ;  // flip V: north = top of image
  }

  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

function loadGLB(url) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(url, resolve, undefined, reject);
  });
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(url, resolve, undefined, reject);
  });
}
