# Third-party asset licenses

## POI sprites (poi_sprites.webp)

`poi_sprites.webp` is rasterized from the [Maki](https://github.com/mapbox/maki) icon set by `scripts/build-poi-atlas.mjs` (`npm run build:poi-atlas`). Maki is by Mapbox and is released under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). The release used is v8.0.1 (commit `9fa4d9df8ba25ce84190ecfb237a14d807e7dfbc`).

The Swift engine draws these sprites from SF Symbols, which browsers do not have. Each sprite uses the closest Maki icon instead. `poi_sprites.json` records the layout and the icon per cell.

| Cell | Sprite | Swift SF Symbol | Maki icon |
| ---: | --- | --- | --- |
| 0 | Restaurant | fork.knife | restaurant |
| 1 | Cafe | cup.and.saucer.fill | cafe |
| 2 | Bar | wineglass.fill | bar |
| 3 | Park | tree.fill | park |
| 4 | Museum | building.columns.fill | museum |
| 5 | Hospital | cross.case.fill | hospital |
| 6 | School | graduationcap.fill | college |
| 7 | Airport | airplane | airport |
| 8 | Stadium | sportscourt.fill | stadium |
| 9 | Hotel | bed.double.fill | lodging |
| 10 | Shopping | bag.fill | shop |
| 11 | GasStation | fuelpump.fill | fuel |
| 12 | Pharmacy | pills.fill | pharmacy |
| 13 | Viewpoint | binoculars.fill | viewpoint |
| 14 | Train | tram.fill | rail-light |
| 15 | Transit | bus.fill | bus |
| 16 | Parking | parkingsign | parking |
| 17 | Bank | banknote.fill | bank |
| 18 | Theatre | theatermasks.fill | theatre |
| 19 | Toilets | toilet.fill | toilet |
| 20 | Civic | building.2.fill | town-hall |
| 21 | Worship | hands.and.sparkles.fill | place-of-worship |
| 22 | Marker | none | none (the cell stays empty) |
