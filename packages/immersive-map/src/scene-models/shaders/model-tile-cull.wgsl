// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The triangles of a model tile a frame draws (ModelTileTriangleCuller):
// of the runs the frame keeps (the models in view and large enough,
// visibleModelRuns), the triangles the world pass would draw a sample of,
// in the tile's own order, and the indirect draw of them.
//
// A triangle is left out when all three corners are outside one side of
// the clip volume, when its back is to the eye (the pass culls back faces),
// or when its outline on the screen holds no sample of the drawable. Each
// corner goes to clip space by the steps of modelTileVertex in
// model-tile.wgsl, from the same matrices composed into one, and the
// outline is widened by a margin first: the GPU snaps the corners to its
// subpixel grid, and the vertex shader takes the steps one by one.
//
// Three dispatches over the same triangles keep the order (a draw of the
// tile resolves equal depths by it): cullTriangles writes the triangles a
// workgroup keeps, packed, into the workgroup's own slot of the scratch
// and their count. scanCounts turns the counts into where each
// workgroup's triangles go, and writes the draw's index count.
// packTriangles moves each workgroup's triangles there.
//
// The ranking uses subgroup ballots: the module is compiled with
// `enable subgroups;` before this text (ModelTileTriangleCuller), which the
// shader check's naga does not take yet.

struct Camera {
    matrix: mat4x4f,
    eye: vec3f,
}

struct CullParameters {
    // The tile's stored positions into the flat world, as the draw's record.
    model: mat4x4f,
    // The drawable's size in pixels.
    viewport: vec2f,
    depthBias: f32,
    runCount: u32,
    // The triangles the runs hold, and the workgroups a row of the dispatch covers.
    triangleCount: u32,
    rowWorkgroups: u32,
    // The samples along each axis: at samplePhase + k * sampleStep pixels.
    sampleStep: f32,
    samplePhase: f32,
    // How far an outline is widened before the test, in pixels.
    margin: f32,
    padding0: f32,
    padding1: f32,
    padding2: f32,
}

// A workgroup culls a chunk of triangles, a thread each.
const workgroupSize = 256u;

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> parameters: CullParameters;
// The tile's 16-byte vertices, four words each: x and y, then z and u.
@group(0) @binding(2) var<storage, read> vertices: array<u32>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
// One run a vec4u: its first triangle among the runs' triangles, its first
// triangle in the tile's index buffer, its triangle count.
@group(0) @binding(4) var<storage, read> runs: array<vec4u>;
@group(0) @binding(5) var<storage, read_write> culled: array<u32>;
// A chunk's slot of three indices a triangle, its kept ones first.
@group(0) @binding(6) var<storage, read_write> scratch: array<u32>;
// A chunk's kept triangles, then where they go: one more entry than
// chunks, the last the total.
@group(0) @binding(7) var<storage, read_write> counts: array<u32>;
@group(0) @binding(8) var<storage, read_write> offsets: array<u32>;
// The indirect draw: index count, instance count, first index, base vertex, first instance.
@group(0) @binding(9) var<storage, read_write> drawArguments: array<u32, 5>;

var<workgroup> ranks: array<u32, 256>;

// The stored positions into clip space, composed once a workgroup: the
// draw's matrix, the step toward the eye by the depth bias (an affine map
// of the point, (1 - bias) p + bias eye) and the camera's matrix.
var<workgroup> storedToClip: mat4x4f;

fn composeStoredToClip() -> mat4x4f {
    let bias = parameters.depthBias;
    let model = parameters.model;
    var drawn: mat4x4f;
    for (var j = 0; j < 4; j++) {
        let column = model[j];
        drawn[j] = vec4f(column.xyz * (1.0 - bias) + camera.eye * (bias * column.w), column.w);
    }
    return camera.matrix * drawn;
}

fn clipPosition(index: u32) -> vec4f {
    let first = vertices[index * 4u];
    let second = vertices[index * 4u + 1u];
    let stored = vec3f(f32(first & 0xffffu), f32(first >> 16u), f32(second & 0xffffu)) / 65535.0;
    return storedToClip * vec4f(stored, 1.0);
}

// Whether the span from low to high holds a sample along an axis.
fn spanHoldsSample(low: f32, high: f32) -> bool {
    let step = parameters.sampleStep;
    let phase = parameters.samplePhase;
    return floor((high - phase) / step) >= ceil((low - phase) / step);
}

fn isDrawn(a: vec4f, b: vec4f, c: vec4f) -> bool {
    // Outside one side of the clip volume with every corner.
    if (a.x > a.w && b.x > b.w && c.x > c.w) { return false; }
    if (a.x < -a.w && b.x < -b.w && c.x < -c.w) { return false; }
    if (a.y > a.w && b.y > b.w && c.y > c.w) { return false; }
    if (a.y < -a.w && b.y < -b.w && c.y < -c.w) { return false; }
    if (a.z > a.w && b.z > b.w && c.z > c.w) { return false; }
    if (a.z < 0.0 && b.z < 0.0 && c.z < 0.0) { return false; }
    // A triangle reaching behind the eye has no outline on the screen: kept.
    if (min(a.w, min(b.w, c.w)) <= 0.0) { return true; }
    // In pixels from the centre, Y up as in normalized device coordinates,
    // where a front face winds counter-clockwise.
    let half = parameters.viewport * 0.5;
    let p = a.xy / a.w * half;
    let q = b.xy / b.w * half;
    let r = c.xy / c.w * half;
    let pq = q - p;
    let pr = r - p;
    let area = pq.x * pr.y - pq.y * pr.x;
    let margin = parameters.margin;
    // Its back to the eye by more than moving a corner by the margin turns.
    let perimeter = abs(pq.x) + abs(pq.y) + abs(pr.x) + abs(pr.y) + abs(r.x - q.x) + abs(r.y - q.y);
    if (area < -2.0 * margin * perimeter) { return false; }
    // The outline in the drawable's pixels, Y down.
    let low = min(p, min(q, r));
    let high = max(p, max(q, r));
    let x = spanHoldsSample(low.x + half.x - margin, high.x + half.x + margin);
    let y = spanHoldsSample(half.y - high.y - margin, half.y - low.y + margin);
    return x && y;
}

