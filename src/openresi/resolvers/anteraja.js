import { BaseCourierResolver } from './base.js';
import { parseLocationQuery } from '../utils/locationParser.js';

/**
 * Anteraja Tracking & Shipping Cost Resolver
 *
 * Tracking: Direct integration with official Anteraja Mobile Gateway (https://api.anteraja.id).
 * Zero captcha, zero OCR, instant sub-second response without external workers.
 *
 * Shipping Costs & Locations: Direct integration with Anteraja Web API (https://anteraja.id/api).
 */
export class AnterajaResolver extends BaseCourierResolver {
  constructor() {
    super('Anteraja', 'anteraja');
    this.baseUrl = 'https://anteraja.id/api';
    this.mobileApiUrl = 'https://api.anteraja.id/order/tracking';
    this.suggestionApiUrl = `${this.baseUrl}/trackparcel/getSuggestion`;
    this.ratesApiUrl = `${this.baseUrl}/trackparcel/getRates`;

    this.defaultUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    // Standard headers mimicking official Anteraja Android Application (v1.21.0)
    this.mobileHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'okhttp/4.9.3',
      'source': 'aca_android',
      'mv': '1.2',
      'appVersion': '1.21.0',
      'appid': 'JV_APP',
      'clientcode': 'ACA',
      'version': '1.0',
    };
  }

  /**
   * Search location suggestions (districts / subdistricts)
   * @param {string} query - Keyword e.g. "Menteng", "Jakarta", "Surabaya"
   * @returns {Promise<Array<{ code: string, label: string, district: string, city: string, province: string, postcodes: string[] }>>}
   */
  async searchLocations(query) {
    const q = (query || '').trim();
    if (q.length < 2) return [];

    try {
      const url = `${this.suggestionApiUrl}?keyword=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': this.defaultUserAgent,
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://anteraja.id/cek-ongkir',
        },
      });

      if (!res.ok) return [];
      const json = await res.json().catch(() => ({}));
      const items = Array.isArray(json.content) ? json.content : [];

      // Sort: prioritize serviced subdistricts (with postal codes) and word matches
      const wordRegex = new RegExp(`\\b${q}\\b`, 'i');
      const sorted = [...items].sort((a, b) => {
        const aHasPost = Array.isArray(a.postcodes) && a.postcodes.length > 0;
        const bHasPost = Array.isArray(b.postcodes) && b.postcodes.length > 0;
        if (aHasPost && !bHasPost) return -1;
        if (!aHasPost && bHasPost) return 1;

        const aMatch =
          wordRegex.test(a.district_name) || wordRegex.test(a.city_name);
        const bMatch =
          wordRegex.test(b.district_name) || wordRegex.test(b.city_name);
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;
        return 0;
      });

      return sorted.map((item) => ({
        code: item.district_code || '',
        label: `${item.district_name}, ${item.city_name}, ${item.province_name}${
          item.postcodes && item.postcodes.length > 0 ? ` (${item.postcodes[0]})` : ''
        }`,
        district: item.district_name || '',
        city: item.city_name || '',
        province: item.province_name || '',
        postcodes: item.postcodes || [],
      }));
    } catch (_) {
      return [];
    }
  }

  /**
   * Search origin locations for Anteraja
   * @param {string} query
   * @returns {Promise<Array<{ code: string, label: string }>>}
   */
  async searchOrigins(query) {
    return this.searchLocations(query);
  }

  /**
   * Search destination locations for Anteraja
   * @param {string} query
   * @returns {Promise<Array<{ code: string, label: string }>>}
   */
  async searchDestinations(query) {
    return this.searchLocations(query);
  }

  /**
   * Calculate Shipping Rates from Origin to Destination
   * @param {object|string} originOrParams - Origin district name/code or params object
   * @param {string} [destination] - Destination district name or district code
   * @param {number} [weight=1000] - Weight in grams (or kg if <= 50)
   * @returns {Promise<object>} Standardized cost estimation result
   */
  async calculateCost(originOrParams, destination, weight = 1000) {
    let rawOrigin = '';
    let rawDest = '';
    let weightInput = weight;

    if (typeof originOrParams === 'object' && originOrParams !== null) {
      rawOrigin = (originOrParams.origin || originOrParams.from || '').trim();
      rawDest = (originOrParams.destination || originOrParams.to || '').trim();
      weightInput = originOrParams.weight !== undefined ? originOrParams.weight : weight;
    } else {
      rawOrigin = (originOrParams || '').trim();
      rawDest = (destination || '').trim();
    }

    let weightNum = Number(weightInput) || 1;
    // If weight <= 50, treat as kg and convert to grams
    let weightGrams = weightNum <= 50 ? Math.round(weightNum * 1000) : Math.round(weightNum);
    const weightKg = Math.max(0.1, weightGrams / 1000);

    if (!rawOrigin || !rawDest) {
      return {
        success: false,
        courier: this.name,
        error: 'Asal (origin) dan tujuan (destination) wajib diisi.',
      };
    }

    // Helper to check if string is already an Anteraja district code (e.g. '31.71.06' or 'ID_...')
    const isAnterajaCode = (c) => /^\d{2}\.\d{2}\.\d{2}$/.test(c) || (c && c.startsWith('ID_'));

    // 1. Resolve Origin District Code
    let originCode = rawOrigin;
    let originLabel = rawOrigin;
    if (!isAnterajaCode(originCode)) {
      const parsedOrigin = parseLocationQuery(rawOrigin);
      let suggestions = [];
      for (const q of parsedOrigin.destinationQueries) {
        suggestions = await this.searchLocations(q);
        if (suggestions.length > 0) break;
      }
      if (suggestions.length === 0) {
        return {
          success: false,
          courier: this.name,
          error: `Lokasi asal "${rawOrigin}" tidak ditemukan di sistem Anteraja. Gunakan pencarian lokasi untuk memilih kecamatan yang valid.`,
        };
      }
      suggestions = parsedOrigin.rankMatches(suggestions, {
        getLabel: (s) => s.label,
        getCity: (s) => s.city,
        getDistrict: (s) => s.district,
        getPostcode: (s) => s.postcodes?.[0],
      });
      originCode = suggestions[0].code;
      originLabel = suggestions[0].label;
    }

    // 2. Resolve Destination District Code
    let destCode = rawDest;
    let destLabel = rawDest;
    if (!isAnterajaCode(destCode)) {
      const parsedDest = parseLocationQuery(rawDest);
      let suggestions = [];
      for (const q of parsedDest.destinationQueries) {
        suggestions = await this.searchLocations(q);
        if (suggestions.length > 0) break;
      }
      if (suggestions.length === 0) {
        return {
          success: false,
          courier: this.name,
          error: `Lokasi tujuan "${rawDest}" tidak ditemukan di sistem Anteraja. Gunakan pencarian lokasi untuk memilih kecamatan yang valid.`,
        };
      }
      suggestions = parsedDest.rankMatches(suggestions, {
        getLabel: (s) => s.label,
        getCity: (s) => s.city,
        getDistrict: (s) => s.district,
        getPostcode: (s) => s.postcodes?.[0],
      });
      destCode = suggestions[0].code;
      destLabel = suggestions[0].label;
    }

    // 3. Query Rates API
    try {
      const res = await fetch(this.ratesApiUrl, {
        method: 'POST',
        headers: {
          'User-Agent': this.defaultUserAgent,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://anteraja.id/cek-ongkir',
        },
        body: JSON.stringify({
          origin: originCode,
          destination: destCode,
        }),
      });

      if (!res.ok) {
        return {
          success: false,
          courier: this.name,
          error: `Gagal memanggil API Anteraja (HTTP status ${res.status}).`,
        };
      }

      const json = await res.json().catch(() => ({}));
      const rawServices = Array.isArray(json.services) ? json.services : [];

      if (rawServices.length === 0) {
        return {
          success: false,
          courier: this.name,
          origin: { code: originCode, label: originLabel },
          destination: { code: destCode, label: destLabel },
          weight: `${weightKg} kg`,
          services: [],
          message: 'Tidak ada layanan Anteraja yang tersedia untuk rute ini.',
        };
      }

      // Courier calculation standard: round up to nearest kg for pricing
      const billingMultiplier = Math.ceil(weightKg);

      const currencyFmt = new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
      });

      const services = rawServices.map((s) => {
        const unitTariff = Number(s.price) || 0;
        const totalTariff = unitTariff * billingMultiplier;
        const timeQuantifier = s.time_quantifier || 'Day';
        const etdStr = s.etd ? `${s.etd} ${timeQuantifier === 'Day' ? 'Hari' : timeQuantifier}` : '-';
        const svcCode = s.service_code || '';
        const svcName = s.service_name || svcCode;

        return {
          service: svcCode || svcName,
          type: svcCode,
          name: svcName,
          cost: totalTariff,
          formattedCost: currencyFmt.format(totalTariff),
          tariff: totalTariff,
          unitTariff: unitTariff,
          etd: etdStr,
          description: svcName,
          isCod: !!s.is_cod,
        };
      });

      // Sort by tariff ascending
      services.sort((a, b) => a.tariff - b.tariff);

      return {
        success: true,
        courier: this.name,
        origin: {
          code: originCode,
          label: originLabel,
        },
        destination: {
          code: destCode,
          label: destLabel,
        },
        weight: `${weightKg} kg`,
        billingWeight: `${billingMultiplier} kg`,
        services: services,
      };
    } catch (err) {
      return {
        success: false,
        courier: this.name,
        error: `Gagal menghitung tarif Anteraja: ${err.message}`,
      };
    }
  }

  /**
   * Compatibility method: Captcha is no longer required with direct Mobile Gateway integration
   * @returns {Promise<{ required: boolean, message: string }>}
   */
  async getCaptcha() {
    return {
      required: false,
      message: 'Captcha tidak diperlukan lagi karena Anteraja terhubung langsung ke API Mobile.',
    };
  }

  /**
   * Track package by waybill / resi
   * Calls Anteraja's official Mobile Gateway (https://api.anteraja.id/order/tracking).
   * 100% direct, zero captcha, no OCR required.
   *
   * @param {string} waybillNumber - Airwaybill number (nomor resi Anteraja)
   * @param {object} [options] - Reserved for options
   * @returns {Promise<object>} Standardized tracking result
   */
  async track(waybillNumber, options = {}) {
    const resi = this.sanitizeWaybill(waybillNumber);

    if (!resi) {
      return {
        success: false,
        courier: this.name,
        waybillNumber: '',
        status: 'INVALID_WAYBILL',
        message: 'Nomor resi tidak boleh kosong.',
      };
    }

    try {
      const res = await fetch(this.mobileApiUrl, {
        method: 'POST',
        headers: {
          ...this.mobileHeaders,
          'msgid': Date.now().toString(),
        },
        body: JSON.stringify([
          {
            codes: resi,
            phoneNumber: options.phoneNumber || options.phone || '',
          },
        ]),
      });

      if (!res.ok) {
        return {
          success: false,
          courier: this.name,
          waybillNumber: resi,
          status: 'RESOLVER_ERROR',
          message: `Gagal memanggil API Anteraja (HTTP status ${res.status}).`,
        };
      }

      const json = await res.json().catch(() => ({}));

      // Check for NOT FOUND status from Anteraja backend
      if (
        json.status === 404 ||
        !json.content ||
        (Array.isArray(json.content) && json.content.length === 0)
      ) {
        return {
          success: false,
          courier: this.name,
          waybillNumber: resi,
          status: 'NOT_FOUND',
          message: `Nomor resi "${resi}" tidak ditemukan di sistem Anteraja. Pastikan nomor resi sudah benar.`,
        };
      }

      // Result payload
      const resultData = Array.isArray(json.content) ? json.content[0] : json.content;
      if (!resultData || resultData.detail === 'not found') {
        return {
          success: false,
          courier: this.name,
          waybillNumber: resi,
          status: 'NOT_FOUND',
          message: `Nomor resi "${resi}" tidak ditemukan di sistem Anteraja. Pastikan nomor resi sudah benar.`,
        };
      }

      // Parse history checkpoints
      const rawHistory = Array.isArray(resultData.history) ? resultData.history : [];
      const history = rawHistory.map((item) => {
        const timestamp = item.dateTime || item.timestamp || '';
        const parts = timestamp.split(' ');
        const date = parts[0] || '';
        const time = parts[1] || '';

        let desc = '';
        if (item.message) {
          if (typeof item.message === 'string') {
            desc = item.message;
          } else {
            desc = item.message.id || item.message.en || '';
          }
        }

        return {
          dateTime: timestamp,
          date: date,
          time: time,
          location: item.hub_name || '',
          status: item.trackingCode || item.tracking_code || '',
          description: desc || 'Status diperbarui',
          actor: item.courier_name || item.driver_name || '',
        };
      });

      const detailObj =
        typeof resultData.detail === 'object' && resultData.detail !== null
          ? resultData.detail
          : {};

      // Determine standardized status
      let standardizedStatus = 'ON_PROCESS';
      const finalStatusUpper = (detailObj.finalStatus || '').toUpperCase();
      const historyText = history
        .map((h) => `${h.status} ${h.description}`)
        .join(' ')
        .toUpperCase();

      if (
        finalStatusUpper === 'DELIVERED' ||
        historyText.includes('DELIVERED') ||
        historyText.includes('TERKIRIM') ||
        historyText.includes('SUDAH DITERIMA') ||
        historyText.includes('SELESAI')
      ) {
        standardizedStatus = 'DELIVERED';
      } else if (
        finalStatusUpper === 'ON_DELIVERY' ||
        historyText.includes('DELIVERY') ||
        historyText.includes('SEDANG DIANTAR') ||
        historyText.includes('SATRIA')
      ) {
        standardizedStatus = 'ON_DELIVERY';
      } else if (
        finalStatusUpper.includes('RETURN') ||
        historyText.includes('RETURN') ||
        historyText.includes('RETUR') ||
        historyText.includes('KEMBALI KE PENGIRIM')
      ) {
        standardizedStatus = 'RETURN_TO_SENDER';
      }

      return {
        success: true,
        courier: this.name,
        waybillNumber: resi,
        verified: true,
        status: standardizedStatus,
        summary: {
          waybill: resi,
          service: detailObj.serviceCode || detailObj.service_code || 'Anteraja',
          status: standardizedStatus,
          sender: detailObj.sender?.name || '',
          senderAddress: detailObj.sender?.address || detailObj.sender?.city || '',
          recipient: detailObj.actualReceiver || detailObj.receiver?.name || '',
          recipientAddress: detailObj.receiver?.address || detailObj.receiver?.city || '',
          deliveredDate: detailObj.deliveredDate || '',
          estimatedTimeArrival: detailObj.estimatedTimeArrival || '',
        },
        detail: {
          service: detailObj.serviceCode || detailObj.service_code || 'Anteraja',
          shipper: detailObj.sender?.name || '',
          receiver: detailObj.actualReceiver || detailObj.receiver?.name || '',
          weight: detailObj.weight ? `${detailObj.weight} g` : '',
          actualAmount: detailObj.actualAmount || 0,
          invoice: detailObj.invoice || '',
        },
        history: history,
      };
    } catch (err) {
      return {
        success: false,
        courier: this.name,
        waybillNumber: resi,
        status: 'RESOLVER_ERROR',
        message: `Terjadi kesalahan saat memproses tracking Anteraja: ${err.message}`,
      };
    }
  }
}

export const anterajaResolver = new AnterajaResolver();
