// Tes tracker cek resi (mock resolver, DB in-memory) + endpoint /v1/track.
// Tidak memakai nomor HP asli: digit tes adalah urutan 1-5 / 1-4.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, TRACK_CACHE_TTL_MS } from '../src/db.js';
import { createHarvester } from '../src/harvester.js';
import { createTracker, normalizeStatus, normalizeEvents } from '../src/tracker.js';
import { createServer } from '../src/server.js';

const API_KEY = 'tes-kunci-acak-123';
const AWB = 'DUMMY1234567890';

// Hasil resolver ala J&T: history terbaru dulu.
function jntFound() {
  return {
    success: true,
    courier: 'J&T Express',
    waybillNumber: AWB,
    verified: true,
    status: 'ON_DELIVERY',
    summary: { service: 'EZ', status: 'SEDANG DIANTAR', lastLocation: 'BANDUNG' },
    history: [
      { dateTime: '2026-11-12 10:00:00', location: 'BANDUNG', status: 'SEDANG DIANTAR', description: 'Paket sedang diantar kurir' },
      { dateTime: '2026-11-11 08:30:00', location: 'TANGERANG', status: 'DITERIMA', description: 'Paket diterima di drop point' },
      { dateTime: '2026-11-10 20:00:00', location: 'JAKARTA', status: 'MANIFEST', description: 'Paket dimanifest' },
    ],
  };
}

// Hasil resolver ala JNE: history { date, description } tanpa status.
function jneFound() {
  return {
    success: true,
    courier: 'JNE Express',
    waybillNumber: AWB,
    verified: true,
    status: 'DELIVERED',
    detail: { service: 'REG', shipper: 'TOKO A', receiver: 'BUDI' },
    history: [
      { date: '2026-11-12 09:00', description: 'DELIVERED TO BUDI', location: 'BANDUNG' },
      { date: '2026-11-11 07:00', description: 'ON PROCESS', location: 'TANGERANG' },
    ],
  };
}

function mockTrackResolver(resultOrFn) {
  const calls = [];
  return {
    calls,
    track: async (awb, opts) => {
      calls.push([awb, { ...opts }]);
      const r = typeof resultOrFn === 'function' ? resultOrFn(awb, opts) : resultOrFn;
      return structuredClone(r);
    },
  };
}

function makeTracker(resolvers, opts = {}) {
  const db = openDb(':memory:');
  const tracker = createTracker({
    db, resolvers, sleepFn: () => Promise.resolve(), timeoutMs: 5000, ...opts,
  });
  return { db, tracker };
}

describe('tracker: normalisasi', () => {
  it('normalizeStatus memetakan teks mentah', () => {
    assert.equal(normalizeStatus('DELIVERED'), 'DELIVERED');
    assert.equal(normalizeStatus('ON_PROCESS'), 'ON_PROCESS');
    assert.equal(normalizeStatus('Paket telah diterima'), 'DELIVERED');
    assert.equal(normalizeStatus('SEDANG DIANTAR'), 'ON_DELIVERY');
    assert.equal(normalizeStatus('RETUR KE PENGIRIM'), 'RETURN_TO_SENDER');
    assert.equal(normalizeStatus('dalam perjalanan'), 'IN_TRANSIT');
    assert.equal(normalizeStatus('apa pun'), 'ON_PROCESS');
    assert.equal(normalizeStatus(''), 'ON_PROCESS');
  });

  it('normalizeEvents urut kronologis, bentuk seragam', () => {
    const events = normalizeEvents(jntFound().history);
    assert.equal(events.length, 3);
    assert.equal(events[0].time, '2026-11-10 20:00:00'); // terlama dulu
    assert.equal(events[2].time, '2026-11-12 10:00:00');
    assert.equal(events[0].status, 'MANIFEST');
    assert.equal(events[0].location, 'JAKARTA');

    const jneEvents = normalizeEvents(jneFound().history);
    assert.equal(jneEvents[0].time, '2026-11-11 07:00');
    assert.equal(jneEvents[0].status, ''); // JNE tidak memberi status per event
    assert.equal(jneEvents[1].description, 'DELIVERED TO BUDI');

    // Waktu tak terparse diletakkan di akhir, urutan asli dipertahankan.
    const mixed = normalizeEvents([
      { dateTime: 'bukan tanggal', description: 'X' },
      { dateTime: '2026-11-12 10:00:00', description: 'Y' },
    ]);
    assert.equal(mixed[0].description, 'Y');
    assert.equal(mixed[1].description, 'X');
  });
});

