import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseCourierResolver } from './base.js';
import { parseLocationQuery } from '../utils/locationParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * J&T Express Tracking & Shipping Cost Resolver
 * Direct integration with https://jet.co.id router API (query/findTrack, query/findRate, query/findProCityArea)
 */
export class JNTResolver extends BaseCourierResolver {
  constructor() {
    super('J&T Express', 'jnt');
    this.baseUrl = 'https://www.jet.co.id';
    this.routerUrl = 'https://www.jet.co.id/index/router/index.html';
    this.trackPageUrl = 'https://www.jet.co.id/track';
    this.ratesPageUrl = 'https://www.jet.co.id/rates';
    this.defaultUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    // In-memory cookies & security tokens
    this.cookies = new Map();
    this.murmur = crypto.randomBytes(16).toString('hex');
    this.pst = crypto.createHash('md5').update(this.murmur + 'j&t2020app!@#').digest('hex');

    // Area data cache
    this._cachedAreas = null;
  }

  /**
   * Save cookies from HTTP response
   * @private
   */
  _saveCookies(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    if (raw) {
      for (const item of raw) {
        if (!item) continue;
        const part = item.split(';')[0];
        const [k, ...v] = part.split('=');
        if (k && v) {
          this.cookies.set(k.trim(), v.join('=').trim());
        }
      }
    }
  }

  /**
   * Get formatted Cookie header string
   * @private
   */
  _getCookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /**
   * Initialize web session to obtain Huawei WAF & PHP session cookies
   * @private
   * @param {'track' | 'rates'} [page='rates']
   */
  async _ensureSession(page = 'rates') {
    if (this.cookies.has('PHPSESSID') && this.cookies.has('HWWAFSESID')) {
      return;
    }

    const url = page === 'track' ? this.trackPageUrl : this.ratesPageUrl;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': this.defaultUserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    this._saveCookies(res);
  }

