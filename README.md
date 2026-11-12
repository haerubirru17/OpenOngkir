# OpenOngkir

API ongkir mandiri untuk Pasar Buku [Berbirru](https://github.com/haerubirru17/berbirru).
Database tarif sendiri. Tujuan akhir: **lepas total dari BinderByte** — ongkir,
wilayah, dan cek resi semuanya pindah.

## Cara kerja

```text
Berbirru (Worker + D1)  <--  Harvester (OpenResi)  <--  Endpoint resmi kurir
   tabel tarif + wilayah       panen + simpan              tanpa API key agregator
```

- Cek ongkir baca D1 dulu. Rute belum ada, dipanen sekali lalu disimpan.
- Wilayah dari dataset Kemendagri, bukan dari agregator.
- Cek resi tetap live, lewat OpenResi.
- Kurir: JNE, J&T, SiCepat, POS Indonesia, AnterAja.

## Status fase

| Fase | Isi | Status |
|------|-----|--------|
| 0 | Validasi OpenResi live (ongkir + resi, 5 kurir) | ✅ Selesai — layak 4/5 kurir, AnterAja pending |
| 1 | Wilayah mandiri di D1 + migrasi ID kecamatan penjual | Belum |
| 2 | Tabel tarif D1, panen via OpenResi (demand-driven + cron) | Belum |
| 3 | Cek resi pindah ke OpenResi | Belum |
| 4 | Putus total: hapus key + kode BinderByte | Belum |

Rencana lengkap: [PLAN.md](PLAN.md). Hasil validasi Fase 0: `docs/FASE-0.md`.

## Sumber data

- [OpenResi](https://github.com/amayonaise/OpenResi) (MIT) — resolver ongkir + resi
  langsung ke endpoint resmi kurir, tanpa API key. Dipakai sebagai mesin panen,
  bukan sebagai database.
- Dataset wilayah: [api-wilayah-indonesia](https://github.com/emsifa/api-wilayah-indonesia)
  / [Wilayah-Administratif-Indonesia](https://github.com/edwardsamuel/Wilayah-Administratif-Indonesia).

## Catatan

- Matriks tarif penuh (asal × tujuan × kurir × berat) tidak realistis — puluhan
  juta baris. Panen bersifat demand-driven: rute yang pernah dicek yang tersimpan.
- Tarif kurir berubah, jadi baris tarif punya tanggal ambil dan di-refresh berkala.
- OpenResi repo baru (Okt 2026) dan memakai endpoint internal kurir — per kurir
  dipantau, dan adapter dipertahankan agar provider bisa diganti.
