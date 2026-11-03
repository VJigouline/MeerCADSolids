import {
  ConeSurface,
  CylinderSurface,
  EllipsoidSurface,
  Frame3,
  PlaneSurface,
  SphereSurface,
  TorusSurface,
  Vector3,
  type ISurface,
  type SurfaceParameter,
} from 'meercad-surfaces';
import { CircularArc, EllipticalArc, Line } from 'meercad-curves';
import { planarFace, projectedCoedge } from '../topology/build.js';
import { Coedge, Edge, Face, Loop, Shell, Vertex } from '../topology/Topology.js';
import { Solid } from './Solid.js';

const TURN = 2 * Math.PI;

function positive(value: number, name: string): void {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be positive.`);
  }
}

/** A plane face around a list of 3D points, counter-clockwise seen from outside. */
export function polygonFace(points: readonly Vertex[], edge: (a: Vertex, b: Vertex) => { edge: Edge; forward: boolean }): Face {
  const list = points.map((p, i) => edge(p, points[(i + 1) % points.length]!));
  return planarFace(list);
}

/** Shares one straight edge between the two faces that use it. */
export function edgeTable(): (a: Vertex, b: Vertex) => { edge: Edge; forward: boolean } {
  const table = new Map<string, Edge>();
  return (a, b) => {
    const forwardKey = `${a.id}/${b.id}`;
    const backwardKey = `${b.id}/${a.id}`;
    const existing = table.get(backwardKey);
    if (existing) {
      return { edge: existing, forward: false };
    }
    if (table.has(forwardKey)) {
      throw new RangeError('A polyhedron must use each edge once in each direction.');
    }
    const edge = Edge.of(new Line(a.point, b.point), a, b);
    table.set(forwardKey, edge);
    return { edge, forward: true };
  };
}

/** A closed solid with flat polygonal faces. Each face lists its corners counter-clockwise from outside. */
export class PolyhedronSolid extends Solid {
  constructor(points: readonly Vector3[], faces: readonly (readonly number[])[], type = 'PolyhedronSolid') {
    if (faces.length < 4) {
      throw new RangeError('A polyhedron needs at least four faces.');
    }
    for (const face of faces) {
      if (face.length < 3 || face.some((i) => !Number.isInteger(i) || i < 0 || i >= points.length)) {
        throw new RangeError('Each polyhedron face needs at least three valid corner indices.');
      }
    }
    const vertices = points.map((p) => new Vertex(p));
    const edge = edgeTable();
    super([new Shell(faces.map((face) => polygonFace(face.map((i) => vertices[i]!), edge)))], type);
    if (!this.isClosed) {
      throw new RangeError('A polyhedron must use each edge exactly twice, once in each direction.');
    }
    if (this.signedVolume() <= 0) {
      throw new RangeError('Polyhedron faces must list their corners counter-clockwise from outside.');
    }
  }

  /** A regular tetrahedron with the given edge length, centred on the origin. */
  static tetrahedron(edge: number): PolyhedronSolid {
    positive(edge, 'Edge length');
    const s = edge / (2 * Math.SQRT2);
    return new PolyhedronSolid(
      [new Vector3(s, s, s), new Vector3(s, -s, -s), new Vector3(-s, s, -s), new Vector3(-s, -s, s)],
      [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]],
      'TetrahedronSolid',
    );
  }

  /** A regular octahedron with the given edge length, centred on the origin. */
  static octahedron(edge: number): PolyhedronSolid {
    positive(edge, 'Edge length');
    const s = edge / Math.SQRT2;
    return new PolyhedronSolid(
      [new Vector3(s, 0, 0), new Vector3(-s, 0, 0), new Vector3(0, s, 0), new Vector3(0, -s, 0), new Vector3(0, 0, s), new Vector3(0, 0, -s)],
      [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]],
      'OctahedronSolid',
    );
  }

  /** A regular icosahedron with the given edge length, centred on the origin. */
  static icosahedron(edge: number): PolyhedronSolid {
    positive(edge, 'Edge length');
    const phi = (1 + Math.sqrt(5)) / 2;
    const s = edge / 2;
    const points = [
      [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
      [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
      [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
    ].map(([x, y, z]) => new Vector3(x! * s, y! * s, z! * s));
    return new PolyhedronSolid(
      points,
      [
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
      ],
      'IcosahedronSolid',
    );
  }

  /** A regular dodecahedron with the given edge length, centred on the origin. */
  static dodecahedron(edge: number): PolyhedronSolid {
    positive(edge, 'Edge length');
    const phi = (1 + Math.sqrt(5)) / 2;
    const s = edge * (phi / 2);
    const a = 1 / phi;
    const points = [
      [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
      [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
      [0, a, phi], [0, a, -phi], [0, -a, phi], [0, -a, -phi],
      [a, phi, 0], [a, -phi, 0], [-a, phi, 0], [-a, -phi, 0],
      [phi, 0, a], [phi, 0, -a], [-phi, 0, a], [-phi, 0, -a],
    ].map(([x, y, z]) => new Vector3(x! * s, y! * s, z! * s));
    return new PolyhedronSolid(
      points,
      [
        [0, 8, 10, 2, 16], [0, 16, 17, 1, 12], [0, 12, 14, 4, 8],
        [1, 17, 3, 11, 9], [1, 9, 5, 14, 12], [2, 10, 6, 15, 13],
        [2, 13, 3, 17, 16], [3, 13, 15, 7, 11], [4, 14, 5, 19, 18],
        [4, 18, 6, 10, 8], [5, 9, 11, 7, 19], [6, 18, 19, 7, 15],
      ],
      'DodecahedronSolid',
    );
  }
}

function boxPoints(frame: Frame3, x: number, y: number, z: number): Vector3[] {
  return [
    new Vector3(0, 0, 0), new Vector3(x, 0, 0), new Vector3(x, y, 0), new Vector3(0, y, 0),
    new Vector3(0, 0, z), new Vector3(x, 0, z), new Vector3(x, y, z), new Vector3(0, y, z),
  ].map((p) => frame.toWorld(p));
}

const BOX_FACES = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];

/** A box with one corner at the frame's origin, extending along its positive axes. */
export class BoxSolid extends PolyhedronSolid {
  constructor(
    readonly frame: Frame3,
    readonly sizeX: number,
    readonly sizeY: number,
    readonly sizeZ: number,
  ) {
    positive(sizeX, 'Size X');
    positive(sizeY, 'Size Y');
    positive(sizeZ, 'Size Z');
    super(boxPoints(frame, sizeX, sizeY, sizeZ), BOX_FACES, 'BoxSolid');
  }

  /** A box centred on a point, with its sides along the world axes. */
  static centred(centre: Vector3, sizeX: number, sizeY: number, sizeZ: number): BoxSolid {
    return new BoxSolid(Frame3.fromNormal(centre.sub(new Vector3(sizeX / 2, sizeY / 2, sizeZ / 2))), sizeX, sizeY, sizeZ);
  }
}

/** A box whose top is shrunk along X, to `topX`: a ramp if it is zero. */
export class WedgeSolid extends PolyhedronSolid {
  constructor(frame: Frame3, sizeX: number, sizeY: number, sizeZ: number, topX = 0) {
    positive(sizeX, 'Size X');
    positive(sizeY, 'Size Y');
    positive(sizeZ, 'Size Z');
    if (!(topX >= 0) || topX > sizeX) {
      throw new RangeError('The top of a wedge must be between zero and the base size.');
    }
    const points = [
      new Vector3(0, 0, 0), new Vector3(sizeX, 0, 0), new Vector3(sizeX, sizeY, 0), new Vector3(0, sizeY, 0),
      new Vector3(0, 0, sizeZ), new Vector3(topX, 0, sizeZ), new Vector3(topX, sizeY, sizeZ), new Vector3(0, sizeY, sizeZ),
    ].map((p) => frame.toWorld(p));
    if (topX === 0) {
      super(
        [points[0]!, points[1]!, points[2]!, points[3]!, points[4]!, points[7]!],
        [[0, 3, 2, 1], [0, 1, 4], [1, 2, 5, 4], [2, 3, 5], [3, 0, 4, 5]],
        'WedgeSolid',
      );
    } else {
      super(points, BOX_FACES, 'WedgeSolid');
    }
  }
}

/** A regular `sides`-sided pyramid on the frame's XY plane, with its apex on +Z. `topRadius` above 0 cuts it flat. */
export class PyramidSolid extends PolyhedronSolid {
  constructor(frame: Frame3, sides: number, radius: number, height: number, topRadius = 0) {
    if (!Number.isInteger(sides) || sides < 3) {
      throw new RangeError('A pyramid needs at least three sides.');
    }
    positive(radius, 'Radius');
    positive(height, 'Height');
    if (!(topRadius >= 0)) {
      throw new RangeError('The top radius must not be negative.');
    }
    const ring = (r: number, z: number) =>
      Array.from({ length: sides }, (_, i) => frame.toWorld(new Vector3(r * Math.cos((TURN * i) / sides), r * Math.sin((TURN * i) / sides), z)));
    const base = ring(radius, 0);
    const reversedBase = Array.from({ length: sides }, (_, i) => sides - 1 - i);
    if (topRadius === 0) {
      const sidesList = Array.from({ length: sides }, (_, i) => [i, (i + 1) % sides, sides]);
      super([...base, frame.toWorld(new Vector3(0, 0, height))], [reversedBase, ...sidesList], 'PyramidSolid');
    } else {
      const sidesList = Array.from({ length: sides }, (_, i) => [i, (i + 1) % sides, sides + ((i + 1) % sides), sides + i]);
      const topFace = Array.from({ length: sides }, (_, i) => sides + i);
      super([...base, ...ring(topRadius, height)], [reversedBase, topFace, ...sidesList], 'PyramidSolid');
    }
  }
}

/** A regular `sides`-sided prism on the frame's XY plane, along +Z. */
export class RegularPrismSolid extends PolyhedronSolid {
  constructor(frame: Frame3, sides: number, radius: number, height: number) {
    if (!Number.isInteger(sides) || sides < 3) {
      throw new RangeError('A prism needs at least three sides.');
    }
    positive(radius, 'Radius');
    positive(height, 'Height');
    const ring = (z: number) =>
      Array.from({ length: sides }, (_, i) => frame.toWorld(new Vector3(radius * Math.cos((TURN * i) / sides), radius * Math.sin((TURN * i) / sides), z)));
    const reversedBase = Array.from({ length: sides }, (_, i) => sides - 1 - i);
    const topFace = Array.from({ length: sides }, (_, i) => sides + i);
    const sidesList = Array.from({ length: sides }, (_, i) => [i, (i + 1) % sides, sides + ((i + 1) % sides), sides + i]);
    super([...ring(0), ...ring(height)], [reversedBase, topFace, ...sidesList], 'RegularPrismSolid');
  }
}

/** A closed-off round cap: a plane disc around a circle of the given frame. */
function discFace(frame: Frame3, outward: Vector3, rim: Edge, rimForwardInFace: boolean, hole?: { edge: Edge; forward: boolean }): Face {
  const planeFrame = Frame3.fromNormal(frame.origin, outward);
  const radius = rim.curve!.boundingBox().diagonal;
  const surface = new PlaneSurface(planeFrame, { u: [-radius, radius], v: [-radius, radius] });
  const outer = new Loop([projectedCoedge(surface, rim, rimForwardInFace, undefined, 64)]);
  const holes = hole ? [new Loop([projectedCoedge(surface, hole.edge, hole.forward, undefined, 64)])] : [];
  return new Face(surface, outer, holes);
}

/** One side of a turned solid: a full-turn surface with a seam, between two circles or poles. */
function sideOfTurn(
  surface: ISurface,
  seam: Edge,
  low: Edge,
  high: Edge,
): Face {
  const { start: u0, end: u1 } = surface.domainU;
  const { start: v0, end: v1 } = surface.domainV;
  const a: SurfaceParameter = { u: u0, v: v0 };
  const b: SurfaceParameter = { u: u1, v: v0 };
  const c: SurfaceParameter = { u: u1, v: v1 };
  const d: SurfaceParameter = { u: u0, v: v1 };
  return new Face(
    surface,
    new Loop([Coedge.straight(low, true, a, b), Coedge.straight(seam, true, b, c), Coedge.straight(high, false, c, d), Coedge.straight(seam, false, d, a)]),
  );
}

/** A straight round cylinder, on the frame's XY plane and along its +Z. */
export class CylinderSolid extends Solid {
  constructor(
    readonly frame: Frame3,
    readonly radius: number,
    readonly height: number,
  ) {
    positive(radius, 'Radius');
    positive(height, 'Height');
    const side = new CylinderSurface(frame, radius, { v: [0, height] });
    const lowPoint = new Vertex(side.pointAt(0, 0));
    const highPoint = new Vertex(side.pointAt(0, height));
    const circle = (z: number) => new CircularArc(Frame3.fromAxes(frame.toWorld(new Vector3(0, 0, z)), frame.xAxis, frame.yAxis, frame.zAxis), radius, 0, TURN);
    const low = Edge.of(circle(0), lowPoint, lowPoint);
    const high = Edge.of(circle(height), highPoint, highPoint);
    const seam = Edge.of(new Line(lowPoint.point, highPoint.point), lowPoint, highPoint);
    const axis = frame.zAxis;
    const faces = [
      sideOfTurn(side, seam, low, high),
      discFace(Frame3.fromAxes(frame.origin, frame.xAxis, frame.yAxis, frame.zAxis), axis.negate(), low, false),
      discFace(Frame3.fromAxes(highPoint.point.sub(frame.xAxis.scale(radius)), frame.xAxis, frame.yAxis, frame.zAxis), axis, high, true),
    ];
    super([new Shell(faces)], 'CylinderSolid');
  }
}

/** A cylinder with a coaxial hole through it. */
export class TubeSolid extends Solid {
  constructor(frame: Frame3, outerRadius: number, innerRadius: number, height: number) {
    positive(outerRadius, 'Outer radius');
    positive(innerRadius, 'Inner radius');
    positive(height, 'Height');
    if (innerRadius >= outerRadius) {
      throw new RangeError('The inner radius must be below the outer radius.');
    }
    const wall = (radius: number, inward: boolean) => {
      const base = new CylinderSurface(frame, radius, { v: [0, height] });
      const surface = inward ? base.reversed() : base;
      const low = new Vertex(surface.pointAt(0, 0));
      const high = new Vertex(surface.pointAt(0, height));
      const circle = (z: number) => {
        const f = Frame3.fromAxes(frame.toWorld(new Vector3(0, 0, z)), frame.xAxis, frame.yAxis, frame.zAxis);
        return inward ? new CircularArc(f, radius, 0, TURN).reversed() : new CircularArc(f, radius, 0, TURN);
      };
      const lowEdge = Edge.of(circle(0), low, low);
      const highEdge = Edge.of(circle(height), high, high);
      const seam = Edge.of(new Line(low.point, high.point), low, high);
      return { face: sideOfTurn(surface, seam, lowEdge, highEdge), lowEdge, highEdge };
    };
    const outer = wall(outerRadius, false);
    const inner = wall(innerRadius, true);
    const topOrigin = frame.toWorld(new Vector3(0, 0, height));
    const faces = [
      outer.face,
      inner.face,
      discFace(Frame3.fromAxes(frame.origin, frame.xAxis, frame.yAxis, frame.zAxis), frame.zAxis.negate(), outer.lowEdge, false, { edge: inner.lowEdge, forward: false }),
      discFace(Frame3.fromAxes(topOrigin, frame.xAxis, frame.yAxis, frame.zAxis), frame.zAxis, outer.highEdge, true, { edge: inner.highEdge, forward: true }),
    ];
    super([new Shell(faces)], 'TubeSolid');
  }
}

/**
 * A round cone, on the frame's XY plane and along its +Z, narrowing from `radius` at the base to
 * `topRadius` at `height`. Either radius may be zero, which makes an apex, but not both.
 */
export class ConeSolid extends Solid {
  constructor(
    readonly frame: Frame3,
    readonly radius: number,
    readonly topRadius: number,
    readonly height: number,
  ) {
    positive(height, 'Height');
    if (!(radius >= 0) || !(topRadius >= 0) || (radius === 0 && topRadius === 0)) {
      throw new RangeError('Cone radii must not be negative, and at least one must be positive.');
    }
    const semiAngle = Math.atan2(topRadius - radius, height);
    const side = new ConeSurface(frame, radius, semiAngle, { v: [0, height] });
    const lowPoint = new Vertex(side.pointAt(0, 0));
    const highPoint = new Vertex(side.pointAt(0, height));
    const seam = Edge.of(new Line(lowPoint.point, highPoint.point), lowPoint, highPoint);
    const ring = (r: number, z: number, at: Vertex) =>
      r > 0
        ? Edge.of(new CircularArc(Frame3.fromAxes(frame.toWorld(new Vector3(0, 0, z)), frame.xAxis, frame.yAxis, frame.zAxis), r, 0, TURN), at, at)
        : Edge.degenerate(at);
    const low = ring(radius, 0, lowPoint);
    const high = ring(topRadius, height, highPoint);
    const faces = [sideOfTurn(side, seam, low, high)];
    if (radius > 0) {
      faces.push(discFace(Frame3.fromAxes(frame.origin, frame.xAxis, frame.yAxis, frame.zAxis), frame.zAxis.negate(), low, false));
    }
    if (topRadius > 0) {
      faces.push(discFace(Frame3.fromAxes(frame.toWorld(new Vector3(0, 0, height)), frame.xAxis, frame.yAxis, frame.zAxis), frame.zAxis, high, true));
    }
    super([new Shell(faces)], 'ConeSolid');
  }
}

/** A closed surface with poles at the ends of `v`: one face, a seam and two degenerate edges. */
function polarFace(surface: ISurface, seamCurve: (from: Vertex, to: Vertex) => Edge): Face {
  const { start: v0, end: v1 } = surface.domainV;
  const south = new Vertex(surface.pointAt(0, v0));
  const north = new Vertex(surface.pointAt(0, v1));
  return sideOfTurn(surface, seamCurve(south, north), Edge.degenerate(south), Edge.degenerate(north));
}

/** A whole sphere. Its seam runs along the frame's +X half of the XZ plane. */
export class SphereSolid extends Solid {
  constructor(
    readonly frame: Frame3,
    readonly radius: number,
  ) {
    positive(radius, 'Radius');
    const surface = new SphereSurface(frame, radius);
    const meridian = new CircularArc(Frame3.fromAxes(frame.origin, frame.xAxis, frame.zAxis, frame.yAxis.negate()), radius, -Math.PI / 2, Math.PI / 2);
    super([new Shell([polarFace(surface, (a, b) => Edge.of(meridian, a, b))])], 'SphereSolid');
  }

  static centredAt(centre: Vector3, radius: number): SphereSolid {
    return new SphereSolid(Frame3.fromNormal(centre), radius);
  }
}

/** A whole ellipsoid, with semi-axes along the frame's axes. */
export class EllipsoidSolid extends Solid {
  constructor(frame: Frame3, radiusX: number, radiusY: number, radiusZ: number) {
    positive(radiusX, 'Radius X');
    positive(radiusY, 'Radius Y');
    positive(radiusZ, 'Radius Z');
    const surface = new EllipsoidSurface(frame, radiusX, radiusY, radiusZ);
    const meridian = new EllipticalArc(Frame3.fromAxes(frame.origin, frame.xAxis, frame.zAxis, frame.yAxis.negate()), radiusX, radiusZ, -Math.PI / 2, Math.PI / 2);
    super([new Shell([polarFace(surface, (a, b) => Edge.of(meridian, a, b))])], 'EllipsoidSolid');
  }
}

/** A whole ring torus around the frame's Z axis. */
export class TorusSolid extends Solid {
  constructor(
    readonly frame: Frame3,
    readonly majorRadius: number,
    readonly minorRadius: number,
  ) {
    positive(majorRadius, 'Major radius');
    positive(minorRadius, 'Minor radius');
    if (minorRadius >= majorRadius) {
      throw new RangeError('The minor radius must be below the major radius.');
    }
    const surface = new TorusSurface(frame, majorRadius, minorRadius);
    const corner = new Vertex(surface.pointAt(0, 0));
    const ring = Edge.of(
      new CircularArc(Frame3.fromAxes(frame.toWorld(new Vector3(0, 0, 0)), frame.xAxis, frame.yAxis, frame.zAxis), majorRadius + minorRadius, 0, TURN),
      corner,
      corner,
    );
    const tube = Edge.of(
      new CircularArc(Frame3.fromAxes(frame.toWorld(new Vector3(majorRadius, 0, 0)), frame.xAxis, frame.zAxis, frame.yAxis.negate()), minorRadius, 0, TURN),
      corner,
      corner,
    );
    const a: SurfaceParameter = { u: 0, v: 0 };
    const b: SurfaceParameter = { u: TURN, v: 0 };
    const c: SurfaceParameter = { u: TURN, v: TURN };
    const d: SurfaceParameter = { u: 0, v: TURN };
    const face = new Face(
      surface,
      new Loop([Coedge.straight(ring, true, a, b), Coedge.straight(tube, true, b, c), Coedge.straight(ring, false, c, d), Coedge.straight(tube, false, d, a)]),
    );
    super([new Shell([face])], 'TorusSolid');
  }
}

/** A sphere with a concentric spherical cavity: two shells, the inner one facing into the cavity. */
export class HollowSphereSolid extends Solid {
  constructor(frame: Frame3, outerRadius: number, innerRadius: number) {
    positive(outerRadius, 'Outer radius');
    positive(innerRadius, 'Inner radius');
    if (innerRadius >= outerRadius) {
      throw new RangeError('The inner radius must be below the outer radius.');
    }
    const meridian = (r: number) => new CircularArc(Frame3.fromAxes(frame.origin, frame.xAxis, frame.zAxis, frame.yAxis.negate()), r, -Math.PI / 2, Math.PI / 2);
    const outer = polarFace(new SphereSurface(frame, outerRadius), (a, b) => Edge.of(meridian(outerRadius), a, b));
    const inner = polarFace(new SphereSurface(frame, innerRadius).reversed(), (a, b) => Edge.of(meridian(innerRadius), a, b));
    super([new Shell([outer]), new Shell([inner])], 'HollowSphereSolid');
  }
}
