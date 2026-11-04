# Algorithms and limits

This page describes how results are computed, and where they stop being reliable.

## Mass properties

Volume, centroid and inertia come from the divergence theorem, which turns each into an integral over the faces. Each face integral then uses Green's theorem in the parameter plane: the double integral of `g(u, v)` equals the loop integral of `G(u, v) dv`, where `G` integrates `g` in `u` from the start of the domain.

So nothing depends on a triangulation of the face. Gauss-Legendre rules run along each coedge and across `u`, and points on an edge are found on the surface by Gauss-Newton steps, starting from the coedge's table.

**Limits:**

- Accuracy follows the surface's derivatives. Where they are numeric, as on `SweepSurface` in rotation-minimizing mode, expect about `1e-3` to `1e-4` rather than `1e-7`.
- Accuracy also follows the edges. An intersection curve from a boolean is an interpolating spline, not the exact curve.
- The volume assumes the shells don't cross themselves. A pipe tighter than its path's radius of curvature gives a meaningless number.

## Tessellation

Each edge is divided once by its curve's own tessellation, so the two faces sharing it get the same points, and that is what makes the welded mesh closed.

A face is meshed in its parameter plane, scaled so that a square there is about square on the surface:

1. Each loop becomes a polygon. On curved surfaces, each boundary point's parameters are found on the surface rather than read from the table.
2. Ear clipping, with holes bridged in, triangulates the polygon.
3. Delaunay flips improve the triangles, leaving boundary edges fixed.
4. Interior points from the surface's own refined grid are inserted, with more flips. A point landing exactly on an edge splits that edge.
5. Any triangle whose centre lies further than the tolerance from the surface gets a point there, for up to eight passes.

The solid then checks that its mesh is closed. If not, it divides every boundary more finely and tries again, up to five times.

**Limits:**

- The tolerance is checked at sample points, so it isn't a hard guarantee. On a sphere, the tests allow twice the tolerance at triangle centres.
- A mesh can still come out open, rarely. `validate()` reports this at the default tolerance, but a mesh at another tolerance needs its own check.
- Triangles are not always well shaped, and slivers near sharp corners are normal.

## Bounding box

The box holds a mesh's points, plus each of the six extremes of each face, pushed outwards along the true surface by golden-section searches inside the trim.

**Limit:** an extreme on a curved edge that lies off the search's path can be short by a fraction of the mesh's chord tolerance. The tests allow `1e-3` of the diagonal against a mesh.

## Classifying points

Within `tolerance` of a face, a point is on the boundary. Otherwise:

- **Near the boundary**, within twice the mesh's chord tolerance, a mesh can't be trusted, since it lies inside a convex surface. So the sign comes from the true normals at the closest point, summed over the faces meeting there.
- **Further away**, the winding number of the closed mesh decides. It needs no ray, so it has no trouble with rays grazing an edge.

**Limit:** at a vertex where faces meet at very different angles, the summed normal isn't angle-weighted, so a point extremely close to such a vertex can be misjudged.

## Closest point

For each face, in order of distance to its box, the nearest mesh triangle gives a start. Gauss-Newton steps refine it on the true surface, and each edge is tested too, since the surface's nearest point can lie outside the trim.

**Limit:** this finds the nearest point near the mesh's nearest point, which is the true nearest unless two minima are closer together than the mesh can tell apart.

## Lines and curves

The curve's polyline is tested against each face's mesh, and each crossing seeds a Levenberg-Marquardt refinement. A result counts if the gap is within tolerance and the point lies inside the face.

**Limits:**

- **Tangent contacts aren't reliably reported**, since the polyline needn't pierce the mesh.
- **Close crossings merge**, within `max(10 tolerance, 1e-5 of the diagonal)`.
- **A curve lying in a face** gives no reliable result.

## Sections

Each face's mesh is cut by the plane, with crossings bisected on the true surface, and the segments are joined into loops with a consistent direction, so that holes subtract from the area.

**Limits:** the area is that of polygons, so it is short by an amount that depends on the chord tolerance. A plane containing a whole flat face doesn't report that face.

## Booleans

Each operation has these steps:

1. **Find cuts.** Every pair of faces whose boxes touch is intersected. Two flat faces give a straight line. Otherwise `ISurface.intersect` gives polylines, whose short gaps are mended. Each is broken at seams and clipped to both faces, and its ends are solved exactly onto the boundary edge they stop at. An edge of one solid lying in a face of the other becomes a cut directly, as the surfaces may only touch there.
2. **Build the curves.** A cut between flat faces is straight. Otherwise it is a cubic Hermite spline through the points, whose tangents come from the two surfaces' normals.
3. **Split faces.** The boundary and cuts of each face form a planar graph in its parameter plane, and tracing its regions gives fragments, with holes assigned to the regions around them.
4. **Classify.** A point well inside each fragment is classified against the other solid. On its boundary, the normals decide between same-facing and opposite-facing, which is what makes coplanar faces work.
5. **Select.**

   | Operation | From A | From B |
   |---|---|---|
   | Union | Outside, or same-facing | Outside |
   | Intersection | Inside, or same-facing | Inside |
   | Difference | Outside, or opposite-facing | Inside, flipped |

6. **Sew.** Pieces running along the same line become one shared edge. A piece used once, or by more than two faces, is an error.
7. **Check.** The result must pass `validate()`, and must agree with the two inputs about which points it holds, at 48 points spread through their boxes. A failure repeats the operation with a finer search mesh, up to five attempts in all, and then throws `BooleanError`.

The check exists because a closed solid can still enclose the wrong region. During development, a closed solid with the wrong volume passed `validate()` alone.

**Limits:**

- **The check is a sample, not a proof.** A wrong region smaller than the spacing of 48 points could pass it.
- **Refusals happen.** In one run on 144 random pairs of boxes, cylinders, spheres, cones, tori and tubes, each put through union, intersection and difference, 140 pairs succeeded in all three and 4 got a `BooleanError`, three of them on tubes. None gave a wrong answer, judged by inclusion and exclusion and by a grid count from the inputs. These are solids in general position, so special positions such as tangent contacts will do worse.
- **Curved cuts are approximate.** They pass through points exact to the tolerance, and between them follow a spline. Volumes of results with curved cuts are typically good to `1e-4` or `1e-5`.
- **Tangent contacts are not handled.** Surfaces that touch without crossing may give no cut or a fragment of one, which usually ends in a `BooleanError`.
- **Curved surfaces that coincide over an area aren't reliable.** Coplanar flat faces are handled. Coincident curved ones are skipped when intersecting, which only works if neighbouring faces divide them properly.
- **Non-manifold results are refused**, such as boxes touching along one edge.
- **Faces aren't merged.** Coplanar fragments stay separate, and repeated operations gather more faces and edges.
- **Cost.** Every pair of nearby faces is intersected, and curved results are meshed and checked, so operations are not fast. In that run, one took about 1 s on average and the slowest pair about 13 s per operation, on one desktop machine.

## Numerical tolerances

| Value | Use |
|---|---|
| `1e-7` of the larger diagonal | Booleans: points count as the same |
| `1/150` of the smaller diagonal | Booleans: chord tolerance of the search meshes |
| `1e-7` of the diagonal | `classifyPoint`: distance that counts as on the boundary |
| `1e-6` of the diagonal | `intersectCurve`: largest gap |
| `1/200` of the diagonal | `tessellate`: default chord tolerance |
| `1e-5` of the domain, per parameter | Booleans: graph nodes that count as the same |

These scale with the model. The tests run every solid, and some booleans, at sizes of `1e-3` and `1e6`.
