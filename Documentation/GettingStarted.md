# Getting started

## Concepts

A boundary representation describes a solid by its skin:

| Part | What it is |
|---|---|
| `Vertex` | A point |
| `Edge` | A piece of a curve between two vertices. A degenerate edge has no curve, and marks where a side of a face's parameter rectangle collapses to a point, such as a sphere's pole. |
| `Coedge` | One use of an edge by a face, with a table from the edge's parameter to the face's `(u, v)` |
| `Loop` | A closed cycle of coedges |
| `Face` | A region of a surface: one outer loop and any holes |
| `Shell` | A connected set of faces |
| `Solid` | One or more shells. A cavity is a shell facing into it. |

Two rules hold everywhere:

- **Normals point out of the solid.** A face's surface normal is its outward normal, so a face needing the opposite side uses `surface.reversed()`.
- **Outer loops run counter-clockwise in the parameter plane, and holes clockwise.** So in a closed solid, each edge is used twice, once in each direction.

The math types (`Vector3`, `Frame3`, `Transform3`, `BoundingBox3`) are shared with `meercad-curves` and `meercad-surfaces`, and this package re-exports them. Curves come from `meercad-curves`.

Solids are immutable. Operations return new ones.

## Making solids

```ts
import { BoxSolid, CylinderSolid, Frame3, PolyhedronSolid, SphereSolid, Vector3 } from 'meercad-solids';

const box = new BoxSolid(Frame3.WORLD, 2, 3, 4);                     // a corner at the frame's origin
const centred = BoxSolid.centred(new Vector3(1, 1, 1), 2, 2, 2);
const tilted = new CylinderSolid(Frame3.fromNormal(new Vector3(1, 2, 3), new Vector3(0, 1, 1)), 1, 5);
const ball = SphereSolid.centredAt(new Vector3(0, 0, 0), 2);
const d20 = PolyhedronSolid.icosahedron(1);
```

From a profile, which is a closed chain of curves in a plane:

```ts
import { CircularArc, Line } from 'meercad-curves';
import { ExtrudedSolid, PipeSolid, RevolvedSolid, Vector3 } from 'meercad-solids';

const square = [
  new Line(new Vector3(0, 0), new Vector3(4, 0)),
  new Line(new Vector3(4, 0), new Vector3(4, 4)),
  new Line(new Vector3(4, 4), new Vector3(0, 4)),
  new Line(new Vector3(0, 4), new Vector3(0, 0)),
];
const plate = new ExtrudedSolid(
  { outer: square, holes: [[CircularArc.circle(new Vector3(2, 2), 1)]] },
  new Vector3(0, 0, 1),
);

// An open profile must start and end on the axis.
const cone = new RevolvedSolid(
  [new Line(new Vector3(0, 0, 0), new Vector3(2, 0, 0)), new Line(new Vector3(2, 0, 0), new Vector3(0, 0, 3))],
  Vector3.ZERO,
  Vector3.Z,
);

const path = new Line(new Vector3(0, 0, 0), new Vector3(0, 0, 5));
const hose = new PipeSolid(path, 1, 0.8);
```

The direction a profile runs in doesn't matter, as builders orient it for you.

## Measuring

```ts
box.volume;
box.surfaceArea;
box.centroid;
const { mass, centroid, inertia } = box.massProperties(7.8);
inertia.zz;
box.boundingBox();
```

The inertia tensor is about the centroid, in the world axes.

## Exploring the topology

```ts
box.faces;
box.edges;
box.vertices;
box.facesOfEdge(box.edges[0]!);        // two faces, on a closed solid
box.neighboursOfFace(box.faces[0]!);
box.eulerCharacteristic;
box.genus;
box.validate();                        // { valid, problems }

const face = box.faces[0]!;
face.surface;                          // an ISurface from meercad-surfaces
face.outer.coedges[0]!.edge.curve;     // an ICurve from meercad-curves
```

## Booleans

```ts
const a = new BoxSolid(Frame3.WORLD, 2, 2, 2);
const b = new BoxSolid(Frame3.fromNormal(new Vector3(1, 1, 1)), 2, 2, 2);

a.union(b);          // always a solid
a.intersection(b);   // undefined if they share nothing
a.difference(b);     // undefined if nothing is left
```

A result can have several shells: separate pieces, or a cavity. Booleans are checked before they return, and throw `BooleanError` if they can't give a valid solid:

```ts
import { BooleanError } from 'meercad-solids';

try {
  const part = a.difference(b);
} catch (error) {
  if (error instanceof BooleanError) {
    // For instance, solids that touch along just an edge give no manifold union.
  }
}
```

Curved solids take longer, and their curved intersections are approximations. See [the limits](Algorithms.md#booleans). Pass a smaller `meshTolerance` to search harder:

```ts
a.intersection(b, { meshTolerance: 0.001 });
```

## Queries

```ts
part.classifyPoint(p);                // 'inside', 'outside' or 'boundary'
part.containsPoint(p);                // inside or on the boundary
part.closestPoint(p);                 // { point, distance, face, u, v }
part.distanceTo(p);                   // to the boundary, also from inside
part.intersectLine(origin, direction);  // sorted along the line
part.intersectCurve(curve);
part.section(origin, normal);         // { loops, area }
```

## Meshes

```ts
const mesh = part.tessellate({ chordTolerance: 0.01 });
mesh.points;          // welded
mesh.triangles;       // three indices per triangle; each mesh edge lies in exactly two
mesh.triangleFaces;   // which face each triangle comes from
mesh.faces;           // separate meshes with normals, for display with crisp edges
```

The tolerance defaults to 1/200 of the bounding-box diagonal.

## Transforming

```ts
import { Transform3, Vector3 } from 'meercad-solids';

part.transformed(Transform3.rotate(Vector3.Z, 0.5));
part.transformed(Transform3.scale(2, 1, 1));       // any affine transform
part.transformed(Transform3.mirror(Vector3.X));    // normals still point out
```

The result is a general `Solid`, with the transformed surfaces and curves.

## Saving

```ts
import { solidFromJSON } from 'meercad-solids';

const copy = solidFromJSON(JSON.parse(JSON.stringify(part.toJSON())));
```

The copy is a general `Solid` whose `type` is the original's class name. A solid built on a `ParametricCurve` or `ParametricSurface` can't be saved, because those hold a function.

## Building your own

Any closed set of faces makes a solid. Use `new Solid(shells)`, then call `validate()`, which checks the topology and the orientation. The classes in `src/solids` show how.
