// Salinan ringkas dari OpenResi src/index.js (commit 53544af) — hanya 5 kurir
// yang dipakai OpenOngkir. Lihat README.md di folder ini untuk asal-usul.
import { jneResolver } from './resolvers/jne.js';
import { jntResolver } from './resolvers/jnt.js';
import { sicepatResolver } from './resolvers/sicepat.js';
import { anterajaResolver } from './resolvers/anteraja.js';
import { posResolver } from './resolvers/pos.js';

const registry = new Map();

registry.set('jne', jneResolver);
registry.set('jnt', jntResolver);
registry.set('jet', jntResolver);
registry.set('sicepat', sicepatResolver);
registry.set('sicepatekspres', sicepatResolver);
registry.set('anteraja', anterajaResolver);
registry.set('pos', posResolver);
registry.set('posindonesia', posResolver);
registry.set('posindo', posResolver);

export function registerCourier(code, resolverInstance) {
  registry.set(code.toLowerCase(), resolverInstance);
}

export function getResolver(courier) {
  if (!courier || typeof courier !== 'string') return null;
  return registry.get(courier.toLowerCase()) || null;
}

export function listSupportedCouriers() {
  const list = [];
  for (const [code, instance] of registry.entries()) {
    list.push({ code, name: instance.name });
  }
  return list;
}

export async function trackPackage(courier, waybillNumber, options = {}) {
  const resolver = getResolver(courier);
  if (!resolver) {
    return {
      success: false,
      courier: courier || 'unknown',
      waybillNumber,
      status: 'UNSUPPORTED_COURIER',
      message: `Ekspedisi "${courier}" belum didukung.`,
    };
  }
  try {
    return await resolver.track(waybillNumber, options);
  } catch (error) {
    return {
      success: false,
      courier: resolver.name,
      waybillNumber,
      status: 'RESOLVER_ERROR',
      message: error.message || 'Terjadi kesalahan saat memproses pelacakan resi.',
    };
  }
}

// Kurir utama OpenOngkir (subset dari PRIMARY_COURIERS upstream).
export const PRIMARY_COURIERS = ['jne', 'sicepat', 'anteraja', 'jnt', 'pos'];

export function getCanonicalCourierCode(code) {
  const c = String(code || '').toLowerCase().trim();
  if (['jet', 'jnt'].includes(c)) return 'jnt';
  if (['sicepat', 'sicepatekspres'].includes(c)) return 'sicepat';
  if (['pos', 'posindonesia', 'posindo'].includes(c)) return 'pos';
  return c;
}

function normalizeServiceItem(raw, courierName, courierCode) {
  const cost = Number(raw.cost !== undefined ? raw.cost : raw.tariff || 0);
  const formattedCost =
    raw.formattedCost && !raw.formattedCost.includes('NaN')
      ? raw.formattedCost.replace(/\u00a0/g, ' ')
      : cost > 0
        ? `Rp ${cost.toLocaleString('id-ID')}`
        : 'Rp 0';

  const service = raw.service || raw.name || raw.type || 'Standard';
  const type = raw.type || raw.service || '';
  const name = raw.name || `${courierName} ${service}`;
  const description = raw.description || raw.name || `${courierName} ${service}`;
  const etd = raw.etd || '-';

  return {
    ...raw,
    courier: courierName,
    courierCode,
    service,
    type,
    name,
    cost,
    formattedCost,
    etd,
    description,
  };
}

function parseCourierInput(input) {
  if (!input || input === 'all' || input === '*') {
    return [...PRIMARY_COURIERS];
  }
  let list = [];
  if (Array.isArray(input)) {
    list = input;
  } else if (typeof input === 'string') {
    list = input.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const unique = [];
  for (const item of list) {
    const canonical = getCanonicalCourierCode(item);
    if (canonical && !unique.includes(canonical)) {
      unique.push(canonical);
    }
  }
  return unique.length > 0 ? unique : [...PRIMARY_COURIERS];
}

/**
 * Universal Shipping Cost / Tariff calculation (Cek Ongkir).
 * @param {string|string[]} courier - kode kurir, 'all', atau dipisah koma
 * @param {object} params - { origin, destination, weight } (weight dalam kg)
 */
export async function calculateShippingCost(courier, params = {}) {
  const isMulti =
    !courier ||
    courier === 'all' ||
    courier === '*' ||
    (typeof courier === 'string' && courier.includes(',')) ||
    (Array.isArray(courier) && courier.length > 1);

  if (!isMulti) {
    const singleCode = Array.isArray(courier) ? courier[0] : courier;
    const resolver = getResolver(singleCode);
    if (!resolver) {
      return {
        success: false,
        courier: singleCode || 'unknown',
        error: `Ekspedisi "${singleCode}" belum didukung.`,
      };
    }
    try {
      const result = await resolver.calculateCost(params);
      const canonicalCode = getCanonicalCourierCode(singleCode);
      if (result.success && Array.isArray(result.services)) {
        const normalizedServices = result.services.map((s) =>
          normalizeServiceItem(s, result.courier || resolver.name, canonicalCode)
        );
        normalizedServices.sort((a, b) => a.cost - b.cost);
        return {
          ...result,
          totalServices: normalizedServices.length,
          cheapest: normalizedServices[0] || null,
          services: normalizedServices,
        };
      }
      return result;
    } catch (error) {
      return {
        success: false,
        courier: resolver.name,
        error: error.message || 'Terjadi kesalahan saat menghitung ongkos kirim.',
      };
    }
  }

  const courierCodes = parseCourierInput(courier);
  const settlements = await Promise.allSettled(
    courierCodes.map(async (code) => {
      const canonical = getCanonicalCourierCode(code);
      const resolver = getResolver(canonical);
      if (!resolver) throw new Error(`Ekspedisi "${code}" belum didukung.`);
      const res = await resolver.calculateCost(params);
      return { code: canonical, resolver, res };
    })
  );

  const allServices = [];
  const successfulCouriers = [];
  const errors = [];

  for (let i = 0; i < settlements.length; i++) {
    const item = settlements[i];
    const code = courierCodes[i];
    if (item.status === 'fulfilled') {
      const { resolver, res, code: canonicalCode } = item.value;
      if (res.success && Array.isArray(res.services) && res.services.length > 0) {
        successfulCouriers.push(canonicalCode);
        for (const s of res.services) {
          allServices.push(
            normalizeServiceItem(s, res.courier || resolver.name, canonicalCode)
          );
        }
      } else {
        errors.push({
          courier: canonicalCode,
          name: resolver.name,
          error: res.error || res.message || 'Tidak ada layanan pengiriman yang tersedia untuk rute ini.',
        });
      }
    } else {
      const canonical = getCanonicalCourierCode(code);
      const resolver = getResolver(canonical);
      errors.push({
        courier: canonical,
        name: resolver ? resolver.name : canonical,
        error: item.reason?.message || 'Gagal memproses perhitungan ongkos kirim.',
      });
    }
  }

  allServices.sort((a, b) => a.cost - b.cost);
  return {
    success: allServices.length > 0,
    totalServices: allServices.length,
    services: allServices,
    cheapest: allServices[0] || null,
    successfulCouriers,
    errors,
  };
}
