# MeerCADSolids

CAD solids in boundary representation (B-rep), in TypeScript. Every solid is shells of faces, each a trimmed region of a surface, bounded by loops of edges that share vertices. Primitives, polyhedra, and extruded, revolved, swept and lofted solids all implement one `ISolid` interface, with volume and inertia, closed meshes, point and line queries, sections and boolean operations.

- Built on [MeerCADCurves](https://github.com/VJigouline/MeerCADCurves) and [MeerCADSurfaces](https://github.com/VJigouline/MeerCADSurfaces)
- Immutable solids: operations return new solids
- Booleans check their own results, and throw rather than return a solid they can't vouch for
- Ships as an ES module with type declarations

## Install

The package isn't published to npm yet. Install it from GitHub, which also fetches and builds its two dependencies:

```sh
npm install github:VJigouline/MeerCADSolids
```

Node.js 22 or later is required.

## Quick example

```ts
import {
  BoxSolid,
  CylinderSolid,
  Frame3,
  SphereSolid,
  Transform3,
  Vector3,
  solidFromJSON,
} from 'meercad-solids';

// Every solid shares the ISolid interface.
const plate = new BoxSolid(Frame3.WORLD, 6, 4, 1);
const drill = new CylinderSolid(Frame3.fromNormal(new Vector3(3, 2, -1)), 0.5, 3);

plate.volume;                                // 24
plate.surfaceArea;                           // 68
plate.massProperties(7.8).inertia.zz;        // about the centroid, with density 7.8
plate.faces.length;                          // 6
plate.eulerCharacteristic;                   // 2

// Booleans
const part = plate.difference(drill)!;
part.genus;                                  // 1: a hole right through
part.volume;                                 // 24 - pi * 0.25
part.validate().valid;                       // true

// Queries
part.classifyPoint(new Vector3(3, 2, 0.5));  // 'outside', in the hole
part.closestPoint(new Vector3(9, 2, 0.5)).distance;      // 3
part.intersectLine(new Vector3(-1, 2, 0.5), Vector3.X);  // four crossings
part.section(new Vector3(0, 0, 0.5), Vector3.Z).area;    // about 23.2, from polygons

// A closed triangle mesh, welded, and per-face meshes for display
const mesh = part.tessellate({ chordTolerance: 0.01 });

// Transforms, including reflections, keep the normals pointing out.
const moved = SphereSolid.centredAt(new Vector3(0, 0, 0), 2).transformed(Transform3.scale(2, 1, 1));

// Save and restore
const copy = solidFromJSON(JSON.parse(JSON.stringify(part.toJSON())));
```

## Solids

| Group | Classes |
|---|---|
| Flat | `BoxSolid`, `WedgeSolid`, `PyramidSolid`, `RegularPrismSolid`, `PolyhedronSolid` (with the tetrahedron, octahedron, icosahedron and dodecahedron) |
| Round | `CylinderSolid`, `TubeSolid`, `ConeSolid`, `SphereSolid`, `HollowSphereSolid`, `EllipsoidSolid`, `TorusSolid`, `CapsuleSolid` |
| From curves | `ExtrudedSolid`, `RevolvedSolid`, `SweptSolid`, `PipeSolid`, `LoftedSolid` |
| General | `Solid`, the result of booleans and transforms, or built directly from `Shell`, `Face`, `Loop`, `Coedge`, `Edge` and `Vertex` |

## Documentation

- [Getting started](Documentation/GettingStarted.md): concepts and common tasks
- [ISolid reference](Documentation/ISolid.md): every property and method
- [Solid catalogue](Documentation/Solids.md): each solid's parameters and topology, and what isn't included
- [Algorithms and limits](Documentation/Algorithms.md): how results are computed, and where they stop being reliable

## Development

| Command | Purpose |
|---|---|
| `npm test` | Run the tests |
| `npm run coverage` | Run the tests with a coverage report |
| `npm run typecheck` | Type-check the sources and tests |
| `npm run build` | Compile to `dist` |

`tests/contract.test.ts` checks every solid in `tests/catalog.ts` against the whole interface, `tests/solids.test.ts` compares results with textbook formulas, `tests/boolean.test.ts` covers booleans with known answers, `tests/stress.test.ts` runs booleans on random solids and checks each result against the two inputs, and `tests/scale.test.ts` repeats key checks on very small and very large models.

## License

[MIT](LICENSE)
