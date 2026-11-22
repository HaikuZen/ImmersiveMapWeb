// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// library
// The frame group of what stands on the flat map (the buildings and the
// trees, StandingFrameResources): the camera, the fog the buildings draw
// with, the shadows and their map, the ground's fog for the trees' discs
// and the trees' frame. Prepended after shadow.wgsl and ground-fog.wgsl.

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

// Mirror of TreeFrameUniformLayout (tile/pipelines/standing-pipelines.ts):
// the unit direction towards the light, the palette the model is coloured
// in, and the crown's radius and the height of its centre in the model's
// metres.
struct TreeFrame {
    lightDirection: vec4f,
    crownColor: vec4f,
    crownShadeColor: vec4f,
    trunkColor: vec4f,
    crown: vec4f,
}

@group(0) @binding(0) var<uniform> camera: Camera;
// The fog the buildings and the models draw with (GroundFogUniform.resolveFrame forBuildings).
@group(0) @binding(1) var<uniform> buildingFog: GroundFog;
@group(0) @binding(2) var<uniform> shadow: Shadow;
@group(0) @binding(3) var shadowMap: texture_depth_2d_array;
@group(0) @binding(4) var shadowSampler: sampler_comparison;
// The ground's fog: the trees' discs lie on the ground and fade as it does.
@group(0) @binding(5) var<uniform> groundFog: GroundFog;
@group(0) @binding(6) var<uniform> treeFrame: TreeFrame;
