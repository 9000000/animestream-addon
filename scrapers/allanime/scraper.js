/**
 * AllAnime Scraper - Cloudflare Worker
 * 
 * Scrapes anime streams from AllAnime using their GraphQL API
 * Memory: ~5MB | CPU: <50ms
 * 
 * Endpoints:
 * - GET /?action=streams&showId=ABC123&episode=1
 * - GET /?action=search&query=naruto
 * - GET /?action=info&showId=ABC123
 * - GET /health
 * 
 * AllAnime uses a GraphQL API with XOR-encrypted source URLs.
 * Encrypted URLs start with "--" and are hex-encoded, XOR'd with key 56.
 * Some sources are direct URLs (already http://...).
 */

const ALLANIME_API = 'https://api.allanime.day/api';
const ALLANIME_BASE = 'https://allanime.to';

// Build headers that mimic a real browser
function buildBrowserHeaders(referer = null) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': ALLANIME_BASE,
    'Referer': referer || ALLANIME_BASE,
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };
  return headers;
}

// JSON response helper
function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

/**
 * Decode AllAnime's XOR-encrypted URLs
 * They use hex encoding with XOR key 56 (0x38)
 */
function decryptSourceUrl(input) {
  if (!input) return null;
  
  // If it's already a URL, return as-is
  if (input.startsWith('http')) {
    return input;
  }
  
  // Remove the "--" prefix if present
  const str = input.startsWith('--') ? input.slice(2) : input;
  
  // Check if it's hex encoded (all hex characters)
  if (!/^[0-9a-fA-F]+$/.test(str)) {
    return input; // Not hex, return as-is
  }
  
  // Decode hex with XOR 56
  let result = '';
  for (let i = 0; i < str.length; i += 2) {
    const hexPair = str.substr(i, 2);
    const num = parseInt(hexPair, 16);
    const decoded = num ^ 56; // XOR key = 56
    result += String.fromCharCode(decoded);
  }
  
  // If decoded to a relative path (internal API), skip it
  if (result.startsWith('/api')) {
    return null;
  }
  
  return result;
}

// Extract quality from source name or URL
function detectQuality(sourceName, url) {
  const text = `${sourceName} ${url}`.toLowerCase();
  if (/2160p|4k|uhd/i.test(text)) return '4K';
  if (/1080p|fhd|fullhd/i.test(text)) return '1080p';
  if (/720p|hd/i.test(text)) return '720p';
  if (/480p|sd/i.test(text)) return '480p';
  if (/360p/i.test(text)) return '360p';
  return 'HD';
}

/**
 * Determine if a URL is a direct video stream Stremio can play
 */
function isDirectStream(url) {
  // Direct video files
  if (/\.(mp4|m3u8|mkv|webm|avi)(\?|$)/i.test(url)) return true;
  // CDN patterns that serve direct video
  if (/fast4speed\.rsvp/i.test(url)) return true;
  return false;
}

/**
 * Extract video URL from Filemoon embed page
 */
