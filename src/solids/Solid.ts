import { BoundingBox3, Vector3, type Transform3 } from 'meercad-surfaces';
import type { ICurve } from 'meercad-curves';
import { booleanOperation, type BooleanKind } from '../algorithms/boolean.js';
import { BooleanError } from '../algorithms/booleanError.js';
import { integrateFace } from '../algorithms/integrate.js';
import { classifySolidPoint, closestSolidPoint, intersectSolidCurve, intersectSolidLine, sectionSolid } from '../algorithms/queries.js';
import { solidToJSON } from './json.js';
import { Edge, Face, flipShells, Shell, transformShells, Vertex } from '../topology/Topology.js';
import type {
  BooleanOptions,
  ClosestSolidPoint,
  ISolid,
  MassProperties,
  PointClassification,
  SolidFaceMesh,
  SolidHit,
  SolidJSON,
  SolidMesh,
  SolidSection,
  SolidTessellationOptions,
  SolidValidation,
} from './ISolid.js';

/** Determinant of a transform's linear part. Negative for a reflection. */
function determinant(t: Transform3): number {
  const m = t.linear;
  return (
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
  );
}

/** True if each mesh edge lies in exactly two triangles, running opposite ways. */
function meshIsClosed(mesh: SolidMesh): boolean {
  const uses = new Map<number, number>();
  const stride = mesh.points.length + 1;
  const { triangles } = mesh;
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const key = triangles[t + k]! * stride + triangles[t + ((k + 1) % 3)]!;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of uses) {
    const a = Math.floor(key / stride);
    const b = key - a * stride;
    if (count !== 1 || uses.get(b * stride + a) !== 1) {
      return false;
    }
  }
  return true;
}

