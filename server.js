/**
 * ============================================================================
 * AMBIANT SCAN — Zero-Dependency Environmental Scraper & Modeler
 * Part of The Governor HQ Suite
 * ============================================================================
 * 
 * Single-file Node.js server. No npm install needed.
 * 
 * Free data sources used:
 *   - Open-Meteo API (weather, UV, air quality) — no key required
 *   - BigDataCloud (reverse geocoding) — no key required
 * 
 * Usage:
 *   node server.js
 * 
 * Endpoints:
 *   GET /scan?lat=45.5&lon=-73.6          → full environmental scan
 *   GET /scan?city=Montreal                → scan by city name
 *   GET /health                            → health check
 *   GET /geoip                             → caller geolocation via IP
 *   GET /cache/stats                       → cache statistics
 *   DELETE /cache                          → flush all caches
 * 
 * Environment variables (optional):
 *   PORT                  — server port (default: 3400)
 *   CACHE_TTL_SECONDS     — data cache TTL (default: 600 = 10min)
 *   GEO_CACHE_TTL_SECONDS — geocoding cache TTL (default: 86400 = 24h)
 *   MAX_CACHE_ENTRIES     — max entries per cache (default: 5000)
 * ============================================================================
 */

const http = require('http');
const https = require('https');
const url = require('url');

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3400', 10);
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '600', 10) * 1000;
const GEO_CACHE_TTL = parseInt(process.env.GEO_CACHE_TTL_SECONDS || '86400', 10) * 1000;
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '5000', 10);

// ─── In-Memory Cache with TTL & LRU eviction ───────────────────────────────

class TTLCache {
  constructor(name, ttl, maxEntries) {
    this.name = name;
    this.ttl = ttl;
    this.maxEntries = maxEntries;
    this.store = new Map();       // key → { data, expiresAt }
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }
    // Move to end for LRU behavior (Map preserves insertion order)
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.data;
  }

  set(key, data) {
    // Evict oldest if at capacity
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
      this.evictions++;
    }
    this.store.set(key, {
      data,
      expiresAt: Date.now() + this.ttl
    });
  }

  flush() {
    const size = this.store.size;
    this.store.clear();
    return size;
  }

  stats() {
    // Purge expired entries for accurate count
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
    return {
      name: this.name,
      entries: this.store.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: (this.hits + this.misses) > 0
        ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(1) + '%'
        : 'N/A',
      ttlSeconds: this.ttl / 1000,
      maxEntries: this.maxEntries
    };
  }
}

// Initialize caches
const geoCache = new TTLCache('geo-reverse', GEO_CACHE_TTL, MAX_CACHE_ENTRIES);
const cityResolveCache = new TTLCache('city-forward', GEO_CACHE_TTL, MAX_CACHE_ENTRIES);
const dataCache = new TTLCache('environmental-data', CACHE_TTL, MAX_CACHE_ENTRIES);
const geoipCache = new TTLCache('geoip', GEO_CACHE_TTL, MAX_CACHE_ENTRIES);

// ─── HTTP Fetch Helper (zero deps) ─────────────────────────────────────────

function fetch(targetUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const driver = parsedUrl.protocol === 'https:' ? https : http;

    const req = driver.get(targetUrl, {
      headers: {
        'User-Agent': 'AmbiantScan/1.0 (TheGovernorHQ)',
        'Accept': 'application/json'
      },
      timeout: timeoutMs
    }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }

      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    });
  });
}

// ─── Geo Utilities ──────────────────────────────────────────────────────────

/**
 * Round coordinates to ~1.1km precision grid for cache key grouping.
 * This means nearby requests share cache entries.
 */
function roundCoords(lat, lon) {
  return {
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100
  };
}

function coordsKey(lat, lon) {
  const r = roundCoords(lat, lon);
  return `${r.lat},${r.lon}`;
}

/**
 * Reverse geocode: GPS → city/locality info.
 * Uses BigDataCloud free API (no key needed).
 */
