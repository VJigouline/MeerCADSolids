import { BoundingBox3, Vector3, type SurfaceParameter } from 'meercad-surfaces';
import { Line, type ICurve } from 'meercad-curves';
import type { ClosestSolidPoint, ISolid, PointClassification, SolidHit, SolidSection } from '../solids/ISolid.js';
import type { Face } from '../topology/Topology.js';
import { invertNear } from './integrate.js';

/** The closest point of a triangle, with its barycentric weights of the second and third corners. */
function closestOnTriangle(p: Vector3, a: Vector3, b: Vector3, c: Vector3): { point: Vector3; b1: number; b2: number } {
  const ab = b.sub(a);
  const ac = c.sub(a);
  const ap = p.sub(a);
  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) {
    return { point: a, b1: 0, b2: 0 };
  }
  const bp = p.sub(b);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) {
    return { point: b, b1: 1, b2: 0 };
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const w = d1 / (d1 - d3);
    return { point: a.addScaled(ab, w), b1: w, b2: 0 };
  }
  const cp = p.sub(c);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) {
    return { point: c, b1: 0, b2: 1 };
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { point: a.addScaled(ac, w), b1: 0, b2: w };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { point: b.addScaled(c.sub(b), w), b1: 1 - w, b2: w };
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return { point: a.addScaled(ab, v).addScaled(ac, w), b1: v, b2: w };
}

function meshTolerance(solid: ISolid): number {
  return Math.max(solid.boundingBox().diagonal, 1e-300) / 300;
}

function boxDistance(box: BoundingBox3, p: Vector3): number {
  const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
  const dy = Math.max(box.min.y - p.y, 0, p.y - box.max.y);
  const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
  return Math.hypot(dx, dy, dz);
}

/** The closest point of one trimmed face: the mesh gives a start, and the true surface and edges refine it. */
export function closestOnFace(face: Face, point: Vector3, tolerance: number): { point: Vector3; u: number; v: number; distance: number; interior: boolean } {
  const mesh = face.tessellate(tolerance);
  let best = Infinity;
  let start: SurfaceParameter = mesh.parameters[0]!;
  let bestPoint = mesh.points[0]!;
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [ia, ib, ic] = [mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!];
    const hit = closestOnTriangle(point, mesh.points[ia]!, mesh.points[ib]!, mesh.points[ic]!);
    const d = hit.point.distanceTo(point);
    if (d < best) {
      best = d;
      bestPoint = hit.point;
      const b0 = 1 - hit.b1 - hit.b2;
      const [qa, qb, qc] = [mesh.parameters[ia]!, mesh.parameters[ib]!, mesh.parameters[ic]!];
      start = { u: b0 * qa.u + hit.b1 * qb.u + hit.b2 * qc.u, v: b0 * qa.v + hit.b1 * qb.v + hit.b2 * qc.v };
    }
  }
  let result = { point: bestPoint, u: start.u, v: start.v, distance: best, interior: false };
  const refined = invertNear(face.surface, point, start, 12);
  if (face.containsParameter(refined.u, refined.v)) {
    const q = face.surface.pointAt(refined.u, refined.v);
    const d = q.distanceTo(point);
    if (d <= result.distance + tolerance) {
      result = { point: q, u: refined.u, v: refined.v, distance: d, interior: face.strictlyContains(refined.u, refined.v, 1e-6) };
    }
  }
  // Check the edges even so: the surface's nearest point can lie outside the trim while an edge is closer.
  for (const loop of face.loops) {
    for (const c of loop.coedges) {
      const near = c.edge.closest(point, tolerance);
      if (near.distance < result.distance - 1e-12) {
        const q = c.uvAt(near.t);
        result = { point: near.point, u: q.u, v: q.v, distance: near.distance, interior: false };
      }
    }
  }
  return result;
}

export function closestSolidPoint(solid: ISolid, point: Vector3): ClosestSolidPoint {
  const tolerance = meshTolerance(solid);
  const order = solid.faces
    .map((face) => ({ face, bound: boxDistance(face.boundingBox(), point) }))
    .sort((a, b) => a.bound - b.bound);
  let best: ClosestSolidPoint | undefined;
  for (const { face, bound } of order) {
    if (best && bound > best.distance) {
      break;
    }
    const hit = closestOnFace(face, point, tolerance);
    if (!best || hit.distance < best.distance) {
      best = { point: hit.point, distance: hit.distance, face, u: hit.u, v: hit.v };
    }
  }
  return best!;
}

