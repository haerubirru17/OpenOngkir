// Harvester: panen tarif live dari endpoint resmi kurir via OpenResi
// (vendored di src/openresi/), simpan ke tabel tariffs.
//
// Prinsip: demand-driven — rute baru dipanen sekali lalu disimpan;
// rute basi (> TTL) dipanen ulang saat ditanya lagi.
import { getResolver } from './openresi/index.js';
import { parseLocationQuery } from './openresi/utils/locationParser.js';

export const COURIERS = {
  jne: 'JNE Express',
  jnt: 'J&T Express',
  sicepat: 'SiCepat Ekspres',
  anteraja: 'AnterAja',
  pos: 'Pos Indonesia',
};

export const ALL_COURIERS = Object.keys(COURIERS);

// Tarif dianggap basi setelah 30 hari (keputusan Fase 2).
export const TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Bila panen satu kurir gagal, jangan coba lagi untuk rute yang sama
// selama 1 jam (negative cache) — kurir yang terblokir (mis. AnterAja 403)
// tidak boleh memperlambat setiap request.
export const NEGATIVE_CACHE_MS = 60 * 60 * 1000;

const TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
// Jeda sopan antar panggilan ke kurir yang sama (0,5–1 dtk).
const POLITE_DELAY_MS = 750;
// Batas harga wajar per kg (pengaman lapis 1).
const PRICE_MIN_PER_KG = 1_000;
const PRICE_MAX_PER_KG = 1_000_000;
// Layanan di luar 5x / 0,2x median termurah antar kurir ditolak.
const OUTLIER_FACTOR = 5;
// Layanan kargo yang dibuang (filter SERVICE_DIBUANG dari Berbirru).
const CARGO_SERVICE_RE = /^(jtr|sps|gokil)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout ${label} (${ms / 1000} dtk)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isPermanentError(err) {
  return /tidak ditemukan/i.test(String(err?.message || err || ''));
}

/** Nama wilayah tanpa awalan administratif (KOTA/KABUPATEN/KECAMATAN). */
function cleanName(name) {
  return String(name || '')
    .replace(/^(kota administrasi|kota|kabupaten|kecamatan)\s+/i, '')
    .trim();
}

