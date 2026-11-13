// Tes metrik quote Fase 4: dari DB vs panen live (per kurir).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createHarvester } from '../src/harvester.js';
import { createServer } from '../src/server.js';

const ORIGIN = '36.71.01'; // TANGERANG, KOTA TANGERANG
const DEST = '32.73.02'; // COBLONG, KOTA BANDUNG
const API_KEY = 'tes-kunci-acak-123';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

function setup(resolvers) {
  const db = openDb(':memory:');
  const harvester = createHarvester({
    db, resolvers, sleepFn: () => Promise.resolve(), politeDelayMs: 0, timeoutMs: 5000,
  });
  return { db, harvester };
}

describe('quote_stats di DB', () => {
  it('mulai 0/0, recordQuoteStats mengakumulasi', () => {
    const db = openDb(':memory:');
    try {
      assert.deepEqual(db.getQuoteStats(), { from_db: 0, live: 0 });
      db.recordQuoteStats(2, 1);
      db.recordQuoteStats(1, 0);
      assert.deepEqual(db.getQuoteStats(), { from_db: 3, live: 1 });
    } finally {
      db.close();
    }
  });
});

describe('getCost menghitung per kurir', () => {
  it('panen pertama = live; tanya kedua = dari DB; fresh=1 = live lagi', async () => {
    const { db, harvester } = setup({
      jne: mockResolver('TGR10000', [{ service: 'REG', cost: 12000, etd: '1-2 hari' }]),
      jnt: mockResolver('TANGERANG', [{ service: 'EZ', cost: 11000, etd: '2-3 hari' }]),
    });
    try {
      const q = { originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne', 'jnt'] };
      await harvester.getCost(q);
      assert.deepEqual(db.getQuoteStats(), { from_db: 0, live: 2 });

      await harvester.getCost(q);
      assert.deepEqual(db.getQuoteStats(), { from_db: 2, live: 2 });

      await harvester.getCost({ ...q, fresh: true });
      assert.deepEqual(db.getQuoteStats(), { from_db: 2, live: 4 });
    } finally {
      db.close();
    }
  });

  it('kurir yang dilewati negative cache tidak dihitung di keduanya', async () => {
    const { db, harvester } = setup({
      jne: mockResolver('TGR10000', [], true),
    });
    try {
      const q = { originCode: ORIGIN, destCode: DEST, weightKg: 1, couriers: ['jne'] };
      await harvester.getCost(q);
      assert.deepEqual(db.getQuoteStats(), { from_db: 0, live: 1 }); // percobaan live gagal tetap live
      await harvester.getCost(q); // dilewati negative cache 1 jam
      assert.deepEqual(db.getQuoteStats(), { from_db: 0, live: 1 });
    } finally {
      db.close();
    }
  });
});

describe('health menampilkan metrik + versi package.json', () => {
  it('quotes_from_db / quotes_live / quotes_db_pct + version 1.0.0', async () => {
    const db = openDb(':memory:');
    const harvester = createHarvester({
      db,
      resolvers: {
        jne: mockResolver('TGR10000', [{ service: 'REG', cost: 12000, etd: '1-2 hari' }]),
        jnt: mockResolver('TANGERANG', [{ service: 'EZ', cost: 11000, etd: '2-3 hari' }]),
      },
      sleepFn: () => Promise.resolve(), politeDelayMs: 0, timeoutMs: 5000,
    });
    const server = createServer({ db, harvester, apiKey: API_KEY });
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

      const before = await (await fetch(`${base}/v1/health`)).json();
      assert.equal(before.version, pkgVersion);
      assert.equal(before.quotes_from_db, 0);
      assert.equal(before.quotes_live, 0);
      assert.equal(before.quotes_db_pct, null); // belum ada quote: tidak ada persen

      const headers = { 'X-API-Key': API_KEY };
      const url = `${base}/v1/cost?origin=${ORIGIN}&destination=${DEST}&weight_g=1000&courier=jne,jnt`;
      await fetch(url, { headers }); // panen live 2 kurir
      await fetch(url, { headers }); // dari DB 2 kurir

      const after = await (await fetch(`${base}/v1/health`)).json();
      assert.equal(after.quotes_from_db, 2);
      assert.equal(after.quotes_live, 2);
      assert.equal(after.quotes_db_pct, 50);
    } finally {
      await new Promise((r) => server.close(r));
      db.close();
    }
  });
});
