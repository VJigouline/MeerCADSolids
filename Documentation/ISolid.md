# ISolid reference

Every solid implements `ISolid`.

## Topology

| Member | Meaning |
|---|---|
| `type` | Class name, such as `BoxSolid`. A boolean result or a transformed copy is a `Solid`. |
| `shells` | Connected sets of faces. A cavity or a separate piece is its own shell. |
| `faces`, `edges`, `vertices` | Every part, each once. `edges` includes degenerate ones. |
| `facesOfEdge(edge)` | The faces meeting an edge |
| `edgesOfVertex(vertex)` | The edges meeting a vertex |
| `neighboursOfFace(face)` | The faces sharing an edge with this one |
| `eulerCharacteristic` | `V - E + 2F - L`, by the Euler-Poincare formula, leaving out degenerate edges, with `L` the number of loops |
| `genus` | The number of through-holes, totalled over the shells |
| `isClosed` | True if every edge is used exactly twice, in opposite directions |
| `validate()` | `{ valid, problems }`. Checks that edges are used properly, loops connect and turn the right way, edges lie on their surfaces, the volume is positive, and the faces mesh into a closed surface. |

## Measures

| Member | Returns |
|---|---|
| `volume` | Enclosed volume, with cavities taken away |
| `surfaceArea` | Total area of the faces, including cavities |
| `centroid` | Centre of volume |
| `massProperties(density = 1)` | `{ volume, mass, centroid, inertia }`, with `inertia` holding `xx`, `yy`, `zz`, `xy`, `yz` and `zx` about the centroid, in the world axes, with the usual negative sign on the products |
| `boundingBox()` | Axis-aligned box |

## Meshes

`tessellate({ chordTolerance })` returns a mesh within the tolerance, which defaults to 1/200 of the box's diagonal.

| Member | Meaning |
|---|---|
| `points`, `triangles` | A welded mesh. Each mesh edge lies in exactly two triangles, and the winding faces out. |
| `triangleFaces` | The index of the face each triangle comes from |
| `faces` | One mesh per face, with `points`, `normals` and `triangles`, and points not shared with other faces, for display |

Results are cached by tolerance.

## Queries

| Method | Returns |
|---|---|
| `classifyPoint(point, tolerance)` | `'inside'`, `'outside'` or `'boundary'`. The tolerance is the distance that counts as on the boundary, by default `1e-7` of the box's diagonal. |
| `containsPoint(point, tolerance)` | True if inside or on the boundary |
| `closestPoint(point)` | `{ point, distance, face, u, v }` on the boundary |
| `distanceTo(point)` | Distance to the boundary. From inside, this is not zero. |
| `intersectCurve(curve, tolerance)` | `{ point, t, face, u, v }[]`, sorted by `t`, the curve's parameter |
| `intersectLine(origin, direction, tolerance)` | The same, with `t` the signed distance from `origin` along `direction`, for an infinite line |
| `section(origin, normal, chordTolerance)` | `{ loops, area }`, with polylines around the cut. The area has holes taken away. |

## Editing

| Method | Returns |
|---|---|
| `transformed(transform)` | The solid under an affine transform, as a `Solid`. A reflection keeps the normals pointing out. |
| `union(other, options)` | The union. Throws `BooleanError` if it can't give a valid solid. |
| `intersection(other, options)` | The common part, or `undefined` if there is none |
| `difference(other, options)` | This solid with the other taken away, or `undefined` if nothing is left |

The options are `tolerance`, the distance below which points count as the same (by default `1e-7` of the larger diagonal), and `meshTolerance`, the chord tolerance of the meshes that find curved intersections (by default 1/150 of the smaller diagonal). If an attempt fails, it is repeated with finer meshes before giving up.

## Other

| Method | Returns |
|---|---|
| `equals(other, tolerance = 1e-6)` | True if the part counts match, the volumes agree, and each vertex of this solid has one of the other's nearby. It doesn't compare surfaces, so it is a quick check rather than a proof. |
| `toJSON()` | A plain object for `solidFromJSON` |

## Topology classes

| Class | Useful members |
|---|---|
| `Vertex` | `point`, `id` |
| `Edge` | `curve`, `t0`, `t1`, `start`, `end`, `isDegenerate`, `isClosed`, `length`, `midpoint`, `pointAt(t)`, `discretize(tolerance)`, `closest(point, tolerance)` |
| `Coedge` | `edge`, `forward`, `ts`, `uvs`, `uvAt(t)`, `Coedge.straight(edge, forward, from, to)` |
| `Loop` | `coedges`, `polygon()`, `signedArea()` |
| `Face` | `surface`, `outer`, `holes`, `loops`, `containsParameter(u, v)`, `tessellate(chord)`, `boundingBox()`, `isFlat()` |
| `Shell` | `faces` |

`Solid` also offers `signedVolume()`, which is negative if the normals point inwards.

## Errors

| Error | When |
|---|---|
| `RangeError` | Invalid input: a non-positive size, a profile that doesn't close, a polyhedron whose faces don't match up, and so on |
| `BooleanError` | A boolean operation can't give a valid result. It says what went wrong and, where it can, near which point. |
| `TypeError` | `solidFromJSON` was given something else |
