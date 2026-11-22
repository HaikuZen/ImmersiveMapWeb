// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The working index buffer of a tile whose buildings a model stands in
// for (HiddenBuildingIndexBuffers): the runs of the tile's extruded indices
// the frame keeps, copied one after another out of the tile's arena into a
// buffer of their own. WebGPU reads no buffer back on the CPU, so the copy
// runs here, a thread an output word: one 32-bit index, or two 16-bit ones.

struct CopyParameters {
    // The runs in `runs`, and the indices the working buffer holds.
    runCount: u32,
    indexCount: u32,
    // 1 for 32-bit indices, 0 for 16-bit ones, two to a word.
    wide: u32,
    // The threads a row of workgroups covers (the dispatch is two-dimensional).
    rowThreads: u32,
}

@group(0) @binding(0) var<storage, read> arena: array<u32>;
@group(0) @binding(1) var<storage, read_write> working: array<u32>;
// One run a vec4u: its first index in the working buffer, its first index
// in the arena (from the arena's start, in indices), its count.
@group(0) @binding(2) var<storage, read> runs: array<vec4u>;
@group(0) @binding(3) var<uniform> parameters: CopyParameters;

// The arena's index of a working buffer's index: the run holding it, by
// bisection over the runs' starts.
fn sourceIndex(destination: u32) -> u32 {
    var low = 0u;
    var high = parameters.runCount;
    while (high - low > 1u) {
        let middle = (low + high) / 2u;
        if (runs[middle].x <= destination) {
            low = middle;
        } else {
            high = middle;
        }
    }
    let run = runs[low];
    return run.y + (destination - run.x);
}

fn arenaIndex(element: u32) -> u32 {
    if (parameters.wide == 1u) {
        return arena[element];
    }
    let word = arena[element / 2u];
    return select(word & 0xffffu, word >> 16u, (element & 1u) == 1u);
}

@compute @workgroup_size(64)
fn copyBuildingIndices(@builtin(global_invocation_id) id: vec3u) {
    let thread = id.y * parameters.rowThreads + id.x;
    if (parameters.wide == 1u) {
        if (thread < parameters.indexCount) {
            working[thread] = arenaIndex(sourceIndex(thread));
        }
        return;
    }
    let first = thread * 2u;
    if (first >= parameters.indexCount) {
        return;
    }
    let low = arenaIndex(sourceIndex(first));
    var high = 0u;
    if (first + 1u < parameters.indexCount) {
        high = arenaIndex(sourceIndex(first + 1u));
    }
    working[thread] = low | (high << 16u);
}
