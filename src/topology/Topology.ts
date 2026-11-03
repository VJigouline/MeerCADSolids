import { BoundingBox3, Vector3, type ISurface, type SurfaceParameter, type Transform3 } from 'meercad-surfaces';
import type { ICurve } from 'meercad-curves';
import { invertNear } from '../algorithms/integrate.js';
import { triangulate, type Point2 } from '../math/triangulate.js';

let nextId = 1;

/** A corner of a solid. */
export class Vertex {
  readonly id = nextId++;

  constructor(readonly point: Vector3) {}
}

/**
 * A piece of a curve between two vertices, from parameter `t0` to `t1`, with `t1 > t0`.
 * An edge with no curve is degenerate: it marks where a whole side of a face's parameter rectangle
 * collapses to one point, such as a sphere's pole.
 */
export class Edge {
  readonly id = nextId++;
  private cache: { tolerance: number; parameters: number[]; points: Vector3[] } | undefined;

  constructor(
    readonly curve: ICurve | undefined,
    readonly t0: number,
    readonly t1: number,
    readonly start: Vertex,
    readonly end: Vertex,
  ) {}

  /** An edge over a whole curve. */
  static of(curve: ICurve, start: Vertex, end: Vertex): Edge {
    return new Edge(curve, curve.domain.start, curve.domain.end, start, end);
  }

  static degenerate(at: Vertex): Edge {
    return new Edge(undefined, 0, 1, at, at);
  }

  get isDegenerate(): boolean {
    return this.curve === undefined;
  }

  get isClosed(): boolean {
    return this.start === this.end;
  }

  pointAt(t: number): Vector3 {
    return this.curve ? this.curve.pointAt(t) : this.start.point;
  }

  get midpoint(): Vector3 {
    return this.pointAt((this.t0 + this.t1) / 2);
  }

  /** Length along the curve. */
  get length(): number {
    return this.curve ? this.curve.lengthBetween(this.t0, this.t1) : 0;
  }

  /** A polyline along the edge, ending exactly at its vertices. Faces sharing it get the same points. */
  discretize(tolerance: number): { parameters: number[]; points: Vector3[] } {
    if (this.cache && this.cache.tolerance === tolerance) {
      return this.cache;
    }
    if (!this.curve) {
      return { parameters: [this.t0, this.t1], points: [this.start.point, this.start.point] };
    }
    const inside = this.curve.tessellate({ chordTolerance: tolerance }).parameters.filter((t) => t > this.t0 + 1e-12 && t < this.t1 - 1e-12);
    const parameters = [this.t0, ...inside, this.t1];
    // A closed edge needs interior points, or its polygon would have no area.
    if (this.isClosed && parameters.length < 5) {
      parameters.splice(1, parameters.length - 2, ...[0.25, 0.5, 0.75].map((s) => this.t0 + (this.t1 - this.t0) * s));
    }
    const points = parameters.map((t) => this.curve!.pointAt(t));
    points[0] = this.start.point;
    points[points.length - 1] = this.end.point;
    this.cache = { tolerance, parameters, points };
    return this.cache;
  }

  /** The closest point of the edge: a scan of its polyline, then a golden-section search. */
  closest(point: Vector3, tolerance: number): { t: number; point: Vector3; distance: number } {
    const { parameters, points } = this.discretize(tolerance);
    if (!this.curve) {
      return { t: this.t0, point: this.start.point, distance: this.start.point.distanceTo(point) };
    }
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i]!.distanceTo(point) < points[best]!.distanceTo(point)) {
        best = i;
      }
    }
    let lo = parameters[Math.max(best - 1, 0)]!;
    let hi = parameters[Math.min(best + 1, parameters.length - 1)]!;
    const ratio = (Math.sqrt(5) - 1) / 2;
    const f = (t: number) => this.curve!.pointAt(t).distanceTo(point);
    let x1 = hi - ratio * (hi - lo);
    let x2 = lo + ratio * (hi - lo);
    let [f1, f2] = [f(x1), f(x2)];
    for (let i = 0; i < 50; i++) {
      if (f1 <= f2) {
        hi = x2;
        x2 = x1;
        f2 = f1;
        x1 = hi - ratio * (hi - lo);
        f1 = f(x1);
      } else {
        lo = x1;
        x1 = x2;
        f1 = f2;
        x2 = lo + ratio * (hi - lo);
        f2 = f(x2);
      }
    }
    const t = (lo + hi) / 2;
    const q = this.curve.pointAt(t);
    return { t, point: q, distance: q.distanceTo(point) };
  }
}

