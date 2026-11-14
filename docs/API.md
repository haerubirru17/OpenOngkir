# Dokumentasi API OpenOngkir (v1)

OpenOngkir adalah layanan cek ongkir + cek resi dengan database tarif
sendiri — tanpa agregator pihak ketiga. Harga ongkir dijawab dari
database (diambil dari endpoint resmi kurir bila rute belum ada);
cek resi selalu live ke kurir.

- **Base URL:** `https://ongkir.lightvela.my.id`
- **Versi API:** v1 (semua endpoint di bawah `/v1/`)
- **Metode:** `GET`, kecuali `POST /v1/api-keys` untuk membuat kunci.
  Metode lain menjawab `405`.
- **Format:** JSON (`Content-Type: application/json; charset=utf-8`).
  Respons sukses selalu diawali `"success": true`; respons gagal
  `"success": false` + `"error"` berisi pesan yang bisa ditampilkan.

## Konsol tes

Untuk mengetes API dari browser tanpa curl, buka `/test` di base URL
(mis. `https://ongkir.lightvela.my.id/test`). Halaman ini tidak butuh
auth untuk dibuka, tapi tiap panggilan API dari halaman memakai
`X-API-Key` yang diisi di halaman (tersimpan di localStorage browser).
Belum punya kunci? Konsol bisa membuatkan satu lewat tombol
"Buat API key" (lihat "POST /v1/api-keys" di bawah). Kunci yang
tersimpan di browser bisa dilihat dan disalin lagi dari bagian
API Keys di konsol. Konsol ini bisa
cek ongkir (dengan pemilih wilayah berjenjang), cek resi (dengan
timeline perjalanan), dan menampilkan status layanan + respons JSON
mentah tiap tes.

## Autentikasi

Semua endpoint kecuali `/v1/health` dan `POST /v1/api-keys` wajib
mengirim header:

```
X-API-Key: <kunci>
```

Tanpa header ini, atau kunci salah, API menjawab `401`:

```json
{ "success": false, "error": "API key tidak valid. Kirim header X-API-Key." }
```

Kunci yang diterima ada dua jenis: master key dari env
`OPENONGKIR_API_KEY` di server, dan key yang dibuat lewat
`POST /v1/api-keys` (disimpan server sebagai hash SHA-256 — key
aslinya tidak pernah disimpan). Key yang dicabut ditolak `401`.

## POST /v1/api-keys

Membuat API key baru. **Tanpa auth** — konsol `/test` dibuka
terbatas untuk publik agar siapa pun bisa mencoba API sendiri.
Key hanya ditampilkan sekali di respons; server tidak bisa
menampilkannya lagi nanti, jadi simpan segera.

```
POST /v1/api-keys
Content-Type: application/json

{ "label": "kunci tes" }
```

Body boleh kosong; `label` opsional (teks, maks 100 karakter).
Respons `201`:

```json
{
  "success": true,
  "api_key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "label": "kunci tes",
  "created_at": "2026-11-13T09:00:00.000Z",
  "note": "Simpan kunci ini — hanya ditampilkan sekali."
}
```

(`api_key` di atas hanya contoh bentuk — 64 karakter hex.)

**Batas pembuatan: maksimal 3 kunci baru per IP per 24 jam.**
Melewati batas menjawab `429`:

```json
{ "success": false, "error": "Batas pembuatan API key tercapai: maksimal 3 kunci baru per 24 jam dari IP ini. Coba lagi besok." }
```

Rate limit 60 permintaan/menit/IP tetap berlaku untuk semua key,
termasuk key yang baru dibuat.

## Rate limit

**60 permintaan/menit per IP** (berlaku untuk semua endpoint, termasuk
`/v1/health`). Melewati batas menjawab `429` dengan header
`Retry-After: 60`:

```json
{ "success": false, "error": "Terlalu banyak permintaan. Coba lagi sebentar." }
```

**IP klien dibaca dari header `CF-Connecting-IP`** (atau entri pertama
`X-Forwarded-For` bila tidak ada) saat permintaan tiba lewat Cloudflare
Tunnel — batas di atas dan batas pembuatan key berlaku per pengunjung,
bukan per server. Header forward diabaikan bila permintaan tidak datang
dari tunnel (anti spoofing).

## GET /v1/health

Status layanan + metrik. **Tanpa auth** (untuk monitoring).

```
GET /v1/health
```

