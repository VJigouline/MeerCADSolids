import { BezierCurve, CircularArc, Helix, Line } from 'meercad-curves';
import {
  BoxSolid,
  CapsuleSolid,
  ConeSolid,
  CylinderSolid,
  EllipsoidSolid,
  ExtrudedSolid,
  Frame3,
  HollowSphereSolid,
  LoftedSolid,
  PipeSolid,
  PolyhedronSolid,
  PyramidSolid,
  RegularPrismSolid,
  RevolvedSolid,
  SphereSolid,
  SweptSolid,
  TorusSolid,
  Transform3,
  TubeSolid,
  WedgeSolid,
  type ISolid,
} from '../src/index.js';
import { v } from './helpers.js';

/** A frame that is not aligned with the world, so tests catch mixed-up local and world coordinates. */
export const tilted = Frame3.fromNormal(v(1, 2, 3), v(1, 1, 2), v(1, -1, 0));

const square = (size: number, z = 0) => [
  new Line(v(0, 0, z), v(size, 0, z)),
  new Line(v(size, 0, z), v(size, size, z)),
  new Line(v(size, size, z), v(0, size, z)),
  new Line(v(0, size, z), v(0, 0, z)),
];

export interface Expected {
  readonly volume?: number;
  readonly area?: number;
  readonly genus: number;
  readonly centroid?: [number, number, number];
  /** True if derivatives on the faces are numeric, which limits the accuracy of its measures. */
  readonly numeric?: boolean;
}

const PI = Math.PI;

