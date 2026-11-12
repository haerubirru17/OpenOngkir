# OpenOngkir

Tools pendamping untuk mengetahui ongkir pengiriman tanpa mengandalkan layanan
pihak ketiga (tanpa agregator seperti BinderByte atau RajaOngkir).

Berdiri sendiri sebagai layanan + database sendiri. Repo Berbirru tidak
disentuh — Berbirru (atau siapa pun) tinggal memanggil API OpenOngkir.

## Cara kerja

```text
Konsumen (Berbirru, dll) --> API OpenOngkir --> DB sendiri (wilayah + tarif)
                                                   ^-- Harvester (OpenResi)
                                                        endpoint resmi kurir
```

- Cek ongkir baca DB sendiri. Rute belum ada, dipanen sekali lalu disimpan.
- Wilayah dari dataset Kemendagri: 38 provinsi, 514 kab/kota, 7.285 kecamatan.
- Cek resi tetap live, lewat OpenResi.
- Kurir: JNE, J&T, SiCepat, POS Indonesia, AnterAja.

## Status fase

| Fase | Isi | Status |
|------|-----|--------|
| 0 | Validasi OpenResi live (ongkir + resi, 5 kurir) | ✅ Selesai — layak 4/5 kurir, AnterAja pending |
| 1 | Wilayah mandiri (dataset + seed di `db/`) | ✅ Selesai |
| 2 | Tabel tarif + harvester + API ongkir | Belum |
| 3 | Endpoint cek resi | Belum |
| 4 | Rilis v1 (deploy + dokumentasi API) | Belum |

Rencana lengkap: [PLAN.md](PLAN.md). Laporan per fase: `docs/FASE-*.md`.

## Data

- `db/schema-wilayah.sql` — skema tabel wilayah.
- `db/seed-wilayah.sql` — 7.837 baris wilayah (Kepmendagri 2025).
- Sumber: [aliziodev/laravel-indonesia-regions](https://github.com/aliziodev/laravel-indonesia-regions) (MIT), data cahyadsn/wilayah.

## Sumber panen

- [OpenResi](https://github.com/amayonaise/OpenResi) (MIT) — resolver ongkir + resi
  langsung ke endpoint resmi kurir, tanpa API key. Dipakai sebagai mesin panen,
  bukan sebagai database.

## Catatan

- Matriks tarif penuh (asal × tujuan × kurir × berat) tidak realistis — puluhan
  juta baris. Panen bersifat demand-driven: rute yang pernah dicek yang tersimpan.
- Tarif kurir berubah, jadi baris tarif punya tanggal ambil dan di-refresh berkala.
- OpenResi repo baru (Okt 2026) dan memakai endpoint internal kurir — per kurir
  dipantau, dan adapter dipertahankan agar sumber panen bisa diganti.
