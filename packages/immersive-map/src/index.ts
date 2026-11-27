// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The public surface of `@artembobkin/immersive-map`.

export { ImmersiveMap } from "./ui/immersive-map-host.ts";
export type { ImmersiveMapDeviceLostEvent } from "./ui/device-recovery.ts";
export type { ImmersiveMapOptions } from "./ui/immersive-map-host.ts";
export type { TileLoadedEvent } from "./ui/immersive-map.ts";
export type { ImmersiveMapDebugPanel } from "./ui/immersive-map-debug-panel.ts";
export type { FrameEvent, ImmersiveMapCameraOption, MapView } from "./ui/immersive-map-view.ts";
export { ImmersiveMapCameraController } from "./ui/camera/immersive-map-camera-controller.ts";
export type { CameraCompletion } from "./ui/camera/immersive-map-camera-controller.ts";
export { ImmersiveMapCameraControlPanel } from "./ui/camera/immersive-map-camera-control-panel.ts";
export type { ImmersiveMapCameraControlPanelOptions } from "./ui/camera/immersive-map-camera-control-panel.ts";
export type { ImmersiveMapCameraSnapshot } from "./ui/camera/immersive-map-camera-snapshot.ts";
export { ImmersiveMapCameraTourController, ImmersiveMapCameraTourShot } from "./ui/camera/immersive-map-camera-tour-controller.ts";
export type { CameraTourStartOptions } from "./ui/camera/immersive-map-camera-tour-controller.ts";
export { ImmersiveMapStillRecorder } from "./export/immersive-map-still-recorder.ts";
export type { ImmersiveMapStillCaptureOptions, ImmersiveMapStillEncoding } from "./export/immersive-map-still-recorder.ts";
export { ImmersiveMapTourVideoRecorder } from "./export/immersive-map-tour-video-recorder.ts";
export type { ImmersiveMapTourVideoExportOptions, ImmersiveMapVideoExportPhase, ImmersiveMapVideoExportProgress } from "./export/immersive-map-tour-video-recorder.ts";
export { ImmersiveMapStillCaptureError, ImmersiveMapVideoExportError } from "./export/immersive-map-export-errors.ts";
export type { ImmersiveMapStillCaptureErrorCode, ImmersiveMapVideoExportErrorCode } from "./export/immersive-map-export-errors.ts";
export { CameraFlightOptions, ImmersiveMapCameraPosition } from "./camera/immersive-map-camera-position.ts";
export type { CameraFlightAltitudeStyle, CameraFlightRouteStyle } from "./camera/immersive-map-camera-position.ts";
export { ImmersiveMapCity } from "./geo/immersive-map-city.ts";
export type { Tile } from "./tile/tile.ts";
export { ImmersiveMapAnnotations } from "./annotations/immersive-map-annotations.ts";
export type { ImmersiveMapAnnotationOptions } from "./annotations/immersive-map-annotations.ts";
export type { AnnotationAnchor } from "./annotations/annotation-overlay-layout-math.ts";
export { geoCoordinate } from "./geo/geo-coordinate.ts";
export type { GeoCoordinate } from "./geo/geo-coordinate.ts";
export { ImmersiveMapPin, PinImageSource, pinCountBadge } from "./pins/immersive-map-pin.ts";
export type { ImmersiveMapPinOptions, PinClusterPolicy, PinCountBadge, PinImage } from "./pins/immersive-map-pin.ts";
export { ImmersiveMapPinsController } from "./pins/immersive-map-pins-controller.ts";
export type { PinImageLoaderFunction } from "./pins/immersive-map-pins-controller.ts";
export { PinImageLoader, PinImageLoaderError } from "./pins/pin-image-loader.ts";
export { PinImageFactory } from "./pins/pin-image-factory.ts";
export type { ImmersiveMapPinTapEvent } from "./pins/selection/pin-selection.ts";
export { ImmersiveMapSelectionController, ImmersiveMapSelectionKind } from "./selection/immersive-map-selection.ts";
export type {
  ImmersiveMapScreenPoint,
  ImmersiveMapSelection,
  ImmersiveMapSelectionChangeEvent,
  ImmersiveMapSelectionClearEvent,
  ImmersiveMapSelectionSource,
} from "./selection/immersive-map-selection.ts";
export { ImmersiveMapLayer, ImmersiveMapPointStyle, ImmersiveMapPolygonStyle, ImmersiveMapPolylineStyle } from "./layers/immersive-map-layer.ts";
export type {
  ImmersiveMapLayerOptions,
  ImmersiveMapPoint,
  ImmersiveMapPointStyleOptions,
  ImmersiveMapPolygon,
  ImmersiveMapPolygonStyleOptions,
  ImmersiveMapPolyline,
  ImmersiveMapPolylineStyleOptions,
} from "./layers/immersive-map-layer.ts";
export { ImmersiveMapTileGridController } from "./tile-grid/immersive-map-tile-grid-controller.ts";
export type {
  ImmersiveMapTileGridLabelProvider,
  ImmersiveMapTileGridSelectionChange,
  ImmersiveMapTileGridTapRejection,
  ImmersiveMapTileGridTapRejectionReason,
} from "./tile-grid/immersive-map-tile-grid-controller.ts";
export { ImmersiveMapTileID } from "./geo/immersive-map-tile-id.ts";
export { ImmersiveMapGeoBounds } from "./geo/immersive-map-geo-bounds.ts";
export { ImmersiveMapLayersController } from "./layers/immersive-map-layers-controller.ts";
export type { ImmersiveMapGeoJSONSource, ImmersiveMapLayersControllerOptions, ImmersiveMapShapesSource } from "./layers/immersive-map-layers-controller.ts";
export type { ImmersiveMapLayerTapEvent } from "./layers/immersive-map-layer-tap-event.ts";
export type { ImmersiveMapLayerSourceError } from "./layers/sources/layer-source-data.ts";
export type { ImmersiveMapGeoJSONError } from "./layers/geojson/immersive-map-geojson.ts";
export { ImmersiveMapSceneModel, ImmersiveMapSceneModelSource } from "./scene-models/immersive-map-scene-model.ts";
export type { ImmersiveMapSceneModelOptions, SceneModelAssetFormat } from "./scene-models/immersive-map-scene-model.ts";
export { ImmersiveMapSceneModelsController } from "./scene-models/immersive-map-scene-models-controller.ts";
export type { SceneModelOrientation, SceneModelPathAnimationCompletion, SceneModelPathAnimationOptions } from "./scene-models/immersive-map-scene-models-controller.ts";
export type { ImmersiveMapSceneModelTapEvent } from "./scene-models/immersive-map-scene-model-tap-event.ts";
export { SceneModelAssetLoadError } from "./scene-models/asset/scene-model-asset-data.ts";
export * from "./configuration/index.ts";
// Types the public API takes and returns: paths for flights and model
// animations, follow options, and what the relief reports around the camera.
export { ImmersiveMapGeoPath, type GeoPathAltitudes } from "./geo/immersive-map-geo-path.ts";
export type { ImmersiveMapPathAnimationCurve } from "./geo/immersive-map-path-animation-curve.ts";
export { ImmersiveMapCameraFollowBearing, ImmersiveMapCameraFollowOptions } from "./ui/camera/immersive-map-camera-follow-options.ts";
export type { ImmersiveMapTerrainSurroundings } from "./tile/relief/lifts/terrain-surroundings.ts";
