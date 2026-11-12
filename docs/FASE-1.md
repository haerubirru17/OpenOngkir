# Fase 1 — Wilayah Mandiri di D1

> **Koreksi cakupan (12 Nov 2026, 16:26):** OpenOngkir adalah tools pendamping
> yang berdiri sendiri — repo Berbirru tidak disentuh. Laporan di bawah ini
> ditulis saat Fase 1 masih dikerjakan sebagai integrasi ke Berbirru
> (PR berbirru #1). PR tersebut **tidak akan di-merge**. Yang dipakai dari
> Fase 1: dataset wilayah + seed SQL, sekarang tinggal di `db/` repo ini.
> Perubahan kode Berbirru (`src/kurir.ts`, migrasi, tes) tidak berlaku.

**Tanggal:** 12 November 2026
**PR (cakupan lama, tidak akan di-merge):** https://github.com/haerubirru17/berbirru/pull/1 (branch
`openongkir/fase-1-wilayah` → `main`)
**Status:** dataset + seed sudah pindah ke `db/` repo ini. PR Berbirru
tidak berlaku lagi.

## Apa yang dikerjakan (cakupan lama)

Dropdown wilayah (provinsi → kabupaten → kecamatan) tidak lagi live ke
BinderByte. `ambilWilayah()` di `src/kurir.ts` sekarang baca tabel D1
`wilayah`. Route `GET /api/kurir/wilayah` tidak berubah; cek tarif dan cek
resi tetap di BinderByte untuk sekarang (Fase 2/3).

| File | Perubahan |
|---|---|
| `src/kurir.ts` | `ambilWilayah()` query D1; fetch `/wilayah/*` + konstanta `ROOT` dihapus. Signature, pesan error, dan jalur `KURIR_MOCK` dipertahankan. |
| `migrations/0038_wilayah.sql` | Tabel `wilayah` (id, parent_id, level, name) + indeks `parent_id`. Tabel saja, tanpa seed. |
| `scripts/seed-wilayah.sql` | 7.837 baris, 16 statement `INSERT OR REPLACE` (≤500 baris each), satu transaksi, idempotent. |
| `tests/wilayah.test.ts` | Tes baru: D1 sungguhan (node:sqlite) + stub `prepare/bind/all`; mengunci provinsi/kabupaten/kecamatan, parent tak dikenal, mock, error tanpa DB, dan kontrak "tidak ada lagi fetch /wilayah". |
| `.gitignore` | Whitelist `scripts/seed-wilayah.sql` (aturan `*.sql` sebelumnya mengabaikannya). |

## Dataset

**Sumber: aliziodev/laravel-indonesia-regions (MIT)**, datanya dari
cahyadsn/wilayah (Kepmendagri No 300.2.2-2430 Tahun 2025).

| Level | Jumlah |
|---|---|
| Provinsi | 38 |
| Kabupaten/kota | 514 |
| Kecamatan | 7.285 |
| **Total** | **7.837** |

Nama di-UPPERCASE agar tampilannya sama seperti respons BinderByte selama ini.
Nama ber-apostrof (20 kecamatan, misal `MA'U`, `O'O'U`) lolos dengan benar
(setelah diperbaiki dari parser awal yang memotongnya).

### Kenapa bukan edwardsamuel / emsifa (rencana awal)

Keduanya **ditolak setelah diverifikasi**, karena dua alasan:

1. **Format kode tidak cocok.** Keduanya memakai kode 7 digit tanpa titik
   (`3672040` untuk Cibeber). BinderByte memakai kode bertitik
   (`36.72.01`). Segmen kecamatan 2 digit pada kode bertitik adalah nomor
   urut dekret (dengan celah historis, misal Kab. Bandung mulai dari
   `32.04.05`), jadi TIDAK bisa dikonversi dari kode 7 digit. Memakai data
   7 digit akan merusak `district_id` tersimpan dan prefix `kec_` untuk cek
   ongkir.
2. **Ketinggalan zaman.** Keduanya hanya 34 provinsi / 7.215 kecamatan
   (pra-pemekaran Papua; Papua masih satu provinsi berkode 94).

## Vonis kompatibilitas ID: COCOK

ID seed (kode bertitik Kemendagri) **sama dengan ID BinderByte**. Bukti:

