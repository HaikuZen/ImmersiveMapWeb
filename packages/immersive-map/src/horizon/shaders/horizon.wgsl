// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The horizon layer, a port of the Swift engine's Horizon.metal: the air
// around the surface's visible edge, resolved per pixel from the view ray.
// The edge is the limb of the sphere the surface currently lives on (the
// resting globe, or the growing sphere of the unroll) and, at zero
// curvature, the plane's horizon. The CPU hands the edge over as the eye's
// local vertical plus the limb's depression below it, so the fragment never
// touches the sphere's centre coordinate and the plane is not a special
// case (horizon-edge-math.ts mirrors the angle).
//
// One shading function, two draws of the world pass right after the last
// world layer, split by the depth buffer: the sky side runs under the
// far-plane less-equal test and reaches only pixels nothing painted, the
// ground side under a far-plane greater test and reaches only painted
// pixels, with its angle clamped to the edge so the whitening lands on the
// rasterized limb. Each pixel is shaded once. Pure arithmetic, no image
// reads, and every fragment is kept.
//
// One geometry feeds it on both surfaces: the band, a static mesh of
// directions around the eye's local vertical at a few angles either side of
// the edge (HorizonBandMath.mesh). Its vertices sit a unit from the eye, so
// the direction interpolated across a triangle is exactly the ray through
// the pixel. On the globe the band ends where the halo has decayed, on the
// plane its top follows the highest corner of the frame, since the sky is
// opaque all the way up.
//
// Three things share the profile (horizon-frame-resolver.ts decides their
// strengths per frame): the globe's atmosphere (the band and glow outside
// the limb, the rim inside, the whitening at it), the limb feather, and the
// flat map's sky painted opaque above the line (a glow of the tint at the
// line decaying into the sky colour). The far ground's fog is not drawn
// here: the shaders of what stands on the map draw it (ground-fog.wgsl).
//
// Layout mirrors HorizonUniformLayout (horizon-uniform.ts).
struct Horizon {
    up: vec3f,
    depression: f32,
    center: vec3f,
    sunInfluence: f32,
    light: vec3f,
    skyStrength: f32,
    tint: vec3f,
    whitenWeight: f32,
    eye: vec3f,
    featherStrength: f32,
    bandRadians: f32,
    glowRadians: f32,
    whitenRadians: f32,
    featherRadians: f32,
    groundBandRadians: f32,
    groundGain: f32,
    cutoffStartRadians: f32,
    cutoffEndRadians: f32,
    skyColor: vec3f,
    skyOpacity: f32,
    skyGradientRadians: f32,
    bandTopRadians: f32,
    viewProjection: mat4x4f,
}

@group(0) @binding(0) var<uniform> horizon: Horizon;

/// True for the ground-side draw: the angle is clamped to the edge, so a
/// painted pixel the analytic edge would put in the sky (the limb pixel
/// itself, under float noise) takes the edge's own value.
override kHorizonGroundSide: bool = false;

// The sky side's profile, weights of the band hugging the edge and of the
// wide glow away from it.
const kHorizonBandWeight: f32 = 0.85;
const kHorizonGlowWeight: f32 = 0.22;

const kHorizonPi: f32 = 3.14159265358979;

/// Signed angle of a unit view direction above the edge: its elevation over
/// the eye's local horizontal plus the limb's depression. Mirrored by
/// HorizonEdgeMath.angleAboveEdge.
fn horizonAngleAboveEdge(direction: vec3f) -> f32 {
    return asin(clamp(dot(direction, horizon.up), -1.0, 1.0)) + horizon.depression;
}

/// The atmosphere outside the edge: a bright band hugging the limb (the
/// dense air) and a wide faint glow into space (the thin air).
fn horizonSkyProfile(aboveRadians: f32) -> f32 {
    let band = exp(-aboveRadians / horizon.bandRadians);
    let glow = exp(-aboveRadians / horizon.glowRadians);
    return saturate(band * kHorizonBandWeight + glow * kHorizonGlowWeight);
}

/// The haze over the surface below the edge: one exponential with a gain,
/// cut off smoothly so the map under the camera stays clean. Mirrored by
/// HorizonFrameResolver.groundProfile.
fn horizonGroundProfile(belowRadians: f32) -> f32 {
    let amount = saturate(exp(-belowRadians / horizon.groundBandRadians) * horizon.groundGain);
    let cutoff = 1.0 - smoothstep(horizon.cutoffStartRadians, horizon.cutoffEndRadians, belowRadians);
    return amount * cutoff;
}