async function reverseGeocode(lat, lon) {
  const key = coordsKey(lat, lon);
  const cached = geoCache.get(key);
  if (cached) return cached;

  const r = roundCoords(lat, lon);
  const apiUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${r.lat}&longitude=${r.lon}&localityLanguage=en`;

  try {
    const data = await fetch(apiUrl);
    const result = {
      city: data.city || data.locality || data.principalSubdivision || 'Unknown',
      region: data.principalSubdivision || '',
      country: data.countryName || '',
      countryCode: data.countryCode || '',
      lat: r.lat,
      lon: r.lon
    };
    geoCache.set(key, result);
    return result;
  } catch (err) {
    // Fallback: return coords-based location
    return {
      city: `Location (${r.lat}, ${r.lon})`,
      region: '',
      country: '',
      countryCode: '',
      lat: r.lat,
      lon: r.lon
    };
  }
}

/**
 * Forward geocode: city name → coordinates.
 * Uses Open-Meteo geocoding API (no key needed).
 */
async function forwardGeocode(cityName) {
  const key = cityName.toLowerCase().trim();
  const cached = cityResolveCache.get(key);
  if (cached) return cached;

  const apiUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`;
  const data = await fetch(apiUrl);

  if (!data.results || data.results.length === 0) {
    throw new Error(`City not found: "${cityName}"`);
  }

  const r = data.results[0];
  const result = {
    city: r.name,
    region: r.admin1 || '',
    country: r.country || '',
    countryCode: r.country_code || '',
    lat: Math.round(r.latitude * 100) / 100,
    lon: Math.round(r.longitude * 100) / 100
  };
  cityResolveCache.set(key, result);
  return result;
}

// ─── Environmental Data Fetchers ────────────────────────────────────────────

/**
 * Fetch weather data from Open-Meteo (free, no API key).
 * Returns current conditions + hourly forecast for today.
 */
async function fetchWeather(lat, lon) {
  const apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day`
    + `&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max`
    + `&timezone=auto`
    + `&forecast_days=1`;

  return fetch(apiUrl);
}

/**
 * Fetch air quality data from Open-Meteo (free, no API key).
 * Includes AQI, PM2.5, PM10, NO2, O3, SO2, CO.
 */
async function fetchAirQuality(lat, lon) {
  const apiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}`
    + `&current=us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,dust,uv_index,uv_index_clear_sky`
    + `&timezone=auto`;

  return fetch(apiUrl);
}

// ─── Data Modeling / Normalization ──────────────────────────────────────────

const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Heavy freezing rain',
  71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail'
};

function aqiLevel(aqi) {
  if (aqi == null) return { level: 'unknown', concern: 'No data available' };
  if (aqi <= 50) return { level: 'good', concern: 'Air quality is satisfactory' };
  if (aqi <= 100) return { level: 'moderate', concern: 'Acceptable; moderate concern for sensitive individuals' };
  if (aqi <= 150) return { level: 'unhealthy_sensitive', concern: 'Sensitive groups may experience health effects' };
  if (aqi <= 200) return { level: 'unhealthy', concern: 'Everyone may begin to experience health effects' };
  if (aqi <= 300) return { level: 'very_unhealthy', concern: 'Health alert: everyone may experience serious effects' };
  return { level: 'hazardous', concern: 'Health warning of emergency conditions' };
}

function uvLevel(uvi) {
  if (uvi == null) return { level: 'unknown', concern: 'No data available' };
  if (uvi <= 2) return { level: 'low', concern: 'No protection needed' };
  if (uvi <= 5) return { level: 'moderate', concern: 'Seek shade during midday' };
  if (uvi <= 7) return { level: 'high', concern: 'Reduce sun exposure between 10am-4pm' };
  if (uvi <= 10) return { level: 'very_high', concern: 'Extra protection needed; avoid being outside during midday' };
  return { level: 'extreme', concern: 'Take all precautions; unprotected skin can burn in minutes' };
}

function windDescription(speedKmh) {
  if (speedKmh == null) return 'unknown';
  if (speedKmh < 1) return 'calm';
  if (speedKmh < 6) return 'light air';
  if (speedKmh < 12) return 'light breeze';
  if (speedKmh < 20) return 'gentle breeze';
  if (speedKmh < 29) return 'moderate breeze';
  if (speedKmh < 39) return 'fresh breeze';
  if (speedKmh < 50) return 'strong breeze';
  if (speedKmh < 62) return 'high wind';
  if (speedKmh < 75) return 'gale';
  if (speedKmh < 89) return 'strong gale';
  if (speedKmh < 103) return 'storm';
  if (speedKmh < 118) return 'violent storm';
  return 'hurricane';
}

