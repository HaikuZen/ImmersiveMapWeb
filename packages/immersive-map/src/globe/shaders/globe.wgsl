// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// library
// The globe's projection and light, shared by every surface the globe draws
// (the vector ground, the raster rings, the placement marks, the polar
// caps). A port of the Swift engine's GlobeTileProjection.h,
// GlobeTransitionProjection.h, GlobeUnroll.h and GlobeLight.h, against the
// frame's uniform (globe-frame-uniform.ts).
//
// The unroll: the morph never mixes positions through the planet's
// interior. The surface lives on a sphere of radius 1 / curvature tangent to
// the view centre, with curvature = (1 - transition) / radius, and every
// point travels a straight line in the chart between its
// azimuthal-equidistant image about the view centre and its Mercator
// position, the blended chart point wrapped onto the growing sphere. At
// transition 0 the surface is exactly the sphere, at 1 exactly the flat
// Mercator world. A vertex whose remaining chart travel exceeds
// kGlobeUnrollCutTravel of a radius is cut (it is content past a pole or
// opposite the view, on its way half a map sideways). The CPU mirror is
// globe-unroll-math.ts.

/// Mirror of GlobeFrameUniformLayout.
struct GlobeFrame {
    sphereClip: mat4x4f,
    sphereWorld: mat4x4f,
    pan: vec2f,
    radius: f32,
    transition: f32,
    mapSize: f32,
    panMercatorY: f32,
    handover: f32,
    padding: f32,
    lightAndStrength: vec4f,
    nightColorAndSoftness: vec4f,
}

const kGlobePi: f32 = 3.14159265358979;
/// The unroll's cut, a fraction of the planet radius (GlobeUnrollMath.cutTravelFraction).
const kGlobeUnrollCutTravel: f32 = 0.25;

/// The unit earth-fixed direction of a world uv (x east in turns, y the
/// Mercator row, both 0..1 across the world), straight through the
/// Gudermannian identities (sin lat = tanh x, cos lat = sech x for
/// x = pi (1 - 2 v)): y the pole axis, z toward longitude 0, x toward 90
/// degrees east.
fn globeWorldUVUnitDirection(worldUv: vec2f) -> vec3f {
    let x = kGlobePi * (1.0 - 2.0 * worldUv.y);
    let e = exp(x);
    let inverseE = 1.0 / e;
    let sinLatitude = (e - inverseE) / (e + inverseE);
    let cosLatitude = 2.0 / (e + inverseE);
    let longitude = worldUv.x * (2.0 * kGlobePi) - kGlobePi;
    return vec3f(cosLatitude * sin(longitude), sinLatitude, cosLatitude * cos(longitude));
}

/// The value wrapped into one map width around 0 (the Swift GeoMath wrap).
fn globeWrap(x: f32, size: f32) -> f32 {
    return x - size * floor((x + size * 0.5) / size);
}

/// The flat morph target of a world point: x in the copy of the wrapped
/// world nearest the reference's (a tile's centre, so a tile at the seam of
/// the wrap stays in one piece), y the Mercator row about the pan's.
/// `mercatorY` is -1..1, north positive.
fn globeTransitionFlatWorldPosition(normalizedWorldX: f32, mercatorY: f32, referenceWorldX: f32, globe: GlobeFrame) -> vec2f {
    let halfMapSize = globe.mapSize * 0.5;
    let panOffset = globe.pan.x * halfMapSize - halfMapSize;
    let reference = globeWrap(referenceWorldX * globe.mapSize + panOffset, globe.mapSize);
    let value = normalizedWorldX * globe.mapSize + panOffset;
    let x = reference + globeWrap(value - reference, globe.mapSize);
    return vec2f(x, (mercatorY - globe.panMercatorY) * halfMapSize);
}

/// The azimuthal-equidistant image of a sphere position about the view
/// centre: arc times departure bearing.
fn globeUnrollChartAE(sphereWorldPosition: vec3f, radius: f32) -> vec2f {
    let fromCenter = sphereWorldPosition - vec3f(0.0, 0.0, -radius);
    let cosTheta = clamp(fromCenter.z / max(radius, 1e-6), -1.0, 1.0);
    let arcSphere = radius * acos(cosTheta);
    let dirSphere = fromCenter.xy;
    let dirSphereLength = length(dirSphere);
    return select(vec2f(0.0), dirSphere * (arcSphere / dirSphereLength), dirSphereLength > 1e-6);
}

