import { CircularArc, Line } from 'meercad-curves';
import { describe, expect, it } from 'vitest';
import {
  BoxSolid,
  CapsuleSolid,
  ConeSolid,
  CylinderSolid,
  EllipsoidSolid,
  ExtrudedSolid,
  Face,
  Frame3,
  HollowSphereSolid,
  LoftedSolid,
  PipeSolid,
  PolyhedronSolid,
  PyramidSolid,
  RegularPrismSolid,
  RevolvedSolid,
  Shell,
  Solid,
  solidFromJSON,
  SphereSolid,
  SweptSolid,
  TorusSolid,
  Transform3,
  TubeSolid,
  Vector3,
  WedgeSolid,
} from '../src/index.js';
import { triangulate } from '../src/math/triangulate.js';
import { tilted } from './catalog.js';
import { expectPoint, monteCarloVolume, v } from './helpers.js';

const PI = Math.PI;
const world = Frame3.WORLD;

describe('topology', () => {
  it('counts the parts of a box', () => {
    const box = new BoxSolid(world, 1, 2, 3);
    expect([box.vertices.length, box.edges.length, box.faces.length]).toEqual([8, 12, 6]);
    expect(box.eulerCharacteristic).toBe(2);
    expect(box.genus).toBe(0);
    expect(box.shells.length).toBe(1);
  });

  it('knows who touches what on a box', () => {
    const box = new BoxSolid(world, 1, 2, 3);
    for (const edge of box.edges) {
      expect(box.facesOfEdge(edge)).toHaveLength(2);
    }
    for (const vertex of box.vertices) {
      expect(box.edgesOfVertex(vertex)).toHaveLength(3);
    }
    for (const face of box.faces) {
      expect(box.neighboursOfFace(face)).toHaveLength(4);
    }
  });

  it.each([
    ['tetrahedron', () => PolyhedronSolid.tetrahedron(1), 4, 6, 4],
    ['octahedron', () => PolyhedronSolid.octahedron(1), 6, 12, 8],
    ['icosahedron', () => PolyhedronSolid.icosahedron(1), 12, 30, 20],
    ['dodecahedron', () => PolyhedronSolid.dodecahedron(1), 20, 30, 12],
  ])('has the right counts for a regular %s', (_name, make, vertices, edges, faces) => {
    const s = make();
    expect([s.vertices.length, s.edges.length, s.faces.length]).toEqual([vertices, edges, faces]);
    expect(s.eulerCharacteristic).toBe(2);
  });

  it('represents curved solids with seams and poles', () => {
    const cylinder = new CylinderSolid(world, 1, 1);
    expect([cylinder.vertices.length, cylinder.edges.length, cylinder.faces.length]).toEqual([2, 3, 3]);
    const sphere = new SphereSolid(world, 1);
    expect(sphere.faces).toHaveLength(1);
    expect(sphere.edges.filter((e) => e.isDegenerate)).toHaveLength(2);
    expect(sphere.eulerCharacteristic).toBe(2);
    const cone = new ConeSolid(world, 1, 0, 1);
    expect(cone.faces).toHaveLength(2);
    expect(cone.edges.filter((e) => e.isDegenerate)).toHaveLength(1);
  });

  it('counts holes and cavities', () => {
    expect(new TorusSolid(world, 3, 1).genus).toBe(1);
    expect(new TubeSolid(world, 2, 1, 1).genus).toBe(1);
    expect(new HollowSphereSolid(world, 2, 1).shells).toHaveLength(2);
    expect(new HollowSphereSolid(world, 2, 1).genus).toBe(0);
  });
});

