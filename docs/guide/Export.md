# Export

The map can render a picture or a video of itself, offscreen and at any size. The export draws with a second, headless map with its own GPU device and workers, so the map on the page stays interactive meanwhile.

## A picture

```ts
const recorder = new ImmersiveMapStillRecorder();
const png = await recorder.capture({
  settings: ImmersiveMapSettings.default,
  camera: ImmersiveMapCameraPosition.make(55.75, 37.61, 14),
  configuration: { width: 1280, height: 720 },
});
```

You get a `Blob`, a PNG unless you ask for another type. No map has to be on the page, so this suits thumbnails and share images. `recorder.captureImageBitmap(...)` returns an `ImageBitmap` instead, the counterpart of the Swift `CGImage`.

A platform's size is a preset: `{ format: ImmersiveMapFrameFormat.threadsPost }` renders 1080 × 1350.

```ts
const webp = await recorder.capture({
  camera: { city: "paris", zoom: 15 },
  configuration: { format: ImmersiveMapFrameFormat.threadsPost, sceneDate: Date.UTC(2026, 5, 21, 12) },
  type: "image/webp",
  quality: 0.9,
});
```

- **Settings.** Pass the same `ImmersiveMapSettings` as your map, with your tile source and style, to get the same look.
- **Content.** Pins and 3D models are passed as values, with `pins` and `sceneModels`. Layers are passed as their controller, with `layers`, and are drawn as they are when the capture starts. The capture waits for their data to be read and prepared. Annotations are DOM elements and are not drawn into a picture.
- **Scale.** `pixelsPerPoint` is the `devicePixelRatio` the picture is drawn for: at 2, a 1280 pixel picture has its labels sized for a 640 point wide view.
- **Waiting.** The capture waits for the tiles it needs, up to `settleTimeout` (10 seconds by default), so the picture is complete.
- **Repeatability.** Set `sceneDate`, in milliseconds since the epoch, to get the same sun and the same picture on every run.
- **Errors.** A failed capture rejects with an `ImmersiveMapStillCaptureError`, whose `code` says why. `signal`, an `AbortSignal`, cancels it.

A map on the page captures itself, with its own settings, camera, pins and layers:

```ts
return await map.captureStill({ configuration: { width: 1280, height: 720, pixelsPerPoint: 2, settleTimeout: 20 } });
```

## A video

Record a camera tour, the same shots as a tour on screen (see [Camera](Camera.md)), into an MP4 file:

```ts
const recorder = new ImmersiveMapTourVideoRecorder();
map.tourVideoRecorder = recorder;

// Later:
const mp4 = await recorder.export(
  [ImmersiveMapCameraTourShot.make(start), ImmersiveMapCameraTourShot.make(end, CameraFlightOptions.make(6))],
  { configuration: { width: 1920, height: 1080, framesPerSecond: 60 } },
);
```

The recorder can also be given as the `tourVideoRecorder` option of `ImmersiveMap.create`. It takes the map's current look when the export starts. It renders frame by frame, waiting for each frame's tiles, so the video never shows a missing tile, whatever the network does. The export runs as fast as the GPU and the encoder allow, not in real time.

- **The file.** The Swift engine writes a QuickTime `.mov` file to a URL you give. Here the export resolves to a `Blob` of an MP4 file, encoded with WebCodecs' `VideoEncoder`. Hand it to the user with an object URL:
  ```ts
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  ```
  The whole file is held in memory until it is done, so a long 4K video takes a lot of it.
- **The first frame.** The video starts from where the map's camera is when the export begins, and flies to the first shot from there. Pass `establish` to start from a position of your own, so the video opens the same way on every run.
- **Size.** A platform's size is a preset: `{ format: ImmersiveMapFrameFormat.instagramReels }` records 1080 × 1920. A video's sides are even, so an odd side of a preset is one pixel smaller.
- **Format.** HEVC by default, or `codec: "h264"` for wider compatibility, or `"av1"`. Browsers differ in what they encode, so ask first: `ImmersiveMapTourVideoRecorder.supportedCodecs(configuration)` lists the codecs this browser encodes at that size and rate.
  ```ts
  const format = ImmersiveMapFrameFormat.instagramReels;
  const [codec] = await ImmersiveMapTourVideoRecorder.supportedCodecs({ format });
  if (codec === undefined) throw new Error("This browser encodes none of H.264, HEVC and AV1 at this size.");

  recorder.onProgress = (progress) => {
    status.textContent = `${progress.phase} ${Math.round(progress.fractionCompleted * 100)}%`;
  };
  return recorder.export(shots, { establish: overview, configuration: { format, codec, includesAnnotations: false } });
  ```
- **Content.** Pins and annotations are drawn in, and `includesPins: false` and `includesAnnotations: false` leave them out. The layers of the map's layers controller are drawn as they are when the export starts. The app's own scene models are not drawn into a video.
- **Annotations.** A browser cannot draw DOM elements into a video frame, so an annotation is drawn from a picture of it. An element that is an `<img>` or a `<canvas>` is drawn as it is. For any other element, give `exportImage: (item, scale) => picture` in `map.annotations.set`, returning a picture drawn at `scale` pixels per CSS pixel. An annotation with neither is left out of the video, with a warning.
- **Progress.** `recorder.onProgress` reports the phase (`"preparing"`, `"rendering"`, `"finishing"`) and `fractionCompleted`, and `recorder.cancel()` stops the export, which then rejects with an `ImmersiveMapVideoExportError`.

## The window at a platform's size

The Swift engine's `windowFormat(_:)` opens a macOS window at the pixels a platform asks for, for a screenshot or a screen recording. A page cannot size the browser's window, so this has no counterpart. Export a picture or a video at the preset instead. The presets of `ImmersiveMapFrameFormat` are the upload sizes of Threads, X, Instagram, TikTok, YouTube, LinkedIn, Facebook and GitHub, and `ImmersiveMapFrameFormat.make(pixelWidth, pixelHeight)` is any other size.

## Credit

Neither a picture nor a video contains the attribution badge. Add the data's credit wherever you publish them (see [Attribution](Attribution.md)).

The code of this page is in [examples/export.ts](examples/export.ts).
