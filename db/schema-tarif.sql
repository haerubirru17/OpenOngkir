-- Skema tabel tarif OpenOngkir (Fase 2).
-- Kode asal/tujuan memakai kode kecamatan Kemendagri (NN.NN.NN), sama
-- seperti tabel wilayah. Waktu disimpan sebagai epoch milidetik (INTEGER).
-- Jalankan SETELAH db/schema-wilayah.sql.

-- Peta kode Kemendagri -> kode lokasi tiap kurir. Tiap kurir punya sistem
-- kode sendiri (JNE: TGR10000, SiCepat: TGR / BDO10115, POS: kode pos,
-- J&T: nama kota/kecamatan, AnterAja: kode Kemendagri itu sendiri).
-- Kolom role ada karena satu kecamatan bisa butuh kode berbeda sebagai
-- asal vs tujuan (mis. J&T: asal = nama kota, tujuan = nama kecamatan;
-- SiCepat: asal = kode kota 3 huruf, tujuan = kode kecamatan).
CREATE TABLE IF NOT EXISTS courier_places (
  kemendagri_code TEXT NOT NULL,
  courier TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('origin', 'destination')),
  courier_code TEXT NOT NULL,
  courier_label TEXT NOT NULL DEFAULT '',
  resolved_at INTEGER NOT NULL,
  PRIMARY KEY (kemendagri_code, courier, role)
);

-- Tarif hasil panen. Satu baris = satu layanan, satu berat (kg, dibulatkan
-- ke atas). fetched_at = kapan harga ini terakhir dicek live ke kurir.
CREATE TABLE IF NOT EXISTS tariffs (
  origin_code TEXT NOT NULL,
  dest_code TEXT NOT NULL,
  courier TEXT NOT NULL,
  service TEXT NOT NULL,
  weight_kg INTEGER NOT NULL,
  price INTEGER NOT NULL,
  eta TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'openresi',
  PRIMARY KEY (origin_code, dest_code, courier, service, weight_kg)
);
CREATE INDEX IF NOT EXISTS idx_tariffs_route ON tariffs(origin_code, dest_code, weight_kg);
CREATE INDEX IF NOT EXISTS idx_tariffs_fetched ON tariffs(fetched_at);

-- Jejak tiap percobaan panen: untuk memantau kegagalan, mengukur rute
-- panas (cron refresh), dan mencatat selisih harga (spot-check).
-- status: 'ok' | 'error' | 'drift' (spot-check menemukan harga berubah).
CREATE TABLE IF NOT EXISTS harvest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin_code TEXT NOT NULL,
  dest_code TEXT NOT NULL,
  courier TEXT NOT NULL,
  weight_kg INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_harvest_log_route ON harvest_log(origin_code, dest_code);
CREATE INDEX IF NOT EXISTS idx_harvest_log_created ON harvest_log(created_at);
