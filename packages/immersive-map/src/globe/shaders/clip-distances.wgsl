// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// library
// The first file of every globe module that clips by the unroll's cut: the
// cut is a clip distance where the device has `clip-distances`. Lines that
// end in the clip-distances marker are kept only there, lines that end in
// the no-clip-distances marker only without it, where the fragment stage
// discards by the interpolated clearance instead (clipDistanceVariant).
enable clip_distances; // clip-distances