describe('tracker: validasi phone', () => {
  it('jne butuh 5 digit, jnt 4 digit', async () => {
    const { db, tracker } = makeTracker({ jne: mockTrackResolver(jneFound()), jnt: mockTrackResolver(jntFound()) });
    try {
      let r = await tracker.track({ courier: 'jne', awb: AWB });
      assert.equal(r.kind, 'invalid');
      assert.match(r.message, /5 digit/);
      r = await tracker.track({ courier: 'jne', awb: AWB, phone: '1234' });
      assert.equal(r.kind, 'invalid');
      r = await tracker.track({ courier: 'jne', awb: AWB, phone: '12345' });
      assert.equal(r.kind, 'found');

      r = await tracker.track({ courier: 'jnt', awb: AWB, phone: '123' });
      assert.equal(r.kind, 'invalid');
      assert.match(r.message, /4 digit/);
      r = await tracker.track({ courier: 'jnt', awb: AWB, phone: '1234' });
      assert.equal(r.kind, 'found');
    } finally {
      db.close();
    }
  });

  it('nomor lebih panjang dipotong ke N digit terakhir', async () => {
    const jnt = mockTrackResolver(jntFound());
    const { db, tracker } = makeTracker({ jnt });
    try {
      const r = await tracker.track({ courier: 'jnt', awb: AWB, phone: '081234567890' });
      assert.equal(r.kind, 'found');
      assert.equal(jnt.calls[0][1].phone, '7890');
    } finally {
      db.close();
    }
  });

  it('kurir tidak dikenal / awb kosong = invalid', async () => {
    const { db, tracker } = makeTracker({});
    try {
      let r = await tracker.track({ courier: 'gojek', awb: AWB });
      assert.equal(r.kind, 'invalid');
      r = await tracker.track({ courier: 'jne', awb: '' });
      assert.equal(r.kind, 'invalid');
      r = await tracker.track({ courier: '', awb: AWB });
      assert.equal(r.kind, 'invalid');
    } finally {
      db.close();
    }
  });

  it('phone diteruskan ke kurir lain bila diisi (SiCepat)', async () => {
    const sicepat = mockTrackResolver({ success: true, courier: 'SiCepat Ekspres', waybillNumber: AWB, status: 'ON_PROCESS', history: [] });
    const { db, tracker } = makeTracker({ sicepat });
    try {
      const r = await tracker.track({ courier: 'sicepat', awb: AWB, phone: '12345' });
      assert.equal(r.kind, 'found');
      assert.equal(sicepat.calls[0][1].phone, '12345');
    } finally {
      db.close();
    }
  });
});

describe('tracker: cache 30 menit + fresh', () => {
  it('panggilan ke-2 dari cache; fresh=1 memanggil ulang', async () => {
    const jnt = mockTrackResolver(jntFound());
    const { db, tracker } = makeTracker({ jnt });
    try {
      const first = await tracker.track({ courier: 'jnt', awb: AWB, phone: '1234' });
      assert.equal(first.kind, 'found');
      assert.equal(first.data.cached, false);
      assert.ok(first.data.fetched_at);
      assert.equal(first.data.events.length, 3);
      assert.equal(first.data.status, 'ON_DELIVERY');

      const second = await tracker.track({ courier: 'jnt', awb: AWB, phone: '1234' });
      assert.equal(second.kind, 'found');
      assert.equal(second.data.cached, true);
      assert.equal(jnt.calls.length, 1);

      const fresh = await tracker.track({ courier: 'jnt', awb: AWB, phone: '1234', fresh: true });
      assert.equal(fresh.data.cached, false);
      assert.equal(jnt.calls.length, 2);
    } finally {
      db.close();
    }
  });

  it('cache basi (> 30 menit) diabaikan', async () => {
    const jnt = mockTrackResolver(jntFound());
    let nowMs = Date.now();
    const { db, tracker } = makeTracker({ jnt }, { now: () => nowMs });
    try {
      await tracker.track({ courier: 'jnt', awb: AWB, phone: '1234' });
      nowMs += TRACK_CACHE_TTL_MS + 1000;
      const r = await tracker.track({ courier: 'jnt', awb: AWB, phone: '1234' });
      assert.equal(r.data.cached, false);
      assert.equal(jnt.calls.length, 2);
    } finally {
      db.close();
    }
  });

  it('not_found tidak di-cache', async () => {
    const pos = mockTrackResolver({ success: false, courier: 'Pos Indonesia', waybillNumber: AWB, status: 'NOT_FOUND', message: 'tidak ditemukan' });
    const { db, tracker } = makeTracker({ pos });
    try {
      const r1 = await tracker.track({ courier: 'pos', awb: AWB });
      assert.equal(r1.kind, 'not_found');
      const r2 = await tracker.track({ courier: 'pos', awb: AWB });
      assert.equal(r2.kind, 'not_found');
      assert.equal(pos.calls.length, 2);
      assert.equal(db.countTrackCache(), 0);
    } finally {
      db.close();
    }
  });
});