- Mock repo ini + script e2e memakai `36.72.01` = Cibeber,
  `36.72.02` = Cilegon — cocok persis dengan dataset.
- Dua dataset independen (aliziodev, afiiif/kode-wilayah-dan-pos) memakai
  kode yang sama untuk Cibeber/Cilegon.
- Cross-check 13 kode mock: 9 cocok. 4 yang beda adalah kesalahan mock,
  bukan dataset (Tanah Abang bukan `31.71.02` melainkan Sawah Besar;
  Cimanuk bukan di `36.03` melainkan Pandeglang; Soreang adalah
  `32.04.37` bukan `32.04.01`; `31` bernama resmi Daerah Khusus Ibukota
  Jakarta).
- Dok BinderByte (docs.binderbyte.com, dicek 12 Nov) tidak menampilkan
  contoh respons wilayah, jadi vonis ini bersandar pada bukti di atas —
  bukan pada dok resmi.

**Akibatnya: tidak perlu migrasi data.** `district_id` penjual/pembeli yang
tersimpan tetap berlaku. ID lama yang tidak ketemu di D1 (hanya mungkin
untuk Papua, lihat risiko) berarti penjual pilih ulang asal.

## Sisa risiko

1. **Papua.** Provinsi 91–96 dinomori ulang + dimekarkan di Kepmendagri 2025
   (Papua Barat lama 91 → 92, Papua lama 94 → 91/93/94/95). ID lama penjual
   Papua kemungkinan tidak ketemu di D1. Dampak terbatas (penjual Papua
   sedikit) dan tertangani jalur pilih-ulang.
2. **Dok BinderByte terbaru** menyarankan ambil ID lokasi dari
   `GET /v1/locations` untuk cek ongkir dan menyatakan ID wilayah "tidak
   dapat dipakai langsung". Berbirru memakai prefix `kec_` + ID wilayah,
   yang terverifikasi live 26 Okt — jadi tidak mengubah Fase 1. Urusan
   format ID ongkir diputuskan di Fase 2.
3. **Pemekaran berikutnya.** Data wilayah berubah saat ada pemekaran baru.
   Seed perlu di-refresh berkala dari sumber yang sama (cara bangkitkan
   ulang terdokumentasi di header `db/seed-wilayah.sql`).

## Perintah apply + deploy — TIDAK BERLAKU (cakupan lama)

Bagian ini dari cakupan lama (integrasi Berbirru) dan tidak berlaku lagi.
Disimpan sebagai catatan saja:

```bash
# 1. Merge PR #1 dulu, lalu dari repo berbirru:
npx wrangler d1 migrations apply berbirru-db --remote
npx wrangler d1 execute berbirru-db --remote --file=scripts/seed-wilayah.sql
npx wrangler d1 execute berbirru-db --remote --command "SELECT level, COUNT(*) FROM wilayah GROUP BY level"
# harus: kabupaten 514, kecamatan 7285, provinsi 38
npm run deploy
```

## Verifikasi yang sudah dilakukan

- `npm test`: 61 OK (termasuk tes baru). `npx tsc --noEmit`: lolos.
- Seed divalidasi dengan sqlite3: jumlah per level 38/514/7285, 0
  `parent_id` hilang, lookup `36` → 8 kabupaten dan `36.72` → 8 kecamatan
  (termasuk `36.72.01` CIBEBER), seed kedua tetap 7.837 baris.
- Push diverifikasi: SHA kelima file di branch cocok dengan
  `git hash-object` lokal. Commit `26bc1190`.

## Catatan lingkungan

`package-lock.json` repo ini mengarah ke mirror Tencent
(`mirrors.tencentyun.com`), yang tidak terjangkau dari VM sandbox — `npm ci`
gagal di sana. Untuk tes lokal, install dilakukan dengan lockfile segar dari
`registry.npmjs.org`, lalu lockfile asli dikembalikan (tidak ikut ter-push).
Tidak ada dampak ke PR.

## Tindak lanjut (cakupan baru)

1. Tutup PR berbirru #1 (menunggu keputusan user).
2. Dataset + seed sudah di `db/` repo ini — dipakai Fase 2.
3. Lanjut Fase 2: tabel tarif + harvester + API ongkir.
