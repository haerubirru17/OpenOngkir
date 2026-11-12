# Rencana OpenOngkir

Tujuan: Pasar Buku Berbirru tidak lagi bergantung pada BinderByte sama sekali.
Nol panggilan, nol biaya agregator, untuk ongkir, wilayah, dan cek resi.

Kondisi awal (dicek dari `haerubirru17/berbirru`, 12 Nov 2026):

- Tiap klik "Cek Ongkir" = sampai 5 panggilan live ke BinderByte `/v1/cost`
  (1 per kurir), tanpa cache. Checkout memvalidasi ulang tarif (5 panggilan lagi).
- Dropdown wilayah juga live ke BinderByte, padahal datanya hampir tidak berubah.
- Cek resi lewat BinderByte `/v1/track`.
- Stack Berbirru: Cloudflare Worker + D1 (`berbirru-db`), cron per jam sudah ada.
  Tanpa binding KV.

## Fase 0 — Validasi (gerbang)

Tes OpenResi live sebelum membangun apa pun:

- Ongkir 5 kurir (JNE, J&T, SiCepat, POS, AnterAja), rute nyata
  Tangerang–Bandung, 1 kg. Catat harga, latensi, dan error per kurir.
- Smoke test cek resi (JNE + J&T, nomor dummy) — baru uji wiring;
  validasi resi asli butuh nomor resi sungguhan.
- Vonis per kurir: layak / tidak sebagai sumber panen.
- Hasil: `docs/FASE-0.md`.

## Fase 1 — Wilayah mandiri

- Impor dataset wilayah Kemendagri (provinsi → kabupaten → kecamatan) ke D1.
- `/api/kurir/wilayah` baca D1, bukan live lagi.
- Migrasi sekali ID kecamatan penjual yang tersimpan (saat ini ID BinderByte)
  lewat pencocokan nama ke kode Kemendagri.

## Fase 2 — Tabel tarif + panen demand-driven

- Tabel tarif di D1: asal, tujuan, kurir, layanan, berat (kg), harga, ETA,
  tanggal ambil, sumber.
- `cekTarifOngkir` baca D1 dulu. Rute belum ada: panen live sekali via OpenResi,
  simpan, sajikan. Validasi checkout juga baca D1.
- Cron refresh rute panas (asal penjual × kota besar), misal tiap 30 hari.
- OpenResi jalan sebagai layanan Node sendiri (VM-1 atau Vercel); Worker
  memanggilnya lewat HTTP.

## Fase 3 — Cek resi pindah

- `cekResi` pindah dari BinderByte `/v1/track` ke OpenResi.
- Perilaku tri-state dipertahankan: found / notfound / error (gangguan
  tidak boleh divonis resi palsu).

## Fase 4 — Putus total

- Hapus secret `BINDERBYTE_KEY` dan seluruh kode BinderByte dari repo Berbirru.
- Ukur: % quote ongkir yang terlayani dari D1.

## Keputusan yang sudah dibuat

- Bukan cache sementara, tapi database tarif sendiri (keputusan user).
- Panen demand-driven, bukan matriks penuh (tidak realistis: ~7.000 kecamatan).
- Sumber panen: OpenResi (endpoint resmi kurir), bukan BinderByte.
- Adapter (`cekTarifOngkir` / `cekResi`) dipertahankan agar provider bisa diganti.