/// The sun's side of the limb: the halo is full where the limb normal faces
/// the light and dims to a residual glow opposite it, by the frame's sun
/// influence (zero on the plane and with the atmosphere off).
fn horizonSunFactor(direction: vec3f) -> f32 {
    if (horizon.sunInfluence <= 0.0) {
        return 1.0;
    }
    let toCenter = horizon.center - horizon.eye;
    let nearest = horizon.eye + direction * max(dot(toCenter, direction), 0.0);
    let normal = normalize(nearest - horizon.center);
    let day = smoothstep(-0.25, 0.25, dot(normal, horizon.light));
    return 1.0 - horizon.sunInfluence * (1.0 - day);
}

/// The haze of one direction, `above` radians above the edge (already
/// clamped on the ground side), premultiplied over what is behind: the
/// tint, whitened toward the edge, weighted by the coverage, and the
/// coverage in alpha.
fn horizonShade(above: f32, direction: vec3f) -> vec4f {
    var haze: f32;
    if (above >= 0.0) {
        haze = horizonSkyProfile(above) * horizon.skyStrength * horizonSunFactor(direction);
    } else {
        haze = horizonGroundProfile(-above);
    }
    let distanceToEdge = abs(above);
    let feather = exp(-distanceToEdge / horizon.featherRadians) * horizon.featherStrength;
    let whiten = exp(-distanceToEdge / horizon.whitenRadians) * horizon.whitenWeight;

    var coverage = saturate(haze + feather * (1.0 - haze));
    var color = mix(horizon.tint, vec3f(1.0), whiten) * coverage;
    if (!kHorizonGroundSide && above >= 0.0 && horizon.skyOpacity > 0.0) {
        // The plane's sky under the halo: a glow of the tint at the line,
        // so the sky meets the band in one colour, decaying into the sky
        // colour over a few e-folds, faded in through the morph.
        let gradient = 1.0 - exp(-above / horizon.skyGradientRadians);
        let sky = mix(horizon.tint, horizon.skyColor, gradient) * horizon.skyOpacity;
        color += sky * (1.0 - coverage);
        coverage += horizon.skyOpacity * (1.0 - coverage);
    }
    return vec4f(color, coverage);
}

struct HorizonBandVertexIn {
    @location(0) azimuth: f32,
    @location(1) station: f32,
}

struct HorizonBandVertexOut {
    @builtin(position) position: vec4f,
    @location(0) direction: vec3f,
}

const kHorizonBandStations: i32 = 8;

/// The band's angles above the edge, station by station, from the rim's far
/// cutoff under the edge to the band's top. The edge itself is a station,
/// and one either side of it is at least four feather widths out. Kept in
/// order by a running maximum and on the sphere of directions. Mirrored by
/// HorizonBandMath.stationAngles.
fn horizonBandStationAngle(station: i32) -> f32 {
    let feather = horizon.featherRadians * 4.0;
    var angles = array<f32, kHorizonBandStations>(
        -horizon.cutoffEndRadians,
        -horizon.cutoffStartRadians,
        -max(horizon.groundBandRadians, feather),
        0.0,
        max(horizon.bandRadians, feather),
        horizon.bandRadians * 3.0,
        horizon.glowRadians,
        horizon.bandTopRadians,
    );
    var angle = angles[0];
    for (var index = 1; index <= station; index += 1) {
        angle = max(angle, angles[index]);
    }
    let limit = 0.5 * kHorizonPi - 1e-3;
    return clamp(angle, horizon.depression - limit, horizon.depression + limit);
}

/// A vertex is a station and an azimuth about the eye's local vertical: the
/// pair becomes a direction placed a unit from the eye, its clip depth
/// lifted to the far plane, where the layer's two depth tests compare. What
/// travels to the fragment is the direction, not the angle: interpolated
/// across the flat triangle it is exactly the ray through the pixel.
@vertex
fn horizonBandVertex(in: HorizonBandVertexIn) -> HorizonBandVertexOut {
    let above = horizonBandStationAngle(i32(in.station));
    // A basis across the local vertical: which one does not matter, the
    // band wraps all the way round.
    let reference = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(horizon.up.z) < 0.9);
    let east = normalize(cross(reference, horizon.up));
    let north = cross(horizon.up, east);
    let elevation = above - horizon.depression;
    let direction = cos(elevation) * (cos(in.azimuth) * east + sin(in.azimuth) * north) + sin(elevation) * horizon.up;
    var out: HorizonBandVertexOut;
    out.position = horizon.viewProjection * vec4f(horizon.eye + direction, 1.0);
    // At the far plane.
    out.position.z = out.position.w;
    out.direction = direction;
    return out;
}

@fragment
fn horizonBandFragment(in: HorizonBandVertexOut) -> @location(0) vec4f {
    let direction = normalize(in.direction);
    var above = horizonAngleAboveEdge(direction);
    if (kHorizonGroundSide) {
        above = min(above, 0.0);
    }
    return horizonShade(above, direction);
}
