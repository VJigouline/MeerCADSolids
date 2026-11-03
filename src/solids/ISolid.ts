import type { BoundingBox3, Transform3, Vector3 } from 'meercad-surfaces';
import type { ICurve } from 'meercad-curves';
import type { Edge, Face, Shell, Vertex } from '../topology/Topology.js';

/** Where a point lies relative to a solid. */
export type PointClassification = 'inside' | 'outside' | 'boundary';

/** Volume, centroid and inertia of a solid of uniform density. */
export interface MassProperties {
  readonly volume: number;
  readonly mass: number;
  readonly centroid: Vector3;
  /** Inertia tensor about the centroid, in the world axes. */
  readonly inertia: {
    readonly xx: number;
    readonly yy: number;
    readonly zz: number;
    readonly xy: number;
    readonly yz: number;
    readonly zx: number;
  };
}

export interface SolidTessellationOptions {
  /** Maximum distance between the solid and its triangles. Default: 1/200 of the bounding-box diagonal. */
  readonly chordTolerance?: number;
}

/** The triangles of one face, for display. Points are not shared with other faces. */
export interface SolidFaceMesh {
  readonly face: Face;
  readonly points: readonly Vector3[];
  readonly normals: readonly Vector3[];
  readonly triangles: readonly number[];
}

/**
 * A closed triangle mesh of a solid. `points` and `triangles` are welded, so each mesh edge lies in
 * exactly two triangles, and winding faces outwards. `faces` holds separate per-face meshes for display.
 */
export interface SolidMesh {
  readonly points: readonly Vector3[];
  readonly triangles: readonly number[];
  /** The index of the face each triangle comes from. */
  readonly triangleFaces: readonly number[];
  readonly faces: readonly SolidFaceMesh[];
}

export interface ClosestSolidPoint {
  readonly point: Vector3;
  readonly distance: number;
  /** The face the point lies on. */
  readonly face: Face;
  readonly u: number;
  readonly v: number;
}

/** A crossing of a curve and the solid's boundary. */
export interface SolidHit {
  readonly point: Vector3;
  /** Parameter on the curve; for `intersectLine`, the signed distance from the line's origin. */
  readonly t: number;
  readonly face: Face;
  readonly u: number;
  readonly v: number;
}

/** A cross-section by a plane. */
export interface SolidSection {
  /** Polylines around the cut. Holes run the opposite way to outer loops, seen along the plane's normal. */
  readonly loops: readonly (readonly Vector3[])[];
  /** The area of the cut, with holes subtracted. */
  readonly area: number;
}

export interface BooleanOptions {
  /** Distance below which points count as the same. Default: 1e-7 of the larger bounding-box diagonal. */
  readonly tolerance?: number;
  /** Chord tolerance of the meshes that find curved intersections. Default: 1/150 of the smaller diagonal. */
  readonly meshTolerance?: number;
}

/** The outcome of checking a solid's topology and geometry. */
export interface SolidValidation {
  readonly valid: boolean;
  /** One sentence per problem found. */
  readonly problems: readonly string[];
}

/** JSON form of a solid. Read it back with `solidFromJSON`. */
export interface SolidJSON {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * The interface every solid implements. A solid is a boundary representation: shells of faces,
 * each a region of a surface bounded by loops of edges, sharing vertices.
 *
 * Solids are immutable. Operations such as `transformed` and `union` return new solids.
 */
export interface ISolid {
  /** Class name, such as `BoxSolid`. A boolean result or a transformed copy is a `Solid`. */
  readonly type: string;

  readonly shells: readonly Shell[];
  readonly faces: readonly Face[];
  /** Every edge, including degenerate ones at poles. */
  readonly edges: readonly Edge[];
  readonly vertices: readonly Vertex[];

  /** Faces meeting an edge. */
  facesOfEdge(edge: Edge): Face[];
  /** Edges meeting a vertex. */
  edgesOfVertex(vertex: Vertex): Edge[];
  /** Faces sharing an edge with this one. */
  neighboursOfFace(face: Face): Face[];

  /** `V - E + 2F - L`, by the Euler-Poincare formula, leaving out degenerate edges. */
  readonly eulerCharacteristic: number;
  /** Number of through-holes, if every shell has the same genus; the total over the shells otherwise. */
  readonly genus: number;
  /** True if every edge is used exactly twice, in opposite directions. */
  readonly isClosed: boolean;
  /** Checks the topology, the orientation and the agreement between edges and surfaces. */
  validate(): SolidValidation;

  readonly volume: number;
  readonly surfaceArea: number;
  readonly centroid: Vector3;
  massProperties(density?: number): MassProperties;

  boundingBox(): BoundingBox3;
  tessellate(options?: SolidTessellationOptions): SolidMesh;

  /** Where a point lies. `tolerance` is the distance from the boundary that counts as on it. */
  classifyPoint(point: Vector3, tolerance?: number): PointClassification;
  /** True if the point lies inside or on the boundary. */
  containsPoint(point: Vector3, tolerance?: number): boolean;
  /** The closest point on the boundary. */
  closestPoint(point: Vector3): ClosestSolidPoint;
  /** Distance to the boundary. For a point inside, this is the distance to the surface, not zero. */
  distanceTo(point: Vector3): number;
  /** Where a curve crosses the boundary, sorted by `t`. */
  intersectCurve(curve: ICurve, tolerance?: number): SolidHit[];
  /** Where an infinite line crosses the boundary, sorted along `direction`. */
  intersectLine(origin: Vector3, direction: Vector3, tolerance?: number): SolidHit[];
  /** The cross-section by a plane. */
  section(origin: Vector3, normal: Vector3, chordTolerance?: number): SolidSection;

  /** The solid under an affine transform. A reflection keeps the normals pointing outwards. */
  transformed(transform: Transform3): ISolid;

  /** The union with another solid. Throws `BooleanError` where it can't give a valid result. */
  union(other: ISolid, options?: BooleanOptions): ISolid;
  /** The common part with another solid, or `undefined` if there is none. */
  intersection(other: ISolid, options?: BooleanOptions): ISolid | undefined;
  /** This solid with another taken away, or `undefined` if nothing is left. */
  difference(other: ISolid, options?: BooleanOptions): ISolid | undefined;

  /** True if the topology counts, volume and vertices agree within the tolerance. */
  equals(other: ISolid, tolerance?: number): boolean;
  toJSON(): SolidJSON;
}
