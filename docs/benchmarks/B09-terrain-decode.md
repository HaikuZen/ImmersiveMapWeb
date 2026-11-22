# B9. Декодирование тайлов высот рельефа

**Сравнивали.** 27 тайлов Mapterhorn из фикстур (Церматт z10–12, Terrarium в WebP, 512×512) в воркере, от байтов файла до `Float32Array` высот в метрах:
- `createImageBitmap` (без премультипликации и без конвертации цвета) и `OffscreenCanvas.getImageData`;
- `ImageDecoder` (WebCodecs) и `VideoFrame.copyTo` в RGBA;
- декодер `image-webp` в Wasm (`crates/bench-wasm`), высоты считаются там же.

Точность — наибольшее отличие высоты от декодирования в Wasm (WebP без потерь декодируется точно). Код: `apps/playground/src/bench/terrain*.ts`, страница `bench-terrain`.

**Окружение.** Mac пользователя, Chrome 157 headless (Playwright, системный Chrome). 15 проходов по набору после 3 прогревочных.

| путь | мс на тайл (медиана) | p95 | наибольшая ошибка высоты, м |
|---|---|---|---|
| createImageBitmap + getImageData | 4.453 | 4.945 | 0 |
| ImageDecoder + copyTo | 4.387 | 4.492 | 0 |
| **image-webp в Wasm** | **3.696** | **4.056** | 0 |

Сырые данные: `raw/bench-terrain-2026-11-21-17-39.json`.

**Решение: декодер в Wasm.** Он на 16% быстрее лучшего браузерного пути и не зависит от того, как браузер обращается с цветом и альфой. B13 показал, что `ImageDecoder` премультиплицирует альфу, а высоты — это числа, а не цвета. Цена — около 50 КБ brotli к Wasm воркера. Применяется на этапе 5: декодер переходит в `crates/worker-wasm` вместе с остальной обработкой рельефа (перенос `GroundReliefDecoder`).

**Применено на этапе 5.** Декодер (перенос `GroundReliefDecoder`: WebP через `image-webp`, PNG через `png`, кодировки Terrarium и Mapbox, перевод высот в половинки f16 и их диапазон) живёт в `crates/ground-relief` и вызывается из `crates/worker-wasm` (`decodeTerrainTile`) в тайловых воркерах (`WorkerTilePipeline.loadTerrain`). Бенчмарк B9 меряет тот же декодер через `crates/bench-wasm`. Цена в Wasm воркера: около 91 КБ brotli (около 295 КБ без сжатия), из них около 48 КБ brotli WebP и около 44 КБ PNG.