```json
{
  "success": true,
  "status": "ok",
  "version": "1.1.0",
  "uptime_s": 198,
  "tariffs": 6,
  "courier_places": 8,
  "track_cached": 1,
  "wilayah": 7837,
  "last_update": "2026-11-12T11:00:04.543Z",
  "quotes_from_db": 2,
  "quotes_live": 2,
  "quotes_db_pct": 50
}
```

| Field | Arti |
|---|---|
| `version` | Versi layanan (sama dengan `package.json`) |
| `uptime_s` | Lama layanan jalan (detik) |
| `tariffs` | Jumlah baris tarif tersimpan |
| `courier_places` | Jumlah peta kode wilayah per kurir tersimpan |
| `track_cached` | Jumlah hasil lacak di cache |
| `wilayah` | Jumlah baris wilayah (7.837: 38 provinsi, 514 kab/kota, 7.285 kecamatan) |
| `last_update` | Waktu pembaruan tarif terakhir (`null` bila belum pernah diperbarui) |
| `quotes_from_db` | Jumlah quote ongkir yang terlayani dari DB (kumulatif, per kurir) |
| `quotes_live` | Jumlah quote yang diambil langsung dari kurir (kumulatif, per kurir) |
| `quotes_db_pct` | % quote dari DB, 1 desimal (`null` bila belum ada quote sama sekali) |

"Quote" dihitung **per kurir per permintaan** `/v1/cost`: satu
permintaan dengan 5 kurir yang 4 di antaranya ada di DB menghitung
`quotes_from_db +4` dan `quotes_live +1`. Kurir yang dilewati karena
baru saja gagal (negative cache 1 jam) tidak dihitung di keduanya —
tidak ada quote yang terlayani dari jalur mana pun.

## GET /v1/wilayah

Daftar wilayah Kemendagri (kode bertitik: provinsi `NN`, kabupaten
`NN.NN`, kecamatan `NN.NN.NN`).

```
GET /v1/wilayah
GET /v1/wilayah?parent=36
```

| Param | Wajib | Keterangan |
|---|---|---|
| `parent` | tidak | Kode wilayah induk. Tanpa param: daftar 38 provinsi. Dengan `parent`: anak-anak dari kode itu. Kode induk yang tidak ada menjawab `400`. |

Contoh respons `GET /v1/wilayah` (tanpa param — 38 provinsi):

```json
{
  "success": true,
  "data": [
    { "id": "11", "parent_id": null, "level": "provinsi", "name": "ACEH" },
    { "id": "12", "parent_id": null, "level": "provinsi", "name": "SUMATERA UTARA" },
    { "id": "13", "parent_id": null, "level": "provinsi", "name": "SUMATERA BARAT" }
  ]
}
```

`GET /v1/wilayah?parent=36` mengembalikan kabupaten di Banten
(`KABUPATEN PANDEGLANG`, `KABUPATEN LEBAK`, …); `?parent=36.71`
mengembalikan kecamatan di Kota Tangerang. Nama wilayah huruf besar
sesuai dataset Kemendagri.

## GET /v1/cost

Cek ongkir. Dibaca dari database sendiri; kurir yang rutenya belum
ada atau sudah basi (> 30 hari) diambil langsung dari kurir lalu disimpan.

```
GET /v1/cost?origin=36.72.01&destination=32.73.01&weight_g=1000&courier=jne,jnt,pos
```

| Param | Wajib | Keterangan |
|---|---|---|
| `origin` | ya | Kode **kecamatan** asal (mis. `36.72.01`) |
| `destination` | ya | Kode **kecamatan** tujuan (mis. `32.73.01`) |
| `weight_g` | tidak | Berat gram, 100–30.000 (default `1000`). Dibulatkan ke atas per kg (`weight_kg`, minimal 1). |
| `courier` | tidak | Daftar kurir dipisah koma. Default: semua kurir. Pilihan: `jne`, `jnt`, `sicepat`, `anteraja`, `pos`. Kurir tidak dikenal menjawab `400`. |
| `fresh` | tidak | `fresh=1` memaksa pengambilan langsung dari kurir untuk semua kurir (lewati DB). |

Contoh respons (rute Cilegon–Bandung, 1 kg; harga terverifikasi live):

