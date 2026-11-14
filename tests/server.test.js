// Tes API server (port ephemeral, resolver mock, DB in-memory).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createHarvester } from '../src/harvester.js';
import { createServer } from '../src/server.js';

const API_KEY = 'tes-kunci-acak-123';
const ORIGIN = '36.71.01';
const DEST = '32.73.02';

function mockResolver(code, services, fail = false) {
  const search = async () => [{ code, label: `${code} TANGERANG BANDUNG`, city: 'TANGERANG', district: 'TANGERANG', postalCode: code }];
  return {
    searchOrigins: search,
    searchDestinations: search,
    calculateCost: async () => {
      if (fail) return { success: false, error: 'fetch failed' };
      return { success: true, courier: code, services: structuredClone(services) };
    },
  };
}

async function startServer({ resolvers, rateLimitPerMin } = {}) {
  const db = openDb(':memory:');
  const harvester = createHarvester({
    db, resolvers, sleepFn: () => Promise.resolve(), politeDelayMs: 0, timeoutMs: 5000,
  });
  const server = createServer({ db, harvester, apiKey: API_KEY, rateLimitPerMin });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
}

const headers = { 'X-API-Key': API_KEY };

describe('server', () => {
  let ctx;
  before(async () => {
    ctx = await startServer({
      resolvers: {
        jne: mockResolver('TGR10000', [{ service: 'REG', cost: 12000, etd: '1-2 hari' }]),
        jnt: mockResolver('TANGERANG', [{ service: 'EZ', cost: 11000, etd: '2-3 hari' }]),
      },
    });
  });
  after(() => new Promise((r) => { ctx.server.close(r); ctx.db.close(); }));

  it('/v1/health tanpa auth', async () => {
    const res = await fetch(`${ctx.base}/v1/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.status, 'ok');
    assert.equal(body.wilayah, 7837);
    assert.ok('last_update' in body);
    assert.equal('last_harvest' in body, false);
  });

  it('/v1/health: last_update terisi setelah ada tarif', async () => {
    // Rute berbeda dari tes cache di bawah, agar tidak mengisi DB-nya duluan.
    const url = `${ctx.base}/v1/cost?origin=36.71.02&destination=32.73.01&weight_g=1000&courier=jne,jnt`;
    const first = await (await fetch(url, { headers })).json();
    assert.equal(first.success, true);
    const res = await fetch(`${ctx.base}/v1/health`);
    const body = await res.json();
    assert.equal(typeof body.last_update, 'string');
    assert.ok(!Number.isNaN(Date.parse(body.last_update)));
  });

  it('/test: halaman konsol tanpa auth', async () => {
    const res = await fetch(`${ctx.base}/test`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.match(body, /OpenOngkir — Cek Ongkir &amp; Lacak Resi/);
    assert.match(body, /id="cost-form"/);
    assert.match(body, /id="track-form"/);
    assert.match(body, /Buat API key/);
    assert.match(body, /id="key-saved-value"/);
    assert.match(body, /id="key-toggle"/);
    assert.match(body, /id="key-copy-saved"/);
    assert.match(body, /id="base-url-value"/);
    assert.match(body, /id="base-url-copy"/);
    assert.doesNotMatch(body, /panen/i);
    assert.doesNotMatch(body, /last_harvest/);
    assert.match(body, /last_update/);
  });

  it('tanpa API key = 401', async () => {
    const res = await fetch(`${ctx.base}/v1/wilayah`);
    assert.equal(res.status, 401);
    const res2 = await fetch(`${ctx.base}/v1/wilayah`, { headers: { 'X-API-Key': 'salah' } });
    assert.equal(res2.status, 401);
  });

  it('/v1/wilayah: provinsi lalu anaknya', async () => {
    const res = await fetch(`${ctx.base}/v1/wilayah`, { headers });
    const body = await res.json();
    assert.equal(body.data.length, 38);
    const res2 = await fetch(`${ctx.base}/v1/wilayah?parent=36`, { headers });
    const body2 = await res2.json();
    assert.ok(body2.data.length > 0);
    assert.ok(body2.data.every((r) => r.parent_id === '36'));
    const res3 = await fetch(`${ctx.base}/v1/wilayah?parent=99.99`, { headers });
    assert.equal(res3.status, 400);
  });

  it('/v1/cost: validasi input', async () => {
    const cases = [
      '/v1/cost', // tanpa param
      `/v1/cost?origin=${ORIGIN}`, // tanpa tujuan
      `/v1/cost?origin=36.71&destination=${DEST}`, // asal bukan kecamatan
      `/v1/cost?origin=${ORIGIN}&destination=99.99.99`, // tujuan tidak ada
      `/v1/cost?origin=${ORIGIN}&destination=${DEST}&weight_g=50`, // terlalu ringan
      `/v1/cost?origin=${ORIGIN}&destination=${DEST}&weight_g=999999`, // terlalu berat
      `/v1/cost?origin=${ORIGIN}&destination=${DEST}&courier=gojek`, // kurir tidak dikenal
    ];
    for (const path of cases) {
      const res = await fetch(`${ctx.base}${path}`, { headers });
      assert.equal(res.status, 400, path);
    }
  });

  it('/v1/cost: panen lalu cached; fresh=1 panen ulang', async () => {
    const url = `${ctx.base}/v1/cost?origin=${ORIGIN}&destination=${DEST}&weight_g=1000&courier=jne,jnt`;
    const first = await (await fetch(url, { headers })).json();
    assert.equal(first.success, true);
    assert.equal(first.estimate, true);
    assert.match(first.disclaimer, /Estimasi/);
    assert.equal(first.weight_kg, 1);
    assert.equal(first.options.length, 2);
    assert.equal(first.options[0].price, 11000);
    assert.equal(first.options.every((o) => o.cached === false), true);
    assert.ok(first.options[0].fetched_at);

    const second = await (await fetch(url, { headers })).json();
    assert.equal(second.options.every((o) => o.cached === true), true);

    const fresh = await (await fetch(`${url}&fresh=1`, { headers })).json();
    assert.equal(fresh.options.every((o) => o.cached === false), true);
  });

  it('/v1/cost: weight_g dibulatkan ke atas per kg', async () => {
    const res = await fetch(`${ctx.base}/v1/cost?origin=${ORIGIN}&destination=${DEST}&weight_g=1500&courier=jne`, { headers });
    const body = await res.json();
    assert.equal(body.weight_kg, 2);
  });

  it('rute tidak dikenal = 404', async () => {
    const res = await fetch(`${ctx.base}/v1/apa`, { headers });
    assert.equal(res.status, 404);
  });
});

describe('server: rate limit + gagal total', () => {
  it('melewati batas = 429', async () => {
    const ctx = await startServer({ rateLimitPerMin: 3, resolvers: {} });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${ctx.base}/v1/health`);
        assert.equal(res.status, 200);
      }
      const res = await fetch(`${ctx.base}/v1/health`);
      assert.equal(res.status, 429);
    } finally {
      await new Promise((r) => ctx.server.close(r));
      ctx.db.close();
    }
  });

  it('semua kurir gagal + DB kosong = 502', async () => {
    const ctx = await startServer({
      resolvers: { jne: mockResolver('TGR10000', [], true) },
    });
    try {
      const res = await fetch(`${ctx.base}/v1/cost?origin=${ORIGIN}&destination=${DEST}&courier=jne`, { headers });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, 'Tarif tidak dapat diambil dari kurir untuk rute ini.');
      assert.equal(body.errors.length, 1);
    } finally {
      await new Promise((r) => ctx.server.close(r));
      ctx.db.close();
    }
  });
});
