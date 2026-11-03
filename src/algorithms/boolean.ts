import { BoundingBox3, Vector3, type ISurface, type SurfaceParameter } from 'meercad-surfaces';
import { HermiteSpline, Line, Polyline, type ICurve } from 'meercad-curves';
import { signedArea, triangulate, type Point2 } from '../math/triangulate.js';
import type { BooleanOptions, ISolid } from '../solids/ISolid.js';
import { Coedge, Edge, Face, Loop, Shell, Vertex } from '../topology/Topology.js';
import { BooleanError } from './booleanError.js';
import { invertNear } from './integrate.js';
import { closestSolidPoint } from './queries.js';

export type BooleanKind = 'union' | 'intersection' | 'difference';

type UV = SurfaceParameter;

/** A point of an intersection curve, with its parameters on both faces. */
interface CutPoint {
  p: Vector3;
  a: UV;
  b: UV;
  /** True if a graph node must be made here: another cut ends or crosses at this point. */
  node?: boolean;
}

/** A curve where a face of one solid meets a face of the other, clipped to both. */
interface Cut {
  readonly faceA: Face;
  readonly faceB: Face;
  points: CutPoint[];
  closed: boolean;
  curve?: ICurve;
  /** The curve's parameter at each point, once it is built. */
  knots?: number[];
}

/** A length of boundary: part of an edge or of a cut, with parameters on the face using it. */
interface Piece {
  readonly curve: ICurve | undefined;
  readonly t0: number;
  readonly t1: number;
  /** Curve parameters, increasing, and the matching face parameters. */
  readonly ts: readonly number[];
  readonly uvs: readonly UV[];
  /** True if a loop keeping the face on its left runs from `t0` to `t1`. */
  readonly forward: boolean;
  /** True for a part of the face's original boundary, as opposed to a cut across it. */
  readonly boundary: boolean;
  readonly at?: Vector3;
}

function pieceUVs(piece: Piece): readonly UV[] {
  return piece.forward ? piece.uvs : [...piece.uvs].reverse();
}

interface Fragment {
  readonly face: Face;
  readonly outer: Piece[];
  readonly holes: Piece[][];
}

/** Levenberg-Marquardt on `E(t) - S(u, v) = 0`, limited to the edge's range. */
function solveEdgeSurface(edge: Edge, surface: ISurface, t0: number, uv: UV): { t: number; uv: UV; gap: number } {
  const curve = edge.curve!;
  const limitT = (x: number) => Math.min(edge.t1, Math.max(edge.t0, x));
  const { domainU: du, domainV: dv } = surface;
  const limitU = (x: number) => Math.min(du.end, Math.max(du.start, x));
  const limitV = (x: number) => Math.min(dv.end, Math.max(dv.start, x));
  let [t, u, v] = [t0, uv.u, uv.v];
  let f = curve.pointAt(t).sub(surface.pointAt(u, v));
  let cost = f.lengthSquared;
  for (let iter = 0; iter < 20 && cost > 0; iter++) {
    const c = curve.derivativeAt(t);
    const a = surface.derivativeAt(u, v, 1, 0).negate();
    const b = surface.derivativeAt(u, v, 0, 1).negate();
    const J = [c, a, b];
    const m = J.map((x) => J.map((y) => x.dot(y)));
    const trace = m[0]![0]! + m[1]![1]! + m[2]![2]!;
    const damp = 1e-12 * trace + 1e-300;
    const [p00, p11, p22] = [m[0]![0]! + damp, m[1]![1]! + damp, m[2]![2]! + damp];
    const [m01, m02, m12] = [m[0]![1]!, m[0]![2]!, m[1]![2]!];
    const [g0, g1, g2] = [-c.dot(f), -a.dot(f), -b.dot(f)];
    const det = p00 * (p11 * p22 - m12 * m12) - m01 * (m01 * p22 - m12 * m02) + m02 * (m01 * m12 - p11 * m02);
    if (det === 0 || !Number.isFinite(det)) {
      break;
    }
    const d0 = (g0 * (p11 * p22 - m12 * m12) - m01 * (g1 * p22 - m12 * g2) + m02 * (g1 * m12 - p11 * g2)) / det;
    const d1 = (p00 * (g1 * p22 - m12 * g2) - g0 * (m01 * p22 - m12 * m02) + m02 * (m01 * g2 - g1 * m02)) / det;
    const d2 = (p00 * (p11 * g2 - g1 * m12) - m01 * (m01 * g2 - g1 * m02) + g0 * (m01 * m12 - p11 * m02)) / det;
    let scale = 1;
    let moved = false;
    for (let k = 0; k < 6; k++) {
      const [nt, nu, nv] = [limitT(t + scale * d0), limitU(u + scale * d1), limitV(v + scale * d2)];
      const nf = curve.pointAt(nt).sub(surface.pointAt(nu, nv));
      if (nf.lengthSquared < cost) {
        [t, u, v, f, cost] = [nt, nu, nv, nf, nf.lengthSquared];
        moved = true;
        break;
      }
      scale /= 2;
    }
    if (!moved) {
      break;
    }
  }
  return { t, uv: { u, v }, gap: Math.sqrt(cost) };
}

function faceEdges(face: Face): Edge[] {
  return [...new Set(face.loops.flatMap((l) => l.coedges.map((c) => c.edge)))].filter((e) => !e.isDegenerate);
}

function lerpUV(a: UV, b: UV, s: number): UV {
  return { u: a.u + (b.u - a.u) * s, v: a.v + (b.v - a.v) * s };
}

/** The parameters at which a polyline, indexed from 0, crosses a polygon's sides. */
function crossings(path: readonly UV[], polygon: readonly UV[]): number[] {
  const result: number[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i]!, path[i + 1]!];
    const [rx, ry] = [b.u - a.u, b.v - a.v];
    for (let k = 0; k < polygon.length; k++) {
      const [c, d] = [polygon[k]!, polygon[(k + 1) % polygon.length]!];
      const [sx, sy] = [d.u - c.u, d.v - c.v];
      const denom = rx * sy - ry * sx;
      if (Math.abs(denom) <= 1e-14 * Math.hypot(rx, ry) * Math.hypot(sx, sy) || denom === 0) {
        continue;
      }
      const s = ((c.u - a.u) * sy - (c.v - a.v) * sx) / denom;
      const r = ((c.u - a.u) * ry - (c.v - a.v) * rx) / denom;
      if (s >= -1e-12 && s <= 1 + 1e-12 && r >= -1e-12 && r <= 1 + 1e-12) {
        result.push(i + Math.min(1, Math.max(0, s)));
      }
    }
  }
  return result;
}

class Engine {
  readonly cuts: Cut[] = [];
  /** Where each original edge must be split. */
  readonly edgeSplits = new Map<Edge, number[]>();

  constructor(
    readonly solidA: ISolid,
    readonly solidB: ISolid,
    readonly weld: number,
    readonly meshTolerance: number,
  ) {}

