# OpenResi (vendored)

Salinan sebagian dari [amayonaise/OpenResi](https://github.com/amayonaise/OpenResi)
(lisensi MIT), **commit `53544af`** (18 Okt 2026) — commit yang sama dengan
yang divalidasi di Fase 0 (`docs/FASE-0.md`).

## Kenapa di-vendor, bukan dependensi git

Paket OpenResi membawa dependensi server penuh (`express`, `cors`,
`swagger-ui-express`, `tesseract.js`, `pngjs`) yang tidak dibutuhkan
harvester. Resolver ongkir hanya butuh `cheerio` (JNE) + `fetch` bawaan
Node. Vendor membuat instalasi OpenOngkir ringan dan tidak bergantung pada
riwayat upstream.

## Yang disalin

- `resolvers/base.js`, `jne.js`, `jnt.js`, `sicepat.js`, `anteraja.js`,
  `pos.js` — verbatim, kecuali satu patch di bawah.
- `utils/locationParser.js` — verbatim (dipakai resolver untuk ranking
  hasil pencarian lokasi).
- `data/jnt-areas.json` — database wilayah J&T (1,7 MB), dipakai resolver
  J&T untuk resolve kota/kecamatan secara lokal.
- `index.js` — adaptasi ringkas dari `src/index.js` upstream: hanya 5 kurir
  di atas (TIKI, Ninja, IDExpress, Lion tidak disalin).

## Patch terhadap upstream

1. `resolvers/jnt.js`: jalur `data/jnt-areas.json` diubah dari
   `../../data/` menjadi `../data/` agar sesuai layout folder ini.

## Catatan upstream

- Resolver POS membawa kunci API mobile PosAja hasil ekstrak upstream
  (tertulis di `resolvers/pos.js`, bisa di-override via env
  `POS_TRACKING_API_KEY`, `POS_JEMBATAN_USER`, `POS_JEMBATAN_PASSWORD`).
  Itu kunci dari repo OpenResi, bukan dari proyek ini.
- JNE ongkir = scraping HTML (rapuh terhadap perubahan layout jne.co.id).
- Bila upstream merilis perbaikan resolver, sinkronkan file yang berubah
  dan perbarui nomor commit di file ini + `docs/FASE-2.md`.
