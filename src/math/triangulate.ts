/** A point in the plane. */
export interface Point2 {
  readonly x: number;
  readonly y: number;
}

function orient(a: Point2, b: Point2, c: Point2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function signedArea(polygon: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function strictlyInTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  return orient(a, b, p) > 0 && orient(b, c, p) > 0 && orient(c, a, p) > 0;
}

function closedInTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  return orient(a, b, p) >= 0 && orient(b, c, p) >= 0 && orient(c, a, p) >= 0;
}

/** Segments ab and cd properly cross, sharing no end point. */
function segmentsCross(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const d1 = orient(a, b, c);
  const d2 = orient(a, b, d);
  const d3 = orient(c, d, a);
  const d4 = orient(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Joins each hole to the polygon by a two-way bridge, giving one vertex cycle.
 * The outer cycle must be counter-clockwise, and the holes clockwise.
 */
function bridgeHoles(points: readonly Point2[], outer: readonly number[], holes: readonly (readonly number[])[]): number[] {
  let ring = [...outer];
  const sorted = [...holes].sort((a, b) => Math.max(...b.map((i) => points[i]!.x)) - Math.max(...a.map((i) => points[i]!.x)));
  for (const hole of sorted) {
    let start = 0;
    hole.forEach((id, k) => {
      if (points[id]!.x > points[hole[start]!]!.x) {
        start = k;
      }
    });
    const from = points[hole[start]!]!;
    // The nearest ring vertex whose straight connection crosses nothing.
    const candidates = ring
      .map((id, k) => ({ id, k, d: (points[id]!.x - from.x) ** 2 + (points[id]!.y - from.y) ** 2 }))
      .sort((a, b) => a.d - b.d);
    const blocked = (to: Point2) => {
      const crossing = (cycle: readonly number[]) =>
        cycle.some((id, k) => segmentsCross(from, to, points[id]!, points[cycle[(k + 1) % cycle.length]!]!));
      return crossing(ring) || holes.some(crossing);
    };
    const target = candidates.find((c) => !blocked(points[c.id]!)) ?? candidates[0]!;
    const rotated = [...hole.slice(start), ...hole.slice(0, start), hole[start]!];
    ring = [...ring.slice(0, target.k + 1), ...rotated, ...ring.slice(target.k)];
  }
  return ring;
}

/** Ear clipping of one vertex cycle. Near-degenerate ears are taken last. */
function earClip(points: readonly Point2[], ring: readonly number[]): [number, number, number][] {
  const result: [number, number, number][] = [];
  const cycle = [...ring];
  const isEar = (k: number, allowFlat: boolean) => {
    const n = cycle.length;
    const [ia, ib, ic] = [cycle[(k + n - 1) % n]!, cycle[k]!, cycle[(k + 1) % n]!];
    const [a, b, c] = [points[ia]!, points[ib]!, points[ic]!];
    const area = orient(a, b, c);
    if (allowFlat ? area < 0 : area <= 0) {
      return false;
    }
    for (const id of cycle) {
      if (id === ia || id === ib || id === ic) {
        continue;
      }
      const p = points[id]!;
      if (p.x === a.x && p.y === a.y) {
        continue;
      }
      if (p.x === c.x && p.y === c.y) {
        continue;
      }
      if (allowFlat ? strictlyInTriangle(p, a, b, c) : closedInTriangle(p, a, b, c)) {
        return false;
      }
    }
    return true;
  };
  while (cycle.length > 3) {
    const n = cycle.length;
    // The best ear is the one with the largest smallest angle, which keeps slivers away.
    let best = -1;
    let bestScore = -Infinity;
    for (let k = 0; k < n; k++) {
      if (!isEar(k, false)) {
        continue;
      }
      const [a, b, c] = [points[cycle[(k + n - 1) % n]!]!, points[cycle[k]!]!, points[cycle[(k + 1) % n]!]!];
      const area = orient(a, b, c);
      const longest = Math.max((a.x - b.x) ** 2 + (a.y - b.y) ** 2, (b.x - c.x) ** 2 + (b.y - c.y) ** 2, (c.x - a.x) ** 2 + (c.y - a.y) ** 2);
      const score = area / longest;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
      if (n > 200) {
        break;
      }
    }
    if (best < 0) {
      for (let k = 0; k < n; k++) {
        if (isEar(k, true)) {
          best = k;
          break;
        }
      }
    }
    if (best < 0) {
      best = 0;
    }
    result.push([cycle[(best + n - 1) % n]!, cycle[best]!, cycle[(best + 1) % n]!]);
    cycle.splice(best, 1);
  }
  if (cycle.length === 3) {
    result.push([cycle[0]!, cycle[1]!, cycle[2]!]);
  }
  return result;
}

/** A triangulation held as a map from each directed edge to the vertex opposite it. */
class EdgeMap {
  private readonly opposite = new Map<number, number>();
  private readonly fixed = new Set<number>();

  constructor(
    private readonly points: readonly Point2[],
    private readonly stride: number,
  ) {}

  private key(a: number, b: number): number {
    return a * this.stride + b;
  }

  add(a: number, b: number, c: number): void {
    this.opposite.set(this.key(a, b), c);
    this.opposite.set(this.key(b, c), a);
    this.opposite.set(this.key(c, a), b);
  }

  remove(a: number, b: number, c: number): void {
    this.opposite.delete(this.key(a, b));
    this.opposite.delete(this.key(b, c));
    this.opposite.delete(this.key(c, a));
  }

  fix(a: number, b: number): void {
    this.fixed.add(this.key(a, b));
    this.fixed.add(this.key(b, a));
  }

  isFixed(a: number, b: number): boolean {
    return this.fixed.has(this.key(a, b));
  }

  opp(a: number, b: number): number | undefined {
    return this.opposite.get(this.key(a, b));
  }

  /** Flips non-Delaunay edges from the given stack, leaving fixed edges alone. */
  legalize(stack: [number, number][]): void {
    let budget = 200 + 40 * this.opposite.size;
    while (stack.length > 0 && budget-- > 0) {
      const [a, b] = stack.pop()!;
      if (this.fixed.has(this.key(a, b))) {
        continue;
      }
      const c = this.opp(a, b);
      const d = this.opp(b, a);
      if (c === undefined || d === undefined || c === d) {
        continue;
      }
      const [pa, pb, pc, pd] = [this.points[a]!, this.points[b]!, this.points[c]!, this.points[d]!];
      // A flip is only valid if the two triangles make a strictly convex quadrilateral.
      if (orient(pc, pd, pb) <= 0 || orient(pd, pc, pa) <= 0) {
        continue;
      }
      if (!inCircle(pa, pb, pc, pd)) {
        continue;
      }
      if (this.opp(c, d) !== undefined || this.opp(d, c) !== undefined) {
        continue;
      }
      this.remove(a, b, c);
      this.remove(b, a, d);
      this.add(c, d, b);
      this.add(d, c, a);
      stack.push([b, c], [d, b], [a, d], [c, a]);
    }
  }

  triangles(): [number, number, number][] {
    const result: [number, number, number][] = [];
    for (const [key, c] of this.opposite) {
      const a = Math.floor(key / this.stride);
      const b = key - a * this.stride;
      if (a < b && a < c) {
        result.push([a, b, c]);
      }
    }
    return result;
  }
}

function inCircle(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const ax = a.x - d.x;
  const ay = a.y - d.y;
  const bx = b.x - d.x;
  const by = b.y - d.y;
  const cx = c.x - d.x;
  const cy = c.y - d.y;
  const det =
    (ax * ax + ay * ay) * (bx * cy - by * cx) -
    (bx * bx + by * by) * (ax * cy - ay * cx) +
    (cx * cx + cy * cy) * (ax * by - ay * bx);
  const scale = (ax * ax + ay * ay) * (bx * bx + by * by) * 1e-14;
  return det > scale;
}

/** A triangle at a just-inserted point, whatever flips happened since. */
function triangleAt(map: EdgeMap, id: number, a: number, b: number): [number, number, number] | undefined {
  for (const [x, y] of [[a, id], [id, b], [b, id], [id, a]] as const) {
    const z = map.opp(x, y);
    if (z !== undefined) {
      return [x, y, z];
    }
  }
  return undefined;
}

export interface TriangulationInput {
  /** All boundary points, then any interior points. */
  readonly points: readonly Point2[];
  /** Indices of the outer cycle, counter-clockwise. */
  readonly outer: readonly number[];
  /** Index cycles of the holes, clockwise. */
  readonly holes: readonly (readonly number[])[];
  /** Indices of interior points to insert. They must lie inside the region. */
  readonly interior: readonly number[];
}

/**
 * Triangulates a polygon with holes, keeping its boundary edges: ear clipping, then Delaunay flips,
 * then inserting each interior point and flipping again. Because every step keeps a valid
 * triangulation of the region, the boundary needs no recovery step.
 */
export function triangulate(input: TriangulationInput): [number, number, number][] {
  const { points, outer, holes, interior } = input;
  const ring = bridgeHoles(points, outer, holes);
  const ears = earClip(points, ring);
  const map = new EdgeMap(points, points.length + 1);
  for (const [a, b, c] of ears) {
    map.add(a, b, c);
  }
  for (const cycle of [outer, ...holes]) {
    cycle.forEach((id, k) => map.fix(id, cycle[(k + 1) % cycle.length]!));
  }
  const allEdges = (): [number, number][] => map.triangles().flatMap(([a, b, c]) => [[a, b], [b, c], [c, a]] as [number, number][]);
  map.legalize(allEdges());
  // Interior points arrive in grid order, so walking from the last triangle reaches the next one quickly.
  const span = Math.max(...points.map((q) => Math.abs(q.x)), ...points.map((q) => Math.abs(q.y)), 1);
  const minArea = 1e-12 * span * span;
  let last: [number, number, number] | undefined = map.triangles()[0];
  const walk = (p: Point2): [number, number, number] | undefined => {
    let current = last;
    for (let step = 0; current && step < 4 * points.length + 16; step++) {
      const [a, b, c]: [number, number, number] = current;
      if (map.opp(a, b) !== c) {
        break;
      }
      let moved = false;
      for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
        if (orient(points[x]!, points[y]!, p) < 0) {
          const w = map.opp(y, x);
          // The walk has reached the polygon's edge, which can happen in a concave region.
          if (w === undefined) {
            return map.triangles().find((t) => closedInTriangle(p, points[t[0]]!, points[t[1]]!, points[t[2]]!));
          }
          current = [y, x, w];
          moved = true;
          break;
        }
      }
      if (!moved) {
        return current;
      }
    }
    return map.triangles().find((t) => closedInTriangle(p, points[t[0]]!, points[t[1]]!, points[t[2]]!));
  };
  for (const id of interior) {
    const p = points[id]!;
    const host = walk(p);
    if (!host) {
      continue;
    }
    const [a, b, c] = host;
    // Grid points often land exactly on an edge between earlier ones. Inserting one in the triangle
    // would make a flat triangle, so divide the edge and both its triangles instead.
    const flatSide = ([[a, b, c], [b, c, a], [c, a, b]] as const).find(([x, y]) => orient(points[x]!, points[y]!, p) <= minArea);
    if (flatSide) {
      const [x, y, z] = flatSide;
      const w = map.opp(y, x);
      if (w === undefined || map.isFixed(x, y)) {
        continue;
      }
      map.remove(x, y, z);
      map.remove(y, x, w);
      map.add(x, id, z);
      map.add(id, y, z);
      map.add(y, id, w);
      map.add(id, x, w);
      last = [x, id, z];
      map.legalize([[y, z], [z, x], [x, w], [w, y]]);
      continue;
    }
    map.remove(a, b, c);
    map.add(a, b, id);
    map.add(b, c, id);
    map.add(c, a, id);
    map.legalize([[a, b], [b, c], [c, a]]);
    last = triangleAt(map, id, a, b);
  }
  return map.triangles();
}
