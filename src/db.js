// Akses SQLite via node:sqlite bawaan Node (tanpa dependensi native).
// Butuh Node >= 23.4 (tanpa flag) — package.json menetapkan >= 24.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_DIR = join(ROOT, 'db');

// Cache cek resi hanya 30 menit — status paket berubah seiring waktu.
export const TRACK_CACHE_TTL_MS = 30 * 60 * 1000;

function readSql(name) {
  return readFileSync(join(DB_DIR, name), 'utf8');
}

/**
 * Buka (atau buat) database OpenOngkir dan pastikan skema + seed wilayah ada.
 * @param {string} dbPath - path file SQLite, atau ':memory:' untuk tes
 * @returns {OpenOngkirDb}
 */
export function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readSql('schema-wilayah.sql'));
  db.exec(readSql('schema-tarif.sql'));
  db.exec(readSql('schema-track.sql'));

  // Seed wilayah sekali, bila tabel masih kosong.
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM wilayah').get();
  if (count === 0) {
    db.exec(readSql('seed-wilayah.sql'));
  }
  return new OpenOngkirDb(db);
}

export class OpenOngkirDb {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  // ---- Wilayah ----

  getWilayah(id) {
    return this.db.prepare('SELECT * FROM wilayah WHERE id = ?').get(id) || null;
  }

  /** Rantai kecamatan -> kabupaten -> provinsi. */
  getWilayahChain(kecamatanId) {
    const kec = this.getWilayah(kecamatanId);
    if (!kec || kec.level !== 'kecamatan') return null;
    const kab = kec.parent_id ? this.getWilayah(kec.parent_id) : null;
    const prov = kab?.parent_id ? this.getWilayah(kab.parent_id) : null;
    return { kecamatan: kec, kabupaten: kab, provinsi: prov };
  }

  listWilayah(parentId) {
    if (parentId === null || parentId === undefined || parentId === '') {
      return this.db
        .prepare("SELECT * FROM wilayah WHERE parent_id IS NULL ORDER BY id")
        .all();
    }
    return this.db
      .prepare('SELECT * FROM wilayah WHERE parent_id = ? ORDER BY id')
      .all(parentId);
  }