export function createHarvester({
  db,
  resolvers = null,
  now = Date.now,
  sleepFn = sleep,
  timeoutMs = TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
  politeDelayMs = POLITE_DELAY_MS,
} = {}) {
  const getRes = (code) =>
    resolvers ? resolvers[code] || null : getResolver(code);

  // Kapan terakhir memanggil tiap kurir (jeda sopan).
  const lastCallAt = new Map();
  // Panen yang sedang berjalan, per kunci rute+kurir (dedupe request bersamaan).
  const inFlight = new Map();

  async function politeWait(courier) {
    const last = lastCallAt.get(courier) || 0;
    const wait = politeDelayMs - (now() - last);
    if (wait > 0) await sleepFn(wait);
    lastCallAt.set(courier, now());
  }

  /**
   * Resolve kode lokasi kurir untuk satu kecamatan (lazy: cek DB dulu,
   * bila belum ada cari via OpenResi lalu simpan ke courier_places).
   * @returns {{ code: string, label: string }}
   */
  async function resolvePlace(kemendagriCode, courier, role) {
    const cached = db.getCourierPlace(kemendagriCode, courier, role);
    if (cached) return { code: cached.courier_code, label: cached.courier_label };

    const chain = db.getWilayahChain(kemendagriCode);
    if (!chain) throw new Error(`Kode wilayah ${kemendagriCode} tidak ditemukan.`);
    const { kecamatan, kabupaten, provinsi } = chain;
    const label = [kecamatan.name, kabupaten?.name, provinsi?.name]
      .filter(Boolean)
      .join(', ');

    // AnterAja menerima kode Kemendagri langsung — tanpa pencarian.
    if (courier === 'anteraja') {
      db.saveCourierPlace(kemendagriCode, courier, role, kemendagriCode, label);
      return { code: kemendagriCode, label };
    }

    const resolver = getRes(courier);
    if (!resolver) throw new Error(`Kurir ${courier} tidak didukung.`);
    const searchFn =
      role === 'origin'
        ? (q) => resolver.searchOrigins(q)
        : (q) => resolver.searchDestinations(q);

    const locStr = [cleanName(kecamatan.name), cleanName(kabupaten?.name), cleanName(provinsi?.name)]
      .filter(Boolean)
      .join(', ');
    const parsed = parseLocationQuery(locStr);
    // POS memakai kode pos kelurahan untuk asal DAN tujuan — selalu cari
    // dari kecamatan dulu (destinationQueries). Kurir lain: asal dari kota,
    // tujuan dari kecamatan.
    const queries =
      courier === 'pos' || role === 'destination' ? parsed.destinationQueries : parsed.originQueries;
    const getters =
      courier === 'pos'
        ? { getLabel: (o) => o.label, getPostcode: (o) => o.postalCode }
        : {
            getLabel: (o) => o.label,
            getCity: (o) => o.city,
            getDistrict: (o) => o.district || o.countyarea,
          };

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await politeWait(courier);
        const match = await withTimeout(
          parsed.findBestMatch(searchFn, queries, getters),
          timeoutMs,
          `cari lokasi ${courier}`
        );
        if (!match) throw new Error(`Lokasi "${locStr}" tidak ditemukan di sistem ${COURIERS[courier]}.`);
        const code = courier === 'pos' ? match.postalCode || match.code : match.code;
        if (!code) throw new Error(`Lokasi "${locStr}" tidak punya kode di sistem ${COURIERS[courier]}.`);
        db.saveCourierPlace(kemendagriCode, courier, role, code, match.label || label);
        return { code, label: match.label || label };
      } catch (err) {
        lastErr = err;
        if (isPermanentError(err)) break;
        if (attempt < 1) await sleepFn(1000);
      }
    }
    throw lastErr;
  }

  /** Saring layanan: buang kargo + harga di luar batas wajar. */
  function filterServices(services) {
    const seen = new Map();
    for (const s of services || []) {
      const service = String(s.service || s.name || '').trim();
      const cost = Number(s.cost);
      if (!service || !Number.isFinite(cost)) continue;
      if (CARGO_SERVICE_RE.test(service)) continue;
      if (/kargo/i.test(String(s.description || '') + ' ' + String(s.type || ''))) continue;
      if (cost < PRICE_MIN_PER_KG || cost > PRICE_MAX_PER_KG) continue;
      const prev = seen.get(service);
      if (!prev || cost < prev.cost) {
        seen.set(service, { service, cost, etd: String(s.etd || '-') });
      }
    }
    return [...seen.values()].sort((a, b) => a.cost - b.cost);
  }

  /**
   * Tolak layanan yang harganya menyimpang jauh dari kurir lain di rute
   * yang sama (pengaman lapis 1). Butuh >= 2 kurir yang berhasil.
   */
  function filterOutliers(perCourier) {
    const ok = perCourier.filter((r) => r.services.length > 0);
    if (ok.length < 2) return perCourier;
    const cheapest = ok.map((r) => r.services[0].cost).sort((a, b) => a - b);
    const median = cheapest[Math.floor(cheapest.length / 2)];
    const lo = median / OUTLIER_FACTOR;
    const hi = median * OUTLIER_FACTOR;
    for (const r of ok) {
      r.services = r.services.filter((s) => s.cost >= lo && s.cost <= hi);
    }
    return perCourier;
  }

  /** Panen satu kurir untuk satu rute (retry 3x + backoff). */
  async function harvestCourier({ originCode, destCode, courier, weightKg }) {
    const started = now();
    try {
      const origin = await resolvePlace(originCode, courier, 'origin');
      const dest = await resolvePlace(destCode, courier, 'destination');
      const resolver = getRes(courier);
      if (!resolver) throw new Error(`Kurir ${courier} tidak didukung.`);

      let lastErr = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await politeWait(courier);
          const res = await withTimeout(
            resolver.calculateCost({ origin: origin.code, destination: dest.code, weight: weightKg }),
            timeoutMs,
            `ongkir ${courier}`
          );
          if (!res || !res.success) {
            throw new Error(res?.error || res?.message || `Gagal memanggil ${COURIERS[courier]}.`);
          }
          const services = filterServices(res.services);
          if (services.length === 0) {
            throw new Error(`Tidak ada layanan valid dari ${COURIERS[courier]} untuk rute ini.`);
          }
          db.logHarvest({
            origin_code: originCode, dest_code: destCode, courier,
            weight_kg: weightKg, status: 'ok', latency_ms: now() - started,
          });
          return { courier, services, error: null };
        } catch (err) {
          lastErr = err;
          if (isPermanentError(err)) break;
          if (attempt < maxAttempts - 1) await sleepFn(1000 * 2 ** attempt);
        }
      }
      throw lastErr;
    } catch (err) {
      db.logHarvest({
        origin_code: originCode, dest_code: destCode, courier,
        weight_kg: weightKg, status: 'error', latency_ms: now() - started,
        error: String(err?.message || err).slice(0, 500),
      });
      return { courier, services: [], error: String(err?.message || err) };
    }
  }

  /** Panen satu rute untuk beberapa kurir (paralel antar kurir). */
  async function harvestRoute({ originCode, destCode, weightKg, couriers }) {
    const results = await Promise.all(
      couriers.map((courier) => {
        const key = `${originCode}|${destCode}|${weightKg}|${courier}`;
        const existing = inFlight.get(key);
        if (existing) return existing;
        const p = harvestCourier({ originCode, destCode, courier, weightKg }).finally(() => {
          inFlight.delete(key);
        });
        inFlight.set(key, p);
        return p;
      })
    );
    filterOutliers(results);
    const fetchedAt = now();
    for (const r of results) {
      if (r.services.length === 0) continue;
      db.deleteTariffs(originCode, destCode, r.courier, weightKg);
      db.saveTariffs(
        r.services.map((s) => ({
          origin_code: originCode, dest_code: destCode, courier: r.courier,
          service: s.service, weight_kg: weightKg, price: s.cost, eta: s.etd,
          source: 'openresi',
        })),
        fetchedAt
      );
    }
    return results;
  }

  /**
   * Jawab ongkir: baca DB dulu, panen kurir yang belum ada / basi.
   * @returns {{ options: Array, errors: Array, weightKg: number }}
   */
  async function getCost({ originCode, destCode, weightKg, couriers, fresh = false }) {
    const cutoff = now() - TTL_MS;
    let dbRows = fresh ? [] : db.getFreshTariffs(originCode, destCode, weightKg, cutoff, couriers);
    const freshCouriers = new Set(dbRows.map((r) => r.courier));
    const missing = couriers.filter((c) => !freshCouriers.has(c));

    let harvested = [];
    let skipped = [];
    let liveCount = 0;
    if (missing.length > 0) {
      let toHarvest = missing;
      if (!fresh) {
        // Negative cache: kurir yang baru gagal untuk rute ini tidak
        // dipanen ulang — pakai error terakhir yang tercatat.
        toHarvest = [];
        for (const c of missing) {
          const last = db.getLatestHarvestLog(originCode, destCode, c, weightKg);
          if (last && last.status === 'error' && last.created_at >= now() - NEGATIVE_CACHE_MS) {
            skipped.push({ courier: c, services: [], error: last.error });
          } else {
            toHarvest.push(c);
          }
        }
      }
      liveCount = toHarvest.length;
      if (toHarvest.length > 0) {
        harvested = await harvestRoute({ originCode, destCode, weightKg, couriers: toHarvest });
      }
      harvested = [...harvested, ...skipped];
      // Baca ulang dari DB agar opsi hasil panen memakai fetched_at yang tersimpan.
      dbRows = db.getFreshTariffs(originCode, destCode, weightKg, cutoff, couriers);
    }
    // Metrik (Fase 4): hitung per kurir — dari DB vs panen live.
    // Kurir yang dilewati negative cache tidak dihitung di keduanya.
    db.recordQuoteStats(freshCouriers.size, liveCount);

    const harvestedCouriers = new Set(harvested.filter((r) => r.services.length > 0).map((r) => r.courier));
    const options = dbRows.map((r) => ({
      courier: r.courier,
      courierName: COURIERS[r.courier] || r.courier,
      service: r.service,
      price: r.price,
      eta: r.eta,
      fetched_at: new Date(r.fetched_at).toISOString(),
      cached: !harvestedCouriers.has(r.courier),
    }));
    options.sort((a, b) => a.price - b.price);
    const errors = harvested
      .filter((r) => r.error)
      .map((r) => ({ courier: r.courier, courierName: COURIERS[r.courier] || r.courier, error: r.error }));
    return { options, errors, weightKg };
  }

  /** Cron refresh: panen ulang rute basi, rute paling sering ditanya dulu. */
  async function refreshStaleRoutes({ limit = 10 } = {}) {
    const routes = db.getStaleRoutes(now() - TTL_MS, limit);
    const summary = { routes: routes.length, ok: 0, errors: [] };
    for (const route of routes) {
      const couriers = [...new Set(
        db.getTariffs(route.origin_code, route.dest_code, route.weight_kg).map((r) => r.courier)
      )];
      if (couriers.length === 0) continue;
      const results = await harvestRoute({
        originCode: route.origin_code, destCode: route.dest_code,
        weightKg: route.weight_kg, couriers,
      });
      for (const r of results) {
        if (r.error) summary.errors.push({ route, courier: r.courier, error: r.error });
        else summary.ok += 1;
      }
    }
    return summary;
  }

  /** Spot-check: bandingkan harga catatan vs live untuk contoh rute. */
  async function spotCheck({ limit = 5 } = {}) {
    const routes = db.getSpotCheckRoutes(limit);
    const summary = { routes: routes.length, drifted: [], errors: [] };
    for (const route of routes) {
      const before = db.getTariffs(route.origin_code, route.dest_code, route.weight_kg);
      const cheapestBefore = new Map();
      for (const row of before) {
        const prev = cheapestBefore.get(row.courier);
        if (!prev || row.price < prev) cheapestBefore.set(row.courier, row.price);
      }
      const couriers = [...cheapestBefore.keys()];
      if (couriers.length === 0) continue;
      const results = await harvestRoute({
        originCode: route.origin_code, destCode: route.dest_code,
        weightKg: route.weight_kg, couriers,
      });
      for (const r of results) {
        if (r.error) {
          summary.errors.push({ route, courier: r.courier, error: r.error });
          continue;
        }
        const cheapestNow = r.services.length > 0 ? r.services[0].cost : null;
        const old = cheapestBefore.get(r.courier);
        if (cheapestNow !== null && old !== undefined && cheapestNow !== old) {
          db.logHarvest({
            origin_code: route.origin_code, dest_code: route.dest_code,
            courier: r.courier, weight_kg: route.weight_kg, status: 'drift',
            error: `spot-check: termurah ${old} -> ${cheapestNow}`,
          });
          summary.drifted.push({
            route, courier: r.courier, oldPrice: old, newPrice: cheapestNow,
          });
        }
      }
    }
    return summary;
  }

  /** Perawatan harian: refresh rute basi + spot-check. */
  async function runDailyMaintenance({ refreshLimit = 10, spotCheckLimit = 5 } = {}) {
    const refresh = await refreshStaleRoutes({ limit: refreshLimit });
    const spot = await spotCheck({ limit: spotCheckLimit });
    return { refresh, spotCheck: spot };
  }

  return {
    resolvePlace,
    harvestCourier,
    harvestRoute,
    getCost,
    refreshStaleRoutes,
    spotCheck,
    runDailyMaintenance,
    // Diekspos untuk tes.
    _filterServices: filterServices,
    _filterOutliers: filterOutliers,
  };
}
