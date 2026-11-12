/**
 * Smart Location Query Parser for Indonesian Courier Logistics
 * 
 * Handles various user input formats such as:
 * - "Coblong, Bandung" (Kecamatan, Kota)
 * - "Tegalsari, Surabaya (60261)" (Kecamatan, Kota + Kode Pos)
 * - "Kecamatan Sukaraja, Kab. Bogor, Jawa Barat" (Prefixes + Province)
 * - "Jakarta Selatan" (Pure City/Regency)
 * - "40132" (5-digit Postal Code)
 */

const KNOWN_PROVINCES = [
  'aceh', 'sumatera utara', 'sumatera barat', 'riau', 'kepulauan riau', 'jambi',
  'sumatera selatan', 'kepulauan bangka belitung', 'bengkulu', 'lampung',
  'dki jakarta', 'jakarta', 'jawa barat', 'banten', 'jawa tengah', 'di yogyakarta',
  'yogyakarta', 'jawa timur', 'bali', 'nusa tenggara barat', 'nusa tenggara timur',
  'kalimantan barat', 'kalimantan tengah', 'kalimantan selatan', 'kalimantan timur',
  'kalimantan utara', 'sulawesi utara', 'gorontalo', 'sulawesi tengah',
  'sulawesi barat', 'sulawesi selatan', 'sulawesi tenggara', 'maluku',
  'maluku utara', 'papua barat', 'papua', 'papua selatan', 'papua tengah',
  'papua pegunungan', 'papua barat daya',
];

/**
 * Remove administrative prefixes like 'Kecamatan', 'Kota', 'Kabupaten', etc.
 * @param {string} str
 * @returns {string}
 */
export function cleanAdminPrefix(str) {
  if (!str) return '';
  return str
    .replace(/^(kecamatan|kec\.?|kelurahan|kel\.?|desa|ds\.?)\s+/i, '')
    .replace(/^(kota\s+administrasi|kota\s+adm\.?|kota|kabupaten|kab\.?)\s+/i, '')
    .trim();
}

/**
 * Parse a location string into structured components and query priorities
 * @param {string} input
 * @returns {object}
 */