  countWilayah() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM wilayah').get().c;
  }

  // ---- courier_places ----

  getCourierPlace(kemendagriCode, courier, role) {
    return (
      this.db
        .prepare(
          'SELECT * FROM courier_places WHERE kemendagri_code = ? AND courier = ? AND role = ?'
        )
        .get(kemendagriCode, courier, role) || null
    );
  }

  saveCourierPlace(kemendagriCode, courier, role, courierCode, courierLabel) {
    this.db
      .prepare(
        `INSERT INTO courier_places
           (kemendagri_code, courier, role, courier_code, courier_label, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kemendagri_code, courier, role) DO UPDATE SET
           courier_code = excluded.courier_code,
           courier_label = excluded.courier_label,
           resolved_at = excluded.resolved_at`
      )
      .run(kemendagriCode, courier, role, courierCode, courierLabel, Date.now());
  }

  countCourierPlaces() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM courier_places').get().c;
  }

  // ---- tariffs ----

  /** Baris tarif segar (fetched_at >= cutoffMs) untuk satu rute + berat. */
  getFreshTariffs(originCode, destCode, weightKg, cutoffMs, couriers = null) {
    let sql =
      'SELECT * FROM tariffs WHERE origin_code = ? AND dest_code = ? AND weight_kg = ? AND fetched_at >= ?';
    const params = [originCode, destCode, weightKg, cutoffMs];
    if (couriers && couriers.length > 0) {
      sql += ` AND courier IN (${couriers.map(() => '?').join(',')})`;
      params.push(...couriers);
    }
    sql += ' ORDER BY price ASC';
    return this.db.prepare(sql).all(...params);
  }

  /** Semua baris tarif satu rute + berat (segar maupun basi), per kurir. */
  getTariffs(originCode, destCode, weightKg, courier = null) {
    let sql =
      'SELECT * FROM tariffs WHERE origin_code = ? AND dest_code = ? AND weight_kg = ?';
    const params = [originCode, destCode, weightKg];
    if (courier) {
      sql += ' AND courier = ?';
      params.push(courier);
    }
    sql += ' ORDER BY price ASC';
    return this.db.prepare(sql).all(...params);
  }

  saveTariffs(rows, fetchedAt = Date.now()) {
    const stmt = this.db.prepare(
      `INSERT INTO tariffs
         (origin_code, dest_code, courier, service, weight_kg, price, eta, fetched_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(origin_code, dest_code, courier, service, weight_kg) DO UPDATE SET
         price = excluded.price,
         eta = excluded.eta,
         fetched_at = excluded.fetched_at,
         source = excluded.source`
    );
    const insertMany = (list) => {
      this.db.exec('BEGIN');
      try {
        for (const r of list) {
          stmt.run(
            r.origin_code, r.dest_code, r.courier, r.service, r.weight_kg,
            r.price, r.eta || '', fetchedAt, r.source || 'openresi'
          );
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
    insertMany(rows);
  }

  /** Hapus baris tarif satu rute + kurir + berat (sebelum simpan hasil panen baru). */
  deleteTariffs(originCode, destCode, courier, weightKg) {
    this.db
      .prepare(
        'DELETE FROM tariffs WHERE origin_code = ? AND dest_code = ? AND courier = ? AND weight_kg = ?'
      )
      .run(originCode, destCode, courier, weightKg);
  }

  countTariffs() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM tariffs').get().c;
  }

  lastHarvestAt() {
    const row = this.db
      .prepare('SELECT MAX(fetched_at) AS m FROM tariffs')
      .get();
    return row?.m || null;
  }

  /** Rute distinct yang punya baris basi, urut rute paling sering dipanen dulu. */
  getStaleRoutes(cutoffMs, limit = 20) {
    return this.db
      .prepare(
        `SELECT DISTINCT t.origin_code, t.dest_code, t.weight_kg,
           (SELECT COUNT(*) FROM harvest_log h
             WHERE h.origin_code = t.origin_code AND h.dest_code = t.dest_code) AS demand
         FROM tariffs t WHERE t.fetched_at < ?
         ORDER BY demand DESC, t.fetched_at ASC LIMIT ?`
      )
      .all(cutoffMs, limit);
  }

  /** Rute distinct untuk spot-check: yang tertua diceknya dulu. */
  getSpotCheckRoutes(limit = 10) {
    return this.db
      .prepare(
        `SELECT origin_code, dest_code, weight_kg, MIN(fetched_at) AS oldest
         FROM tariffs GROUP BY origin_code, dest_code, weight_kg
         ORDER BY oldest ASC LIMIT ?`
      )
      .all(limit);
  }

  // ---- track_cache ----

  /** Baris cache cek resi (apa pun umurnya — pemanggil yang menilai TTL). */
  getTrackCache(courier, awb) {
    return (
      this.db
        .prepare('SELECT * FROM track_cache WHERE courier = ? AND awb = ?')
        .get(courier, awb) || null
    );
  }

  /** Simpan hasil lacak (payload = JSON hasil normalisasi, tanpa fetched_at). */
  saveTrackCache(courier, awb, payload, fetchedAt = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO track_cache (courier, awb, payload, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(courier, awb) DO UPDATE SET
           payload = excluded.payload,
           fetched_at = excluded.fetched_at`
      )
      .run(courier, awb, payload, fetchedAt);
    // Bersihkan baris basi sekalian (murah, tabel ini kecil).
    this.db
      .prepare('DELETE FROM track_cache WHERE fetched_at < ?')
      .run(fetchedAt - TRACK_CACHE_TTL_MS);
  }

  countTrackCache() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM track_cache').get().c;
  }

  // ---- harvest_log ----

  /** Baris log terbaru untuk satu rute + kurir + berat (untuk negative cache). */
  getLatestHarvestLog(originCode, destCode, courier, weightKg) {
    return (
      this.db
        .prepare(
          `SELECT * FROM harvest_log
           WHERE origin_code = ? AND dest_code = ? AND courier = ? AND weight_kg = ?
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(originCode, destCode, courier, weightKg) || null
    );
  }

  logHarvest({ origin_code, dest_code, courier, weight_kg = 1, status, latency_ms = 0, error = '' }) {
    this.db
      .prepare(
        `INSERT INTO harvest_log
           (origin_code, dest_code, courier, weight_kg, status, latency_ms, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(origin_code, dest_code, courier, weight_kg, status, latency_ms, error, Date.now());
  }
}