/** The winding number of a closed mesh about a point: the total solid angle over 4 pi. */
function windingNumber(solid: ISolid, p: Vector3, tolerance: number): number {
  const { points, triangles } = solid.tessellate({ chordTolerance: tolerance });
  let sum = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = points[triangles[t]!]!.sub(p);
    const b = points[triangles[t + 1]!]!.sub(p);
    const c = points[triangles[t + 2]!]!.sub(p);
    const [la, lb, lc] = [a.length, b.length, c.length];
    const numerator = a.dot(b.cross(c));
    const denominator = la * lb * lc + a.dot(b) * lc + b.dot(c) * la + c.dot(a) * lb;
    sum += 2 * Math.atan2(numerator, denominator);
  }
  return sum / (4 * Math.PI);
}

export function classifySolidPoint(solid: ISolid, point: Vector3, tolerance?: number): PointClassification {
  const size = Math.max(solid.boundingBox().diagonal, 1e-300);
  const on = tolerance ?? 1e-7 * size;
  if (!solid.boundingBox().contains(point, on)) {
    return 'outside';
  }
  const mesh = size / 300;
  const reach = Math.max(2 * mesh, on);
  const near = solid.faces
    .map((face) => ({ face, bound: boxDistance(face.boundingBox(), point) }))
    .filter((f) => f.bound <= reach)
    .map(({ face }) => ({ face, hit: closestOnFace(face, point, mesh) }))
    .sort((a, b) => a.hit.distance - b.hit.distance);
  const best = near[0];
  if (best && best.hit.distance <= on) {
    return 'boundary';
  }
  // Close to the boundary a mesh can't be trusted, as it lies inside a convex surface by up to its
  // chord tolerance. So use the true normals where the closest point is: of the one face there, or
  // summed over the faces meeting at an edge, which gives the right side of the edge too.
  if (best && best.hit.distance <= 2 * mesh) {
    const sharing = 1e-6 * size + 1e-9 * best.hit.distance;
    let normal = Vector3.ZERO;
    for (const { face, hit } of near) {
      if (hit.distance <= best.hit.distance + sharing) {
        normal = normal.add(face.surface.normalAt(hit.u, hit.v));
      }
    }
    return point.sub(best.hit.point).dot(normal) > 0 ? 'outside' : 'inside';
  }
  return windingNumber(solid, point, mesh) > 0.5 ? 'inside' : 'outside';
}

/** Levenberg-Marquardt on `S(u, v) - C(t) = 0`. */
function refineHit(face: Face, curve: ICurve, u0: number, v0: number, t0: number): { u: number; v: number; t: number; gap: number } {
  const s = face.surface;
  let [u, v, t] = [u0, v0, t0];
  const limitU = (x: number) => Math.min(s.domainU.end, Math.max(s.domainU.start, x));
  const limitV = (x: number) => Math.min(s.domainV.end, Math.max(s.domainV.start, x));
  const limitT = (x: number) => Math.min(curve.domain.end, Math.max(curve.domain.start, x));
  let f = s.pointAt(u, v).sub(curve.pointAt(t));
  let cost = f.lengthSquared;
  for (let iter = 0; iter < 15 && cost > 0; iter++) {
    const a = s.derivativeAt(u, v, 1, 0);
    const b = s.derivativeAt(u, v, 0, 1);
    const c = curve.derivativeAt(t).negate();
    const [m11, m12, m13, m22, m23, m33] = [a.dot(a), a.dot(b), a.dot(c), b.dot(b), b.dot(c), c.dot(c)];
    const damp = 1e-12 * (m11 + m22 + m33) + 1e-300;
    const [p11, p22, p33] = [m11 + damp, m22 + damp, m33 + damp];
    const [g1, g2, g3] = [-a.dot(f), -b.dot(f), -c.dot(f)];
    const det = p11 * (p22 * p33 - m23 * m23) - m12 * (m12 * p33 - m23 * m13) + m13 * (m12 * m23 - p22 * m13);
    if (det === 0 || !Number.isFinite(det)) {
      break;
    }
    const d1 = (g1 * (p22 * p33 - m23 * m23) - m12 * (g2 * p33 - m23 * g3) + m13 * (g2 * m23 - p22 * g3)) / det;
    const d2 = (p11 * (g2 * p33 - m23 * g3) - g1 * (m12 * p33 - m23 * m13) + m13 * (m12 * g3 - g2 * m13)) / det;
    const d3 = (p11 * (p22 * g3 - g2 * m23) - m12 * (m12 * g3 - g2 * m13) + g1 * (m12 * m23 - p22 * m13)) / det;
    let scale = 1;
    let moved = false;
    for (let k = 0; k < 6; k++) {
      const [nu, nv, nt] = [limitU(u + scale * d1), limitV(v + scale * d2), limitT(t + scale * d3)];
      const nf = s.pointAt(nu, nv).sub(curve.pointAt(nt));
      if (nf.lengthSquared < cost) {
        [u, v, t, f, cost] = [nu, nv, nt, nf, nf.lengthSquared];
        moved = true;
        break;
      }
      scale /= 2;
    }
    if (!moved) {
      break;
    }
  }
  return { u, v, t, gap: Math.sqrt(cost) };
}

