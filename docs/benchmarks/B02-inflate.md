# B2. Распаковка gzip

**Сравнивали.** Распаковку сжатых тайлов из фикстур в воркере. Каждый путь заканчивается там, где Wasm-парсер может читать байты, поэтому к JS-путям добавлено копирование в память Wasm:
- `DecompressionStream`, вход через `Blob.stream()`;
- `DecompressionStream`, вход через `writable.getWriter()`;
- `miniz_oxide` в Wasm;
- `zlib-rs` (через `flate2`) в Wasm.

Код: `crates/bench-wasm`, `apps/playground/src/bench/inflate*.ts`.

**Окружение.** Mac пользователя (8 логических ядер), Chrome 157 headless (Playwright, системный Chrome), cross-origin isolation включена (точность таймера 5 мкс). Фикстуры: `node scripts/fetch-fixtures.mjs`, 131 тайл (Москва и Манхэттен z14–15, Церматт z10–13, Рим z15, Париж z10, глобус z0–5, океан z8). 25 проходов по всему набору (7,6 МБ gzip, 11,5 МБ после распаковки).

| путь | весь набор, мс (медиана) | p95 | мс на МБ распаковки | мс на тайл |
|---|---|---|---|---|
| DecompressionStream (Blob) + копия в Wasm | 55.9 | 65.4 | 4.86 | 0.43 |
| **DecompressionStream (writer) + копия в Wasm** | **36.3** | **40.1** | **3.16** | **0.28** |
| miniz_oxide в Wasm | 47.8 | 50.7 | 4.15 | 0.37 |
| zlib-rs в Wasm | 45.8 | 48.6 | 3.97 | 0.35 |

Сырые данные: `raw/bench-inflate-2026-11-21-15-58.json`.

**Решение: `DecompressionStream` с writer.** Он на 21% быстрее лучшего Wasm-варианта, даже с копированием в Wasm, и не добавляет кода в бандл. Вход через `Blob` медленнее на 54%, его не используем. Применено в `packages/immersive-map/src/worker/tile-worker.ts`.