  private planeCut(fa: Face, fb: Face): CutPoint[][] {
    const na = fa.surface.planeNormal();
    const nb = fb.surface.planeNormal();
    if (!na || !nb) {
      return [];
    }
    const direction = na.cross(nb);
    if (direction.length <= 1e-9) {
      return [];
    }
    const pa = fa.surface.pointAt(fa.surface.domainU.start, fa.surface.domainV.start);
    const pb = fb.surface.pointAt(fb.surface.domainU.start, fb.surface.domainV.start);
    // The point of both planes nearest to a point in the middle of the faces.
    const middle = fa.boundingBox().center.lerp(fb.boundingBox().center, 0.5);
    const dir = direction.normalized();
    const da = pa.dot(na);
    const db = pb.dot(nb);
    const c = na.dot(nb);
    const denom = 1 - c * c;
    const offset = middle.sub(na.scale(na.dot(middle) - da)).sub(nb.scale(0));
    const off = nb.dot(offset) - db;
    // Move along the part of nb perpendicular to na, to reach the second plane while staying on the first.
    const onBoth = offset.sub(nb.sub(na.scale(c)).scale(off / denom));
    const reach = fa.boundingBox().diagonal + fb.boundingBox().diagonal + middle.distanceTo(onBoth);
    const point = (p: Vector3): CutPoint => ({
      p,
      a: invertNear(fa.surface, p, { u: fa.surface.domainU.start, v: fa.surface.domainV.start }),
      b: invertNear(fb.surface, p, { u: fb.surface.domainU.start, v: fb.surface.domainV.start }),
    });
    // Parameters on a plane patch stop at the patch, so stay within reach of both patches through the clip.
    const lineStart = onBoth.addScaled(dir, -reach);
    const lineEnd = onBoth.addScaled(dir, reach);
    return [this.clipLineToPatches(fa, fb, lineStart, lineEnd, point)];
  }

  /** Limits a straight line to the parts where it lies over both plane patches. */
  private clipLineToPatches(fa: Face, fb: Face, start: Vector3, end: Vector3, point: (p: Vector3) => CutPoint): CutPoint[] {
    const clip = (face: Face, range: [number, number]): [number, number] => {
      const s = face.surface;
      const origin = s.pointAt(s.domainU.start, s.domainV.start);
      const su = s.derivativeAt(s.domainU.start, s.domainV.start, 1, 0);
      const sv = s.derivativeAt(s.domainU.start, s.domainV.start, 0, 1);
      const [lenU, lenV] = [su.length, sv.length];
      const [ex, ey] = [su.normalized(), sv.normalized()];
      const line = end.sub(start);
      const axes: [Vector3, number][] = [[ex, lenU * (s.domainU.end - s.domainU.start)], [ey, lenV * (s.domainV.end - s.domainV.start)]];
      let [lo, hi] = range;
      for (const [axis, extent] of axes) {
        const p0 = start.sub(origin).dot(axis);
        const dp = line.dot(axis);
        if (Math.abs(dp) < 1e-14) {
          if (p0 < -this.weld || p0 > extent + this.weld) {
            return [1, 0];
          }
          continue;
        }
        const [t1, t2] = [-p0 / dp, (extent - p0) / dp];
        lo = Math.max(lo, Math.min(t1, t2));
        hi = Math.min(hi, Math.max(t1, t2));
      }
      return [lo, hi];
    };
    const [lo, hi] = clip(fb, clip(fa, [0, 1]));
    if (!(hi > lo)) {
      return [];
    }
    return [point(start.lerp(end, lo)), point(start.lerp(end, hi))];
  }

  /** True if the two faces' surfaces coincide, so that intersecting them means nothing. */
  private coincident(fa: Face, fb: Face): boolean {
    const mesh = fa.tessellate(this.meshTolerance);
    const step = Math.max(1, Math.floor(mesh.points.length / 12));
    for (let i = 0; i < mesh.points.length; i += step) {
      const q = fb.surface.closestPoint(mesh.points[i]!);
      if (q.distance > 100 * this.weld) {
        return false;
      }
    }
    return true;
  }

