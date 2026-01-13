# AllAnime Scraper

A Cloudflare Worker that scrapes anime streams from AllAnime using their GraphQL API.

## Features

- **Search anime** by title
- **Get show info** including available episodes (SUB/DUB)
- **Get episode streams** with multiple providers
- **XOR decryption** for encoded source URLs (key: 56)
- **Caching** via Cloudflare Cache API (3 minute TTL)
- **No external dependencies** - pure JS

## Tested Stream Providers

| Provider | Type | Usable |
|----------|------|--------|
| Yt-mp4 | Direct CDN | ✅ Yes (may need referer) |
| Filemoon | Embed | ✅ Yes |
| Streamwish | Embed | ✅ Yes |
| Mp4upload | Embed | ✅ Yes |
| OK.ru | Embed | ✅ Yes |
| Listeamed | Embed | ⚠️ Cloudflare blocked |

## Local Testing

```bash
# Test the scraper logic locally (requires Node.js 18+)
node test-local-v2.js

# Run with Wrangler dev server
wrangler dev --port 8787
```

## Deployment

```bash
# Deploy to Cloudflare Workers
wrangler deploy
```

## API Endpoints

### Health Check
```
GET /health
```

### Search Anime
```
GET /?action=search&query=naruto&limit=20
```

Response:
```json
{
  "query": "naruto",
  "results": [
    {
      "id": "ABC123",
      "title": "Naruto",
      "poster": "https://...",
      "type": "TV",
      "score": 8.5,
      "episodes": 220,
      "genres": ["Action", "Adventure"]
    }
  ],
  "count": 1
}
```

### Get Show Info
```
GET /?action=info&showId=ABC123
```

Response:
```json
{
  "id": "ABC123",
  "title": "Naruto",
  "description": "...",
  "episodes": {
    "sub": ["1", "2", "3", ...],
    "dub": ["1", "2", "3", ...]
  }
}
```

### Get Episode Streams
```
GET /?action=streams&showId=ABC123&episode=1
```

Response:
```json
{
  "showId": "ABC123",
  "episode": "1",
  "streams": [
    {
      "url": "https://...",
      "quality": "1080p",
      "provider": "Vidstreaming",
      "type": "SUB",
      "isEmbed": true
    }
  ],
  "count": 5
}
```

## Stream Types

- **SUB**: Japanese audio with subtitles
- **DUB**: English dubbed audio

## Stream URL Types

AllAnime returns two types of stream URLs:

1. **Direct streams** - Ready to play (.m3u8, .mp4)
2. **Embed pages** - Require further extraction (marked with `isEmbed: true`)

For embed pages, you'll need additional processing to extract the actual video URL.

## Known Embed Providers

- Vidstreaming
- GogoAnime
- StreamSB
- Mp4Upload
- Doodstream

## Integration with Stremio

To use these streams in Stremio, you'll need to:

1. Map MAL/AniList IDs to AllAnime show IDs
2. Convert embed URLs to direct stream URLs (for embed sources)
3. Return streams in Stremio format:

```javascript
{
  name: 'AllAnime',
  title: 'Episode 1 - 1080p [SUB]',
  url: 'https://...',
  behaviorHints: {
    notWebReady: true // for HLS streams
  }
}
```

## Rate Limits

AllAnime's API has rate limits. The scraper uses caching to minimize API calls:
- Stream responses cached for 3 minutes
- Search/info responses not cached (fresh data)

## Disclaimer

This scraper is for educational purposes. Use responsibly and respect the source website's terms of service.
