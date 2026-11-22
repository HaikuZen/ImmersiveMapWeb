// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A size of the map's frame in pixels: the size a platform asks for an
 * image or a video, so a frame of the map is ready to post there. A
 * picture takes it with `immersiveMapStillConfiguration({ format })`, a
 * video with `immersiveMapVideoExportConfiguration({ format })`.
 *
 * The presets are each platform's recommended upload size. Any other size
 * is `ImmersiveMapFrameFormat.make(pixelWidth, pixelHeight)`.
 */
export interface ImmersiveMapFrameFormat {
  /** The frame's width in pixels. */
  readonly pixelWidth: number;
  /** The frame's height in pixels. */
  readonly pixelHeight: number;
}

/**
 * A frame of `pixelWidth` by `pixelHeight` pixels. A side below one pixel
 * is taken as one, and a fractional side is cut to whole pixels.
 */
function make(pixelWidth: number, pixelHeight: number): ImmersiveMapFrameFormat {
  return Object.freeze({
    pixelWidth: Math.max(1, Math.trunc(pixelWidth)),
    pixelHeight: Math.max(1, Math.trunc(pixelHeight)),
  });
}

/** The frame formats: the factory, the aspect ratio and every platform's preset. */
export const ImmersiveMapFrameFormat = Object.freeze({
  make,

  /** The width over the height: 0.8 for a 4:5 portrait, 1.78 for 16:9. */
  aspectRatio(format: ImmersiveMapFrameFormat): number {
    return format.pixelWidth / format.pixelHeight;
  },

  // Threads

  /** A Threads post: 4:5, 1080 × 1350. */
  threadsPost: make(1080, 1350),
  /** A square Threads post: 1:1, 1080 × 1080. */
  threadsSquare: make(1080, 1080),
  /** A Threads video: 9:16, 1080 × 1920. */
  threadsVideo: make(1080, 1920),

  // X (Twitter)

  /** An X image in landscape: 16:9, 1600 × 900. */
  xLandscape: make(1600, 900),
  /** A square X image: 1:1, 1080 × 1080. */
  xSquare: make(1080, 1080),
  /** An X video: 16:9, 1920 × 1080. */
  xVideo: make(1920, 1080),

  // Instagram

  /** An Instagram feed post: 4:5, 1080 × 1350. */
  instagramFeed: make(1080, 1350),
  /** An Instagram post as the profile grid shows it: 3:4, 1080 × 1440. */
  instagramGrid: make(1080, 1440),
  /** Instagram Reels and Stories: 9:16, 1080 × 1920. */
  instagramReels: make(1080, 1920),

  // TikTok

  /** A TikTok video: 9:16, 1080 × 1920. */
  tikTokVideo: make(1080, 1920),

  // YouTube

  /** A YouTube video: 16:9, 1920 × 1080. */
  youTubeVideo: make(1920, 1080),
  /** A YouTube Short: 9:16, 1080 × 1920. */
  youTubeShorts: make(1080, 1920),

  // LinkedIn

  /** A LinkedIn post in portrait: 4:5, 1080 × 1350. */
  linkedInPortrait: make(1080, 1350),
  /** A LinkedIn link preview: 1.91:1, 1200 × 627. */
  linkedInLink: make(1200, 627),

  // Facebook

  /** A Facebook feed post: 4:5, 1080 × 1350. */
  facebookFeed: make(1080, 1350),
  /** A Facebook link preview: 1.91:1, 1200 × 630. */
  facebookLink: make(1200, 630),

  // GitHub

  /** A GitHub repository's social preview: 2:1, 1280 × 640. */
  gitHubSocialPreview: make(1280, 640),

  // Screens

  /** Full HD: 16:9, 1920 × 1080. */
  fullHD: make(1920, 1080),
  /** 4K UHD: 16:9, 3840 × 2160. */
  uhd4K: make(3840, 2160),
});
