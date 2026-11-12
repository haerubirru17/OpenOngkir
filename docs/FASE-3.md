# Fase 3 — Endpoint Cek Resi ✅ Selesai

**Tanggal:** 12 November 2026.
**Rencana:** `PLAN.md` (Fase 3) — cek resi live via OpenResi, perilaku
tri-state found / not_found / error, alur digit HP.

## Yang dibangun

| File | Isi |
|---|---|
| `src/tracker.js` | Logika lacak: validasi phone, cache 30 menit, retry, normalisasi hasil |
| `src/server.js` | Endpoint `GET /v1/track` (+ `track_cached` di `/v1/health`, versi 0.3.0) |
| `db/schema-track.sql` | Tabel `track_cache` (courier, awb, payload, fetched_at) |
| `src/db.js` | `getTrackCache` / `saveTrackCache` / `countTrackCache` (+ prune baris basi) |
| `tests/track.test.js` | 17 tes unit + mock (tracker + endpoint) |
| `tests/live.test.js` | +2 tes live (smoke test resi dummy + endpoint HTTP live) |

## Endpoint

```
GET /v1/track?courier=jnt&awb=JP1234567890&phone=1234&fresh=1
Header: X-API-Key: <kunci>
```

| Param | Wajib | Keterangan |
|---|---|---|
| `courier` | ya | Salah satu: `jne`, `jnt`, `sicepat`, `anteraja`, `pos` |
| `awb` | ya | Nomor resi |
| `phone` | JNE/J&T | Digit terakhir HP: JNE 5 digit (penerima), J&T 4 digit (pengirim/penerima). Bila diisi lebih panjang (mis. nomor lengkap), diambil N digit terakhir. Kurir lain: diteruskan bila diisi (SiCepat membutuhkannya untuk sebagian resi), diabaikan bila tidak. |
| `fresh` | tidak | `fresh=1` lewati cache, paksa cek live |

Auth + rate limit sama seperti `/v1/cost` (X-API-Key, 60/menit/IP).

### Respons sukses (200)

```json
{
  "success": true,
  "courier": "jnt",
  "courierName": "J&T Express",
  "awb": "JP1234567890",
  "status": "ON_DELIVERY",
  "service": "EZ",
  "sender": "",
  "recipient": "",
  "origin": "",
  "destination": "",
  "events": [
    { "time": "2026-11-10 20:00:00", "status": "MANIFEST", "location": "JAKARTA", "description": "Paket dimanifest" },
    { "time": "2026-11-12 10:00:00", "status": "SEDANG DIANTAR", "location": "BANDUNG", "description": "Paket sedang diantar kurir" }
  ],
  "fetched_at": "2026-11-12T15:00:00.000Z",
  "cached": false
}
```

`status` dinormalisasi ke satu dari: `DELIVERED`, `ON_DELIVERY`,
`ON_PROCESS`, `IN_TRANSIT`, `RETURN_TO_SENDER`. `events` selalu urut
kronologis (terlama dulu) — resolver tiap kurir mengembalikan urutan
yang berbeda-beda (J&T terbaru dulu, JNE/POS tergantung halaman kurir).
Field `service`/`sender`/`recipient`/`origin`/`destination` bisa berupa
string kosong bila kurir tidak memberikannya (bentuk respons tetap stabil).

Tidak ada label `estimate` seperti di `/v1/cost`: hasil lacak adalah data
live faktual dari kurir, bukan estimasi.

### Pemetaan status HTTP (tri-state + verifikasi HP)

| Keadaan | HTTP | `status` di body | Keterangan |
|---|---|---|---|
| Resi ditemukan | 200 | (status paket) | Dari live atau cache 30 menit |
| Resi tidak ditemukan | 404 | `NOT_FOUND` | Pesan jelas dari kurir |
| Resi butuh digit HP (SiCepat, phone tidak diisi) | 400 | — | + `requiresPhoneVerification: true`, `digits` |
| Digit HP ditolak kurir (J&T) | 400 | `WRONG_PHONE_DIGITS` | Digit sudah diisi tapi tidak cocok |
| Verifikasi JNE gagal | 404 | `VERIFICATION_FAILED` | JNE tidak membedakan digit salah vs resi tidak ada (lihat bawah) |
| Input tidak valid (kurir/awb/phone) | 400 | — | Pesan menyebut digit yang dibutuhkan |
| Kurir gagal/timeout | 502 | — | Gangguan, BUKAN vonis resi palsu |

