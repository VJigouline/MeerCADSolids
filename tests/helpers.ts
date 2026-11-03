import { expect } from 'vitest';
import { Vector3, type ISolid, type SolidMesh } from '../src/index.js';

export const v = (x: number, y: number, z = 0) => new Vector3(x, y, z);

export function expectPoint(actual: Vector3, expected: Vector3, tolerance = 1e-9): void {
  const distance = actual.distanceTo(expected);
  if (!(distance <= tolerance)) {
    expect.fail(`(${actual.toArray()}) is ${distance} from (${expected.toArray()}), tolerance ${tolerance}`);
  }
}

/** Each mesh edge is used exactly twice, in opposite directions. */
export function isWatertight(mesh: SolidMesh): boolean {
  const uses = new Map<string, number>();
  const { triangles } = mesh;
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k]!;
      const b = triangles[t + ((k + 1) % 3)]!;
      const key = `${a}/${b}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of uses) {
    const [a, b] = key.split('/');
    if (count !== 1 || uses.get(`${b}/${a}`) !== 1) {
      return false;
    }
  }
  return true;
}

/** The volume and area of a mesh, as a check independent of the face integrator. */
export function meshMeasures(mesh: SolidMesh): { volume: number; area: number } {
  let volume = 0;
  let area = 0;
  const { points, triangles } = mesh;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [points[triangles[t]!]!, points[triangles[t + 1]!]!, points[triangles[t + 2]!]!];
    volume += a.dot(b.cross(c)) / 6;
    area += b.sub(a).cross(c.sub(a)).length / 2;
  }
  return { volume, area };
}

/** The volume of a solid by counting grid points inside it, an estimate independent of its faces. */
export function monteCarloVolume(solid: ISolid, n = 24): number {
  const box = solid.boundingBox();
  const s = box.size;
  let inside = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        const p = v(box.min.x + (s.x * (i + 0.5)) / n, box.min.y + (s.y * (j + 0.5)) / n, box.min.z + (s.z * (k + 0.5)) / n);
        if (solid.classifyPoint(p) !== 'outside') {
          inside++;
        }
      }
    }
  }
  return (inside / n ** 3) * s.x * s.y * s.z;
}