describe('tracker: tri-state + verifikasi HP', () => {
  it('AWAITING tanpa phone = needs_phone; dengan phone = wrong_phone', async () => {
    const awaiting = { success: false, courier: 'X', waybillNumber: AWB, status: 'AWAITING_PHONE_VERIFICATION', message: 'butuh digit HP' };
    const sicepat = mockTrackResolver(awaiting);
    const jnt = mockTrackResolver(awaiting);
    const { db, tracker } = makeTracker({ sicepat, jnt });
    try {
      const r1 = await tracker.track({ courier: 'sicepat', awb: AWB });
      assert.equal(r1.kind, 'needs_phone');
      assert.equal(r1.digits, 5);
      const r2 = await tracker.track({ courier: 'jnt', awb: AWB, phone: '1234' });
      assert.equal(r2.kind, 'wrong_phone');
      assert.match(r2.message, /tidak cocok/);
    } finally {
      db.close();
    }
  });

  it('VERIFICATION_FAILED (JNE) = kind sendiri, pesan dua kemungkinan', async () => {
    const jne = mockTrackResolver({
      success: true, courier: 'JNE Express', waybillNumber: AWB,
      status: 'VERIFICATION_FAILED', message: 'Verifikasi gagal atau data tidak ditemukan',
    });
    const { db, tracker } = makeTracker({ jne });
    try {
      const r = await tracker.track({ courier: 'jne', awb: AWB, phone: '12345' });
      assert.equal(r.kind, 'verification_failed');
      assert.match(r.message, /digit terakhir/);
    } finally {
      db.close();
    }
  });

  it('error kurir: retry 3x lalu kind error; 403 tidak di-retry', async () => {
    let fails = 0;
    const flaky = {
      track: async () => {
        fails += 1;
        if (fails < 3) throw new Error('fetch failed');
        return jntFound();
      },
    };
    const { db: db1, tracker: t1 } = makeTracker({ jnt: flaky });
    try {
      const r = await t1.track({ courier: 'jnt', awb: AWB, phone: '1234' });
      assert.equal(r.kind, 'found');
      assert.equal(fails, 3);
    } finally {
      db1.close();
    }

    let calls403 = 0;
    const blocked = {
      track: async () => {
        calls403 += 1;
        return { success: false, courier: 'Anteraja', waybillNumber: AWB, status: 'RESOLVER_ERROR', message: 'Gagal memanggil API Anteraja (HTTP status 403).' };
      },
    };
    const { db: db2, tracker: t2 } = makeTracker({ anteraja: blocked });
    try {
      const r = await t2.track({ courier: 'anteraja', awb: AWB });
      assert.equal(r.kind, 'error');
      assert.equal(calls403, 1); // permanen — langsung menyerah
      assert.match(r.message, /403/);
    } finally {
      db2.close();
    }
  });

  it('timeout kurir = error, bukan crash', async () => {
    const hanging = { track: async () => new Promise(() => {}) };
    const { db, tracker } = makeTracker({ sicepat: hanging }, { timeoutMs: 50, maxAttempts: 1 });
    try {
      const r = await tracker.track({ courier: 'sicepat', awb: AWB });
      assert.equal(r.kind, 'error');
      assert.match(r.message, /Timeout/);
    } finally {
      db.close();
    }
  });
});