export function parseLocationQuery(input) {
  if (!input || typeof input !== 'string') {
    return {
      raw: '',
      clean: '',
      postalCode: null,
      district: '',
      city: '',
      province: '',
      originQueries: [],
      destinationQueries: [],
      rankMatches: () => [],
      findBestMatch: async () => null,
    };
  }

  const raw = input.trim();

  // 1. Extract 5-digit postal code if present
  let postalCode = null;
  const zipMatch = raw.match(/\b([1-9]\d{4})\b/);
  if (zipMatch) {
    postalCode = zipMatch[1];
  }

  // Remove postal code and extra parentheses for text parsing
  let text = raw.replace(/\(?\b[1-9]\d{4}\b\)?/g, '').replace(/[()]/g, ' ').trim();

  // Split by comma, slash, or hyphen delimiter
  const parts = text
    .split(/[,/]/)
    .map((p) => p.trim())
    .filter(Boolean);

  let district = '';
  let city = '';
  let province = '';

  if (parts.length === 1) {
    const single = parts[0];
    const cleaned = cleanAdminPrefix(single);
    district = cleaned;
    city = cleaned;
  } else if (parts.length === 2) {
    const part0 = parts[0];
    const part1 = parts[1];
    const lower1 = part1.toLowerCase();

    // Check if second part is a province
    if (KNOWN_PROVINCES.includes(lower1)) {
      city = cleanAdminPrefix(part0);
      province = part1;
      district = city;
    } else {
      district = cleanAdminPrefix(part0);
      city = cleanAdminPrefix(part1);
    }
  } else if (parts.length >= 3) {
    district = cleanAdminPrefix(parts[0]);
    city = cleanAdminPrefix(parts[1]);
    province = cleanAdminPrefix(parts[2]);
  }

  const cleanRaw = cleanAdminPrefix(text).replace(/\s+/g, ' ').trim();

  // 2. Build prioritized search query list
  // Extract base city if city is directional subdivision (e.g. "Jakarta Pusat" -> "Jakarta")
  let baseCity = '';
  const directionalMatch = city.match(/^(.+?)\s+(pusat|selatan|barat|utara|timur)$/i);
  if (directionalMatch) {
    baseCity = directionalMatch[1].trim();
  }

  // For origin: couriers (JNE, SiCepat, J&T, TIKI) prioritize City level
  const originQueries = [];
  if (city && !originQueries.includes(city)) originQueries.push(city);
  if (baseCity && !originQueries.includes(baseCity)) originQueries.push(baseCity);
  if (cleanRaw && !originQueries.includes(cleanRaw)) originQueries.push(cleanRaw);
  if (district && !originQueries.includes(district)) originQueries.push(district);
  if (postalCode && !originQueries.includes(postalCode)) originQueries.push(postalCode);

  // For destination: couriers prioritize District / Sub-district level
  const destinationQueries = [];
  if (district && !destinationQueries.includes(district)) destinationQueries.push(district);
  if (city && !destinationQueries.includes(city)) destinationQueries.push(city);
  if (baseCity && !destinationQueries.includes(baseCity)) destinationQueries.push(baseCity);
  if (cleanRaw && !destinationQueries.includes(cleanRaw)) destinationQueries.push(cleanRaw);
  if (postalCode && !destinationQueries.includes(postalCode)) destinationQueries.push(postalCode);

  /**
   * Smart ranking for courier search results based on city / district context
   * @param {Array<object>} items
   * @param {object} [fieldGetters]
   * @returns {Array<object>}
   */
  const rankMatches = (items = [], fieldGetters = {}) => {
    if (!Array.isArray(items) || items.length <= 1) return items;

    const getLabel = fieldGetters.getLabel || ((it) => it.label || it.name || it.area || '');
    const getCity = fieldGetters.getCity || ((it) => it.city || it.city_name || '');
    const getDistrict = fieldGetters.getDistrict || ((it) => it.district || it.subdistrict || it.district_name || it.countyarea || '');
    const getPostcode = fieldGetters.getPostcode || ((it) => it.postalCode || it.zipcode || '');

    const targetCityLower = city.toLowerCase();
    const targetDistrictLower = district.toLowerCase();
    const targetProvLower = province.toLowerCase();

    return [...items].sort((a, b) => {
      const labelA = String(getLabel(a)).toLowerCase();
      const labelB = String(getLabel(b)).toLowerCase();

      const cityA = String(getCity(a)).toLowerCase();
      const cityB = String(getCity(b)).toLowerCase();

      const distA = String(getDistrict(a)).toLowerCase();
      const distB = String(getDistrict(b)).toLowerCase();

      // Postal code match priority
      if (postalCode) {
        const postA = String(getPostcode(a));
        const postB = String(getPostcode(b));
        if (postA === postalCode && postB !== postalCode) return -1;
        if (postA !== postalCode && postB === postalCode) return 1;
      }

      let scoreA = 0;
      let scoreB = 0;

      // Both district and city match target
      if (targetDistrictLower && targetCityLower && targetDistrictLower !== targetCityLower) {
        const aHasDist = distA.includes(targetDistrictLower) || labelA.includes(targetDistrictLower);
        const aHasCity = cityA.includes(targetCityLower) || labelA.includes(targetCityLower);
        if (aHasDist && aHasCity) scoreA += 100;

        const bHasDist = distB.includes(targetDistrictLower) || labelB.includes(targetDistrictLower);
        const bHasCity = cityB.includes(targetCityLower) || labelB.includes(targetCityLower);
        if (bHasDist && bHasCity) scoreB += 100;
      }

      // City match score
      if (targetCityLower) {
        if (cityA.includes(targetCityLower) || labelA.includes(targetCityLower)) scoreA += 40;
        if (cityB.includes(targetCityLower) || labelB.includes(targetCityLower)) scoreB += 40;
      }

      // District match score
      if (targetDistrictLower) {
        if (distA.includes(targetDistrictLower) || labelA.includes(targetDistrictLower)) scoreA += 30;
        if (distB.includes(targetDistrictLower) || labelB.includes(targetDistrictLower)) scoreB += 30;
      }

      // Province match score
      if (targetProvLower) {
        if (labelA.includes(targetProvLower)) scoreA += 20;
        if (labelB.includes(targetProvLower)) scoreB += 20;
      }

      return scoreB - scoreA;
    });
  };

  /**
   * Iterate over candidate search queries, test city context, and return the best item
   * @param {Function} searchFn
   * @param {Array<string>} [queries]
   * @param {object} [fieldGetters]
   * @returns {Promise<object|null>}
   */
  const findBestMatch = async (searchFn, queries = destinationQueries, fieldGetters = {}) => {
    let fallback = [];
    const getLabel = fieldGetters.getLabel || ((it) => it.label || it.name || it.area || '');
    const getCity = fieldGetters.getCity || ((it) => it.city || it.city_name || '');
    const targetCityLower = city.toLowerCase();

    for (const q of queries) {
      let items = [];
      try {
        items = await searchFn(q);
      } catch (_) {
        items = [];
      }
      if (Array.isArray(items) && items.length > 0) {
        if (targetCityLower) {
          const hasCityMatch = items.some((it) => {
            const l = String(getLabel(it)).toLowerCase();
            const c = String(getCity(it)).toLowerCase();
            return l.includes(targetCityLower) || c.includes(targetCityLower);
          });
          if (hasCityMatch) {
            const ranked = rankMatches(items, fieldGetters);
            return ranked[0];
          }
          if (fallback.length === 0) fallback = items;
        } else {
          const ranked = rankMatches(items, fieldGetters);
          return ranked[0];
        }
      }
    }

    if (fallback.length > 0) {
      const ranked = rankMatches(fallback, fieldGetters);
      return ranked[0];
    }
    return null;
  };

  return {
    raw,
    clean: cleanRaw,
    postalCode,
    district,
    city,
    province,
    originQueries,
    destinationQueries,
    rankMatches,
    findBestMatch,
  };
}