/** One use of an edge by a face. Its table maps the edge's parameter to the face's `(u, v)`. */
export class Coedge {
  constructor(
    readonly edge: Edge,
    /** True if the loop runs along the edge from `t0` to `t1`. */
    readonly forward: boolean,
    /** Edge parameters, increasing. */
    readonly ts: readonly number[],
    readonly uvs: readonly SurfaceParameter[],
  ) {}

  /** A use whose parameters run straight in the parameter plane, from `from` to `to` along the loop. */
  static straight(edge: Edge, forward: boolean, from: SurfaceParameter, to: SurfaceParameter): Coedge {
    return new Coedge(edge, forward, [edge.t0, edge.t1], forward ? [from, to] : [to, from]);
  }

  uvAt(t: number): SurfaceParameter {
    const { ts, uvs } = this;
    if (t <= ts[0]!) {
      return uvs[0]!;
    }
    for (let i = 0; i + 1 < ts.length; i++) {
      if (t <= ts[i + 1]!) {
        const s = (t - ts[i]!) / (ts[i + 1]! - ts[i]!);
        return { u: uvs[i]!.u + (uvs[i + 1]!.u - uvs[i]!.u) * s, v: uvs[i]!.v + (uvs[i + 1]!.v - uvs[i]!.v) * s };
      }
    }
    return uvs[uvs.length - 1]!;
  }

  /** The `(u, v)` polyline in the direction of the loop. */
  get loopUVs(): SurfaceParameter[] {
    return this.forward ? [...this.uvs] : [...this.uvs].reverse();
  }
}

/** A closed cycle of coedges. An outer loop runs counter-clockwise in the parameter plane, a hole clockwise. */
export class Loop {
  constructor(readonly coedges: readonly Coedge[]) {}

  /** The `(u, v)` polygon of the loop, without a repeated closing point. */
  polygon(): SurfaceParameter[] {
    const result: SurfaceParameter[] = [];
    for (const c of this.coedges) {
      const uvs = c.loopUVs;
      result.push(...uvs.slice(0, -1));
    }
    return result;
  }

  signedArea(): number {
    const p = this.polygon();
    let sum = 0;
    for (let i = 0; i < p.length; i++) {
      const [a, b] = [p[i]!, p[(i + 1) % p.length]!];
      sum += a.u * b.v - b.u * a.v;
    }
    return sum / 2;
  }
}

/** Triangles of one face. Point indices run through `pointKeys`, which identify shared boundary points. */
export interface FaceMesh {
  readonly points: readonly Vector3[];
  readonly normals: readonly Vector3[];
  readonly parameters: readonly SurfaceParameter[];
  readonly triangles: readonly number[];
  /** A name shared by every use of the same 3D point on an edge or vertex; empty inside the face. */
  readonly pointKeys: readonly string[];
}

/**
 * A region of a surface. The surface's normal always points out of the solid, so its loops always run
 * counter-clockwise (outer) and clockwise (holes) in the parameter plane.
 */
export class Face {
  readonly id = nextId++;
  private meshCache = new Map<string, FaceMesh>();
  private boxCache: BoundingBox3 | undefined;

  constructor(
    readonly surface: ISurface,
    readonly outer: Loop,
    readonly holes: readonly Loop[] = [],
  ) {}

  get loops(): readonly Loop[] {
    return [this.outer, ...this.holes];
  }

