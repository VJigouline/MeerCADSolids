# Solid catalogue

A frame gives a solid its position and direction: pass `Frame3.WORLD` for the world axes. Angles are in radians.

## Flat solids

### `PolyhedronSolid`

`new PolyhedronSolid(points, faces)`, where each face lists its corner indices counter-clockwise from outside. Each face must be flat. It throws if an edge isn't used exactly once in each direction, or if the faces turn inwards.

Regular solids, centred on the origin, by edge length: `PolyhedronSolid.tetrahedron(edge)`, `octahedron`, `icosahedron` and `dodecahedron`.

### `BoxSolid`

`new BoxSolid(frame, sizeX, sizeY, sizeZ)`, with one corner at the frame's origin, extending along its positive axes. `BoxSolid.centred(centre, sizeX, sizeY, sizeZ)` is centred on a point, along the world axes.

### `WedgeSolid`

`new WedgeSolid(frame, sizeX, sizeY, sizeZ, topX = 0)`: a box whose top is shrunk along X. A `topX` of zero makes a ramp.

### `PyramidSolid`

`new PyramidSolid(frame, sides, radius, height, topRadius = 0)`: a regular pyramid on the frame's XY plane, with its apex on +Z. A positive `topRadius` cuts it flat. `radius` is to the corners.

### `RegularPrismSolid`

`new RegularPrismSolid(frame, sides, radius, height)`.

## Round solids

| Class | Constructor | Faces | Notes |
|---|---|---|---|
| `CylinderSolid` | `(frame, radius, height)` | Side, two discs | Along the frame's +Z |
| `TubeSolid` | `(frame, outerRadius, innerRadius, height)` | Two sides, two rings | Genus 1 |
| `ConeSolid` | `(frame, radius, topRadius, height)` | Side, up to two discs | Either radius can be zero, making an apex |
| `SphereSolid` | `(frame, radius)` | One | A seam and two poles. `SphereSolid.centredAt(centre, radius)` needs no frame. |
| `HollowSphereSolid` | `(frame, outerRadius, innerRadius)` | Two | Two shells |
| `EllipsoidSolid` | `(frame, radiusX, radiusY, radiusZ)` | One | |
| `TorusSolid` | `(frame, majorRadius, minorRadius)` | One | Genus 1. The minor radius must be below the major. |
| `CapsuleSolid` | `(frame, radius, height)` | Three | `height` is between the centres of the two ends |

## Solids from curves

A profile is `{ outer, holes? }`, with each a closed chain of curves in one plane, where each curve starts at the end of the last. The direction doesn't matter.

### `ExtrudedSolid`

`new ExtrudedSolid(profile, vector)`. The vector mustn't lie in the profile's plane, but needn't be perpendicular to it.

### `RevolvedSolid`

`new RevolvedSolid(profile, axisOrigin, axisDirection, { angle })`, where `profile` is a chain of curves in a half-plane through the axis, and `angle` defaults to a full turn. A part turn gets two flat ends.

| Chain | Result |
|---|---|
| Open, with both ends on the axis | A solid with poles, such as a sphere from a half circle |
| Closed, off the axis | A ring, such as a torus from a circle |
| Closed, with one whole curve along the axis | That curve is left out, so a rectangle gives a cylinder |

### `SweptSolid`

`new SweptSolid(profile, path)`: a flat profile carried along a path, turning with it, by rotation-minimizing frames. The profile is taken as positioned at the start of the path, and the path must leave its plane there. Both ends are flat, so the profile must stay flat at the far end, which it does if the frames are rigid.

### `PipeSolid`

`new PipeSolid(path, radius, innerRadius = 0)`: a round bar along a path, hollow if `innerRadius` is positive. Its ends are flat and perpendicular to the path. It folds over itself where the radius exceeds the path's radius of curvature, and doesn't check for that.

### `LoftedSolid`

`new LoftedSolid(sections, { parameters })`: a smooth solid through a series of flat sections, with flat caps. Every section must have the same number of curves, starting at corresponding points and running the same way. Sections that disagree twist the solid.

## General solids

`Solid` is the result of booleans and transforms. It can be built directly: `new Solid(shells)`, then check it with `validate()`.

## Accuracy of measures

Measures come from the true surfaces and edges, not a mesh. See [the details](Algorithms.md#mass-properties).

| Solid | Typical relative accuracy |
|---|---|
| Flat and round primitives, extrusions, revolutions and lofts | Better than `1e-7`; textbook values are matched in the tests |
| `SweptSolid` and `PipeSolid` on a non-planar path | About `1e-3` to `1e-4`, because frames and derivatives there are numeric |
| Boolean results with curved cuts | Often `1e-4` to `1e-5`, depending on `meshTolerance`, because a cut is an interpolating curve |

## What isn't included

- **Fillets, chamfers and shelling.** These need a rolling-ball or offset solver over edges. A chamfer can be made with a boolean against a wedge.
- **Non-manifold results.** Solids touching only along an edge or at a point give a `BooleanError`, not a shared-edge solid. So do sheet bodies and wire bodies: every solid here is closed.
- **Merging coplanar faces after a boolean.** A union of boxes keeps its seams as separate faces, which are valid but not minimal. Nothing removes them yet.
- **Overlapping curved surfaces in booleans.** Coplanar faces work, but curved surfaces that coincide over an area, such as two coaxial cylinders of the same radius overlapping along their length, aren't handled reliably.
- **STEP, IGES and other file formats.** `toJSON` is the only format.
- **Infinite half-spaces.** Use a large box.
- **Variable-section sweeps and guide rails.** A `LoftedSolid` through placed sections covers many of these.

The class of a primitive isn't kept by `transformed`, booleans or JSON: the result is a general `Solid` with the same geometry. So a transformed `BoxSolid` has no `sizeX`.