```json
{
  "success": true,
  "origin": { "code": "36.72.01", "name": "CIBEBER" },
  "destination": { "code": "32.73.01", "name": "SUKASARI" },
  "weight_g": 1000,
  "weight_kg": 1,
  "estimate": true,
  "disclaimer": "Estimasi — harga final mengikuti tarif resmi kurir saat paket diserahkan.",
  "options": [
    { "courier": "pos", "courierName": "Pos Indonesia", "service": "Reguler", "price": 11700, "eta": "3-4 HARI", "fetched_at": "2026-11-12T11:00:04.543Z", "cached": true },
    { "courier": "jne", "courierName": "JNE Express", "service": "REG", "price": 13000, "eta": "1-2 Hari", "fetched_at": "2026-11-12T11:00:04.543Z", "cached": true },
    { "courier": "jnt", "courierName": "J&T Express", "service": "EZ", "price": 13000, "eta": "2-3 hari", "fetched_at": "2026-11-12T11:00:04.543Z", "cached": true },
    { "courier": "jnt", "courierName": "J&T Express", "service": "DOC", "price": 14000, "eta": "2-3 hari", "fetched_at": "2026-11-12T11:00:04.543Z", "cached": true },
    { "courier": "pos", "courierName": "Pos Indonesia", "service": "Nextday", "price": 22500, "eta": "1 HARI", "fetched_at": "2026-11-12T11:00:04.543Z", "cached": true },
    { "courier": "jne", "courierName": "JNE Express", "service": "YES", "price": 25000, "eta": "1-1 Hari", "fetched_at": "2026-11-12T11:00:04.543Z", "cached": true }
  ],
  "errors": [
    { "courier": "sicepat", "courierName": "SiCepat Ekspres", "error": "Lokasi tidak ditemukan di sistem SiCepat." },
    { "courier": "anteraja", "courierName": "AnterAja", "error": "Gagal memanggil API AnterAja, HTTP 403." }
  ]
}
```

Catatan respons:

- `options` urut dari harga termurah. `cached: true` berarti harga
  diambil dari database (bukan pengambilan baru); `cached: false` berarti
  baru diambil langsung dari kurir di permintaan ini.
- `fetched_at` = kapan harga itu terakhir dicek live ke kurir.
  `estimate: true` + `disclaimer` selalu ada — harga adalah estimasi
  (lihat "Catatan penting").
- `errors` berisi kurir yang gagal di permintaan ini. Sebagian kurir
  gagal tidak menggagalkan respons — selama ada minimal satu opsi,
  status tetap `200`. Bila tidak ada satu pun opsi yang berhasil
  (semua kurir gagal dan DB tidak punya tarif segar untuk rute ini),
  API menjawab `502` (`"Tarif tidak dapat diambil dari kurir untuk rute ini."`).
- Layanan kargo (JTR/SPS/GOKIL) tidak pernah muncul di `options`.

## GET /v1/track

Cek resi live ke kurir. Hasil yang ditemukan di-cache 30 menit;
`fresh=1` memaksa cek live.

```
GET /v1/track?courier=jne&awb=KAJ0000000000001&phone=12345&fresh=1
```

| Param | Wajib | Keterangan |
|---|---|---|
| `courier` | ya | Salah satu: `jne`, `jnt`, `sicepat`, `anteraja`, `pos` |
| `awb` | ya | Nomor resi |
| `phone` | JNE/J&T | Digit terakhir nomor HP: **JNE 5 digit** (penerima), **J&T 4 digit** (pengirim/penerima). Bila diisi lebih panjang (mis. nomor lengkap), diambil N digit terakhir. Kurir lain: diteruskan bila diisi (SiCepat membutuhkannya untuk sebagian resi), diabaikan bila tidak. |
| `fresh` | tidak | `fresh=1` lewati cache, paksa cek live |

Contoh respons sukses (200) — data fiktif sebagai contoh bentuk:

```json
{
  "success": true,
  "courier": "jne",
  "courierName": "JNE Express",
  "awb": "KAJ0000000000001",
  "status": "DELIVERED",
  "service": "REG",
  "sender": "Nama Pengirim",
  "recipient": "Nama Penerima",
  "origin": "TANGERANG",
  "destination": "BANDUNG",
  "events": [
    { "time": "2026-11-10 14:22:03", "status": "", "location": "TANGERANG", "description": "SHIPMENT RECEIVED AT [TANGERANG]" },
    { "time": "2026-11-12 15:09:18", "status": "", "location": "BANDUNG", "description": "DELIVERED TO [PENERIMA | 12-11-2026 15:09 | BANDUNG]" }
  ],
  "fetched_at": "2026-11-12T16:16:50.721Z",
  "cached": false
}
```

