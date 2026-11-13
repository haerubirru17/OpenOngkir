# Fase 4 — Rilis v1 ✅ Selesai

**Tanggal:** 13 November 2026.
**Rencana:** `PLAN.md` (Fase 4) — dokumentasi API untuk konsumen +
ukur % quote ongkir yang terlayani dari DB. Deploy layanan sudah
live sejak Fase 2/3 (VM-1, https://ongkir.lightvela.my.id), jadi
Fase 4 tidak membangun deploy baru — fokusnya dokumentasi, metrik,
dan penomoran versi 1.0.0.

## Yang dibangun

| File | Isi |
|---|---|
| `docs/API.md` (baru) | Dokumentasi API konsumen: 4 endpoint, auth, rate limit, kode error, catatan perilaku kurir |
| `db/schema-stats.sql` (baru) | Tabel `quote_stats` (dua baris: `from_db`, `live`) |
| `src/db.js` | `recordQuoteStats` / `getQuoteStats` + muat `schema-stats.sql` di `openDb` |
| `src/harvester.js` | `getCost` menghitung per kurir: dari DB vs panen live |
| `src/server.js` | `/v1/health` menampilkan metrik + versi dibaca dari `package.json` (bukan hardcode) |
| `package.json` | Versi `0.3.0` → `1.0.0` |
| `tests/stats.test.js` (baru) | 4 tes metrik (DB, harvester, health HTTP) |
| `README.md`, `PLAN.md` | Status v1 + tautan `docs/API.md` |

## Dokumentasi API (`docs/API.md`)

Ditulis dari kode nyata (`src/server.js`, `src/tracker.js`,
`src/harvester.js`) — bukan dari ingatan. Isi: base URL
`https://ongkir.lightvela.my.id`, auth `X-API-Key`, rate limit
60/menit/IP, keempat endpoint dengan parameter + contoh
request/response + kode error (400/401/404/405/429/500/502), dan
catatan penting: label estimasi + `fetched_at`, TTL tarif 30 hari,
AnterAja ongkir masih 403 (tracking-nya tidak terblokir), JNE tidak
membedakan resi tidak ada vs digit HP salah, SiCepat tracking kadang
lambat (reCAPTCHA).

Contoh memakai bentuk yang sudah terverifikasi live (health,
cost Cilegon–Bandung, track JNE). Contoh track memakai data fiktif
yang jelas-jelas contoh — tidak ada nomor resi asli, digit HP, atau
nama orang asli di dokumen repo publik ini.

## Metrik: % quote ongkir dari DB

**Definisi:** "quote" = satu kurir dalam satu permintaan
`/v1/cost`. Satu permintaan dengan 5 kurir yang 4 di antaranya ada
di DB menghitung `quotes_from_db +4` dan `quotes_live +1`. Menghitung
per kurir (bukan per permintaan) mengukur cakupan DB dengan jujur —
permintaan campuran tidak divonis "live" sepenuhnya.

**Aturan hitung** (di `harvester.getCost`, satu-satunya tempat yang
tahu kedua sisi):

- `from_db`: kurir yang punya baris tarif segar di DB saat ditanya.
- `live`: kurir yang benar-benar dipanen live di permintaan itu
  (termasuk yang panennya gagal — ia tetap "harus panen live").
- Kurir yang dilewati karena negative cache (baru gagal < 1 jam,
  tidak dipanen ulang) tidak dihitung di keduanya — tidak ada quote
  yang terlayani dari jalur mana pun.
- `fresh=1` memaksa semua kurir live (DB dilewati) — tercatat
  sebagai `live`, sesuai kenyataan.
- Cron refresh + spot-check tidak memakai `getCost`, jadi tidak
  mencemari metrik (metrik hanya mengukur permintaan konsumen).

**Penyimpanan:** tabel `quote_stats` di SQLite (persisten, ikut
restart layanan), dua baris kunci-nilai. `openDb` mengeksekusi
`db/schema-stats.sql` (`CREATE TABLE IF NOT EXISTS`) — database
produksi yang sudah ada mendapat tabel ini otomatis saat service
restart setelah deploy, tanpa migrasi manual.

**Tampilan** di `GET /v1/health`:

```json
{
  "quotes_from_db": 2,
  "quotes_live": 2,
  "quotes_db_pct": 50
}
```

`quotes_db_pct` = persen 1 desimal; `null` bila belum ada quote
sama sekali (0% akan menyesatkan — belum ada data, bukan semua live).

## Rilis v1 (versi 1.0.0)

- `package.json`: `0.3.0` → `1.0.0`.
- `/v1/health` sebelumnya hardcode `version: '0.3.0'` — kini membaca
  `package.json` saat modul dimuat, jadi `package.json` adalah satu
  sumber versi. Tes memverifikasi health melaporkan versi yang sama
  dengan `package.json`.
- `package-lock.json` tidak diubah: versi root di lock file sudah
  tertinggal sejak 0.2.0 (praktik repo ini tidak menyinkronkannya
  tiap rilis) — di luar cakupan bedah Fase 4.

## Hasil tes

- `npm test`: **56/56 hijau** (52 lama + 4 baru).
  - `quote_stats` di DB: mulai 0/0, `recordQuoteStats` mengakumulasi.
  - `getCost`: panen pertama = live; tanya kedua = dari DB;
    `fresh=1` = live lagi.
  - Negative cache: kurir yang dilewati tidak dihitung di keduanya
    (percobaan live yang gagal tetap dihitung `live`).
  - Health HTTP: field metrik + `quotes_db_pct` benar (2 dari DB +
    2 live = 50%), `version` sama dengan `package.json`,
    `quotes_db_pct` = `null` sebelum ada quote.
- Tidak ada perubahan perilaku endpoint lain — satu-satunya
  perubahan fungsional: pencatatan metrik di `getCost` + 3 field
  baru di `/v1/health` + versi dari `package.json`.

## Yang masih pending (di luar Fase 4)

- **Deploy v1 ke VM-1** (langkah terpisah — belum dikerjakan).
  Setelah deploy: restart service membuat tabel `quote_stats` di DB
  produksi; metrik mulai dari 0 (riwayat sebelum v1 tidak ada).
- **AnterAja ongkir masih 403** dari IP sandbox dan VM-1.
- **Validasi resi asli kurir lain** (J&T/SiCepat/AnterAja/POS baru
  teruji resi dummy).
- **SiCepat tracking dari VM-1** (reCAPTCHA flaky dari IP sandbox).
