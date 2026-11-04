import { describe, expect, it } from 'vitest';
import { Transform3, solidFromJSON, type SolidJSON } from '../src/index.js';
import { catalog } from './catalog.js';
import { expectPoint, isWatertight, meshMeasures, v } from './helpers.js';

const rotateAndMove = Transform3.translate(v(5, -3, 2)).compose(Transform3.rotate(v(1, 2, -1), 0.8));

describe.each(Object.entries(catalog))('%s', (_name, { make, expected }) => {
  const solid = make();
  const box = solid.boundingBox();
  const size = box.diagonal;

  it('is valid and closed', () => {
    const report = solid.validate();
    expect(report.problems).toEqual([]);
    expect(report.valid).toBe(true);
    expect(solid.isClosed).toBe(true);
  });

  it('has the expected topology', () => {
    expect(solid.genus).toBe(expected.genus);
    for (const edge of solid.edges) {
      if (!edge.isDegenerate) {
        expect(solid.facesOfEdge(edge).length).toBeGreaterThan(0);
        expect(edge.pointAt(edge.t0).distanceTo(edge.start.point)).toBeLessThan(1e-7 * size);
        expect(edge.pointAt(edge.t1).distanceTo(edge.end.point)).toBeLessThan(1e-7 * size);
      }
    }
    for (const vertex of solid.vertices) {
      expect(solid.edgesOfVertex(vertex).length).toBeGreaterThan(0);
    }
  });

  it('has the expected volume and area', () => {
    expect(solid.volume).toBeGreaterThan(0);
    if (expected.volume !== undefined) {
      expect(solid.volume / expected.volume).toBeCloseTo(1, expected.numeric ? 4 : 7);
    }
    if (expected.area !== undefined) {
      expect(solid.surfaceArea / expected.area).toBeCloseTo(1, 7);
    }
  });

  it('has a closed mesh, whose measures agree with the exact ones', () => {
    const mesh = solid.tessellate({ chordTolerance: size / 400 });
    expect(mesh.triangles.length).toBeGreaterThan(0);
    expect(isWatertight(mesh)).toBe(true);
    const { volume, area } = meshMeasures(mesh);
    // A mesh within a chord tolerance can't be further off in volume than its area times a few chords.
    expect(Math.abs(volume - solid.volume)).toBeLessThanOrEqual(3 * solid.surfaceArea * (size / 400));
    expect(area).toBeLessThanOrEqual(solid.surfaceArea * 1.05);
    expect(area).toBeGreaterThanOrEqual(solid.surfaceArea * 0.8);
    expect(mesh.triangleFaces.length).toBe(mesh.triangles.length / 3);
    expect(() => solid.tessellate({ chordTolerance: 0 })).toThrow(RangeError);
  });

  it('gets closer to the exact measures with a finer mesh', () => {
    const coarse = meshMeasures(solid.tessellate({ chordTolerance: size / 100 }));
    const fine = meshMeasures(solid.tessellate({ chordTolerance: size / 1600 }));
    const bound = 3 * solid.surfaceArea * (size / 1600);
    expect(Math.abs(fine.volume - solid.volume)).toBeLessThanOrEqual(bound);
    expect(Math.abs(fine.volume - solid.volume)).toBeLessThanOrEqual(Math.abs(coarse.volume - solid.volume) + 1e-9 * solid.volume);
  });

  it('has a box that holds its mesh tightly', () => {
    const mesh = solid.tessellate({ chordTolerance: size / 400 });
    for (const p of mesh.points) {
      expect(box.contains(p, 1e-3 * size)).toBe(true);
    }
  });

  it('classifies points on its boundary and around it', () => {
    const mesh = solid.tessellate({ chordTolerance: size / 200 });
    const stride = Math.max(1, Math.floor(mesh.faces.length));
    for (const f of mesh.faces.slice(0, stride)) {
      const q = f.points[Math.floor(f.points.length / 2)]!;
      const n = f.normals[Math.floor(f.points.length / 2)]!;
      expect(solid.classifyPoint(q)).toBe('boundary');
      expect(solid.containsPoint(q)).toBe(true);
      const step = 1e-3 * size;
      const out = q.addScaled(n, step);
      expect(solid.classifyPoint(out)).toBe('outside');
      expect(solid.containsPoint(out)).toBe(false);
    }
    expect(solid.classifyPoint(box.max.add(v(size, size, size)))).toBe('outside');
  });

  it('finds closest points', () => {
    const mesh = solid.tessellate({ chordTolerance: size / 200 });
    const f = mesh.faces[0]!;
    const q = f.points[0]!;
    expect(solid.distanceTo(q)).toBeLessThan(1e-6 * size);
    const out = box.center.add(v(2, 1, 1.5).scale(size));
    const found = solid.closestPoint(out);
    expect(found.distance).toBeCloseTo(found.point.distanceTo(out), 9);
    for (const p of mesh.points) {
      expect(found.distance).toBeLessThanOrEqual(p.distanceTo(out) + 1e-6 * size);
    }
  });

  it('crosses a line an even number of times, on its boundary', () => {
    const hits = solid.intersectLine(box.center.add(v(0.013, 0.007, 0.011)), v(0.31, 0.53, 0.79));
    expect(hits.length % 2).toBe(0);
    for (const h of hits) {
      expect(solid.distanceTo(h.point)).toBeLessThan(1e-5 * size);
    }
  });

  it('has a section through it that encloses area', () => {
    const c = solid.centroid;
    const section = solid.section(c.add(v(0.013, 0.007, 0.011).scale(size / 10)), v(0.2, 0.3, 0.9));
    if (solid.classifyPoint(c) === 'inside') {
      expect(section.area).toBeGreaterThan(0);
      expect(section.loops.length).toBeGreaterThan(0);
    }
    for (const loop of section.loops) {
      for (const p of loop) {
        expect(solid.distanceTo(p)).toBeLessThan(1e-3 * size);
      }
    }
  });

  it('keeps its measures under rigid transforms, and scales them', () => {
    const moved = solid.transformed(rotateAndMove);
    const digits = expected.numeric ? 3 : 6;
    expect(moved.volume / solid.volume).toBeCloseTo(1, digits);
    expect(moved.surfaceArea / solid.surfaceArea).toBeCloseTo(1, digits);
    expect(moved.validate().problems).toEqual([]);
    expectPoint(moved.centroid, rotateAndMove.applyToPoint(solid.centroid), (expected.numeric ? 1e-3 : 1e-6) * size);
    const big = solid.transformed(Transform3.scale(2));
    expect(big.volume / solid.volume).toBeCloseTo(8, digits - 1);
    expect(big.surfaceArea / solid.surfaceArea).toBeCloseTo(4, digits - 1);
  });

  it('stays outward and valid when mirrored', () => {
    const mirror = Transform3.mirror(v(0.3, -1, 0.2));
    const image = solid.transformed(mirror);
    expect(image.validate().problems).toEqual([]);
    expect(image.volume / solid.volume).toBeCloseTo(1, expected.numeric ? 3 : 6);
    expect(isWatertight(image.tessellate({ chordTolerance: size / 200 }))).toBe(true);
    expectPoint(image.centroid, mirror.applyToPoint(solid.centroid), (expected.numeric ? 1e-3 : 1e-6) * size);
  });

  it('scales its volume by the determinant under a stretch', () => {
    const stretched = solid.transformed(Transform3.scale(2, 1, 0.5));
    expect(stretched.volume / solid.volume).toBeCloseTo(1, expected.numeric ? 3 : 5);
    expect(stretched.validate().problems).toEqual([]);
  });

  it('has an inertia tensor that is valid', () => {
    const m = solid.massProperties(3);
    expect(m.mass).toBeCloseTo(m.volume * 3, 9);
    const { xx, yy, zz } = m.inertia;
    expect(xx).toBeGreaterThan(0);
    expect(yy).toBeGreaterThan(0);
    expect(zz).toBeGreaterThan(0);
    // The triangle inequality of the principal moments holds on the diagonal too.
    expect(xx + yy).toBeGreaterThanOrEqual(zz * (1 - 1e-6));
    expect(yy + zz).toBeGreaterThanOrEqual(xx * (1 - 1e-6));
    expect(zz + xx).toBeGreaterThanOrEqual(yy * (1 - 1e-6));
    expect(() => solid.massProperties(0)).toThrow(RangeError);
  });

  it('round-trips through JSON', () => {
    const json = JSON.parse(JSON.stringify(solid.toJSON())) as SolidJSON;
    const copy = solidFromJSON(json);
    expect(copy.type).toBe(solid.type);
    expect(copy.volume / solid.volume).toBeCloseTo(1, 7);
    expect(copy.faces.length).toBe(solid.faces.length);
    expect(copy.validate().problems).toEqual([]);
    expect(copy.equals(solid)).toBe(true);
    expect(solid.equals(solid.transformed(Transform3.translate(v(size, 0, 0))))).toBe(false);
  });
});
