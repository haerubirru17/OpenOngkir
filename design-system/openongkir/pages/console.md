# Page Override — `/console` sebagai Konsol Profesional

Overrides `design-system/openongkir/pages/test.md` dan MASTER.md untuk
halaman `/console` saja. Mode: **Operate** (alat) + **Read** (bagian
Dokumentasi). Pengunjung memakai konsol untuk bekerja: cek ongkir,
lacak resi, kelola API key, membaca referensi API — bukan membaca
landing page.

## Keputusan dari ui-ux-pro-max `--design-system`

Query: "developer API console dashboard", dial variance 4 / motion 3 /
density 7 (2026-11-13).

- **Style: Minimalism & Swiss Style** — mengonfirmasi MASTER.md. Tidak
  ada perubahan arah visual.
- **Pattern: FAQ/Documentation Landing** — dipakai sebagian: bagian
  Dokumentasi memakai daftar isi + anchor per endpoint. Hero dengan
  search bar TIDAK dipakai (konsol punya navigasi, bukan landing).
- **Warna: tema gelap kode ditolak untuk shell** (identitas kertas
  terang + hijau tua MASTER.md tetap). Yang diadopsi hanya catatan
  "Code dark": blok kode (`pre`) memakai latar tinta `#1B1B18` dan
  teks terang — kode dibaca di permukaan gelap, UI tetap terang.
- **Tipografi: JetBrains Mono / IBM Plex Sans** — Inter dipertahankan
  (keputusan MASTER.md); JetBrains Mono sudah menjadi font data.
- **Daftar AVOID dihormati:** endpoint tidak dikubur (TOC + anchor),
  versi tampil live di pil topbar, state rate limit didokumentasikan
  (batas 60/menit + 429).
- **Density 7:** jarak konsol lebih padat dari halaman konsol lama
  (padding konten 24px, gap antar-bagian 24px, sidebar 264px).
- **Navigasi (pencarian `--domain ux`):** nav sticky tidak boleh
  menutupi konten (topbar sticky berada dalam alur flex); navigasi
  keyboard lengkap (fokus terkelola di menu mobile, Esc menutup);
  tombol back browser tetap bekerja (routing hash, tanpa replace);
  hierarki heading berurutan (h1 judul bagian → h2 kepala seksi →
  h3 endpoint → h4 sub-bagian).

## Layout

- **Desktop (≥1024px):** sidebar kiri tetap terlihat (264px,
  wordmark + 5 tautan navigasi + catatan kaki), konten di kanan
  (max-width 960px). Topbar sticky: judul bagian aktif + pil status
  Live dari `/v1/health`.
- **Mobile (<1024px):** sidebar tersembunyi di balik tombol
  HAMBURGER di topbar (ikon 3 garis, target sentuh 44×44px).
  Membuka panel slide-over (transform 250ms ease-out) + overlay
  gelap. Tutup via tombol X, klik overlay, atau Escape. Fokus
  pindah ke tautan nav pertama saat dibuka, kembali ke tombol
  hamburger saat ditutup; Tab berputar di dalam panel selagi terbuka.
- **Routing:** hash (`#/overview`, `#/cek-ongkir`, `#/lacak-resi`,
  `#/api-keys`, `#/dokumentasi`, `#/dokumentasi/<endpoint>` untuk
  anchor dokumen). Satu bagian terlihat dalam satu waktu; pindah
  bagian memakai satu momen gerak (fade-in 200ms).

## Bagian navigasi

1. **Overview** — pengantar satu kalimat + status API live
   (daftar definisi dari `/v1/health`: versi, uptime, tarif, wilayah,
   metrik quote DB/live, pembaruan terakhir) + jalan pintas berupa
   daftar tautan ke alat (bukan grid kartu). Status API key
   (tersimpan/belum ada) tampil sebagai satu baris + tautan.
2. **Cek Ongkir** — form lengkap seperti sebelumnya (wilayah
   berjenjang, berat, chip kurir, fresh=1, hasil urut termurah +
   tag Termurah, JSON mentah collapsible).
3. **Lacak Resi** — form + timeline seperti sebelumnya.
4. **API Keys** — tombol "Buat API key gratis" (key tampil sekali +
   salin + auto-simpan localStorage), paste key manual, kartu
   "Kunci tersimpan" (kunci dari localStorage: tersembunyi default,
   ikon mata untuk melihat, tombol Salin untuk dipakai di produk
   lain) + Ganti/Lupakan, baris "Base URL" (origin halaman ini +
   `/v1`, readonly + tombol Salin) agar key + base URL bisa dipakai di
   produk user, penjelasan batas 3 key/24 jam.
   TIDAK ada daftar key — API tidak menyediakannya.
5. **Dokumentasi** — referensi API lengkap yang dirender di dalam
   konsol, isinya HANYA dari `docs/API.md`: pengantar (base URL,
   format), autentikasi, rate limit, kelima endpoint (metode +
   path, tabel parameter, contoh curl, contoh respons JSON, kode
   error), tabel kode error, catatan penting (estimasi, fetched_at,
   fresh=1, digit HP JNE 5 / J&T 4, AnterAja 403, JNE
   VERIFICATION_FAILED, cache resi 30 menit). Contoh memakai data
   fiktif (repo publik). Setiap blok kode punya tombol Salin.

## Komponen

- Tautan nav: baris 44px, ikon SVG 18px + label; aktif = latar
  hijau muda + teks hijau tua. Hover: latar abu hangat.
- Pil status: titik hijau + "Live · v1.1.0" (merah bila tidak
  terjangkau), sama seperti sebelumnya.
- Blok kode: permukaan gelap, kepala blok berisi label + tombol
  Salin (32px). Salin memakai `navigator.clipboard` dengan
  fallback `execCommand`.
- Tabel parameter: kolom Nama / Wajib / Keterangan; nama parameter
  mono; label "wajib" hijau tebal, "opsional" muted. Di layar
  sempit tabel digulir horizontal di dalam wadahnya (halaman
  sendiri tidak bergeser).
- Tombol, input, chip kurir, hasil harga, timeline, kotak error:
  sama seperti `pages/test.md` (tidak berubah).

## Larangan impeccable yang dijaga

Tanpa teks gradien, tanpa glassmorphism, tanpa emoji/glif sebagai
ikon (SVG Lucide-style satu stroke), tanpa eyebrow di atas heading,
tanpa grid kartu identik (Overview memakai daftar definisi +
daftar tautan, bukan kartu metrik), tanpa hero-metric, tanpa
garis sisi >1px pada callout, tanpa bayangan offset keras.
Satu momen gerak saja; `prefers-reduced-motion` menonaktifkannya.
