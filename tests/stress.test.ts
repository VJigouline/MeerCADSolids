import { describe, expect, it } from 'vitest';
import { BooleanError, BoxSolid, ConeSolid, CylinderSolid, Frame3, SphereSolid, TorusSolid, TubeSolid, type ISolid } from '../src/index.js';
import { v } from './helpers.js';

/**
 * Random pairs in general position. A refusal is allowed, since the library promises to throw rather
 * than return a wrong solid, but a wrong answer is not. So each result is checked two ways:
 * inclusion and exclusion, and a grid count made from the two inputs alone.
 */
let seed = 20261103;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const r = (a: number, b: number) => a + (b - a) * random();
const frame = () => Frame3.fromNormal(v(r(-1, 1), r(-1, 1), r(-1, 1)), v(r(-1, 1), r(-1, 1), r(0.2, 1)), v(r(-1, 1), r(-1, 1), r(-1, 1)));

const makers: Record<string, () => ISolid> = {
  box: () => new BoxSolid(frame(), r(1, 3), r(1, 3), r(1, 3)),
  cylinder: () => new CylinderSolid(frame(), r(0.4, 1.5), r(1, 4)),
  sphere: () => new SphereSolid(frame(), r(0.5, 2)),
  cone: () => new ConeSolid(frame(), r(0.5, 1.5), r(0, 0.5), r(1, 3)),
  torus: () => new TorusSolid(frame(), r(1.2, 2), r(0.3, 0.8)),
  tube: () => new TubeSolid(frame(), r(1, 2), r(0.3, 0.8), r(1, 3)),
};

function gridCount(a: ISolid, b: ISolid, n = 12): number {
  const [p, q] = [a.boundingBox(), b.boundingBox()];
  const lo = v(Math.min(p.min.x, q.min.x), Math.min(p.min.y, q.min.y), Math.min(p.min.z, q.min.z));
  const hi = v(Math.max(p.max.x, q.max.x), Math.max(p.max.y, q.max.y), Math.max(p.max.z, q.max.z));
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        const x = v(lo.x + ((hi.x - lo.x) * (i + 0.5)) / n, lo.y + ((hi.y - lo.y) * (j + 0.5)) / n, lo.z + ((hi.z - lo.z) * (k + 0.5)) / n);
        if (a.containsPoint(x) && b.containsPoint(x)) {
          count++;
        }
      }
    }
  }
  return (count / n ** 3) * (hi.x - lo.x) * (hi.y - lo.y) * (hi.z - lo.z);
}

describe.each([
  ['box', 'box'],
  ['box', 'cylinder'],
  ['cylinder', 'cylinder'],
  ['box', 'cone'],
  ['box', 'sphere'],
  ['box', 'torus'],
  ['cylinder', 'tube'],
])('random %s and %s', (first, second) => {
  it('never gives a wrong answer, and rarely refuses', () => {
    let refused = 0;
    const count = 4;
    for (let n = 0; n < count; n++) {
      const [a, b] = [makers[first]!(), makers[second]!()];
      try {
        const union = a.union(b);
        const common = a.intersection(b);
        const rest = a.difference(b);
        const shared = common?.volume ?? 0;
        expect(Math.abs(union.volume + shared - a.volume - b.volume) / (a.volume + b.volume)).toBeLessThan(1e-3);
        expect(Math.abs((rest?.volume ?? 0) + shared - a.volume) / a.volume).toBeLessThan(1e-3);
        expect(union.validate().valid).toBe(true);
        const counted = gridCount(a, b);
        const spread = Math.max(a.boundingBox().diagonal, b.boundingBox().diagonal);
        expect(Math.abs(counted - shared)).toBeLessThan(Math.max(0.05 * (a.volume + b.volume), 30 * (spread / 12) ** 3));
      } catch (error) {
        if (!(error instanceof BooleanError)) {
          throw error;
        }
        refused++;
      }
    }
    expect(refused).toBeLessThanOrEqual(1);
  });
});
