import { describe, expect, it } from 'vitest';
import {
  BooleanError,
  BoxSolid,
  ConeSolid,
  CylinderSolid,
  Frame3,
  PolyhedronSolid,
  SphereSolid,
  TorusSolid,
  Transform3,
  type ISolid,
} from '../src/index.js';
import { isWatertight, meshMeasures, v } from './helpers.js';

const PI = Math.PI;
const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => new BoxSolid(Frame3.fromNormal(v(x, y, z)), sx, sy, sz);
const zCylinder = (x: number, y: number, z: number, r: number, h: number) => new CylinderSolid(Frame3.fromNormal(v(x, y, z)), r, h);

/** Checks a result is a sound solid, with the volume expected. */
function expectSolid(result: ISolid | undefined, volume: number, digits = 5): ISolid {
  expect(result).toBeDefined();
  const s = result!;
  expect(s.validate().problems).toEqual([]);
  expect(s.volume / volume).toBeCloseTo(1, digits);
  const size = s.boundingBox().diagonal;
  const mesh = s.tessellate({ chordTolerance: size / 300 });
  expect(isWatertight(mesh)).toBe(true);
  // A mesh within a chord tolerance can't be further off in volume than its area times a few chords.
  const chord = size / 300;
  expect(Math.abs(meshMeasures(mesh).volume - s.volume)).toBeLessThanOrEqual(3 * s.surfaceArea * chord);
  return s;
}

/** Union plus intersection must equal the sum of the two, and the difference their gap. */
function expectConsistent(a: ISolid, b: ISolid, digits = 4): void {
  const union = a.union(b);
  const common = a.intersection(b);
  const rest = a.difference(b);
  const otherRest = b.difference(a);
  expect(union.validate().problems).toEqual([]);
  const commonVolume = common?.volume ?? 0;
  expect((union.volume + commonVolume) / (a.volume + b.volume)).toBeCloseTo(1, digits);
  expect(((rest?.volume ?? 0) + commonVolume) / a.volume).toBeCloseTo(1, digits);
  expect(((otherRest?.volume ?? 0) + commonVolume) / b.volume).toBeCloseTo(1, digits);
}

describe('flat solids', () => {
  const a = box(0, 0, 0, 2, 2, 2);
  const b = box(1, 1, 1, 2, 2, 2);

  it('unites overlapping boxes', () => {
    const u = expectSolid(a.union(b), 8 + 8 - 1);
    expect(u.isClosed).toBe(true);
    expect(u.genus).toBe(0);
  });

  it('intersects overlapping boxes, in a box', () => {
    const c = expectSolid(a.intersection(b), 1);
    expect(c.faces.length).toBe(6);
    expect(c.vertices.length).toBe(8);
    expect(c.surfaceArea).toBeCloseTo(6, 7);
  });

  it('takes one box from another', () => {
    const d = expectSolid(a.difference(b), 7);
    expect(d.containsPoint(v(0.5, 0.5, 0.5))).toBe(true);
    expect(d.containsPoint(v(1.5, 1.5, 1.5))).toBe(false);
  });

  it('cuts a slot right through a box', () => {
    const slot = box(-1, 0.5, -1, 4, 1, 4);
    const d = expectSolid(a.difference(slot), 8 - 2 * 2 * 1);
    expect(d.shells.length).toBe(2);
  });

  it('makes a through hole, with genus 1', () => {
    const hole = box(0.5, 0.5, -1, 1, 1, 4);
    const d = expectSolid(a.difference(hole), 8 - 2);
    expect(d.genus).toBe(1);
  });

  it('agrees with itself by inclusion and exclusion', () => {
    expectConsistent(a, b);
    expectConsistent(PolyhedronSolid.octahedron(2), box(-0.5, -0.5, -0.5, 1.3, 1.3, 1.3));
  });
});

describe('solids sharing planes', () => {
  const a = box(0, 0, 0, 2, 2, 2);

  it('unites boxes stacked face to face, and removes the face between', () => {
    const top = box(0.5, 0.5, 2, 1, 1, 1);
    const u = expectSolid(a.union(top), 9);
    expect(u.containsPoint(v(1, 1, 2))).toBe(true);
  });

  it('unites boxes with whole faces in common', () => {
    expectSolid(a.union(box(0, 0, 2, 2, 2, 2)), 16);
  });

  it('gives nothing for the common part of boxes that only touch', () => {
    expect(a.intersection(box(2, 0, 0, 2, 2, 2))).toBeUndefined();
  });

  it('leaves a box alone when taking a touching box', () => {
    expectSolid(a.difference(box(2, 0, 0, 2, 2, 2)), 8);
  });

  it('handles a pocket cut from one side, flush with it', () => {
    const pocket = box(0.5, 0.5, 1, 1, 1, 1);
    expectSolid(a.difference(pocket), 7);
  });

  it('handles a smaller box sharing a corner', () => {
    expectSolid(a.difference(box(0, 0, 0, 1, 1, 1)), 7);
    expectSolid(a.intersection(box(0, 0, 0, 1, 1, 1)), 1);
    expectSolid(a.union(box(0, 0, 0, 1, 1, 1)), 8);
  });

  it('treats identical solids properly', () => {
    expectSolid(a.union(a), 8);
    expectSolid(a.intersection(a), 8);
    expect(a.difference(a)).toBeUndefined();
  });
});