  /**
   * Mends the short gaps a mesh-based intersection can leave in its curves. A true end lies at the limit
   * of a surface; any other end has lost its neighbour, and is joined to the nearest such end.
   */
  private joinChains(fa: Face, fb: Face, input: readonly { points: CutPoint[]; closed: boolean }[]): { points: CutPoint[]; closed: boolean }[] {
    const atLimit = (q: UV, s: ISurface) => {
      const { domainU: du, domainV: dv } = s;
      const [mu, mv] = [1e-6 * (du.end - du.start), 1e-6 * (dv.end - dv.start)];
      return (
        (!s.isPeriodicU && (q.u <= du.start + mu || q.u >= du.end - mu)) ||
        (!s.isPeriodicV && (q.v <= dv.start + mv || q.v >= dv.end - mv))
      );
    };
    const free = (c: CutPoint) => !atLimit(c.a, fa.surface) && !atLimit(c.b, fb.surface);
    const chains = input.map((c) => ({ points: [...c.points], closed: c.closed }));
    const reach = 4 * this.meshTolerance;
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = 0; i < chains.length && !changed; i++) {
        const chain = chains[i]!;
        if (chain.closed) {
          continue;
        }
        const tail = chain.points[chain.points.length - 1]!;
        if (!free(tail)) {
          continue;
        }
        // The nearest free end: this chain's own start closes it, and another chain's end extends it.
        let best: { j: number; flip: boolean; d: number } | undefined;
        for (let j = 0; j < chains.length; j++) {
          const other = chains[j]!;
          if (other.closed) {
            continue;
          }
          const start = other.points[0]!;
          const end = other.points[other.points.length - 1]!;
          if (free(start) && (j !== i || other.points.length > 2)) {
            const d = tail.p.distanceTo(start.p);
            if (d <= reach && (!best || d < best.d)) {
              best = { j, flip: false, d };
            }
          }
          if (j !== i && free(end)) {
            const d = tail.p.distanceTo(end.p);
            if (d <= reach && (!best || d < best.d)) {
              best = { j, flip: true, d };
            }
          }
        }
        if (!best) {
          continue;
        }
        if (best.j === i) {
          chain.closed = true;
        } else {
          const other = chains[best.j]!;
          chain.points.push(...(best.flip ? [...other.points].reverse() : other.points));
          chains.splice(best.j, 1);
        }
        changed = true;
      }
      if (!changed) {
        // An end can also be free at the start of a chain only, so try the chains the other way round.
        for (const chain of chains) {
          if (!chain.closed && free(chain.points[0]!) && !free(chain.points[chain.points.length - 1]!)) {
            chain.points.reverse();
            const tail = chain.points[chain.points.length - 1]!;
            if (chains.some((o) => o !== chain && !o.closed && (free(o.points[0]!) || free(o.points[o.points.length - 1]!)) && Math.min(o.points[0]!.p.distanceTo(tail.p), o.points[o.points.length - 1]!.p.distanceTo(tail.p)) <= reach)) {
              changed = true;
              break;
            }
          }
        }
      }
    }
    return chains.map((c) => {
      // Repeated points would make a curve with zero-length spans.
      const clean: CutPoint[] = [];
      for (const q of c.points) {
        if (clean.length === 0 || clean[clean.length - 1]!.p.distanceTo(q.p) > this.weld) {
          clean.push(q);
        }
      }
      if (c.closed && clean.length > 1 && clean[0]!.p.distanceTo(clean[clean.length - 1]!.p) <= this.weld) {
        clean.pop();
      }
      return { points: clean, closed: c.closed };
    });
  }

  /** Breaks a polyline wherever its parameters jump across a seam, adding a point on the seam each side. */
  private breakAtSeams(fa: Face, fb: Face, points: readonly CutPoint[], closed: boolean): { runs: CutPoint[][]; closed: boolean } {
    const [sa, sb] = [fa.surface, fb.surface];
    const list = closed ? [...points, points[0]!] : [...points];
    /** The second parameters, moved by a whole period where that brings them next to the first. */
    const unwrap = (x: UV, y: UV, s: ISurface): UV => {
      let { u, v } = y;
      const spanU = s.domainU.end - s.domainU.start;
      const spanV = s.domainV.end - s.domainV.start;
      if (s.isPeriodicU && Math.abs(x.u - u) > spanU / 2) {
        u += x.u > u ? spanU : -spanU;
      }
      if (s.isPeriodicV && Math.abs(x.v - v) > spanV / 2) {
        v += x.v > v ? spanV : -spanV;
      }
      return { u, v };
    };
    /** Where the straight path from `x` to `y` leaves the domain, and the same place on the other side. */
    const leaving = (x: UV, y: UV, s: ISurface): { f: number; before: UV; after: UV }[] => {
      const result: { f: number; before: UV; after: UV }[] = [];
      const { start: u0, end: u1 } = s.domainU;
      const { start: v0, end: v1 } = s.domainV;
      // A point exactly on the seam counts as crossing it: unwrapped, it sits at the end of the domain.
      if (s.isPeriodicU) {
        for (const [limit, wrapped] of [[u1, u0], [u0, u1]] as const) {
          if ((limit === u1 && y.u >= u1 && x.u < u1) || (limit === u0 && y.u < u0)) {
            const f = (limit - x.u) / (y.u - x.u);
            const v = x.v + (y.v - x.v) * f;
            result.push({ f, before: { u: limit, v }, after: { u: wrapped, v } });
          }
        }
      }
      if (s.isPeriodicV) {
        for (const [limit, wrapped] of [[v1, v0], [v0, v1]] as const) {
          if ((limit === v1 && y.v >= v1 && x.v < v1) || (limit === v0 && y.v < v0)) {
            const f = (limit - x.v) / (y.v - x.v);
            const u = x.u + (y.u - x.u) * f;
            result.push({ f, before: { u, v: limit }, after: { u, v: wrapped } });
          }
        }
      }
      return result;
    };
    const runs: CutPoint[][] = [[list[0]!]];
    let broke = false;
    for (let i = 0; i + 1 < list.length; i++) {
      const [x, y] = [list[i]!, list[i + 1]!];
      const [ya, yb] = [unwrap(x.a, y.a, sa), unwrap(x.b, y.b, sb)];
      // One segment can cross both solids' seams, at different places, so take them in order.
      const events = [
        ...leaving(x.a, ya, sa).map((e) => ({ ...e, onA: true })),
        ...leaving(x.b, yb, sb).map((e) => ({ ...e, onA: false })),
      ].sort((m, n) => m.f - n.f);
      // Each crossing moves that surface's parameters to the other side of its seam for all that follows.
      let [shiftA, shiftB]: [UV, UV] = [{ u: 0, v: 0 }, { u: 0, v: 0 }];
      for (const e of events) {
        const p = x.p.lerp(y.p, e.f);
        const onA = lerpUV(x.a, ya, e.f);
        const onB = lerpUV(x.b, yb, e.f);
        const a = { u: onA.u + shiftA.u, v: onA.v + shiftA.v };
        const b = { u: onB.u + shiftB.u, v: onB.v + shiftB.v };
        runs[runs.length - 1]!.push({ p, a: e.onA ? e.before : a, b: e.onA ? b : e.before });
        runs.push([{ p, a: e.onA ? e.after : a, b: e.onA ? b : e.after }]);
        const step = { u: e.after.u - e.before.u, v: e.after.v - e.before.v };
        if (e.onA) {
          shiftA = { u: shiftA.u + step.u, v: shiftA.v + step.v };
        } else {
          shiftB = { u: shiftB.u + step.u, v: shiftB.v + step.v };
        }
        broke = true;
      }
      runs[runs.length - 1]!.push(y);
    }
    if (closed && broke) {
      // The closing joint is continuous, so the last run and the first join there.
      const last = runs.pop()!;
      runs[0] = [...last.slice(0, -1), ...runs[0]!];
      return { runs, closed: false };
    }
    return { runs, closed: closed && !broke };
  }

  /** The parts of a polyline lying in both faces. */
  private clip(fa: Face, fb: Face, run: readonly CutPoint[], closed: boolean): { points: CutPoint[]; closed: boolean }[] {
    const uvA = run.map((c) => c.a);
    const uvB = run.map((c) => c.b);
    const breaks = new Set<number>();
    for (const polygon of fa.loops.map((l) => l.polygon())) {
      crossings(uvA, polygon).forEach((s) => breaks.add(s));
    }
    for (const polygon of fb.loops.map((l) => l.polygon())) {
      crossings(uvB, polygon).forEach((s) => breaks.add(s));
    }
    const last = run.length - 1;
    const stops = [...new Set([0, ...breaks, last])].sort((x, y) => x - y);
    const at = (s: number): CutPoint => {
      const i = Math.min(Math.floor(s), last - 1);
      const f = s - i;
      if (f === 0) {
        return run[i]!;
      }
      if (f === 1) {
        return run[i + 1]!;
      }
      return { p: run[i]!.p.lerp(run[i + 1]!.p, f), a: lerpUV(run[i]!.a, run[i + 1]!.a, f), b: lerpUV(run[i]!.b, run[i + 1]!.b, f) };
    };
    const inside = (s: number) => {
      const c = at(s);
      return (
        fa.containsParameter(c.a.u, c.a.v, 1e-7) &&
        fb.containsParameter(c.b.u, c.b.v, 1e-7)
      );
    };
    if (closed && stops.length === 2) {
      return inside(last / 2) ? [{ points: [...run], closed: true }] : [];
    }
    const result: { points: CutPoint[]; closed: boolean }[] = [];
    let current: CutPoint[] | undefined;
    for (let k = 0; k + 1 < stops.length; k++) {
      const [lo, hi] = [stops[k]!, stops[k + 1]!];
      if (hi - lo < 1e-9) {
        continue;
      }
      if (inside((lo + hi) / 2)) {
        current ??= [at(lo)];
        for (let i = Math.floor(lo) + 1; i < hi; i++) {
          current.push(run[i]!);
        }
        current.push(at(hi));
      } else if (current) {
        result.push({ points: current, closed: false });
        current = undefined;
      }
    }
    if (current) {
      result.push({ points: current, closed: false });
    }
    return result;
  }

  /** Puts an end of a cut exactly on the boundary edge it stops at, and exactly on the other surface. */
  private snapEnd(point: CutPoint, fa: Face, fb: Face): CutPoint {
    const reach = 4 * this.meshTolerance;
    let best: { p: Vector3; a: UV; b: UV; distance: number } | undefined;
    const tryFace = (owner: Face, other: Face, ownerIsA: boolean) => {
      for (const edge of faceEdges(owner)) {
        const near = edge.closest(point.p, this.meshTolerance);
        if (near.distance > reach) {
          continue;
        }
        const otherUV = ownerIsA ? point.b : point.a;
        const solved = solveEdgeSurface(edge, other.surface, near.t, otherUV);
        if (solved.gap > this.weld / 4) {
          continue;
        }
        const p = edge.pointAt(solved.t);
        const moved = p.distanceTo(point.p);
        if (best && moved >= best.distance) {
          continue;
        }
        const ownerUV = invertNear(owner.surface, p, ownerIsA ? point.a : point.b);
        best = {
          p,
          a: ownerIsA ? ownerUV : solved.uv,
          b: ownerIsA ? solved.uv : ownerUV,
          distance: moved,
        };
      }
    };
    tryFace(fa, fb, true);
    tryFace(fb, fa, false);
    return best ? { p: best.p, a: best.a, b: best.b } : point;
  }

  private addCut(fa: Face, fb: Face, points: CutPoint[], closed: boolean): void {
    let list = points;
    if (!closed) {
      list = [this.snapEnd(points[0]!, fa, fb), ...points.slice(1, -1), this.snapEnd(points[points.length - 1]!, fa, fb)];
    }
    // Consecutive repeats would make zero-length curve segments.
    const clean: CutPoint[] = [];
    for (const c of list) {
      if (clean.length === 0 || clean[clean.length - 1]!.p.distanceTo(c.p) > this.weld) {
        clean.push(c);
      } else if (c === list[list.length - 1]) {
        clean[clean.length - 1] = c;
      }
    }
    if (closed && clean.length > 1 && clean[0]!.p.distanceTo(clean[clean.length - 1]!.p) <= this.weld) {
      clean.pop();
    }
    if (clean.length < (closed ? 3 : 2)) {
      return;
    }
    this.cuts.push({ faceA: fa, faceB: fb, points: clean, closed });
  }

  /** True if the points all lie along one edge of a face. */
  private alongEdge(face: Face, points: readonly Vector3[]): boolean {
    return faceEdges(face).some((edge) => points.every((q) => edge.closest(q, this.meshTolerance).distance <= 100 * this.weld));
  }

  /**
   * An edge lying in a face of the other solid must divide that face, yet the surfaces there may only
   * touch at their limits, where intersecting them finds nothing. So add such edges directly. Straight
   * edges in flat faces don't need this, since cutting the two planes finds them.
   */
  private addEdgesInFaces(owners: ISolid, targets: ISolid, ownerIsA: boolean): void {
    for (const edge of owners.edges) {
      if (edge.isDegenerate) {
        continue;
      }
      const users = owners.facesOfEdge(edge);
      const curved = !(edge.curve instanceof Line) || users.some((f) => !f.isFlat());
      if (!curved) {
        continue;
      }
      const { parameters, points } = edge.discretize(this.meshTolerance);
      const box = BoundingBox3.fromPoints(points);
      for (const target of targets.faces) {
        if (!target.boundingBox().intersects(box, this.weld)) {
          continue;
        }
        const samples = [0, 0.25, 0.5, 0.75, 1].map((s) => edge.pointAt(edge.t0 + (edge.t1 - edge.t0) * s));
        if (samples.some((q) => target.surface.closestPoint(q).distance > 10 * this.weld)) {
          continue;
        }
        const user = users[0]!;
        const coedge = user.loops.flatMap((l) => l.coedges).find((c) => c.edge === edge)!;
        let guess: UV = target.surface.closestPoint(points[0]!);
        const list: CutPoint[] = parameters.map((t, i) => {
          guess = invertNear(target.surface, points[i]!, guess);
          const own = coedge.uvAt(t);
          return ownerIsA ? { p: points[i]!, a: own, b: guess } : { p: points[i]!, a: guess, b: own };
        });
        const [fa, fb] = ownerIsA ? [user, target] : [target, user];
        const inFace = (c: CutPoint) => (ownerIsA ? target.containsParameter(c.b.u, c.b.v, 1e-7) : target.containsParameter(c.a.u, c.a.v, 1e-7));
        // Whole edges only for now: a partial overlap is found from the other solid's cuts ending on it.
        if (edge.isClosed) {
          if (list.every(inFace)) {
            this.cuts.push({ faceA: fa, faceB: fb, points: list.slice(0, -1), closed: true, curve: edge.curve!, knots: parameters });
          }
        } else if (list.every(inFace)) {
          this.cuts.push({ faceA: fa, faceB: fb, points: list, closed: false, curve: edge.curve!, knots: parameters });
        }
      }
    }
  }

  findCuts(): void {
    this.addEdgesInFaces(this.solidB, this.solidA, false);
    this.addEdgesInFaces(this.solidA, this.solidB, true);
    for (const fa of this.solidA.faces) {
      for (const fb of this.solidB.faces) {
        if (!fa.boundingBox().intersects(fb.boundingBox(), this.weld)) {
          continue;
        }
        if (fa.isFlat() && fb.isFlat()) {
          for (const line of this.planeCut(fa, fb)) {
            for (const part of line.length === 2 ? this.clip(fa, fb, line, false) : []) {
              this.addCut(fa, fb, part.points, false);
            }
          }
          continue;
        }
        if (!fa.isFlat() && !fb.isFlat() && this.coincident(fa, fb)) {
          continue;
        }
        const sections = fa.surface.intersect(fb.surface, { tolerance: this.weld / 10, meshTolerance: this.meshTolerance });
        const chains = sections
          .filter((section) => {
            // A contact along a face's own edge is added directly, from the edge itself.
            const probes = [0, 0.25, 0.5, 0.75].map((s) => section.points[Math.floor(s * section.points.length)]!);
            return !this.alongEdge(fa, probes) && !this.alongEdge(fb, probes);
          })
          .map((section) => ({
            points: section.points.map((p, i) => ({ p, a: section.parameters[i]!, b: section.parametersOther[i]! })),
            closed: section.closed,
          }));
        for (const { points, closed: wasClosed } of this.joinChains(fa, fb, chains)) {
          const { runs, closed } = this.breakAtSeams(fa, fb, points, wasClosed);
          for (const run of runs) {
            const path = closed ? [...run, run[0]!] : run;
            for (const part of this.clip(fa, fb, path, closed)) {
              const pts = part.closed ? part.points.slice(0, -1) : part.points;
              this.addCut(fa, fb, pts, part.closed);
            }
          }
        }
      }
    }
  }

  /** Records where the cuts stop along original edges. */
  registerEdgeSplits(): void {
    const add = (edge: Edge, p: Vector3) => {
      const near = edge.closest(p, this.meshTolerance);
      if (near.distance > this.weld) {
        return;
      }
      if (edge.pointAt(edge.t0).distanceTo(p) <= this.weld || edge.pointAt(edge.t1).distanceTo(p) <= this.weld) {
        return;
      }
      const list = this.edgeSplits.get(edge) ?? [];
      if (!list.some((t) => edge.pointAt(t).distanceTo(p) <= this.weld)) {
        list.push(near.t);
      }
      this.edgeSplits.set(edge, list);
    };
    for (const cut of this.cuts) {
      if (cut.closed) {
        continue;
      }
      for (const end of [cut.points[0]!, cut.points[cut.points.length - 1]!]) {
        for (const face of [cut.faceA, cut.faceB]) {
          for (const edge of faceEdges(face)) {
            add(edge, end.p);
          }
        }
      }
    }
  }

  /** Inserts graph nodes where a cut's end lands in the middle of another cut on the same face. */
  linkCuts(): void {
    const onFace = (face: Face) => this.cuts.filter((c) => c.faceA === face || c.faceB === face);
    const seen = new Set<Face>();
    for (const cut of this.cuts) {
      for (const face of [cut.faceA, cut.faceB]) {
        if (seen.has(face)) {
          continue;
        }
        seen.add(face);
        const list = onFace(face);
        for (const host of list) {
          for (const other of list) {
            if (host === other || other.closed) {
              continue;
            }
            for (const end of [other.points[0]!, other.points[other.points.length - 1]!]) {
              this.insertNode(host, end);
            }
          }
        }
      }
    }
  }

  private insertNode(host: Cut, end: CutPoint): void {
    const pts = host.points;
    const count = host.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const [x, y] = [pts[i]!, pts[(i + 1) % pts.length]!];
      if (x.p.distanceTo(end.p) <= this.weld) {
        x.node = true;
        return;
      }
      if (y.p.distanceTo(end.p) <= this.weld) {
        y.node = true;
        return;
      }
      const seg = y.p.sub(x.p);
      const s = end.p.sub(x.p).dot(seg) / seg.lengthSquared;
      if (s > 0 && s < 1 && x.p.addScaled(seg, s).distanceTo(end.p) <= this.weld) {
        pts.splice(i + 1, 0, { p: end.p, a: lerpUV(x.a, y.a, s), b: lerpUV(x.b, y.b, s), node: true });
        return;
      }
    }
  }

  /**
   * The curve of a cut. Between flat faces it is straight. Otherwise it is a cubic Hermite spline
   * through the points, whose tangents come exactly from the normals of the two surfaces.
   */
  curveOf(cut: Cut): ICurve {
    if (!cut.curve) {
      const pts = cut.points.map((c) => c.p);
      if (cut.faceA.isFlat() && cut.faceB.isFlat()) {
        cut.curve = pts.length === 2 ? new Line(pts[0]!, pts[1]!) : new Polyline(pts);
        cut.knots = pts.length === 2 ? [0, 1] : pts.map((_, i) => i);
      } else {
        const list = cut.closed ? [...cut.points, cut.points[0]!] : cut.points;
        const knots = [0];
        for (let i = 1; i < list.length; i++) {
          knots.push(knots[i - 1]! + list[i]!.p.distanceTo(list[i - 1]!.p));
        }
        const count = list.length;
        const tangents = list.map((c, i) => {
          const before = list[cut.closed && i === 0 ? count - 2 : Math.max(i - 1, 0)]!.p;
          const after = list[cut.closed && i === count - 1 ? 1 : Math.min(i + 1, count - 1)]!.p;
          const chord = after.sub(before).normalized();
          const exact = cut.faceA.surface.normalAt(c.a.u, c.a.v).cross(cut.faceB.surface.normalAt(c.b.u, c.b.v));
          // Where the surfaces are nearly tangent the cross product means little, so use the chords.
          if (exact.length < 1e-3) {
            return chord;
          }
          const unit = exact.normalized();
          return unit.dot(chord) < 0 ? unit.negate() : unit;
        });
        cut.curve = new HermiteSpline(list.map((c) => c.p), tangents, knots);
        cut.knots = knots;
      }
    }
    return cut.curve;
  }

  /** The boundary of a face as pieces, split where the cuts demand. */
  private boundaryPieces(face: Face): Piece[][] {
    const spanU = face.surface.domainU.end - face.surface.domainU.start;
    const spanV = face.surface.domainV.end - face.surface.domainV.start;
    const cutEnds = this.cuts
      .filter((c) => (c.faceA === face || c.faceB === face) && !c.closed)
      .flatMap((c) => {
        const useA = c.faceA === face;
        return [c.points[0]!, c.points[c.points.length - 1]!].map((e) => (useA ? e.a : e.b));
      });
    return face.loops.map((loop) => {
      const pieces: Piece[] = [];
      for (const c of loop.coedges) {
        const edge = c.edge;
        if (edge.isDegenerate) {
          // A pole's edge is a line of parameters, which a cut can reach at any point.
          const [from, to] = [c.uvs[0]!, c.uvs[c.uvs.length - 1]!];
          const [dx, dy] = [to.u - from.u, to.v - from.v];
          const len2 = dx * dx + dy * dy;
          const stops = cutEnds
            .map((q) => {
              const s = ((q.u - from.u) * dx + (q.v - from.v) * dy) / len2;
              return { s, off: Math.hypot((from.u + dx * s - q.u) / spanU, (from.v + dy * s - q.v) / spanV) };
            })
            .filter((x) => x.s > 1e-9 && x.s < 1 - 1e-9 && x.off <= 1e-6)
            .map((x) => x.s)
            .sort((a, b) => a - b);
          const fractions = [...new Set([0, ...stops, 1])];
          const parts: Piece[] = [];
          for (let i = 0; i + 1 < fractions.length; i++) {
            parts.push({
              curve: undefined,
              t0: 0,
              t1: 1,
              ts: [0, 1],
              uvs: [lerpUV(from, to, fractions[i]!), lerpUV(from, to, fractions[i + 1]!)],
              forward: c.forward,
              boundary: true,
              at: edge.start.point,
            });
          }
          pieces.push(...(c.forward ? parts : parts.reverse()));
          continue;
        }
        const splits = [...(this.edgeSplits.get(edge) ?? [])].sort((a, b) => a - b);
        const stops = [edge.t0, ...splits, edge.t1];
        const parts: Piece[] = [];
        for (let i = 0; i + 1 < stops.length; i++) {
          const [t0, t1] = [stops[i]!, stops[i + 1]!];
          const uvAtEnd = (t: number) => {
            if (t === edge.t0 || t === edge.t1) {
              return c.uvAt(t);
            }
            return invertNear(face.surface, edge.pointAt(t), c.uvAt(t));
          };
          const inner = c.ts.map((t, k) => ({ t, uv: c.uvs[k]! })).filter((e) => e.t > t0 + 1e-12 && e.t < t1 - 1e-12);
          parts.push({
            curve: edge.curve,
            t0,
            t1,
            ts: [t0, ...inner.map((e) => e.t), t1],
            uvs: [uvAtEnd(t0), ...inner.map((e) => e.uv), uvAtEnd(t1)],
            forward: c.forward,
            boundary: true,
          });
        }
        pieces.push(...(c.forward ? parts : parts.reverse()));
      }
      return pieces;
    });
  }

  /** True if a cut's piece runs along the face's own boundary, so that it divides nothing. */
  private liesOnBoundary(face: Face, p: readonly Vector3[]): boolean {
    return faceEdges(face).some((edge) => p.every((q) => edge.closest(q, this.meshTolerance).distance <= 2 * this.weld));
  }

  /** The cuts on a face as pieces, split at their nodes, without those on the boundary or repeated. */
  private cutPieces(face: Face): Piece[] {
    const result: Piece[] = [];
    const kept: { a: Vector3; b: Vector3; mid: Vector3 }[] = [];
    for (const cut of this.cuts) {
      if (cut.faceA !== face && cut.faceB !== face) {
        continue;
      }
      const useA = cut.faceA === face;
      const uvOf = (c: CutPoint) => (useA ? c.a : c.b);
      const curve = this.curveOf(cut);
      const count = cut.points.length;
      const paramAt = (i: number) => cut.knots![i]!;
      if (cut.closed) {
        const step = Math.max(1, Math.floor(count / 4));
        if (this.liesOnBoundary(face, cut.points.filter((_, i) => i % step === 0).map((c) => c.p))) {
          continue;
        }
        const uvs = [...cut.points.map(uvOf), uvOf(cut.points[0]!)];
        result.push({ curve, t0: paramAt(0), t1: paramAt(count), ts: uvs.map((_, i) => paramAt(i)), uvs, forward: true, boundary: false });
        continue;
      }
      const stops = [0];
      for (let i = 1; i + 1 < count; i++) {
        if (cut.points[i]!.node) {
          stops.push(i);
        }
      }
      stops.push(count - 1);
      for (let s = 0; s + 1 < stops.length; s++) {
        const [i0, i1] = [stops[s]!, stops[s + 1]!];
        const pts = cut.points.slice(i0, i1 + 1);
        const mid = pts.length % 2 === 1 ? pts[(pts.length - 1) / 2]!.p : pts[pts.length / 2 - 1]!.p.lerp(pts[pts.length / 2]!.p, 0.5);
        const [a, b] = [pts[0]!.p, pts[pts.length - 1]!.p];
        const third = a.lerp(pts[Math.min(1, pts.length - 1)]!.p, 0.5);
        if (this.liesOnBoundary(face, [a, mid, b, third])) {
          continue;
        }
        const twin = kept.some(
          (k) =>
            k.mid.distanceTo(mid) <= 2 * this.weld &&
            ((k.a.distanceTo(a) <= 2 * this.weld && k.b.distanceTo(b) <= 2 * this.weld) || (k.a.distanceTo(b) <= 2 * this.weld && k.b.distanceTo(a) <= 2 * this.weld)),
        );
        if (twin) {
          continue;
        }
        kept.push({ a, b, mid });
        result.push({
          curve,
          t0: paramAt(i0),
          t1: paramAt(i1),
          ts: pts.map((_, k) => paramAt(i0 + k)),
          uvs: pts.map(uvOf),
          forward: true,
          boundary: false,
        });
      }
    }
    return result;
  }

  /** Divides a face along its cuts, by tracing the regions of the planar graph they make with its boundary. */
  split(face: Face): Fragment[] {
    const boundary = this.boundaryPieces(face);
    const cuts = this.cutPieces(face);
    if (cuts.length === 0) {
      return [{ face, outer: boundary[0]!, holes: boundary.slice(1) }];
    }
    const spanU = face.surface.domainU.end - face.surface.domainU.start;
    const spanV = face.surface.domainV.end - face.surface.domainV.start;
    // Measured in each parameter separately: on a long cylinder, u and v differ by orders of magnitude.
    const [nodeU, nodeV] = [1e-5 * spanU, 1e-5 * spanV];
    const nodes: UV[] = [];
    const nodeOf = (q: UV) => {
      const found = nodes.findIndex((n) => Math.abs(n.u - q.u) <= nodeU && Math.abs(n.v - q.v) <= nodeV);
      if (found >= 0) {
        return found;
      }
      nodes.push(q);
      return nodes.length - 1;
    };
    interface HalfEdge {
      piece: Piece;
      forward: boolean;
      from: number;
      to: number;
      angle: number;
      used: boolean;
      twin: number;
    }
    let halves: HalfEdge[] = [];
    const addPiece = (piece: Piece) => {
      const uv = pieceUVs(piece);
      const [a, b] = [uv[0]!, uv[uv.length - 1]!];
      const [from, to] = [nodeOf(a), nodeOf(b)];
      // Angles in the normalized plane, so that the ordering around a node doesn't depend on units.
      const direction = (x: UV, y: UV) => Math.atan2((y.v - x.v) / spanV, (y.u - x.u) / spanU);
      const apart = (x: UV, y: UV) => Math.abs(x.u - y.u) > nodeU || Math.abs(x.v - y.v) > nodeV;
      const next = uv.find((q) => apart(q, a)) ?? b;
      const before = [...uv].reverse().find((q) => apart(q, b)) ?? a;
      const id = halves.length;
      halves.push({ piece, forward: true, from, to, angle: direction(a, next), used: false, twin: id + 1 });
      halves.push({ piece, forward: false, from: to, to: from, angle: direction(b, before), used: false, twin: id });
    };
    boundary.flat().forEach(addPiece);
    cuts.forEach(addPiece);
    // Dead ends can't bound a region, and would stop the trace.
    for (let changed = true; changed; ) {
      changed = false;
      const degree = new Map<number, number>();
      for (const h of halves) {
        degree.set(h.from, (degree.get(h.from) ?? 0) + 1);
      }
      const dead = new Set<HalfEdge>();
      halves.forEach((h) => {
        if (!h.piece.boundary && (degree.get(h.from) === 1 || degree.get(h.to) === 1) && h.from !== h.to) {
          dead.add(h);
        }
      });
      if (dead.size > 0) {
        const remap = new Map<HalfEdge, number>();
        const live = halves.filter((h) => !dead.has(h));
        live.forEach((h, i) => remap.set(h, i));
        const before = halves;
        live.forEach((h) => {
          h.twin = remap.get(before[h.twin]!)!;
        });
        halves = live;
        changed = true;
      }
    }
    const outgoing = new Map<number, number[]>();
    halves.forEach((h, i) => {
      outgoing.set(h.from, [...(outgoing.get(h.from) ?? []), i]);
    });
    for (const list of outgoing.values()) {
      list.sort((a, b) => halves[a]!.angle - halves[b]!.angle);
    }
    // Keeping the region on the left: from the twin of the way in, take the next edge clockwise.
    const nextOf = (i: number): number => {
      const twin = halves[i]!.twin;
      const list = outgoing.get(halves[i]!.to)!;
      const at = list.indexOf(twin);
      return list[(at + list.length - 1) % list.length]!;
    };
    const cycles: { pieces: Piece[]; polygon: UV[]; area: number }[] = [];
    halves.forEach((_, start) => {
      if (halves[start]!.used) {
        return;
      }
      const pieces: Piece[] = [];
      const polygon: UV[] = [];
      let valid = true;
      let i = start;
      let guard = 0;
      do {
        const h = halves[i]!;
        h.used = true;
        // A boundary piece taken against its own direction faces out of the face.
        if (!h.forward && h.piece.boundary) {
          valid = false;
        }
        const directed: Piece = h.forward ? h.piece : { ...h.piece, forward: !h.piece.forward };
        pieces.push(directed);
        polygon.push(...pieceUVs(directed).slice(0, -1));
        i = nextOf(i);
      } while (i !== start && ++guard < 100000);
      if (valid) {
        const plane: Point2[] = polygon.map((q) => ({ x: q.u, y: q.v }));
        cycles.push({ pieces, polygon, area: signedArea(plane) });
      }
    });
    const tiny = 1e-12 * spanU * spanV;
    const outers = cycles.filter((c) => c.area > tiny);
    const inners = cycles.filter((c) => c.area < -tiny);
    const fragments: Fragment[] = outers.map((c) => ({ face, outer: c.pieces, holes: [] }));
    const contains = (polygon: readonly UV[], q: UV) => {
      let inside = false;
      for (let k = 0; k < polygon.length; k++) {
        const [a, b] = [polygon[k]!, polygon[(k + 1) % polygon.length]!];
        if (a.v > q.v !== b.v > q.v && q.u < a.u + ((q.v - a.v) / (b.v - a.v)) * (b.u - a.u)) {
          inside = !inside;
        }
      }
      return inside;
    };
    for (const inner of inners) {
      const q = inner.polygon[0]!;
      let host = -1;
      // The region filling this very cycle touches it everywhere, and is too small to hold it.
      const holeArea = -inner.area;
      outers.forEach((c, i) => {
        if (c.area > holeArea * (1 + 1e-9) && contains(c.polygon, q) && (host < 0 || c.area < outers[host]!.area)) {
          host = i;
        }
      });
      if (host >= 0) {
        fragments[host]!.holes.push(inner.pieces);
      }
    }
    return fragments;
  }

  /** A point well inside a fragment, on its surface. */
  sampleOf(fragment: Fragment): UV {
    const polygons = [fragment.outer, ...fragment.holes].map((list) => list.flatMap((p) => pieceUVs(p).slice(0, -1)));
    const points: Point2[] = [];
    const cycles = polygons.map((poly) =>
      poly.map((q) => {
        points.push({ x: q.u, y: q.v });
        return points.length - 1;
      }),
    );
    const triangles = triangulate({ points, outer: cycles[0]!, holes: cycles.slice(1), interior: [] });
    let best = triangles[0]!;
    let area = -Infinity;
    for (const t of triangles) {
      const [a, b, c] = [points[t[0]]!, points[t[1]]!, points[t[2]]!];
      const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (value > area) {
        area = value;
        best = t;
      }
    }
    const [a, b, c] = [points[best[0]]!, points[best[1]]!, points[best[2]]!];
    return { u: (a.x + b.x + c.x) / 3, v: (a.y + b.y + c.y) / 3 };
  }
}