describe('validation', () => {
  it('notices a missing face', () => {
    const box = new BoxSolid(world, 1, 1, 1);
    const open = new Solid([new Shell(box.faces.slice(1))]);
    expect(open.isClosed).toBe(false);
    const report = open.validate();
    expect(report.valid).toBe(false);
    expect(report.problems.join(' ')).toMatch(/used exactly twice/);
  });

  it('notices a face turned the wrong way', () => {
    const box = new BoxSolid(world, 1, 1, 1);
    const f = box.faces[0]!;
    const turned = new Face(f.surface.reversed(), f.outer);
    const report = new Solid([new Shell([turned, ...box.faces.slice(1)])]).validate();
    expect(report.valid).toBe(false);
  });

  it('notices a solid inside out', () => {
    const box = new BoxSolid(world, 1, 1, 1);
    const inside = box.transformed(Transform3.mirror(Vector3.X)) as Solid;
    expect(inside.signedVolume()).toBeGreaterThan(0);
    expect(() => new PolyhedronSolid([v(0, 0), v(1, 0), v(0, 1), v(0, 0, 1)], [[0, 2, 1], [0, 3, 2], [0, 1, 3], [1, 2, 3]].map((f) => [...f].reverse()))).toThrow(RangeError);
  });

  it('refuses a solid with nothing in it', () => {
    expect(() => new Solid([])).toThrow(RangeError);
    expect(() => new Solid([new Shell([])])).toThrow(RangeError);
  });
});

describe('mass properties', () => {
  it('matches the textbook for a box', () => {
    const [a, b, c] = [2, 3, 4];
    const m = new BoxSolid(Frame3.fromNormal(v(5, 6, 7)), a, b, c).massProperties(2);
    expect(m.volume).toBeCloseTo(24, 9);
    expect(m.mass).toBeCloseTo(48, 9);
    expectPoint(m.centroid, v(6, 7.5, 9), 1e-9);
    expect(m.inertia.xx).toBeCloseTo((48 * (b * b + c * c)) / 12, 7);
    expect(m.inertia.yy).toBeCloseTo((48 * (a * a + c * c)) / 12, 7);
    expect(m.inertia.zz).toBeCloseTo((48 * (a * a + b * b)) / 12, 7);
    expect(m.inertia.xy).toBeCloseTo(0, 7);
    expect(m.inertia.yz).toBeCloseTo(0, 7);
    expect(m.inertia.zx).toBeCloseTo(0, 7);
  });

  it('matches the textbook for a sphere', () => {
    const r = 2;
    const m = SphereSolid.centredAt(v(1, 2, 3), r).massProperties();
    const moment = (2 / 5) * m.mass * r * r;
    expect(m.volume).toBeCloseTo((4 / 3) * PI * 8, 7);
    expectPoint(m.centroid, v(1, 2, 3), 1e-8);
    expect(m.inertia.xx / moment).toBeCloseTo(1, 7);
    expect(m.inertia.yy / moment).toBeCloseTo(1, 7);
    expect(m.inertia.zz / moment).toBeCloseTo(1, 7);
  });

  it('matches the textbook for a cylinder', () => {
    const [r, h] = [1.5, 4];
    const m = new CylinderSolid(world, r, h).massProperties();
    expectPoint(m.centroid, v(0, 0, 2), 1e-8);
    expect(m.inertia.zz / ((m.mass * r * r) / 2)).toBeCloseTo(1, 7);
    expect(m.inertia.xx / ((m.mass * (3 * r * r + h * h)) / 12)).toBeCloseTo(1, 7);
  });

  it('matches the textbook for a cone', () => {
    const [r, h] = [2, 3];
    const m = new ConeSolid(world, r, 0, h).massProperties();
    expectPoint(m.centroid, v(0, 0, h / 4), 1e-8);
    expect(m.inertia.zz / ((3 / 10) * m.mass * r * r)).toBeCloseTo(1, 7);
  });

  it('matches the textbook for a torus', () => {
    const [R, r] = [3, 1];
    const m = new TorusSolid(world, R, r).massProperties();
    expect(m.inertia.zz / (m.mass * (R * R + (3 / 4) * r * r))).toBeCloseTo(1, 6);
    expect(m.inertia.xx / (m.mass * ((1 / 2) * R * R + (5 / 8) * r * r))).toBeCloseTo(1, 6);
  });

  it('turns an inertia tensor with its solid', () => {
    // A long bar turned 45 degrees about Z has equal xx and yy and a non-zero product.
    const bar = new BoxSolid(Frame3.fromNormal(v(-2, -0.5, -0.5)), 4, 1, 1).transformed(Transform3.rotate(Vector3.Z, PI / 4));
    const m = bar.massProperties();
    expect(m.inertia.xx).toBeCloseTo(m.inertia.yy, 7);
    expect(Math.abs(m.inertia.xy)).toBeGreaterThan(0.5);
  });

  it('subtracts a cavity', () => {
    const hollow = new HollowSphereSolid(world, 3, 1);
    expect(hollow.volume).toBeCloseTo((4 / 3) * PI * 26, 6);
    expectPoint(hollow.centroid, v(0, 0, 0), 1e-7);
    expect(hollow.surfaceArea).toBeCloseTo(4 * PI * 10, 6);
  });
});

