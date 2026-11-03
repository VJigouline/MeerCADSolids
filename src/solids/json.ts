import { Vector3, curveFromJSON, surfaceFromJSON, type SurfaceJSON } from 'meercad-surfaces';
import type { CurveJSON } from 'meercad-curves';
import { Coedge, Edge, Face, Loop, Shell, Vertex } from '../topology/Topology.js';
import type { ISolid, SolidJSON } from './ISolid.js';

/** The boundary representation as plain data: vertices and edges in tables, and faces that refer to them. */
export function solidToJSON(solid: ISolid): SolidJSON {
  const vertices = solid.vertices;
  const edges = solid.edges;
  const vertexIndex = new Map(vertices.map((v, i) => [v, i]));
  const edgeIndex = new Map(edges.map((e, i) => [e, i]));
  const loopJSON = (loop: Loop) =>
    loop.coedges.map((c) => ({
      edge: edgeIndex.get(c.edge)!,
      forward: c.forward,
      ts: [...c.ts],
      uvs: c.uvs.map((q) => [q.u, q.v]),
    }));
  return {
    type: solid.type,
    vertices: vertices.map((v) => v.point.toArray()),
    edges: edges.map((e) => ({
      curve: e.curve?.toJSON(),
      t0: e.t0,
      t1: e.t1,
      start: vertexIndex.get(e.start)!,
      end: vertexIndex.get(e.end)!,
    })),
    shells: solid.shells.map((shell) =>
      shell.faces.map((face) => ({
        surface: face.surface.toJSON(),
        outer: loopJSON(face.outer),
        holes: face.holes.map(loopJSON),
      })),
    ),
  };
}

interface CoedgeJSON {
  readonly edge: number;
  readonly forward: boolean;
  readonly ts: number[];
  readonly uvs: [number, number][];
}

interface FaceJSON {
  readonly surface: SurfaceJSON;
  readonly outer: CoedgeJSON[];
  readonly holes: CoedgeJSON[][];
}

interface EdgeJSON {
  readonly curve?: CurveJSON;
  readonly t0: number;
  readonly t1: number;
  readonly start: number;
  readonly end: number;
}

/** The shells stored in a solid's JSON form. */
export function shellsFromJSON(json: SolidJSON): Shell[] {
  const data = json as unknown as { vertices: number[][]; edges: EdgeJSON[]; shells: FaceJSON[][] };
  if (!Array.isArray(data.vertices) || !Array.isArray(data.edges) || !Array.isArray(data.shells)) {
    throw new TypeError('This is not the JSON form of a solid.');
  }
  const vertices = data.vertices.map((p) => new Vertex(Vector3.fromArray(p)));
  const edges = data.edges.map(
    (e) => new Edge(e.curve ? curveFromJSON(e.curve) : undefined, e.t0, e.t1, vertices[e.start]!, vertices[e.end]!),
  );
  const loop = (list: CoedgeJSON[]) =>
    new Loop(list.map((c) => new Coedge(edges[c.edge]!, c.forward, c.ts, c.uvs.map(([u, v]) => ({ u, v })))));
  return data.shells.map(
    (faces) => new Shell(faces.map((f) => new Face(surfaceFromJSON(f.surface), loop(f.outer), f.holes.map(loop)))),
  );
}
