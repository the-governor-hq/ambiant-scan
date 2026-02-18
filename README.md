# 🌍 Ambiant Scan

**Zero-Dependency single-file Environmental Scraper & Modeler**
Part of [The Governor HQ](../README.md) suite.

A single-file Node.js  that scrapes legitimate free APIs and returns normalized environmental data: temperature, air quality, UV index, humidity, wind, atmospheric pressure, and more.

## Features

- **Zero dependencies** — just `node server.js`
- **GPS → City → Cache → Query** pipeline for performance
- **3-tier LRU cache** with TTL (geo, city-resolve, data)
- **Coordinate grid snapping** (~1.1km) — nearby requests share cache entries
- **Parallel API fetching** — weather + air quality fetched simultaneously
- **Graceful degradation** — returns partial data if one source is down
- **CORS enabled** — query from any frontend

## Data Sources

| Source | Data | API Key |
|--------|------|---------|
| [Open-Meteo](https://open-meteo.com/) | Weather, UV, Air Quality | ❌ Not required |
| [BigDataCloud](https://www.bigdatacloud.com/) | Reverse Geocoding | ❌ Not required |

## Quick Start

```bash
cd ambiant-scan
node server.js
```

Server starts on `http://localhost:3400`

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

### `GET /health`

Health check.

### `GET /cache/stats`

View cache hit rates and entry counts.

### `DELETE /cache`

Flush all caches.

## Response Shape

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

## License

MIT