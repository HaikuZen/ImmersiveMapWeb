// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The stars around the globe, a port of the Swift engine's
// StarfieldStars.metal. Space itself is not drawn here: the world pass's
// clear colour paints it, and the stars blend additively over it. They stay
// at full strength through the unroll: the clear colour is space until the
// surface switch, and the flat map's sky fades in over the stars.
//
// WebGPU has no point size, so each star is an instanced quad of the size
// the Metal point sprite had, in pixels, and the quad's corner stands in
// for the sprite's point coordinate. The sprite's terms are unit-range, the
// Metal shader evaluates them in half: here they are f32 (f16 waits on
// benchmark B15).

struct StarfieldParams {
    /// The stars' own projection times the camera's view.
    matrix: mat4x4f,
    /// The globe's pan rotation, row-vector layout (`v * M`).
    rotation: mat4x4f,
    viewportSizePx: vec2f,
    globeRadius: f32,
    radiusScale: f32,
    time: f32,
}

@group(0) @binding(0) var<uniform> params: StarfieldParams;

struct StarIn {
    @location(0) position: vec3f,
    @location(1) size: f32,
    @location(2) brightness: f32,
    @location(3) temperature: f32,
    @location(4) twinklePhase: f32,
    @location(5) halo: f32,
}

struct StarOut {
    @builtin(position) position: vec4f,
    @location(0) centered: vec2f,
    @location(1) @interpolate(flat) brightness: f32,
    @location(2) @interpolate(flat) temperature: f32,
    @location(3) @interpolate(flat) twinklePhase: f32,
    @location(4) @interpolate(flat) halo: f32,
}

@vertex
fn starfieldVertex(in: StarIn, @builtin(vertex_index) vertexIndex: u32) -> StarOut {
    // Two triangles of the sprite, corners in -1...1.
    var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
    let corner = corners[vertexIndex];
    let starRadius = params.globeRadius * params.radiusScale;
    let rotated = vec4f(in.position * starRadius, 1.0) * params.rotation;
    let world = vec4f(rotated.xyz + vec3f(0.0, 0.0, -params.globeRadius), 1.0);
    var position = params.matrix * world;
    let sizeScale = starRadius / params.globeRadius;
    let pointSize = max(1.2, in.size * sizeScale * 0.32);
    position = vec4f(position.xy + corner * pointSize / params.viewportSizePx * position.w, position.zw);
    // Stars are background: forced to the far plane so the sky depth test
    // rejects them wherever the globe surface has written depth.
    position.z = position.w;
    var out: StarOut;
    out.position = position;
    out.centered = corner;
    out.brightness = in.brightness;
    out.temperature = in.temperature;
    out.twinklePhase = in.twinklePhase;
    out.halo = in.halo;
    return out;
}

@fragment
fn starfieldFragment(in: StarOut) -> @location(0) vec4f {
    let centered = in.centered;
    let radiusSquared = dot(centered, centered);
    if (radiusSquared > 1.0) {
        discard;
    }
    let core = exp(-radiusSquared * 7.8);
    let halo = exp(-radiusSquared * 2.35) * (0.45 + in.halo * 0.95);
    let crossGlow = exp(-abs(centered.x * centered.y) * 10.0) * 0.08 * in.halo;
    let twinkle = 0.9 + 0.1 * sin(params.time * (1.0 + in.halo * 1.3) + in.twinklePhase);
    let intensity = in.brightness * twinkle;

    let warm = vec3f(1.0, 0.88, 0.78);
    let neutral = vec3f(0.96, 0.97, 1.0);
    let cool = vec3f(0.72, 0.83, 1.0);
    let t = clamp(in.temperature, 0.0, 1.0);
    let color = select(mix(neutral, cool, (t - 0.5) * 2.0), mix(warm, neutral, t * 2.0), t < 0.5);

    let alpha = saturate(core * 0.95 + halo * 0.55 + crossGlow) * intensity;
    let emissive = color * (core * 1.3 + halo * 0.75 + crossGlow * 1.6) * intensity;
    return vec4f(emissive, alpha);
}
