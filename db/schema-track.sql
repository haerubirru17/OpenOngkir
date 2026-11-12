-- Skema cache cek resi OpenOngkir (Fase 3).
-- Cek resi bersifat live (status paket berubah seiring waktu), jadi hasil
-- hanya di-cache singkat (30 menit) — bukan database permanen seperti tarif.
-- Hanya hasil "ditemukan" yang di-cache; resi tidak ditemukan / error tidak
-- disimpan agar percobaan berikutnya selalu cek live lagi.
-- Jalankan SETELAH db/schema-tarif.sql.

CREATE TABLE IF NOT EXISTS track_cache (
  courier TEXT NOT NULL,
  awb TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (courier, awb)
);
CREATE INDEX IF NOT EXISTS idx_track_cache_fetched ON track_cache(fetched_at);
