import {
  ExtrusionSurface,
  Frame3,
  LoftSurface,
  RevolutionSurface,
  SweepSurface,
  Transform3,
  Vector3,
  type ISurface,
  type SurfaceParameter,
} from 'meercad-surfaces';
import { CircularArc, Line, type ICurve } from 'meercad-curves';
import { checkedWire, planarFace, ringOfFaces, type DirectedEdge } from '../topology/build.js';
import { Coedge, Edge, Face, Loop, Shell, Vertex } from '../topology/Topology.js';
import { Solid } from './Solid.js';

const TURN = 2 * Math.PI;

/** A profile: one outer wire and any hole wires, all closed chains of curves in one plane. */
export interface Profile {
  readonly outer: readonly ICurve[];
  readonly holes?: readonly (readonly ICurve[])[];
}

/** The area of a wire about an axis, positive if it runs counter-clockwise seen from the axis's tip. */
function wireArea(wire: readonly ICurve[], axis: Vector3): number {
  const ring = wire.flatMap((c) => {
    const { start, end } = c.domain;
    return Array.from({ length: 16 }, (_, i) => c.pointAt(start + ((end - start) * i) / 16));
  });
  let sum = Vector3.ZERO;
  for (let i = 0; i < ring.length; i++) {
    sum = sum.add(ring[i]!.cross(ring[(i + 1) % ring.length]!));
  }
  return sum.dot(axis) / 2;
}

function reversedWire(wire: readonly ICurve[]): ICurve[] {
  return [...wire].reverse().map((c) => c.reversed());
}

function profileNormal(wire: readonly ICurve[]): Vector3 {
  const ring = wire.flatMap((c) => {
    const { start, end } = c.domain;
    return Array.from({ length: 16 }, (_, i) => c.pointAt(start + ((end - start) * i) / 16));
  });
  let sum = Vector3.ZERO;
  for (let i = 0; i < ring.length; i++) {
    sum = sum.add(ring[i]!.cross(ring[(i + 1) % ring.length]!));
  }
  if (sum.length === 0) {
    throw new RangeError('A profile must enclose an area.');
  }
  return sum.normalized();
}

/** Outer wire counter-clockwise and holes clockwise, about the given axis. */
function orientedProfile(profile: Profile, axis: Vector3): { outer: ICurve[]; holes: ICurve[][] } {
  checkedWire(profile.outer);
  const outer = wireArea(profile.outer, axis) > 0 ? [...profile.outer] : reversedWire(profile.outer);
  const holes = (profile.holes ?? []).map((wire) => {
    checkedWire(wire);
    return wireArea(wire, axis) < 0 ? [...wire] : reversedWire(wire);
  });
  return { outer, holes };
}

const directed = (edges: readonly Edge[], forward: boolean): DirectedEdge[] => {
  const list = edges.map((edge) => ({ edge, forward }));
  return forward ? list : list.reverse();
};

/**
 * A solid between two caps: one surface per curve of the wires, running `u` along the curve and `v`
 * from one cap to the other. Each cap is flat, so the wires at both ends must each lie in a plane.
 */
function cappedShell(
  wires: readonly (readonly ICurve[])[],
  surfaceOf: (curve: ICurve, wire: number, index: number) => ISurface,
  topOf: (surface: ISurface, curve: ICurve) => ICurve,
  railOf: (surface: ISurface) => ICurve,
  bottomOf: (surface: ISurface, curve: ICurve) => ICurve = (_s, c) => c,
): Shell {
  const rings = wires.map((wire, w) => {
    const surfaces = wire.map((c, i) => surfaceOf(c, w, i));
    return ringOfFaces(
      surfaces,
      (i) => bottomOf(surfaces[i]!, wire[i]!),
      (i) => topOf(surfaces[i]!, wire[i]!),
      (i) => railOf(surfaces[i]!),
    );
  });
  const bottom = planarFace(directed(rings[0]!.bottom, false), rings.slice(1).map((r) => directed(r.bottom, false)));
  const top = planarFace(directed(rings[0]!.top, true), rings.slice(1).map((r) => directed(r.top, true)));
  return new Shell([...rings.flatMap((r) => r.faces), bottom, top]);
}