  /**
   * Invoke J&T backend router endpoint
   * @private
   * @param {string} method - J&T router method e.g. 'query/findRate'
   * @param {object|string} [data='']
   * @param {string} [referer]
   * @returns {Promise<any>}
   */
  async _invokeRouter(method, data = '', referer = this.ratesPageUrl) {
    await this._ensureSession(referer.includes('track') ? 'track' : 'rates');

    const params = new URLSearchParams();
    params.append('method', method);
    params.append('pId', this.murmur);
    params.append('pst', this.pst);

    if (typeof data === 'object' && data !== null) {
      for (const [k, v] of Object.entries(data)) {
        params.append(`data[${k}]`, v !== undefined && v !== null ? v : '');
      }
    } else {
      params.append('data', data || '');
    }

    const res = await fetch(this.routerUrl, {
      method: 'POST',
      headers: {
        'User-Agent': this.defaultUserAgent,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.baseUrl,
        'Referer': referer,
        'Cookie': this._getCookieHeader(),
        'X-SimplyPost-Id': this.murmur,
        'X-SimplyPost-Signature': this.pst,
      },
      body: params.toString(),
    });

    this._saveCookies(res);

    if (!res.ok) {
      throw new Error(`J&T router API returned HTTP ${res.status}`);
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed);
      }
      if (typeof parsed.data === 'string') {
        try {
          parsed.data = JSON.parse(parsed.data);
        } catch (_) {}
      }
    } catch (e) {
      throw new Error(`Invalid JSON response from J&T: ${text.slice(0, 100)}`);
    }

    return parsed;
  }

  /**
   * Load all J&T province, city, and district areas (cached)
   * @private
   * @returns {Promise<Array<object>>}
   */
  async _getAreas() {
    if (this._cachedAreas && this._cachedAreas.length > 0) {
      return this._cachedAreas;
    }

    // Try loading from local data file
    const candidates = [
      // OpenOngkir: jalur disesuaikan ke layout vendored (src/openresi/data/).
      path.resolve(__dirname, '../data/jnt-areas.json'),
      path.join(process.cwd(), 'data/jnt-areas.json'),
    ];
    for (const dataPath of candidates) {
      if (fs.existsSync(dataPath)) {
        try {
          const raw = fs.readFileSync(dataPath, 'utf8');
          this._cachedAreas = JSON.parse(raw);
          if (Array.isArray(this._cachedAreas) && this._cachedAreas.length > 0) {
            return this._cachedAreas;
          }
        } catch (_) {}
      }
    }

    // Fetch from live router
    const res = await this._invokeRouter('query/findProCityArea', '');
    const list = Array.isArray(res.data) ? res.data : [];
    if (list.length > 0) {
      this._cachedAreas = list;
      try {
        const dir = path.dirname(dataPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dataPath, JSON.stringify(list));
      } catch (_) {}
    }

    return this._cachedAreas || [];
  }

  /**
   * Validate J&T waybill format
   * J&T waybills follow patterns:
   * - 12 digits starting with 888, 666, 555
   * - J followed by letter and 10 digits (e.g. JP0123456789, JX0123456789)
   * - 10 digits starting with 1
   * - F or LY followed by 8 digits
   * @param {string} waybill
   * @returns {boolean}
   */
  isValidWaybillFormat(waybill) {
    if (!waybill || typeof waybill !== 'string') return false;
    const clean = waybill.trim().toUpperCase();
    return /^(888|666|555)[\d]{9}$|^(J)[A-Z]{1}[\d]{10}$|^(1)[\d]{9}$|^(F|LY)[\d]{8}$/i.test(clean);
  }

  /**
   * Track waybill on J&T Express
   * @param {string} waybillNumber - Nomor resi J&T (e.g. "JP1234567890")
   * @param {object} [options]
   * @param {string} [options.phone] - 4 digit terakhir nomor telepon pengirim/penerima
   * @param {string} [options.last4Phone] - Alias for phone
   * @returns {Promise<object>} Standardized tracking object
   */
  async track(waybillNumber, options = {}) {
    const resi = this.sanitizeWaybill(waybillNumber).toUpperCase();
    if (!resi) {
      return {
        success: false,
        courier: this.name,
        waybillNumber: '',
        status: 'INVALID_INPUT',
        message: 'Nomor resi tidak boleh kosong.',
      };
    }

    const phone = (options.phone || options.last4Phone || '').toString().trim();

    // Query findTrack with type fallback (1 -> 2 -> 3) like the official web client
    let trackData = null;
    let lastResponse = null;

    for (let type = 1; type <= 3; type++) {
      const response = await this._invokeRouter(
        'query/findTrack',
        {
          billcode: resi,
          lang: 'id',
          source: 3,
          phone: phone,
          type: type,
        },
        this.trackPageUrl
      );

      lastResponse = response;

      // Handle Phone Verification Required / Failed
      if (response.code === 8022) {
        return {
          success: false,
          courier: this.name,
          waybillNumber: resi,
          verified: false,
          status: 'AWAITING_PHONE_VERIFICATION',
          requiresPhoneVerification: true,
          message:
            'Sesuai kebijakan perlindungan privasi J&T Express, masukkan 4 digit terakhir nomor HP pengirim atau penerima (gunakan opsi --phone <4_digit> atau query ?phone=XXXX).',
        };
      }

      // Handle Not Found / Wrong Number
      if (response.code === 8023) {
        return {
          success: false,
          courier: this.name,
          waybillNumber: resi,
          status: 'NOT_FOUND',
          message: `Nomor resi "${resi}" tidak ditemukan di sistem J&T Express. Pastikan nomor resi sudah benar.`,
        };
      }

      const list = Array.isArray(response)
        ? response
        : Array.isArray(response.data)
        ? response.data
        : null;

      if (list && list.length > 0 && list[0].details && list[0].details.length > 0) {
        trackData = list[0];
        break;
      }
    }

    if (!trackData || !trackData.details || trackData.details.length === 0) {
      return {
        success: false,
        courier: this.name,
        waybillNumber: resi,
        status: 'NOT_FOUND',
        message:
          lastResponse?.desc ||
          `Nomor resi "${resi}" tidak ditemukan atau belum ada update pergerakan paket.`,
      };
    }

    // Parse and Standardize Checkpoints
    const rawDetails = trackData.details;
    const history = rawDetails.map((item) => {
      const scanStatus = item.status || item.scanstatus || '';
      const site = item.scanNetworkName || item.siteName || '';
      const signer = item.staffName || item.signer || '';
      const nextSite = item.nextSite || '';
      const trackingText = item.customerTracking || '';

      let description = trackingText;
      if (!description) {
        if (site && nextSite) {
          description = `${scanStatus} dari ${site} menuju ${nextSite}`;
        } else if (site) {
          description = `${scanStatus} di ${site}`;
        } else {
          description = scanStatus;
        }
      }

      return {
        dateTime: item.scanTime || '',
        location: site || nextSite || '',
        status: scanStatus,
        description: description,
        actor: signer || item.deliveryName || '',
        code: item.code || '',
      };
    });

    // Determine Final Status
    const latestEvent = history[0] || {};
    let standardizedStatus = 'ON_PROCESS';
    const latestCode = (latestEvent.code || '').toString();
    const latestText = (latestEvent.status + ' ' + latestEvent.description).toUpperCase();

    if (latestCode === '100' || latestText.includes('DELIVERED') || latestText.includes('TERKIRIM') || latestText.includes('DITERIMA')) {
      standardizedStatus = 'DELIVERED';
    } else if (latestCode === '94' || latestText.includes('SEDANG DIANTAR') || latestText.includes('ON DELIVERY')) {
      standardizedStatus = 'ON_DELIVERY';
    } else if (latestText.includes('RETURN') || latestText.includes('RETUR')) {
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
        service: trackData.serviceType || 'J&T Express',
        status: latestEvent.status || standardizedStatus,
        lastLocation: latestEvent.location || '',
        recipient: latestEvent.actor || trackData.signer || '',
        latestUpdate: latestEvent.dateTime || '',
      },
      history: history,
    };
  }

  /**
   * Search origin locations for J&T
   * @param {string} query - Keyword e.g. "Jakarta"
   * @returns {Promise<Array<{ code: string, label: string, city: string, province: string }>>}
   */
  async searchOrigins(query) {
    const q = (query || '').trim().toLowerCase();
    if (q.length < 2) return [];

    const areas = await this._getAreas();
    const cityMap = new Map();

    for (const a of areas) {
      const city = a.city || '';
      const prov = a.province || '';
      const county = a.countyarea || '';

      if (
        city.toLowerCase().includes(q) ||
        prov.toLowerCase().includes(q) ||
        county.toLowerCase().includes(q)
      ) {
        const key = `${city}|${prov}`;
        if (!cityMap.has(key)) {
          cityMap.set(key, {
            code: city,
            label: `${city}, ${prov}`,
            city: city,
            province: prov,
          });
        }
      }
    }

    return Array.from(cityMap.values()).slice(0, 50);
  }

  /**
   * Search destination locations for J&T
   * J&T requires destination at the countyarea (kecamatan) level for rates calculation.
   * @param {string} query - Keyword e.g. "Gubeng" or "Surabaya"
   * @returns {Promise<Array<{ code: string, label: string, district: string, city: string, province: string }>>}
   */
  async searchDestinations(query) {
    const q = (query || '').trim().toLowerCase();
    if (q.length < 2) return [];

    const areas = await this._getAreas();
    const results = [];

    for (const a of areas) {
      const county = a.countyarea || '';
      const city = a.city || '';
      const prov = a.province || '';

      if (
        county.toLowerCase().includes(q) ||
        city.toLowerCase().includes(q) ||
        prov.toLowerCase().includes(q)
      ) {
        results.push({
          code: county,
          label: `${county}, ${city}, ${prov}`,
          district: county,
          city: city,
          province: prov,
        });
        if (results.length >= 60) break;
      }
    }

    return results;
  }

  /**
   * Calculate shipping fee (Cek Ongkir) for J&T Express
   * @param {object} params
   * @param {string} params.origin - Origin city (e.g. "Jakarta", "Surabaya")
   * @param {string} params.destination - Destination district/city (e.g. "Gubeng", "Surabaya", "Cengkareng")
   * @param {number|string} [params.weight=1] - Weight in kg (defaults to 1)
   * @returns {Promise<object>} Standardized rates result
   */
  async calculateCost(params = {}) {
    const rawOrigin = (params.origin || '').trim();
    const rawDest = (params.destination || '').trim();
    const weight = Math.max(0.1, parseFloat(params.weight || 1));

    if (!rawOrigin || !rawDest) {
      return {
        success: false,
        courier: this.name,
        error: 'Kota/wilayah asal (origin) dan tujuan (destination) wajib diisi.',
      };
    }

    const areas = await this._getAreas();
    const parsedOrigin = parseLocationQuery(rawOrigin);
    const parsedDest = parseLocationQuery(rawDest);

    // 1. Resolve Origin City (J&T uses City level for origin, e.g. 'JAKARTA', 'SURABAYA', 'BANDUNG')
    let resolvedOriginCity = '';
    let originLabel = '';

    for (const q of parsedOrigin.originQueries) {
      const qLower = q.toLowerCase();
      // Exact city match
      const exactCity = areas.find((a) => a.city.toLowerCase() === qLower);
      if (exactCity) {
        resolvedOriginCity = exactCity.city;
        originLabel = `${exactCity.city}, ${exactCity.province}`;
        break;
      }
      // Partial city match
      const partCity = areas.find((a) => a.city.toLowerCase().includes(qLower));
      if (partCity) {
        resolvedOriginCity = partCity.city;
        originLabel = `${partCity.city}, ${partCity.province}`;
        break;
      }
      // District match fallback to its city
      const partCounty = areas.find((a) => a.countyarea.toLowerCase().includes(qLower));
      if (partCounty) {
        resolvedOriginCity = partCounty.city;
        originLabel = `${partCounty.city}, ${partCounty.province}`;
        break;
      }
    }

    if (!resolvedOriginCity) {
      return {
        success: false,
        courier: this.name,
        error: `Kota asal "${rawOrigin}" tidak ditemukan di database wilayah J&T. Coba gunakan nama kota utama (contoh: Jakarta, Surabaya, Bandung).`,
      };
    }

    // 2. Resolve Destination District (J&T uses countyarea / kecamatan for destination)
    let resolvedDestCounty = '';
    let destLabel = '';

    for (const q of parsedDest.destinationQueries) {
      const qLower = q.toLowerCase();
      // Search matching countyareas
      const matches = areas.filter(
        (a) =>
          a.countyarea.toLowerCase().includes(qLower) ||
          a.city.toLowerCase().includes(qLower)
      );

      if (matches.length > 0) {
        const ranked = parsedDest.rankMatches(matches, {
          getDistrict: (a) => a.countyarea,
          getCity: (a) => a.city,
          getLabel: (a) => `${a.countyarea}, ${a.city}, ${a.province}`,
        });
        resolvedDestCounty = ranked[0].countyarea;
        destLabel = `${ranked[0].countyarea}, ${ranked[0].city}, ${ranked[0].province}`;
        break;
      }
    }

    if (!resolvedDestCounty) {
      return {
        success: false,
        courier: this.name,
        error: `Wilayah tujuan "${rawDest}" tidak ditemukan di database wilayah J&T. Masukkan nama kecamatan atau kota.`,
      };
    }

    // 3. Query J&T Router query/findRate
    const response = await this._invokeRouter('query/findRate', {
      senderAddr: resolvedOriginCity,
      receiverAddr: resolvedDestCounty,
      weight: weight,
    });

    if (response.code !== 20000 || !Array.isArray(response.data) || response.data.length === 0) {
      return {
        success: false,
        courier: this.name,
        error:
          response.desc ||
          `Tarif pengiriman tidak tersedia untuk rute ${resolvedOriginCity} ke ${resolvedDestCounty}.`,
      };
    }

    // Service descriptions mapping
    const serviceMeta = {
      EZ: {
        name: 'J&T Regular (EZ)',
        etd: '2-3 hari',
        desc: 'Layanan Pengiriman Reguler J&T Express ke seluruh Indonesia',
      },
      ECO: {
        name: 'J&T Economy (ECO)',
        etd: '3-5 hari',
        desc: 'Layanan Pengiriman Ekonomis untuk paket lebih hemat',
      },
      DOC: {
        name: 'J&T Document (DOC)',
        etd: '2-3 hari',
        desc: 'Layanan Pengiriman Khusus Dokumen & Surat',
      },
      SUPER: {
        name: 'J&T Super',
        etd: '1 hari',
        desc: 'Layanan Pengiriman Kilat Next Day / Same Day',
      },
      JSD: {
        name: 'J&T Same Day (JSD)',
        etd: 'Hari yang sama',
        desc: 'Layanan Pengiriman Tiba di Hari yang Sama',
      },
    };

    const currencyFmt = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

    const services = response.data.map((item) => {
      const code = (item.serviceType || item.serviceCode || '').toUpperCase();
      const meta = serviceMeta[code] || {
        name: `J&T ${code}`,
        etd: '-',
        desc: `Layanan Pengiriman ${code} J&T Express`,
      };

      const baseFee = parseFloat(item.serviceFees || 0);
      const otherFee = parseFloat(item.otherFees || 0);
      const totalFee = baseFee + otherFee;

      return {
        service: code,
        type: code,
        name: meta.name,
        cost: totalFee,
        formattedCost: currencyFmt.format(totalFee),
        etd: meta.etd,
        description: meta.desc,
      };
    });

    return {
      success: true,
      courier: this.name,
      origin: {
        code: resolvedOriginCity,
        city: resolvedOriginCity,
        label: originLabel,
      },
      destination: {
        code: resolvedDestCounty,
        district: resolvedDestCounty,
        label: destLabel,
      },
      weight: `${weight} kg`,
      services: services,
    };
  }
}

export const jntResolver = new JNTResolver();
