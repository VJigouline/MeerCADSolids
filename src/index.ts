// The shared math types come from the other libraries, so one set works with all three.
export { BoundingBox3, Frame3, Transform3, Vector3 } from 'meercad-surfaces';

export type {
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
} from './solids/ISolid.js';

export { Coedge, Edge, Face, Loop, Shell, Vertex } from './topology/Topology.js';
export type { FaceMesh } from './topology/Topology.js';

export { Solid } from './solids/Solid.js';
export {
  BoxSolid,
  ConeSolid,
  CylinderSolid,
  EllipsoidSolid,
  HollowSphereSolid,
  PolyhedronSolid,
  PyramidSolid,
  RegularPrismSolid,
  SphereSolid,
  TorusSolid,
  TubeSolid,
  WedgeSolid,
} from './solids/Primitives.js';
export { CapsuleSolid, ExtrudedSolid, LoftedSolid, PipeSolid, RevolvedSolid, SweptSolid } from './solids/Generated.js';
export type { LoftOptions, Profile, RevolveOptions } from './solids/Generated.js';

export { BooleanError } from './algorithms/booleanError.js';
export { solidFromJSON } from './solids/serialization.js';