/** A low-discrepancy sequence, whose points spread evenly without falling on any grid of the model. */
function halton(index: number, base: number): number {
  let [f, r, i] = [1, 0, index];
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * A closed solid can still enclose the wrong region. So compare the result with what the two inputs
 * imply at points spread through their bounding box, leaving out points too close to any boundary.
 */
function agreesWithInputs(result: ISolid, a: ISolid, b: ISolid, kind: BooleanKind, count = 48): boolean {
  const [p, q] = [a.boundingBox(), b.boundingBox()];
  const min = new Vector3(Math.min(p.min.x, q.min.x), Math.min(p.min.y, q.min.y), Math.min(p.min.z, q.min.z));
  const max = new Vector3(Math.max(p.max.x, q.max.x), Math.max(p.max.y, q.max.y), Math.max(p.max.z, q.max.z));
  const margin = 1e-3 * Math.max(p.diagonal, q.diagonal);
  for (let i = 1; i <= count; i++) {
    const point = new Vector3(
      min.x + (max.x - min.x) * halton(i, 2),
      min.y + (max.y - min.y) * halton(i, 3),
      min.z + (max.z - min.z) * halton(i, 5),
    );
    const inA = a.classifyPoint(point, margin);
    const inB = b.classifyPoint(point, margin);
    if (inA === 'boundary' || inB === 'boundary') {
      continue;
    }
    const held = result.classifyPoint(point, margin);
    if (held === 'boundary') {
      continue;
    }
    const [x, y] = [inA === 'inside', inB === 'inside'];
    const expected = kind === 'union' ? x || y : kind === 'intersection' ? x && y : x && !y;
    if ((held === 'inside') !== expected) {
      return false;
    }
  }
  return true;
}

/** Area, volume and the first and second moments, about a reference point. */
interface Moments {
  readonly area: number;
  readonly volume: number;
  readonly first: Vector3;
  readonly xx: number;
  readonly yy: number;
  readonly zz: number;
  readonly xy: number;
  readonly yz: number;
  readonly zx: number;
  readonly origin: Vector3;
}

/** A boundary-representation solid. Every solid in this library is one of these. */
export class Solid implements ISolid {
  readonly shells: readonly Shell[];
  readonly type: string;
  private moments: Moments | undefined;
  private box: BoundingBox3 | undefined;
  private meshes = new Map<number, SolidMesh>();

  constructor(shells: readonly Shell[], type = 'Solid') {
    if (shells.length === 0 || shells.some((s) => s.faces.length === 0)) {
      throw new RangeError('A solid needs at least one shell with at least one face.');
    }
    this.shells = shells;
    this.type = type;
  }

  /** A copy of the solid made with its normals flipped: how a builder corrects a wrong orientation. */
  protected static outwards(shells: readonly Shell[]): readonly Shell[] {
    const probe = new Solid(shells);
    return probe.signedVolume() < 0 ? flipShells(shells) : shells;
  }

  get faces(): readonly Face[] {
    return this.shells.flatMap((s) => s.faces);
  }

  get edges(): readonly Edge[] {
    const seen = new Set<Edge>();
    for (const face of this.faces) {
      for (const loop of face.loops) {
        for (const c of loop.coedges) {
          seen.add(c.edge);
        }
      }
    }
    return [...seen];
  }

  get vertices(): readonly Vertex[] {
    const seen = new Set<Vertex>();
    for (const e of this.edges) {
      seen.add(e.start);
      seen.add(e.end);
    }
    return [...seen];
  }

  facesOfEdge(edge: Edge): Face[] {
    return this.faces.filter((f) => f.loops.some((l) => l.coedges.some((c) => c.edge === edge)));
  }

  edgesOfVertex(vertex: Vertex): Edge[] {
    return this.edges.filter((e) => e.start === vertex || e.end === vertex);
  }

  neighboursOfFace(face: Face): Face[] {
    const mine = new Set(face.loops.flatMap((l) => l.coedges.map((c) => c.edge)));
    return this.faces.filter((f) => f !== face && f.loops.some((l) => l.coedges.some((c) => mine.has(c.edge))));
  }

  get eulerCharacteristic(): number {
    const edges = this.edges.filter((e) => !e.isDegenerate).length;
    const loops = this.faces.reduce((n, f) => n + f.loops.length, 0);
    return this.vertices.length - edges + 2 * this.faces.length - loops;
  }

  get genus(): number {
    return this.shells.length - this.eulerCharacteristic / 2;
  }

  get isClosed(): boolean {
    const uses = new Map<Edge, number>();
    for (const face of this.faces) {
      for (const loop of face.loops) {
        for (const c of loop.coedges) {
          if (!c.edge.isDegenerate) {
            uses.set(c.edge, (uses.get(c.edge) ?? 0) + (c.forward ? 1 : 1000));
          }
        }
      }
    }
    return [...uses.values()].every((n) => n === 1001);
  }

  validate(): SolidValidation {
    const problems: string[] = [];
    if (!this.isClosed) {
      problems.push('Some edge is not used exactly twice, in opposite directions.');
    }
    const size = Math.max(this.boundingBox().diagonal, 1e-300);
    const tolerance = 1e-6 * size;
    this.faces.forEach((face, f) => {
      if (face.outer.signedArea() <= 0) {
        problems.push(`Face ${f} has an outer loop that is not counter-clockwise in its parameters.`);
      }
      for (const hole of face.holes) {
        if (hole.signedArea() >= 0) {
          problems.push(`Face ${f} has a hole that is not clockwise in its parameters.`);
        }
      }
      for (const loop of face.loops) {
        loop.coedges.forEach((c, i) => {
          const next = loop.coedges[(i + 1) % loop.coedges.length]!;
          const end = c.forward ? c.edge.end : c.edge.start;
          const start = next.forward ? next.edge.start : next.edge.end;
          if (end !== start) {
            problems.push(`Face ${f} has a loop whose edges don't connect.`);
          }
          for (const s of [0, 0.3, 0.7, 1]) {
            const t = c.edge.t0 + (c.edge.t1 - c.edge.t0) * s;
            const q = c.uvAt(t);
            const gap = face.surface.pointAt(q.u, q.v).distanceTo(c.edge.pointAt(t));
            if (gap > Math.max(tolerance * 1e3, 5 * size * 2e-3)) {
              problems.push(`Face ${f} has an edge that lies ${gap} away from its surface.`);
              break;
            }
          }
        });
      }
    });
    if (!(this.volume > 0)) {
      problems.push('The volume is not positive, so the normals may point inwards.');
    }
    if (problems.length === 0 && !meshIsClosed(this.tessellate())) {
      problems.push('The faces cannot be meshed into a closed surface.');
    }
    return { valid: problems.length === 0, problems };
  }

  /** Integrates all the moments once, about the centre of the bounding box. */
  private allMoments(): Moments {
    if (!this.moments) {
      const origin = this.boundingBox().center;
      const size = this.boundingBox().diagonal;
      const totals = new Array<number>(11).fill(0);
      for (const face of this.faces) {
        const { surface } = face;
        const values = integrateFace(
          face,
          (u, v) => {
            const r = surface.pointAt(u, v).sub(origin);
            const n = surface.derivativeAt(u, v, 1, 0).cross(surface.derivativeAt(u, v, 0, 1));
            const [x, y, z] = [r.x, r.y, r.z];
            return [
              n.length,
              (x * n.x + y * n.y + z * n.z) / 3,
              (x * x * n.x) / 2,
              (y * y * n.y) / 2,
              (z * z * n.z) / 2,
              (x * x * x * n.x) / 3,
              (y * y * y * n.y) / 3,
              (z * z * z * n.z) / 3,
              (x * x * y * n.x) / 2,
              (y * y * z * n.y) / 2,
              (z * z * x * n.z) / 2,
            ];
          },
          size,
          11,
        );
        values.forEach((value, k) => {
          totals[k]! += value;
        });
      }
      this.moments = {
        area: totals[0]!,
        volume: totals[1]!,
        first: new Vector3(totals[2]!, totals[3]!, totals[4]!),
        xx: totals[5]!,
        yy: totals[6]!,
        zz: totals[7]!,
        xy: totals[8]!,
        yz: totals[9]!,
        zx: totals[10]!,
        origin,
      };
    }
    return this.moments;
  }

  /** The volume with its sign. Negative if the normals point inwards. */
  signedVolume(): number {
    return this.allMoments().volume;
  }

  get volume(): number {
    return Math.abs(this.signedVolume());
  }

  get surfaceArea(): number {
    return this.allMoments().area;
  }

  get centroid(): Vector3 {
    const m = this.allMoments();
    return m.origin.addScaled(m.first, 1 / m.volume);
  }

  massProperties(density = 1): MassProperties {
    if (!(density > 0)) {
      throw new RangeError('Density must be positive.');
    }
    const m = this.allMoments();
    const c = m.first.scale(1 / m.volume);
    // From second moments about the reference point to the inertia tensor about the centroid.
    const [xx, yy, zz] = [m.xx - m.volume * c.x * c.x, m.yy - m.volume * c.y * c.y, m.zz - m.volume * c.z * c.z];
    const [xy, yz, zx] = [m.xy - m.volume * c.x * c.y, m.yz - m.volume * c.y * c.z, m.zx - m.volume * c.z * c.x];
    return {
      volume: m.volume,
      mass: m.volume * density,
      centroid: m.origin.add(c),
      inertia: {
        xx: density * (yy + zz),
        yy: density * (zz + xx),
        zz: density * (xx + yy),
        xy: -density * xy,
        yz: -density * yz,
        zx: -density * zx,
      },
    };
  }

  boundingBox(): BoundingBox3 {
    if (!this.box) {
      this.box = BoundingBox3.fromPoints(this.faces.flatMap((f) => f.extremePoints()));
    }
    return this.box;
  }

  tessellate(options: SolidTessellationOptions = {}): SolidMesh {
    const chord = options.chordTolerance ?? this.boundingBox().diagonal / 200;
    if (!(chord > 0)) {
      throw new RangeError('Chord tolerance must be positive.');
    }
    const cached = this.meshes.get(chord);
    if (cached) {
      return cached;
    }
    // Chords of two boundary curves meeting at a sharp angle can cross, which leaves the mesh open.
    // Dividing every boundary more finely cures that while keeping shared edges matched.
    let result = this.buildMesh(chord, chord);
    for (let edgeChord = chord / 3, pass = 0; pass < 5 && !meshIsClosed(result); edgeChord /= 3, pass++) {
      result = this.buildMesh(chord, edgeChord);
    }
    this.meshes.set(chord, result);
    return result;
  }

  private buildMesh(chord: number, edgeChord: number): SolidMesh {
    const points: Vector3[] = [];
    const triangles: number[] = [];
    const triangleFaces: number[] = [];
    const faces: SolidFaceMesh[] = [];
    const shared = new Map<string, number>();
    this.faces.forEach((face, f) => {
      const mesh = face.tessellate(chord, edgeChord);
      const index = mesh.points.map((p, i) => {
        const key = mesh.pointKeys[i]!;
        if (key === '') {
          points.push(p);
          return points.length - 1;
        }
        let id = shared.get(key);
        if (id === undefined) {
          id = points.length;
          points.push(p);
          shared.set(key, id);
        }
        return id;
      });
      for (let t = 0; t < mesh.triangles.length; t += 3) {
        const [a, b, c] = [index[mesh.triangles[t]!]!, index[mesh.triangles[t + 1]!]!, index[mesh.triangles[t + 2]!]!];
        if (a !== b && b !== c && c !== a) {
          triangles.push(a, b, c);
          triangleFaces.push(f);
        }
      }
      faces.push({ face, points: mesh.points, normals: mesh.normals, triangles: mesh.triangles });
    });
    return { points, triangles, triangleFaces, faces };
  }

  classifyPoint(point: Vector3, tolerance?: number): PointClassification {
    return classifySolidPoint(this, point, tolerance);
  }

  containsPoint(point: Vector3, tolerance?: number): boolean {
    return this.classifyPoint(point, tolerance) !== 'outside';
  }

  closestPoint(point: Vector3): ClosestSolidPoint {
    return closestSolidPoint(this, point);
  }

  distanceTo(point: Vector3): number {
    return this.closestPoint(point).distance;
  }

  intersectCurve(curve: ICurve, tolerance?: number): SolidHit[] {
    return intersectSolidCurve(this, curve, tolerance);
  }

  intersectLine(origin: Vector3, direction: Vector3, tolerance?: number): SolidHit[] {
    return intersectSolidLine(this, origin, direction, tolerance);
  }

  section(origin: Vector3, normal: Vector3, chordTolerance?: number): SolidSection {
    return sectionSolid(this, origin, normal, chordTolerance);
  }

  transformed(transform: Transform3): ISolid {
    return new Solid(transformShells(this.shells, transform, determinant(transform) < 0));
  }

  private combine(other: ISolid, kind: BooleanKind, options?: BooleanOptions): ISolid | undefined {
    // Whether an intersection curve is found whole can depend on where the search mesh happens to fall.
    // So check each result, and look again with a finer mesh before giving up.
    const base = options?.meshTolerance ?? Math.min(this.boundingBox().diagonal, other.boundingBox().diagonal) / 150;
    let failure = 'The result failed validation.';
    for (const divisor of [1, 2, 3, 5, 8]) {
      try {
        const shells = booleanOperation(this, other, kind, { ...options, meshTolerance: base / divisor });
        if (!shells) {
          return undefined;
        }
        const result = new Solid(shells);
        const report = result.validate();
        if (!report.valid) {
          failure = report.problems[0]!;
        } else if (!agreesWithInputs(result, this, other, kind)) {
          failure = 'The result is closed, but disagrees with the two solids about which points it holds.';
        } else {
          return result;
        }
      } catch (error) {
        if (!(error instanceof BooleanError)) {
          throw error;
        }
        failure = error.message;
      }
    }
    throw new BooleanError(failure);
  }

  union(other: ISolid, options?: BooleanOptions): ISolid {
    return this.combine(other, 'union', options)!;
  }

  intersection(other: ISolid, options?: BooleanOptions): ISolid | undefined {
    return this.combine(other, 'intersection', options);
  }

  difference(other: ISolid, options?: BooleanOptions): ISolid | undefined {
    return this.combine(other, 'difference', options);
  }

  equals(other: ISolid, tolerance = 1e-6): boolean {
    if (
      this.faces.length !== other.faces.length ||
      this.edges.length !== other.edges.length ||
      this.vertices.length !== other.vertices.length ||
      Math.abs(this.volume - other.volume) > tolerance * Math.max(this.volume, other.volume, 1)
    ) {
      return false;
    }
    const size = this.boundingBox().diagonal;
    return this.vertices.every((a) => other.vertices.some((b) => a.point.distanceTo(b.point) <= tolerance * Math.max(size, 1)));
  }

  toJSON(): SolidJSON {
    return solidToJSON(this);
  }
}
