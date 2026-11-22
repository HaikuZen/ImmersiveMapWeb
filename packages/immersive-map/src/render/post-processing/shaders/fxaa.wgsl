// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// FXAA over the finished world pass, a port of the Swift engine's FXAA.metal.
// The pass runs only when FXAA is on (RenderFrameOutputPlanner), so the
// shader carries no switch.

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

struct PostProcessingVertexOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn postProcessingVertex(@builtin(vertex_index) vertexIndex: u32) -> PostProcessingVertexOut {
    let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    let clip = positions[vertexIndex];
    var out: PostProcessingVertexOut;
    out.position = vec4f(clip, 0.0, 1.0);
    out.uv = vec2f(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
    return out;
}

// The alpha is carried through: with transparent space the frame's alpha
// is the map's coverage, and the page composites the canvas with it.
@fragment
fn fxaaFragment(in: PostProcessingVertexOut) -> @location(0) vec4f {
    let texel = 1.0 / vec2f(textureDimensions(source));
    let centerSample = textureSampleLevel(source, sourceSampler, in.uv, 0.0);
    let nw = textureSampleLevel(source, sourceSampler, in.uv + texel * vec2f(-1.0, -1.0), 0.0).rgb;
    let ne = textureSampleLevel(source, sourceSampler, in.uv + texel * vec2f(1.0, -1.0), 0.0).rgb;
    let sw = textureSampleLevel(source, sourceSampler, in.uv + texel * vec2f(-1.0, 1.0), 0.0).rgb;
    let se = textureSampleLevel(source, sourceSampler, in.uv + texel * vec2f(1.0, 1.0), 0.0).rgb;

    let lumaWeights = vec3f(0.299, 0.587, 0.114);
    let lumaNW = dot(nw, lumaWeights);
    let lumaNE = dot(ne, lumaWeights);
    let lumaSW = dot(sw, lumaWeights);
    let lumaSE = dot(se, lumaWeights);
    let lumaM = dot(centerSample.rgb, lumaWeights);
    let lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
    let lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));

    // The flat interiors that make most of a frame return after five
    // samples: the canonical thresholds, an absolute floor for the dark and
    // an eighth of the local maximum elsewhere.
    if (lumaMax - lumaMin < max(0.0312, lumaMax * 0.125)) {
        return centerSample;
    }

    let direction = vec2f(-((lumaNW + lumaNE) - (lumaSW + lumaSE)), (lumaNW + lumaSW) - (lumaNE + lumaSE));
    let directionReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 0.0078125);
    let inverseDirectionAdjustment = 1.0 / (min(abs(direction.x), abs(direction.y)) + directionReduce);
    let sampleStep = clamp(direction * inverseDirectionAdjustment, vec2f(-8.0), vec2f(8.0)) * texel;

    // The blend runs on the full RGBA: the colours are premultiplied, so the
    // coverage and the colour smooth together.
    let resultA = 0.5 * (textureSampleLevel(source, sourceSampler, in.uv + sampleStep * (1.0 / 3.0 - 0.5), 0.0) +
                         textureSampleLevel(source, sourceSampler, in.uv + sampleStep * (2.0 / 3.0 - 0.5), 0.0));
    let resultB = resultA * 0.5 + 0.25 * (textureSampleLevel(source, sourceSampler, in.uv + sampleStep * -0.5, 0.0) +
                                          textureSampleLevel(source, sourceSampler, in.uv + sampleStep * 0.5, 0.0));
    let lumaB = dot(resultB.rgb, lumaWeights);
    if (lumaB < lumaMin || lumaB > lumaMax) {
        return resultA;
    }
    return resultB;
}