  /**
   * True if `(u, v)` lies in the region. Points on the boundary count as inside. The tolerance is a
   * fraction of the domain, measured in each parameter separately, as their units can differ widely.
   */
  containsParameter(u: number, v: number, tolerance = 1e-9): boolean {
    const spanU = this.surface.domainU.end - this.surface.domainU.start;
    const spanV = this.surface.domainV.end - this.surface.domainV.start;
    let inside = false;
    for (const loop of this.loops) {
      const p = loop.polygon();
      for (let i = 0; i < p.length; i++) {
        const [a, b] = [p[i]!, p[(i + 1) % p.length]!];
        const [dx, dy] = [(b.u - a.u) / spanU, (b.v - a.v) / spanV];
        const [px, py] = [(u - a.u) / spanU, (v - a.v) / spanV];
        const len2 = dx * dx + dy * dy;
        const s = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
        if (Math.hypot(dx * s - px, dy * s - py) <= tolerance) {
          return true;
        }
        if (a.v > v !== b.v > v && u < a.u + ((v - a.v) / (b.v - a.v)) * (b.u - a.u)) {
          inside = !inside;
        }
      }
    }
    return inside;
  }

  /** Metric scales, so that a square in the scaled plane is about square on the surface. */
  private scales(): [number, number] {
    const us = this.loops.flatMap((l) => l.polygon());
    const midU = us.reduce((s, p) => s + p.u, 0) / us.length;
    const midV = us.reduce((s, p) => s + p.v, 0) / us.length;
    const a = this.surface.derivativeAt(midU, midV, 1, 0).length;
    const b = this.surface.derivativeAt(midU, midV, 0, 1).length;
    const top = Math.max(a, b, 1e-300);
    return [Math.max(a, 1e-3 * top), Math.max(b, 1e-3 * top)];
  }

  /**
   * Triangles within the chord tolerance, with boundary points shared with neighbouring faces.
   * `edgeTolerance` divides the boundary more finely than the interior, for faces whose boundary
   * curves meet at such a sharp angle that their chords would cross.
   */
  tessellate(chordTolerance: number, edgeTolerance = chordTolerance): FaceMesh {
    const cacheKey = `${chordTolerance}/${edgeTolerance}`;
    const cached = this.meshCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const [su, sv] = this.scales();
    const points: Vector3[] = [];
    const parameters: SurfaceParameter[] = [];
    const pointKeys: string[] = [];
    const plane: Point2[] = [];
    const add = (p: Vector3, uv: SurfaceParameter, key: string) => {
      points.push(p);
      parameters.push(uv);
      pointKeys.push(key);
      plane.push({ x: uv.u * su, y: uv.v * sv });
      return points.length - 1;
    };
    const cycles = this.loops.map((loop) => {
      const cycle: number[] = [];
      for (const c of loop.coedges) {
        const { parameters: ts, points: ps } = c.edge.discretize(edgeTolerance);
        const order = ts.map((_, i) => (c.forward ? i : ts.length - 1 - i));
        for (const i of order.slice(0, -1)) {
          const key = i === 0 ? `v${c.edge.start.id}` : i === ts.length - 1 ? `v${c.edge.end.id}` : `e${c.edge.id}:${i}`;
          // A table is only a guide between its entries, so find points accurately on curved surfaces.
          const guess = c.uvAt(ts[i]!);
          const uv = c.ts.length > 2 && !this.isFlat() ? invertNear(this.surface, ps[i]!, guess) : guess;
          cycle.push(add(ps[i]!, uv, key));
        }
      }
      return cycle;
    });
    // Interior points come from the surface's own refined grid.
    const grid = this.surface.tessellate({ chordTolerance, maxPoints: 40000 });
    const us = [...new Set(grid.parameters.map((p) => p.u))];
    const vs = [...new Set(grid.parameters.map((p) => p.v))];
    const polygons = this.loops.map((l) => l.polygon());
    const box = polygons.flat();
    const [uLo, uHi] = [Math.min(...box.map((p) => p.u)), Math.max(...box.map((p) => p.u))];
    const [vLo, vHi] = [Math.min(...box.map((p) => p.v)), Math.max(...box.map((p) => p.v))];
    const margin = 1e-4;
    const interior: number[] = [];
    const planar = this.isFlat();
    if (!planar) {
      for (const u of us) {
        if (u <= uLo || u >= uHi) {
          continue;
        }
        for (const v of vs) {
          if (v <= vLo || v >= vHi) {
            continue;
          }
          if (this.clearlyInside(u, v, polygons, margin)) {
            interior.push(add(this.surface.pointAt(u, v), { u, v }, ''));
          }
        }
      }
    }
    let raw = triangulate({ points: plane, outer: cycles[0]!, holes: cycles.slice(1), interior });
    // The grid can miss a thin region altogether, leaving triangles that cut across the surface. So
    // refine by what matters: any triangle whose centre lies too far from the surface gets a point there.
    if (!planar) {
      const margin2 = margin * 0.01;
      for (let pass = 0; pass < 8 && interior.length < 20000; pass++) {
        let added = 0;
        for (const [a, b, c] of raw) {
          const [qa, qb, qc] = [parameters[a]!, parameters[b]!, parameters[c]!];
          const centre = { u: (qa.u + qb.u + qc.u) / 3, v: (qa.v + qb.v + qc.v) / 3 };
          const flat = points[a]!.add(points[b]!).add(points[c]!).scale(1 / 3);
          const on = this.surface.pointAt(centre.u, centre.v);
          if (on.distanceTo(flat) > chordTolerance && this.clearlyInside(centre.u, centre.v, polygons, margin2)) {
            interior.push(add(on, centre, ''));
            added++;
          }
        }
        if (added === 0) {
          break;
        }
        raw = triangulate({ points: plane, outer: cycles[0]!, holes: cycles.slice(1), interior });
      }
    }
    const triangles: number[] = [];
    for (const [a, b, c] of raw) {
      const [pa, pb, pc] = [points[a]!, points[b]!, points[c]!];
      if (pa.distanceTo(pb) === 0 || pb.distanceTo(pc) === 0 || pc.distanceTo(pa) === 0) {
        continue;
      }
      triangles.push(a, b, c);
    }
    const mesh: FaceMesh = {
      points,
      parameters,
      pointKeys,
      triangles,
      normals: parameters.map((q) => this.surface.normalAt(q.u, q.v)),
    };
    this.meshCache.set(cacheKey, mesh);
    return mesh;
  }

