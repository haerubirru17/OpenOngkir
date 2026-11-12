# Fase 0 — Validasi OpenResi Live

**Tanggal tes:** 12 November 2026, ±15:52–16:00 WIB
**Sumber yang diuji:** [amayonaise/OpenResi](https://github.com/amayonaise/OpenResi), commit `53544af` (18 Okt 2026), lisensi MIT
**Cara tes:** server OpenResi dijalankan lokal di VM ini (`npm install`, `node src/server.js`, port 4000, Node v24.22.1), lalu dipanggil via curl.
**Rute ongkir:** Tangerang (Kota Tangerang) → Bandung (Kota Bandung), berat 1000 gram (`weight=1` kg)
**Tes resi:** nomor dummy `1234567890` — hanya uji wiring, BUKAN validasi resi sungguhan.
**Respons mentah:** `docs/fase-0-raw/*.json` (14 file)

## Hasil ongkir

| Kurir | Hasil | Latensi | Layanan + harga (1 kg) |
|---|---|---|---|
| JNE | ✅ Berhasil | 3,9 dtk | REG Rp 12.000 (1–2 hari), YES Rp 24.000, JTR Rp 45.000, SPS Rp 403.000, JTR<130 Rp 450.000, JTR>130 Rp 750.000, JTR>200 Rp 800.000 |
| J&T | ✅ Berhasil | 18,0 dtk | EZ Rp 11.000 (2–3 hari), DOC Rp 12.000, JND Rp 20.000 |
| SiCepat | ✅ Berhasil* | 1,9 dtk | HALU Rp 7.500 (2–4 hari), REG Rp 11.000 (2–3 hari), GOKIL Rp 40.000 (kargo) |
| POS | ✅ Berhasil | 9,3 dtk | Reguler Rp 9.900 (2 hari), Nextday Rp 21.600 (1 hari) |
| AnterAja | ❌ Gagal (blocked) | 38 dtk | — |

\* SiCepat: 2 percobaan pertama gagal dengan error `fetch failed` (8,4 dtk dan 61,1 dtk), percobaan ke-3 berhasil. Flaky — lihat temuan no. 3.

**Validasi silang harga:** layanan REG/Reguler empat kurir yang berhasil berada di rentang Rp 9.900–12.000 untuk rute yang sama. Konsisten satu sama lain dan wajar untuk Tangerang–Bandung 1 kg. Ini sinyal kuat bahwa datanya benar-benar tarif resmi, bukan angka palsu.

**Resolusi lokasi per kurir (dari input nama kota yang sama, "Tangerang" → "Bandung"):**

| Kurir | Asal ter-resolve | Tujuan ter-resolve |
|---|---|---|
| JNE | TGR10000 (TANGERANG) | BDO10000 (BANDUNG) |
| J&T | TANGERANG, BANTEN | CINAMBO, BANDUNG (kecamatan) |
| SiCepat | TGR (Tangerang) | BDO10115 — Ibun, **Kab. Bandung** |
| POS | 15111 — Kel. SUKARASA, Kec. TANGERANG | 40113 — Kel. BABAKAN CIAMIS, Kec. SUMUR BANDUNG |

Perhatikan SiCepat: "Bandung" jatuh ke **Kabupaten** Bandung (Ibun), bukan Kota Bandung. Nama kota mentah tidak deterministik — lihat temuan no. 1.

## Hasil cek resi (dummy `1234567890`)

| Kurir | Hasil | Catatan |
|---|---|---|
| JNE | ✅ Wiring OK | Percobaan 1 gagal `fetch failed` (transien, 9,9 dtk). Retry berhasil (1,3 dtk): status `AWAITING_PHONE_VERIFICATION` — butuh 5 digit terakhir nomor HP penerima untuk melihat rincian. |
| J&T | ✅ Wiring OK | Tanpa phone: `AWAITING_PHONE_VERIFICATION` (1,9 dtk, butuh 4 digit terakhir HP). Dengan `phone=1234`: `NOT_FOUND` bersih (1,7 dtk) — "Nomor resi "1234567890" tidak ditemukan di sistem J&T Express." |

Ini baru uji wiring. Validasi resi sungguhan butuh nomor resi asli + digit HP yang benar, belum dilakukan.

## Kendala & temuan

1. **Resolusi lokasi tidak deterministik.** Nama kota yang sama bisa jatuh ke kota, kabupaten, kecamatan, atau kelurahan yang berbeda-beda di tiap kurir. Harvester Fase 2 TIDAK boleh memakai nama kota mentah — harus memakai kode wilayah eksplisit per kurir (kode JNE `BDO10000`, kode SiCepat `BDOxxxxx`, kode pos POS, kode Kemendagri AnterAja).
2. **Latensi live 2–18 detik.** Terlalu lambat untuk checkout live, tapi tidak masalah untuk panen. Ini justru membenarkan arsitektur database tarif.
3. **Kegagalan transien nyata.** SiCepat gagal 2x lalu berhasil; tracking JNE gagal 1x lalu berhasil. Penyebab pasti tidak tertangkap (pesan error hanya `fetch failed`, tanpa detail). Harvester WAJIB punya retry + backoff, dan tiap baris tarif harus menyimpan `fetched_at` + status.
4. **AnterAja terblokir di IP ini.** Bukti: `GET /api/locations?courier=anteraja&search=Tangerang` mengembalikan `count: 0`; ongkir dengan nama kota gagal (`Lokasi asal "Tangerang" tidak ditemukan di sistem Anteraja`); ongkir dengan kode kecamatan gagal `Gagal memanggil API Anteraja (HTTP status 403)`; curl langsung ke `anteraja.id` mengembalikan HTTP 403 "Access Denied" (Akamai EdgeSuite). Ini blokir level jaringan/IP, bukan bug OpenResi. **Harus dites ulang dari IP lain (VM-1/VPS user)** sebelum divonis.
5. **Tracking JNE & J&T butuh digit HP.** JNE minta 5 digit terakhir HP penerima, J&T 4 digit terakhir HP pengirim/penerima. Implikasi Fase 3: Berbirru perlu alur untuk mengumpulkan/menyimpan digit ini — tanpa itu, cek resi via OpenResi tidak bisa jalan penuh. (BinderByte sekarang tidak meminta ini.)
6. **JNE ongkir = scraping HTML.** Resolver JNE mem-parse tabel tarif di situs jne.co.id dengan cheerio. Berfungsi hari ini, tapi rapuh terhadap perubahan layout situs JNE.
7. **Layanan kargo ikut muncul.** JNE mengembalikan JTR/SPS, SiCepat mengembalikan GOKIL. Filter yang sudah ada di Berbirru (`SERVICE_DIBUANG`) harus dipertahankan di skema panen.
8. **AnterAja menerima kode Kemendagri.** Kodenya (`36.71.01` dst) diterima langsung tanpa pencarian lokasi — kabar baik untuk pemetaan wilayah Fase 1, kalau blokir 403-nya teratasi.

## Vonis per kurir (sebagai sumber panen ongkir)

| Kurir | Vonis |
|---|---|
| JNE | **LAYAK** — cepat (3,9 dtk), lengkap. Catatan: scraping HTML, rapuh. |
| J&T | **LAYAK** — lambat (18 dtk) tapi tidak masalah untuk panen. |
| SiCepat | **LAYAK DENGAN CATATAN** — flaky, retry wajib. Perhatikan resolve tujuan (Kab. Bandung). |
| POS | **LAYAK** — lengkap, resolve sampai kelurahan + kode pos. |
| AnterAja | **PENDING** — blocked 403 Akamai dari IP ini. Tes ulang dari IP lain (VM-1/VPS). |

## Vonis keseluruhan

**OpenResi LAYAK sebagai sumber panen untuk 4 dari 5 kurir Berbirru.** Harga yang kembali konsisten antar kurir dan wajar. Proyek bisa lanjut ke Fase 1 (wilayah mandiri) dan Fase 2 (tabel tarif + panen) untuk JNE, J&T, SiCepat, dan POS.

AnterAja belum bisa divonis — butuh tes ulang dari IP lain. Jika tetap terblokir, pilihannya: (a) AnterAja tetap via BinderByte sementara (satu-satunya sisa ketergantungan), atau (b) AnterAja dikeluarkan dulu dari daftar kurir sampai ada jalan.

**Tindak lanjut sebelum/saat Fase 2:**
- Tes ulang AnterAja dari VM-1 atau VPS (IP berbeda).
- Putuskan skema kode wilayah per kurir (temuan no. 1) — ini penentu desain tabel tarif.
- Putuskan alur digit HP untuk cek resi (temuan no. 5) sebelum Fase 3.
- Validasi resi sungguhan (butuh nomor resi asli + digit HP benar).