## Keputusan implementasi

- **Cache 30 menit, hanya hasil "ditemukan".** Status paket berubah
  seiring waktu, jadi tidak disimpan lama seperti tarif. Resi tidak
  ditemukan / error tidak di-cache agar percobaan berikutnya selalu cek
  live lagi (resi yang baru dikirim bisa muncul belakangan).
- **Validasi phone di tracker (satu tempat).** Server hanya memetakan
  kind → HTTP. Pesan error menyebut jelas hanya digit terakhir yang
  dibutuhkan, bukan nomor lengkap.
- **Retry 3x + timeout keras 20 dtk** (pola yang sama dengan harvester).
  Error permanen (404/403/resi tidak ditemukan) tidak di-retry.
  Timeout penting: probe live menunjukkan SiCepat bisa menggantung
  > 60 dtk — tanpa timeout, satu kurir bisa menggantung API.
- **Dedupe request bersamaan** per kurir+resi+phone. Phone masuk kunci
  agar hasil resi yang sudah terverifikasi tidak terbagi ke request
  dengan digit yang salah.
- **Skema terpisah `db/schema-track.sql`** (bukan menumpang
  `schema-tarif.sql`) — Fase 3 punya tabel sendiri, tabel Fase 2 tidak
  diubah.

## Perilaku kurir (probe + tes live 12 Nov 2026, resi dummy `1234567890`)

| Kurir | Hasil | Latensi | Catatan |
|---|---|---|---|
| JNE (+phone 12345) | `verification_failed` → 404 | 3,6 dtk | JNE tidak membedakan resi tidak ada vs digit salah — keduanya kembali `VERIFICATION_FAILED` ("Verifikasi gagal atau data tidak ditemukan"). Pesan API menjelaskan dua kemungkinan itu. |
| J&T (+phone 1234) | `not_found` → 404 | 1,4 dtk | Pesan bersih, sama seperti Fase 0. |
| SiCepat | `not_found` → 404 | 2,8 dtk | Flaky: probe awal menggantung > 60 dtk (aliran reCAPTCHA), tes live beberapa menit kemudian berhasil 2,8 dtk. Timeout + retry tetap wajib. |
| POS | `not_found` → 404 | 1,4 dtk | Pesan bersih. |
| AnterAja | `not_found` → 404 | 1,4 dtk | **Tracking AnterAja TIDAK terblokir 403** — berbeda dengan API ongkirnya yang 403 dari IP sandbox dan VM-1. Endpoint tracking-nya bisa dijangkau. |

## Hasil tes

- `npm test`: **46/46 hijau** (29 lama + 17 baru: normalisasi status/events,
  validasi phone per kurir, cache + TTL + `fresh=1`, not_found tidak
  di-cache, tri-state + verifikasi HP, retry + timeout, endpoint 401/400/
  404/502).
- `npm run test:live`: **6/6 hijau** — 4 tes ongkir Fase 2 tetap lolos
  (harga sama seperti Fase 2) + 2 tes tracking baru (smoke test resi
  dummy 5 kurir + endpoint HTTP live 404/400).

## Yang masih pending (di luar Fase 3)

- **Validasi resi asli.** Semua tes live memakai resi dummy — yang
  terbukti baru wiring + tri-state yang rapi. Validasi ujung-ke-ujung
  (resi sungguhan + digit HP benar → events lengkap, status benar)
  butuh satu nomor resi asli + digit HP dari user. Belum bisa dilakukan
  di sini; jangan klaim endpoint teruji resi asli sebelum itu.
- **SiCepat dari VM-1.** Perilaku reCAPTCHA-nya flaky dari IP sandbox
  (sekali gantung > 60 dtk, sekali berhasil 2,8 dtk). Tes ulang dari
  IP VM-1 setelah deploy.
- **Deploy ke VM-1** (langkah terpisah — belum dikerjakan).
- Fase 4: rilis v1 (deploy + dokumentasi API).