describe('point queries', () => {
  const box = new BoxSolid(world, 2, 2, 2);
  const sphere = new SphereSolid(world, 2);

  it('classifies points against a box, including tilted faces', () => {
    expect(box.classifyPoint(v(1, 1, 1))).toBe('inside');
    expect(box.classifyPoint(v(3, 1, 1))).toBe('outside');
    expect(box.classifyPoint(v(2, 1, 1))).toBe('boundary');
    expect(box.classifyPoint(v(2, 2, 2))).toBe('boundary');
    expect(box.classifyPoint(v(1.999, 1, 1))).toBe('inside');
    expect(box.classifyPoint(v(2.001, 1, 1))).toBe('outside');
    expect(box.classifyPoint(v(2.1, 1, 1), 0.2)).toBe('boundary');
  });

  it('classifies points against a sphere, closer than its mesh can resolve', () => {
    expect(sphere.classifyPoint(v(1.9999, 0, 0))).toBe('inside');
    expect(sphere.classifyPoint(v(2.0001, 0, 0))).toBe('outside');
    expect(sphere.classifyPoint(v(0, 0, 1.9999))).toBe('inside');
    expect(sphere.classifyPoint(v(0, 0, 2.0001))).toBe('outside');
    expect(sphere.classifyPoint(v(0, 0, 0))).toBe('inside');
  });

  it('classifies points in a hole and a cavity', () => {
    const tube = new TubeSolid(world, 2, 1, 3);
    expect(tube.classifyPoint(v(0, 0, 1))).toBe('outside');
    expect(tube.classifyPoint(v(1.5, 0, 1))).toBe('inside');
    const hollow = new HollowSphereSolid(world, 3, 1);
    expect(hollow.classifyPoint(v(0, 0, 0))).toBe('outside');
    expect(hollow.classifyPoint(v(2, 0, 0))).toBe('inside');
    expect(hollow.classifyPoint(v(1, 0, 0))).toBe('boundary');
  });

  it('agrees with a grid count on the volume', () => {
    expect(monteCarloVolume(new TorusSolid(world, 3, 1)) / (2 * PI * PI * 3)).toBeCloseTo(1, 1);
    expect(monteCarloVolume(new TubeSolid(world, 2, 1, 3)) / (PI * 3 * 3)).toBeCloseTo(1, 1);
  });

  it('finds the closest point on faces, edges and corners', () => {
    expect(box.closestPoint(v(5, 1, 1)).distance).toBeCloseTo(3, 9);
    expectPoint(box.closestPoint(v(5, 5, 1)).point, v(2, 2, 1), 1e-7);
    expectPoint(box.closestPoint(v(5, 5, 5)).point, v(2, 2, 2), 1e-7);
    expect(box.distanceTo(v(1, 1, 1))).toBeCloseTo(1, 9);
    expect(sphere.distanceTo(v(5, 0, 0))).toBeCloseTo(3, 7);
    expect(sphere.distanceTo(v(1, 0, 0))).toBeCloseTo(1, 7);
    const cylinder = new CylinderSolid(world, 1, 2);
    expect(cylinder.distanceTo(v(3, 0, 1))).toBeCloseTo(2, 7);
    expect(cylinder.distanceTo(v(0.5, 0, 5))).toBeCloseTo(3, 7);
    expect(cylinder.distanceTo(v(3, 0, 5))).toBeCloseTo(Math.hypot(2, 3), 6);
  });
});

