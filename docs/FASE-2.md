# Fase 2 — Tabel Tarif + Harvester + API Ongkir ✅ Selesai

**Tanggal:** 12 November 2026.
**Rencana:** `docs/FASE-2-PLAN.md` (disetujui user, termasuk 5 lapis
pengaman akurasi harga + diagram pipeline).

## Yang dibangun

Satu layanan Node (tanpa framework) + SQLite, sesuai rencana:

| File | Isi |
|---|---|
| `db/schema-tarif.sql` | Tabel `courier_places`, `tariffs`, `harvest_log` |
| `src/db.js` | Akses SQLite via `node:sqlite`; init skema + seed wilayah otomatis |
| `src/harvester.js` | Panen live, resolve kode kurir (lazy), filter, retry, cron refresh + spot-check |
| `src/server.js` | API `GET /v1/wilayah`, `GET /v1/cost`, `GET /v1/health`; auth API key; rate limit 60/menit/IP |
| `src/openresi/` | OpenResi vendored (lihat bawah) |
| `scripts/refresh.js` | Perawatan harian standalone (untuk system cron) |
| `tests/` | 29 tes unit (mock) + 4 tes live |
| `package.json` | Satu-satunya dependensi: `cheerio` (untuk scraping JNE) |

## Keputusan implementasi

- **Driver SQLite: `node:sqlite` bawaan Node** (butuh Node ≥ 24).
  Tanpa dependensi native (tanpa `better-sqlite3` / node-gyp) dan tanpa
  wasm (`sql.js`) — instalasi di VM-1 tinggal `npm install`.
- **OpenResi di-vendor** (`src/openresi/`, commit upstream `53544af` —
  commit yang sama dengan Fase 0), bukan dependensi git. Alasan: paket
  OpenResi membawa `express`, `swagger-ui-express`, `tesseract.js` yang
  tidak dibutuhkan harvester; resolver ongkir hanya butuh `cheerio` +
  `fetch`. Satu patch kecil: jalur `data/jnt-areas.json` di `jnt.js`
  disesuaikan ke layout folder ini. Detail di `src/openresi/README.md`.
- **API key:** wajib via header `X-API-Key` (env `OPENONGKIR_API_KEY`).
  Bila env tidak diset, server membuat kunci acak saat start dan
  mencetaknya ke stdout (aman secara default, tetap nyaman untuk dev).
- **`/v1/health` tanpa auth** (penyimpangan kecil dari rencana): untuk
  monitoring (mis. Uptime Kuma). Hanya menampilkan hitungan agregat.

## Penyimpangan dari rencana (dengan alasan)

1. **`courier_places` tambah kolom `role`** (`origin`/`destination`,
   PK menjadi `(kemendagri_code, courier, role)`). Alasan: satu kecamatan
   butuh kode berbeda sebagai asal vs tujuan — J&T asal = nama kota,
   tujuan = nama kecamatan; SiCepat asal = kode kota 3 huruf, tujuan =
   kode kecamatan. Tanpa `role`, satu baris tidak bisa benar untuk
   kedua peran.
2. **Negative cache 1 jam** (tambahan, ditemukan saat smoke test):
   kurir yang baru gagal untuk satu rute tidak dipanen ulang selama
   1 jam — error terakhir dipakai lagi. Tanpa ini, AnterAja yang
   terblokir 403 menambah ~4 dtk ke SETIAP request semua-kurir.
   `fresh=1` mengabaikan negative cache.
3. **POS resolve dari kecamatan untuk asal dan tujuan.** Awalnya asal
   memakai query kota dulu sehingga Coblong (Bandung) jatuh ke kode pos
   kelurahan di kecamatan lain (40113, Sumur Bandung). Sekarang kedua
   peran memakai `destinationQueries` (kecamatan dulu) → 40132
   (Lebakgede, Coblong).
4. **`db/schema-wilayah.sql`: `CREATE TABLE` → `CREATE TABLE IF NOT EXISTS`.**
   Struktur tidak berubah; hanya agar init DB idempotent (membuka DB
   yang sudah ada sebelumnya gagal).

## Pengaman akurasi harga (5 lapis, sesuai rencana)

1. **Cegah:** kode wilayah eksplisit per kurir (`courier_places`);
   harga di luar Rp 1.000–1.000.000/kg ditolak; layanan yang
   menyimpang > 5x / < 0,2x dari median termurah antar kurir dibuang;
   layanan kargo (JTR/SPS/GOKIL) dibuang.
2. **Kasih tanggal:** setiap opsi membawa `fetched_at` + flag `cached`.
3. **Spot-check:** cron harian membandingkan harga catatan vs live;
   selisih dicatat (`harvest_log` status `drift`) dan baris diperbarui.
