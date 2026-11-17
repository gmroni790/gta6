// Seeded randomness for Sunset Bay: one mulberry32 stream per world, so a seed always
// builds the same city, the same traffic and the same screenshot scenes. Game code must
// never call Math.random(); it takes its randomness from G.rng, made here.

/** A small fast seeded generator: mulberry32. `seed` is any 32-bit integer. */
export function createRandom(seed) {
  let state = seed >>> 0;
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    /** A float in [min, max). */
    range(min, max) {
      return min + (max - min) * next();
    },
    /** An integer in [min, max]. */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** One element of `array`, uniformly. */
    pick(array) {
      return array[Math.floor(next() * array.length)];
    },
    /** True with probability `p`. */
    chance(p) {
      return next() < p;
    },
  };
}
