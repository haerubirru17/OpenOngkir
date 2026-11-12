// Tes harvester dengan resolver mock (tanpa jaringan).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createHarvester, TTL_MS } from '../src/harvester.js';

const ORIGIN = '36.71.01'; // TANGERANG, KOTA TANGERANG
const DEST = '32.73.02'; // COBLONG, KOTA BANDUNG

function mockResolver({ code, services, failTimes = 0, failError = 'fetch failed', calls = {} }) {
  let attempts = 0;
  const search = async (q) => {
    calls.search = (calls.search || 0) + 1;
    // Label mengandung nama kota agar findBestMatch lolos cek kota.
    return [{ code, label: `${code} TANGERANG BANDUNG`, city: 'TANGERANG', district: 'TANGERANG', postalCode: code }];
  };
  return {
    searchOrigins: search,
    searchDestinations: search,
    calculateCost: async () => {
      calls.cost = (calls.cost || 0) + 1;
      attempts += 1;
      if (attempts <= failTimes) throw new Error(failError);
      return { success: true, courier: code, services: structuredClone(services) };
    },
  };
}

function setup(resolvers) {
  const db = openDb(':memory:');
  const harvester = createHarvester({
    db,
    resolvers,
    sleepFn: () => Promise.resolve(), // tanpa jeda di tes
    politeDelayMs: 0,
    timeoutMs: 5000,
  });
  return { db, harvester };
}

describe('filter layanan', () => {
  it('buang kargo, harga di luar batas, dan dedupe layanan', () => {
    const { harvester } = setup({});
    const out = harvester._filterServices([
      { service: 'REG', cost: 12000, etd: '1-2 hari' },
      { service: 'REG', cost: 13000, etd: '1-2 hari' }, // duplikat, lebih mahal
      { service: 'JTR', cost: 45000, etd: '3-4 hari' },
      { service: 'JTR<130', cost: 450000, etd: '3-4 hari' },
      { service: 'SPS', cost: 403000, etd: '0-24 jam' },
      { service: 'GOKIL', cost: 40000, etd: '2-4 hari', description: 'KARGO' },
      { service: 'MURAH', cost: 500, etd: '-' }, // di bawah batas
      { service: 'MAHAL', cost: 5_000_000, etd: '-' }, // di atas batas
      { service: 'YES', cost: 24000, etd: '1 hari' },
    ]);
    assert.deepEqual(out.map((s) => s.service), ['REG', 'YES']);
    assert.equal(out[0].cost, 12000); // duplikat: yang termurah dipertahankan
  });

  it('filter outlier: kurir yang harganya menyimpang jauh dibuang', () => {
    const { harvester } = setup({});
    const perCourier = [
      { courier: 'jne', services: [{ service: 'REG', cost: 12000, etd: '' }] },
      { courier: 'jnt', services: [{ service: 'EZ', cost: 11000, etd: '' }] },
      { courier: 'pos', services: [{ service: 'Reguler', cost: 9900, etd: '' }] },
      { courier: 'sicepat', services: [{ service: 'REG', cost: 500000, etd: '' }] }, // salah baca?
    ];
    const out = harvester._filterOutliers(perCourier);
    assert.equal(out.find((r) => r.courier === 'sicepat').services.length, 0);
    assert.equal(out.find((r) => r.courier === 'jne').services.length, 1);
    // Satu kurir saja: tidak ada pembanding, tidak ada yang dibuang.
    const single = harvester._filterOutliers([
      { courier: 'jne', services: [{ service: 'REG', cost: 500000, etd: '' }] },
    ]);
    assert.equal(single[0].services.length, 1);
  });
});

describe('resolvePlace (lazy courier_places)', () => {
  it('pencarian sekali, lalu dari DB', async () => {
    const calls = {};
    const { db, harvester } = setup({
      jne: mockResolver({ code: 'TGR10000', services: [], calls }),
    });
    const first = await harvester.resolvePlace(ORIGIN, 'jne', 'origin');
    assert.equal(first.code, 'TGR10000');
    assert.equal(calls.search, 1);
    const second = await harvester.resolvePlace(ORIGIN, 'jne', 'origin');
    assert.equal(second.code, 'TGR10000');
    assert.equal(calls.search, 1); // tidak cari lagi
    assert.equal(db.countCourierPlaces(), 1);
    db.close();
  });

  it('anteraja memakai kode Kemendagri langsung tanpa pencarian', async () => {
    const calls = {};
    const { db, harvester } = setup({
      anteraja: mockResolver({ code: 'X', services: [], calls }),
    });
    const place = await harvester.resolvePlace(ORIGIN, 'anteraja', 'destination');
    assert.equal(place.code, ORIGIN);
    assert.equal(calls.search, undefined);
    db.close();
  });
});