// The first index of a triangle of the runs in the tile's index buffer:
// the run holding it, by bisection over the runs' starts.
fn sourceIndex(triangle: u32) -> u32 {
    var low = 0u;
    var high = parameters.runCount;
    while (high - low > 1u) {
        let middle = (low + high) / 2u;
        if (runs[middle].x <= triangle) { low = middle; } else { high = middle; }
    }
    let run = runs[low];
    return (run.y + triangle - run.x) * 3u;
}

fn workgroupIndex(group: vec3u) -> u32 {
    return group.y * parameters.rowWorkgroups + group.x;
}

// The workgroup's inclusive prefix sum of each thread's value in `ranks`.
fn scanRanks(local: u32) {
    for (var step = 1u; step < workgroupSize; step = step * 2u) {
        workgroupBarrier();
        let other = select(0u, ranks[select(local, local - step, local >= step)], local >= step);
        workgroupBarrier();
        ranks[local] = ranks[local] + other;
    }
    workgroupBarrier();
}

// The kept triangles of the subgroup's lanes below this one.
fn keptBelow(ballot: vec4u, lane: u32) -> u32 {
    var count = 0u;
    for (var i = 0u; i < 4u; i++) {
        let low = i * 32u;
        let partial = (1u << (lane - low)) - 1u;
        let mask = select(select(0u, partial, lane >= low), 0xffffffffu, lane >= low + 32u);
        count += countOneBits(ballot[i] & mask);
    }
    return count;
}

// A thread a triangle. The kept triangles are ranked in order by the
// subgroups' ballots and the counts of the subgroups before (a 1D
// workgroup's subgroups are its invocations in order, as Metal, Vulkan and
// Direct3D 12 group them), with one wait on the workgroup.
@compute @workgroup_size(256)
fn cullTriangles(
    @builtin(workgroup_id) group: vec3u,
    @builtin(local_invocation_index) local: u32,
    @builtin(subgroup_invocation_id) lane: u32,
    @builtin(subgroup_size) subgroupSize: u32,
) {
    if (local == 0u) { storedToClip = composeStoredToClip(); }
    workgroupBarrier();
    let chunk = workgroupIndex(group);
    let triangle = chunk * workgroupSize + local;
    var kept = false;
    var corners = vec3u(0u);
    if (triangle < parameters.triangleCount) {
        let source = sourceIndex(triangle);
        corners = vec3u(indices[source], indices[source + 1u], indices[source + 2u]);
        kept = isDrawn(clipPosition(corners.x), clipPosition(corners.y), clipPosition(corners.z));
    }
    let ballot = subgroupBallot(kept);
    let subgroup = local / subgroupSize;
    if (lane == 0u) { ranks[subgroup] = countOneBits(ballot.x) + countOneBits(ballot.y) + countOneBits(ballot.z) + countOneBits(ballot.w); }
    workgroupBarrier();
    var rank = keptBelow(ballot, lane);
    for (var i = 0u; i < subgroup; i++) { rank += ranks[i]; }
    if (kept) {
        let place = (chunk * workgroupSize + rank) * 3u;
        scratch[place] = corners.x;
        scratch[place + 1u] = corners.y;
        scratch[place + 2u] = corners.z;
    }
    if (local == workgroupSize - 1u) { counts[chunk] = rank + select(0u, 1u, kept); }
}

// One workgroup: each thread sums a share of the counts, the shares are
// summed across the workgroup, and each thread writes its share's offsets.
@compute @workgroup_size(256)
fn scanCounts(@builtin(local_invocation_index) local: u32) {
    let chunks = (parameters.triangleCount + workgroupSize - 1u) / workgroupSize;
    let share = (chunks + workgroupSize - 1u) / workgroupSize;
    let first = min(local * share, chunks);
    let end = min(first + share, chunks);
    var sum = 0u;
    for (var i = first; i < end; i++) { sum += counts[i]; }
    ranks[local] = sum;
    scanRanks(local);
    var offset = ranks[local] - sum;
    for (var i = first; i < end; i++) {
        offsets[i] = offset;
        offset += counts[i];
    }
    if (local == workgroupSize - 1u) {
        offsets[chunks] = ranks[local];
        drawArguments[0] = ranks[local] * 3u;
    }
}

// Each workgroup moves a chunk's kept triangles to where they go, a thread
// every packWorkgroupSize-th of them: a chunk keeps a third of its
// triangles or so, and a thread that would move none costs its launch.
const packWorkgroupSize = 64u;

@compute @workgroup_size(64)
fn packTriangles(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) local: u32) {
    let chunk = workgroupIndex(group);
    if (chunk * workgroupSize >= parameters.triangleCount) { return; }
    let start = offsets[chunk];
    let count = offsets[chunk + 1u] - start;
    for (var i = local; i < count; i += packWorkgroupSize) {
        let source = (chunk * workgroupSize + i) * 3u;
        let destination = (start + i) * 3u;
        culled[destination] = scratch[source];
        culled[destination + 1u] = scratch[source + 1u];
        culled[destination + 2u] = scratch[source + 2u];
    }
}
