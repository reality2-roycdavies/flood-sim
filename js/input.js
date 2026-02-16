import { CONFIG } from './config.js';

const MOUSE_SENSITIVITY = 0.002;
const PITCH_LIMIT = Math.PI * 0.45;

export class InputManager {
  constructor(vrSetup) {
    this.vrSetup = vrSetup;
    this.leftStick = { x: 0, y: 0 };
    this.rightStick = { x: 0, y: 0 };
    this.rightTrigger = false;
    this.rightGrip = false;
    this.leftGrip = false;
    this.aButtonPressed = false;  // toggle tabletop/immersive
    this.bButtonPressed = false;  // reset water
    this.resetPressed = false;
    this.toggleViewPressed = false;

    // Mouse look state (desktop)
    this.mouseYaw = 0;
    this.mousePitch = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.pointerLocked = false;

    // Mouse click for storm placement
    this.mouseClicked = false;
    this.mouseX = 0;
    this.mouseY = 0;

    // Rain rate adjustment (+/- keys, edge-triggered)
    this.rainAdjust = 0;  // +1 or -1 per press
    this._lastPlus = false;
    this._lastMinus = false;

    // Sim speed adjustment ([ ] keys, edge-triggered)
    this.simSlower = false;
    this.simFaster = false;
    this._lastBracketL = false;
    this._lastBracketR = false;

    // Desktop keyboard
    this.keys = {};
    window.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    // Mouse events
    const canvas = vrSetup.renderer.domElement;

    canvas.addEventListener('click', (e) => {
      if (!this.vrSetup.isInVR()) {
        this.mouseClicked = true;
        this.mouseX = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      // Always track mouse position for hover raycasting
      this.mouseX = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
    });

    // Edge-triggered state
    this._lastAButton = false;
    this._lastBButton = false;
    this._lastTab = false;
    this._lastKeyB = false;
  }

  update() {
    this.leftStick.x = 0;
    this.leftStick.y = 0;
    this.rightStick.x = 0;
    this.rightStick.y = 0;
    this.rightTrigger = false;
    this.rightGrip = false;
    this.leftGrip = false;
    this.aButtonPressed = false;
    this.bButtonPressed = false;
    this.resetPressed = false;
    this.toggleViewPressed = false;
    this.rainAdjust = 0;
    this.simSlower = false;
    this.simFaster = false;

    if (this.vrSetup.isInVR()) {
      this._pollGamepads();
    } else {
      this._pollKeyboard();
    }

    // Edge-triggered Tab (toggle view)
    const tabNow = !!this.keys['Tab'];
    if (tabNow && !this._lastTab) {
      this.toggleViewPressed = true;
    }
    this._lastTab = tabNow;

    // Edge-triggered B key (reset water)
    const keyBNow = !!this.keys['KeyB'];
    if (keyBNow && !this._lastKeyB) {
      this.resetPressed = true;
    }
    this._lastKeyB = keyBNow;

    // Edge-triggered +/- keys (rain rate)
    const plusNow = !!(this.keys['Equal'] || this.keys['NumpadAdd']);
    if (plusNow && !this._lastPlus) this.rainAdjust = 1;
    this._lastPlus = plusNow;

    const minusNow = !!(this.keys['Minus'] || this.keys['NumpadSubtract']);
    if (minusNow && !this._lastMinus) this.rainAdjust = -1;
    this._lastMinus = minusNow;

    // Edge-triggered [ ] keys (sim speed)
    const blNow = !!this.keys['BracketLeft'];
    if (blNow && !this._lastBracketL) this.simSlower = true;
    this._lastBracketL = blNow;

    const brNow = !!this.keys['BracketRight'];
    if (brNow && !this._lastBracketR) this.simFaster = true;
    this._lastBracketR = brNow;
  }

  consumeClick() {
    if (this.mouseClicked) {
      this.mouseClicked = false;
      return true;
    }
    return false;
  }

  _pollGamepads() {
    const session = this.vrSetup.renderer.xr.getSession();
    if (!session) return;

    const sources = session.inputSources;
    if (!sources || sources.length === 0) return;

    for (const source of sources) {
      if (!source.gamepad) continue;
      const axes = source.gamepad.axes;
      const buttons = source.gamepad.buttons;

      const sx = axes.length > 2 ? (axes[2] ?? 0) : (axes[0] ?? 0);
      const sy = axes.length > 3 ? (axes[3] ?? 0) : (axes[1] ?? 0);

      if (source.handedness === 'left') {
        this.leftStick.x = Math.abs(sx) > CONFIG.THUMBSTICK_DEADZONE ? sx : 0;
        this.leftStick.y = Math.abs(sy) > CONFIG.THUMBSTICK_DEADZONE ? sy : 0;
        this.leftGrip = buttons[1] && buttons[1].pressed;
      } else if (source.handedness === 'right') {
        this.rightStick.x = Math.abs(sx) > CONFIG.THUMBSTICK_DEADZONE ? sx : 0;
        this.rightStick.y = Math.abs(sy) > CONFIG.THUMBSTICK_DEADZONE ? sy : 0;
        this.rightGrip = buttons[1] && buttons[1].pressed;
        // Right trigger
        this.rightTrigger = buttons[0] && buttons[0].pressed;

        // A button (index 4) - toggle view (edge-triggered)
        const aBtn = buttons[4] && buttons[4].pressed;
        if (aBtn && !this._lastAButton) {
          this.toggleViewPressed = true;
        }
        this._lastAButton = aBtn;

        // B button (index 5) - reset water (edge-triggered)
        const bBtn = buttons[5] && buttons[5].pressed;
        if (bBtn && !this._lastBButton) {
          this.resetPressed = true;
        }
        this._lastBButton = bBtn;
      }
    }
  }

  _pollKeyboard() {
    if (this.keys['KeyW']) this.leftStick.y = -1;
    if (this.keys['KeyS']) this.leftStick.y = 1;
    if (this.keys['KeyA']) this.leftStick.x = -1;
    if (this.keys['KeyD']) this.leftStick.x = 1;
  }
}