/** A planar profile moved along a straight vector. */
export class ExtrudedSolid extends Solid {
  constructor(
    readonly profile: Profile,
    readonly vector: Vector3,
  ) {
    if (vector.lengthSquared === 0) {
      throw new RangeError('The extrusion vector must not be zero.');
    }
    checkedWire(profile.outer);
    const normal = profileNormal(profile.outer);
    if (Math.abs(normal.dot(vector.normalized())) < 1e-9) {
      throw new RangeError('The extrusion vector must not lie in the plane of the profile.');
    }
    const axis = normal.dot(vector) > 0 ? normal : normal.negate();
    const { outer, holes } = orientedProfile(profile, axis);
    const shell = cappedShell(
      [outer, ...holes],
      (c) => new ExtrusionSurface(c, vector),
      (_s, c) => c.transformed(Transform3.translate(vector)),
      (s) => new Line(s.pointAt(s.domainU.start, 0), s.pointAt(s.domainU.start, 1)),
    );
    super(Solid.outwards([shell]), 'ExtrudedSolid');
  }
}

/** A planar profile carried along a path, turning with it. The profile is taken as positioned at the path's start. */
export class SweptSolid extends Solid {
  constructor(profile: Profile, path: ICurve, type = 'SweptSolid') {
    checkedWire(profile.outer);
    const tangent = path.tangentAt(path.domain.start);
    const normal = profileNormal(profile.outer);
    if (Math.abs(normal.dot(tangent)) < 1e-6) {
      throw new RangeError('The path must leave the plane of the profile at its start.');
    }
    const axis = normal.dot(tangent) > 0 ? normal : normal.negate();
    const { outer, holes } = orientedProfile(profile, axis);
    const shell = cappedShell(
      [outer, ...holes],
      (c) => new SweepSurface(c, path),
      (s) => s.isoCurveV(s.domainV.end),
      (s) => s.isoCurveU(s.domainU.start),
    );
    super(Solid.outwards([shell]), type);
  }
}

/** A round bar along a path, optionally hollow. The ends are flat and perpendicular to the path. */
export class PipeSolid extends SweptSolid {
  constructor(path: ICurve, radius: number, innerRadius = 0) {
    if (!(radius > 0) || !(innerRadius >= 0) || innerRadius >= radius) {
      throw new RangeError('Pipe radii must be positive, with the inner radius below the outer one.');
    }
    const start = path.startPoint;
    const tangent = path.tangentAt(path.domain.start);
    const frame = Frame3.fromNormal(start, tangent);
    const circle = (r: number) => new CircularArc(frame, r, 0, TURN);
    super({ outer: [circle(radius)], holes: innerRadius > 0 ? [[circle(innerRadius)]] : [] }, path, 'PipeSolid');
  }
}

export interface LoftOptions {
  /** Where each section lies in the loft's `v`, increasing. */
  readonly parameters?: readonly number[];
}

/**
 * A solid through a series of planar sections, with flat caps at both ends. Every section has the
 * same number of curves, each starting at corresponding points and running the same way.
 */
export class LoftedSolid extends Solid {
  constructor(sections: readonly (readonly ICurve[])[], options: LoftOptions = {}) {
    if (sections.length < 2) {
      throw new RangeError('A lofted solid needs at least two sections.');
    }
    const count = sections[0]!.length;
    if (sections.some((s) => s.length !== count)) {
      throw new RangeError('Every section must have the same number of curves.');
    }
    sections.forEach((s) => checkedWire(s));
    const shell = cappedShell(
      [sections[0]!],
      (_c, _w, i) => new LoftSurface(sections.map((s) => s[i]!), options.parameters ? { parameters: options.parameters } : {}),
      (s) => s.isoCurveV(s.domainV.end),
      (s) => s.isoCurveU(s.domainU.start),
      (s) => s.isoCurveV(s.domainV.start),
    );
    super(Solid.outwards([shell]), 'LoftedSolid');
  }
}