  private flat: boolean | undefined;

  /** True if the surface is a plane, which needs no interior points. */
  isFlat(): boolean {
    this.flat ??= this.surface.isPlanar(1e-9 * Math.max(this.surface.boundingBox().diagonal, 1));
    return this.flat;
  }

  /** True if `(u, v)` lies in the region and further than `margin`, a fraction of the domain, from its boundary. */
  strictlyContains(u: number, v: number, margin: number): boolean {
    return this.clearlyInside(u, v, this.loops.map((l) => l.polygon()), margin);
  }

  private clearlyInside(u: number, v: number, polygons: readonly SurfaceParameter[][], margin: number): boolean {
    const spanU = this.surface.domainU.end - this.surface.domainU.start;
    const spanV = this.surface.domainV.end - this.surface.domainV.start;
    let inside = false;
    for (const p of polygons) {
      for (let i = 0; i < p.length; i++) {
        const [a, b] = [p[i]!, p[(i + 1) % p.length]!];
        const [dx, dy] = [(b.u - a.u) / spanU, (b.v - a.v) / spanV];
        const [px, py] = [(u - a.u) / spanU, (v - a.v) / spanV];
        const len2 = dx * dx + dy * dy;
        const s = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
        if (Math.hypot(dx * s - px, dy * s - py) <= margin) {
          return false;
        }
        if (a.v > v !== b.v > v && u < a.u + ((v - a.v) / (b.v - a.v)) * (b.u - a.u)) {
          inside = !inside;
        }
      }
    }
    return inside;
  }

  private extremes: Vector3[] | undefined;

