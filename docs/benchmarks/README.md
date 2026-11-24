# Замеры

Правила замеров: фиксированные фикстуры, прогрев, не меньше трёх прогонов, медиана и p95. Вариант заменяет действующий, только если он быстрее на 10% и больше. Каждый браузерный бенчмарк — это страница `apps/playground/bench-*.html`. Запуск:

```sh
node scripts/fetch-fixtures.mjs            # один раз
npm run dev -w playground                  # dev-сервер с cross-origin isolation на :5173
node scripts/bench.mjs bench-prep          # B1, сырые данные в docs/benchmarks/raw/
```

| # | Тема | Решение |
|---|---|---|
| [B1](B01-tile-prep.md) | Подготовка тайла: Rust/Wasm против TS | Rust/Wasm |
| [B2](B02-inflate.md) | Распаковка gzip | `DecompressionStream` (writer) |
| [B3](B03-transfer.md) | Передача тайла из воркера в GPU | transfer + `mappedAtCreation` |
| [B4](B04-planner.md) | Логика кадра: планировщик тайлов | Rust/Wasm на главном потоке |
| [B4](B04-labels.md) | Логика кадра: коллизии подписей | Rust/Wasm на главном потоке |
| [B4](B04-pins.md) | Логика кадра: раскладка и кластеры pins | Rust/Wasm на главном потоке |
| [B5–B7](B05-B07-encoding.md) | Буферы тайлов, параметры отрисовки, запись команд | буфер на тайл, storage + `firstInstance`, прямая запись |
| [B18b](B18b-layer-lines.md) | Линии слоёв приложения: инстанс на сегмент (как Swift) против готовой триангуляции в воркере слоёв | инстанс на сегмент (на 100 000 сегментов разница меньше 10% и с разным знаком, лента в 14 раз больше и в 2–3 раза дороже при обновлении) |
| [B17](B17-threads.md) | Потоки в Wasm | несколько воркеров со своим Wasm |
| [B18](B18-lines.md) | Линии: инстанс на сегмент против готовой триангуляции | готовая триангуляция в воркере |
| [B8](B08-offscreen.md) | Рендер в воркере (OffscreenCanvas) | главный поток |
| [B9](B09-terrain-decode.md) | Декодирование тайлов высот | `image-webp` в Wasm (`crates/ground-relief` в тайловых воркерах) |
| [B10](B10-occlusion.md) | Затенение долин (terrain occlusion) | compute-шейдер WebGPU (`GroundReliefOcclusionGpu`) |
| [B11](B11-geojson.md) | Разбор GeoJSON | `serde_json` в Wasm, в отдельном воркере (применяется на этапе 6) |
| [B12](B12-storage.md) | Дисковый кэш | IndexedDB |
| [B13](B13-atlas.md) | Доставка атласов шрифтов | WebP без потерь, `createImageBitmap` |
| [B14](B14-model-textures.md) | Текстуры тайлов моделей: нативный ASTC против декодирования в RGBA8 или BC7 | нативный ASTC, где есть `texture-compression-astc`, иначе RGBA8 из Wasm (`decodeModelTile`, режим 1) |
| [B15](B15-precision.md) | Точность в тяжёлых фрагментных шейдерах: f16 против f32 | f32 (f16 не быстрее, на земле на 2–4% медленнее) |
| [B16](B16-antialias.md) | Сглаживание: MSAA 4× против FXAA против обоих | по умолчанию без сглаживания. FXAA почти бесплатен, MSAA около +1 мс, оба остаются настройками |
| [B20](B20-export.md) | Экспорт видео (WebCodecs) и снимков PNG из кадра WebGPU | `new VideoFrame(canvas)` с холста WebGPU вне документа, `canvas.toBlob` для PNG |
| [B21](B21-building-levels.md) | Здания: общие вершины и острый уровень детализации вдали | общие вершины (кадр −13%, арены −19%). Острый уровень убран: 0–6% кадра за 10,5% размера арен |
| [B22](B22-shared-core.md) | Общее ядро: что из главного потока уходит в Rust | видимость тайлов и раскладка названий дорог в Rust/Wasm из ImmersiveMapCore (кадр 1.13 → 0.80 мс CPU). Рендер (wgpu медленнее на 8–16%) и контроллер камеры остаются на TypeScript |