function windDirectionLabel(degrees) {
  if (degrees == null) return 'unknown';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(degrees / 22.5) % 16];
}

/**
 * Compose the full environmental scan result from raw API responses.
 */
function modelEnvironmentalData(location, weather, airQuality) {
  const w = weather?.current || {};
  const wUnits = weather?.current_units || {};
  const d = weather?.daily || {};
  const aq = airQuality?.current || {};
  const aqUnits = airQuality?.current_units || {};

  const uvIndex = aq.uv_index ?? null;
  const uvClearSky = aq.uv_index_clear_sky ?? null;
  const uvMax = d.uv_index_max?.[0] ?? uvIndex;

  return {
    meta: {
      source: 'ambiant-scan',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      location: {
        city: location.city,
        region: location.region,
        country: location.country,
        countryCode: location.countryCode,
        coordinates: { lat: location.lat, lon: location.lon }
      },
      timezone: weather?.timezone || null,
      elevation_m: weather?.elevation || null
    },

    temperature: {
      current_c: w.temperature_2m ?? null,
      feels_like_c: w.apparent_temperature ?? null,
      daily_high_c: d.temperature_2m_max?.[0] ?? null,
      daily_low_c: d.temperature_2m_min?.[0] ?? null,
      unit: wUnits.temperature_2m || '°C'
    },

    air_quality: {
      us_aqi: aq.us_aqi ?? null,
      ...aqiLevel(aq.us_aqi),
      pollutants: {
        pm2_5: { value: aq.pm2_5 ?? null, unit: aqUnits.pm2_5 || 'μg/m³' },
        pm10: { value: aq.pm10 ?? null, unit: aqUnits.pm10 || 'μg/m³' },
        nitrogen_dioxide: { value: aq.nitrogen_dioxide ?? null, unit: aqUnits.nitrogen_dioxide || 'μg/m³' },
        ozone: { value: aq.ozone ?? null, unit: aqUnits.ozone || 'μg/m³' },
        sulphur_dioxide: { value: aq.sulphur_dioxide ?? null, unit: aqUnits.sulphur_dioxide || 'μg/m³' },
        carbon_monoxide: { value: aq.carbon_monoxide ?? null, unit: aqUnits.carbon_monoxide || 'μg/m³' },
        dust: { value: aq.dust ?? null, unit: aqUnits.dust || 'μg/m³' }
      }
    },

    uv_index: {
      current: uvIndex,
      clear_sky: uvClearSky,
      daily_max: uvMax,
      ...uvLevel(uvIndex)
    },

    humidity: {
      relative_percent: w.relative_humidity_2m ?? null
    },

    wind: {
      speed_kmh: w.wind_speed_10m ?? null,
      gusts_kmh: w.wind_gusts_10m ?? null,
      direction_degrees: w.wind_direction_10m ?? null,
      direction_label: windDirectionLabel(w.wind_direction_10m),
      description: windDescription(w.wind_speed_10m),
      daily_max_kmh: d.wind_speed_10m_max?.[0] ?? null
    },

    atmosphere: {
      pressure_msl_hpa: w.pressure_msl ?? null,
      surface_pressure_hpa: w.surface_pressure ?? null,
      cloud_cover_percent: w.cloud_cover ?? null
    },

    precipitation: {
      current_mm: w.precipitation ?? null,
      rain_mm: w.rain ?? null,
      daily_sum_mm: d.precipitation_sum?.[0] ?? null,
      daily_probability_percent: d.precipitation_probability_max?.[0] ?? null
    },

    conditions: {
      weather_code: w.weather_code ?? null,
      description: WEATHER_CODES[w.weather_code] || 'Unknown',
      is_day: w.is_day === 1
    },

    sun: {
      sunrise: d.sunrise?.[0] || null,
      sunset: d.sunset?.[0] || null
    }
  };
}

// ─── Core Scan Logic ────────────────────────────────────────────────────────

