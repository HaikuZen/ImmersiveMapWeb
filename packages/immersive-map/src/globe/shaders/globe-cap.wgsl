// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// requires: globe.wgsl
// The polar caps: the sphere past the Mercator edge, each in one constant
// colour from the style (the north cap the open ocean, the south the polar
// ice), under the globe's light. A port of the Swift engine's Globe.metal.

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

/// One cap's draw record: its colour in the first row.
struct CapDraw {
    color: vec4f,
    unused: array<vec4f, 4>,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(3) var<uniform> globe: GlobeFrame;
@group(1) @binding(0) var<storage, read> draws: array<CapDraw>;

/// The cap does not morph into the plane: during the unfurl it diverges
/// from the tile surface, so it fades out in the first third of the
/// transition, while the divergence is not yet noticeable.
const kGlobeCapFadeEndTransition: f32 = 0.35;

struct CapVertexOut {
    @builtin(position) position: vec4f,
    @location(0) @interpolate(flat) drawIndex: u32,
    @location(1) sphereNormal: vec3f,
}

@vertex
fn globeCapVertex(@location(0) latLon: vec2f, @builtin(instance_index) drawIndex: u32) -> CapVertexOut {
    // The cap stores geographic latitude: the tile path's sphere has
    // phi = latitude - pi/2, so the caps take the same convention or the
    // hemispheres swap. The longitude keeps the cap's own origin.
    let phi = latLon.x - kGlobePi * 0.5;
    let theta = latLon.y;
    let unitDirection = vec3f(sin(phi) * sin(theta), cos(phi), sin(phi) * cos(theta));
    var out: CapVertexOut;
    out.position = globe.sphereClip * vec4f(unitDirection, 1.0);
    out.drawIndex = drawIndex;
    out.sphereNormal = (globe.sphereWorld * vec4f(unitDirection, 0.0)).xyz;
    return out;
}

@fragment
fn globeCapFragment(in: CapVertexOut) -> @location(0) vec4f {
    // Opaque surface colour: the cap is planet, and only the unfurl's fade
    // thins it out.
    let fade = smoothstep(0.0, kGlobeCapFadeEndTransition, clamp(globe.transition, 0.0, 1.0));
    let color = draws[in.drawIndex].color;
    return vec4f(globeLitColor(color.rgb, in.sphereNormal, globe), 1.0 - fade);
}
