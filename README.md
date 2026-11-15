# OpenOngkir

Tools pendamping untuk mengetahui ongkir pengiriman tanpa mengandalkan layanan
pihak ketiga (tanpa agregator seperti BinderByte atau RajaOngkir).

Berdiri sendiri sebagai layanan + database sendiri. Repo Berbirru tidak
disentuh — Berbirru (atau siapa pun) tinggal memanggil API OpenOngkir.

Layanan live: <https://ongkir.lightvela.my.id> — dokumentasi API untuk
konsumen: [`docs/API.md`](docs/API.md). Konsol di browser:
[`/console`](https://ongkir.lightvela.my.id/console) — cek ongkir dan cek resi
tanpa curl; API key bisa dibuat langsung dari konsol (tombol
"Buat API key", maks 3 per IP per 24 jam) atau pakai kunci master
dari `.env` di server.

## Cara kerja

```text
Konsumen (Berbirru, dll) --> API OpenOngkir --> DB sendiri (wilayah + tarif)
                                                   ^-- Harvester (OpenResi)
                                                        endpoint resmi kurir
```

- Cek ongkir baca DB sendiri. Rute belum ada, diambil sekali dari kurir lalu disimpan.
- Wilayah dari dataset Kemendagri: 38 provinsi, 514 kab/kota, 7.285 kecamatan.
- Cek resi tetap live, lewat OpenResi.
- Kurir: JNE, J&T, SiCepat, POS Indonesia, AnterAja.

## Status fase

| Fase | Isi | Status |
|------|-----|--------|
| 0 | Validasi OpenResi live (ongkir + resi, 5 kurir) | ✅ Selesai — layak 4/5 kurir, AnterAja pending |
| 1 | Wilayah mandiri (dataset + seed di `db/`) | ✅ Selesai |
| 2 | Tabel tarif + harvester + API ongkir | ✅ Selesai — 5 rute × 4 kurir live, AnterAja masih pending |
| 3 | Endpoint cek resi | ✅ Selesai — tri-state rapi; resi asli JNE tervalidasi (parser JSON) |
| 4 | Rilis v1 (deploy + dokumentasi API) | ✅ Selesai — v1.0.0, `docs/API.md` + metrik quote dari DB |

Rencana lengkap: [PLAN.md](PLAN.md). Laporan per fase: `docs/FASE-*.md`.

## Menjalankan

```bash
npm install
OPENONGKIR_API_KEY=<kunci-acak> node src/server.js
```

Butuh Node ≥ 24. Base URL: `https://ongkir.lightvela.my.id/v1`.
API: `GET /wilayah?parent=`,
`GET /cost?origin=&destination=&weight_g=&courier=&fresh=1`,
`GET /track?courier=&awb=&phone=&fresh=1`,
`GET /health`, `POST /api-keys` (buat key baru, maks 3/IP/24 jam).
Semua endpoint kecuali `/health` dan `POST /api-keys` butuh header
`X-API-Key`. Dokumentasi API lengkap: `docs/API.md`. Laporan per
fase: `docs/FASE-2.md`, `docs/FASE-3.md`, `docs/FASE-4.md`.

## Self-hosting

Repo ini bisa di-self-host: satu service Node + SQLite, tanpa layanan
berbayar. Butuh Node ≥ 24 (atau Docker).

### Docker

```bash
cp .env.example .env   # isi OPENONGKIR_API_KEY dengan kunci acak yang kuat
docker compose up -d
curl localhost:3000/v1/health
```

Data tersimpan di volume `openongkir-data` (DB SQLite di `data/`).
Konsol: <http://localhost:3000/console>.

### Manual

```bash
npm ci
OPENONGKIR_API_KEY=<kunci-acak> npm start
```

Variabel env: lihat `.env.example`. Tanpa `OPENONGKIR_API_KEY`, server
membuat kunci sementara saat start (berlaku sampai restart).

Catatan:

- DB tarif mulai KOSONG dan terisi demand-driven: quote pertama tiap rute
  diambil live dari kurir, quote berikutnya dibaca dari DB lokal.
- Wilayah (7.837 baris) otomatis ter-seed saat start pertama.
- Perawatan harian (refresh rute basi + spot-check) jalan otomatis di
  dalam service tiap 24 jam. `npm run refresh` menjalankan perawatan yang
  sama secara manual (atau via cron sistem — lihat `scripts/refresh.js`).
- Sebagian kurir memblokir IP server tertentu: SiCepat + AnterAja
  mengembalikan 403 dari IP VM kami, tapi jalan dari IP lain. Hasil per
  kurir di servermu bisa berbeda.

## Data

- `db/schema-wilayah.sql` — skema tabel wilayah.
- `db/seed-wilayah.sql` — 7.837 baris wilayah (Kepmendagri 2025).
- Sumber: [aliziodev/laravel-indonesia-regions](https://github.com/aliziodev/laravel-indonesia-regions) (MIT), data cahyadsn/wilayah.

## Sumber tarif

- [OpenResi](https://github.com/amayonaise/OpenResi) (MIT) — resolver ongkir + resi
  langsung ke endpoint resmi kurir, tanpa API key. Dipakai sebagai mesin pengambilan tarif,
  bukan sebagai database.

## Catatan

- Matriks tarif penuh (asal × tujuan × kurir × berat) tidak realistis — puluhan
  juta baris. Pengambilan tarif bersifat demand-driven: rute yang pernah dicek yang tersimpan.
- Tarif kurir berubah, jadi baris tarif punya tanggal ambil dan di-refresh berkala.
- OpenResi repo baru (Okt 2026) dan memakai endpoint internal kurir — per kurir
  dipantau, dan adapter dipertahankan agar sumber tarif bisa diganti.
