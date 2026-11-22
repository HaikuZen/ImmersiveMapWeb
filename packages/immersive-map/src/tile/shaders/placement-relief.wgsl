// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT
// requires: ../relief/shaders/ground-relief.wgsl

// The placement prepass on the ground relief (PlacementStencilSubsystem), a
// port of the relief's paths of the Swift engine's
// PlacementStencilRenderSubsystem and TileRaster.metal: a square is the
// raster tiles' grid over it, raised by the terrain its source's ground
// rises by, so the marks lie where the ground does. Drawn twice: the
// ground's depth first, every point of the ground once, then the marks
// tested against it. After the marks the depth goes back to the cleared far
// plane (placementDepthResetVertex). No colour.

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

struct TileDraw {
    model: mat4x4f,
    depthOffset: f32,
    depthRankStep: f32,
    alphaScale: f32,
    dashUnitsPerPoint: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var<storage, read> draws: array<TileDraw>;

// The relief's depth, one value with tile-raster.wgsl: the raised ground
// keeps the real geometry's depth scale at the band's first step, as the
// ground the marks stand for draws.
const kPlacementLayerDepthStep: f32 = 3.2e-6;
const kPlacementReliefBandScale: f32 = 0.25;
const kPlacementReliefGroundBehind: f32 = 2.0 * kPlacementLayerDepthStep;

@vertex
fn placementReliefVertex(@location(0) localPosition: vec2f, @builtin(instance_index) drawIndex: u32) -> @builtin(position) vec4f {
    var worldPosition = draws[drawIndex].model * vec4f(localPosition, 0.0, 1.0);
    worldPosition.z += groundReliefLift(localPosition);
    var position = camera.matrix * worldPosition;
    position.z *= 1.0 + kPlacementReliefGroundBehind - 0.5 * kPlacementLayerDepthStep * kPlacementReliefBandScale;
    return position;
}

/// A square on the plane among the relief's (its source's terrain not in):
/// the grid flat, at the depth the raster ground's plane draws at.
@vertex
fn placementGridVertex(@location(0) localPosition: vec2f, @builtin(instance_index) drawIndex: u32) -> @builtin(position) vec4f {
    let worldPosition = draws[drawIndex].model * vec4f(localPosition, 0.0, 1.0);
    var position = camera.matrix * worldPosition;
    let step = 0.5 * kPlacementLayerDepthStep;
    position.z *= (1.0 - step) / (1.0 - 1536.0 * kPlacementLayerDepthStep);
    return position;
}

/// One triangle over the whole screen at the far plane: after the relief's
/// marks are tested against the ground's depth, that depth is put back to
/// the cleared far plane, so the ground passes meet the depth they met
/// before the prepass wrote any. Counter-clockwise like every triangle of
/// the flat map.
@vertex
fn placementDepthResetVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    return vec4f(positions[index], 1.0, 1.0);
}

@fragment
fn placementReliefFragment() -> @location(0) vec4f {
    return vec4f(0.0);
}