/** Moller-Trumbore intersection of a segment and a triangle. */
function pierce(a: Vector3, b: Vector3, p0: Vector3, p1: Vector3, p2: Vector3): { s: number; b1: number; b2: number } | undefined {
  const margin = 1e-6;
  const dir = b.sub(a);
  const e1 = p1.sub(p0);
  const e2 = p2.sub(p0);
  const h = dir.cross(e2);
  const det = e1.dot(h);
  if (Math.abs(det) <= 1e-14 * dir.length * e1.length * e2.length) {
    return undefined;
  }
  const o = a.sub(p0);
  const b1 = o.dot(h) / det;
  if (b1 < -margin || b1 > 1 + margin) {
    return undefined;
  }
  const q = o.cross(e1);
  const b2 = dir.dot(q) / det;
  if (b2 < -margin || b1 + b2 > 1 + margin) {
    return undefined;
  }
  const s = e2.dot(q) / det;
  return s < -margin || s > 1 + margin ? undefined : { s: Math.min(1, Math.max(0, s)), b1, b2 };
}

export function intersectSolidCurve(solid: ISolid, curve: ICurve, tolerance?: number): SolidHit[] {
  const size = Math.max(solid.boundingBox().diagonal, 1e-300);
  const gapLimit = tolerance ?? 1e-6 * size;
  const mesh = size / 300;
  const polyline = curve.tessellate({ chordTolerance: mesh });
  const hits: SolidHit[] = [];
  const merge = Math.max(10 * gapLimit, 1e-5 * size);
  for (const face of solid.faces) {
    const box = face.boundingBox();
    const fm = face.tessellate(mesh);
    for (let i = 0; i + 1 < polyline.points.length; i++) {
      const [a, b] = [polyline.points[i]!, polyline.points[i + 1]!];
      if (!BoundingBox3.fromPoints([a, b]).intersects(box, 1e-9 * size)) {
        continue;
      }
      for (let k = 0; k < fm.triangles.length; k += 3) {
        const [ia, ib, ic] = [fm.triangles[k]!, fm.triangles[k + 1]!, fm.triangles[k + 2]!];
        const hit = pierce(a, b, fm.points[ia]!, fm.points[ib]!, fm.points[ic]!);
        if (!hit) {
          continue;
        }
        const b0 = 1 - hit.b1 - hit.b2;
        const [qa, qb, qc] = [fm.parameters[ia]!, fm.parameters[ib]!, fm.parameters[ic]!];
        const t0 = polyline.parameters[i]! + (polyline.parameters[i + 1]! - polyline.parameters[i]!) * hit.s;
        const refined = refineHit(face, curve, b0 * qa.u + hit.b1 * qb.u + hit.b2 * qc.u, b0 * qa.v + hit.b1 * qb.v + hit.b2 * qc.v, t0);
        if (refined.gap > gapLimit || !face.containsParameter(refined.u, refined.v, 1e-6)) {
          continue;
        }
        const point = face.surface.pointAt(refined.u, refined.v);
        if (!hits.some((h) => h.point.distanceTo(point) <= merge)) {
          hits.push({ point, t: refined.t, face, u: refined.u, v: refined.v });
        }
      }
    }
  }
  return hits.sort((a, b) => a.t - b.t);
}

