# Fase 2 — Rencana: Tabel Tarif + Harvester + API Ongkir

**Status:** RENCANA — menunggu Gas user.
**Tanggal:** 12 November 2026.

## Tujuan

OpenOngkir bisa menjawab "berapa ongkir dari A ke B, berat X" dari database
sendiri, tanpa agregator.

## Arsitektur — Node + SQLite di VM-1 (rekomendasi)

Satu layanan Node yang berisi API + harvester, dengan OpenResi dipakai
sebagai library (import resolver langsung, tanpa HTTP hop).

```text
Konsumen --> API OpenOngkir (Node, VM-1) --> SQLite (wilayah + tarif)
                                                  ^-- Harvester (OpenResi)
```

Kenapa bukan Worker + D1: harvester butuh Node (OpenResi memakai cheerio
dan OCR — tidak jalan di Worker). Memisah API (Worker) dan harvester (Node)
berarti dua deploy, dan D1 hanya bisa ditulis dari luar lewat API Cloudflare.
Satu layanan Node lebih sederhana. Skema SQLite dan D1 se-dialek, jadi API
bisa dipindah ke Worker nanti tanpa ubah skema.

Bonus: IP VM-1 sekaligus jadi arena tes ulang AnterAja (403 dari IP sandbox
di Fase 0).

## Skema

`wilayah` sudah ada dari Fase 1. Tambahan:

- `courier_places(kemendagri_code, courier, courier_code, courier_label, resolved_at)`
  — PK (kemendagri_code, courier). Alasan: tiap kurir punya sistem kode
  lokasi sendiri (temuan Fase 0: "Bandung" jatuh ke tempat berbeda di tiap
  kurir). Mapping dibangun malas: saat pertama kali panen rute itu, kode
  kurir di-resolve via OpenResi lalu disimpan.
- `tariffs(origin_code, dest_code, courier, service, weight_kg, price, eta, fetched_at, source)`
  — PK (origin, dest, courier, service, weight_kg). Kode asal/tujuan adalah
  kode kecamatan Kemendagri. Berat dibulatkan ke atas per kg.
- `harvest_log(id, origin_code, dest_code, courier, status, latency_ms, error, created_at)`
  — memantau kegagalan panen dan rute panas untuk cron refresh.

## Alur cek ongkir

1. `GET /v1/cost?origin=36.72.01&destination=32.73.01&weight_g=1000&courier=jnt`
   (courier opsional; tanpa itu, semua kurir).
2. Validasi: kode wilayah harus ada di tabel `wilayah`; berat 100–30.000 g.
3. Baca `tariffs`. Baris segar = `fetched_at` kurang dari 30 hari.
4. Rute/kurir yang belum ada atau basi → panen live via OpenResi (resolve
   kode kurir dulu lewat `courier_places`), simpan ke `tariffs`, sajikan.
5. Respons: opsi urut termurah, bentuk sama seperti `TarifOption` Berbirru
   (`courier`, `courierName`, `service`, `price`, `eta`) + flag `cached`.
6. Filter layanan kargo (JTR/SPS/GOKIL dst) dan batas harga wajar,
   seperti yang sudah ada di Berbirru.

## Harvester

- Retry 3x + backoff (SiCepat flaky di Fase 0 — gagal 2x baru berhasil).
- Timeout 20 dtk per kurir; paralel antar kurir, berurutan per rute.
- Cron refresh harian: rute paling sering ditanya yang berumur > 30 hari.
- Jeda sopan antar panggilan ke kurir yang sama (0,5–1 dtk) agar tidak diblokir.
- AnterAja ikut dipanen; bila 403 juga dari VM-1, kurir itu ditandai
  nonaktif sementara, bukan gagal total.

## API

- `GET /v1/wilayah?parent=` — provinsi/kabupaten/kecamatan dari tabel wilayah.
- `GET /v1/cost` — seperti alur di atas.
- `GET /v1/health` — status layanan + jumlah baris tarif + panen terakhir.
- Auth: API key sederhana via header `X-API-Key` (satu key di env).
  Direkomendasikan karena layanan terekspos internet. Tanpa key = 401.
- Rate limit dasar per IP (60/menit).

## Struktur repo (tambahan)

- `src/server.js` — API.
- `src/harvester.js` — logika panen + retry + cron refresh.
- `src/db.js` — akses SQLite.
- `src/openresi/` — OpenResi sebagai dependensi (via git URL di package.json
  bila bisa di-import langsung; bila tidak, salinan vendored + catat commit).
- `db/schema-tarif.sql` — skema `courier_places`, `tariffs`, `harvest_log`.
- `tests/` — tes API + harvester (mock OpenResi) + tes live terbatas.

## Verifikasi sebelum dinyatakan selesai

- Tes lokal: 5 rute nyata × 4 kurir (harga wajar + tersimpan di DB).
- Request ke-2 untuk rute yang sama dilayani dari DB (< 100 ms).
- Rute basi (> 30 hari) di-refresh saat ditanya lagi.
- Retry SiCepat terbukti menangani gagal transien.
- AnterAja dites dari IP VM-1 (bila deploy di sana).
- Laporan `docs/FASE-2.md`.

## Keputusan (rekomendasi — Gas berarti setuju)

1. Hosting: **VM-1 (Node + SQLite)**. Alternatif: Worker + D1 (dua deploy).
2. API key: **ya**. Alternatif: terbuka tanpa key.
3. TTL tarif: **30 hari**. Alternatif: 7/14/90 hari.
