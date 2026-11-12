// Tes lapisan DB (in-memory, seed wilayah asli ikut dimuat).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';

describe('db', () => {
  it('seed wilayah terisi 7.837 baris', () => {
    const db = openDb(':memory:');
    assert.equal(db.countWilayah(), 7837);
    db.close();
  });

  it('getWilayahChain mengembalikan kecamatan -> kabupaten -> provinsi', () => {
    const db = openDb(':memory:');
    const chain = db.getWilayahChain('36.71.01');
    assert.equal(chain.kecamatan.name, 'TANGERANG');
    assert.equal(chain.kabupaten.name, 'KOTA TANGERANG');
    assert.equal(chain.provinsi.name, 'BANTEN');
    assert.equal(db.getWilayahChain('36.71'), null); // bukan kecamatan
    assert.equal(db.getWilayahChain('99.99.99'), null);
    db.close();
  });

  it('listWilayah: tanpa parent = provinsi, dengan parent = anaknya', () => {
    const db = openDb(':memory:');
    assert.equal(db.listWilayah('').length, 38);
    const kab = db.listWilayah('36');
    assert.ok(kab.length > 0 && kab.every((r) => r.parent_id === '36'));
    const kec = db.listWilayah('36.71');
    assert.ok(kec.length > 0 && kec.every((r) => r.level === 'kecamatan'));
    db.close();
  });

  it('tariffs: simpan, baca segar vs basi, hapus', () => {
    const db = openDb(':memory:');
    const now = Date.now();
    db.saveTariffs([
      { origin_code: '36.71.01', dest_code: '32.73.02', courier: 'jne', service: 'REG', weight_kg: 1, price: 12000, eta: '1-2 hari' },
      { origin_code: '36.71.01', dest_code: '32.73.02', courier: 'jnt', service: 'EZ', weight_kg: 1, price: 11000, eta: '2-3 hari' },
    ], now);
    assert.equal(db.countTariffs(), 2);
    // Segar: cutoff 30 hari lalu.
    assert.equal(db.getFreshTariffs('36.71.01', '32.73.02', 1, now - 30 * 86400e3).length, 2);
    // Basi: cutoff di masa depan (semua baris dianggap basi).
    assert.equal(db.getFreshTariffs('36.71.01', '32.73.02', 1, now + 1).length, 0);
    // Filter kurir.
    assert.equal(db.getFreshTariffs('36.71.01', '32.73.02', 1, now - 30 * 86400e3, ['jne']).length, 1);
    // Upsert menimpa harga lama.
    db.saveTariffs([
      { origin_code: '36.71.01', dest_code: '32.73.02', courier: 'jne', service: 'REG', weight_kg: 1, price: 13000, eta: '1-2 hari' },
    ], now + 1000);
    assert.equal(db.countTariffs(), 2);
    assert.equal(db.getTariffs('36.71.01', '32.73.02', 1, 'jne')[0].price, 13000);
    // Hapus per kurir.
    db.deleteTariffs('36.71.01', '32.73.02', 'jne', 1);
    assert.equal(db.countTariffs(), 1);
    db.close();
  });

  it('courier_places: simpan + baca per role', () => {
    const db = openDb(':memory:');
    db.saveCourierPlace('36.71.01', 'jnt', 'origin', 'TANGERANG', 'TANGERANG, BANTEN');
    db.saveCourierPlace('36.71.01', 'jnt', 'destination', 'TANGERANG', 'TANGERANG, BANTEN');
    db.saveCourierPlace('36.71.01', 'jne', 'origin', 'TGR10000', 'TANGERANG');
    assert.equal(db.getCourierPlace('36.71.01', 'jnt', 'origin').courier_code, 'TANGERANG');
    assert.equal(db.getCourierPlace('36.71.01', 'jnt', 'destination').courier_code, 'TANGERANG');
    assert.equal(db.getCourierPlace('36.71.01', 'jne', 'destination'), null);
    assert.equal(db.countCourierPlaces(), 3);
    db.close();
  });

  it('harvest_log + rute basi + spot-check', () => {
    const db = openDb(':memory:');
    const now = Date.now();
    const old = now - 31 * 86400e3;
    db.saveTariffs([
      { origin_code: '36.71.01', dest_code: '32.73.02', courier: 'jne', service: 'REG', weight_kg: 1, price: 12000, eta: '' },
    ], old);
    db.saveTariffs([
      { origin_code: '31.71.01', dest_code: '35.78.02', courier: 'jne', service: 'REG', weight_kg: 1, price: 20000, eta: '' },
    ], now);
    db.logHarvest({ origin_code: '36.71.01', dest_code: '32.73.02', courier: 'jne', status: 'ok', latency_ms: 100 });
    db.logHarvest({ origin_code: '36.71.01', dest_code: '32.73.02', courier: 'jne', status: 'ok', latency_ms: 100 });
    const stale = db.getStaleRoutes(now - 30 * 86400e3, 10);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].origin_code, '36.71.01');
    const spot = db.getSpotCheckRoutes(10);
    assert.equal(spot.length, 2);
    assert.equal(spot[0].origin_code, '36.71.01'); // tertua dulu
    assert.equal(db.lastHarvestAt(), now);
    db.close();
  });
});
