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

## Fase 2 — Tabel tarif + harvester + API ongkir

- Tabel tarif: asal, tujuan, kurir, layanan, berat (kg), harga, ETA,
  tanggal ambil, sumber.
- Harvester demand-driven: rute belum ada dipanen sekali via OpenResi,
  simpan, sajikan. Cron refresh rute panas.
- API ongkir: cek tarif dari DB (asal, tujuan, berat, kurir opsional).
- Filter layanan kargo (JTR/SPS/GOKIL) dipertahankan dari Berbirru.

## Fase 3 — Endpoint cek resi

- Cek resi lewat OpenResi (live).
- Perilaku tri-state: found / notfound / error (gangguan tidak boleh
  divonis resi palsu).
- Alur digit HP (JNE 5 digit, J&T 4 digit) diputuskan sebelum membangun.

## Fase 4 — Rilis v1

- Deploy layanan + dokumentasi API untuk konsumen.
- Ukur: % quote ongkir yang terlayani dari DB.

## Keputusan yang sudah dibuat

- Tools mandiri, bukan integrasi ke Berbirru (koreksi user 12 Nov 2026).
- Database tarif sendiri, bukan cache sementara.
- Panen demand-driven, bukan matriks penuh.
- Sumber panen: OpenResi (endpoint resmi kurir), bukan agregator.
- Dataset wilayah: aliziodev/laravel-indonesia-regions (edwardsamuel/emsifa
  ditolak: kode 7 digit tanpa titik + hanya 34 provinsi).