  /** Mesh points, plus each of the six extremes pushed outwards along the true surface and edges. */
  extremePoints(): Vector3[] {
    if (!this.extremes) {
      const size = Math.max(this.surface.boundingBox().diagonal, 1e-300);
      const mesh = this.tessellate(size / 200);
      const result = [...mesh.points];
      const { domainU: du, domainV: dv } = this.surface;
      const [wu, wv] = [(du.end - du.start) / 16, (dv.end - dv.start) / 16];
      for (const axis of ['x', 'y', 'z'] as const) {
        for (const sign of [1, -1]) {
          let best = 0;
          mesh.points.forEach((p, i) => {
            if (sign * p[axis] > sign * mesh.points[best]![axis]) {
              best = i;
            }
          });
          let { u, v } = mesh.parameters[best]!;
          const score = (a: number, b: number) => (this.containsParameter(a, b) ? sign * this.surface.pointAt(a, b)[axis] : -Infinity);
          for (let round = 0; round < 3; round++) {
            for (const dir of ['u', 'v'] as const) {
              const c = dir === 'u' ? u : v;
              const w = (dir === 'u' ? wu : wv) / 2 ** round;
              const clampLo = dir === 'u' ? du.start : dv.start;
              const clampHi = dir === 'u' ? du.end : dv.end;
              let [lo, hi] = [Math.max(c - w, clampLo), Math.min(c + w, clampHi)];
              const f = (x: number) => (dir === 'u' ? score(x, v) : score(u, x));
              for (let k = 0; k < 24; k++) {
                const m1 = lo + (hi - lo) * 0.382;
                const m2 = lo + (hi - lo) * 0.618;
                if (f(m1) >= f(m2)) {
                  hi = m2;
                } else {
                  lo = m1;
                }
              }
              const x = (lo + hi) / 2;
              if (f(x) >= f(c)) {
                if (dir === 'u') {
                  u = x;
                } else {
                  v = x;
                }
              }
            }
          }
          result.push(this.surface.pointAt(u, v));
        }
      }
      this.extremes = result;
    }
    return this.extremes;
  }

  /** The bounding box of the region. */
  boundingBox(): BoundingBox3 {
    this.boxCache ??= BoundingBox3.fromPoints(this.extremePoints());
    return this.boxCache;
  }
}

/** A connected set of faces. */
export class Shell {
  constructor(readonly faces: readonly Face[]) {}
}

/** A distinct `Vertex` and `Edge` map used when transforming or reversing a whole solid. */
export interface TopologyMaps {
  readonly vertices: Map<Vertex, Vertex>;
  readonly edges: Map<Edge, Edge>;
}

/** Applies an affine transform to a set of shells, sharing each edge's copy between its faces. */
export function transformShells(shells: readonly Shell[], t: Transform3, flipOrientation: boolean): Shell[] {
  const vertices = new Map<Vertex, Vertex>();
  const edges = new Map<Edge, Edge>();
  const vertex = (v: Vertex) => {
    let copy = vertices.get(v);
    if (!copy) {
      copy = new Vertex(t.applyToPoint(v.point));
      vertices.set(v, copy);
    }
    return copy;
  };
  const edge = (e: Edge) => {
    let copy = edges.get(e);
    if (!copy) {
      copy = new Edge(e.curve?.transformed(t), e.t0, e.t1, vertex(e.start), vertex(e.end));
      edges.set(e, copy);
    }
    return copy;
  };
  return shells.map(
    (shell) =>
      new Shell(
        shell.faces.map((face) => {
          const moved = face.surface.transformed(t);
          if (!flipOrientation) {
            const copyLoop = (loop: Loop) => new Loop(loop.coedges.map((c) => new Coedge(edge(c.edge), c.forward, c.ts, c.uvs)));
            return new Face(moved, copyLoop(face.outer), face.holes.map(copyLoop));
          }
          return reversedFace(face, moved, edge);
        }),
      ),
  );
}

/** A face turned inside out: the surface reversed, `u` mirrored, and each loop run the other way. */
function reversedFace(face: Face, surface: ISurface, edge: (e: Edge) => Edge): Face {
  const { start, end } = surface.domainU;
  const flipped = surface.reversed();
  const mirror = (q: SurfaceParameter) => ({ u: start + end - q.u, v: q.v });
  const copyLoop = (loop: Loop) =>
    new Loop([...loop.coedges].reverse().map((c) => new Coedge(edge(c.edge), !c.forward, c.ts, c.uvs.map(mirror))));
  return new Face(flipped, copyLoop(face.outer), face.holes.map(copyLoop));
}

/** The same shells with every normal flipped, keeping the edges and vertices. */
export function flipShells(shells: readonly Shell[]): Shell[] {
  return shells.map((shell) => new Shell(shell.faces.map((f) => reversedFace(f, f.surface, (e) => e))));
}
