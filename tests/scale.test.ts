import { describe, expect, it } from 'vitest';
import { BoxSolid, CylinderSolid, Frame3, SphereSolid, Transform3, Vector3, type ISolid } from '../src/index.js';
import { catalog } from './catalog.js';
import { isWatertight, v } from './helpers.js';

/** Model sizes the documentation says are supported. */
const SCALES = [1e-3, 1e6];

describe.each(SCALES)('at model scale %d', (scale) => {
  const up = Transform3.scale(scale);

  describe.each(Object.entries(catalog))('%s', (_name, { make, expected }) => {
    const base = make();
    const solid: ISolid = base.transformed(up);

    it('scales its measures, stays valid, and meshes closed', () => {
      const digits = expected.numeric ? 3 : 5;
      expect(solid.volume / (base.volume * scale ** 3)).toBeCloseTo(1, digits);
      expect(solid.surfaceArea / (base.surfaceArea * scale ** 2)).toBeCloseTo(1, digits);
      expect(solid.boundingBox().diagonal / (base.boundingBox().diagonal * scale)).toBeCloseTo(1, 3);
      expect(solid.validate().problems).toEqual([]);
      expect(isWatertight(solid.tessellate())).toBe(true);
    });

    it('classifies a point on its boundary and well outside it', () => {
      const mesh = solid.tessellate();
      const q = mesh.faces[0]!.points[0]!;
      expect(solid.classifyPoint(q)).toBe('boundary');
      const far = solid.boundingBox().max.add(new Vector3(scale, scale, scale));
      expect(solid.classifyPoint(far)).toBe('outside');
    });
  });

  it('does booleans at this scale', () => {
    const place = (x: number, y: number, z: number) => Frame3.fromNormal(v(x * scale, y * scale, z * scale));
    const a = new BoxSolid(place(0, 0, 0), 2 * scale, 2 * scale, 2 * scale);
    const b = new BoxSolid(place(1, 1, 1), 2 * scale, 2 * scale, 2 * scale);
    expect(a.union(b).volume / (15 * scale ** 3)).toBeCloseTo(1, 6);
    const hole = new CylinderSolid(place(1, 1, -1), 0.5 * scale, 4 * scale);
    const drilled = a.difference(hole)!;
    expect(drilled.volume / ((8 - Math.PI * 0.5) * scale ** 3)).toBeCloseTo(1, 4);
    expect(drilled.genus).toBe(1);
    const s1 = new SphereSolid(place(0, 0, 0), scale);
    const s2 = new SphereSolid(place(0, 0, 1), scale);
    const lens = (Math.PI * (2 - 1) ** 2 * (1 + 4)) / 12;
    expect(s1.intersection(s2)!.volume / (lens * scale ** 3)).toBeCloseTo(1, 3);
  });
});
