// Tes pencarian lokasi SiCepat + pemisah "pencarian gagal" vs "tidak ada hasil".
// fetch global di-stub (tanpa jaringan).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SiCepatResolver } from '../src/openresi/resolvers/sicepat.js';
import { parseLocationQuery } from '../src/openresi/utils/locationParser.js';

const realFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = handler;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('sicepat searchOrigins/searchDestinations', () => {
  it('HTTP error (mis. 429) dilempar, bukan []', async () => {
    stubFetch(async () => ({ ok: false, status: 429 }));
    const r = new SiCepatResolver();
    await assert.rejects(() => r.searchOrigins('Tangerang'), /HTTP 429/);
    await assert.rejects(() => r.searchDestinations('Bandung'), /HTTP 429/);
  });

  it('HTTP 200 tetap di-parse seperti biasa', async () => {
    stubFetch(async (url) => ({
      ok: true,
      status: 200,
      json: async () => String(url).includes('/origin')
        ? { data: { sicepat: { results: [{ origin_code: 'TGR', origin_name: 'Tangerang' }] } } }
        : { data: { sicepat: { results: [{ destination_code: 'BDO10000', subdistrict: 'Coblong', city: 'Bandung', province: 'Jawa Barat' }] } } },
    }));
    const r = new SiCepatResolver();
    const origins = await r.searchOrigins('Tangerang');
    assert.deepEqual(origins, [{ code: 'TGR', label: 'Tangerang' }]);
    const dests = await r.searchDestinations('Coblong');
    assert.equal(dests[0].code, 'BDO10000');
    assert.equal(dests[0].city, 'Bandung');
  });
});

describe('findBestMatch: gagal vs kosong', () => {
  it('semua query error -> error terakhir dilempar (transien)', async () => {
    const parsed = parseLocationQuery('TANGERANG, TANGERANG, BANTEN');
    const throwing = async () => {
      throw new Error('fetch failed');
    };
    await assert.rejects(
      () => parsed.findBestMatch(throwing, parsed.originQueries, {}),
      /fetch failed/
    );
  });

  it('semua query kosong tanpa error -> null (lokasi memang tidak ada)', async () => {
    const parsed = parseLocationQuery('TANGERANG, TANGERANG, BANTEN');
    const empty = async () => [];
    const match = await parsed.findBestMatch(empty, parsed.originQueries, {});
    assert.equal(match, null);
  });

  it('satu query error, satu lagi berhasil -> hasil dipakai (tanpa lempar)', async () => {
    const parsed = parseLocationQuery('TANGERANG, TANGERANG, BANTEN');
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error('fetch failed');
      return [{ code: 'TGR', label: 'Tangerang' }];
    };
    const match = await parsed.findBestMatch(flaky, parsed.originQueries, {
      getLabel: (o) => o.label,
    });
    assert.equal(match.code, 'TGR');
  });
});