4. **Tombol segar:** `fresh=1` memaksa panen live (mengabaikan DB dan
   negative cache).
5. **Jujur di label:** respons membawa `estimate: true` + disclaimer
   bahwa harga final mengikuti tarif resmi kurir.

## Hasil tes live (12 Nov 2026, ±17:00 WIB)

5 rute nyata × 4 kurir (JNE, J&T, SiCepat, POS), 1 kg. Semua berhasil.
Rute Tangerang–Bandung sama persis dengan acuan Fase 0 (JNE REG Rp 12.000,
J&T EZ Rp 11.000, SiCepat REG Rp 11.000, POS Reguler Rp 9.900).

| Rute | JNE REG | J&T termurah | SiCepat REG | POS Reguler |
|---|---|---|---|---|
| Tangerang → Bandung | 12.000 | EZ 11.000 | 11.000 (HALU 7.500) | 9.900 |
| Jakarta Pusat → Surabaya | 20.000 | EZ 18.000 | 18.000 (HALU 14.500) | 16.200 |
| Bandung → Yogyakarta | 18.000 | EZ 16.000 | 16.000 (HALU 12.500) | 14.400 |
| Tangerang → Makassar | 56.000 | ECO 34.000 | 62.400 (HALU 37.500) | 47.250 |
| Jakarta Pusat → Medan | 47.000 | ECO 18.000 | 36.000 (HALU 21.600) | 33.300 |

Layanan lengkap per rute (harga 1 kg): JNE REG/YES; J&T EZ/DOC (+JND
untuk Bandung, +ECO untuk Makassar/Medan); SiCepat HALU/REG (+BEST
Rp 18.000 untuk Bandung — layanan baru sejak Fase 0); POS Reguler
(+Nextday untuk rute Jawa).

**Kualitas resolve lokasi** (dari `courier_places`, 34 mapping): JNE
tujuan sampai level kecamatan (BDO10054 Coblong, SUB10030 Wonocolo,
MES10025 Medan Kota); J&T tujuan = nama kecamatan (COBLONG, WONOCOLO,
MARISO), asal = nama kota; SiCepat tujuan = kode kecamatan; POS =
kode pos kelurahan di kecamatan yang benar (40132 Lebakgede/Coblong,
20212 Pusat Pasar/Medan Kota).

**Tes lain (semua lolos):**

- 29 tes unit (`npm test`): DB, filter, retry (termasuk simulasi gagal
  2x ala SiCepat), timeout, lazy resolve, stale refresh, spot-check,
  server (auth, rate limit, validasi, 502).
- 4 tes live (`npm run test:live`): 5 rute di atas; request ke-2 dari
  DB **0,7 ms** (in-process) / **33 ms** via HTTP (batas: 100 ms);
  baris basi (> 30 hari) di-refresh saat ditanya lagi; AnterAja dicoba
  dan gagal 403 seperti yang diharapkan (lihat bawah).
- Smoke test server end-to-end: `/v1/health`, auth 401, `/v1/wilayah`,
  `/v1/cost` cached + `fresh=1` — semua sesuai.
- Total hasil panen: **42 baris tarif** tersimpan; 24 panen sukses +
  1 error AnterAja di `harvest_log`.

**Catatan latensi:** seluruh suite live 5 rute selesai ±20 dtk —
jauh lebih cepat dari latensi Fase 0 (J&T 18 dtk/rute). Kemungkinan
karena resolve lokasi kini ter-cache di `courier_places` dan endpoint
kurir sedang responsif; bukan jaminan kecepatan di masa depan.

## AnterAja: masih pending

Panen live dari IP sandbox tetap gagal: `Gagal memanggil API Anteraja
(HTTP status 403)` (±4 dtk). Sesuai dugaan Fase 0 (blokir Akamai level
IP). **Bukan blocker:** kurir lain jalan, dan negative cache mencegah
AnterAja memperlambat request. **Tes ulang dari VM-1** setelah deploy.

## Menjalankan

```bash
npm install
OPENONGKIR_API_KEY=<kunci-acak> node src/server.js
# atau: cp .env.example .env  (isi kuncinya)  lalu:
node --env-file=.env src/server.js
```

Perawatan harian (refresh + spot-check) jalan otomatis di dalam service
(tiap 24 jam) atau via system cron: `node scripts/refresh.js`.

## Yang masih pending (di luar Fase 2)

- **Deploy ke VM-1** (langkah terpisah — belum dikerjakan).
- **Tes ulang AnterAja dari IP VM-1** setelah deploy.
- Fase 3: endpoint cek resi. Fase 4: rilis v1.