describe('intersections', () => {
  it('crosses a sphere twice, reporting the distance along the line', () => {
    const hits = new SphereSolid(world, 2).intersectLine(v(-5, 0.3, 0.2), Vector3.X);
    expect(hits).toHaveLength(2);
    const d = Math.sqrt(4 - 0.09 - 0.04);
    expect(hits[0]!.t).toBeCloseTo(5 - d, 6);
    expect(hits[1]!.t).toBeCloseTo(5 + d, 6);
    expectPoint(hits[0]!.face.surface.pointAt(hits[0]!.u, hits[0]!.v), hits[0]!.point, 1e-6);
  });

  it('crosses a box at trimmed faces only', () => {
    const box = new BoxSolid(world, 2, 2, 2);
    expect(box.intersectLine(v(1, 1, -3), Vector3.Z)).toHaveLength(2);
    expect(box.intersectLine(v(5, 5, -3), Vector3.Z)).toHaveLength(0);
    const tube = new TubeSolid(world, 2, 1, 3);
    expect(tube.intersectLine(v(-5, 0.01, 1), Vector3.X)).toHaveLength(4);
    expect(tube.intersectLine(v(0.01, 0.01, -5), Vector3.Z)).toHaveLength(0);
    expect(() => box.intersectLine(v(0, 0), Vector3.ZERO)).toThrow(RangeError);
  });

  it('stops at the end of a finite curve', () => {
    const box = new BoxSolid(world, 2, 2, 2);
    expect(box.intersectCurve(new Line(v(1, 1, 1), v(1, 1, 5)))).toHaveLength(1);
    expect(box.intersectCurve(new Line(v(5, 1, 1), v(9, 1, 1)))).toHaveLength(0);
    const ring = new CircularArc(Frame3.fromNormal(v(1, 1, 1)), 2, 0, 2 * PI);
    expect(box.intersectCurve(ring).length).toBe(0);
    const crossing = new CircularArc(Frame3.fromNormal(v(1, 1, 1)), 1.2, 0, 2 * PI);
    expect(box.intersectCurve(crossing).length).toBe(8);
  });

  it('sections a box, a sphere and a tube to the right area', () => {
    const box = new BoxSolid(world, 2, 3, 4).section(v(1, 1, 2), Vector3.Z);
    expect(box.area).toBeCloseTo(6, 9);
    expect(box.loops).toHaveLength(1);
    const sphere = new SphereSolid(world, 2).section(v(0.05, 0.03, 1), v(0, 0, 1), 1e-3);
    expect(sphere.area / (PI * 3)).toBeCloseTo(1, 3);
    expect(sphere.loops).toHaveLength(1);
    const tube = new TubeSolid(world, 3, 1, 2).section(v(0, 0, 1), Vector3.Z, 1e-3);
    expect(tube.area / (PI * 8)).toBeCloseTo(1, 3);
    expect(tube.loops).toHaveLength(2);
    expect(new BoxSolid(world, 1, 1, 1).section(v(0, 0, 5), Vector3.Z).loops).toHaveLength(0);
    expect(() => new BoxSolid(world, 1, 1, 1).section(v(0, 0, 0), Vector3.ZERO)).toThrow(RangeError);
  });

  it('sections an oblique cut through a cylinder to an ellipse', () => {
    const c = new CylinderSolid(Frame3.fromNormal(v(0, 0, -5)), 1, 10);
    const s = c.section(v(0, 0.01, 0), v(0, 1, 1), 1e-3);
    expect(s.area / (PI * Math.SQRT2)).toBeCloseTo(1, 3);
  });
});