describe('harvestCourier retry', () => {
  it('gagal transien 2x (ala SiCepat) lalu berhasil', async () => {
    const calls = {};
    const { db, harvester } = setup({
      sicepat: mockResolver({
        code: 'TGR', calls, failTimes: 2,
        services: [{ service: 'REG', cost: 11000, etd: '2-3 hari' }],
      }),
    });
    const res = await harvester.harvestCourier({ originCode: ORIGIN, destCode: DEST, courier: 'sicepat', weightKg: 1 });
    assert.equal(res.error, null);
    assert.equal(res.services[0].cost, 11000);
    assert.equal(calls.cost, 3);
    db.close();
  });

  it('error permanen (lokasi tidak ditemukan) tidak di-retry', async () => {
    const calls = {};
    const { db, harvester } = setup({
      jne: mockResolver({
        code: 'TGR10000', calls, failTimes: 10,
        failError: 'Kota asal "X" tidak ditemukan di sistem JNE.',
        services: [],
      }),
    });
    const res = await harvester.harvestCourier({ originCode: ORIGIN, destCode: DEST, courier: 'jne', weightKg: 1 });
    assert.ok(res.error);
    assert.equal(calls.cost, 1);
    db.close();
  });

  it('timeout dihitung sebagai gagal setelah 3 percobaan', async () => {
    const db = openDb(':memory:');
    let attempts = 0;
    const harvester = createHarvester({
      db,
      resolvers: {
        jne: {
          searchOrigins: async () => [{ code: 'TGR10000', label: 'TANGERANG' }],
          searchDestinations: async () => [{ code: 'BDO10000', label: 'BANDUNG' }],
          calculateCost: async () => {
            attempts += 1;
            await new Promise(() => {}); // tidak pernah selesai
          },
        },
      },
      sleepFn: () => Promise.resolve(),
      politeDelayMs: 0,
      timeoutMs: 50,
      maxAttempts: 3,
    });
    const res = await harvester.harvestCourier({ originCode: ORIGIN, destCode: DEST, courier: 'jne', weightKg: 1 });
    assert.match(res.error, /Timeout/);
    assert.equal(attempts, 3);
    db.close();
  });
});

