-- API key yang dibuat pengunjung lewat POST /v1/api-keys (konsol publik
-- terbatas). Key ASLI tidak pernah disimpan — hanya hash SHA-256-nya.
-- Kolom ip dipakai untuk batas pembuatan (maksimal 3 key baru per IP
-- per 24 jam); revoked=1 menolak key tanpa menghapus barisnya.

CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,
  label TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_api_keys_ip_created
  ON api_keys (ip, created_at);
