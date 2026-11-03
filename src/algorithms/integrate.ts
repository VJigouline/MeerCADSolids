import type { ISurface, SurfaceParameter, Vector3 } from 'meercad-surfaces';
import type { Coedge, Face } from '../topology/Topology.js';

const GL = [
  [0.1834346424956498, 0.362683783378362],
  [0.525532409916329, 0.3137066458778873],
  [0.7966664774136267, 0.2223810344533745],
  [0.9602898564975363, 0.1012285362903763],
] as const;

/** Gauss-Legendre nodes and weights on [0, 1]. */
const NODES: readonly (readonly [number, number])[] = GL.flatMap(([x, w]) => [
  [0.5 - x / 2, w / 2] as const,
  [0.5 + x / 2, w / 2] as const,
]);

/** The parameters on a surface nearest to a point, by Gauss-Newton steps from a good guess. */
export function invertNear(surface: ISurface, target: Vector3, guess: SurfaceParameter, iterations = 8): SurfaceParameter {
  const { domainU: du, domainV: dv } = surface;
  const clampU = (u: number) => Math.min(du.end, Math.max(du.start, u));
  const clampV = (v: number) => Math.min(dv.end, Math.max(dv.start, v));
  let { u, v } = guess;
  for (let i = 0; i < iterations; i++) {
    const d = surface.pointAt(u, v).sub(target);
    const su = surface.derivativeAt(u, v, 1, 0);
    const sv = surface.derivativeAt(u, v, 0, 1);
    const [E, F, G] = [su.lengthSquared, su.dot(sv), sv.lengthSquared];
    const det = E * G - F * F;
    if (!(det > 1e-20 * E * G) || !(det > 0)) {
      // At a pole only one parameter means anything, so move that one alone.
      if (G > 0 && E <= 1e-12 * G) {
        v = clampV(v - sv.dot(d) / G);
      } else if (E > 0 && G <= 1e-12 * E) {
        u = clampU(u - su.dot(d) / E);
      }
      break;
    }
    const [gu, gv] = [su.dot(d), sv.dot(d)];
    const du0 = -(G * gu - F * gv) / det;
    const dv0 = -(E * gv - F * gu) / det;
    const [nu, nv] = [clampU(u + du0), clampV(v + dv0)];
    const moved = Math.abs(nu - u) + Math.abs(nv - v);
    u = nu;
    v = nv;
    if (moved <= 1e-14 * (du.end - du.start + dv.end - dv.start)) {
      break;
    }
  }
  return { u, v };
}

/** Accurate parameters at a point of a coedge, starting from its table. */
function coedgeParameter(face: Face, c: Coedge, t: number): SurfaceParameter {
  const guess = c.uvAt(t);
  if (c.ts.length === 2) {
    // A straight table is exact for every coedge built that way, and iso-lines need no search.
    const straight = face.surface.pointAt(guess.u, guess.v).distanceTo(c.edge.pointAt(t));
    if (straight <= 1e-11 * Math.max(1, c.edge.pointAt(t).length)) {
      return guess;
    }
  }
  return invertNear(face.surface, c.edge.pointAt(t), guess);
}

/**
 * Integrates a function over a face by Green's theorem in the parameter plane: the double integral of
 * `g(u, v)` equals the loop integral of `G(u, v) dv`, where `G` integrates `g` in `u` from the start
 * of the domain. Accuracy then doesn't depend on any triangulation of the face.
 */
export function integrateFace(face: Face, g: (u: number, v: number) => readonly number[], size: number, components: number): number[] {
  const surface = face.surface;
  const uStart = surface.domainU.start;
  const uSpan = surface.domainU.end - uStart;
  const uBreaks = surface.breakpointsU();
  const vBreaks = surface.breakpointsV();
  const sum = new Array<number>(components).fill(0);
  const antiderivative = (u: number, v: number): number[] => {
    const out = new Array<number>(components).fill(0);
    let lo = uStart;
    for (const stop of [...uBreaks.filter((b) => b > uStart && b < u), u]) {
      // Eight nodes a panel, with panels fine enough for the wave-like integrands of second moments.
      const pieces = Math.max(2, Math.ceil((8 * Math.abs(stop - lo)) / uSpan));
      for (let p = 0; p < pieces; p++) {
        const a = lo + ((stop - lo) * p) / pieces;
        const b = lo + ((stop - lo) * (p + 1)) / pieces;
        for (const [x, w] of NODES) {
          const values = g(a + (b - a) * x, v);
          for (let k = 0; k < components; k++) {
            out[k]! += values[k]! * w * (b - a);
          }
        }
      }
      lo = stop;
    }
    return out;
  };
  const tolerance = size / 200;
  for (const loop of face.loops) {
    for (const c of loop.coedges) {
      const edge = c.edge;
      const { parameters } = edge.curve ? edge.discretize(tolerance) : { parameters: [edge.t0, edge.t1] };
      // Spans also end where v crosses a surface breakpoint, so that nothing kinks inside a span.
      const stops = new Set(parameters);
      for (let i = 0; i + 1 < c.ts.length; i++) {
        const [a, b] = [c.uvs[i]!, c.uvs[i + 1]!];
        for (const brk of vBreaks) {
          if ((a.v < brk && b.v > brk) || (a.v > brk && b.v < brk)) {
            stops.add(c.ts[i]! + ((c.ts[i + 1]! - c.ts[i]!) * (brk - a.v)) / (b.v - a.v));
          }
        }
      }
      const ts = [...stops].sort((x, y) => x - y);
      const direction = c.forward ? 1 : -1;
      for (let i = 0; i + 1 < ts.length; i++) {
        const [a, b] = [ts[i]!, ts[i + 1]!];
        // dv from a difference of nearby parameters, so that the outer integral stays accurate.
        const h = (b - a) * 1e-4;
        for (const [x, w] of NODES) {
          const t = a + (b - a) * x;
          const q = coedgeParameter(face, c, t);
          const before = coedgeParameter(face, c, t - h);
          const after = coedgeParameter(face, c, t + h);
          const dvdt = (after.v - before.v) / (2 * h);
          if (dvdt === 0) {
            continue;
          }
          const inner = antiderivative(q.u, q.v);
          for (let k = 0; k < components; k++) {
            sum[k]! += direction * inner[k]! * dvdt * w * (b - a);
          }
        }
      }
    }
  }
  return sum;
}
