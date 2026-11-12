// Tes LIVE terhadap endpoint resmi kurir via OpenResi.
// Dijalankan hanya bila OPENONGKIR_LIVE_TEST=1 (memakai jaringan + lambat).
// Hasil diringkas ke /tmp/openongkir-live-results.json untuk laporan FASE-2.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { createHarvester } from '../src/harvester.js';
import { createTracker } from '../src/tracker.js';
import { createServer } from '../src/server.js';

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

// Tes LIVE cek resi dengan resi dummy 1234567890 — hanya uji wiring
// (tri-state rapi), BUKAN validasi resi sungguhan. Resi asli + digit HP
// yang benar masih menunggu user (lihat docs/FASE-3.md).
const DUMMY_AWB = '1234567890';
const TRACK_DB_PATH = process.env.OPENONGKIR_LIVE_TRACK_DB || '/tmp/openongkir-live-track.db';
const trackResults = { dummy: {}, http: {} };

describe('live tracking (OpenResi)', { skip: !LIVE }, () => {
  let db;
  let tracker;

  before(() => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(TRACK_DB_PATH + suffix, { force: true });
    db = openDb(TRACK_DB_PATH);
    // Timeout + percobaan dikurangi untuk suite live: SiCepat bisa
    // menggantung > 60 dtk (aliran reCAPTCHA) dari IP sandbox.
    tracker = createTracker({ db, timeoutMs: 15000, maxAttempts: 2 });
  });

  after(() => {
    writeFileSync('/tmp/openongkir-live-track-results.json', JSON.stringify(trackResults, null, 2));
    db.close();
  });

  it('resi dummy: tri-state rapi per kurir (tanpa crash)', async () => {
    const cases = [
      // JNE tidak membedakan resi tidak ada vs digit salah (probe 12 Nov).
      { courier: 'jne', phone: '12345', expect: 'verification_failed' },
      { courier: 'jnt', phone: '1234', expect: 'not_found' },
      { courier: 'pos', phone: '', expect: 'not_found' },
      { courier: 'anteraja', phone: '', expect: 'not_found' },
      // SiCepat: aliran reCAPTCHA menggantung dari IP sandbox → error
      // (timeout) adalah hasil yang diharapkan; not_found juga diterima
      // bila jaringannya sedang bersahabat.
      { courier: 'sicepat', phone: '', expect: ['error', 'not_found'] },
    ];
    for (const c of cases) {
      const t0 = Date.now();
      const r = await tracker.track({ courier: c.courier, awb: DUMMY_AWB, phone: c.phone });
      const ms = Date.now() - t0;
      trackResults.dummy[c.courier] = { kind: r.kind, message: r.message || '', ms };
      console.log(`\n== track dummy ${c.courier} (${ms} ms): ${r.kind} — ${(r.message || '').slice(0, 100)} ==`);
      const expected = Array.isArray(c.expect) ? c.expect : [c.expect];
      assert.ok(
        expected.includes(r.kind),
        `${c.courier}: kind ${r.kind}, diharapkan ${expected.join(' atau ')}`
      );
    }
  });

  it('endpoint /v1/track live: 404 rapi + 400 validasi', async () => {
    const harvester = createHarvester({ db, resolvers: {}, sleepFn: () => Promise.resolve(), politeDelayMs: 0 });
    const server = createServer({ db, harvester, tracker, apiKey: 'live-test-key' });
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'X-API-Key': 'live-test-key' };
    try {
      const res404 = await fetch(`${base}/v1/track?courier=jnt&awb=${DUMMY_AWB}&phone=1234`, { headers });
      assert.equal(res404.status, 404);
      const body404 = await res404.json();
      assert.equal(body404.success, false);
      assert.equal(body404.status, 'NOT_FOUND');
      trackResults.http.notFound = { status: res404.status, bodyStatus: body404.status };

      const res400 = await fetch(`${base}/v1/track?courier=jne&awb=${DUMMY_AWB}`, { headers });
      assert.equal(res400.status, 400);
      const body400 = await res400.json();
      assert.match(body400.error, /5 digit/);
      trackResults.http.missingPhone = { status: res400.status };
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