describe('builders', () => {
  it('builds a box from a centre', () => {
    const b = BoxSolid.centred(v(1, 1, 1), 2, 4, 6);
    expectPoint(b.centroid, v(1, 1, 1), 1e-9);
    expect(b.volume).toBeCloseTo(48, 9);
    expectPoint(b.boundingBox().min, v(0, -1, -2), 1e-9);
    expect(() => new BoxSolid(world, 0, 1, 1)).toThrow(RangeError);
  });

  it('checks the sizes of its primitives', () => {
    expect(() => new WedgeSolid(world, 1, 1, 1, 2)).toThrow(RangeError);
    expect(() => new WedgeSolid(world, 0, 1, 1)).toThrow(RangeError);
    expect(() => new PyramidSolid(world, 2, 1, 1)).toThrow(RangeError);
    expect(() => new PyramidSolid(world, 4, 1, 0)).toThrow(RangeError);
    expect(() => new PyramidSolid(world, 4, 1, 1, -1)).toThrow(RangeError);
    expect(() => new RegularPrismSolid(world, 2, 1, 1)).toThrow(RangeError);
    expect(() => new CylinderSolid(world, 0, 1)).toThrow(RangeError);
    expect(() => new CylinderSolid(world, 1, -1)).toThrow(RangeError);
    expect(() => new ConeSolid(world, 0, 0, 1)).toThrow(RangeError);
    expect(() => new ConeSolid(world, 1, 1, 0)).toThrow(RangeError);
    expect(() => new SphereSolid(world, 0)).toThrow(RangeError);
    expect(() => new EllipsoidSolid(world, 1, 0, 1)).toThrow(RangeError);
    expect(() => new TorusSolid(world, 1, 1)).toThrow(RangeError);
    expect(() => new TubeSolid(world, 1, 2, 1)).toThrow(RangeError);
    expect(() => new HollowSphereSolid(world, 1, 1)).toThrow(RangeError);
    expect(() => new CapsuleSolid(world, 0, 1)).toThrow(RangeError);
  });

  it('checks polyhedra', () => {
    const tet = [v(0, 0), v(1, 0), v(0, 1), v(0, 0, 1)];
    expect(() => new PolyhedronSolid(tet, [[0, 1, 2]])).toThrow(RangeError);
    expect(() => new PolyhedronSolid(tet, [[0, 1], [0, 1, 2], [0, 1, 3], [1, 2, 3]])).toThrow(RangeError);
    expect(() => new PolyhedronSolid(tet, [[0, 1, 9], [0, 1, 2], [0, 1, 3], [1, 2, 3]])).toThrow(RangeError);
    expect(() => new PolyhedronSolid(tet, [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 2, 3]])).toThrow(RangeError);
    expect(() => new PolyhedronSolid(tet, [[0, 2, 1], [0, 2, 1], [1, 2, 3], [0, 3, 2]])).toThrow(RangeError);
    expect(() => new PolyhedronSolid([...tet, v(5, 5, 5)], [[0, 1, 4, 2], [0, 3, 1], [1, 3, 2], [0, 2, 3]])).toThrow(RangeError);
  });

  it('checks extrusions', () => {
    const open = [new Line(v(0, 0), v(1, 0)), new Line(v(1, 0), v(1, 1))];
    expect(() => new ExtrudedSolid({ outer: open }, Vector3.Z)).toThrow(RangeError);
    expect(() => new ExtrudedSolid({ outer: [] }, Vector3.Z)).toThrow(RangeError);
    const closed = [...open, new Line(v(1, 1), v(0, 0))];
    expect(() => new ExtrudedSolid({ outer: closed }, Vector3.ZERO)).toThrow(RangeError);
    expect(() => new ExtrudedSolid({ outer: closed }, Vector3.X)).toThrow(RangeError);
    expect(new ExtrudedSolid({ outer: closed }, Vector3.Z).volume).toBeCloseTo(0.5, 9);
  });

  it('checks revolutions', () => {
    const profile = [new Line(v(1, 0, 0), v(2, 0, 0)), new Line(v(2, 0, 0), v(2, 0, 1))];
    expect(() => new RevolvedSolid(profile, v(0, 0), Vector3.Z)).toThrow(RangeError);
    expect(() => new RevolvedSolid([], v(0, 0), Vector3.Z)).toThrow(RangeError);
    const onAxis = [new Line(v(0, 0, 0), v(2, 0, 0)), new Line(v(2, 0, 0), v(0, 0, 1))];
    expect(() => new RevolvedSolid(onAxis, v(0, 0), Vector3.ZERO)).toThrow(RangeError);
    expect(() => new RevolvedSolid(onAxis, v(0, 0), Vector3.Z, { angle: 0 })).toThrow(RangeError);
    expect(() => new RevolvedSolid(onAxis, v(0, 0), Vector3.Z, { angle: 7 })).toThrow(RangeError);
    const gap = [new Line(v(0, 0, 0), v(2, 0, 0)), new Line(v(2.5, 0, 0), v(0, 0, 1))];
    expect(() => new RevolvedSolid(gap, v(0, 0), Vector3.Z)).toThrow(RangeError);
    const touching = [new Line(v(0, 0, 0), v(2, 0, 0)), new Line(v(2, 0, 0), v(0, 0, 1)), new Line(v(0, 0, 1), v(1, 0, 0.5)), new Line(v(1, 0, 0.5), v(0, 0, 0))];
    expect(() => new RevolvedSolid(touching, v(0, 0), Vector3.Z)).toThrow(RangeError);
  });

  it('checks sweeps, pipes and lofts', () => {
    const circle = [CircularArc.circle(v(0, 0), 1)];
    const inPlane = new Line(v(0, 0), v(5, 0));
    expect(() => new SweptSolid({ outer: circle }, inPlane)).toThrow(RangeError);
    const path = new Line(v(0, 0), v(0, 0, 5));
    expect(new SweptSolid({ outer: circle }, path).volume).toBeCloseTo(5 * PI, 5);
    expect(() => new PipeSolid(path, 0)).toThrow(RangeError);
    expect(() => new PipeSolid(path, 1, 1)).toThrow(RangeError);
    expect(new PipeSolid(path, 1, 0.5).volume).toBeCloseTo(5 * PI * 0.75, 5);
    expect(() => new LoftedSolid([circle])).toThrow(RangeError);
    const two = [new Line(v(0, 0, 1), v(1, 0, 1)), new Line(v(1, 0, 1), v(0, 0, 1))];
    expect(() => new LoftedSolid([circle, two])).toThrow(RangeError);
  });

  it('lofts a straight prism from two sections, with parameters given', () => {
    const square = (z: number) => [
      new Line(v(0, 0, z), v(1, 0, z)),
      new Line(v(1, 0, z), v(1, 1, z)),
      new Line(v(1, 1, z), v(0, 1, z)),
      new Line(v(0, 1, z), v(0, 0, z)),
    ];
    const s = new LoftedSolid([square(0), square(3)], { parameters: [0, 1] });
    expect(s.volume).toBeCloseTo(3, 8);
    expect(s.surfaceArea).toBeCloseTo(14, 8);
  });

  it('turns a tilted capsule without its measures changing', () => {
    const c = new CapsuleSolid(tilted, 0.5, 2);
    expect(c.volume).toBeCloseTo(PI * 0.25 * 2 + (4 / 3) * PI * 0.125, 7);
    expectPoint(c.centroid, tilted.toWorld(v(0, 0, 1)), 1e-6);
  });
});