async function extractFilemoon(embedUrl) {
  try {
    const response = await fetch(embedUrl, {
      headers: buildBrowserHeaders(embedUrl),
    });
    if (!response.ok) return null;
    
    const html = await response.text();
    
    // Filemoon uses packed JavaScript with eval
    // Look for the file URL in the page
    const fileMatch = html.match(/file:\s*["']([^"']+\.m3u8[^"']*)/i) ||
                      html.match(/sources:\s*\[\s*\{\s*file:\s*["']([^"']+)/i);
    
    if (fileMatch) {
      return fileMatch[1];
    }
    
    // Try to find packed JS and extract
    const evalMatch = html.match(/eval\(function\(p,a,c,k,e,[dr]\).+?\)\)/);
    if (evalMatch) {
      const unpacked = unpackJS(evalMatch[0]);
      const urlMatch = unpacked.match(/file:\s*["']([^"']+\.m3u8[^"']*)/i) ||
                       unpacked.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
      if (urlMatch) return urlMatch[1] || urlMatch[0];
    }
    
    return null;
  } catch (e) {
    console.error('Filemoon extraction failed:', e.message);
    return null;
  }
}

/**
 * Extract video URL from Streamwish embed page
 */
async function extractStreamwish(embedUrl) {
  try {
    const response = await fetch(embedUrl, {
      headers: buildBrowserHeaders(embedUrl),
    });
    if (!response.ok) return null;
    
    const html = await response.text();
    
    // Look for m3u8 or mp4 URLs
    const m3u8Match = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
    if (m3u8Match) return m3u8Match[0];
    
    const mp4Match = html.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/i);
    if (mp4Match) return mp4Match[0];
    
    // Try packed JS
    const evalMatch = html.match(/eval\(function\(p,a,c,k,e,[dr]\).+?\)\)/);
    if (evalMatch) {
      const unpacked = unpackJS(evalMatch[0]);
      const urlMatch = unpacked.match(/https?:\/\/[^"'\s]+\.(m3u8|mp4)[^"'\s]*/i);
      if (urlMatch) return urlMatch[0];
    }
    
    return null;
  } catch (e) {
    console.error('Streamwish extraction failed:', e.message);
    return null;
  }
}

/**
 * Extract video URL from Mp4upload embed page  
 */
async function extractMp4upload(embedUrl) {
  try {
    const response = await fetch(embedUrl, {
      headers: buildBrowserHeaders(embedUrl),
    });
    if (!response.ok) return null;
    
    const html = await response.text();
    
    // Mp4upload typically has src in player or video tag
    const srcMatch = html.match(/player\.src\(\{\s*type:\s*["'][^"']+["'],\s*src:\s*["']([^"']+)/i) ||
                    html.match(/src:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i) ||
                    html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)/i);
    
    if (srcMatch) return srcMatch[1];
    
    // Try eval packed
    const evalMatch = html.match(/eval\(function\(p,a,c,k,e,[dr]\).+?\)\)/);
    if (evalMatch) {
      const unpacked = unpackJS(evalMatch[0]);
      const urlMatch = unpacked.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/i);
      if (urlMatch) return urlMatch[0];
    }
    
    return null;
  } catch (e) {
    console.error('Mp4upload extraction failed:', e.message);
    return null;
  }
}

/**
 * Extract video URL from OK.ru embed
 */
async function extractOkru(embedUrl) {
  try {
    const response = await fetch(embedUrl, {
      headers: buildBrowserHeaders(embedUrl),
    });
    if (!response.ok) return null;
    
    const html = await response.text();
    
    // OK.ru stores video info in data-options JSON
    const optionsMatch = html.match(/data-options=["']([^"']+)/);
    if (optionsMatch) {
      // Decode HTML entities
      const decoded = optionsMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      try {
        const options = JSON.parse(decoded);
        const metadata = JSON.parse(options.flashvars?.metadata || '{}');
        
        // Get highest quality video
        const videos = metadata.videos || [];
        const best = videos.reduce((best, v) => 
          (!best || parseInt(v.name) > parseInt(best.name)) ? v : best, null);
        
        if (best) return best.url;
      } catch (e) {}
    }
    
    // Fallback: look for direct video URLs
    const hlsMatch = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
    if (hlsMatch) return hlsMatch[0];
    
    const mp4Match = html.match(/https?:\/\/vd[^"'\s]+\.mp4[^"'\s]*/i);
    if (mp4Match) return mp4Match[0];
    
    return null;
  } catch (e) {
    console.error('OK.ru extraction failed:', e.message);
    return null;
  }
}

/**
 * Simple JavaScript unpacker for eval(function(p,a,c,k,e,d/r) patterns
 * This is a basic implementation - may not work for all packed scripts
 */
function unpackJS(packed) {
  try {
    // Extract the parameters from the packed function
    const match = packed.match(/eval\(function\(p,a,c,k,e,[dr]\)\{.+?\}(?:\(.+?,'([^']+)'\.split\('\|'\))/s);
    if (!match) return packed;
    
    // For safety, just try to extract URLs directly from the packed string
    const urlMatches = packed.match(/https?:\\\/\\\/[^"']+/g) || [];
    const urls = urlMatches.map(u => u.replace(/\\\//g, '/'));
    
    // Return the first video URL found
    for (const url of urls) {
      if (/\.(m3u8|mp4)/i.test(url)) return url;
    }
    
    return packed;
  } catch (e) {
    return packed;
  }
}

/**
 * Extract direct video URL from an embed page
 */
async function extractDirectUrl(embedUrl, provider) {
  const urlLower = embedUrl.toLowerCase();
  
  if (urlLower.includes('filemoon')) {
    return await extractFilemoon(embedUrl);
  }
  if (urlLower.includes('streamwish')) {
    return await extractStreamwish(embedUrl);
  }
  if (urlLower.includes('mp4upload')) {
    return await extractMp4upload(embedUrl);
  }
  if (urlLower.includes('ok.ru')) {
    return await extractOkru(embedUrl);
  }
  
  return null;
}

/**
 * GraphQL query to get episode sources
 * @param {string} showId - AllAnime show ID
 * @param {string} episode - Episode number
 * @param {boolean} extractDirect - Whether to extract direct URLs from embeds (slower but Stremio-ready)
 */
async function getEpisodeSources(showId, episode, extractDirect = false) {
  const query = `
    query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) {
      episode(
        showId: $showId
        translationType: $translationType
        episodeString: $episodeString
      ) {
        episodeString
        sourceUrls
        notes
      }
    }
  `;

  const streams = [];

  // Try both sub and dub
  for (const translationType of ['sub', 'dub']) {
    try {
      const response = await fetch(ALLANIME_API, {
        method: 'POST',
        headers: {
          ...buildBrowserHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: {
            showId,
            translationType,
            episodeString: String(episode),
          },
        }),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const episodeData = data?.data?.episode;

      if (!episodeData?.sourceUrls) continue;

      // Process each source
      for (const source of episodeData.sourceUrls) {
        if (!source.sourceUrl) continue;

        const decodedUrl = decryptSourceUrl(source.sourceUrl);
        
        // Skip null (internal API) or non-URL results
        if (!decodedUrl) continue;
        if (!decodedUrl.startsWith('http')) continue;
        
        // Skip blocked providers
        if (decodedUrl.includes('listeamed.net')) continue;
        
        // Check if it's a direct stream or embed
        const isDirect = isDirectStream(decodedUrl);
        const isEmbed = !isDirect && (
          decodedUrl.includes('/embed') || 
          decodedUrl.includes('/e/') ||
          decodedUrl.includes('streaming.php') ||
          decodedUrl.includes('player') ||
          decodedUrl.includes('ok.ru')
        );

        let finalUrl = decodedUrl;
        let extracted = false;
        
        // If extractDirect is enabled, try to extract direct URL from embeds
        if (extractDirect && isEmbed) {
          const directUrl = await extractDirectUrl(decodedUrl, source.sourceName);
          if (directUrl) {
            finalUrl = directUrl;
            extracted = true;
          } else {
            // Skip embeds we couldn't extract
            continue;
          }
        } else if (!extractDirect && isEmbed) {
          // In non-extract mode, skip embeds (they won't play in Stremio)
          continue;
        }

        streams.push({
          url: finalUrl,
          quality: detectQuality(source.sourceName, finalUrl),
          provider: source.sourceName || 'AllAnime',
          type: translationType.toUpperCase(), // SUB or DUB
          isDirect: isDirect || extracted,
          priority: source.priority || 0,
          // For Stremio: add behavior hints for streams that need special handling
          behaviorHints: isDirect && decodedUrl.includes('fast4speed') ? {
            proxyHeaders: {
              request: {
                'Referer': 'https://allanime.to/'
              }
            }
          } : undefined,
        });
      }
    } catch (e) {
      console.error(`Error fetching ${translationType}:`, e.message);
    }
  }

  // Sort by priority (higher = better)
  streams.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  return streams;
}

/**
 * GraphQL query to search for anime
 */
async function searchAnime(searchQuery, limit = 20) {
  const query = `
    query ($search: SearchInput!, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType, $countryOrigin: VaildCountryOriginEnumType) {
      shows(
        search: $search
        limit: $limit
        page: $page
        translationType: $translationType
        countryOrigin: $countryOrigin
      ) {
        edges {
          _id
          name
          englishName
          nativeName
          thumbnail
          type
          score
          status
          season
          episodeCount
          description
          genres
        }
      }
    }
  `;

  try {
    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: {
        ...buildBrowserHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          search: {
            query: searchQuery,
            allowAdult: false,
            allowUnknown: false,
          },
          limit,
          page: 1,
          translationType: 'sub',
          countryOrigin: 'JP', // Japanese anime only
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const shows = data?.data?.shows?.edges || [];

    return shows.map(show => ({
      id: show._id,
      title: show.englishName || show.name,
      nativeTitle: show.nativeName,
      poster: show.thumbnail,
      type: show.type,
      score: show.score,
      status: show.status,
      season: show.season,
      episodes: show.episodeCount,
      description: show.description,
      genres: show.genres,
    }));
  } catch (e) {
    console.error('Search error:', e.message);
    return [];
  }
}

/**
 * GraphQL query to get show info and episodes
 */
async function getShowInfo(showId) {
  const query = `
    query ($showId: String!) {
      show(_id: $showId) {
        _id
        name
        englishName
        nativeName
        thumbnail
        banner
        type
        score
        status
        season
        episodeCount
        description
        genres
        studios
        averageScore
        availableEpisodesDetail
      }
    }
  `;

  try {
    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: {
        ...buildBrowserHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { showId },
      }),
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const show = data?.data?.show;

    if (!show) return null;

    // Parse available episodes
    const episodes = {
      sub: show.availableEpisodesDetail?.sub || [],
      dub: show.availableEpisodesDetail?.dub || [],
    };

    return {
      id: show._id,
      title: show.englishName || show.name,
      nativeTitle: show.nativeName,
      poster: show.thumbnail,
      banner: show.banner,
      type: show.type,
      score: show.score || show.averageScore,
      status: show.status,
      season: show.season,
      episodeCount: show.episodeCount,
      description: show.description,
      genres: show.genres,
      studios: show.studios,
      episodes,
    };
  } catch (e) {
    console.error('Show info error:', e.message);
    return null;
  }
}

/**
 * Main Cloudflare Worker handler
 */
export default {
  async fetch(request, env, ctx) {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    
    // Health check endpoint
    if (url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        provider: 'AllAnime',
        api: ALLANIME_API,
        timestamp: new Date().toISOString(),
      }, 200, corsHeaders);
    }

    const action = url.searchParams.get('action');

    try {
      // Action: Get streams for an episode
      if (action === 'streams') {
        const showId = url.searchParams.get('showId');
        const episode = url.searchParams.get('episode');

        if (!showId || !episode) {
          return jsonResponse({ 
            error: 'Missing required parameters: showId, episode' 
          }, 400, corsHeaders);
        }

        // Check if we should extract direct URLs from embeds
        const extract = url.searchParams.get('extract') === '1' || 
                       url.searchParams.get('extract') === 'true';

        // Check cache first (separate cache for extract vs non-extract)
        const cacheKey = new Request(`${url.origin}/cache/streams/${showId}/${episode}${extract ? '/extract' : ''}`);
        const cache = caches.default;
        
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          const cached = await cachedResponse.json();
          return jsonResponse({ 
            ...cached, 
            cached: true 
          }, 200, corsHeaders);
        }

        const streams = await getEpisodeSources(showId, episode, extract);

        const result = {
          showId,
          episode,
          streams,
          count: streams.length,
          extracted: extract,
          timestamp: new Date().toISOString(),
        };

        // Cache for 3 minutes
        const responseToCache = new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
        ctx.waitUntil(cache.put(cacheKey, responseToCache));

        return jsonResponse(result, 200, corsHeaders);
      }

      // Action: Search for anime
      if (action === 'search') {
        const query = url.searchParams.get('query');
        const limit = parseInt(url.searchParams.get('limit') || '20');

        if (!query) {
          return jsonResponse({ 
            error: 'Missing required parameter: query' 
          }, 400, corsHeaders);
        }

        const results = await searchAnime(query, limit);

        return jsonResponse({
          query,
          results,
          count: results.length,
          timestamp: new Date().toISOString(),
        }, 200, corsHeaders);
      }

      // Action: Get show info
      if (action === 'info') {
        const showId = url.searchParams.get('showId');

        if (!showId) {
          return jsonResponse({ 
            error: 'Missing required parameter: showId' 
          }, 400, corsHeaders);
        }

        const info = await getShowInfo(showId);

        if (!info) {
          return jsonResponse({ 
            error: 'Show not found' 
          }, 404, corsHeaders);
        }

        return jsonResponse(info, 200, corsHeaders);
      }

      // Default: show usage
      return jsonResponse({
        name: 'AllAnime Scraper',
        version: '1.0.0',
        endpoints: {
          streams: '/?action=streams&showId=ABC123&episode=1',
          search: '/?action=search&query=naruto',
          info: '/?action=info&showId=ABC123',
          health: '/health',
        },
        example: {
          search: 'First search for an anime to get its showId',
          streams: 'Then use the showId to get episode streams',
        },
      }, 200, corsHeaders);

    } catch (error) {
      return jsonResponse({
        error: error.message,
        stack: error.stack,
      }, 500, corsHeaders);
    }
  },
};
