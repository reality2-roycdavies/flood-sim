import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { CONFIG } from './config.js';

export class VRSetup {
  constructor() {
    this.renderer = null;
    this.camera = null;
    this.dolly = null;
    this.controllers = [];
    this.controllerGrips = [];
    this.session = null;
    this.onSessionStart = null;
    this.onSessionEnd = null;
  }

  init() {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    document.body.appendChild(this.renderer.domElement);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      CONFIG.NEAR_CLIP,
      CONFIG.FAR_CLIP,
    );
    this.camera.position.set(0, CONFIG.EYE_HEIGHT, 0);

    // Dolly (camera rig)
    this.dolly = new THREE.Group();
    this.dolly.add(this.camera);

    // Controllers
    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      this.dolly.add(controller);
      this.controllers.push(controller);

      // Controller grip (for visual models)
      const grip = this.renderer.xr.getControllerGrip(i);
      this.dolly.add(grip);
      this.controllerGrips.push(grip);

      // Ray line for pointing
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -5),
      ]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0x4a9eda, linewidth: 2 });
      const line = new THREE.Line(lineGeo, lineMat);
      line.visible = false;
      controller.add(line);
      controller.userData.line = line;
    }

    // VR Button
    const vrButton = VRButton.createButton(this.renderer);
    document.body.appendChild(vrButton);

    // Session events
    this.renderer.xr.addEventListener('sessionstart', () => {
      this.session = this.renderer.xr.getSession();
      // Enable foveated rendering for Quest
      if (this.renderer.xr.getFoveation) {
        try { this.renderer.xr.setFoveation(1); } catch (e) { /* ignore */ }
      }
      // Show controller ray lines
      this.controllers.forEach(c => {
        if (c.userData.line) c.userData.line.visible = true;
      });
      if (this.onSessionStart) this.onSessionStart();
    });

    this.renderer.xr.addEventListener('sessionend', () => {
      this.session = null;
      this.controllers.forEach(c => {
        if (c.userData.line) c.userData.line.visible = false;
      });
      if (this.onSessionEnd) this.onSessionEnd();
    });

    // Handle resize
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return this;
  }

  isInVR() {
    return this.renderer.xr.isPresenting;
  }
}