async function performScan(lat, lon, location) {
  const cacheKey = coordsKey(lat, lon);

  // Check data cache first
  const cached = dataCache.get(cacheKey);
  if (cached) {
    cached.meta._cached = true;
    return cached;
  }

  // Fetch both in parallel
  const [weather, airQuality] = await Promise.all([
    fetchWeather(lat, lon).catch(err => {
      console.error(`[Weather fetch error] ${err.message}`);
      return null;
    }),
    fetchAirQuality(lat, lon).catch(err => {
      console.error(`[AirQuality fetch error] ${err.message}`);
      return null;
    })
  ]);

  if (!weather && !airQuality) {
    throw new Error('All environmental data sources are unavailable');
  }

  const result = modelEnvironmentalData(location, weather, airQuality);
  result.meta._cached = false;

  // Cache it
  dataCache.set(cacheKey, result);

  return result;
}

// ─── GeoIP Utilities ────────────────────────────────────────────────────────

/**
 * Extract the real client IP from the request.
 * Priority: Fly-Client-IP → X-Forwarded-For (first entry) → X-Real-IP → socket
 * Handles Fly.io, Cloudflare, nginx, and other reverse proxies.
 */
function getClientIP(req) {
  // Fly.io sets this to the true client IP
  const flyClientIP = req.headers['fly-client-ip'];
  if (flyClientIP) return flyClientIP.trim();

  // Standard proxy header — first entry is the original client
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }

  // Nginx-style header
  const realIP = req.headers['x-real-ip'];
  if (realIP) return realIP.trim();

  // Direct connection fallback
  const addr = req.socket?.remoteAddress || '';
  // Strip IPv6-mapped IPv4 prefix (::ffff:1.2.3.4 → 1.2.3.4)
  return addr.replace(/^::ffff:/, '');
}

/**
 * Determine if an IP is a private/localhost address.
 */