type Position = 'in' | 'out' | 'same' | 'opposite';

function positionOf(engine: Engine, fragment: Fragment, other: ISolid): Position {
  const q = engine.sampleOf(fragment);
  const p = fragment.face.surface.pointAt(q.u, q.v);
  const on = Math.max(10 * engine.weld, 1e-7 * other.boundingBox().diagonal);
  const where = other.classifyPoint(p, on);
  if (where === 'inside') {
    return 'in';
  }
  if (where === 'outside') {
    return 'out';
  }
  const near = closestSolidPoint(other, p);
  const theirs = near.face.surface.normalAt(near.u, near.v);
  return fragment.face.surface.normalAt(q.u, q.v).dot(theirs) > 0 ? 'same' : 'opposite';
}

function keepsFromA(kind: BooleanKind, position: Position): boolean {
  switch (kind) {
    case 'union':
      return position === 'out' || position === 'same';
    case 'intersection':
      return position === 'in' || position === 'same';
    case 'difference':
      return position === 'out' || position === 'opposite';
  }
}

function keepsFromB(kind: BooleanKind, position: Position): boolean {
  return kind === 'difference' ? position === 'in' : position === (kind === 'union' ? 'out' : 'in');
}

/** The fragment turned inside out: the surface reversed, `u` mirrored, and each loop run the other way. */
function flipped(fragment: Fragment): Fragment {
  const s = fragment.face.surface;
  const { start, end } = s.domainU;
  const mirror = (q: UV) => ({ u: start + end - q.u, v: q.v });
  const flipList = (list: readonly Piece[]) => [...list].reverse().map((p) => ({ ...p, forward: !p.forward, uvs: p.uvs.map(mirror) }));
  const face = new Face(s.reversed(), new Loop([]));
  return { face, outer: flipList(fragment.outer), holes: fragment.holes.map(flipList) };
}