export function intersectSolidLine(solid: ISolid, origin: Vector3, direction: Vector3, tolerance?: number): SolidHit[] {
  const dir = direction.normalized();
  if (dir.lengthSquared === 0) {
    throw new RangeError('Line direction must not be zero.');
  }
  const box = solid.boundingBox();
  const middle = origin.addScaled(dir, box.center.sub(origin).dot(dir));
  const reach = box.diagonal + middle.distanceTo(box.center) + 1e-9;
  const line = new Line(middle.addScaled(dir, -reach), middle.addScaled(dir, reach));
  return intersectSolidCurve(solid, line, tolerance)
    .map((h) => ({ ...h, t: h.point.sub(origin).dot(dir) }))
    .sort((a, b) => a.t - b.t);
}

export function sectionSolid(solid: ISolid, origin: Vector3, normal: Vector3, chordTolerance?: number): SolidSection {
  const n = normal.normalized();
  if (n.lengthSquared === 0) {
    throw new RangeError('Plane normal must not be zero.');
  }
  const size = Math.max(solid.boundingBox().diagonal, 1e-300);
  const chord = chordTolerance ?? size / 300;
  const noise = 1e-12 * Math.max(size, origin.length);
  const height = (p: Vector3) => {
    const h = p.sub(origin).dot(n);
    return Math.abs(h) <= noise ? noise : h;
  };
  // Directed segments, keeping the cut's material on their left seen along the plane's normal.
  const segments: [Vector3, Vector3][] = [];
  for (const face of solid.faces) {
    const mesh = face.tessellate(chord);
    const heights = mesh.points.map(height);
    const crossing = (a: number, b: number): Vector3 => {
      // Bisect on the true surface, unless this edge is a chord on the boundary, whose end points are exact.
      const [qa, qb] = [mesh.parameters[a]!, mesh.parameters[b]!];
      let [lo, hi] = [0, 1];
      const sign = heights[a]! >= 0;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const h = height(face.surface.pointAt(qa.u + (qb.u - qa.u) * mid, qa.v + (qb.v - qa.v) * mid));
        if (h >= 0 === sign) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      const s = (lo + hi) / 2;
      return face.surface.pointAt(qa.u + (qb.u - qa.u) * s, qa.v + (qb.v - qa.v) * s);
    };
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const corners = [mesh.triangles[t]!, mesh.triangles[t + 1]!, mesh.triangles[t + 2]!];
      const ends: Vector3[] = [];
      let entering = false;
      for (let k = 0; k < 3; k++) {
        const [a, b] = [corners[k]!, corners[(k + 1) % 3]!];
        if (heights[a]! >= 0 !== heights[b]! >= 0) {
          if (ends.length === 0) {
            entering = heights[a]! >= 0;
          }
          ends.push(crossing(a, b));
        }
      }
      if (ends.length === 2) {
        // Going round the triangle, it crosses down then up, or up then down. Orient so that the solid
        // lies to the left when looking along the plane's normal.
        segments.push(entering ? [ends[1]!, ends[0]!] : [ends[0]!, ends[1]!]);
      }
    }
  }
  const loops = chainDirected(segments, 1e-7 * size);
  let area = 0;
  const frameX = n.anyPerpendicular();
  const frameY = n.cross(frameX);
  for (const loop of loops) {
    let sum = 0;
    for (let i = 0; i < loop.length; i++) {
      const [a, b] = [loop[i]!.sub(origin), loop[(i + 1) % loop.length]!.sub(origin)];
      sum += a.dot(frameX) * b.dot(frameY) - b.dot(frameX) * a.dot(frameY);
    }
    area += sum / 2;
  }
  return { loops, area: Math.abs(area) };
}

/** Joins directed segments into cycles, end to start. */
function chainDirected(segments: readonly [Vector3, Vector3][], tolerance: number): Vector3[][] {
  const key = (p: Vector3) => `${Math.round(p.x / tolerance)},${Math.round(p.y / tolerance)},${Math.round(p.z / tolerance)}`;
  const from = new Map<string, number[]>();
  segments.forEach(([a], i) => {
    const k = key(a);
    from.set(k, [...(from.get(k) ?? []), i]);
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const loops: Vector3[][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i] || segments[i]![0].distanceTo(segments[i]![1]) <= tolerance) {
      used[i] = true;
      continue;
    }
    used[i] = true;
    const loop = [segments[i]![0]];
    let tip = segments[i]![1];
    for (;;) {
      const startKey = key(tip);
      const next = (from.get(startKey) ?? []).find((j) => !used[j]);
      if (next === undefined) {
        break;
      }
      used[next] = true;
      loop.push(segments[next]![0]);
      tip = segments[next]![1];
    }
    if (loop.length >= 3) {
      loops.push(loop);
    }
  }
  return loops;
}