describe('solids that do not cross', () => {
  const a = box(0, 0, 0, 2, 2, 2);
  const far = box(5, 5, 5, 1, 1, 1);
  const inner = box(0.5, 0.5, 0.5, 1, 1, 1);

  it('keeps disjoint solids as two shells', () => {
    const u = expectSolid(a.union(far), 9);
    expect(u.shells.length).toBe(2);
    expect(a.intersection(far)).toBeUndefined();
    expectSolid(a.difference(far), 8);
  });

  it('makes a cavity from a solid wholly inside', () => {
    const d = expectSolid(a.difference(inner), 7);
    expect(d.shells.length).toBe(2);
    expect(d.containsPoint(v(1, 1, 1))).toBe(false);
    expect(d.containsPoint(v(0.25, 0.25, 0.25))).toBe(true);
    expectSolid(a.union(inner), 8);
    expectSolid(a.intersection(inner), 1);
    expect(inner.difference(a)).toBeUndefined();
  });
});

describe('curved solids', () => {
  it('drills a round hole through a box', () => {
    const hole = zCylinder(1, 1, -1, 0.5, 4);
    const d = expectSolid(box(0, 0, 0, 2, 2, 2).difference(hole), 8 - PI * 0.25 * 2, 4);
    expect(d.genus).toBe(1);
  });

  it('takes the common part of a box and a cylinder', () => {
    expectSolid(box(0, 0, 0, 2, 2, 2).intersection(zCylinder(1, 1, -1, 0.5, 4)), PI * 0.25 * 2, 4);
  });

  it('caps a cylinder that stops inside a box', () => {
    const blind = zCylinder(1, 1, 1, 0.5, 2);
    expectSolid(box(0, 0, 0, 2, 2, 2).difference(blind), 8 - PI * 0.25, 4);
  });

  it('unites a box and a cylinder standing on it', () => {
    const peg = zCylinder(1, 1, 2, 0.5, 1);
    expectSolid(box(0, 0, 0, 2, 2, 2).union(peg), 8 + PI * 0.25, 4);
  });

  it('cuts a sphere with a box, leaving a hemisphere', () => {
    const sphere = SphereSolid.centredAt(v(0, 0, 0), 1);
    const lower = box(-2, -2, -2, 4, 4, 2);
    expectSolid(sphere.intersection(lower), (2 / 3) * PI, 3);
  });

  it('cuts a spherical cap away from a sphere', () => {
    const sphere = SphereSolid.centredAt(v(0, 0, 0), 1);
    const above = box(-2, -2, 0.5, 4, 4, 2);
    const h = 0.5;
    const cap = (PI * h * h * (3 - h)) / 3;
    expectSolid(sphere.intersection(above), cap, 3);
    expectSolid(sphere.difference(above), (4 / 3) * PI - cap, 3);
  });

  it('forms a lens from two spheres', () => {
    const a = SphereSolid.centredAt(v(0, 0, 0), 1);
    const b = SphereSolid.centredAt(v(0.3, 0.2, 1), 1);
    const d = Math.hypot(0.3, 0.2, 1);
    const lens = (PI * (2 - d) ** 2 * (d + 4)) / 12;
    expectSolid(a.intersection(b), lens, 3);
    expectConsistent(a, b, 3);
  });

  it('crosses two cylinders at right angles', () => {
    const a = new CylinderSolid(Frame3.fromNormal(v(0.1, 0, -3)), 1, 6);
    const b = new CylinderSolid(Frame3.fromNormal(v(-3, 0.1, 0.05), v(1, 0, 0)), 0.5, 6);
    const c = a.intersection(b);
    expect(c).toBeDefined();
    expectConsistent(a, b, 3);
  });

  it('cuts a cone with a box', () => {
    const cone = new ConeSolid(Frame3.fromNormal(v(0, 0, 0)), 1, 0, 2);
    const upper = box(-2, -2, 1, 4, 4, 2);
    const smaller = (PI * 0.25 * 1) / 3;
    expectSolid(cone.intersection(upper), smaller, 3);
    expectSolid(cone.difference(upper), (PI * 2) / 3 - smaller, 3);
  });

  it('cuts a torus with a box', () => {
    const torus = new TorusSolid(Frame3.fromNormal(v(0, 0, 0)), 3, 1);
    const half = box(-6, 0.01, -2, 12, 6, 4);
    expectSolid(torus.intersection(half), undefinedTorusHalf(), 2);
    expectSolid(torus.difference(half), 2 * PI * PI * 3 - undefinedTorusHalf(), 2);
  });
});

/** Half a torus, less the thin slice between y = 0 and y = 0.01. */
function undefinedTorusHalf(): number {
  return PI * PI * 3 - 2 * PI * 0.01;
}

describe('general solids', () => {
  it('works on transformed solids, and any order', () => {
    const t = Transform3.rotate(v(1, 2, 3), 0.7);
    const a = box(0, 0, 0, 2, 2, 2).transformed(t);
    const b = box(1, 1, 1, 2, 2, 2).transformed(t);
    expectSolid(a.union(b), 15);
    expectSolid(b.union(a), 15);
    expectSolid(a.intersection(b), 1);
  });

  it('chains operations', () => {
    const plate = box(0, 0, 0, 6, 4, 1);
    const one = plate.difference(zCylinder(1.5, 2, -1, 0.5, 3))!;
    const two = one.difference(zCylinder(4.5, 2, -1, 0.5, 3))!;
    const result = expectSolid(two, 24 - 2 * PI * 0.25, 3);
    expect(result.genus).toBe(2);
    const stood = result.union(box(2.5, 1.5, 1, 1, 1, 1));
    expectSolid(stood, 25 - 2 * PI * 0.25, 3);
  });

  it('refuses to make a non-manifold result', () => {
    const a = box(0, 0, 0, 1, 1, 1);
    const edgeToEdge = box(1, 1, 0, 1, 1, 1);
    expect(() => a.union(edgeToEdge)).toThrow(BooleanError);
  });
});
