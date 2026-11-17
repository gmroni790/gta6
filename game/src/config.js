// Shared constants for Sunset Bay: the city grid, the palette, the tuning numbers.
// Every module imports these instead of hardcoding layout numbers, so the city stays
// one consistent place no matter which file is asking about it.

// The city is a square, CITY_HALF metres from its centre to each edge, on a grid of
// avenues (north-south) and streets (east-west) ROAD_SPACING apart.
export const CITY_HALF = 300;
export const ROAD_SPACING = 60;
export const ROAD_WIDTH = 12;
export const SIDEWALK = 3;
export const BLOCK = ROAD_SPACING - ROAD_WIDTH - 2 * SIDEWALK; // 42
export const AVENUES = [-240, -180, -120, -60, 0, 60, 120, 180, 240];
export const STREETS = [-240, -180, -120, -60, 0, 60, 120, 180, 240];

// A sun-soaked coastal palette: warm light, turquoise water, pale buildings.
export const COLORS = {
  sky: 0x8ec9e8,
  fog: 0xa8d0e6,
  sun: 0xfff1d6,
  ground: 0x8a8f7a,
  asphalt: 0x333338,
  asphaltLine: 0xd8d8c8,
  sidewalk: 0x9a9a92,
  sand: 0xe8d9a8,
  water: 0x2e8fa8,
  building: [0xd8cfc0, 0xc8b8a0, 0xb8c4cc, 0xd8b8a0, 0xa8b8a8, 0xe0d8cc],
  glass: 0x2a3a48,
  palm: 0x3a7a3a,
  car: [0xc83232, 0x3268c8, 0xe8e8e8, 0x222222, 0xe8a832, 0x38a868, 0x8832a8, 0xc86828],
  police: 0x1a1a2e,
};

export const DISTRICTS = [
  { name: 'Downtown', minX: -120, maxX: 120, minZ: -120, maxZ: 120, tall: true },
  { name: 'Marina', minX: -300, maxX: 300, minZ: 180, maxZ: 300, tall: false },
  { name: 'Old Town', minX: -300, maxX: -120, minZ: -300, maxZ: 180, tall: false },
  { name: 'Harbor', minX: 180, maxX: 300, minZ: -300, maxZ: 180, tall: false },
  { name: 'Hills', minX: -120, maxX: 180, minZ: -300, maxZ: -120, tall: false },
];

export const TUNING = {
  walkSpeed: 5,
  runSpeed: 9,
  jumpSpeed: 7,
  gravity: 20,
  carAccel: 14,
  carBrake: 26,
  carMaxSpeed: 42, // m/s, ~150 km/h for the fastest cars
  carTurn: 1.9,
  trafficSpeed: 12,
  pedSpeed: 1.4,
  copSpeed: 7.5,
  playerMaxHealth: 100,
  startMoney: 250,
  paintCost: 100,
  tokenValue: 50,
};

export const CONFIG = {
  CITY_HALF,
  ROAD_SPACING,
  ROAD_WIDTH,
  SIDEWALK,
  BLOCK,
  AVENUES,
  STREETS,
  COLORS,
  DISTRICTS,
  TUNING,
  // Fixed-step simulation: 60 steps a second, as the starter ran.
  STEP: 1 / 60,
  MAX_FRAME: 0.25,
  SAVE_KEY: 'sunset-bay-save-v1',
};
