export const CONFIG = {
  // Terrain
  DATA_PATH: 'data',

  // Water simulation
  SIM_GRAVITY: 9.81,
  SIM_DT: 0.02,
  SIM_STEPS_PER_FRAME: 4,
  SIM_SPEED_MIN: 1,
  SIM_SPEED_MAX: 500,
  SIM_FLOW_MULTIPLIER: 2.0,  // amplify gravity-driven flow for visual effect
  MIN_RENDER_DEPTH: 0.05,

  // Storm
  STORM_DEFAULT_RADIUS_CELLS: 30,
  STORM_DEFAULT_RAIN_RATE: 0.00005,  // m/s (~180 mm/hr, heavy storm)
  STORM_MAX_RAIN_RATE: 0.001,        // m/s (~3600 mm/hr, extreme)

  // View modes
  TABLETOP_SCALE: null,  // computed from terrain size -> fit 1.5m
  TABLETOP_HEIGHT: 0.8,  // meters above floor
  TABLETOP_DISTANCE: 0.5,  // meters in front of user
  EYE_HEIGHT: 1.6,

  // Camera
  NEAR_CLIP: 0.01,
  FAR_CLIP: 500,

  // Input
  THUMBSTICK_DEADZONE: 0.15,
};