export interface RevolveOptions {
  /** Angle of the turn, in radians. Default: a full turn. */
  readonly angle?: number;
}

/**
 * A profile turned about an axis. The profile lies in a plane through the axis, on one side of it.
 *
 * It is a chain of curves. If open, its two ends must both lie on the axis. If closed, it mustn't touch
 * the axis, unless a whole curve of it lies along the axis, in which case that curve is left out.
 */
export class RevolvedSolid extends Solid {
  constructor(profile: readonly ICurve[], axisOrigin: Vector3, axisDirection: Vector3, options: RevolveOptions = {}) {
    super(Solid.outwards([revolvedShell(profile, axisOrigin, axisDirection, options.angle ?? TURN)]), 'RevolvedSolid');
  }
}

function revolvedShell(profile: readonly ICurve[], axisOrigin: Vector3, axisDirection: Vector3, angle: number): Shell {
  if (profile.length === 0) {
    throw new RangeError('A profile needs at least one curve.');
  }
  if (!(angle > 0) || angle > TURN + 1e-12) {
    throw new RangeError('The angle of a turn must be above zero and at most a full turn.');
  }
  if (axisDirection.lengthSquared === 0) {
    throw new RangeError('The axis direction must not be zero.');
  }
  const axis = axisDirection.normalized();
  const size = Math.max(...profile.map((c) => c.boundingBox().diagonal), 1e-300);
  const tolerance = 1e-7 * size;
  const radial = (p: Vector3) => {
    const r = p.sub(axisOrigin);
    return r.sub(axis.scale(r.dot(axis)));
  };
  const onAxis = (p: Vector3) => radial(p).length <= tolerance;
  const isAxial = (c: ICurve) => onAxis(c.startPoint) && onAxis(c.endPoint) && onAxis(c.pointAt((c.domain.start + c.domain.end) / 2));
  const full = Math.abs(angle - TURN) <= 1e-9;
  const closedInput = profile[0]!.startPoint.distanceTo(profile[profile.length - 1]!.endPoint) <= tolerance;
  // Rotate a closed chain so that it starts just after any curve along the axis, which is then left out.
  let chain = [...profile];
  const axial = chain.findIndex(isAxial);
  if (axial >= 0) {
    if (!closedInput) {
      throw new RangeError('Only a closed profile may include a curve along the axis.');
    }
    chain = [...chain.slice(axial + 1), ...chain.slice(0, axial)];
    if (chain.some(isAxial)) {
      throw new RangeError('A profile may include only one curve along the axis.');
    }
  }
  for (let i = 0; i + 1 < chain.length; i++) {
    if (chain[i]!.endPoint.distanceTo(chain[i + 1]!.startPoint) > tolerance) {
      throw new RangeError('A profile must be a chain of curves, each starting where the last one ends.');
    }
  }
  const startsOnAxis = onAxis(chain[0]!.startPoint);
  const endsOnAxis = onAxis(chain[chain.length - 1]!.endPoint);
  const ring = axial < 0 && closedInput;
  if (!ring && !(startsOnAxis && endsOnAxis)) {
    throw new RangeError('An open profile must start and end on the axis.');
  }
  if (ring && chain.some((c) => onAxis(c.startPoint))) {
    throw new RangeError('A closed profile must not touch the axis, except along one whole curve.');
  }
  const uEnd = angle;
  const rotate = (p: Vector3, a: number) => {
    const r = radial(p);
    return p.sub(r).addScaled(r, Math.cos(a)).addScaled(axis.cross(r), Math.sin(a));
  };
  const n = chain.length;
  // Profile joints, at the start and end of the turn.
  const jointCount = ring ? n : n + 1;
  const jointPoint = (j: number) => (j < n ? chain[j]!.startPoint : chain[n - 1]!.endPoint);
  const startVertices = Array.from({ length: jointCount }, (_, j) => new Vertex(jointPoint(j)));
  const endVertices = full
    ? startVertices
    : startVertices.map((v, j) => (onAxis(jointPoint(j)) ? v : new Vertex(rotate(jointPoint(j), uEnd))));
  const vertexAt = (list: readonly Vertex[], j: number) => list[ring ? j % n : j]!;
  // A ring at each joint: a circle or arc, or nothing where the joint is on the axis.
  const rings = Array.from({ length: jointCount }, (_, j) => {
    const p = jointPoint(j);
    if (onAxis(p)) {
      return Edge.degenerate(vertexAt(startVertices, j));
    }
    const r = radial(p);
    const centre = p.sub(r);
    const frame = Frame3.fromAxes(centre, r.normalized(), axis.cross(r).normalized(), axis);
    return Edge.of(new CircularArc(frame, r.length, 0, uEnd), vertexAt(startVertices, j), vertexAt(endVertices, j));
  });
  const ringAt = (j: number) => rings[ring ? j % n : j]!;
  // The meridians: where each curve of the profile lies at the start and end of the turn.
  const startMeridians = chain.map((c, i) => Edge.of(c, vertexAt(startVertices, i), vertexAt(startVertices, i + 1)));
  const endMeridians = full
    ? startMeridians
    : chain.map((c, i) => {
        const moved = new RevolutionSurface(c, axisOrigin, axis, 0, uEnd).isoCurveU(uEnd);
        return Edge.of(moved, vertexAt(endVertices, i), vertexAt(endVertices, i + 1));
      });
  const faces = chain.map((c, i) => {
    const surface = new RevolutionSurface(c, axisOrigin, axis, 0, uEnd);
    const { start: v0, end: v1 } = surface.domainV;
    const a: SurfaceParameter = { u: 0, v: v0 };
    const b: SurfaceParameter = { u: uEnd, v: v0 };
    const d: SurfaceParameter = { u: uEnd, v: v1 };
    const e: SurfaceParameter = { u: 0, v: v1 };
    return new Face(
      surface,
      new Loop([
        Coedge.straight(ringAt(i), true, a, b),
        new Coedge(endMeridians[i]!, true, [endMeridians[i]!.t0, endMeridians[i]!.t1], [b, d]),
        Coedge.straight(ringAt(i + 1), false, d, e),
        new Coedge(startMeridians[i]!, false, [startMeridians[i]!.t0, startMeridians[i]!.t1], [a, e]),
      ]),
    );
  });
  if (full) {
    return new Shell(faces);
  }
  // Flat ends of a part turn, closed along the axis where the profile doesn't close itself.
  const close = (meridians: readonly Edge[], vertices: readonly Vertex[]) => {
    const list = meridians.map((edge) => ({ edge, forward: true }));
    if (!ring) {
      const [first, last] = [vertices[0]!, vertices[jointCount - 1]!];
      list.push({ edge: Edge.of(new Line(last.point, first.point), last, first), forward: true });
    }
    return list;
  };
  const startCap = close(startMeridians, startVertices);
  const endCapLoop = endMeridians.map((edge) => ({ edge, forward: false })).reverse();
  if (!ring) {
    // The same axis edge, run the opposite way, so the two caps join along it.
    endCapLoop.push({ edge: startCap[startCap.length - 1]!.edge, forward: false });
  }
  return new Shell([...faces, planarFace(startCap), planarFace(endCapLoop)]);
}

/** A round bar with hemispherical ends: `height` between the centres of the two ends. */
export class CapsuleSolid extends RevolvedSolid {
  constructor(frame: Frame3, radius: number, height: number) {
    if (!(radius > 0) || !(height > 0)) {
      throw new RangeError('Capsule sizes must be positive.');
    }
    // A half-plane through the axis, with its X along the frame's X and its Y along the axis.
    const halfPlane = (z: number) => Frame3.fromAxes(frame.toWorld(new Vector3(0, 0, z)), frame.xAxis, frame.zAxis, frame.yAxis.negate());
    const lower = new CircularArc(halfPlane(0), radius, -Math.PI / 2, 0);
    const wall = new Line(frame.toWorld(new Vector3(radius, 0, 0)), frame.toWorld(new Vector3(radius, 0, height)));
    const upper = new CircularArc(halfPlane(height), radius, 0, Math.PI / 2);
    super([lower, wall, upper], frame.origin, frame.zAxis);
  }
}
