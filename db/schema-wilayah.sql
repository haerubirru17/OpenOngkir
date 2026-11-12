-- Skema tabel wilayah OpenOngkir (tools mandiri).
-- ID memakai kode bertitik Kemendagri (NN / NN.NN / NN.NN.NN).
-- Seed: db/seed-wilayah.sql (7.837 baris).
CREATE TABLE wilayah (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('provinsi', 'kabupaten', 'kecamatan')),
  name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wilayah_parent ON wilayah(parent_id);