/// Positive once the vertex's remaining chart travel is short enough to
/// show, normalized by the radius so the clip distances stay of order one.
fn globeUnrollCutClearance(sphereWorldPosition: vec3f, flatWorldPosition: vec2f, transition: f32, radius: f32) -> f32 {
    let chartAE = globeUnrollChartAE(sphereWorldPosition, radius);
    let remaining = (1.0 - transition) * length(flatWorldPosition - chartAE);
    return kGlobeUnrollCutTravel - remaining / max(radius, 1e-6);
}

fn globeUnrollWorldPosition(sphereWorldPosition: vec3f, flatWorldPosition: vec2f, transition: f32, radius: f32) -> vec3f {
    let curvature = (1.0 - transition) / max(radius, 1e-6);
    if (curvature <= 1e-9) {
        return vec3f(flatWorldPosition, 0.0);
    }
    // The straight chart line between the two flat images of the point.
    let chartPoint = mix(globeUnrollChartAE(sphereWorldPosition, radius), flatWorldPosition, transition);
    let arc = length(chartPoint);
    if (arc <= 1e-6) {
        return vec3f(chartPoint, 0.0);
    }
    let azimuth = chartPoint / arc;
    let angle = arc * curvature;
    let rho = sin(angle) / curvature;
    let sag = (cos(angle) - 1.0) / curvature;
    return vec3f(azimuth * rho, sag);
}

/// A surface point of a world uv on the frame's surface: its unit earth
/// direction (what `sphereClip` takes to clip space on the resting sphere),
/// its world position through the unroll toward the plane (`morph` only),
/// the sphere's world normal there, and the cut's clearance (1 on the
/// resting sphere).
struct GlobeSurfacePoint {
    unitDirection: vec3f,
    world: vec3f,
    normal: vec3f,
    clearance: f32,
}

fn globeSurfacePoint(worldUv: vec2f, referenceWorldX: f32, morph: bool, globe: GlobeFrame) -> GlobeSurfacePoint {
    let unitDirection = globeWorldUVUnitDirection(worldUv);
    let sphereWorldPosition = (globe.sphereWorld * vec4f(unitDirection, 1.0)).xyz;
    var point: GlobeSurfacePoint;
    point.unitDirection = unitDirection;
    point.normal = (globe.sphereWorld * vec4f(unitDirection, 0.0)).xyz;
    point.world = sphereWorldPosition;
    point.clearance = 1.0;
    if (morph) {
        // The flat morph target is the Mercator plane, and the world uv
        // already is its Mercator coordinate: only the convention changes
        // (the uv row runs 0..1 from the north edge, the projection wants
        // -1..1 north positive, clamped to the Mercator range).
        let mercatorY = clamp(1.0 - 2.0 * worldUv.y, -1.0, 1.0);
        let flatWorldPosition = globeTransitionFlatWorldPosition(worldUv.x, mercatorY, referenceWorldX, globe);
        point.world = globeUnrollWorldPosition(sphereWorldPosition, flatWorldPosition, globe.transition, globe.radius);
        point.clearance = globeUnrollCutClearance(sphereWorldPosition, flatWorldPosition, globe.transition, globe.radius);
    }
    return point;
}

/// The clip position of a surface point: the composed matrix on the
/// resting sphere, the camera's over the unrolled position in the morph.
fn globeSurfaceClip(point: GlobeSurfacePoint, morph: bool, cameraMatrix: mat4x4f, globe: GlobeFrame) -> vec4f {
    if (morph) {
        return cameraMatrix * vec4f(point.world, 1.0);
    }
    return globe.sphereClip * vec4f(point.unitDirection, 1.0);
}

/// A surface colour under the globe's light at a point whose sphere normal
/// (world space) is `normal`: the colour itself where the normal faces the
/// sun, toward the night colour where it faces away, a smoothstep across
/// the terminator, all of it scaled by the strength.
fn globeLitColor(color: vec3f, normal: vec3f, globe: GlobeFrame) -> vec3f {
    let strength = globe.lightAndStrength.w;
    if (strength <= 0.0) {
        return color;
    }
    let softness = max(globe.nightColorAndSoftness.w, 1e-3);
    let day = smoothstep(-softness, softness, dot(normalize(normal), globe.lightAndStrength.xyz));
    return mix(color, globe.nightColorAndSoftness.rgb, strength * (1.0 - day));
}