/** Makes shared edges and vertices from the fragments' pieces, by matching pieces along the same line. */
function sew(fragments: readonly Fragment[], weld: number, meshTolerance: number): Shell[] {
  // Mapping any point to one vertex.
  const vertices: Vertex[] = [];
  const cells = new Map<string, Vertex[]>();
  const size = weld * 4;
  const vertexAt = (p: Vector3): Vertex => {
    const cx = Math.floor(p.x / size);
    const cy = Math.floor(p.y / size);
    const cz = Math.floor(p.z / size);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          for (const v of cells.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
            if (v.point.distanceTo(p) <= 2 * weld) {
              return v;
            }
          }
        }
      }
    }
    const v = new Vertex(p);
    vertices.push(v);
    const key = `${cx},${cy},${cz}`;
    cells.set(key, [...(cells.get(key) ?? []), v]);
    return v;
  };

  interface Use {
    fragment: number;
    loop: number;
    index: number;
    piece: Piece;
    start: Vertex;
    end: Vertex;
  }
  const pointOf = (p: Piece, t: number) => (p.curve ? p.curve.pointAt(t) : p.at!);
  // Every vertex must exist before a long piece can be divided at a vertex in its middle.
  const loops = fragments.map((f) => [f.outer, ...f.holes].map((list) => [...list]));
  for (const list of loops.flat(1)) {
    for (const p of list) {
      vertexAt(pointOf(p, p.t0));
      vertexAt(pointOf(p, p.t1));
    }
  }
  const splitAt = (piece: Piece): Piece[] => {
    if (!piece.curve) {
      return [piece];
    }
    const stops: number[] = [];
    const proxy = new Edge(piece.curve, piece.t0, piece.t1, new Vertex(pointOf(piece, piece.t0)), new Vertex(pointOf(piece, piece.t1)));
    const box = BoundingBox3.fromPoints(proxy.discretize(meshTolerance).points);
    for (const v of vertices) {
      if (!box.contains(v.point, meshTolerance + 2 * weld)) {
        continue;
      }
      if (v.point.distanceTo(proxy.start.point) <= 2 * weld || v.point.distanceTo(proxy.end.point) <= 2 * weld) {
        continue;
      }
      const near = proxy.closest(v.point, meshTolerance);
      if (near.distance <= 2 * weld) {
        stops.push(near.t);
      }
    }
    if (stops.length === 0) {
      return [piece];
    }
    const cuts = [piece.t0, ...stops.sort((a, b) => a - b), piece.t1];
    const uvAt = (t: number): UV => {
      for (let i = 0; i + 1 < piece.ts.length; i++) {
        if (t <= piece.ts[i + 1]!) {
          return lerpUV(piece.uvs[i]!, piece.uvs[i + 1]!, (t - piece.ts[i]!) / (piece.ts[i + 1]! - piece.ts[i]!));
        }
      }
      return piece.uvs[piece.uvs.length - 1]!;
    };
    const parts: Piece[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [t0, t1] = [cuts[i]!, cuts[i + 1]!];
      const inner = piece.ts.map((t, k) => ({ t, uv: piece.uvs[k]! })).filter((e) => e.t > t0 + 1e-12 && e.t < t1 - 1e-12);
      parts.push({ ...piece, t0, t1, ts: [t0, ...inner.map((e) => e.t), t1], uvs: [uvAt(t0), ...inner.map((e) => e.uv), uvAt(t1)] });
    }
    return piece.forward ? parts : parts.reverse();
  };
  for (const fragmentLoops of loops) {
    fragmentLoops.forEach((list, k) => {
      fragmentLoops[k] = list.flatMap(splitAt);
    });
  }

  const uses: Use[] = [];
  loops.forEach((fragmentLoops, f) => {
    fragmentLoops.forEach((list, l) => {
      list.forEach((piece, index) => {
        const a = vertexAt(pointOf(piece, piece.t0));
        const b = vertexAt(pointOf(piece, piece.t1));
        uses.push({ fragment: f, loop: l, index, piece, start: a, end: b });
      });
    });
  });

  // Pair the uses, each with another running along the same line.
  const coedges = new Map<Use, Coedge>();
  const groups = new Map<string, Use[]>();
  for (const u of uses) {
    if (!u.piece.curve) {
      continue;
    }
    const key = u.start.id < u.end.id ? `${u.start.id}/${u.end.id}` : `${u.end.id}/${u.start.id}`;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  for (const group of groups.values()) {
    const open = [...group];
    while (open.length > 0) {
      const first = open.shift()!;
      const c = first.piece.curve!;
      const edge = new Edge(c, first.piece.t0, first.piece.t1, first.start, first.end);
      const mid = edge.midpoint;
      const quarter = edge.pointAt(edge.t0 + (edge.t1 - edge.t0) / 4);
      const matches = open.filter((other) => {
        const proxy = new Edge(other.piece.curve!, other.piece.t0, other.piece.t1, other.start, other.end);
        return proxy.closest(mid, meshTolerance).distance <= Math.max(meshTolerance, 4 * weld) && proxy.closest(quarter, meshTolerance).distance <= Math.max(meshTolerance, 4 * weld);
      });
      const where = `near (${mid.toArray().map((x) => x.toFixed(4)).join(', ')})`;
      if (matches.length === 0) {
        throw new BooleanError(`The result has an edge used only once ${where}, so it would not be closed.`);
      }
      if (matches.length > 1) {
        throw new BooleanError(`The result has an edge shared by more than two faces ${where}, so it would not be a manifold solid.`);
      }
      const second = matches[0]!;
      open.splice(open.indexOf(second), 1);
      coedges.set(first, new Coedge(edge, first.piece.forward, first.piece.ts, first.piece.uvs));
      coedges.set(second, matchedCoedge(edge, second, meshTolerance));
      const [fa, fb] = [coedges.get(first)!, coedges.get(second)!];
      if (fa.forward === fb.forward) {
        throw new BooleanError(`Two faces of the result run the same way along an edge they share, near (${mid.toArray().map((x) => x.toFixed(4)).join(', ')}).`);
      }
    }
  }

  // Degenerate pieces stay with their own face.
  for (const u of uses) {
    if (!u.piece.curve) {
      coedges.set(u, new Coedge(Edge.degenerate(u.start), u.piece.forward, u.piece.ts, u.piece.uvs));
    }
  }

  const byLoop = new Map<string, Use[]>();
  for (const u of uses) {
    const key = `${u.fragment}/${u.loop}`;
    byLoop.set(key, [...(byLoop.get(key) ?? []), u]);
  }
  const faces = fragments.map((fragment, f) => {
    const loop = (l: number) => new Loop(byLoop.get(`${f}/${l}`)!.map((u) => coedges.get(u)!));
    const holes = fragment.holes.map((_, h) => loop(h + 1));
    return new Face(fragment.face.surface, loop(0), holes);
  });

  // Faces joined by edges form one shell.
  const parent = faces.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    parent[i] = root;
    return root;
  };
  const owner = new Map<Edge, number>();
  faces.forEach((face, i) => {
    for (const l of face.loops) {
      for (const c of l.coedges) {
        if (c.edge.isDegenerate) {
          continue;
        }
        const seen = owner.get(c.edge);
        if (seen === undefined) {
          owner.set(c.edge, i);
        } else {
          parent[find(i)] = find(seen);
        }
      }
    }
  });
  const shells = new Map<number, Face[]>();
  faces.forEach((face, i) => {
    const root = find(i);
    shells.set(root, [...(shells.get(root) ?? []), face]);
  });
  return [...shells.values()].map((list) => new Shell(list));
}