describe('getCost (DB dulu, panen bila perlu)', () => {
  it('panen pertama dari live, kedua dari DB (cached)', async () => {
    const calls = {};
    const { db, harvester } = setup({
      jne: mockResolver({ code: 'TGR10000', services: [{ service: 'REG', cost: 12000, etd: '1-2 hari' }], calls }),
      jnt: mockResolver({ code: 'TANGERANG', services: [{ service: 'EZ', cost: 11000, etd: '2-3 hari' }], calls }),
    });
    const first = await harvester.getCost({ originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne', 'jnt'] });
    assert.equal(first.options.length, 2);
    assert.equal(first.options[0].price, 11000); // urut termurah
    assert.equal(first.options.every((o) => o.cached === false), true);
    assert.ok(first.options[0].fetched_at);
    assert.equal(db.countTariffs(), 2);

    const costCallsAfterFirst = calls.cost;
    const second = await harvester.getCost({ originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne', 'jnt'] });
    assert.equal(second.options.length, 2);
    assert.equal(second.options.every((o) => o.cached === true), true);
    assert.equal(calls.cost, costCallsAfterFirst); // tidak panen lagi
    db.close();
  });

  it('baris basi (> 30 hari) di-refresh saat ditanya lagi', async () => {
    const calls = {};
    const { db, harvester } = setup({
      jne: mockResolver({ code: 'TGR10000', services: [{ service: 'REG', cost: 12500, etd: '1-2 hari' }], calls }),
    });
    db.saveTariffs([
      { origin_code: ORIGIN, dest_code: DEST, courier: 'jne', service: 'REG', weight_kg: 1, price: 12000, eta: '1-2 hari' },
    ], Date.now() - 31 * 86400e3);
    const res = await harvester.getCost({ originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne'] });
    assert.equal(res.options[0].price, 12500); // harga baru hasil panen
    assert.equal(res.options[0].cached, false);
    assert.equal(calls.cost, 1);
    db.close();
  });

  it('fresh=1 memaksa panen walau DB masih segar', async () => {
    const calls = {};
    const { db, harvester } = setup({
      jne: mockResolver({ code: 'TGR10000', services: [{ service: 'REG', cost: 12000, etd: '1-2 hari' }], calls }),
    });
    await harvester.getCost({ originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne'] });
    assert.equal(calls.cost, 1);
    await harvester.getCost({ originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne'], fresh: true });
    assert.equal(calls.cost, 2);
    db.close();
  });

  it('kurir gagal tidak menggagalkan kurir lain', async () => {
    const { db, harvester } = setup({
      jne: mockResolver({ code: 'TGR10000', services: [{ service: 'REG', cost: 12000, etd: '1-2 hari' }] }),
      sicepat: mockResolver({ code: 'TGR', services: [], failTimes: 10, failError: 'fetch failed' }),
    });
    const res = await harvester.getCost({ originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne', 'sicepat'] });
    assert.equal(res.options.length, 1);
    assert.equal(res.options[0].courier, 'jne');
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].courier, 'sicepat');
    db.close();
  });

  it('negative cache: kurir yang baru gagal tidak dipanen ulang 1 jam', async () => {
    const calls = {};
    const { db, harvester } = setup({
      jne: mockResolver({ code: 'TGR10000', services: [{ service: 'REG', cost: 12000, etd: '1-2 hari' }], calls }),
      anteraja: mockResolver({ code: ORIGIN, services: [], failTimes: 10, failError: 'HTTP status 403', calls }),
    });
    const first = await harvester.getCost({ originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne', 'anteraja'] });
    assert.equal(first.errors.length, 1);
    assert.equal(first.errors[0].courier, 'anteraja');
    const costCallsAfterFirst = calls.cost;
    // Request ke-2: jne dari DB, anteraja dari negative cache (tanpa panen).
    const second = await harvester.getCost({ originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne', 'anteraja'] });
    assert.equal(second.options.length, 1);
    assert.equal(second.errors.length, 1);
    assert.equal(second.errors[0].courier, 'anteraja');
    assert.equal(calls.cost, costCallsAfterFirst);
    // fresh=1 mengabaikan negative cache.
    await harvester.getCost({ originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne', 'anteraja'], fresh: true });
    assert.ok(calls.cost > costCallsAfterFirst);
    db.close();
  });
});

describe('refresh + spot-check', () => {
  it('refreshStaleRoutes memanen ulang rute basi', async () => {
    const calls = {};
    const { db, harvester } = setup({
      jne: mockResolver({ code: 'TGR10000', services: [{ service: 'REG', cost: 12000, etd: '1-2 hari' }], calls }),
    });
    db.saveTariffs([
      { origin_code: ORIGIN, dest_code: DEST, courier: 'jne', service: 'REG', weight_kg: 1, price: 12000, eta: '' },
    ], Date.now() - 31 * 86400e3);
    const out = await harvester.refreshStaleRoutes({ limit: 10 });
    assert.equal(out.routes, 1);
    assert.equal(out.ok, 1);
    const rows = db.getFreshTariffs(ORIGIN, DEST, 1, Date.now() - TTL_MS);
    assert.equal(rows.length, 1); // segar lagi
    db.close();
  });

  it('spotCheck mendeteksi selisih harga', async () => {
    const { db, harvester } = setup({
      jne: mockResolver({ code: 'TGR10000', services: [{ service: 'REG', cost: 13500, etd: '1-2 hari' }] }),
    });
    db.saveTariffs([
      { origin_code: ORIGIN, dest_code: DEST, courier: 'jne', service: 'REG', weight_kg: 1, price: 12000, eta: '' },
    ], Date.now());
    const out = await harvester.spotCheck({ limit: 5 });
    assert.equal(out.drifted.length, 1);
    assert.equal(out.drifted[0].oldPrice, 12000);
    assert.equal(out.drifted[0].newPrice, 13500);
    assert.equal(db.getTariffs(ORIGIN, DEST, 1, 'jne')[0].price, 13500); // diperbarui
    db.close();
  });
});