describe('meshes', () => {
  it('gives a flat solid exact volume at any tolerance', () => {
    const b = new BoxSolid(world, 2, 2, 2);
    const mesh = b.tessellate({ chordTolerance: 1 });
    expect(mesh.triangles.length / 3).toBe(12);
    expect(mesh.points.length).toBe(8);
    expect(mesh.faces).toHaveLength(6);
  });

  it('caches by tolerance, and refines with it', () => {
    const s = new SphereSolid(world, 1);
    expect(s.tessellate({ chordTolerance: 0.01 })).toBe(s.tessellate({ chordTolerance: 0.01 }));
    expect(s.tessellate({ chordTolerance: 0.001 }).points.length).toBeGreaterThan(s.tessellate({ chordTolerance: 0.01 }).points.length);
  });

  it('stays within the chord tolerance of a sphere', () => {
    const s = new SphereSolid(world, 1);
    const chord = 0.005;
    const { points, triangles } = s.tessellate({ chordTolerance: chord });
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [points[triangles[t]!]!, points[triangles[t + 1]!]!, points[triangles[t + 2]!]!];
      const middle = a.add(b).add(c).scale(1 / 3);
      expect(1 - middle.length).toBeLessThan(2 * chord);
    }
  });
});

describe('JSON', () => {
  it('restores a boolean result', () => {
    const a = new BoxSolid(world, 2, 2, 2);
    const hole = new CylinderSolid(Frame3.fromNormal(v(1, 1, -1)), 0.5, 4);
    const drilled = a.difference(hole)!;
    const copy = solidFromJSON(JSON.parse(JSON.stringify(drilled.toJSON())));
    expect(copy.validate().problems).toEqual([]);
    expect(copy.volume / drilled.volume).toBeCloseTo(1, 8);
    expect(copy.genus).toBe(1);
  });

  it('refuses something else', () => {
    expect(() => solidFromJSON({ type: 'Nonsense' })).toThrow(TypeError);
  });
});

