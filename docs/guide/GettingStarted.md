# Getting started

`@artembobkin/immersive-map` is a map for web pages: a globe that unrolls into a flat map, with buildings, relief, your own data and 3D models. It draws with WebGPU and does its heavy work in WebAssembly workers. This page takes you from adding the package to the first map on screen.

## What the map needs

- **WebGPU.** The map draws with WebGPU only and has no WebGL fallback. It runs in Chrome and Edge 113 or later on the desktop and Chrome 121 or later on Android, Safari 26 or later, and Firefox 141 or later on Windows. Where WebGPU is missing, `ImmersiveMap.create` rejects with an error that says so. The engine turns on the optional WebGPU features it finds (`shader-f16`, `timestamp-query`, the texture compressions and others) and has a fallback inside WebGPU for each one it does not find.
- **A secure context.** Browsers expose WebGPU on HTTPS pages and on `localhost` only.
- **No special headers.** The map needs no cross-origin isolation (COOP and COEP) and no `SharedArrayBuffer`. The playground sends those headers only to get finer timers for its benchmarks.
- **WebCodecs** for the video export alone (see [Export](Export.md)).

## Adding the package

```sh
npm install @artembobkin/immersive-map
```

The package ships ES modules with their type declarations, its WebAssembly modules and its assets (the font atlases, the globe's overview, the tree model, the pin shapes). The map loads nothing of its own from a CDN: the app's bundler copies the WebAssembly modules and the assets next to the app and serves them from there.

The code finds its workers, WebAssembly modules and assets the standard way, `new URL("…", import.meta.url)` and `new Worker(new URL("…", import.meta.url), { type: "module" })`, which the current bundlers follow with no configuration. Vite 8 and webpack 5 are checked: a new app with the package and nothing else draws the map in development and in a production build.

The types need TypeScript 6 or later, whose `lib.dom` declares WebGPU. With an older TypeScript, add `@webgpu/types` to the project.

The debug panel is a separate entry, `@artembobkin/immersive-map/debug`, so a page that imports `@artembobkin/immersive-map` alone carries none of it.

## The first map

```ts
const map = await ImmersiveMap.create({
  container: document.getElementById("map")!,
});
```

The map fills the container with a canvas, so give the container a size in CSS. This is the whole planet from the hosted tiles, with the built-in style, the globe at low zooms, buildings, trees and the attribution badge. Nothing needs a key or an account. Detailed models of the landmarks are one setting away (see [3D content](3DContent.md)).

`ImmersiveMap.create` resolves once the GPU and the tile workers are ready. `map.destroy()` tears down the canvas, the workers, the listeners and the GPU resources, for example when the part of the page that holds the map goes away.

The map draws on demand: a frame is drawn when the camera moves, a tile lands or an animation runs. `map.onFrame(listener)` reports every drawn frame with its CPU time, its GPU time where the browser measures it, and its tile counts.

## Options and settings

The Swift engine sets everything about the map with SwiftUI modifiers on the view. Here the same values are set in two places:

- **Options of `ImmersiveMap.create`** hold what belongs to one map on the page: the container, where the camera opens, the controllers, the on-screen camera buttons and the debug panel.
- **`ImmersiveMapSettings`** holds the map's whole configuration. It has a method for every Swift modifier that configures the map, under the same name. Most methods take the modifier's arguments as one object, as in `.shadows({ strength: 0.6 })`.

```ts
const map = await ImmersiveMap.create({
  container,
  camera: { city: "paris", zoom: 15 },
  settings: ImmersiveMapSettings.default
    .night()
    .shadows({ strength: 0.6 })
    .trees({ isEnabled: false }),
});
```

A settings value is immutable, and each method returns a new value with only the values you pass changed. Everything you leave out keeps its default, or the value an earlier call gave it, so `.shadows({ strength: 0.6 })` changes the strength and nothing else.

For a value no method sets, `edit` hands you a mutable copy of the settings' data:

```ts
settings.edit((s) => void (s.scene.shadows.mapResolution = 2048));
```

The settings are plain data. `JSON.stringify(settings)` writes them, and `ImmersiveMapSettings.from(data)` reads them back, so they can come from your app's own stored preferences.

## Settings in one place

Build the value once when several maps share it:

```ts
const settings = ImmersiveMapSettings.default
  .night()
  .shadows({ strength: 0.6 });

const maps = await Promise.all([
  ImmersiveMap.create({ container: first, settings, camera: { city: "paris" } }),
  ImmersiveMap.create({ container: second, settings, camera: { city: "rome" } }),
]);
```

The same value configures a picture or a video (see [Export](Export.md)).

## Changing the settings

Pass new settings whenever your state changes, and the map follows. `map.setSettings` takes a value, or a function of the current settings:

```ts
nightToggle.addEventListener("change", () => {
  void map.setSettings((settings) => settings.night(nightToggle.checked));
});

// A whole value works too, and the promise resolves once the map draws by it.
await map.setSettings(ImmersiveMapSettings.default.shadows({ isEnabled: false }));
```

`map.settings` reads the settings the map runs by. Most changes apply on the next frame: the camera, the light and the shadows, the fog, the attribution.

Some change how the tiles are prepared, so the map prepares its tiles again, from the disk cache where it can: the style (`.night()` included), the tile parsing, the caches and the globe's overview.

Others build the map's GPU side again, with the camera kept where it is and the controllers and listeners carried over: the tile source, the labels, the pin settings, the model archive, `.msaa()`, and also the buildings' extrusion, the trees, the ground flattening and most of the ground relief's values, which the Swift engine applies in place. Change these when the user asks for it, not on every frame.

## The debug panel

```ts
const { ImmersiveMapDebugPanel } = await import("@artembobkin/immersive-map/debug");
const map = await ImmersiveMap.create({ container, debugPanel: ImmersiveMapDebugPanel.hud });
```

The panel shows the camera and the frame's diagnostics, draws overlays such as the tile borders, and drags the settings live. `map.installDebugPanel(ImmersiveMapDebugPanel.hud)` adds it to a running map, and `settings.debugPanel(false)` hides it. The Swift wireframe mode has no counterpart, since WebGPU has no line fill mode.

## Next

- [Setting up the tile source](TileSource.md) and [Attribution](Attribution.md): the data the map draws and its credit.
- [Camera](Camera.md): where the map looks, and how the user moves it.
- [Style](Style.md), [Custom styles](CustomStyle.md), [Relief](Relief.md) and [The scene](Scene.md): how the map looks.
- [Your own data](Layers.md), [Annotations, pins and taps](AnnotationsAndPins.md) and [3D content](3DContent.md): what you put on the map.
- [Export](Export.md): pictures and videos of the map.

The code of this page is in [examples/getting-started.ts](examples/getting-started.ts).
