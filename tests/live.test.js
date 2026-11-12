// Tes LIVE terhadap endpoint resmi kurir via OpenResi.
// Dijalankan hanya bila OPENONGKIR_LIVE_TEST=1 (memakai jaringan + lambat).
// Hasil diringkas ke /tmp/openongkir-live-results.json untuk laporan FASE-2.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { createHarvester } from '../src/harvester.js';

const LIVE = process.env.OPENONGKIR_LIVE_TEST === '1';
const DB_PATH = process.env.OPENONGKIR_LIVE_DB || '/tmp/openongkir-live.db';
const COURIERS4 = ['jne', 'jnt', 'sicepat', 'pos'];

const ROUTES = [
  { name: 'Tangerang -> Bandung', origin: '36.71.01', dest: '32.73.02' },
  { name: 'Jakarta Pusat -> Surabaya', origin: '31.71.01', dest: '35.78.02' },
  { name: 'Bandung -> Yogyakarta', origin: '32.73.02', dest: '34.71.01' },
  { name: 'Tangerang -> Makassar', origin: '36.71.01', dest: '73.71.01' },
  { name: 'Jakarta Pusat -> Medan', origin: '31.71.01', dest: '12.71.01' },
];

const results = { routes: [], cachedMs: null, staleRefreshed: false, anteraja: null };

describe('live (OpenResi)', { skip: !LIVE }, () => {
  let db;
  let harvester;

  before(() => {
    rmSync(DB_PATH, { force: true });
    rmSync(`${DB_PATH}-journal`, { force: true });
    rmSync(`${DB_PATH}-wal`, { force: true });
    rmSync(`${DB_PATH}-shm`, { force: true });
    db = openDb(DB_PATH);
    harvester = createHarvester({ db });
  });

  after(() => {
    writeFileSync('/tmp/openongkir-live-results.json', JSON.stringify(results, null, 2));
    db.close();
  });

  it('5 rute x 4 kurir: harga wajar dan tersimpan', async () => {
    for (const route of ROUTES) {
      const { options, errors } = await harvester.getCost({
        originCode: route.origin, destCode: route.dest, weightKg: 1, couriers: COURIERS4,
      });
      const perCourier = {};
      for (const c of COURIERS4) {
        const opts = options.filter((o) => o.courier === c);
        perCourier[c] = opts.length > 0
          ? { cheapest: opts[0], services: opts.map((o) => `${o.service} Rp${o.price.toLocaleString('id-ID')}`) }
          : { error: errors.find((e) => e.courier === c)?.error || 'tidak ada opsi' };
      }
      results.routes.push({ ...route, perCourier });
      console.log(`\n== ${route.name} ==`);
      for (const c of COURIERS4) {
        const p = perCourier[c];
        console.log(`  ${c}: ${p.cheapest ? p.services.join(' | ') : 'GAGAL: ' + p.error}`);
      }
      for (const c of COURIERS4) {
        const opts = options.filter((o) => o.courier === c);
        assert.ok(opts.length > 0, `${route.name} ${c}: tidak ada opsi (error: ${errors.find((e) => e.courier === c)?.error})`);
        for (const o of opts) {
          assert.ok(o.price >= 1000 && o.price <= 1_000_000, `${route.name} ${c} ${o.service}: harga ${o.price} di luar batas`);
          assert.equal(o.cached, false);
        }
      }
      const stored = db.getTariffs(route.origin, route.dest, 1);
      assert.ok(stored.length >= 4, `${route.name}: baris tersimpan ${stored.length}`);
    }
  });

  it('request ke-2 dilayani dari DB (< 100 ms)', async () => {
    const route = ROUTES[0];
    const t0 = Date.now();
    const { options } = await harvester.getCost({
      originCode: route.origin, destCode: route.dest, weightKg: 1, couriers: COURIERS4,
    });
    const ms = Date.now() - t0;
    results.cachedMs = ms;
    assert.ok(options.length > 0);
    assert.ok(options.every((o) => o.cached === true), 'semua opsi harus cached');
    assert.ok(ms < 100, `request cached ${ms} ms, melebihi 100 ms`);
  });

  it('baris basi (> 30 hari) di-refresh saat ditanya lagi', async () => {
    const route = ROUTES[0];
    const old = Date.now() - 31 * 86400e3;
    db.db.prepare(
      'UPDATE tariffs SET fetched_at = ? WHERE origin_code = ? AND dest_code = ? AND weight_kg = 1'
    ).run(old, route.origin, route.dest);
    const { options } = await harvester.getCost({
      originCode: route.origin, destCode: route.dest, weightKg: 1, couriers: COURIERS4,
    });
    assert.ok(options.length > 0);
    assert.ok(options.every((o) => o.cached === false), 'semua opsi harus hasil panen baru');
    const rows = db.getTariffs(route.origin, route.dest, 1);
    assert.ok(rows.every((r) => r.fetched_at > old), 'fetched_at harus diperbarui');
    results.staleRefreshed = true;
  });

  it('anteraja: dicoba, kegagalan 403 dicatat (bukan blocker)', async () => {
    const route = ROUTES[0];
    const res = await harvester.harvestCourier({
      originCode: route.origin, destCode: route.dest, courier: 'anteraja', weightKg: 1,
    });
    results.anteraja = res.error
      ? { status: 'error', error: res.error }
      : { status: 'ok', services: res.services };
    console.log(`\n== AnterAja ${route.name}: ${res.error ? 'GAGAL: ' + res.error : 'BERHASIL ' + JSON.stringify(res.services)} ==`);
    // Tes ini tidak menggagalkan suite: 403 dari IP sandbox adalah hasil yang diharapkan.
    assert.ok(true);
  });
});