/** The second use of a shared edge: its table is put in terms of the first use's curve. */
function matchedCoedge(edge: Edge, use: { piece: Piece; start: Vertex; end: Vertex }, meshTolerance: number): Coedge {
  const { piece } = use;
  let ts: number[];
  let uvs: UV[];
  if (piece.curve === edge.curve) {
    ts = [...piece.ts];
    uvs = [...piece.uvs];
  } else {
    const params = piece.ts.map((t) => edge.closest(piece.curve!.pointAt(t), meshTolerance).t);
    const pairs = params.map((t, i) => ({ t, uv: piece.uvs[i]! })).sort((x, y) => x.t - y.t);
    ts = pairs.map((p) => p.t);
    uvs = pairs.map((p) => p.uv);
    ts[0] = edge.t0;
    ts[ts.length - 1] = edge.t1;
  }
  // Which way the loop runs, in terms of the shared edge.
  const loopStart = piece.forward ? use.start : use.end;
  let forward: boolean;
  if (!edge.isClosed) {
    forward = loopStart === edge.start;
  } else {
    const t = piece.t0 + (piece.t1 - piece.t0) * 0.25;
    const direction = piece.curve!.pointAt(t + (piece.t1 - piece.t0) * 0.01).sub(piece.curve!.pointAt(t));
    const near = edge.closest(piece.curve!.pointAt(t), meshTolerance).t;
    const along = edge.curve!.pointAt(near + (edge.t1 - edge.t0) * 0.01).sub(edge.curve!.pointAt(near));
    forward = direction.dot(along) > 0 === piece.forward;
  }
  return new Coedge(edge, forward, ts, uvs);
}