- `status` dinormalisasi ke satu dari: `DELIVERED`, `ON_DELIVERY`,
  `ON_PROCESS`, `IN_TRANSIT`, `RETURN_TO_SENDER`.
- `events` selalu urut kronologis (terlama dulu). Field `service` /
  `sender` / `recipient` / `origin` / `destination` / `status`
  per-event bisa berupa string kosong bila kurir tidak memberikannya —
  bentuk respons tetap stabil.
- Tidak ada label `estimate`: hasil lacak adalah data live faktual
  dari kurir, bukan estimasi.

### Pemetaan status HTTP

| Keadaan | HTTP | `status` di body | Keterangan |
|---|---|---|---|
| Resi ditemukan | 200 | (status paket) | Dari live atau cache 30 menit |
| Resi tidak ditemukan | 404 | `NOT_FOUND` | Pesan jelas dari kurir |
| Resi butuh digit HP (SiCepat, `phone` tidak diisi) | 400 | — | + `requiresPhoneVerification: true`, `digits` |
| Digit HP ditolak kurir (J&T) | 400 | `WRONG_PHONE_DIGITS` | Digit sudah diisi tapi tidak cocok |
| Verifikasi JNE gagal | 404 | `VERIFICATION_FAILED` | JNE tidak membedakan digit salah vs resi tidak ada (lihat bawah) |
| Input tidak valid (kurir/awb/phone) | 400 | — | Pesan menyebut digit yang dibutuhkan |
| Kurir gagal/timeout | 502 | — | Gangguan, BUKAN vonis resi palsu |

Contoh respons 404 (resi tidak ditemukan):

```json
{
  "success": false,
  "error": "Nomor resi \"1234567890\" tidak ditemukan di sistem J&T Express. Pastikan nomor resi sudah benar.",
  "courier": "jnt",
  "awb": "1234567890",
  "status": "NOT_FOUND"
}
```

## Kode error (semua endpoint)

| HTTP | Arti | Contoh pemicu |
|---|---|---|
| 400 | Input tidak valid | Kode wilayah bukan kecamatan, `weight_g` di luar 100–30.000, kurir tidak dikenal, digit HP kurang |
| 401 | API key tidak valid | Header `X-API-Key` tidak ada / salah / dicabut (tidak berlaku untuk `/v1/health` dan `POST /v1/api-keys`) |
| 404 | Tidak ditemukan | Rute tidak dikenal, resi tidak ditemukan, verifikasi JNE gagal |
| 405 | Metode tidak didukung | Selain `GET` (kecuali `POST /v1/api-keys`) |
| 429 | Rate limit | > 60 permintaan/menit/IP, atau > 3 pembuatan key baru per IP per 24 jam |
| 500 | Kesalahan internal | — |
| 502 | Kurir gagal | Tarif tidak dapat diambil dari kurir (cost) atau kurir gagal/timeout (track) |

## Catatan penting

- **Harga adalah estimasi.** Tarif disimpan di database dan dianggap
  segar 30 hari; harga final mengikuti tarif resmi kurir saat paket
  diserahkan. Selalu tampilkan `disclaimer` dan `fetched_at` ke
  pengguna akhir. Cron refresh + spot-check harian menjaga harga
  tetap dekat dengan tarif live.
- **AnterAja ongkir masih 403.** API ongkir AnterAja menolak
  permintaan dari IP layanan (403) — kurir ini muncul di `errors`
  pada `/v1/cost`. Tracking AnterAja (`/v1/track`) TIDAK terblokir.
- **JNE tidak membedakan resi tidak ada vs digit HP salah.**
  Keduanya kembali sebagai `VERIFICATION_FAILED` (404). Bila
  mendapat status ini, periksa kembali nomor resi DAN 5 digit
  terakhir HP penerima.
- **SiCepat tracking kadang lambat.** Sekali waktu SiCepat
  menggantung lama (aliran reCAPTCHA); API memakai timeout keras
  20 detik + retry, jadi satu kurir tidak menggantung respons —
  kegagalan muncul sebagai `502` (track) atau entri `errors`
  (cost), bukan hang.
- **Cache cek resi 30 menit**, hanya untuk hasil "ditemukan".
  Resi tidak ditemukan / error tidak di-cache agar percobaan
  berikutnya selalu cek live lagi.
- **Jangan kirim nomor HP lengkap** ke `/v1/track` — cukup digit
  terakhir yang diminta (JNE 5, J&T 4). Bila terlanjur mengirim
  nomor lengkap, API hanya memakai N digit terakhir.