function isPrivateIP(ip) {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === 'localhost' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/**
 * Look up geolocation for an IP address using ip-api.com (free, no key).
 * Returns lat, lon, city, region, country, timezone, isp, etc.
 */
async function geoipLookup(ip) {
  const cached = geoipCache.get(ip);
  if (cached) return cached;

  // ip-api.com free tier: 45 req/min, HTTP only (HTTPS requires paid plan)
  const apiUrl = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`;

  const data = await fetch(apiUrl, 5000);

  if (data.status !== 'success') {
    throw new Error(data.message || 'GeoIP lookup failed');
  }

  const result = {
    ip: data.query,
    lat: data.lat,
    lon: data.lon,
    city: data.city || 'Unknown',
    region: data.regionName || '',
    regionCode: data.region || '',
    country: data.country || '',
    countryCode: data.countryCode || '',
    zip: data.zip || '',
    timezone: data.timezone || '',
    isp: data.isp || '',
    org: data.org || '',
    as: data.as || ''
  };

  geoipCache.set(ip, result);
  return result;
}

// ─── HTTP Server & Routing ──────────────────────────────────────────────────

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': statusCode === 200 ? `public, max-age=${Math.floor(CACHE_TTL / 1000)}` : 'no-cache',
    'X-Powered-By': 'Ambiant-Scan/1.0'
  });
  res.end(body);
}

function sendError(res, statusCode, message, details = null) {
  sendJSON(res, statusCode, {
    error: true,
    status: statusCode,
    message,
    ...(details ? { details } : {}),
    timestamp: new Date().toISOString()
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  const startTime = Date.now();

  try {
    // ── GET /health ──
    if (req.method === 'GET' && pathname === '/health') {
      return sendJSON(res, 200, {
        status: 'ok',
        service: 'ambiant-scan',
        version: '1.0.0',
        uptime_seconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
      });
    }

    // ── GET /geoip ──
    if (req.method === 'GET' && pathname === '/geoip') {
      const clientIP = getClientIP(req);

      if (!clientIP || isPrivateIP(clientIP)) {
        return sendJSON(res, 200, {
          warning: 'Private or localhost IP detected — geolocation unavailable',
          ip: clientIP || 'unknown',
          source: req.headers['fly-client-ip'] ? 'fly-client-ip' : 
                  req.headers['x-forwarded-for'] ? 'x-forwarded-for' : 
                  req.headers['x-real-ip'] ? 'x-real-ip' : 'socket',
          hint: 'Deploy behind a reverse proxy or on Fly.io for real client IPs',
          timestamp: new Date().toISOString()
        });
      }

      try {
        const geo = await geoipLookup(clientIP);
        return sendJSON(res, 200, {
          ...geo,
          source: req.headers['fly-client-ip'] ? 'fly-client-ip' : 
                  req.headers['x-forwarded-for'] ? 'x-forwarded-for' : 
                  req.headers['x-real-ip'] ? 'x-real-ip' : 'socket',
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        return sendError(res, 502, 'GeoIP lookup failed', err.message);
      }
    }

    // ── GET /cache/stats ──
    if (req.method === 'GET' && pathname === '/cache/stats') {
      return sendJSON(res, 200, {
        caches: [
          geoCache.stats(),
          cityResolveCache.stats(),
          dataCache.stats(),
          geoipCache.stats()
        ],
        timestamp: new Date().toISOString()
      });
    }

    // ── DELETE /cache ──
    if (req.method === 'DELETE' && pathname === '/cache') {
      const flushed = geoCache.flush() + cityResolveCache.flush() + dataCache.flush() + geoipCache.flush();
      return sendJSON(res, 200, {
        message: 'All caches flushed',
        flushedEntries: flushed,
        timestamp: new Date().toISOString()
      });
    }

    // ── GET /scan ──
    if (req.method === 'GET' && pathname === '/scan') {
      let lat, lon, location;

      if (query.city) {
        // City-based lookup
        try {
          location = await forwardGeocode(query.city);
          lat = location.lat;
          lon = location.lon;
        } catch (err) {
          return sendError(res, 404, err.message);
        }
      } else if (query.lat && query.lon) {
        // GPS-based lookup
        lat = parseFloat(query.lat);
        lon = parseFloat(query.lon);

        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          return sendError(res, 400, 'Invalid coordinates. lat must be -90..90, lon must be -180..180');
        }

        const rounded = roundCoords(lat, lon);
        lat = rounded.lat;
        lon = rounded.lon;

        // Reverse geocode for location metadata
        location = await reverseGeocode(lat, lon);
      } else {
        return sendError(res, 400, 'Missing parameters. Provide ?lat=XX&lon=YY or ?city=NAME', {
          examples: [
            '/scan?lat=45.50&lon=-73.57',
            '/scan?city=Montreal',
            '/scan?city=Tokyo'
          ]
        });
      }

      const result = await performScan(lat, lon, location);
      result.meta._responseTime_ms = Date.now() - startTime;

      return sendJSON(res, 200, result);
    }

    // ── 404 ──
    return sendError(res, 404, 'Not found', {
      available_endpoints: [
        'GET /scan?lat=XX&lon=YY',
        'GET /scan?city=NAME',
        'GET /geoip',
        'GET /health',
        'GET /cache/stats',
        'DELETE /cache'
      ]
    });

  } catch (err) {
    console.error(`[Error] ${req.method} ${req.url} — ${err.message}`);
    return sendError(res, 500, 'Internal server error', err.message);
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────────┐
  │         🌍  AMBIANT SCAN  v1.0.0            │
  │    Environmental Scraper & Modeler           │
  │    Part of The Governor HQ Suite             │
  ├─────────────────────────────────────────────┤
  │  Server:    http://localhost:${String(PORT).padEnd(18)}│
  │  Cache TTL: ${String(CACHE_TTL / 1000 + 's').padEnd(32)}│
  │  Geo TTL:   ${String(GEO_CACHE_TTL / 1000 + 's').padEnd(32)}│
  ├─────────────────────────────────────────────┤
  │  GET /scan?lat=45.5&lon=-73.6               │
  │  GET /scan?city=Montreal                    │
  │  GET /geoip                                 │
  │  GET /health                                │
  │  GET /cache/stats                           │
  │  DELETE /cache                              │
  └─────────────────────────────────────────────┘
  `);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${PORT} is already in use.`);
  } else {
    console.error(`[FATAL] ${err.message}`);
  }
  process.exit(1);
});