/** One instance of every solid kind, with what is known about it. */
export const catalog: Record<string, { make: () => ISolid; expected: Expected }> = {
  BoxSolid: { make: () => new BoxSolid(tilted, 2, 3, 4), expected: { volume: 24, area: 52, genus: 0 } },
  'WedgeSolid (ramp)': { make: () => new WedgeSolid(tilted, 3, 2, 4), expected: { volume: 12, area: 3 * 2 + 3 * 4 + 2 * 4 + 2 * 5, genus: 0 } },
  'WedgeSolid (cut)': { make: () => new WedgeSolid(tilted, 3, 2, 4, 1), expected: { volume: 16, genus: 0 } },
  PyramidSolid: { make: () => new PyramidSolid(tilted, 4, Math.SQRT2, 3), expected: { volume: (4 * 3) / 3, genus: 0 } },
  'PyramidSolid (frustum)': { make: () => new PyramidSolid(tilted, 4, Math.SQRT2, 3, Math.SQRT2 / 2), expected: { volume: (3 * (4 + 1 + 2)) / 3, genus: 0 } },
  RegularPrismSolid: { make: () => new RegularPrismSolid(tilted, 6, 2, 3), expected: { volume: ((3 * Math.sqrt(3)) / 2) * 4 * 3, genus: 0 } },
  Tetrahedron: { make: () => PolyhedronSolid.tetrahedron(2), expected: { volume: 8 / (6 * Math.SQRT2), area: Math.sqrt(3) * 4, genus: 0 } },
  Octahedron: { make: () => PolyhedronSolid.octahedron(2), expected: { volume: (Math.SQRT2 / 3) * 8, area: 2 * Math.sqrt(3) * 4, genus: 0 } },
  Icosahedron: { make: () => PolyhedronSolid.icosahedron(1), expected: { volume: (5 / 12) * (3 + Math.sqrt(5)), area: 5 * Math.sqrt(3), genus: 0 } },
  Dodecahedron: { make: () => PolyhedronSolid.dodecahedron(1), expected: { volume: (15 + 7 * Math.sqrt(5)) / 4, area: 3 * Math.sqrt(25 + 10 * Math.sqrt(5)), genus: 0 } },
  CylinderSolid: { make: () => new CylinderSolid(tilted, 2, 5), expected: { volume: PI * 4 * 5, area: 2 * PI * 2 * 5 + 2 * PI * 4, genus: 0 } },
  TubeSolid: { make: () => new TubeSolid(tilted, 3, 1, 4), expected: { volume: PI * 8 * 4, area: 2 * PI * 3 * 4 + 2 * PI * 1 * 4 + 2 * PI * 8, genus: 1 } },
  'ConeSolid (apex)': { make: () => new ConeSolid(tilted, 2, 0, 3), expected: { volume: (PI * 4 * 3) / 3, area: PI * 2 * Math.hypot(2, 3) + PI * 4, genus: 0 } },
  'ConeSolid (frustum)': { make: () => new ConeSolid(tilted, 3, 1, 4), expected: { volume: (PI * 4 * (9 + 3 + 1)) / 3, area: PI * (3 + 1) * Math.hypot(2, 4) + PI * 9 + PI, genus: 0 } },
  SphereSolid: { make: () => new SphereSolid(tilted, 2), expected: { volume: (4 / 3) * PI * 8, area: 16 * PI, genus: 0 } },
  HollowSphereSolid: { make: () => new HollowSphereSolid(tilted, 3, 1), expected: { volume: (4 / 3) * PI * 26, area: 4 * PI * 10, genus: 0 } },
  EllipsoidSolid: { make: () => new EllipsoidSolid(tilted, 3, 2, 1), expected: { volume: (4 / 3) * PI * 6, genus: 0 } },
  TorusSolid: { make: () => new TorusSolid(tilted, 3, 1), expected: { volume: 2 * PI * PI * 3, area: 4 * PI * PI * 3, genus: 1 } },
  CapsuleSolid: { make: () => new CapsuleSolid(tilted, 1, 2), expected: { volume: PI * 2 + (4 / 3) * PI, area: 2 * PI * 2 + 4 * PI, genus: 0 } },
  'ExtrudedSolid (square)': { make: () => new ExtrudedSolid({ outer: square(2) }, v(0, 0, 3)), expected: { volume: 12, area: 2 * 4 + 4 * 2 * 3, genus: 0 } },
  'ExtrudedSolid (oblique)': { make: () => new ExtrudedSolid({ outer: square(2) }, v(1, 1, 3)), expected: { volume: 12, genus: 0 } },
  'ExtrudedSolid (circle)': { make: () => new ExtrudedSolid({ outer: [CircularArc.circle(v(1, 1), 2)] }, v(0, 0, 3)), expected: { volume: PI * 4 * 3, area: 2 * PI * 2 * 3 + 2 * PI * 4, genus: 0 } },
  'ExtrudedSolid (hole)': {
    make: () => new ExtrudedSolid({ outer: square(4), holes: [[CircularArc.circle(v(2, 2), 1)]] }, v(0, 0, 3)),
    expected: { volume: (16 - PI) * 3, area: 2 * (16 - PI) + 4 * 4 * 3 + 2 * PI * 3, genus: 1 },
  },
  'ExtrudedSolid (reversed wire)': {
    make: () => new ExtrudedSolid({ outer: [...square(2)].reverse().map((c) => c.reversed()) }, v(0, 0, -3)),
    expected: { volume: 12, genus: 0 },
  },
  'RevolvedSolid (sphere)': {
    make: () => {
      const half = Frame3.fromAxes(v(0, 0, 0), v(1, 0, 0), v(0, 0, 1), v(0, -1, 0));
      return new RevolvedSolid([new CircularArc(half, 2, -PI / 2, PI / 2)], v(0, 0, 0), v(0, 0, 1));
    },
    expected: { volume: (4 / 3) * PI * 8, area: 16 * PI, genus: 0 },
  },
  'RevolvedSolid (ring)': {
    make: () => {
      const tube = Frame3.fromAxes(v(3, 0, 0), v(1, 0, 0), v(0, 0, 1), v(0, -1, 0));
      return new RevolvedSolid([new CircularArc(tube, 1, 0, 2 * PI)], v(0, 0, 0), v(0, 0, 1));
    },
    expected: { volume: 2 * PI * PI * 3, area: 4 * PI * PI * 3, genus: 1 },
  },
  'RevolvedSolid (washer)': {
    make: () =>
      new RevolvedSolid(
        [new Line(v(2, 0, 0), v(3, 0, 0)), new Line(v(3, 0, 0), v(3, 0, 1)), new Line(v(3, 0, 1), v(2, 0, 1)), new Line(v(2, 0, 1), v(2, 0, 0))],
        v(0, 0, 0),
        v(0, 0, 1),
      ),
    expected: { volume: PI * 5, genus: 1 },
  },
  'RevolvedSolid (with axis curve)': {
    make: () =>
      new RevolvedSolid(
        [new Line(v(0, 0, 0), v(2, 0, 0)), new Line(v(2, 0, 0), v(2, 0, 3)), new Line(v(2, 0, 3), v(0, 0, 3)), new Line(v(0, 0, 3), v(0, 0, 0))],
        v(0, 0, 0),
        v(0, 0, 1),
      ),
    expected: { volume: PI * 4 * 3, area: 2 * PI * 2 * 3 + 2 * PI * 4, genus: 0 },
  },
  'RevolvedSolid (part turn)': {
    make: () =>
      new RevolvedSolid(
        [new Line(v(1, 0, 0), v(3, 0, 0)), new Line(v(3, 0, 0), v(3, 0, 2)), new Line(v(3, 0, 2), v(1, 0, 2)), new Line(v(1, 0, 2), v(1, 0, 0))],
        v(0, 0, 0),
        v(0, 0, 1),
        { angle: PI / 2 },
      ),
    expected: { volume: (PI / 4) * 8 * 2, genus: 0 },
  },
  'RevolvedSolid (part turn to the axis)': {
    make: () => new RevolvedSolid([new Line(v(0, 0, 0), v(2, 0, 0)), new Line(v(2, 0, 0), v(0, 0, 3))], v(0, 0, 0), v(0, 0, 1), { angle: PI }),
    expected: { volume: (PI * 4 * 3) / 6, genus: 0 },
  },
  SweptSolid: {
    make: () =>
      new SweptSolid(
        { outer: [CircularArc.circle(v(0, 0, 0), 0.5, v(0, 1, 0))] },
        new BezierCurve([v(0, 0, 0), v(0, 4, 0), v(4, 6, 1), v(7, 6, 3)]),
      ),
    expected: { genus: 0, numeric: true },
  },
  PipeSolid: { make: () => new PipeSolid(new Helix(tilted, 4, 3, 1.5), 0.5), expected: { genus: 0, numeric: true } },
  'PipeSolid (hollow)': { make: () => new PipeSolid(new CircularArc(Frame3.WORLD, 5, 0, PI), 1, 0.5), expected: { volume: PI * 0.75 * PI * 5, genus: 1, numeric: true } },
  LoftedSolid: {
    make: () =>
      new LoftedSolid([
        square(4, 0),
        square(3, 2).map((c) => c.transformed(Transform3.translate(v(0.5, 0.5, 0)))),
        square(2, 4).map((c) => c.transformed(Transform3.translate(v(1, 1, 0)))),
      ]),
    expected: { genus: 0 },
  },
};
