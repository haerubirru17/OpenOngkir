-- Metrik quote ongkir (Fase 4): berapa quote yang terlayani dari DB
-- vs yang harus panen live. Dihitung per kurir per permintaan /v1/cost.
-- Dua baris: 'from_db' (kurir yang jawab dari baris tarif segar) dan
-- 'live' (kurir yang harus dipanen live). Kurir yang dilewati karena
-- negative cache (baru gagal, tidak dipanen ulang) tidak dihitung di
-- keduanya — tidak ada quote yang terlayani dari jalur mana pun.

CREATE TABLE IF NOT EXISTS quote_stats (
  name TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
