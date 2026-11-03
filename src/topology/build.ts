import { Frame3, PlaneSurface, Vector3, type ISurface, type SurfaceParameter } from 'meercad-surfaces';
import type { ICurve } from 'meercad-curves';
import { invertNear } from '../algorithms/integrate.js';
import { Coedge, Edge, Face, Loop, Vertex } from './Topology.js';

/** An edge and the direction in which a loop runs along it. */
export interface DirectedEdge {
  readonly edge: Edge;
  readonly forward: boolean;
}

/** A use of an edge whose table comes from sampling it and finding each point on the surface. */
export function projectedCoedge(surface: ISurface, edge: Edge, forward: boolean, start?: SurfaceParameter, samples = 48): Coedge {
  const ts = Array.from({ length: samples + 1 }, (_, i) => edge.t0 + ((edge.t1 - edge.t0) * i) / samples);
  const uvs: SurfaceParameter[] = [];
  let guess = start ?? undefined;
  for (const t of ts) {
    const p = edge.pointAt(t);
    const q = guess ? invertNear(surface, p, guess) : surface.closestPoint(p);
    guess = { u: q.u, v: q.v };
    uvs.push(guess);
  }
  return new Coedge(edge, forward, ts, uvs);
}

/**
 * A plane face around loops of directed edges, whose plane is found from the edges. The side the
 * plane faces is chosen to make the outer loop counter-clockwise. Holes must run the other way.
 */
export function planarFace(outer: readonly DirectedEdge[], holes: readonly (readonly DirectedEdge[])[] = [], hintNormal?: Vector3): Face {
  const samples = (loop: readonly DirectedEdge[]) =>
    loop.flatMap(({ edge, forward }) => {
      const list = Array.from({ length: 12 }, (_, i) => edge.pointAt(edge.t0 + ((edge.t1 - edge.t0) * (forward ? i : 12 - i)) / 12));
      return list;
    });
  const ring = samples(outer);
  // Newell's method: its direction is the one the loop runs counter-clockwise about.
  let normal = Vector3.ZERO;
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i]!, ring[(i + 1) % ring.length]!];
    normal = normal.add(a.cross(b));
  }
  if (normal.length === 0) {
    if (!hintNormal) {
      throw new RangeError('A planar face needs a loop that encloses an area.');
    }
    normal = hintNormal;
  }
  normal = normal.normalized();
  const origin = ring[0]!;
  const frame = Frame3.fromNormal(origin, normal);
  const all = [ring, ...holes.map(samples)].flat().map((p) => frame.toLocal(p));
  const size = Math.max(...all.map((p) => p.length), 1e-300);
  if (all.some((p) => Math.abs(p.z) > 1e-6 * size)) {
    throw new RangeError('The edges of a planar face must lie in one plane.');
  }
  const pad = 1e-3 * size;
  const surface = new PlaneSurface(frame, {
    u: [Math.min(...all.map((p) => p.x)) - pad, Math.max(...all.map((p) => p.x)) + pad],
    v: [Math.min(...all.map((p) => p.y)) - pad, Math.max(...all.map((p) => p.y)) + pad],
  });
  const loop = (list: readonly DirectedEdge[]) => new Loop(list.map(({ edge, forward }) => projectedCoedge(surface, edge, forward, { u: 0, v: 0 })));
  return new Face(surface, loop(outer), holes.map(loop));
}

/**
 * Side faces joining two wires: the surfaces run `u` along each curve of the wire and `v` across. Each
 * surface gets its bottom edge from `bottom`, top from `top`, and shared `rail` edges at its sides.
 */
export interface RingFaces {
  readonly faces: Face[];
  /** The bottom wire's edges, in order, running along `u`. */
  readonly bottom: Edge[];
  /** The top wire's edges, in order, running along `u`. */
  readonly top: Edge[];
}

/** A wire of curves, joined end to end into a cycle. */
export function checkedWire(curves: readonly ICurve[], tolerance = 1e-7): void {
  if (curves.length === 0) {
    throw new RangeError('A profile needs at least one curve.');
  }
  curves.forEach((c, i) => {
    const next = curves[(i + 1) % curves.length]!;
    const size = Math.max(c.boundingBox().diagonal, 1);
    if (c.endPoint.distanceTo(next.startPoint) > tolerance * size) {
      throw new RangeError('A profile must be a closed chain of curves, each starting where the last one ends.');
    }
  });
}

/**
 * Builds side faces between a bottom and a top wire, given one surface per curve of the wire. Vertices
 * and rails are shared between neighbouring faces, including around the wire's closing joint.
 */
export function ringOfFaces(
  surfaces: readonly ISurface[],
  bottomCurve: (i: number) => ICurve,
  topCurve: (i: number) => ICurve,
  railCurve: (i: number) => ICurve,
): RingFaces {
  const n = surfaces.length;
  const lowVertices = surfaces.map((_, i) => new Vertex(bottomCurve(i).startPoint));
  const highVertices = surfaces.map((_, i) => new Vertex(topCurve(i).startPoint));
  const rails = surfaces.map((_, i) => Edge.of(railCurve(i), lowVertices[i]!, highVertices[i]!));
  const bottom = surfaces.map((_, i) => Edge.of(bottomCurve(i), lowVertices[i]!, lowVertices[(i + 1) % n]!));
  const top = surfaces.map((_, i) => Edge.of(topCurve(i), highVertices[i]!, highVertices[(i + 1) % n]!));
  const faces = surfaces.map((s, i) => {
    const { start: u0, end: u1 } = s.domainU;
    const { start: v0, end: v1 } = s.domainV;
    const lowEdge = new Coedge(bottom[i]!, true, [bottom[i]!.t0, bottom[i]!.t1], [{ u: u0, v: v0 }, { u: u1, v: v0 }]);
    const highEdge = new Coedge(top[i]!, false, [top[i]!.t0, top[i]!.t1], [{ u: u0, v: v1 }, { u: u1, v: v1 }]);
    const nextRail = rails[(i + 1) % n]!;
    const right = Coedge.straight(nextRail, true, { u: u1, v: v0 }, { u: u1, v: v1 });
    const left = Coedge.straight(rails[i]!, false, { u: u0, v: v1 }, { u: u0, v: v0 });
    return new Face(s, new Loop([lowEdge, right, highEdge, left]));
  });
  return { faces, bottom, top };
}