/** Runs a boolean operation, returning the result's shells, or nothing if it is empty. */
export function booleanOperation(a: ISolid, b: ISolid, kind: BooleanKind, options: BooleanOptions = {}): Shell[] | undefined {
  const [boxA, boxB] = [a.boundingBox(), b.boundingBox()];
  const weld = options.tolerance ?? 1e-7 * Math.max(boxA.diagonal, boxB.diagonal);
  const meshTolerance = options.meshTolerance ?? Math.min(boxA.diagonal, boxB.diagonal) / 150;
  const engine = new Engine(a, b, weld, meshTolerance);
  engine.findCuts();
  engine.registerEdgeSplits();
  engine.linkCuts();
  const fragments: Fragment[] = [];
  for (const face of a.faces) {
    for (const fragment of engine.split(face)) {
      if (keepsFromA(kind, positionOf(engine, fragment, b))) {
        fragments.push(fragment);
      }
    }
  }
  for (const face of b.faces) {
    for (const fragment of engine.split(face)) {
      if (keepsFromB(kind, positionOf(engine, fragment, a))) {
        fragments.push(kind === 'difference' ? flipped(fragment) : fragment);
      }
    }
  }
  if (fragments.length === 0) {
    return undefined;
  }
  return sew(fragments, weld, meshTolerance);
}