describe('server: /v1/track', () => {
  let ctx;
  const headers = { 'X-API-Key': API_KEY };

  before(async () => {
    const db = openDb(':memory:');
    const harvester = createHarvester({ db, resolvers: {}, sleepFn: () => Promise.resolve(), politeDelayMs: 0 });
    const tracker = createTracker({
      db,
      resolvers: {
        jnt: mockTrackResolver(jntFound()),
        jne: mockTrackResolver({
          success: true, courier: 'JNE Express', waybillNumber: AWB,
          status: 'VERIFICATION_FAILED', message: 'Verifikasi gagal atau data tidak ditemukan',
        }),
        pos: mockTrackResolver({ success: false, courier: 'Pos Indonesia', waybillNumber: AWB, status: 'NOT_FOUND', message: 'tidak ditemukan' }),
        sicepat: mockTrackResolver({ success: false, courier: 'SiCepat Ekspres', waybillNumber: AWB, status: 'AWAITING_PHONE_VERIFICATION', message: 'butuh 5 digit HP' }),
        anteraja: mockTrackResolver({ success: false, courier: 'Anteraja', waybillNumber: AWB, status: 'RESOLVER_ERROR', message: 'Gagal memanggil API Anteraja (HTTP status 403).' }),
      },
      sleepFn: () => Promise.resolve(), timeoutMs: 5000,
    });
    const server = createServer({ db, harvester, tracker, apiKey: API_KEY });
    await new Promise((r) => server.listen(0, r));
    ctx = { db, server, base: `http://127.0.0.1:${server.address().port}` };
  });
  after(() => new Promise((r) => { ctx.server.close(r); ctx.db.close(); }));

  it('tanpa API key = 401', async () => {
    const res = await fetch(`${ctx.base}/v1/track?courier=jnt&awb=${AWB}&phone=1234`);
    assert.equal(res.status, 401);
  });

  it('validasi input = 400', async () => {
    const cases = [
      '/v1/track',
      '/v1/track?awb=123',
      '/v1/track?courier=jnt',
      '/v1/track?courier=gojek&awb=123',
      '/v1/track?courier=jne&awb=123',
      '/v1/track?courier=jne&awb=123&phone=1234',
      '/v1/track?courier=jnt&awb=123&phone=12',
    ];
    for (const path of cases) {
      const res = await fetch(`${ctx.base}${path}`, { headers });
      assert.equal(res.status, 400, path);
    }
  });

  it('ditemukan: 200, bentuk standar, lalu cached', async () => {
    const url = `${ctx.base}/v1/track?courier=jnt&awb=${AWB}&phone=1234`;
    const first = await (await fetch(url, { headers })).json();
    assert.equal(first.success, true);
    assert.equal(first.courier, 'jnt');
    assert.equal(first.courierName, 'J&T Express');
    assert.equal(first.awb, AWB);
    assert.equal(first.status, 'ON_DELIVERY');
    assert.equal(first.events.length, 3);
    assert.equal(first.events[0].time, '2026-11-10 20:00:00');
    assert.equal(first.cached, false);
    assert.ok(first.fetched_at);

    const second = await (await fetch(url, { headers })).json();
    assert.equal(second.cached, true);
  });

  it('tidak ditemukan = 404; VERIFICATION_FAILED = 404; AWAITING = 400; error = 502', async () => {
    const notFound = await fetch(`${ctx.base}/v1/track?courier=pos&awb=${AWB}`, { headers });
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).status, 'NOT_FOUND');

    const vf = await fetch(`${ctx.base}/v1/track?courier=jne&awb=${AWB}&phone=12345`, { headers });
    assert.equal(vf.status, 404);
    assert.equal((await vf.json()).status, 'VERIFICATION_FAILED');

    const awaiting = await fetch(`${ctx.base}/v1/track?courier=sicepat&awb=${AWB}`, { headers });
    assert.equal(awaiting.status, 400);
    const awaitingBody = await awaiting.json();
    assert.equal(awaitingBody.requiresPhoneVerification, true);
    assert.equal(awaitingBody.digits, 5);

    const err = await fetch(`${ctx.base}/v1/track?courier=anteraja&awb=${AWB}`, { headers });
    assert.equal(err.status, 502);
  });
});
