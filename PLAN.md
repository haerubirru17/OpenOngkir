# Rencana OpenOngkir

**OpenOngkir adalah tools pendamping yang berdiri sendiri**: layanan untuk
mengetahui ongkir pengiriman tanpa mengandalkan layanan pihak ketiga.
Punya database wilayah + tarif sendiri, dipanen dari endpoint resmi kurir
via OpenResi. Repo Berbirru tidak disentuh — integrasi (bila ada) adalah
keputusan terpisah nanti.

## Arsitektur

```text
Konsumen --> API OpenOngkir (wilayah, ongkir, resi) --> DB sendiri
                                                        ^-- Harvester (OpenResi)
```

- API: cek wilayah, cek ongkir (baca DB, panen bila rute belum ada), cek resi (live).
- DB: SQLite/D1 — tabel wilayah + tarif (+ log panen nanti).
- Harvester: OpenResi sebagai sumber panen; demand-driven + cron rute panas.

## Fase 0 — Validasi ✅ Selesai

Tes OpenResi live (laporan: `docs/FASE-0.md`): layak 4/5 kurir
(JNE, J&T, SiCepat, POS). AnterAja pending (403 Akamai dari IP sandbox,
tes ulang dari VM-1/VPS). Temuan: kode wilayah eksplisit per kurir,
latensi live 2–18 dtk, tracking butuh digit HP.

## Fase 1 — Wilayah mandiri ✅ Selesai

Dataset wilayah + seed (laporan: `docs/FASE-1.md`):
aliziodev/laravel-indonesia-regions (MIT), data Kepmendagri 2025 —
38 provinsi, 514 kab/kota, 7.285 kecamatan, kode bertitik native.
Skema di `db/schema-wilayah.sql`, seed di `db/seed-wilayah.sql`.

Koreksi cakupan (12 Nov 2026): Fase 1 awalnya dikerjakan sebagai integrasi
ke repo Berbirru (PR berbirru #1). Atas koreksi user, OpenOngkir diputuskan
sebagai tools mandiri — PR tersebut tidak di-merge dan repo Berbirru tidak
disentuh. Dataset + seed dipakai ulang di repo ini.

## Fase 2 — Tabel tarif + harvester + API ongkir ✅ Selesai

Layanan Node + SQLite (laporan: `docs/FASE-2.md`):

- Tabel tarif: asal, tujuan, kurir, layanan, berat (kg), harga, ETA,
  tanggal ambil, sumber — plus `courier_places` (peta kode Kemendagri
  ke kode tiap kurir, per role asal/tujuan) dan `harvest_log`.
- Harvester demand-driven via OpenResi (vendored, commit `53544af`):
  retry 3x, timeout 20 dtk/kurir, filter kargo (JTR/SPS/GOKIL),
  batas harga wajar + filter outlier antar kurir, negative cache 1 jam
  untuk kurir yang gagal.
- API ongkir: `GET /v1/cost` (baca DB, panen bila rute belum ada/basi,
  `fresh=1` memaksa live), `GET /v1/wilayah`, `GET /v1/health`.
  Auth `X-API-Key`, rate limit 60/menit/IP.
- Pengaman akurasi: `fetched_at` + flag `cached` di tiap opsi, cron
  refresh + spot-check harian, label estimasi.
- Tes live 12 Nov 2026: 5 rute × 4 kurir berhasil (42 baris tarif);
  request ke-2 dari DB 0,7 ms; AnterAja masih 403 dari IP sandbox
  (tes ulang dari VM-1 setelah deploy).

## Fase 3 — Endpoint cek resi ✅ Selesai

Layanan Node + SQLite (laporan: `docs/FASE-3.md`):

- `GET /v1/track?courier=&awb=&phone=&fresh=1` — cek resi live via
  OpenResi, respons ternormalisasi (status standar, events kronologis).
- Tri-state: found (200) / not_found (404) / error kurir (502) —
  gangguan tidak divonis resi palsu.
- Digit HP wajib untuk JNE (5 digit penerima) dan J&T (4 digit
  pengirim/penerima); pesan error menyebut hanya digit terakhir yang
  dibutuhkan. JNE tidak membedakan digit salah vs resi tidak ada
  (`VERIFICATION_FAILED` → 404 dengan pesan dua kemungkinan).
- Cache singkat 30 menit (`track_cache`), hanya hasil "ditemukan";
  `fresh=1` memaksa live. Retry 3x + timeout 20 dtk.
- Tes live 12 Nov 2026: resi dummy 5 kurir memberi tri-state rapi
  (JNE verification_failed, J&T/POS/AnterAja not_found, SiCepat
  flaky — sekali gantung > 60 dtk, sekali not_found 2,8 dtk).
  AnterAja tracking TIDAK terblokir 403 (berbeda dengan API ongkirnya).
- PENDING: validasi resi asli butuh satu resi asli + digit HP dari user.

## Fase 4 — Rilis v1 ✅ Selesai

Laporan: `docs/FASE-4.md`.

- Dokumentasi API konsumen di `docs/API.md` (4 endpoint, auth,
  rate limit, kode error, catatan perilaku kurir).
- Metrik % quote dari DB: hitungan per kurir per permintaan
  `/v1/cost`, persisten di SQLite (`quote_stats`), tampil di
  `/v1/health` (`quotes_from_db`, `quotes_live`, `quotes_db_pct`).
- Versi 1.0.0 (`package.json` = satu sumber versi; `/v1/health`
  membacanya dari sana, bukan hardcode).
- Deploy layanan sudah live sejak Fase 2/3 (VM-1,
  https://ongkir.lightvela.my.id) — Fase 4 merilis dokumentasi +
  metrik + versi; deploy v1 ke VM-1 adalah langkah terpisah.

## Keputusan yang sudah dibuat

- Tools mandiri, bukan integrasi ke Berbirru (koreksi user 12 Nov 2026).
- Database tarif sendiri, bukan cache sementara.
- Panen demand-driven, bukan matriks penuh.
- Sumber panen: OpenResi (endpoint resmi kurir), bukan agregator.
- Dataset wilayah: aliziodev/laravel-indonesia-regions (edwardsamuel/emsifa
  ditolak: kode 7 digit tanpa titik + hanya 34 provinsi).