describe('triangulate', () => {
  const area = (points: { x: number; y: number }[], t: [number, number, number][]) =>
    t.reduce((sum, [a, b, c]) => sum + ((points[b]!.x - points[a]!.x) * (points[c]!.y - points[a]!.y) - (points[b]!.y - points[a]!.y) * (points[c]!.x - points[a]!.x)) / 2, 0);

  it('covers a concave polygon exactly', () => {
    const points = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 2, y: 1 }, { x: 0, y: 4 }];
    const t = triangulate({ points, outer: [0, 1, 2, 3, 4], holes: [], interior: [] });
    expect(t).toHaveLength(3);
    expect(area(points, t)).toBeCloseTo(10, 12);
  });

  it('leaves holes open, and uses interior points, also on an edge', () => {
    const points = [
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
      { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 1 },
      { x: 3, y: 3 }, { x: 3, y: 2 }, { x: 3, y: 1 },
    ];
    const t = triangulate({ points, outer: [0, 1, 2, 3], holes: [[4, 5, 6, 7]], interior: [8, 9, 10] });
    expect(area(points, t)).toBeCloseTo(15, 12);
    const used = new Set(t.flat());
    expect(used.has(8) && used.has(9) && used.has(10)).toBe(true);
    for (const [a, b, c] of t) {
      const cx = (points[a]!.x + points[b]!.x + points[c]!.x) / 3;
      const cy = (points[a]!.y + points[b]!.y + points[c]!.y) / 3;
      expect(cx > 1 && cx < 2 && cy > 1 && cy < 2).toBe(false);
    }
  });

  it('splits an edge for a grid point that lands exactly on it', () => {
    const points = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 1, y: 1 }];
    const t = triangulate({ points, outer: [0, 1, 2, 3], holes: [], interior: [4] });
    expect(new Set(t.flat()).has(4)).toBe(true);
    expect(t).toHaveLength(4);
    expect(area(points, t)).toBeCloseTo(4, 12);
  });
});
