# 🌍 Ambiant Scan

**Zero-Dependency single-file Environmental Scraper & Modeler**  
Part of **The Governor HQ** Suite

A single-file Node.js server that scrapes legitimate free APIs and returns normalized environmental data: temperature, air quality, UV index, humidity, wind, atmospheric pressure, geolocation, and more.

## Features

- **Zero dependencies** — just `node server.js`
- **GPS → City → Cache → Query** pipeline for performance
- **GeoIP endpoint** — auto-detect caller position from IP (proxy-aware)
- **4-tier LRU cache** with TTL (geo, city-resolve, data, geoip)
- **Coordinate grid snapping** (~1.1km) — nearby requests share cache entries
- **Parallel API fetching** — weather + air quality fetched simultaneously
- **Graceful degradation** — returns partial data if one source is down
- **Fly.io ready** — respects `Fly-Client-IP`, `X-Forwarded-For`, `X-Real-IP`
- **CORS enabled** — query from any frontend

## Data Sources

| Source | Data | API Key |
|--------|------|---------|
| [Open-Meteo](https://open-meteo.com/) | Weather, UV, Air Quality | ❌ Not required |
| [BigDataCloud](https://www.bigdatacloud.com/) | Reverse Geocoding | ❌ Not required |
| [ip-api.com](http://ip-api.com/) | GeoIP (IP → location) | ❌ Not required |

## Quick Start

```bash
cd ambiant-scan
node server.js
```

Server starts on `http://localhost:3400`

> **API Collections** for fast testing are included — see [API Collections](#api-collections) below.

## API

### `GET /scan?lat=XX&lon=YY`

Scan by GPS coordinates.

```bash
curl "http://localhost:3400/scan?lat=45.50&lon=-73.57"
```

### `GET /scan?city=NAME`

Scan by city name.

```bash
curl "http://localhost:3400/scan?city=Montreal"
```

### `GET /geoip`

Returns the caller's geolocation based on their IP address. Handles reverse proxies automatically.

```bash
curl "http://localhost:3400/geoip"
```

**Behind a proxy / Fly.io:**
```bash
# Simulating Fly.io header locally:
curl -H "Fly-Client-IP: 24.48.0.1" "http://localhost:3400/geoip"
```

<details>
<summary>Example response</summary>

```json
{
  "ip": "24.48.0.1",
  "lat": 45.6085,
  "lon": -73.5493,
  "city": "Montreal",
  "region": "Quebec",
  "regionCode": "QC",
  "country": "Canada",
  "countryCode": "CA",
  "zip": "H1K",
  "timezone": "America/Toronto",
  "isp": "Le Groupe Videotron Ltee",
  "org": "Videotron Ltee",
  "as": "AS5769 Videotron Ltee",
  "source": "fly-client-ip",
  "timestamp": "2026-02-18T20:36:13.181Z"
}
```
</details>

**IP Resolution Priority:**

| Priority | Header | Set by |
|----------|--------|--------|
| 1 | `Fly-Client-IP` | Fly.io edge proxy |
| 2 | `X-Forwarded-For` (first entry) | Most reverse proxies |
| 3 | `X-Real-IP` | Nginx |
| 4 | `socket.remoteAddress` | Direct connection |

> On localhost, returns a helpful warning since private IPs can't be geolocated.

### `GET /health`

Health check.

### `GET /cache/stats`

View cache hit rates and entry counts for all 4 caches.

### `DELETE /cache`

Flush all caches.

## Response Shape (`/scan`)

```json
{
  "meta": {
    "source": "ambiant-scan",
    "version": "1.0.0",
    "timestamp": "2026-02-18T12:00:00.000Z",
    "location": {
      "city": "Montreal",
      "region": "Quebec",
      "country": "Canada",
      "countryCode": "CA",
      "coordinates": { "lat": 45.5, "lon": -73.57 }
    },
    "timezone": "America/Toronto",
    "elevation_m": 36,
    "_cached": false,
    "_responseTime_ms": 287
  },
  "temperature": {
    "current_c": -8.2,
    "feels_like_c": -14.1,
    "daily_high_c": -5.0,
    "daily_low_c": -12.3,
    "unit": "°C"
  },
  "air_quality": {
    "us_aqi": 42,
    "level": "good",
    "concern": "Air quality is satisfactory",
    "pollutants": {
      "pm2_5": { "value": 8.1, "unit": "μg/m³" },
      "pm10": { "value": 12.4, "unit": "μg/m³" },
      "...": "..."
    }
  },
  "uv_index": {
    "current": 1.2,
    "clear_sky": 1.8,
    "daily_max": 2.5,
    "level": "low",
    "concern": "No protection needed"
  },
  "humidity": { "relative_percent": 72 },
  "wind": {
    "speed_kmh": 15.3,
    "gusts_kmh": 28.1,
    "direction_degrees": 225,
    "direction_label": "SW",
    "description": "gentle breeze"
  },
  "atmosphere": {
    "pressure_msl_hpa": 1018.2,
    "surface_pressure_hpa": 1014.1,
    "cloud_cover_percent": 75
  },
  "precipitation": {
    "current_mm": 0,
    "rain_mm": 0,
    "daily_sum_mm": 2.1,
    "daily_probability_percent": 45
  },
  "conditions": {
    "weather_code": 2,
    "description": "Partly cloudy",
    "is_day": true
  },
  "sun": {
    "sunrise": "2026-02-18T07:02",
    "sunset": "2026-02-18T17:31"
  }
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3400` | Server port |
| `CACHE_TTL_SECONDS` | `600` | Environmental data cache TTL (10 min) |
| `GEO_CACHE_TTL_SECONDS` | `86400` | Geocoding cache TTL (24 hours) |
| `MAX_CACHE_ENTRIES` | `5000` | Max entries per cache before LRU eviction |

## Cache Architecture

```
Request
  ├── /geoip
  │     └── geoipCache (24h TTL) → IP geolocation
  │
  ├── ?city=Montreal
  │     └── cityResolveCache (24h TTL) → lat/lon
  │
  ├── ?lat=45.5&lon=-73.6
  │     └── roundCoords (~1.1km grid snap)
  │           └── geoCache (24h TTL) → city metadata
  │
  └── coordsKey → dataCache (10min TTL)
        ├── HIT → return instantly
        └── MISS → parallel fetch [weather + air quality]
                     → model → cache → return
```

## API Collections

Pre-built collection files for fast testing are included in the `collections/` folder:

| File | Client |
|------|--------|
| `collections/insomnia.json` | [Insomnia](https://insomnia.rest/) — Import via Application → Import |
| `collections/postman.json` | [Postman](https://www.postman.com/) — Import via File → Import |
| `collections/api.http` | VS Code [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) / JetBrains HTTP Client |

All collections use a `base_url` variable (default `http://localhost:3400`) so you can switch between local and production.

## Deployment (Fly.io)

```bash
fly launch        # first time
fly deploy        # subsequent deploys
```

The included `fly.toml` is pre-configured. The `/geoip` endpoint works automatically on Fly.io — the `Fly-Client-IP` header is set by the edge proxy.

## License

MIT