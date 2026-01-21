/**
 * AnimeStream Stremio Addon - Cloudflare Worker (GitHub-backed)
 * 
 * A lightweight serverless Stremio addon that fetches catalog data from GitHub.
 * No embedded data - stays under Cloudflare's 1MB limit easily.
 */

// ===== CONFIGURATION =====
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/data';
const CACHE_TTL = 21600; // 6 hours cache for GitHub data (catalog is static, rarely updates)
const CACHE_BUSTER = 'v15'; // Change this to bust cache after catalog updates
const ALLANIME_CACHE_TTL = 300; // 5 minutes for AllAnime API responses (streams change frequently)
const MANIFEST_CACHE_TTL = 86400; // 24 hours for manifest (rarely changes)
const CATALOG_HTTP_CACHE = 21600; // 6 hours HTTP cache for catalog responses (static content)
const STREAM_HTTP_CACHE = 120; // 2 minutes HTTP cache for stream responses
const META_HTTP_CACHE = 3600; // 1 hour HTTP cache for meta responses

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 120; // Max 120 requests per minute per IP (2/sec average)
const rateLimitMap = new Map();
const MAX_RATE_LIMIT_ENTRIES = 1000; // Prevent memory issues

// ===== HAGLUND API (ID MAPPING) CONFIGURATION =====
// Haglund API maps between AniList, MAL, Kitsu, and IMDB IDs
// Source: https://github.com/aliyss/syncribullet uses this API
const HAGLUND_API_BASE = 'https://arm.haglund.dev/api/v2';
const HAGLUND_CACHE_TTL = 86400; // 24 hour cache for ID mappings (they don't change often)

// Caches for external API data
let haglundIdCache = new Map();
const MAX_HAGLUND_CACHE_ENTRIES = 500; // Prevent memory issues

// ===== SCROBBLING CONFIGURATION =====
// AniList API for scrobbling (updating watch progress)
// Based on syncribullet: https://github.com/aliyss/syncribullet
const ANILIST_API_BASE = 'https://graphql.anilist.co';
const ANILIST_OAUTH_URL = 'https://anilist.co/api/v2/oauth/authorize';

// MAL API for scrobbling (requires OAuth2)
const MAL_API_BASE = 'https://api.myanimelist.net/v2';
const MAL_OAUTH_URL = 'https://myanimelist.net/v1/oauth2/authorize';
const MAL_CLIENT_ID = 'e1c53f5d91d73133d628b7e2f56df992';

// ===== USER TOKEN CACHE =====
// In-memory cache to reduce KV reads (tokens are read frequently during playback)
// Cache TTL: 5 minutes - balance between freshness and KV usage
const userTokenCache = new Map();
const USER_TOKEN_CACHE_TTL = 300000; // 5 minutes
const MAX_USER_TOKEN_CACHE_ENTRIES = 200;

// Helper to get user tokens (with in-memory cache to reduce KV reads)
async function getUserTokens(userId, env) {
  if (!userId || !env?.USER_TOKENS) return null;
  
  // Check in-memory cache first
  const cached = userTokenCache.get(userId);
  if (cached && Date.now() - cached.timestamp < USER_TOKEN_CACHE_TTL) {
    return cached.data;
  }
  
  // Cleanup cache if too large
  if (userTokenCache.size > MAX_USER_TOKEN_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [key, value] of userTokenCache) {
      if (now - value.timestamp > USER_TOKEN_CACHE_TTL) {
        userTokenCache.delete(key);
      }
    }
  }
  
  try {
    const data = await env.USER_TOKENS.get(userId, 'json');
    if (data) {
      userTokenCache.set(userId, { data, timestamp: Date.now() });
    }
    return data;
  } catch (error) {
    console.error('[KV] Error reading user tokens:', error.message);
    return null;
  }
}

// Helper to save user tokens (writes to KV, updates cache)
async function saveUserTokens(userId, tokens, env) {
  if (!userId || !env?.USER_TOKENS) return false;
  
  try {
    await env.USER_TOKENS.put(userId, JSON.stringify(tokens));
    userTokenCache.set(userId, { data: tokens, timestamp: Date.now() });
    return true;
  } catch (error) {
    console.error('[KV] Error saving user tokens:', error.message);
    return false;
  }
}

// Generate a short user ID from AniList/MAL user info
function generateUserId(anilistUser, malUser) {
  if (anilistUser?.id) return `al_${anilistUser.id}`;
  if (malUser?.id) return `mal_${malUser.id}`;
  // Fallback: random ID
  return `u_${Math.random().toString(36).substring(2, 10)}`;
}

// ===== CONSTANTS =====
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  ...CORS_HEADERS,
};

// ===== RATE LIMITING =====
// Simple in-memory rate limiter per IP address
function checkRateLimit(ip) {
  const now = Date.now();
  
  // Cleanup old entries periodically
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    const cutoff = now - RATE_LIMIT_WINDOW;
    for (const [key, data] of rateLimitMap) {
      if (data.windowStart < cutoff) {
        rateLimitMap.delete(key);
      }
    }
  }
  
  let entry = rateLimitMap.get(ip);
  
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    // New window
    entry = { windowStart: now, count: 1 };
    rateLimitMap.set(ip, entry);
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }
  
  entry.count++;
  
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW - now) / 1000) };
  }
  
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - entry.count };
}

// Helper to create JSON response with cache headers
function jsonResponse(data, options = {}) {
  const { maxAge = 0, staleWhileRevalidate = 0, status = 200, extraHeaders = {} } = options;
  const headers = { ...JSON_HEADERS, ...extraHeaders };
  
  if (maxAge > 0) {
    // Cache-Control: public allows CDN caching, s-maxage for edge cache, stale-while-revalidate for background refresh
    headers['Cache-Control'] = `public, max-age=${maxAge}, s-maxage=${maxAge}${staleWhileRevalidate ? `, stale-while-revalidate=${staleWhileRevalidate}` : ''}`;
  } else {
    headers['Cache-Control'] = 'no-cache';
  }
  
  return new Response(JSON.stringify(data), { status, headers });
}

// ===== HAGLUND API (ID MAPPING) FUNCTIONS =====
// Maps between AniList, MAL, Kitsu, and IMDB IDs
// Source pattern from syncribullet: https://github.com/aliyss/syncribullet
// NOTE: Runtime MAL schedule API calls have been removed - we use pre-scraped
// broadcastDay data from catalog.json instead (updated via incremental-update.js)

/**
 * Get ID mappings from Haglund API
 * @param {string} id - The ID to look up
 * @param {string} source - Source type: 'anilist', 'mal', 'kitsu', or 'imdb'
 * @returns {Promise<Object>} Object with mapped IDs: { anilist, mal, kitsu, imdb }
 */
async function getIdMappings(id, source) {
  const cacheKey = `${source}:${id}`;
  
  // Check cache first
  if (haglundIdCache.has(cacheKey)) {
    return haglundIdCache.get(cacheKey);
  }
  
  // Cleanup cache if too large
  if (haglundIdCache.size > MAX_HAGLUND_CACHE_ENTRIES) {
    const entries = Array.from(haglundIdCache.entries());
    const toDelete = entries.slice(0, Math.floor(MAX_HAGLUND_CACHE_ENTRIES / 2));
    toDelete.forEach(([key]) => haglundIdCache.delete(key));
  }
  
  try {
    const url = `${HAGLUND_API_BASE}/ids?source=${source}&id=${id}&include=anilist,kitsu,myanimelist,imdb`;
    const response = await fetch(url, {
      cf: { cacheTtl: HAGLUND_CACHE_TTL, cacheEverything: true }
    });
    
    if (!response.ok) {
      throw new Error(`Haglund API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Normalize the response
    const mappings = {
      anilist: data.anilist ? parseInt(data.anilist) : null,
      mal: data.myanimelist ? parseInt(data.myanimelist) : null,
      kitsu: data.kitsu ? parseInt(data.kitsu) : null,
      imdb: data.imdb || null
    };
    
    // Cache the result
    haglundIdCache.set(cacheKey, mappings);
    
    return mappings;
  } catch (error) {
    console.error(`[Haglund] Error fetching ID mappings for ${source}:${id}:`, error.message);
    return { anilist: null, mal: null, kitsu: null, imdb: null };
  }
}

/**
 * Get ID mappings from IMDB ID (handles multi-season anime)
 * @param {string} imdbId - The IMDB ID (e.g., "tt12343534")
 * @param {number} season - Optional season number for multi-season anime
 * @returns {Promise<Object>} Object with mapped IDs
 */
async function getIdMappingsFromImdb(imdbId, season = null) {
  const cacheKey = season ? `imdb:${imdbId}:${season}` : `imdb:${imdbId}`;
  
  // Check cache first
  if (haglundIdCache.has(cacheKey)) {
    return haglundIdCache.get(cacheKey);
  }
  
  try {
    const url = `${HAGLUND_API_BASE}/imdb?id=${imdbId}&include=anilist,kitsu,myanimelist,imdb`;
    const response = await fetch(url, {
      cf: { cacheTtl: HAGLUND_CACHE_TTL, cacheEverything: true }
    });
    
    if (!response.ok) {
      throw new Error(`Haglund API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // IMDB endpoint returns an array for multi-season anime
    // Each element corresponds to a season
    let seasonData;
    if (Array.isArray(data)) {
      if (season && data.length >= season) {
        seasonData = data[season - 1]; // 0-indexed array
      } else if (data.length > 0) {
        seasonData = data[0]; // First season as fallback
      }
    } else {
      seasonData = data;
    }
    
    if (!seasonData) {
      return { anilist: null, mal: null, kitsu: null, imdb: imdbId };
    }
    
    const mappings = {
      anilist: seasonData.anilist ? parseInt(seasonData.anilist) : null,
      mal: seasonData.myanimelist ? parseInt(seasonData.myanimelist) : null,
      kitsu: seasonData.kitsu ? parseInt(seasonData.kitsu) : null,
      imdb: seasonData.imdb || imdbId
    };
    
    // Cache the result
    haglundIdCache.set(cacheKey, mappings);
    
    return mappings;
  } catch (error) {
    console.error(`[Haglund] Error fetching IMDB mappings for ${imdbId}:`, error.message);
    return { anilist: null, mal: null, kitsu: null, imdb: imdbId };
  }
}

// ===== ANILIST SCROBBLING API =====
// Based on syncribullet: https://github.com/aliyss/syncribullet/blob/main/src/utils/receivers/anilist/api/sync.ts

/**
 * Get current user info from AniList
 * @param {string} accessToken - AniList OAuth access token
 * @returns {Promise<Object>} User info { id, name }
 */
async function getAnilistCurrentUser(accessToken) {
  const query = `
    query {
      Viewer {
        id
        name
        avatar { large medium }
      }
    }
  `;
  
  try {
    const response = await fetch(ANILIST_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ query })
    });
    
    if (!response.ok) {
      throw new Error(`AniList API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.data?.Viewer || null;
  } catch (error) {
    console.error('[AniList] Error fetching current user:', error.message);
    return null;
  }
}

/**
 * Get current progress for an anime on AniList
 * @param {number} anilistId - AniList media ID
 * @param {string} accessToken - AniList OAuth access token
 * @returns {Promise<Object>} Current progress info
 */
async function getAnilistProgress(anilistId, accessToken) {
  const query = `
    query ($id: Int, $type: MediaType) {
      Media(id: $id, type: $type) {
        id
        title { userPreferred romaji english native }
        type
        format
        status(version: 2)
        episodes
        isAdult
        nextAiringEpisode { airingAt timeUntilAiring episode }
        mediaListEntry { id status score progress }
      }
    }
  `;
  
  try {
    const response = await fetch(ANILIST_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        query,
        variables: { id: anilistId, type: 'ANIME' }
      })
    });
    
    if (!response.ok) {
      throw new Error(`AniList API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.data?.Media || null;
  } catch (error) {
    console.error('[AniList] Error fetching progress:', error.message);
    return null;
  }
}

/**
 * Update watch progress on AniList (scrobble)
 * Based on syncribullet: https://github.com/aliyss/syncribullet/blob/main/src/utils/receivers/anilist/api/sync.ts
 * @param {number} anilistId - AniList media ID
 * @param {string} status - Status: CURRENT, PLANNING, COMPLETED, REPEATING, PAUSED, DROPPED
 * @param {number} progress - Episode number watched
 * @param {string} accessToken - AniList OAuth access token
 * @returns {Promise<Object>} Updated entry info
 */
async function syncAnilistProgress(anilistId, status, progress, accessToken) {
  // GraphQL mutation for updating anime list entry
  // From syncribullet: https://github.com/aliyss/syncribullet/blob/main/src/utils/receivers/anilist/api/sync.ts
  const mutation = `
    mutation (
      $id: Int
      $mediaId: Int
      $status: MediaListStatus
      $score: Float
      $progress: Int
      $progressVolumes: Int
      $repeat: Int
      $private: Boolean
      $notes: String
      $customLists: [String]
      $hiddenFromStatusLists: Boolean
      $advancedScores: [Float]
      $startedAt: FuzzyDateInput
      $completedAt: FuzzyDateInput
    ) {
      SaveMediaListEntry(
        id: $id
        mediaId: $mediaId
        status: $status
        score: $score
        progress: $progress
        progressVolumes: $progressVolumes
        repeat: $repeat
        private: $private
        notes: $notes
        customLists: $customLists
        hiddenFromStatusLists: $hiddenFromStatusLists
        advancedScores: $advancedScores
        startedAt: $startedAt
        completedAt: $completedAt
      ) {
        id
        mediaId
        status
        score
        progress
        updatedAt
        user { id name }
        media {
          id
          title { userPreferred }
          type
          format
          status
          episodes
        }
      }
    }
  `;
  
  try {
    const response = await fetch(ANILIST_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          mediaId: anilistId,
          status: status,
          progress: progress
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AniList API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`AniList GraphQL error: ${data.errors[0]?.message}`);
    }
    
    console.log(`[AniList] Updated ${anilistId}: status=${status}, progress=${progress}`);
    return data.data?.SaveMediaListEntry || null;
  } catch (error) {
    console.error('[AniList] Error syncing progress:', error.message);
    throw error;
  }
}

/**
 * Smart scrobble to AniList - handles status transitions automatically
 * Based on syncribullet logic: https://github.com/aliyss/syncribullet/blob/main/src/utils/receivers/anilist/recevier-server.ts
 * @param {number} anilistId - AniList media ID
 * @param {number} episode - Episode number watched
 * @param {string} accessToken - AniList OAuth access token
 * @returns {Promise<Object>} Scrobble result
 */
async function scrobbleToAnilist(anilistId, episode, accessToken) {
  // First get current progress and anime info
  const mediaInfo = await getAnilistProgress(anilistId, accessToken);
  
  if (!mediaInfo) {
    throw new Error('Could not fetch anime info from AniList');
  }
  
  const currentEntry = mediaInfo.mediaListEntry;
  const totalEpisodes = mediaInfo.episodes || 9999; // Use high number for ongoing anime
  const currentStatus = currentEntry?.status;
  const currentProgress = currentEntry?.progress || 0;
  
  // Determine new status based on episode and current status
  let newStatus = currentStatus || 'CURRENT';
  let newProgress = episode;
  
  // Status transition logic from syncribullet
  if (currentStatus === 'COMPLETED') {
    // Already completed - don't update
    console.log(`[AniList] Anime ${anilistId} already COMPLETED, skipping`);
    return { skipped: true, reason: 'Already completed' };
  }
  
  // If currently PAUSED, DROPPED, or PLANNING, set to CURRENT
  if (['PAUSED', 'DROPPED', 'PLANNING'].includes(currentStatus)) {
    newStatus = 'CURRENT';
  }
  
  // If no entry exists, start watching
  if (!currentStatus) {
    newStatus = 'CURRENT';
  }
  
  // If watched episode >= total episodes, mark as COMPLETED
  if (episode >= totalEpisodes && mediaInfo.status === 'FINISHED') {
    newStatus = 'COMPLETED';
    newProgress = totalEpisodes;
  }
  
  // Only update if new progress is higher than current
  if (newProgress <= currentProgress && newStatus === currentStatus) {
    console.log(`[AniList] Episode ${episode} <= current progress ${currentProgress}, skipping`);
    return { skipped: true, reason: 'Episode already watched' };
  }
  
  // Sync the progress
  const result = await syncAnilistProgress(anilistId, newStatus, newProgress, accessToken);
  
  return {
    success: true,
    mediaId: anilistId,
    title: mediaInfo.title?.userPreferred || mediaInfo.title?.romaji,
    previousProgress: currentProgress,
    newProgress: newProgress,
    status: newStatus,
    isCompleted: newStatus === 'COMPLETED'
  };
}

// ===== MAL SCROBBLING FUNCTIONS =====

/**
 * Get current anime status from MAL
 */
async function getMalAnimeStatus(malId, accessToken) {
  try {
    const response = await fetch(`${MAL_API_BASE}/anime/${malId}?fields=id,title,num_episodes,status,my_list_status`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!response.ok) {
      if (response.status === 401) return { error: 'token_expired' };
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error('[MAL] Error fetching anime status:', error.message);
    return null;
  }
}

/**
 * Update MAL anime list status
 */
async function updateMalStatus(malId, status, episode, accessToken) {
  try {
    const params = new URLSearchParams({
      status: status,
      num_watched_episodes: episode.toString()
    });
    
    // Add start date if starting to watch
    if (status === 'watching') {
      const today = new Date().toISOString().split('T')[0];
      params.append('start_date', today);
    }
    
    // Add finish date if completed
    if (status === 'completed') {
      const today = new Date().toISOString().split('T')[0];
      params.append('finish_date', today);
    }
    
    const response = await fetch(`${MAL_API_BASE}/anime/${malId}/my_list_status`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    
    if (!response.ok) {
      throw new Error(`MAL API error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('[MAL] Error updating status:', error.message);
    throw error;
  }
}

/**
 * Smart scrobble to MAL - handles status transitions automatically
 * Based on mal-stremio-addon logic
 */
async function scrobbleToMal(malId, episode, accessToken, isMovie = false) {
  // Get current anime info and status
  const animeInfo = await getMalAnimeStatus(malId, accessToken);
  
  if (!animeInfo) {
    throw new Error('Could not fetch anime info from MAL');
  }
  
  if (animeInfo.error === 'token_expired') {
    return { error: 'token_expired' };
  }
  
  const listStatus = animeInfo.my_list_status;
  const totalEpisodes = animeInfo.num_episodes || 9999;
  const currentStatus = listStatus?.status;
  const currentProgress = listStatus?.num_watched_episodes || 0;
  
  // Determine new status
  let newStatus = currentStatus || 'watching';
  let newProgress = episode;
  
  // Movies are marked as completed immediately
  if (isMovie) {
    newStatus = 'completed';
    newProgress = 1;
    const result = await updateMalStatus(malId, newStatus, newProgress, accessToken);
    return {
      success: true,
      mediaId: malId,
      title: animeInfo.title,
      status: newStatus,
      isCompleted: true
    };
  }
  
  // Status transition logic
  if (currentStatus === 'completed') {
    console.log(`[MAL] Anime ${malId} already completed, skipping`);
    return { skipped: true, reason: 'Already completed' };
  }
  
  // If on_hold, plan_to_watch, or dropped, move to watching
  if (['on_hold', 'plan_to_watch', 'dropped'].includes(currentStatus)) {
    newStatus = 'watching';
  }
  
  // If no status, start watching
  if (!currentStatus) {
    newStatus = 'watching';
  }
  
  // If watched episode >= total episodes and anime is finished airing, mark as completed
  if (episode >= totalEpisodes && animeInfo.status === 'finished_airing') {
    newStatus = 'completed';
    newProgress = totalEpisodes;
  }
  
  // Only update if new progress is higher
  if (newProgress <= currentProgress && newStatus === currentStatus) {
    console.log(`[MAL] Episode ${episode} <= current progress ${currentProgress}, skipping`);
    return { skipped: true, reason: 'Episode already watched' };
  }
  
  const result = await updateMalStatus(malId, newStatus, newProgress, accessToken);
  
  return {
    success: true,
    mediaId: malId,
    title: animeInfo.title,
    previousProgress: currentProgress,
    newProgress: newProgress,
    status: newStatus,
    isCompleted: newStatus === 'completed'
  };
}

const PAGE_SIZE = 100;

// Configure page HTML (embedded for serverless deployment)
const CONFIGURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AnimeStream Configuration</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/png" href="https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/public/logo.png">
<style>
  *,*::before,*::after{box-sizing:border-box}
  :root{
    --bg:#0A0F1C;
    --card:#161737;
    --fg:#EEF1F7;
    --muted:#5F67AD;
    --preview:#5A5F8F;
    --box:#0E0B1F;
    --primary:#3926A6;
    --primary-hover:#5a42d6;
    --border:rgba(255,255,255,.08);
    --shadow:0 28px 96px rgba(0,0,0,.46);
    --radius:26px;
    --ctl-h:50px;
  }
  html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial,"Noto Sans",sans-serif;}
  .wrap{max-width:1100px;margin:56px auto;padding:0 32px;}
  .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:48px;}
  h1{font-weight:800;font-size:38px;letter-spacing:.2px;margin:0 0 8px;text-align:center;}
  .subtle{color:var(--muted);text-align:center;margin:-2px 0 34px;}
  .stack{display:grid;grid-template-columns:1fr;row-gap:22px}
  .section-title{font-weight:600;font-size:18px;margin:0 0 16px;color:var(--fg)}
  .toggles-row{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media (max-width: 900px){ .toggles-row{grid-template-columns:1fr} }
  label{display:block;font-weight:600;font-size:15px;margin:0 0 8px;}
  .control{width:100%;background:var(--box);color:var(--fg);border:1px solid transparent;border-radius:16px;padding:0 16px;height:var(--ctl-h);line-height:calc(var(--ctl-h) - 2px);outline:none;}
  .control:focus{box-shadow:0 0 0 2px rgba(57,38,166,.35);border-color:var(--primary)}
  .control.valid{border-color:rgba(34,197,94,.5);box-shadow:0 0 0 2px rgba(34,197,94,.2)}
  .control.invalid{border-color:rgba(239,68,68,.5);box-shadow:0 0 0 2px rgba(239,68,68,.2)}
  select.control{appearance:none;background-image:linear-gradient(45deg,transparent 50%, var(--preview) 50%),linear-gradient(135deg, var(--preview) 50%, transparent 50%);background-position:calc(100% - 16px) 50%, calc(100% - 11px) 50%;background-size:6px 6px,6px 6px;background-repeat:no-repeat;padding-right:44px}
  .help{color:var(--muted);font-size:13px;margin-top:8px;line-height:1.45}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:18px;border:2px solid transparent;padding:14px 18px;min-width:220px;cursor:pointer;text-decoration:none;color:var(--fg);transition:transform .05s ease, box-shadow .2s ease, background .2s ease, border .2s ease;}
  .btn:active{transform:translateY(1px)}
  .btn-primary{background:var(--primary);border-color:var(--primary)}
  .btn-primary:hover{box-shadow:0 12px 38px rgba(57,38,166,.35);background:var(--primary-hover)}
  .btn-outline{background:transparent;border-color:var(--primary);color:var(--fg)}
  .btn-outline:hover{background:rgba(57,38,166,.08)}
  .btn-sm{min-width:auto;padding:8px 14px;border-radius:12px;border-width:1px;height:40px}
  .toggle-box{display:flex;align-items:center;gap:12px;background:var(--box);border:1px solid transparent;border-radius:16px;padding:12px 16px;height:var(--ctl-h);cursor:pointer;user-select:none;transition:all 0.2s ease}
  .toggle-box:hover{border-color:rgba(57,38,166,.3)}
  .toggle-box input{transform:scale(1.1);accent-color:var(--primary)}
  .toggle-box .label{font-weight:600}
  .buttons{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:32px}
  @media (max-width: 720px){ .buttons{grid-template-columns:1fr} }
  code.inline{background:var(--box);border:1px solid transparent;padding:12px;border-radius:8px;font-size:12px;color:var(--preview);display:flex;align-items:center;word-break:break-all;line-height:1.4;min-height:calc(2 * 1.4em);white-space:pre-wrap;overflow-wrap:anywhere}
  .footline{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-top:16px}
  .manifest-container{flex: 1;min-width:0}
  .manifest-label{color:var(--muted);font-size:14px;margin-bottom:8px;font-weight:500}
  .divider{height:1px;background:var(--border);margin:24px 0}
  .stat{display:inline-block;background:var(--box);padding:4px 12px;border-radius:8px;font-size:13px;color:var(--muted);margin-right:8px}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#22c55e;color:#fff;padding:12px 24px;border-radius:12px;font-weight:600;opacity:0;transition:opacity .3s;z-index:1000}
  .toast.show{opacity:1}
  .toast.error{background:#ef4444}
  .copy-btn{background:var(--primary);border:none;color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;margin-left:8px}
  .copy-btn:hover{background:var(--primary-hover)}
  .manifest-row{display:flex;align-items:center;gap:8px}
  .alt-install{margin-top:12px;font-size:13px;color:var(--muted);text-align:center}
  .alt-install a{color:var(--primary);text-decoration:underline}
  .pill-gap{--pill-gap:10px}
  .pill-h{--pill-h:var(--ctl-h)}
  .lang-controls{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center}
  .pill-grid{display:grid;gap:10px;margin-top:10px;grid-template-columns:repeat(4, 1fr)}
  @media (max-width: 720px){ .pill-grid{grid-template-columns:repeat(2, 1fr)} }
  .pill{display:flex;align-items:center;background:var(--box);border:1px solid transparent;border-radius:16px;height:var(--ctl-h);padding:0 12px;width:100%;overflow:hidden}
  .pill .txt{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pill .handle{opacity:.8;cursor:pointer;font-size:16px;color:#f44336 !important;margin-left:auto;padding-left:12px;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;transition:all 0.2s ease}
  .pill .handle:hover{background:rgba(244,67,54,0.1);transform:scale(1.1)}
  .scrobble-row{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media (max-width: 900px){ .scrobble-row{grid-template-columns:1fr} }
  .input-btn-row{display:flex;gap:10px;align-items:center}
  .input-btn-row .control{flex:1}
  .input-btn-row .btn{height:var(--ctl-h);white-space:nowrap}
  .btn-disabled{opacity:0.6;cursor:not-allowed;pointer-events:none;background:var(--box) !important;border-color:var(--muted) !important;color:var(--muted) !important}
  .scrobble-status{display:flex;align-items:center;gap:10px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);border-radius:12px;padding:8px 12px;margin-top:8px;font-size:13px}
  .scrobble-status .icon{color:#22c55e}
  .scrobble-status .user{font-weight:600;color:#22c55e}
  .scrobble-status .disconnect{background:#ef4444;border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;margin-left:auto}
  .scrobble-status .disconnect:hover{background:#dc2626}
  input::placeholder{color:var(--muted) !important;opacity:1}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>AnimeStream</h1>
      <p class="subtle">Configure your anime addon settings</p>

      <div class="stack">
        <div>
          <div class="section-title">Display Settings</div>
          <div class="toggles-row">
            <div>
              <div id="toggleShowCounts" class="toggle-box" role="button" tabindex="0" aria-pressed="true">
                <input id="showCounts" type="checkbox" checked />
                <div class="label">Show counts on filter options</div>
              </div>
              <div class="help">When enabled, genres and seasons will show item counts like "Action (1467)". Disable for cleaner display.</div>
            </div>

            <div>
              <div id="toggleExcludeLongRunning" class="toggle-box" role="button" tabindex="0" aria-pressed="false">
                <input id="excludeLongRunning" type="checkbox" />
                <div class="label">Exclude long-running anime</div>
              </div>
              <div class="help">Hide long-running anime like One Piece, Detective Conan, etc. from the "Currently Airing" catalog.</div>
            </div>
          </div>
        </div>

        <div>
          <div class="section-title">Hide Catalogs</div>
          <div class="lang-controls">
            <select id="catalogPicker" class="control">
              <option value="">Select catalogs to hide...</option>
              <option value="top">Top Rated</option>
              <option value="season">Season Releases</option>
              <option value="airing">Currently Airing</option>
              <option value="movies">Movies</option>
            </select>
            <button class="btn btn-sm btn-outline" id="catalogAdd" type="button">Add</button>
            <button class="btn btn-sm btn-outline" id="catalogClear" type="button">Clear</button>
          </div>
          <div class="help">Hide catalogs from Stremio. At least one must remain visible.</div>
          <div id="catalogPills" class="pill-grid"></div>
        </div>

        <div>
          <div class="section-title">Scrobbling (Sync Watch Progress)</div>
          <div class="help" style="margin-bottom:12px">Automatically track watched episodes. When you start an episode, it marks it as watched on your tracking account.</div>
          
          <div class="scrobble-row">
            <div>
              <label>AniList</label>
              <button id="anilistAuthBtn" class="btn btn-sm btn-outline" type="button">Login with AniList</button>
              <div id="anilistStatus"></div>
            </div>
            
            <div>
              <label>MyAnimeList</label>
              <button id="malAuthBtn" class="btn btn-sm btn-outline" type="button">Login with MAL</button>
              <div id="malStatus"></div>
            </div>
          </div>
        </div>

        <div>
          <div class="section-title">RAW Anime + Debrid (NEW!)</div>
          <div class="help" style="margin-bottom:12px">Enable torrent streams for RAW (unsubtitled) anime with higher quality. Requires a debrid service subscription for instant streaming.</div>
          
          <div class="toggles-row" style="margin-bottom:12px">
            <div>
              <div id="toggleEnableTorrents" class="toggle-box" role="button" tabindex="0" aria-pressed="true">
                <input id="enableTorrents" type="checkbox" checked />
                <div class="label">Enable torrent streams</div>
              </div>
              <div class="help">Show RAW torrent options alongside regular streams</div>
            </div>
            <div>
              <div id="togglePreferRaw" class="toggle-box" role="button" tabindex="0" aria-pressed="false">
                <input id="preferRaw" type="checkbox" />
                <div class="label">Prefer RAW releases</div>
              </div>
              <div class="help">Sort RAW (no subtitles) releases first</div>
            </div>
          </div>
          
          <div class="scrobble-row">
            <div>
              <label>Debrid Provider</label>
              <select id="debridProvider" class="control">
                <option value="">None (torrents won't play)</option>
                <option value="realdebrid">Real-Debrid</option>
                <option value="alldebrid">AllDebrid</option>
                <option value="premiumize">Premiumize</option>
                <option value="torbox">TorBox</option>
                <option value="debridlink">Debrid-Link</option>
              </select>
              <div class="help">Select your debrid service</div>
            </div>
            
            <div>
              <label>API Key</label>
              <input id="debridApiKey" type="password" class="control" placeholder="Enter your API key" />
              <div class="help">Get from your debrid account settings</div>
            </div>
          </div>
          
          <div id="debridStatus" style="margin-top:8px"></div>
        </div>

        <div>
          <div class="section-title">Database Stats</div>
          <div id="stats"><span class="stat" id="statTotal">Loading...</span></div>
        </div>
      </div>

      <div class="buttons">
        <a id="installApp" href="#" class="btn btn-primary" style="width:100%">Install to Stremio</a>
        <a id="installWeb" href="#" class="btn btn-outline" style="width:100%">Install to Web</a>
      </div>

      <div class="footline">
        <div class="manifest-container">
          <div class="manifest-label">Manifest URL:</div>
          <div class="manifest-row">
            <code id="manifestUrl" class="inline" style="flex:1"></code>
            <button id="copyBtn" class="copy-btn">Copy</button>
          </div>
        </div>
      </div>

      <div class="alt-install">
        Install not working? <a id="altInstallLink" href="#" target="_blank">Click here to install via Stremio website</a>
      </div>
    </div>

    <div style="text-align:center;margin-top:24px;color:var(--muted);font-size:13px">
      AnimeStream v1.3.0 • 7,000+ anime • RAW + Debrid + Soft Subtitles
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
  (function(){
    'use strict';
    const originHost = window.location.origin;
    const state = { 
      showCounts: true, 
      excludeLongRunning: false, 
      hiddenCatalogs: [], 
      userId: '',
      // Debrid settings
      enableTorrents: true,
      preferRaw: false,
      debridProvider: '',
      debridApiKey: ''
    };
    
    function persist() { localStorage.setItem('animestream_config', JSON.stringify(state)); }
    
    try { Object.assign(state, JSON.parse(localStorage.getItem('animestream_config') || '{}')); } catch {}
    
    // Load from URL path config
    const pathMatch = window.location.pathname.match(/^\\/([^\\/]+)\\/configure/);
    if (pathMatch) {
      const configStr = decodeURIComponent(pathMatch[1]);
      configStr.split('&').forEach(part => {
        const [key, value] = part.split('=');
        if (key === 'showCounts') state.showCounts = value !== '0';
        if (key === 'excludeLongRunning') state.excludeLongRunning = value === '1';
        if (key === 'hc' && value) state.hiddenCatalogs = value.split(',').filter(c => ['top','season','airing','movies'].includes(c));
        if (key === 'uid' && value) state.userId = value;
        if (key === 'tor' && value === '0') state.enableTorrents = false;
        if (key === 'raw' && value === '1') state.preferRaw = true;
        if (key === 'dp' && value) state.debridProvider = value;
        if (key === 'dk' && value) state.debridApiKey = decodeURIComponent(value);
      });
      persist();
    }
    
    const $ = sel => document.querySelector(sel);
    const showCountsEl = $('#showCounts');
    const excludeLongRunningEl = $('#excludeLongRunning');
    const catalogPicker = $('#catalogPicker');
    const catalogAddBtn = $('#catalogAdd');
    const catalogClearBtn = $('#catalogClear');
    const catalogPillsEl = $('#catalogPills');
    const manifestEl = $('#manifestUrl');
    const appBtn = $('#installApp');
    const webBtn = $('#installWeb');
    const statsEl = $('#stats');
    const copyBtn = $('#copyBtn');
    const altInstallLink = $('#altInstallLink');
    const toast = $('#toast');
    const anilistStatusEl = $('#anilistStatus');
    
    // Debrid elements
    const enableTorrentsEl = $('#enableTorrents');
    const preferRawEl = $('#preferRaw');
    const debridProviderEl = $('#debridProvider');
    const debridApiKeyEl = $('#debridApiKey');
    const debridStatusEl = $('#debridStatus');
    
    const CATALOG_NAMES = { top: 'Top Rated', season: 'Season Releases', airing: 'Currently Airing', movies: 'Movies' };
    
    showCountsEl.checked = state.showCounts !== false;
    excludeLongRunningEl.checked = state.excludeLongRunning === true;
    
    // Initialize debrid settings
    if (enableTorrentsEl) enableTorrentsEl.checked = state.enableTorrents !== false;
    if (preferRawEl) preferRawEl.checked = state.preferRaw === true;
    if (debridProviderEl) debridProviderEl.value = state.debridProvider || '';
    if (debridApiKeyEl) debridApiKeyEl.value = state.debridApiKey || '';
    
    function showToast(msg, isError) {
      toast.textContent = msg;
      toast.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => { toast.className = 'toast'; }, 3000);
    }
    
    async function fetchStats() {
      try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        statsEl.innerHTML = '<span class="stat">Total: ' + (data.totalAnime?.toLocaleString() || '?') + ' anime</span>' +
          '<span class="stat">Series: ' + (data.totalSeries?.toLocaleString() || '?') + '</span>' +
          '<span class="stat">Movies: ' + (data.totalMovies?.toLocaleString() || '?') + '</span>';
      } catch { statsEl.innerHTML = '<span class="stat">7,000+ anime</span>'; }
    }
    
    // ===== CATALOG BLACKLIST =====
    function renderCatalogPills() {
      catalogPillsEl.innerHTML = state.hiddenCatalogs.map(key => 
        '<div class="pill" data-key="' + key + '"><span class="txt">' + (CATALOG_NAMES[key] || key) + '</span><span class="handle" title="Remove">✕</span></div>'
      ).join('');
      
      // Update dropdown - hide already selected items
      Array.from(catalogPicker.options).forEach(opt => {
        if (opt.value) opt.disabled = state.hiddenCatalogs.includes(opt.value);
      });
      catalogPicker.value = '';
      
      // Attach remove handlers
      catalogPillsEl.querySelectorAll('.handle').forEach(handle => {
        handle.onclick = () => {
          const key = handle.parentElement.dataset.key;
          state.hiddenCatalogs = state.hiddenCatalogs.filter(c => c !== key);
          persist();
          renderCatalogPills();
          rerender();
        };
      });
    }
    
    catalogAddBtn.onclick = () => {
      const val = catalogPicker.value;
      if (!val) return;
      
      // Ensure at least 1 catalog remains visible
      if (state.hiddenCatalogs.length >= 3) {
        showToast('At least one catalog must remain visible', true);
        return;
      }
      
      if (!state.hiddenCatalogs.includes(val)) {
        state.hiddenCatalogs.push(val);
        persist();
        renderCatalogPills();
        rerender();
      }
    };
    
    catalogClearBtn.onclick = () => {
      state.hiddenCatalogs = [];
      persist();
      renderCatalogPills();
      rerender();
    };
    
    renderCatalogPills();
    
    showCountsEl.onchange = () => { state.showCounts = showCountsEl.checked; persist(); rerender(); };
    excludeLongRunningEl.onchange = () => { state.excludeLongRunning = excludeLongRunningEl.checked; persist(); rerender(); };
    
    function wireToggle(boxId, inputEl) {
      const box = document.getElementById(boxId);
      if (!box) return;
      box.addEventListener('click', (e) => { if (e.target !== inputEl) { inputEl.checked = !inputEl.checked; inputEl.dispatchEvent(new Event('change')); } });
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputEl.checked = !inputEl.checked; inputEl.dispatchEvent(new Event('change')); } });
    }
    wireToggle('toggleShowCounts', showCountsEl);
    wireToggle('toggleExcludeLongRunning', excludeLongRunningEl);
    
    // ===== ANILIST SCROBBLING =====
    const ANILIST_CLIENT_ID = '34748'; // Hardcoded - users don't need to create apps
    const anilistAuthBtn = $('#anilistAuthBtn');
    // anilistStatusEl already declared above
    let anilistToken = localStorage.getItem('animestream_anilist_token') || '';
    let anilistUser = null;
    let anilistUserId = null;
    
    function renderAnilistStatus() {
      if (anilistUser && anilistToken) {
        anilistStatusEl.innerHTML = '<div class="scrobble-status">' +
          '<span class="icon">✓</span>' +
          '<span>Connected as <span class="user">' + anilistUser + '</span></span>' +
          '<button class="disconnect" id="anilistDisconnect">Disconnect</button></div>';
        
        $('#anilistDisconnect').onclick = async () => {
          // Clear server-side tokens if we have a user ID
          if (state.userId) {
            try { await fetch('/api/user/' + state.userId + '/disconnect', { method: 'POST', body: JSON.stringify({ service: 'anilist' }) }); } catch {}
          }
          localStorage.removeItem('animestream_anilist_token');
          anilistToken = '';
          anilistUser = null;
          anilistUserId = null;
          renderAnilistStatus();
          rerender();
          showToast('AniList disconnected');
        };
        anilistAuthBtn.style.display = 'none';
      } else {
        anilistStatusEl.innerHTML = '';
        anilistAuthBtn.style.display = '';
      }
    }
    
    // Check existing token validity and save to server
    async function checkAnilistConnection() {
      if (!anilistToken) {
        renderAnilistStatus();
        return;
      }
      
      try {
        const res = await fetch('/api/anilist/user', {
          headers: { 'Authorization': 'Bearer ' + anilistToken }
        });
        const data = await res.json();
        if (data.user && data.user.name) {
          anilistUser = data.user.name;
          anilistUserId = data.user.id;
          
          // Generate user ID if not exists and save tokens to server
          if (!state.userId && anilistUserId) {
            state.userId = 'al_' + anilistUserId;
            persist();
          }
          
          // Save tokens to server for scrobbling
          await saveTokensToServer();
        } else {
          localStorage.removeItem('animestream_anilist_token');
          anilistToken = '';
        }
      } catch {}
      renderAnilistStatus();
      rerender();
    }
    
    // Save tokens to server (KV storage)
    async function saveTokensToServer() {
      if (!state.userId) return;
      
      const tokens = {};
      if (anilistToken) tokens.anilistToken = anilistToken;
      if (anilistUserId) tokens.anilistUserId = anilistUserId;
      if (anilistUser) tokens.anilistUser = anilistUser;
      if (malToken) tokens.malToken = malToken;
      if (malUser) tokens.malUser = malUser;
      
      try {
        await fetch('/api/user/' + state.userId + '/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tokens)
        });
      } catch (err) {
        console.error('Failed to save tokens:', err);
      }
    }
    
    function startAnilistAuth() {
      // Redirect to AniList OAuth - will redirect back with token in URL hash
      const authUrl = 'https://anilist.co/api/v2/oauth/authorize?client_id=' + ANILIST_CLIENT_ID + '&response_type=token';
      window.location.href = authUrl;
    }
    
    anilistAuthBtn.onclick = startAnilistAuth;
    
    // Handle OAuth token from URL hash (after redirect back)
    function checkUrlForAnilistToken() {
      const hash = window.location.hash;
      if (hash && hash.includes('access_token=')) {
        const match = hash.match(/access_token=([^&]+)/);
        if (match && match[1]) {
          const token = match[1];
          localStorage.setItem('animestream_anilist_token', token);
          anilistToken = token;
          // Clear the hash from URL
          history.replaceState(null, '', window.location.pathname + window.location.search);
          showToast('AniList connected! Syncing tokens...');
          checkAnilistConnection();
        }
      }
    }
    
    // ===== MYANIMELIST SCROBBLING =====
    const MAL_CLIENT_ID = 'e1c53f5d91d73133d628b7e2f56df992';
    const malAuthBtn = $('#malAuthBtn');
    const malStatusEl = $('#malStatus');
    let malToken = localStorage.getItem('animestream_mal_token') || '';
    let malUser = null;
    let malUserId = null;
    
    function renderMalStatus() {
      if (malUser && malToken) {
        malStatusEl.innerHTML = '<div class="scrobble-status">' +
          '<span class="icon">✓</span>' +
          '<span>Connected as <span class="user">' + malUser + '</span></span>' +
          '<button class="disconnect" id="malDisconnect">Disconnect</button></div>';
        
        $('#malDisconnect').onclick = async () => {
          // Clear server-side tokens if we have a user ID
          if (state.userId) {
            try { await fetch('/api/user/' + state.userId + '/disconnect', { method: 'POST', body: JSON.stringify({ service: 'mal' }) }); } catch {}
          }
          localStorage.removeItem('animestream_mal_token');
          localStorage.removeItem('animestream_mal_code_verifier');
          malToken = '';
          malUser = null;
          malUserId = null;
          renderMalStatus();
          rerender();
          showToast('MyAnimeList disconnected');
        };
        malAuthBtn.style.display = 'none';
      } else {
        malStatusEl.innerHTML = '';
        malAuthBtn.style.display = '';
      }
    }
    
    // MAL uses PKCE OAuth2 flow
    function generateCodeVerifier() {
      const array = new Uint8Array(32);
      crypto.getRandomValues(array);
      return btoa(String.fromCharCode.apply(null, array)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }
    
    async function generateCodeChallenge(verifier) {
      // MAL uses plain code challenge (code_challenge = code_verifier)
      return verifier;
    }
    
    function startMalAuth() {
      const codeVerifier = generateCodeVerifier();
      localStorage.setItem('animestream_mal_code_verifier', codeVerifier);
      
      const authUrl = 'https://myanimelist.net/v1/oauth2/authorize?' +
        'response_type=code&' +
        'client_id=' + MAL_CLIENT_ID + '&' +
        'code_challenge=' + codeVerifier + '&' +
        'code_challenge_method=plain&' +
        'redirect_uri=' + encodeURIComponent(window.location.origin + '/mal/callback');
      
      window.location.href = authUrl;
    }
    
    malAuthBtn.onclick = startMalAuth;
    
    // Check for MAL OAuth code in URL (after redirect)
    async function checkUrlForMalCode() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const isMalCallback = params.get('mal_callback') === '1';
      
      if (code && isMalCallback) {
        const codeVerifier = localStorage.getItem('animestream_mal_code_verifier');
        if (!codeVerifier) {
          showToast('MAL auth failed: missing code verifier', true);
          // Clean up URL
          history.replaceState(null, '', '/configure');
          return;
        }
        
        try {
          // Exchange code for token via our API endpoint
          const res = await fetch('/api/mal/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, codeVerifier, redirectUri: window.location.origin + '/mal/callback' })
          });
          const data = await res.json();
          
          if (data.access_token) {
            localStorage.setItem('animestream_mal_token', data.access_token);
            malToken = data.access_token;
            localStorage.removeItem('animestream_mal_code_verifier');
            showToast('MyAnimeList connected successfully!');
            // Clean up URL
            history.replaceState(null, '', '/configure');
            checkMalConnection();
            return;
          } else {
            showToast('MAL auth failed: ' + (data.error || 'unknown error'), true);
          }
        } catch (err) {
          showToast('MAL auth failed: ' + err.message, true);
        }
        // Clean up URL on error too
        history.replaceState(null, '', '/configure');
      }
    }
    
    async function checkMalConnection() {
      if (!malToken) {
        renderMalStatus();
        return;
      }
      
      try {
        const res = await fetch('/api/mal/user', {
          headers: { 'Authorization': 'Bearer ' + malToken }
        });
        const data = await res.json();
        if (data.user && data.user.name) {
          malUser = data.user.name;
          malUserId = data.user.id;
          
          // Generate user ID if not exists (prefer AniList ID if available)
          if (!state.userId && malUserId) {
            state.userId = 'mal_' + malUserId;
            persist();
          }
          
          // Save tokens to server for scrobbling
          await saveTokensToServer();
        } else {
          localStorage.removeItem('animestream_mal_token');
          malToken = '';
        }
      } catch {}
      renderMalStatus();
      rerender();
    }
    
    // Initialize - check for OAuth tokens in URL first
    checkUrlForMalCode();
    checkUrlForAnilistToken();
    checkAnilistConnection();
    checkMalConnection();
    
    // ===== DEBRID SETTINGS HANDLERS =====
    function updateDebridStatus() {
      if (!debridStatusEl) return;
      
      if (state.debridProvider && state.debridApiKey) {
        const providerNames = {
          realdebrid: 'Real-Debrid',
          alldebrid: 'AllDebrid',
          premiumize: 'Premiumize',
          torbox: 'TorBox',
          debridlink: 'Debrid-Link'
        };
        debridStatusEl.innerHTML = '<div class="scrobble-status">' +
          '<span class="icon">✓</span>' +
          '<span>Configured: <span class="user">' + (providerNames[state.debridProvider] || state.debridProvider) + '</span></span>' +
          '</div>';
      } else if (state.enableTorrents) {
        debridStatusEl.innerHTML = '<div class="help" style="color:#f59e0b">⚠️ Torrent streams enabled but no debrid configured. Torrents will show but won\\'t play.</div>';
      } else {
        debridStatusEl.innerHTML = '';
      }
    }
    
    if (enableTorrentsEl) {
      enableTorrentsEl.onchange = () => {
        state.enableTorrents = enableTorrentsEl.checked;
        persist();
        updateDebridStatus();
        rerender();
      };
      wireToggle('toggleEnableTorrents', enableTorrentsEl);
    }
    
    if (preferRawEl) {
      preferRawEl.onchange = () => {
        state.preferRaw = preferRawEl.checked;
        persist();
        rerender();
      };
      wireToggle('togglePreferRaw', preferRawEl);
    }
    
    if (debridProviderEl) {
      debridProviderEl.onchange = () => {
        state.debridProvider = debridProviderEl.value;
        persist();
        updateDebridStatus();
        rerender();
      };
    }
    
    if (debridApiKeyEl) {
      debridApiKeyEl.onchange = () => {
        state.debridApiKey = debridApiKeyEl.value.trim();
        persist();
        updateDebridStatus();
        rerender();
      };
      // Also update on blur for better UX
      debridApiKeyEl.onblur = debridApiKeyEl.onchange;
    }
    
    // Initial debrid status
    updateDebridStatus();
    
    function buildConfigPath() {
      const parts = [];
      if (!state.showCounts) parts.push('showCounts=0');
      if (state.excludeLongRunning) parts.push('excludeLongRunning=1');
      if (state.hiddenCatalogs.length > 0) parts.push('hc=' + state.hiddenCatalogs.join(','));
      // Include user ID for scrobbling (tokens stored server-side in KV)
      if (state.userId) parts.push('uid=' + state.userId);
      // Debrid settings
      if (!state.enableTorrents) parts.push('tor=0');
      if (state.preferRaw) parts.push('raw=1');
      if (state.debridProvider) parts.push('dp=' + state.debridProvider);
      if (state.debridApiKey) parts.push('dk=' + encodeURIComponent(state.debridApiKey));
      return parts.join('&');
    }
    
    // Copy manifest URL to clipboard
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(manifestEl.textContent);
        showToast('Copied! Paste in Stremio > Addons > Add Addon URL');
      } catch {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = manifestEl.textContent;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Copied! Paste in Stremio > Addons > Add Addon URL');
      }
    };
    
    // Handle install button click with error detection
    appBtn.onclick = (e) => {
      const stremioUrl = appBtn.href;
      
      // Try to detect if stremio:// protocol fails
      // Set a flag, wait briefly, if page is still visible protocol likely failed
      let didNavigate = false;
      const checkTimer = setTimeout(() => {
        if (!didNavigate && document.visibilityState === 'visible') {
          showToast('Stremio not detected. Try Copy button or Web install.', true);
        }
      }, 1500);
      
      document.addEventListener('visibilitychange', function handler() {
        if (document.visibilityState === 'hidden') {
          didNavigate = true;
          clearTimeout(checkTimer);
          document.removeEventListener('visibilitychange', handler);
        }
      });
      
      // Let the default link behavior proceed
    };
    
    function rerender() {
      const configPath = buildConfigPath();
      const manifestUrl = configPath ? originHost + '/' + configPath + '/manifest.json' : originHost + '/manifest.json';
      manifestEl.textContent = manifestUrl;
      appBtn.href = configPath ? 'stremio://' + window.location.host + '/' + configPath + '/manifest.json' : 'stremio://' + window.location.host + '/manifest.json';
      webBtn.href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);
      altInstallLink.href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);
    }
    
    fetchStats();
    rerender();
  })();
  </script>
</body>
</html>`;

// AllAnime API endpoint (direct integration, no separate worker)
const ALLANIME_API = 'https://api.allanime.day/api';
const ALLANIME_BASE = 'https://allanime.to';

// ===== DATA CACHE (in-memory per worker instance) =====
// Simple in-memory cache - each worker instance maintains its own cache
// Combined with HTTP Cache-Control headers, this provides multi-layer caching:
// 1. In-memory cache (instant, per worker instance)
// 2. Cloudflare edge cache (via Cache-Control headers, shared across requests)
// 3. Browser cache (via Cache-Control headers, per user)
let catalogCache = null;
let filterOptionsCache = null;
let cacheTimestamp = 0;

// AllAnime search results cache (reduces API calls for repeated searches)
const allAnimeSearchCache = new Map();
const ALLANIME_SEARCH_CACHE_TTL = 300000; // 5 minutes
const MAX_SEARCH_CACHE_SIZE = 100;

// Helper to get/set AllAnime search cache
function getCachedSearch(query) {
  const cached = allAnimeSearchCache.get(query.toLowerCase());
  if (cached && Date.now() - cached.time < ALLANIME_SEARCH_CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCachedSearch(query, data) {
  // Limit cache size to prevent memory issues
  if (allAnimeSearchCache.size >= MAX_SEARCH_CACHE_SIZE) {
    const oldestKey = allAnimeSearchCache.keys().next().value;
    allAnimeSearchCache.delete(oldestKey);
  }
  allAnimeSearchCache.set(query.toLowerCase(), { data, time: Date.now() });
}

// ===== ALLANIME API HELPERS =====

// Build headers that mimic a real browser for AllAnime API
function buildBrowserHeaders(referer = null) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': ALLANIME_BASE,
    'Referer': referer || ALLANIME_BASE,
  };
}

/**
 * Decode AllAnime's XOR-encrypted URLs
 * They use hex encoding with XOR key 56 (0x38)
 */
function decryptSourceUrl(input) {
  if (!input) return null;
  if (input.startsWith('http')) return normalizeUrl(input);
  
  const str = input.startsWith('--') ? input.slice(2) : input;
  if (!/^[0-9a-fA-F]+$/.test(str)) return input;
  
  let result = '';
  for (let i = 0; i < str.length; i += 2) {
    const num = parseInt(str.substr(i, 2), 16);
    result += String.fromCharCode(num ^ 56);
  }
  
  if (result.startsWith('/api')) return null;
  return normalizeUrl(result);
}

// Fix double slashes and normalize URLs
function normalizeUrl(url) {
  if (!url) return url;
  // Fix double slashes after domain (but not after protocol)
  return url.replace(/([^:]\/)\/+/g, '$1');
}

// Extract quality from source name or URL
function detectQuality(sourceName, url) {
  const text = `${sourceName} ${url}`.toLowerCase();
  if (/2160p|4k|uhd/i.test(text)) return '4K';
  if (/1080p|fhd|fullhd/i.test(text)) return '1080p';
  if (/720p|hd/i.test(text)) return '720p';
  if (/480p|sd/i.test(text)) return '480p';
  return 'HD';
}

// Strip HTML tags from text
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Convert Stremio season:episode to AllAnime absolute episode number
 * 
 * Cinemeta/IMDB splits long-running anime into seasons based on arcs,
 * but AllAnime uses continuous episode numbering (e.g., One Piece has 1150+ episodes as season 1)
 * 
 * This mapping converts Stremio's S22E68 format to AllAnime's absolute E1153 format
 */
const EPISODE_SEASON_MAPPINGS = {
  // ===========================================
  // ONE PIECE (tt0388629) - 1150+ episodes
  // VERIFIED mapping from Cinemeta seasons to AllAnime absolute episodes
  // S21E1 = "The Land of Wano!" = Episode 892
  // S22E1 = "A New Emperor! Buggy" = Episode 1086
  // ===========================================
  'tt0388629': {
    seasons: [
      { season: 1, start: 1, end: 8 },         // Romance Dawn
      { season: 2, start: 9, end: 30 },        // Orange Town/Syrup Village
      { season: 3, start: 31, end: 47 },       // Baratie/Arlong Park
      { season: 4, start: 48, end: 60 },       // Arlong Park cont./Loguetown
      { season: 5, start: 61, end: 69 },       // Reverse Mountain/Whisky Peak
      { season: 6, start: 70, end: 91 },       // Little Garden/Drum Island
      { season: 7, start: 92, end: 130 },      // Alabasta
      { season: 8, start: 131, end: 143 },     // Post-Alabasta
      { season: 9, start: 144, end: 195 },     // Skypiea
      { season: 10, start: 196, end: 226 },    // Long Ring Long Land/G-8
      { season: 11, start: 227, end: 325 },    // Water 7/Enies Lobby
      { season: 12, start: 326, end: 381 },    // Thriller Bark
      { season: 13, start: 382, end: 481 },    // Sabaody/Impel Down
      { season: 14, start: 482, end: 516 },    // Marineford
      { season: 15, start: 517, end: 578 },    // Post-War
      { season: 16, start: 579, end: 627 },    // Fishman Island
      { season: 17, start: 628, end: 745 },    // Punk Hazard/Dressrosa
      { season: 18, start: 746, end: 778 },    // Zou
      { season: 19, start: 779, end: 877 },    // Whole Cake Island
      { season: 20, start: 878, end: 891 },    // Reverie
      { season: 21, start: 892, end: 1085 },   // Wano Country (VERIFIED: S21E1 = Ep 892)
      { season: 22, start: 1086, end: 1155 },  // Egghead (VERIFIED: S22E1 = Ep 1086)
      { season: 23, start: 1156, end: 9999 },  // Current arc (ongoing)
    ],
    totalSeasons: 23
  },

  // ===========================================
  // DRAGON BALL Z (tt0214341) - 291 episodes
  // Cinemeta: S1:39, S2:35, S3:33, S4:32, S5:26, S6:29, S7:25, S8:34, S9:38
  // ===========================================
  'tt0214341': {
    seasons: [
      { season: 1, start: 1, end: 39 },      // Saiyan Saga
      { season: 2, start: 40, end: 74 },     // Namek Saga
      { season: 3, start: 75, end: 107 },    // Captain Ginyu Saga
      { season: 4, start: 108, end: 139 },   // Frieza Saga
      { season: 5, start: 140, end: 165 },   // Garlic Jr. Saga
      { season: 6, start: 166, end: 194 },   // Trunks/Android Saga
      { season: 7, start: 195, end: 219 },   // Imperfect Cell Saga
      { season: 8, start: 220, end: 253 },   // Cell Games Saga
      { season: 9, start: 254, end: 291 },   // Buu Saga
    ],
    totalSeasons: 9
  },

  // ===========================================
  // NARUTO (tt0409591) - 220 episodes
  // Cinemeta: S1:35, S2:48, S3:48, S4:48, S5:41
  // ===========================================
  'tt0409591': {
    seasons: [
      { season: 1, start: 1, end: 35 },      // Land of Waves/Chunin Exam
      { season: 2, start: 36, end: 83 },     // Chunin Exam Finals
      { season: 3, start: 84, end: 131 },    // Tsunade Search/Sasuke Retrieval
      { season: 4, start: 132, end: 179 },   // Filler arcs
      { season: 5, start: 180, end: 220 },   // Filler arcs/Final
    ],
    totalSeasons: 5
  },

  // ===========================================
  // NARUTO SHIPPUDEN (tt0988824) - 500 episodes
  // Cinemeta uses 22 seasons with varying episode counts
  // ===========================================
  'tt0988824': {
    seasons: [
      { season: 1, start: 1, end: 32 },
      { season: 2, start: 33, end: 53 },
      { season: 3, start: 54, end: 71 },
      { season: 4, start: 72, end: 88 },
      { season: 5, start: 89, end: 112 },
      { season: 6, start: 113, end: 143 },
      { season: 7, start: 144, end: 151 },
      { season: 8, start: 152, end: 175 },
      { season: 9, start: 176, end: 196 },
      { season: 10, start: 197, end: 222 },
      { season: 11, start: 223, end: 242 },
      { season: 12, start: 243, end: 260 },
      { season: 13, start: 261, end: 295 },
      { season: 14, start: 296, end: 320 },
      { season: 15, start: 321, end: 348 },
      { season: 16, start: 349, end: 361 },
      { season: 17, start: 362, end: 393 },
      { season: 18, start: 394, end: 413 },
      { season: 19, start: 414, end: 431 },
      { season: 20, start: 432, end: 450 },
      { season: 21, start: 451, end: 458 },
      { season: 22, start: 459, end: 500 },
    ],
    totalSeasons: 22
  },

  // ===========================================
  // BLEACH (tt0434665) - 366 + TYBW episodes
  // Cinemeta uses 16 seasons for original + TYBW
  // ===========================================
  'tt0434665': {
    seasons: [
      { season: 1, start: 1, end: 20 },      // Agent of Shinigami
      { season: 2, start: 21, end: 41 },     // Soul Society: Entry
      { season: 3, start: 42, end: 63 },     // Soul Society: Rescue
      { season: 4, start: 64, end: 91 },     // Bount arc (filler)
      { season: 5, start: 92, end: 109 },    // Assault on Hueco Mundo
      { season: 6, start: 110, end: 131 },   // Arrancar arc
      { season: 7, start: 132, end: 151 },   // Arrancar vs Shinigami
      { season: 8, start: 152, end: 167 },   // Past arc
      { season: 9, start: 168, end: 189 },   // Hueco Mundo arc
      { season: 10, start: 190, end: 205 },  // Arrancar Battle
      { season: 11, start: 206, end: 212 },  // Past arc 2
      { season: 12, start: 213, end: 229 },  // Fake Karakura Town
      { season: 13, start: 230, end: 265 },  // Zanpakuto arc (filler)
      { season: 14, start: 266, end: 316 },  // Arrancar Finale
      { season: 15, start: 317, end: 342 },  // Gotei 13 Invasion
      { season: 16, start: 343, end: 366 },  // Fullbring arc
      // TYBW continues as season 17+ in Cinemeta
      { season: 17, start: 367, end: 390 },  // Thousand-Year Blood War Part 1
      { season: 18, start: 391, end: 9999 }, // TYBW continuation
    ],
    totalSeasons: 18
  },

  // ===========================================
  // FAIRY TAIL (tt1528406) - 328 episodes
  // Cinemeta: S1:48, S2:48, S3:54, S4:25, S5:51, S6:39, S7:12, S8:51
  // ===========================================
  'tt1528406': {
    seasons: [
      { season: 1, start: 1, end: 48 },      // Macao/Daybreak/Lullaby
      { season: 2, start: 49, end: 96 },     // Phantom Lord/Tower of Heaven
      { season: 3, start: 97, end: 150 },    // Battle of Fairy Tail/Oración Seis
      { season: 4, start: 151, end: 175 },   // Edolas arc
      { season: 5, start: 176, end: 226 },   // Tenrou Island/X791
      { season: 6, start: 227, end: 265 },   // Grand Magic Games
      { season: 7, start: 266, end: 277 },   // Eclipse/Sun Village
      { season: 8, start: 278, end: 328 },   // Tartaros/Avatar/Alvarez
    ],
    totalSeasons: 8
  },

  // ===========================================
  // HUNTER X HUNTER 2011 (tt2098220) - 148 episodes
  // Cinemeta: S1:58, S2:78, S3:12
  // ===========================================
  'tt2098220': {
    seasons: [
      { season: 1, start: 1, end: 58 },      // Hunter Exam/Heavens Arena/Yorknew
      { season: 2, start: 59, end: 136 },    // Greed Island/Chimera Ant
      { season: 3, start: 137, end: 148 },   // Election arc
    ],
    totalSeasons: 3
  },

  // ===========================================
  // DRAGON BALL SUPER (tt4644488) - 131 episodes
  // Cinemeta: S1:14, S2:13, S3:19, S4:30, S5:55
  // ===========================================
  'tt4644488': {
    seasons: [
      { season: 1, start: 1, end: 14 },      // God of Destruction Beerus
      { season: 2, start: 15, end: 27 },     // Golden Frieza
      { season: 3, start: 28, end: 46 },     // Universe 6
      { season: 4, start: 47, end: 76 },     // Future Trunks
      { season: 5, start: 77, end: 131 },    // Tournament of Power
    ],
    totalSeasons: 5
  },

  // ===========================================
  // DETECTIVE CONAN / CASE CLOSED (tt0131179)
  // 1100+ episodes - Cinemeta uses continuous numbering
  // ===========================================
  'tt0131179': {
    seasons: [
      { season: 1, start: 1, end: 999999 }  // Treat as continuous
    ],
    totalSeasons: 1
  },

  // ===========================================
  // BORUTO (tt6342474) - 293 episodes
  // Cinemeta uses single season
  // ===========================================
  'tt6342474': {
    seasons: [
      { season: 1, start: 1, end: 293 }
    ],
    totalSeasons: 1
  },
};

function convertToAbsoluteEpisode(imdbId, season, episode) {
  const mapping = EPISODE_SEASON_MAPPINGS[imdbId];
  
  if (!mapping) {
    // No special mapping needed - return episode as-is
    // For most anime, Stremio uses season 1 with continuous episodes
    return episode;
  }
  
  // Find the season mapping
  const seasonData = mapping.seasons.find(s => s.season === season);
  
  if (!seasonData) {
    console.log(`No season mapping for ${imdbId} S${season}, using episode ${episode} as-is`);
    return episode;
  }
  
  // Calculate absolute episode: season_start + (episode - 1)
  const absoluteEpisode = seasonData.start + (episode - 1);
  
  // Validate it's within the season range
  if (absoluteEpisode > seasonData.end) {
    console.log(`Episode ${episode} exceeds season ${season} range (max: ${seasonData.end - seasonData.start + 1}), capping to ${seasonData.end}`);
    return seasonData.end;
  }
  
  return absoluteEpisode;
}

// Check if URL is a direct video stream
function isDirectStream(url) {
  if (/\.(mp4|m3u8|mkv|webm)(\?|$)/i.test(url)) return true;
  if (/fast4speed\.rsvp/i.test(url)) return true;
  return false;
}

/**
 * Search AllAnime for shows matching a query
 * Uses in-memory cache to reduce API calls
 */
async function searchAllAnime(searchQuery, limit = 10) {
  // Check cache first
  const cacheKey = `${searchQuery}:${limit}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    console.log(`AllAnime search cache hit: "${searchQuery}"`);
    return cached;
  }

  const query = `
    query ($search: SearchInput!, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType, $countryOrigin: VaildCountryOriginEnumType) {
      shows(search: $search, limit: $limit, page: $page, translationType: $translationType, countryOrigin: $countryOrigin) {
        edges { _id name englishName nativeName type score status episodeCount malId aniListId }
      }
    }
  `;

  try {
    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: {
          search: { query: searchQuery, allowAdult: false, allowUnknown: false },
          limit,
          page: 1,
          translationType: 'sub',
          countryOrigin: 'JP',
        },
      }),
    });

    if (!response.ok) return [];
    
    const data = await response.json();
    const shows = data?.data?.shows?.edges || [];
    
    const results = shows.map(show => ({
      id: show._id,
      title: show.englishName || show.name,
      nativeTitle: show.nativeName,
      type: show.type,
      score: show.score,
      malId: show.malId ? parseInt(show.malId) : null,
      aniListId: show.aniListId ? parseInt(show.aniListId) : null,
    }));
    
    // Cache the results
    setCachedSearch(cacheKey, results);
    return results;
  } catch (e) {
    console.error('AllAnime search error:', e.message);
    return [];
  }
}

/**
 * Get episode sources from AllAnime
 */
async function getEpisodeSources(showId, episode) {
  const query = `
    query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) {
      episode(showId: $showId, translationType: $translationType, episodeString: $episodeString) {
        episodeString
        sourceUrls
      }
    }
  `;

  const streams = [];

  for (const translationType of ['sub', 'dub']) {
    try {
      const response = await fetch(ALLANIME_API, {
        method: 'POST',
        headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          variables: { showId, translationType, episodeString: String(episode) },
        }),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const episodeData = data?.data?.episode;
      if (!episodeData?.sourceUrls) continue;

      for (const source of episodeData.sourceUrls) {
        if (!source.sourceUrl) continue;

        const decodedUrl = decryptSourceUrl(source.sourceUrl);
        if (!decodedUrl || !decodedUrl.startsWith('http')) continue;
        if (decodedUrl.includes('listeamed.net')) continue;

        const isDirect = isDirectStream(decodedUrl);
        
        // Only include direct streams for now (Stremio can play these)
        if (!isDirect) continue;

        streams.push({
          url: decodedUrl,
          quality: detectQuality(source.sourceName, decodedUrl),
          provider: source.sourceName || 'AllAnime',
          type: translationType.toUpperCase(),
          isDirect: true,
          behaviorHints: decodedUrl.includes('fast4speed') ? {
            notWebReady: true,
            bingeGroup: `allanime-${showId}`,
            proxyHeaders: { request: { 'Referer': 'https://allanime.to/' } }
          } : undefined,
        });
      }
    } catch (e) {
      console.error(`Error fetching ${translationType}:`, e.message);
    }
  }

  return streams;
}

// ===== ALLANIME SHOW DETAILS =====

/**
 * Get full show details from AllAnime including available episodes
 */
async function getAllAnimeShowDetails(showId) {
  const query = `
    query ($showId: String!) {
      show(_id: $showId) {
        _id
        name
        englishName
        nativeName
        description
        type
        status
        score
        episodeCount
        thumbnail
        banner
        genres
        studios
        availableEpisodesDetail
      }
    }
  `;

  try {
    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: { ...buildBrowserHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { showId } }),
    });

    if (!response.ok) return null;
    
    const data = await response.json();
    return data?.data?.show || null;
  } catch (e) {
    console.error('AllAnime show details error:', e.message);
    return null;
  }
}

// ===== CINEMETA FALLBACK =====

/**
 * Fetch anime metadata from Cinemeta when not in our catalog
 * This allows us to provide streams for anime that users find via other addons
 * Returns full metadata including poster, description, etc.
 */
async function fetchCinemetaMeta(imdbId, type = 'series') {
  try {
    const cinemetaType = type === 'movie' ? 'movie' : 'series';
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${cinemetaType}/${imdbId}.json`, {
      headers: buildBrowserHeaders()
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data?.meta?.name) return null;
    
    const meta = data.meta;
    
    // Return full metadata that might be useful
    return {
      id: imdbId,
      name: meta.name,
      type: cinemetaType,
      poster: meta.poster || null,
      background: meta.background || null,
      description: meta.description || null,
      genres: meta.genres || [],
      releaseInfo: meta.releaseInfo || null,
      runtime: meta.runtime || null,
      videos: meta.videos || [],
      // Flag to indicate if metadata is incomplete
      _hasPoster: !!meta.poster,
      _hasDescription: !!meta.description && meta.description.length > 10,
      _isComplete: !!meta.poster && !!meta.description && meta.description.length > 10
    };
  } catch (e) {
    console.error('Cinemeta fetch error:', e.message);
    return null;
  }
}

/**
 * Fetch anime title from AniList API using MAL ID
 * This is a fallback when Cinemeta doesn't have the anime
 * @param {number} malId - MyAnimeList ID
 * @returns {Promise<Object|null>} Anime info with title or null
 */
async function fetchAniListByMalId(malId) {
  try {
    const query = `
      query ($malId: Int) {
        Media(idMal: $malId, type: ANIME) {
          id
          idMal
          title { romaji english native }
          description
          coverImage { large }
        }
      }
    `;
    
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ query, variables: { malId: parseInt(malId) } })
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data?.data?.Media) return null;
    
    const media = data.data.Media;
    return {
      id: `mal-${media.idMal}`,
      name: media.title.english || media.title.romaji || media.title.native,
      mal_id: media.idMal,
      anilist_id: media.id,
      description: media.description,
      poster: media.coverImage?.large,
      _source: 'anilist'
    };
  } catch (e) {
    console.error('AniList fetch error:', e.message);
    return null;
  }
}

/**
 * Search AniList API by title to get MAL/AniList IDs
 * This is used when we only have a title but no IDs
 * @param {string} title - Anime title to search
 * @returns {Promise<Object|null>} Anime info or null
 */
async function searchAniListByTitle(title) {
  try {
    const query = `
      query ($search: String) {
        Page(page: 1, perPage: 5) {
          media(search: $search, type: ANIME) {
            id
            idMal
            title { romaji english native }
            description
            coverImage { large }
          }
        }
      }
    `;
    
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ query, variables: { search: title } })
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const results = data?.data?.Page?.media;
    if (!results || results.length === 0) return null;
    
    // Return first result (best match)
    const media = results[0];
    return {
      id: `mal-${media.idMal}`,
      name: media.title.english || media.title.romaji || media.title.native,
      mal_id: media.idMal,
      anilist_id: media.id,
      description: media.description,
      poster: media.coverImage?.large,
      _source: 'anilist'
    };
  } catch (e) {
    console.error('AniList search error:', e.message);
    return null;
  }
}

/**
 * Check if metadata is poor/incomplete and needs enrichment
 */
function isMetadataIncomplete(meta) {
  if (!meta) return true;
  // Consider incomplete if missing poster or has very short/no description
  return !meta.poster || !meta.description || meta.description.length < 20;
}

// ===== DATA FETCHING =====

// ID Mappings cache (for AniDB/MAL/synonyms lookup)
let idMappingsCache = null;
let idMappingsCacheTimestamp = 0;

/**
 * Fetch ID mappings from GitHub (includes AniDB IDs, TVDB season info, synonyms)
 * Used to enrich anime objects for accurate torrent searching
 */
async function fetchIdMappings() {
  const now = Date.now();
  
  // Return cached data if still fresh (1 hour cache)
  if (idMappingsCache && (now - idMappingsCacheTimestamp) < CACHE_TTL * 1000) {
    return idMappingsCache;
  }
  
  try {
    const response = await fetch(`${GITHUB_RAW_BASE}/id-mappings.json?v=${CACHE_BUSTER}`, {
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch id-mappings: ${response.status}`);
    }
    
    idMappingsCache = await response.json();
    idMappingsCacheTimestamp = now;
    
    console.log(`[fetchIdMappings] Loaded mappings for ${Object.keys(idMappingsCache).length} anime`);
    
    return idMappingsCache;
  } catch (error) {
    console.error('[fetchIdMappings] Error:', error.message);
    return idMappingsCache || {};
  }
}

/**
 * Enrich anime object with IDs from id-mappings.json
 * This adds AniDB ID, synonyms, TVDB season info for accurate torrent searching
 */
async function enrichAnimeWithMappings(anime, imdbId) {
  if (!imdbId) return anime;
  
  const mappings = await fetchIdMappings();
  const mapping = mappings[imdbId];
  
  if (!mapping) return anime;
  
  // Enrich anime object with mapping data
  return {
    ...anime,
    anidb_id: mapping.adb || anime.anidb_id,
    mal_id: mapping.mal || anime.mal_id,
    anilist_id: mapping.al || anime.anilist_id,
    synonyms: mapping.syn || anime.synonyms || [],
    tvdb_season: mapping.tvdbS,
    tvdb_part: mapping.tvdbP,
    media_type: mapping.type,
  };
}

async function fetchCatalogData() {
  const now = Date.now();
  
  // Return cached data if still fresh
  if (catalogCache && filterOptionsCache && (now - cacheTimestamp) < CACHE_TTL * 1000) {
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  }
  
  try {
    // Fetch both files in parallel (use cache buster to force refresh after updates)
    const [catalogRes, filterRes] = await Promise.all([
      fetch(`${GITHUB_RAW_BASE}/catalog.json?v=${CACHE_BUSTER}`, {
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
      }),
      fetch(`${GITHUB_RAW_BASE}/filter-options.json?v=${CACHE_BUSTER}`, {
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
      })
    ]);
    
    if (!catalogRes.ok || !filterRes.ok) {
      throw new Error(`Failed to fetch data: catalog=${catalogRes.status}, filter=${filterRes.status}`);
    }
    
    const catalogData = await catalogRes.json();
    // The catalog.json has a nested structure: { catalog: [...], stats: {...}, ... }
    catalogCache = catalogData.catalog || catalogData;
    filterOptionsCache = await filterRes.json();
    cacheTimestamp = now;
    
    console.log(`[loadCatalogData] Loaded ${catalogCache.length} entries from GitHub (version: ${catalogData.version || 'unknown'})`);
    
    return { catalog: catalogCache, filterOptions: filterOptionsCache };
  } catch (error) {
    console.error('Error fetching data from GitHub:', error);
    
    // Return cached data even if expired, if available
    if (catalogCache && filterOptionsCache) {
      return { catalog: catalogCache, filterOptions: filterOptionsCache };
    }
    
    throw error;
  }
}

// ===== HELPER FUNCTIONS =====

// Get current anime season based on date
function getCurrentSeason(date = new Date()) {
  const month = date.getMonth() + 1; // 1-12
  const year = date.getFullYear();
  
  let season;
  if (month >= 1 && month <= 3) {
    season = 'Winter';
  } else if (month >= 4 && month <= 6) {
    season = 'Spring';
  } else if (month >= 7 && month <= 9) {
    season = 'Summer';
  } else {
    season = 'Fall';
  }
  
  return { year, season, display: `${year} - ${season}` };
}

// Check if a season is in the future
function isFutureSeason(seasonYear, seasonName, currentSeason) {
  const seasonOrder = { 'winter': 0, 'spring': 1, 'summer': 2, 'fall': 3 };
  
  if (seasonYear > currentSeason.year) return true;
  if (seasonYear < currentSeason.year) return false;
  
  // Same year - compare season order
  const currentOrder = seasonOrder[currentSeason.season.toLowerCase()];
  const checkOrder = seasonOrder[seasonName.toLowerCase()];
  
  return checkOrder > currentOrder;
}

// Check if anime belongs to a future season
function isUpcomingSeason(anime, currentSeason) {
  if (!anime.year || !anime.season) return false;
  return isFutureSeason(anime.year, anime.season, currentSeason);
}

function parseGenreFilter(genre) {
  if (!genre) return null;
  return genre.replace(/\s*\(\d+\)$/, '').trim();
}

function parseWeekdayFilter(weekday) {
  if (!weekday) return null;
  return weekday.replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
}

function parseSeasonFilter(seasonValue) {
  if (!seasonValue) return null;
  const cleanValue = seasonValue.replace(/\s*\(\d+\)$/, '').trim();
  const match = cleanValue.match(/^(\d{4})\s*-\s*(\w+)$/);
  if (match) {
    return { year: parseInt(match[1]), season: match[2].toLowerCase() };
  }
  return null;
}

// ===== NSFW CONTENT FILTERING =====
// Block hentai and adult content from appearing in catalogs
// These IDs were detected using HentaiStream database matching
const NSFW_BLOCKLIST = new Set([
  'tt5235870','mal-48755','mal-49944','mal-59407','mal-61232','mal-62328','mal-60494','mal-61790',
  'mal-53204','mal-62315','mal-59185','mal-60553','mal-57044','mal-61599','mal-60784','mal-62689',
  'mal-62406','mal-55003','mal-62316','mal-62380','mal-61764','mal-32587','mal-58891','mal-59840',
  'mal-61694','mal-61628','mal-61935','mal-60351','mal-50622','mal-61164','mal-62921','mal-60980',
  'mal-60720','mal-61538','mal-51088','mal-62578','mal-61788','mal-38817','mal-61936','mal-60470',
  'mal-61353','mal-61583','mal-58890','mal-62339','mal-62369','mal-42141','mal-62353','mal-61165',
  'mal-61789','mal-62314','mal-59697','mal-60495','mal-62106','mal-61911','mal-63096','mal-62897',
  'mal-61166','mal-60642','mal-58122','mal-62537','mal-59173','mal-60857','mal-61539','mal-59404',
  'mal-58123','mal-60044','mal-56154','mal-61937','mal-48392','mal-60147'
]);

// NSFW genres that should trigger filtering
const NSFW_GENRES = new Set(['hentai', 'erotica', 'adult', '18+', 'r-18', 'r18', 'xxx', 'smut']);

// Check if anime should be filtered as NSFW
function isNSFWContent(anime) {
  // Check blocklist
  if (NSFW_BLOCKLIST.has(anime.id)) return true;
  
  // Check genres
  if (anime.genres) {
    for (const genre of anime.genres) {
      if (NSFW_GENRES.has(genre.toLowerCase())) return true;
    }
  }
  
  return false;
}

function isSeriesType(anime) {
  if (anime.subtype === 'movie') return false;
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (anime.subtype === 'special' && runtime >= 100) return false;
  return true;
}

// Filter out entries that are separate seasons of shows already covered by a main entry
// These have IMDB IDs that cover all seasons, so we don't need separate catalog entries
// NOTE: Only hide entries whose main series is ONGOING. If main is FINISHED but this season is ONGOING,
// keep this entry visible so it appears in "Currently Airing"
const HIDDEN_DUPLICATE_ENTRIES = new Set([
  // Standalone season entries that should be hidden in favor of parent series
  // These are separate catalog entries for seasons that are already covered by the main entry
  'tt36956670',   // JJK: Hidden Inventory/Premature Death (S2 - covered by tt12343534)
  'tt14331144',   // JJK 0 movie (covered by tt12343534 as a prequel movie)
  'mal-57658',    // JJK: The Culling Game Part 1 (S3 - covered by tt12343534)
  'mal-59978',    // Frieren 2nd Season (covered by tt22248376)
  // Add more as needed
]);

// Map standalone season entries to their parent series ID
// When a season is ONGOING, the parent series should appear in Currently Airing
const SEASON_TO_PARENT_MAP = {
  'mal-57658': 'tt12343534',    // JJK: The Culling Game Part 1 → Jujutsu Kaisen
  'tt36956670': 'tt12343534',   // JJK: Hidden Inventory → Jujutsu Kaisen
  'tt14331144': 'tt12343534',   // JJK 0 → Jujutsu Kaisen
  'mal-59978': 'tt22248376',    // Frieren 2nd Season → Frieren: Beyond Journey's End
  // Add more mappings as needed
};

// Reverse map: parent ID → list of season IDs (for stream checking)
const PARENT_TO_SEASONS_MAP = {
  'tt12343534': ['mal-57658', 'tt36956670', 'tt14331144'],  // JJK seasons
  'tt22248376': ['mal-59978'],  // Frieren seasons
  // Add more mappings as needed
};

// Map parent ID → which season number is currently airing
// Only this season will be streamable, older seasons redirect to Torrentio
const PARENT_ONGOING_SEASON = {
  'tt12343534': 3,  // JJK Season 3 (The Culling Game) is currently airing
  'tt22248376': 2,  // Frieren Season 2 is currently airing
  // Add more as needed
};

// Get all parent IDs that have an ongoing season
function getParentsWithOngoingSeasons(catalogData) {
  const ongoingParents = new Set();
  for (const anime of catalogData) {
    if (anime.status === 'ONGOING') {
      const parentId = SEASON_TO_PARENT_MAP[anime.id];
      if (parentId) {
        ongoingParents.add(parentId);
      }
    }
  }
  return ongoingParents;
}

// Check if a parent series has any ongoing season in the catalog
function parentHasOngoingSeason(parentId, catalogData) {
  const seasonIds = PARENT_TO_SEASONS_MAP[parentId];
  if (!seasonIds) return false;
  
  for (const seasonId of seasonIds) {
    const season = catalogData.find(a => a.id === seasonId);
    if (season && season.status === 'ONGOING') {
      return true;
    }
  }
  return false;
}

// Get the currently airing season number for a parent series
function getOngoingSeasonNumber(parentId) {
  return PARENT_ONGOING_SEASON[parentId] || null;
}

// Non-anime entries to filter from catalogs
// These are Western animation, anime-inspired content, donghua (Chinese), or fan animations
const NON_ANIME_BLACKLIST = new Set([
  // Western Animation
  'tt15248880', // Adventure Time: Fionna & Cake
  'tt1305826',  // Adventure Time
  'tt4501334',  // Adventure Time (duplicate)
  'tt11165358', // Adventure Time: Distant Lands
  'tt5161450',  // Adventure Time: The Wand
  'tt0373732',  // The Boondocks
  'tt0278238',  // Samurai Jack
  'tt11126994', // Arcane
  'tt8050756',  // The Owl House
  'tt12895414', // The SpongeBob SquarePants Anime
  'tt29661543', // #holoEN3DRepeat
  'tt9362722',  // Spider-Man: Across the Spider-Verse
  'tt4633694',  // Spider-Man: Into The Spider-Verse
  'tt16360004', // Spider-Man: Beyond the Spider-Verse
  'tt14205554', // K-POP DEMON HUNTERS (Netflix)
  'tt0417299',  // Avatar: The Legend So Far
  'tt3975938',  // The Legend of Korra Book 2
  'tt13660822', // Avatar: Super Deformed Shorts
  'tt16026746', // X-Men '97
  'tt14069590', // DOTA: Dragon's Blood (Studio Mir)
  'tt12605636', // Onyx Equinox (Crunchyroll Studios)
  'tt8170404',  // Ballmastrz (Adult Swim)
  'tt0127379',  // Johnny Cypher in Dimension Zero
  'tt12588448', // Larva Island (Korean CGI)
  'tt0934701',  // Ni Hao, Kai-Lan (Nickelodeon)
  'tt10428604', // Magic: The Gathering (Netflix)
  'tt0423746',  // Super Robot Monkey Team (Disney)
  'tt2080922',  // Oscar's Oasis (French CGI)
  'tt0077687',  // The Hobbit 1977 (Rankin/Bass)
  'tt4499280',  // Solo: A Star Wars Story
  'tt32915621', // Valoran Town (LoL, Chinese)
  'tt28786861', // Justice League x RWBY Part 2 (DC/Rooster Teeth)
  'tt4717402',  // MFKZ (French production)
  'tt0343314',  // Teen Titans (US, Warner Bros. Animation)
  'tt2218106',  // Teen Titans Go! (US, Warner Bros. Animation)
  'tt2098999',  // Amphibia (Disney)
  'mal-45749',  // Amphibia Season Three (Disney)
  'tt6517102',  // Castlevania (Netflix, US production)
  'tt14833612', // Castlevania: Nocturne (Netflix, US)
  'tt11680642', // Pantheon (AMC, US production)
  'tt21056886', // Scavengers Reign (Max, US production)
  'tt9288848',  // Pacific Rim: The Black (Netflix, Polygon Pictures but US IP)
  
  // Avatar: The Last Airbender (US production, Nickelodeon)
  'mal-7926',   // Avatar: The Last Airbender Book 3: Fire
  'mal-7937',   // Avatar: The Last Airbender Book 2: Earth
  'mal-7936',   // Avatar: The Last Airbender Book 1: Water
  'mal-11839',  // Avatar: The Legend So Far
  'mal-11842',  // Avatar Pilot
  
  // Legend of Korra (US production, Nickelodeon)
  'mal-7927',   // The Legend of Korra Book 1: Air
  'mal-7938',   // The Legend of Korra Book 2: Spirits
  'mal-8077',   // The Legend of Korra Book 3: Change
  'mal-8706',   // The Legend of Korra Book 4: Balance
  'mal-11565',  // The Re-telling of Korra's Journey
  
  // DOTA: Dragon's Blood (Studio Mir, Korean/US)
  'mal-44413',  // DOTA: Dragon's Blood Book II
  'mal-46257',  // DOTA: Dragon's Blood: Book III
  
  // RWBY (Rooster Teeth, US production)
  'tt3066242',  // RWBY
  'tt21198914', // RWBY (duplicate IMDB)
  'tt35253928', // RWBY II World of Remnant
  'tt5660680',  // RWBY: Chibi
  'tt19389868', // RWBY: Ice Queendom
  'tt28695882', // RWBY Volume 9: Beyond
  'mal-11013',  // RWBY Prologue Trailers
  'mal-12629',  // RWBY IV Character Short
  'mal-8707',   // RWBY II World of Remnant
  'mal-13649',  // RWBY V: Character Shorts
  'mal-11439',  // RWBY III World of Remnant
  'mal-13248',  // RWBY Chibi 2
  'mal-12669',  // RWBY IV World of Remnant
  'mal-14240',  // RWBY Chibi 3
  'mal-41936',  // RWBY VI: Character Short
  'mal-12674',  // RWBY: The Story So Far
  'mal-47335',  // RWBY Vol. X
  'tt24548912', // Justice League x RWBY Part 1
  'mal-48814',  // RWBY Volume 9: Bonus Ending Animatic
  'mal-48799',  // RWBY Volume 9: Beyond
  
  // Adventure Time (Cartoon Network, US)
  'mal-13768',  // Adventure Time Season 8
  'mal-41118',  // Adventure Time Season 10
  'mal-13766',  // Adventure Time Season 6
  'mal-13767',  // Adventure Time Season 7
  'mal-13770',  // Adventure Time: Graybles Allsorts
  'mal-13771',  // Adventure Time Short: Frog Seasons
  
  // Steven Universe (Cartoon Network, US)
  'mal-11215',  // Steven Universe Season 2 Specials
  'mal-11100',  // Steven Universe Pilot
  'mal-13424',  // Steven Universe Season 4 Specials
  
  // Star vs. the Forces of Evil (Disney, US)
  'tt2758770',  // Star vs. the Forces of Evil
  'mal-13533',  // Star vs. The Forces of Evil: The Battle for Mewni
  
  // Teen Titans (US, Warner Bros.)
  'mal-11483',  // Teen Titans: The Lost Episode
  'tt10548944', // Teen Titans Go! vs. Teen Titans
  
  // Voltron (US production)
  'tt1669774',  // Voltron Force
  'tt0164303',  // Voltron: The Third Dimension
  
  // The Dragon Prince (US, Wonderstorm)
  'tt8688814',  // The Dragon Prince
  
  // Gen:Lock (Rooster Teeth, US)
  'mal-42560',  // Gen:Lock Character Reveal Teasers
  
  // Gravity Falls (Disney, US)
  'mal-47514',  // Gravity Falls Pilot
  
  // Amphibia (Disney, US)
  'mal-45754',  // Disney Theme Song Takeover-Amphibia
  'tt20190086', // Amphibia Chibi Tiny Tales
  
  // Donghua (Chinese Animation) - not Japanese anime
  'tt11755260', // The Daily Life of the Immortal King
  'tt14986786', // Perfect World
  'tt15788086', // Stellar Transformation
  'tt19902148', // Throne of Seal
  'tt27517921', // Against the Gods
  'tt27432264', // Renegade Immortal
  'tt30629237', // Wan Jie Qi Yuan
  'tt37578217', // Ling Cage
  'tt32801071', // Perfect World Movie
  'tt20603126', // Thousands of worlds
  'tt33968201', // Spring and Autumn
  'tt15832382', // Hong Ling Jin Xia
  'tt28863606', // God of Ten Thousand Realms
  'tt6859260',  // The King's Avatar
]);

// Manual poster overrides for anime with broken/missing metahub posters
// V5 cleanup: Removed items NOT IN CATALOG or with good Fribb/IMDB matches
const POSTER_OVERRIDES = {
  'tt38691315': 'https://media.kitsu.app/anime/50202/poster_image/large-b0a51e52146b1d81d8d0924b5a8bbe82.jpeg', // Style of Hiroshi Nohara Lunch - imdb_v5_medium
  'tt12787182': 'https://media.kitsu.app/anime/poster_images/43256/large.jpg', // Fushigi Dagashiya: Zenitendou
  'tt1978960': 'https://media.kitsu.app/anime/poster_images/5007/large.jpg', // Knyacki!
  'tt37776400': 'https://media.kitsu.app/anime/50096/poster_image/large-9ca5e6ff11832a8bf554697c1f183dbf.jpeg', // Dungeons & Television
  'tt37509404': 'https://media.kitsu.app/anime/49961/poster_image/large-3f376bc5492dd5de03c4d13295604f95.jpeg', // Gekkan! Nanmono Anime
  'tt39281420': 'https://media.kitsu.app/anime/50253/poster_image/large-5c560f04c35705e046a945dfc5c5227f.jpeg', // Koala's Diary
  'tt36270770': 'https://media.kitsu.app/anime/46581/poster_image/large-eb771819d7a6a152d1925f297bcf1928.jpeg', // ROAD OF NARUTO
  'tt27551813': 'https://cdn.myanimelist.net/images/anime/1921/135489l.jpg', // Idol (fribb_kitsu but MAL poster better)
  'tt39287518': 'https://media.kitsu.app/anime/49998/poster_image/large-16edb06a60a6644010b55d4df6a2012a.jpeg', // Kaguya-sama Stairway
  'tt37196939': 'https://media.kitsu.app/anime/49966/poster_image/large-420c08752313cc1ad419f79aa4621a8d.jpeg', // Wash it All Away
  'tt39050141': 'https://media.kitsu.app/anime/50371/poster_image/large-e9aaad3342085603c1e3d2667a5954ab.jpeg', // Love Through A Prism
  'tt32482998': 'https://media.kitsu.app/anime/50431/poster_image/large-22e1364623ae07665ab286bdbad6d02c.jpeg', // Duel Masters LOST
  'tt36592708': 'https://media.kitsu.app/anime/48198/poster_image/large-b8e67c6a35c2a5e94b5c0b82e0f5a3c7.jpeg', // There's No Freaking Way I'll be Your Lover!
  // Items removed (NOT IN CATALOG after v5):
  // tt35348212, tt37578217, tt37894464, tt37836273, tt39254742, tt36294552, tt38268282, tt37532731
};

// Manual metadata overrides for anime with incomplete catalog data
// V5 cleanup: Removed items NOT IN CATALOG, kept items that still need enhancements
// Items with fribb_kitsu/imdb_v5_high matches may still need background/cast overrides
const METADATA_OVERRIDES = {
  'tt38691315': { // Style of Hiroshi Nohara Lunch - imdb_v5_medium
    runtime: '24 min',
    rating: 6.4,
    genres: ['Animation', 'Comedy']
  },
  'tt38037498': { // There was a Cute Girl in the Hero's Party - imdb_v5_medium
    rating: 7.6,
    genres: ['Animation', 'Action', 'Adventure', 'Fantasy']
  },
  'tt38798044': { // The Case Book of Arne - fribb_kitsu
    rating: 6.5,
    genres: ['Animation', 'Mystery']
  },
  'tt12787182': { // Fushigi Dagashiya - imdb_v5_high
    runtime: '10 min',
    rating: 6.15,
    genres: ["Mystery"],
    background: 'https://cdn.myanimelist.net/images/anime/1602/150098l.jpg',
    cast: ["Iketani, Nobue","Katayama, Fukujuurou","Hasegawa, Ikumi"],
  },
  'tt38652044': { // Isekai no Sata - fribb_kitsu
    runtime: '23 min',
    rating: 5.48,
    genres: ["Action","Adventure","Fantasy","Isekai"],
    background: 'https://cdn.myanimelist.net/images/anime/1282/102248l.jpg',
    cast: ["Takahashi, Rie","Amasaki, Kouhei","Kubo, Yurika","Mizumori, Chiko","Mano, Ayumi"],
  },
  'tt38646949': { // Majutsushi Kunon - fribb_kitsu
    rating: 6.7,
    genres: ["Fantasy"],
    background: 'https://cdn.myanimelist.net/images/anime/1704/154459l.jpg',
    cast: ["Hayami, Saori","Uchida, Maaya","Inomata, Satoshi","Shimazaki, Nobunaga","Okamura, Haruka"],
  },
  'tt37776400': { // Dungeons & Television - imdb_v5_medium
    rating: 6.64,
    genres: ["Adventure","Fantasy"],
    background: 'https://cdn.myanimelist.net/images/anime/1874/151419l.jpg',
    cast: ["Haneta, Chika","Matsuzaki, Nana","Ishiguro, Chihiro","Okada, Yuuki"],
  },
  'tt37509404': { // Gekkan! Nanmono Anime - imdb_v5_medium
    genres: ["Slice of Life","Anthropomorphic"],
    background: 'https://cdn.myanimelist.net/images/anime/1581/150017l.jpg',
    cast: ["Hikasa, Youko","Izawa, Shiori","Kitou, Akari","Shiraishi, Haruka","Ootani, Ikue"],
  },
  'tt39281420': { // Koala Enikki - imdb_v5_medium
    rating: 6.31,
    genres: ["Slice of Life","Anthropomorphic"],
    background: 'https://cdn.myanimelist.net/images/anime/1987/152302l.jpg',
    cast: ["Uchida, Aya"],
  },
  'tt1978960': { // Knyacki! - imdb_v5_high
    background: 'https://cdn.myanimelist.net/images/anime/2/55107l.jpg',
  },
  'tt34852231': { // Gnosia - fribb_kitsu
    runtime: '25 min',
    cast: ["Hasegawa, Ikumi","Anzai, Chika","Nakamura, Yuuichi","Sakura, Ayane","Seto, Asami"],
  },
  'tt32832424': { // Haigakura - fribb_kitsu
    runtime: '23 min',
    rating: 5.91,
  },
  'tt38980285': { // Darwin Jihen - fribb_kitsu
    runtime: '24 min',
    rating: 6.75,
  },
  'tt32336365': { // Ikoku Nikki - fribb_kitsu
    runtime: '23 min',
    rating: 7.97,
  },
  'tt38646611': { // Hanazakari no Kimitachi e - fribb_kitsu
    runtime: '4 min',
  },
  'tt38978132': { // Kizoku Tensei - fribb_kitsu
    rating: 6.43,
    cast: ["Nanami, Karin","Tachibana, Azusa","Sumi, Tomomi Jiena","Yusa, Kouji","Kawanishi, Kengo"],
  },
  'tt27517921': { // Nitian Xie Shen - imdb_v5_medium
    rating: 7.81,
  },
  'tt38980445': { // Mayonaka Heart Tune - fribb_kitsu
    runtime: '23 min',
    rating: 7.26,
  },
  'tt27432264': { // Xian Ni - imdb_v5_high
    rating: 8.44,
  },
  'tt34710525': { // Cat's Eye (2025) - fribb_kitsu
    runtime: '25 min',
    rating: 7.22,
  },
  'tt27865962': { // Beyblade X - fribb_kitsu
    runtime: '23 min',
    rating: 6.8,
  },
  'tt37196939': { // Kirei ni Shitemoraemasu ka - fribb_kitsu
    runtime: '23 min',
    rating: 6.96,
  },
  'tt38969275': { // Maou no Musume - fribb_kitsu
    runtime: '23 min',
    rating: 7.24,
  },
  'tt38037470': { // SI-VIS - fribb_kitsu
    runtime: '23 min',
    rating: 5.98,
  },
  'tt31608637': { // Xianwu Dizun - imdb_v5_medium
    rating: 7.24,
  },
  'tt33309549': { // Shibou Yuugi - fribb_kitsu
    runtime: '26 min',
    rating: 7.88,
  },
  'tt38253018': { // Osananajimi to wa - fribb_kitsu
    runtime: '25 min',
    rating: 7.35,
  },
  'tt37137805': { // Champignon no Majo - fribb_kitsu
    runtime: '24 min',
    rating: 7.31,
  },
  'tt38128737': { // Ganglion - fribb_kitsu
    runtime: '3 min',
    rating: 6.06,
  },
  'tt34623148': { // Kagaku×Bouken Survival! - imdb_v5_medium
    description: 'The series follows children in various adventurous situations while weaving information about science into the story.',
  },
  'tt33349897': { // Kono Kaisha ni Suki - fribb_kitsu
    runtime: '23 min',
  },
  'tt28197251': { // Chao Neng Lifang - imdb_v5_high
    cast: ["Hioka, Natsumi","Yomichi, Yuki","Nanase, Ayaka","Takahashi, Shinya","Yamamoto, Kanehira"],
  },
  'tt0306365': { // Nintama Rantarou - fribb_kitsu
    runtime: '10 min',
  },
  'tt0367414': { // Sore Ike! Anpanman - fribb_kitsu
    runtime: '24 min',
  },
  'tt32832433': { // Touhai - fribb_kitsu
    runtime: '23 min',
  },
  'tt38572776': { // Potion, Wagami wo Tasukeru - imdb_v5_high
    runtime: '13 min',
  },
  'tt32535912': { // Watari-kun - fribb_kitsu
    runtime: '23 min',
  },
  'tt35769369': { // Chitose-kun - fribb_kitsu
    rating: 7.22,
  },
  'tt38648925': { // Jack-of-All-Trades - imdb_v5_high
    rating: 6.1,
  },
  'tt37499375': { // Digimon Beatbreak - fribb_kitsu
    rating: 7.05,
  },
  'tt28022382': { // Douluo Dalu 2 - imdb_v5_high
    rating: 7.94,
  },
  'tt17163876': { // Ninjala - fribb_kitsu
    rating: 5.75,
  },
  'tt15816496': { // Ni Tian Zhizun - imdb_v5_high
    rating: 7.28,
  },
  'tt35346388': { // #Compass 2.0 - fribb_kitsu
    rating: 5.86,
  },
  'tt38976904': { // Goumon Baito-kun - fribb_kitsu
    rating: 6.35,
  },
  'tt34715295': { // Tono to Inu - fribb_kitsu
    rating: 6.68,
  },
  'tt36632066': { // Odayaka Kizoku - fribb_kitsu
    rating: 6.75,
  },
  'tt33501934': { // Mushen Ji - imdb_v5_high
    rating: 8.24,
  },
  'tt36270770': { // ROAD OF NARUTO - imdb_v5_high
    genres: ['Action', 'Fantasy', 'Martial Arts'],
    cast: ['Sugiyama, Noriaki', 'Takeuchi, Junko'],
  },
  'tt27551813': { // Idol - fribb_kitsu
    genres: ['School', 'Music', 'Slice of Life', 'Comedy', 'Sci-Fi', 'Mecha'],
  },
  'tt21030032': { // Oshi no Ko
    runtime: '30 min',
  },
  // Removed (NOT IN CATALOG after v5):
  // tt37578217 (Ling Cage), tt35348212 (Kaijuu Sekai Seifuku), tt37836273 (Shuukan Ranobe),
  // tt26443616, tt37364267, tt37894464, tt32158870, tt13352178, tt37532599, tt12826684,
  // tt0283783, tt26997679, tt37815384, tt34852961, tt27617390, tt36270200, tt37536527,
  // tt34382834, tt32649136, tt36534643, tt13544716, tt38647635
};

function isHiddenDuplicate(anime) {
  return HIDDEN_DUPLICATE_ENTRIES.has(anime.id);
}

function isNonAnime(anime) {
  const id = anime.id || anime.imdb_id;
  return NON_ANIME_BLACKLIST.has(id);
}

// Filter out "deleted" placeholder entries from Kitsu
function isDeletedEntry(anime) {
  const name = (anime.name || '').toLowerCase().trim();
  // Match "delete", "deleted", "deleteg", "deleteasv", etc.
  return /^delete/i.test(name);
}

// Filter out recap episodes - these are summary/compilation episodes, not proper anime
function isRecap(anime) {
  const name = (anime.name || '').toLowerCase();
  // Check for recap patterns in name
  if (/\brecaps?\b/i.test(name)) return true;
  // Also filter "digest" episodes (Japanese term for recaps)
  if (/\bdigest\b/i.test(name) && anime.subtype === 'special') return true;
  return false;
}

// Filter out music videos from main catalogs (keep in search)
// Exception: Keep notable music video anime like Interstella5555, Shelter
const NOTABLE_MUSIC_ANIME = new Set([
  'tt0368667',  // Interstella5555
  'tt6443118',  // Shelter
  'tt1827378',  // Black★Rock Shooter (original MV that spawned anime)
  'mal-937',    // On Your Mark (Ghibli)
  'tt27551813', // Idol
]);

function isMusicVideo(anime) {
  if (anime.subtype !== 'music') return false;
  // Keep notable music anime
  if (NOTABLE_MUSIC_ANIME.has(anime.id)) return false;
  return true;
}

// Fix HTML entities in descriptions
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2014;/g, '—')
    .replace(/&#x2013;/g, '–')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Filter out OVA entries - these are often incomplete/broken in streaming
// Keep only: TV series, movies, ONA (web series), and specials
// Notable OVAs that should be kept (popular standalone OVAs with high ratings)
const NOTABLE_OVA = new Set([
  'tt0495212',  // Hellsing Ultimate
  'tt0279077',  // FLCL
  'tt0096633',  // Legend of the Galactic Heroes
  'tt0248119',  // JoJo's Bizarre Adventure (1993)
  'tt1992386',  // Black Lagoon: Roberta's Blood Trail
  'tt4483100',  // Kidou Senshi Gundam: The Origin
  'tt2496120',  // Space Battleship Yamato
  'tt0315008',  // Shonan Junai Gumi!
]);

function isOVA(anime) {
  if (anime.subtype !== 'OVA') return false;
  // Keep notable OVAs
  if (NOTABLE_OVA.has(anime.id)) return false;
  return true;
}

// Combined filter for catalog exclusions
function shouldExcludeFromCatalog(anime) {
  if (isHiddenDuplicate(anime)) return true;
  if (isNonAnime(anime)) return true;
  if (isRecap(anime)) return true;
  if (isMusicVideo(anime)) return true;
  if (isDeletedEntry(anime)) return true;
  if (isOVA(anime)) return true;  // Filter out OVAs
  if (isNSFWContent(anime)) return true;  // Filter out hentai/adult content
  return false;
}

function isMovieType(anime) {
  if (anime.subtype === 'movie') return true;
  let runtime = anime.runtime;
  if (typeof runtime === 'string') {
    const match = runtime.match(/(\d+)/);
    runtime = match ? parseInt(match[1]) : 0;
  }
  if (anime.subtype === 'special' && runtime >= 100) return true;
  return false;
}

// ===== FORMAT FUNCTIONS =====

function formatAnimeMeta(anime) {
  const formatted = { ...anime };
  
  // Apply metadata overrides first
  if (METADATA_OVERRIDES[anime.id]) {
    const overrides = METADATA_OVERRIDES[anime.id];
    Object.assign(formatted, overrides);
  }
  
  formatted.type = anime.subtype === 'movie' ? 'movie' : 'series';
  
  if (formatted.rating !== null && formatted.rating !== undefined && !isNaN(formatted.rating)) {
    formatted.imdbRating = formatted.rating.toFixed(1);
  }
  
  if (formatted.year) {
    formatted.releaseInfo = formatted.year.toString();
  }
  
  // Decode HTML entities in description (fixes &apos;, &#x2014;, etc.)
  if (formatted.description) {
    formatted.description = decodeHtmlEntities(formatted.description);
    if (formatted.description.length > 200) {
      formatted.description = formatted.description.substring(0, 200) + '...';
    }
  }
  
  // Poster priority:
  // 1) Manual override (for specific broken posters via POSTER_OVERRIDES)
  // 2) Metahub for any anime with IMDB ID (has nice title overlay like Cinemeta)
  // 3) Fallback to catalog poster (Kitsu) for non-IMDB content
  if (POSTER_OVERRIDES[anime.id]) {
    formatted.poster = POSTER_OVERRIDES[anime.id];
  } else if (anime.id && anime.id.startsWith('tt')) {
    // Use Metahub for all IMDB content - has title overlays like Cinemeta
    formatted.poster = `https://images.metahub.space/poster/medium/${anime.id}/img`;
  }
  // If no IMDB ID, keep the catalog poster (Kitsu)
  
  return formatted;
}

// ===== SEARCH FUNCTION =====

function searchDatabase(catalogData, query, targetType = null) {
  if (!query || query.length < 2) return [];
  
  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);
  
  const scored = [];
  
  for (const anime of catalogData) {
    // In search, allow recaps and music videos (just exclude blacklisted non-anime)
    if (isHiddenDuplicate(anime)) continue;
    if (isNonAnime(anime)) continue;
    if (targetType === 'series' && !isSeriesType(anime)) continue;
    if (targetType === 'movie' && !isMovieType(anime)) continue;
    
    const name = (anime.name || '').toLowerCase();
    const description = (anime.description || '').toLowerCase();
    const genres = (anime.genres || []).map(g => g.toLowerCase());
    const studios = (anime.studios || []).map(s => s.toLowerCase());
    
    let score = 0;
    
    if (name === normalizedQuery) {
      score += 1000;
    } else if (name.startsWith(normalizedQuery)) {
      score += 500;
    } else if (name.includes(normalizedQuery)) {
      score += 200;
    }
    
    for (const word of queryWords) {
      if (name.includes(word)) score += 50;
    }
    
    for (const word of queryWords) {
      if (genres.some(g => g.includes(word))) score += 30;
      if (studios.some(s => s.includes(word))) score += 30;
    }
    
    if (description.includes(normalizedQuery)) score += 20;
    
    if (score > 0) {
      score += (anime.rating || 0) / 10;
      scored.push({ anime, score });
    }
  }
  
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.anime.rating || 0) - (a.anime.rating || 0);
  });
  
  return scored.map(s => s.anime);
}

// ===== CATALOG HANDLERS =====

function handleTopRated(catalogData, genreFilter, config) {
  let filtered = catalogData.filter(anime => isSeriesType(anime) && !shouldExcludeFromCatalog(anime));
  
  if (genreFilter) {
    const genre = parseGenreFilter(genreFilter);
    filtered = filtered.filter(anime => 
      anime.genres && anime.genres.some(g => 
        g.toLowerCase() === genre.toLowerCase()
      )
    );
  }
  
  filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return filtered;
}

function handleSeasonReleases(catalogData, seasonFilter) {
  let filtered = catalogData.filter(anime => isSeriesType(anime) && !shouldExcludeFromCatalog(anime));
  
  const currentSeason = getCurrentSeason();
  
  if (seasonFilter) {
    const cleanFilter = seasonFilter.replace(/\s*\(\d+\)$/, '').trim();
    
    // Handle "Upcoming" filter - all future seasons
    if (cleanFilter.toLowerCase() === 'upcoming') {
      filtered = filtered.filter(anime => {
        if (!anime.year || !anime.season) return false;
        return isUpcomingSeason(anime, currentSeason);
      });
    } else {
      // Handle specific season filter (e.g., "2026 - Winter")
      const parsed = parseSeasonFilter(seasonFilter);
      if (parsed) {
        filtered = filtered.filter(anime => {
          if (!anime.year) return false;
          if (anime.year !== parsed.year) return false;
          // Also check season matches if we have that data
          if (anime.season && parsed.season) {
            return anime.season.toLowerCase() === parsed.season.toLowerCase();
          }
          return true;
        });
      }
    }
  } else {
    // No filter - show current season by default
    filtered = filtered.filter(anime => {
      if (!anime.year || !anime.season) return false;
      return anime.year === currentSeason.year && 
             anime.season.toLowerCase() === currentSeason.season.toLowerCase();
    });
  }
  
  // Sort by rating, with newer anime prioritized
  filtered.sort((a, b) => {
    // First by year (newer first)
    if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
    // Then by rating
    return (b.rating || 0) - (a.rating || 0);
  });
  return filtered;
}

/**
 * Handle the "Currently Airing" catalog
 * Uses pre-scraped broadcastDay data from catalog.json (updated via incremental-update.js)
 * @param {Array} catalogData - Full catalog data
 * @param {string} genreFilter - Optional weekday filter (e.g., "Monday", "Friday")
 * @param {Object} config - User configuration
 * @returns {Array} Filtered and sorted anime list
 */
function handleAiring(catalogData, genreFilter, config) {
  // Debug: Check if MAL-only anime exist in catalog
  const malOnlyIds = ['mal-59978', 'mal-53876', 'mal-62804'];
  malOnlyIds.forEach(id => {
    const anime = catalogData.find(a => a.id === id);
    if (anime) {
      console.log(`[handleAiring DEBUG] ${id} exists in catalog: ${anime.name}, status=${anime.status}, broadcastDay=${anime.broadcastDay}`);
    } else {
      console.log(`[handleAiring DEBUG] ${id} NOT FOUND in catalog`);
    }
  });
  
  // Get parent series that have ongoing seasons (e.g., JJK main entry when S3 is airing)
  const parentsWithOngoingSeasons = getParentsWithOngoingSeasons(catalogData);
  
  // Build a map of parent ID → ongoing season's broadcast day
  // This allows us to show the correct broadcast day for parent series
  const parentBroadcastDays = {};
  for (const anime of catalogData) {
    if (anime.status === 'ONGOING') {
      const parentId = SEASON_TO_PARENT_MAP[anime.id];
      if (parentId && anime.broadcastDay) {
        parentBroadcastDays[parentId] = anime.broadcastDay;
      }
    }
  }
  
  // Debug: Count before filtering
  const ongoingCount = catalogData.filter(a => a.status === 'ONGOING').length;
  const ongoingFriday = catalogData.filter(a => a.status === 'ONGOING' && a.broadcastDay === 'Friday');
  console.log(`[handleAiring] Total ONGOING: ${ongoingCount}, ONGOING Friday: ${ongoingFriday.length}`);
  ongoingFriday.forEach(a => {
    const seriesType = isSeriesType(a);
    const excluded = shouldExcludeFromCatalog(a);
    console.log(`[handleAiring] ${a.name} (${a.id}): isSeriesType=${seriesType}, shouldExclude=${excluded}`);
  });
  
  // Include anime that are either:
  // 1. Directly marked as ONGOING in our catalog
  // 2. Parent series that have an ongoing season (even if parent is marked FINISHED)
  let filtered = catalogData.filter(anime => {
    if (!isSeriesType(anime) || shouldExcludeFromCatalog(anime)) {
      // Debug: Log rejection reasons for MAL anime
      if (anime.id && anime.id.startsWith('mal-')) {
        console.log(`[handleAiring REJECTED] ${anime.id}: isSeriesType=${isSeriesType(anime)}, shouldExclude=${shouldExcludeFromCatalog(anime)}`);
      }
      return false;
    }
    // Include if directly ONGOING or parent with ongoing season
    const isOngoing = anime.status === 'ONGOING' || parentsWithOngoingSeasons.has(anime.id);
    return isOngoing;
  });
  
  console.log(`[handleAiring] After initial filter: ${filtered.length} anime`);
  
  // For anime, enhance broadcast day information for parent series
  filtered = filtered.map(anime => {
    // Inherit broadcast day from ongoing season for parent series
    if (parentsWithOngoingSeasons.has(anime.id) && parentBroadcastDays[anime.id] && !anime.broadcastDay) {
      return { ...anime, broadcastDay: parentBroadcastDays[anime.id] };
    }
    return anime;
  });
  
  // Apply exclude long-running filter ONLY if explicitly enabled
  // By default, long-running anime like Detective Conan ARE included
  if (config.excludeLongRunning === true) {
    const currentYear = new Date().getFullYear();
    filtered = filtered.filter(anime => {
      const year = anime.year || currentYear;
      const episodeCount = anime.episodes || null;
      
      // If anime started more than 10 years ago and we don't have episode data,
      // assume it's long-running (safer to exclude than include)
      if (year < currentYear - 10 && episodeCount === null) {
        return false;
      }
      
      // If we have episode data, use it
      if (episodeCount !== null) {
        return episodeCount < 100;
      }
      
      // For recent anime without episode data, include them
      return true;
    });
    console.log(`[handleAiring] After excludeLongRunning filter: ${filtered.length} anime`);
  }
  
  // Filter by weekday if specified
  if (genreFilter) {
    const weekday = parseWeekdayFilter(genreFilter);
    if (weekday) {
      const beforeCount = filtered.length;
      filtered = filtered.filter(anime => 
        anime.broadcastDay && anime.broadcastDay.toLowerCase() === weekday
      );
      console.log(`[handleAiring] After weekday filter (${weekday}): ${filtered.length} anime (from ${beforeCount})`);
      filtered.forEach(a => console.log(`[handleAiring] Final: ${a.name} (${a.id})`));
    }
  }
  
  filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return filtered;
}

function handleMovies(catalogData, genreFilter) {
  let filtered = catalogData.filter(anime => isMovieType(anime) && !shouldExcludeFromCatalog(anime));
  
  if (genreFilter) {
    const cleanFilter = parseGenreFilter(genreFilter);
    
    if (cleanFilter === 'Upcoming') {
      filtered = filtered.filter(anime => anime.status !== 'FINISHED');
      filtered.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (cleanFilter === 'New Releases') {
      const currentYear = new Date().getFullYear();
      filtered = filtered.filter(anime => 
        anime.year >= currentYear - 1 && anime.status === 'FINISHED'
      );
      filtered.sort((a, b) => {
        if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
        return (b.rating || 0) - (a.rating || 0);
      });
    } else {
      filtered = filtered.filter(anime => 
        anime.genres && anime.genres.some(g => 
          g.toLowerCase() === cleanFilter.toLowerCase()
        )
      );
      filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    }
  } else {
    filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }
  
  return filtered;
}

// Generate season options dynamically based on current date
// Shows current season first, then past seasons, with "Upcoming" for all future
function generateSeasonOptions(filterOptions, currentSeason, showCounts, catalogData) {
  const seasonOrder = ['winter', 'spring', 'summer', 'fall'];
  const options = [];
  
  // Count anime per season if we have catalog data
  const seasonCounts = {};
  let upcomingCount = 0;
  
  if (catalogData && showCounts) {
    for (const anime of catalogData) {
      if (!anime.year || !anime.season) continue;
      if (!isSeriesType(anime) || isHiddenDuplicate(anime) || isNonAnime(anime)) continue;
      
      if (isUpcomingSeason(anime, currentSeason)) {
        upcomingCount++;
      } else {
        // Normalize season to title case for consistent counting
        const normalizedSeason = anime.season.charAt(0).toUpperCase() + anime.season.slice(1).toLowerCase();
        const key = `${anime.year} - ${normalizedSeason}`;
        seasonCounts[key] = (seasonCounts[key] || 0) + 1;
      }
    }
  }
  
  // Add "Upcoming" FIRST at the top of the list
  if (showCounts) {
    options.push(`Upcoming (${upcomingCount})`);
  } else {
    options.push('Upcoming');
  }
  
  // Add current season
  const currentKey = `${currentSeason.year} - ${currentSeason.season}`;
  if (showCounts && seasonCounts[currentKey]) {
    options.push(`${currentKey} (${seasonCounts[currentKey]})`);
  } else if (showCounts) {
    options.push(`${currentKey} (0)`);
  } else {
    options.push(currentKey);
  }
  
  // Add past seasons (go back through recent years)
  const pastSeasons = [];
  let year = currentSeason.year;
  let seasonIdx = seasonOrder.indexOf(currentSeason.season.toLowerCase());
  
  // Go back through past seasons (up to 20 entries)
  for (let i = 0; i < 20; i++) {
    seasonIdx--;
    if (seasonIdx < 0) {
      seasonIdx = 3; // Fall
      year--;
    }
    
    const seasonName = seasonOrder[seasonIdx].charAt(0).toUpperCase() + seasonOrder[seasonIdx].slice(1);
    const key = `${year} - ${seasonName}`;
    const count = seasonCounts[key] || 0;
    
    if (count > 0 || year >= currentSeason.year - 2) {
      if (showCounts) {
        pastSeasons.push(`${key} (${count})`);
      } else {
        pastSeasons.push(key);
      }
    }
  }
  
  options.push(...pastSeasons);
  
  return options;
}

// ===== MANIFEST =====

function getManifest(filterOptions, showCounts = true, catalogData = null, hiddenCatalogs = [], config = {}) {
  const genreOptions = showCounts && filterOptions.genres?.withCounts 
    ? filterOptions.genres.withCounts.filter(g => !g.toLowerCase().startsWith('animation'))
    : (filterOptions.genres?.list || []).filter(g => g.toLowerCase() !== 'animation');
  
  // Generate dynamic season options based on current date
  // Shows: Current season + past seasons, with "Upcoming" for all future seasons
  const currentSeason = getCurrentSeason();
  const seasonOptions = generateSeasonOptions(filterOptions, currentSeason, showCounts, catalogData);
  
  // Recalculate weekday counts if excludeLongRunning is enabled
  let weekdayOptions;
  if (showCounts && config.excludeLongRunning && catalogData) {
    // Recalculate counts excluding long-running anime
    const weekdayCounts = {};
    const currentYear = new Date().getFullYear();
    
    for (const anime of catalogData) {
      if (!anime.broadcastDay || anime.status !== 'ONGOING') continue;
      if (!isSeriesType(anime) || shouldExcludeFromCatalog(anime)) continue;
      
      // Apply the same long-running filter logic as in handleAiring
      const year = anime.year || currentYear;
      const episodeCount = anime.episodes || null;
      
      // Skip long-running anime
      if (year < currentYear - 10 && episodeCount === null) continue;
      if (episodeCount !== null && episodeCount >= 100) continue;
      
      const day = anime.broadcastDay;
      weekdayCounts[day] = (weekdayCounts[day] || 0) + 1;
    }
    
    // Format as "Day (count)"
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    weekdayOptions = weekdays
      .filter(day => weekdayCounts[day] > 0)
      .map(day => `${day} (${weekdayCounts[day]})`);
  } else {
    weekdayOptions = showCounts && filterOptions.weekdays?.withCounts 
      ? filterOptions.weekdays.withCounts 
      : (filterOptions.weekdays?.list || []);
  }
  
  const movieOptions = showCounts && filterOptions.movieGenres?.withCounts 
    ? ['Upcoming', 'New Releases', ...filterOptions.movieGenres.withCounts.filter(g => !g.toLowerCase().startsWith('animation'))]
    : ['Upcoming', 'New Releases', ...(filterOptions.movieGenres?.list || []).filter(g => g.toLowerCase() !== 'animation')];

  // Build catalog list, filtering out hidden catalogs
  const allCatalogs = [
    {
      id: 'anime-top-rated',
      type: 'anime',
      name: 'Top Rated',
      key: 'top',
      extra: [
        { name: 'genre', options: genreOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      id: 'anime-season-releases',
      type: 'anime',
      name: 'Season Releases',
      key: 'season',
      extra: [
        { name: 'genre', options: seasonOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      id: 'anime-airing',
      type: 'anime',
      name: 'Currently Airing',
      key: 'airing',
      extra: [
        { name: 'genre', options: weekdayOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      id: 'anime-movies',
      type: 'anime',
      name: 'Movies',
      key: 'movies',
      extra: [
        { name: 'genre', options: movieOptions, isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ];
  
  // Filter out hidden catalogs (but always keep at least 1)
  let visibleCatalogs = allCatalogs.filter(c => !hiddenCatalogs.includes(c.key));
  if (visibleCatalogs.length === 0) {
    visibleCatalogs = [allCatalogs[0]]; // Fallback to Top Rated
  }
  
  // Remove the 'key' property before returning (it's internal)
  const catalogs = visibleCatalogs.map(({ key, ...rest }) => rest);
  
  // Always include search catalogs (can't be hidden)
  catalogs.push(
    {
      id: 'anime-series-search',
      type: 'series',
      name: 'Anime Series',
      extra: [
        { name: 'search', isRequired: true },
        { name: 'skip' }
      ]
    },
    {
      id: 'anime-movies-search',
      type: 'movie',
      name: 'Anime Movies',
      extra: [
        { name: 'search', isRequired: true },
        { name: 'skip' }
      ]
    }
  );

  return {
    id: 'community.animestream',
    version: '1.2.1',
    name: 'AnimeStream',
    description: 'All your favorite Anime series and movies with filtering by genre, seasonal releases, currently airing and ratings. Stream both SUB and DUB options via AllAnime.',
    // CRITICAL: Use explicit resource objects with types and idPrefixes
    // for Stremio to properly route stream requests
    resources: [
      'catalog',
      {
        name: 'meta',
        types: ['series', 'movie', 'anime'],
        idPrefixes: ['tt', 'kitsu', 'mal']
      },
      {
        name: 'stream',
        types: ['series', 'movie', 'anime'],
        idPrefixes: ['tt', 'kitsu', 'mal']
      },
      // Subtitles handler is used to trigger scrobbling when user opens an episode
      // Returns empty subtitles but marks episode as watched on AniList
      {
        name: 'subtitles',
        types: ['series', 'movie'],
        idPrefixes: ['tt']
      }
    ],
    types: ['anime', 'series', 'movie'],
    idPrefixes: ['tt', 'kitsu', 'mal'],
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    },
    // Contact email for support
    contactEmail: 'animestream-addon@proton.me',
    logo: 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/public/logo.png',
    background: 'https://raw.githubusercontent.com/Zen0-99/animestream-addon/master/public/logo.png',
    stremioAddonsConfig: {
      issuer: 'https://stremio-addons.net',
      signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..i9a29ppmiWk7ftZEtiYlHA.Ap8MrBWPmOgs1DNA_uqUsIGWQ3Ag2b3WFVLKE5pq0jiCtNVbW0Xd_u7ot84l_iLZ0jz9eoMugUJOc7036mArojkYNPxLDCuKXoH-2uQoQ54XD__pgFh-KVxC240T9y6B.1Vk_SHRoLAUJobX8botduw'
    }
  };
}

// ===== CONFIG PARSING =====

function parseConfig(configStr) {
  const config = { 
    excludeLongRunning: false, 
    showCounts: true, 
    hiddenCatalogs: [], 
    anilistToken: '', 
    malToken: '', 
    userId: '',
    // Debrid settings
    debridProvider: '',
    debridApiKey: '',
    // Stream source settings
    enableTorrents: true,
    enableAllAnime: true,
    preferRaw: false,
    // Subtitle preferences
    subtitleLanguages: ['en', 'ja']
  };
  
  if (!configStr) return config;
  
  // Keep original for case-sensitive values, lowercase for flag detection
  const decodedConfigStr = decodeURIComponent(configStr);
  const lowerConfigStr = decodedConfigStr.toLowerCase();
  
  // Check for flag presence in the string
  if (lowerConfigStr.includes('nolongrunning') || lowerConfigStr.includes('excludelongrunning')) {
    config.excludeLongRunning = true;
  }
  
  // Support both 'nocounts' and 'hidecounts' (Cloudflare blocks 'nocounts' in URL paths)
  if (lowerConfigStr.includes('nocounts') || lowerConfigStr.includes('hidecounts')) {
    config.showCounts = false;
  }
  
  // Parse key-value pairs (use original string to preserve case for API keys)
  const params = decodedConfigStr.split(/[._|&]/);
  for (const param of params) {
    const [rawKey, ...valueParts] = param.split(/[=-]/);
    const key = rawKey.toLowerCase(); // Key is case-insensitive
    const value = valueParts.join('-'); // Preserve original case for value
    
    if (key === 'showcounts') {
      const lv = value.toLowerCase();
      config.showCounts = lv !== '0' && lv !== 'false';
    }
    if (key === 'hc' && value) {
      // Hidden catalogs: comma-separated list (e.g., hc=top,movies)
      // Valid values: top, season, airing, movies
      const validCatalogs = ['top', 'season', 'airing', 'movies'];
      config.hiddenCatalogs = value.split(',')
        .map(c => c.trim().toLowerCase())
        .filter(c => validCatalogs.includes(c))
        .slice(0, 3); // Max 3 hidden (at least 1 must remain)
    }
    if (key === 'uid' && value) {
      // User ID for token storage lookup (e.g., uid=abc123)
      config.userId = decodeURIComponent(value);
    }
    // Legacy: direct token in URL (deprecated, use uid instead)
    if (key === 'al' && value) {
      config.anilistToken = decodeURIComponent(value);
    }
    if (key === 'mal' && value) {
      config.malToken = decodeURIComponent(value);
    }
    // Debrid settings
    if (key === 'dp' && value) {
      // Debrid provider (e.g., dp=realdebrid, dp=alldebrid)
      const validProviders = Object.keys(DEBRID_PROVIDERS);
      const lowerValue = value.toLowerCase();
      if (validProviders.includes(lowerValue)) {
        config.debridProvider = lowerValue;
      }
    }
    if (key === 'dk' && value) {
      // Debrid API key (CASE SENSITIVE - AllDebrid keys are case-sensitive!)
      config.debridApiKey = decodeURIComponent(value);
    }
    // Stream source toggles
    if (key === 'tor' && (value.toLowerCase() === '0' || value.toLowerCase() === 'false')) {
      config.enableTorrents = false;
    }
    if (key === 'aa' && (value.toLowerCase() === '0' || value.toLowerCase() === 'false')) {
      config.enableAllAnime = false;
    }
    if (key === 'raw' && (value.toLowerCase() === '1' || value.toLowerCase() === 'true')) {
      config.preferRaw = true;
    }
    // Subtitle languages
    if (key === 'slang' && value) {
      config.subtitleLanguages = value.split(',').map(l => l.trim().toLowerCase()).filter(Boolean);
    }
  }
  
  return config;
}

// ===== STREAM HANDLING =====

// Levenshtein distance for fuzzy matching
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  
  if (m === 0) return n;
  if (n === 0) return m;
  
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  
  return dp[m][n];
}

function stringSimilarity(str1, str2) {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 100;
  const distance = levenshteinDistance(str1, str2);
  return ((maxLen - distance) / maxLen) * 100;
}

// Find anime by any ID in catalog (supports IMDB tt*, MAL mal-*, Kitsu kitsu:*)
function findAnimeById(catalog, id) {
  // Try exact match on id field first
  let anime = catalog.find(a => a.id === id);
  if (anime) return anime;
  
  // For IMDB IDs, also check imdb_id field
  if (id.startsWith('tt')) {
    anime = catalog.find(a => a.imdb_id === id);
    if (anime) return anime;
  }
  
  // For MAL IDs (mal-12345), check mal_id field
  if (id.startsWith('mal-')) {
    const malId = id.replace('mal-', '');
    anime = catalog.find(a => a.mal_id === malId || a.id === id);
    if (anime) return anime;
  }
  
  // For Kitsu IDs (kitsu:12345), check kitsu_id field  
  if (id.startsWith('kitsu:')) {
    const kitsuId = id.replace('kitsu:', '');
    anime = catalog.find(a => a.kitsu_id === kitsuId || a.id === id);
    if (anime) return anime;
  }
  
  return null;
}

// Legacy function for backwards compatibility
function findAnimeByImdbId(catalog, imdbId) {
  return findAnimeById(catalog, imdbId);
}

// Direct AllAnime show ID mappings for popular series
// Maps: IMDB ID + season -> AllAnime show ID
// This bypasses search entirely for known popular series
const DIRECT_ALLANIME_IDS = {
  // My Hero Academia seasons (tt5626028)
  'tt5626028:1': 'gKwRaeqdMMkgmCLZw', // MHA Season 1 (13 eps)
  'tt5626028:2': 'JYfouPvxtkY5923Me', // MHA Season 2 (25 eps) - "Hero Academia 2"
  'tt5626028:3': '9ufLY3tw89ppeMhSK', // MHA Season 3 (25 eps) - "Hero Academia 3"
  'tt5626028:4': 'f2EZhiqts8FwRYi8E', // MHA Season 4 (25 eps) - "Hero Academia S4"
  'tt5626028:5': '8XhppLabWy7vJ8v76', // MHA Season 5 (25 eps) - "Boku no Academia S 5"
  'tt5626028:6': 'Yr7ha4n76ofd7BeSX', // MHA Season 6 (25 eps)
  'tt5626028:7': 'cskJzx6rseAgcGcAe', // MHA Season 7 (21 eps)
  
  // Solo Leveling (tt21209876)
  'tt21209876:1': 'B6AMhLy6EQHDgYgBF', // Solo Leveling Season 1 (Ore dake Level Up na Ken)
  'tt21209876:2': '9NdrgcZjsp7HEJ5oK', // Solo Leveling Season 2 (Arise from the Shadow)
  
  // Demon Slayer: Kimetsu no Yaiba (tt9335498)
  'tt9335498:1': 'gvwLtiYciaenJRoFy', // Kimetsu no Yaiba Season 1 (26 eps) - MAL:38000
  'tt9335498:2': 'ECmu5W4MPnKNFXqPZ', // Mugen Train Arc (7 eps) - MAL:49926
  'tt9335498:3': 'SJms742bSTrcyJZay', // Yuukaku-hen / Entertainment District Arc (11 eps) - MAL:47778
  'tt9335498:4': 'XJzfDyv8vsXWCMkTk', // Katanakaji no Sato-hen / Swordsmith Village (11 eps) - MAL:51019
  'tt9335498:5': 'ubGJNAmJmdKSjNBSX', // Hashira Geiko-hen / Hashira Training (8 eps) - MAL:55701
  
  // Jujutsu Kaisen (tt12343534)
  'tt12343534:1': '8Ti9Lnd3gW7TgeCXj', // Jujutsu Kaisen Season 1 (24 eps) - MAL:40748
  
  // Note: Attack on Titan Season 1 (tt2560140:1) is NOT available on AllAnime search
  // Season 2+ are available but S1 is missing from their index
};

// Title aliases for anime with different names across sources
// Maps: our catalog name -> AllAnime search terms (used as fallback)
const TITLE_ALIASES = {
  'my hero academia': ['Boku no Hero Academia'],
  'attack on titan': ['Shingeki no Kyojin'],
  'demon slayer': ['Kimetsu no Yaiba'],
  'jujutsu kaisen': ['Jujutsu Kaisen'],
  'solo leveling': ['Ore dake Level Up na Ken', 'Solo Leveling'],
  'dark moon: kuro no tsuki - tsuki no saidan': ['Dark Moon: Tsuki no Saidan', 'Dark Moon: The Blood Altar'],
  'dark moon: kuro no tsuki': ['Dark Moon: Tsuki no Saidan', 'Dark Moon: The Blood Altar'],
  'monogatari series: off & monster season': ['Monogatari Series: Off & Monster Season', 'Monogatari Off Monster'],
};

// Search AllAnime for matching show (using direct API)
// Now supports optional malId/aniListId for exact verification
async function findAllAnimeShow(title, malId = null, aniListId = null) {
  if (!title) return null;
  
  // Check for known title aliases first
  const normalizedTitle = title.toLowerCase();
  for (const [aliasKey, searchTerms] of Object.entries(TITLE_ALIASES)) {
    if (normalizedTitle.includes(aliasKey) || aliasKey.includes(normalizedTitle)) {
      for (const searchTerm of searchTerms) {
        console.log(`Trying alias: "${searchTerm}" for "${title}"`);
        const results = await searchAllAnime(searchTerm, 5);
        if (results && results.length > 0) {
          // If we have MAL/AniList ID, verify before accepting
          if (malId || aniListId) {
            const verified = results.find(r => 
              (malId && r.malId === malId) || (aniListId && r.aniListId === aniListId)
            );
            if (verified) {
              console.log(`Found via alias + ID verification: ${verified.id} - ${verified.title}`);
              return verified.id;
            }
          } else {
            console.log(`Found via alias: ${results[0].id} - ${results[0].title}`);
            return results[0].id;
          }
        }
      }
    }
  }
  
  try {
    const results = await searchAllAnime(title, 15);
    
    if (!results || results.length === 0) return null;
    
    // PRIORITY 1: Direct MAL/AniList ID match (most reliable)
    if (malId || aniListId) {
      const idMatch = results.find(r => 
        (malId && r.malId === malId) || (aniListId && r.aniListId === aniListId)
      );
      if (idMatch) {
        console.log(`Found via ID match (MAL:${malId}/AL:${aniListId}): ${idMatch.id} - ${idMatch.title}`);
        return idMatch.id;
      }
      console.log(`No ID match found among ${results.length} results for MAL:${malId}/AL:${aniListId}`);
    }
    
    // PRIORITY 2: Fuzzy title matching (fallback)
    // Normalize titles for matching
    const normalizedSearchTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Find best match using Levenshtein distance
    let bestMatch = null;
    let bestScore = 0;
    
    for (const show of results) {
      let score = 0;
      const showName = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const nativeTitle = (show.nativeTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      
      // Exact match
      if (showName === normalizedSearchTitle) {
        score = 100;
      } else if (showName.includes(normalizedSearchTitle) || normalizedSearchTitle.includes(showName)) {
        score = 80;
      } else {
        // Fuzzy match
        const similarity = Math.max(
          stringSimilarity(normalizedSearchTitle, showName),
          stringSimilarity(normalizedSearchTitle, nativeTitle)
        );
        score = similarity * 0.9;
      }
      
      if (show.type === 'TV') score += 3;
      if (show.type === 'Movie') score += 2;
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = show;
      }
    }
    
    // Increase threshold when we have IDs but couldn't match them (extra cautious)
    const threshold = (malId || aniListId) ? 75 : 60;
    if (bestMatch && bestScore >= threshold) {
      console.log(`Found via title match (score:${bestScore.toFixed(1)}): ${bestMatch.id} - ${bestMatch.title}`);
      return bestMatch.id;
    }
    
    console.log(`No confident match for "${title}" (best score: ${bestScore.toFixed(1)}, threshold: ${threshold})`);
    return null;
  } catch (e) {
    console.error('Search error:', e);
    return null;
  }
}

// Season-aware search for AllAnime shows
// Many anime have separate AllAnime entries per season (e.g., "Jujutsu Kaisen Season 2")
// Now accepts optional IDs for direct lookup and verification
async function findAllAnimeShowForSeason(title, season, imdbId = null, malId = null, aniListId = null) {
  if (!title) return null;
  
  // FIRST: Check direct AllAnime ID mappings (most reliable)
  if (imdbId) {
    const directKey = `${imdbId}:${season}`;
    if (DIRECT_ALLANIME_IDS[directKey]) {
      console.log(`Using direct AllAnime ID for ${directKey}: ${DIRECT_ALLANIME_IDS[directKey]}`);
      return DIRECT_ALLANIME_IDS[directKey];
    }
  }
  
  // Known season name mappings for popular shows
  // Maps: "base title" + season number -> AllAnime search terms
  const seasonMappings = {
    'solo leveling': {
      1: ['Solo Leveling'],
      2: ['Solo Leveling Season 2', 'Solo Leveling -Arise from the Shadow-', 'Solo Leveling Arise from the Shadow']
    },
    'jujutsu kaisen': {
      1: ['Jujutsu Kaisen'],
      2: ['Jujutsu Kaisen Season 2', 'Jujutsu Kaisen 2nd Season'],
      3: ['Jujutsu Kaisen: The Culling Game', 'Jujutsu Kaisen Season 3', 'Jujutsu Kaisen Culling Game']
    },
    'attack on titan': {
      1: ['Shingeki no Kyojin'],
      2: ['Shingeki no Kyojin Season 2'],
      3: ['Shingeki no Kyojin Season 3'],
      4: ['Shingeki no Kyojin: The Final Season', 'Attack on Titan Final Season']
    },
    'my hero academia': {
      1: ['Boku no Hero Academia'],
      2: ['Boku no Hero Academia 2nd Season'],
      3: ['Boku no Hero Academia 3rd Season'],
      4: ['Boku no Hero Academia 4th Season'],
      5: ['Boku no Hero Academia 5th Season'],
      6: ['Boku no Hero Academia 6th Season'],
      7: ['Boku no Hero Academia 7th Season', 'My Hero Academia Final Season']
    },
    'demon slayer': {
      1: ['Kimetsu no Yaiba'],
      2: ['Kimetsu no Yaiba: Yuukaku-hen', 'Demon Slayer: Entertainment District Arc'],
      3: ['Kimetsu no Yaiba: Katanakaji no Sato-hen', 'Demon Slayer: Swordsmith Village Arc'],
      4: ['Kimetsu no Yaiba: Hashira Geiko-hen', 'Demon Slayer: Hashira Training Arc']
    }
  };
  
  const normalizedBaseTitle = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  
  // Check if we have a known mapping
  for (const [baseName, seasons] of Object.entries(seasonMappings)) {
    if (normalizedBaseTitle.includes(baseName) || baseName.includes(normalizedBaseTitle)) {
      if (seasons[season]) {
        // Try each search term for this season
        for (const searchTerm of seasons[season]) {
          console.log(`Trying season mapping: "${searchTerm}" for ${title} S${season}`);
          const showId = await findAllAnimeShow(searchTerm, malId, aniListId);
          if (showId) {
            console.log(`Found show via season mapping: ${showId}`);
            return showId;
          }
        }
      }
    }
  }
  
  // Generic season search strategies
  const searchStrategies = [];
  
  if (season === 1) {
    // For season 1, just search the base title
    searchStrategies.push(title);
  } else {
    // For other seasons, try various naming conventions
    searchStrategies.push(`${title} Season ${season}`);
    searchStrategies.push(`${title} ${season}${getOrdinalSuffix(season)} Season`);
    searchStrategies.push(`${title} Part ${season}`);
    searchStrategies.push(title); // Fallback to base title
  }
  
  for (const searchTerm of searchStrategies) {
    console.log(`Searching AllAnime with: "${searchTerm}" (MAL:${malId}, AL:${aniListId})`);
    const showId = await findAllAnimeShow(searchTerm, malId, aniListId);
    if (showId) {
      return showId;
    }
  }
  
  return null;
}

// Helper for ordinal suffixes (1st, 2nd, 3rd, etc.)
function getOrdinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return (s[(v - 20) % 10] || s[v] || s[0]);
}

// Handle meta requests - provide episode data from AllAnime
// Also enriches metadata from AllAnime when Cinemeta data is poor
async function handleMeta(catalog, type, id) {
  // Decode URL-encoded ID
  const decodedId = decodeURIComponent(id);
  const baseId = decodedId.split(':')[0];
  
  console.log(`Meta request for ${baseId}`);
  
  // Block known non-anime entries (Western animation, etc.)
  if (NON_ANIME_BLACKLIST.has(baseId)) {
    console.log(`Blocked non-anime meta request: ${baseId}`);
    return { meta: null };
  }
  
  // First check our catalog (supports tt*, mal-*, kitsu:*)
  let anime = findAnimeById(catalog, baseId);
  let cinemeta = null;
  
  // If not in catalog and it's an IMDB ID, try Cinemeta
  if (!anime && baseId.startsWith('tt')) {
    cinemeta = await fetchCinemetaMeta(baseId, type);
    anime = cinemeta;
  }
  
  if (!anime) {
    console.log(`No anime found for meta: ${baseId}`);
    return { meta: null };
  }
  
  // Apply metadata overrides FIRST before any enrichment checks
  const hasOverride = !!METADATA_OVERRIDES[baseId];
  const overrides = hasOverride ? METADATA_OVERRIDES[baseId] : {};
  if (hasOverride) {
    console.log(`Applying metadata overrides for ${baseId}`);
    anime = { ...anime, ...overrides };
  }
  
  // Check if we need to enrich metadata from AllAnime/Cinemeta
  const needsEnrichment = isMetadataIncomplete(anime);
  
  // Search AllAnime for this show
  const showId = await findAllAnimeShow(anime.name);
  let showDetails = null;
  
  if (showId) {
    // Get full show details from AllAnime
    showDetails = await getAllAnimeShowDetails(showId);
    if (showDetails && needsEnrichment) {
      console.log(`Enriching metadata from AllAnime for: ${anime.name}`);
    }
  } else {
    console.log(`No AllAnime match for: ${anime.name}`);
  }
  
  // If we still need enrichment and AllAnime failed, try Cinemeta as fallback
  // (Only for IMDB IDs, and only if we don't already have Cinemeta data)
  if (needsEnrichment && !showDetails && !cinemeta && baseId.startsWith('tt')) {
    console.log(`Trying Cinemeta fallback for: ${anime.name}`);
    cinemeta = await fetchCinemetaMeta(baseId, type);
  }
  
  // Build episodes - PRIORITY: Cinemeta (has accurate seasons) > AllAnime > Catalog
  // Cinemeta is the authoritative source for season/episode structure
  // AllAnime is only used for stream discovery, not metadata
  const episodes = [];
  
  // For IMDB IDs, ALWAYS prefer Cinemeta's video list for proper season structure
  // This ensures multi-season anime display correctly in Stremio
  if (baseId.startsWith('tt')) {
    // Fetch Cinemeta if we haven't already
    if (!cinemeta) {
      cinemeta = await fetchCinemetaMeta(baseId, type);
    }
    
    if (cinemeta && cinemeta.videos && cinemeta.videos.length > 0) {
      // Use Cinemeta videos - they have proper season/episode numbers
      console.log(`Using Cinemeta videos for ${baseId}: ${cinemeta.videos.length} episodes across multiple seasons`);
      episodes.push(...cinemeta.videos);
    }
  }
  
  // Fallback to AllAnime episode list if Cinemeta doesn't have videos
  // This covers cases where Cinemeta is missing data for newer/obscure anime
  if (episodes.length === 0 && showDetails) {
    console.log(`Cinemeta videos unavailable, falling back to AllAnime for ${baseId}`);
    const availableEps = showDetails.availableEpisodesDetail || {};
    const subEpisodes = availableEps.sub || [];
    const dubEpisodes = availableEps.dub || [];
    
    // Use sub episodes as the primary list (usually more complete)
    const allEpisodes = [...new Set([...subEpisodes, ...dubEpisodes])].sort((a, b) => parseFloat(a) - parseFloat(b));
    
    for (const epNum of allEpisodes) {
      const epNumber = parseFloat(epNum);
      // Assume season 1 for AllAnime-only shows (no multi-season data available)
      const season = 1;
      
      episodes.push({
        id: `${baseId}:${season}:${Math.floor(epNumber)}`,
        title: `Episode ${epNumber}`,
        season: season,
        episode: Math.floor(epNumber),
        thumbnail: showDetails.thumbnail || anime.poster, // Use show poster as fallback thumbnail
        released: new Date().toISOString() // AllAnime doesn't provide release dates easily
      });
    }
  }
  
  // Last resort: use catalog videos
  if (episodes.length === 0 && anime.videos && anime.videos.length > 0) {
    console.log(`Using catalog videos for ${baseId}`);
    episodes.push(...anime.videos);
  }
  
  // Build meta object with enrichment from best available source
  // Priority: AllAnime > Cinemeta > Catalog
  const hasAllAnime = showDetails !== null;
  const hasCinemeta = cinemeta !== null;
  
  // Determine best source for each field
  const bestPoster = hasAllAnime && showDetails.thumbnail ? showDetails.thumbnail :
                     hasCinemeta && cinemeta.poster ? cinemeta.poster : 
                     anime.poster;
  
  const bestDescription = hasAllAnime && showDetails.description ? showDetails.description :
                          hasCinemeta && cinemeta.description ? cinemeta.description :
                          anime.description || '';
  
  // Clean up description - remove source citations and decode HTML entities
  const cleanDescription = decodeHtmlEntities(stripHtml(bestDescription).replace(/\s*\(Source:.*?\)\s*$/i, '').trim());
  
  const bestBackground = overrides.background ? overrides.background :
                         hasAllAnime && showDetails.banner ? showDetails.banner :
                         hasCinemeta && cinemeta.background ? cinemeta.background :
                         anime.background;
  
  // Priority: Manual override > AllAnime > Cinemeta > Catalog
  const bestGenres = overrides.genres ? overrides.genres :
                     hasAllAnime && showDetails.genres ? showDetails.genres :
                     hasCinemeta && cinemeta.genres ? cinemeta.genres :
                     anime.genres || [];
  
  const meta = {
    id: baseId,
    type: 'series',
    name: anime.name, // Keep original name for consistency
    poster: bestPoster,
    background: bestBackground,
    description: cleanDescription,
    genres: bestGenres,
    runtime: anime.runtime,
    videos: episodes,
    releaseInfo: anime.releaseInfo || 
                 (hasAllAnime && showDetails.status === 'Releasing' ? 'Ongoing' : 
                  hasAllAnime ? showDetails.status : undefined)
  };
  
  const source = hasAllAnime ? (needsEnrichment ? 'AllAnime-enriched' : 'AllAnime+catalog') : 
                 hasCinemeta ? 'Cinemeta-enriched' : 'catalog-only';
  console.log(`Returning meta with ${episodes.length} episodes for ${meta.name} (${source})`);
  return { meta };
}

// ===== STREAM SERVING CONFIGURATION =====
// All anime streams are served - no restrictions
// AllAnime supports all anime, not just currently airing

function shouldServeAllAnimeStream(anime, requestedEpisode, requestedSeason, catalogData, episodeReleaseDate, totalSeasonEpisodes) {
  // Allow all streams - no restrictions
  return { allowed: true, reason: 'all_allowed' };
}

// ===== PATCH 1.3: RAW ANIME TORRENTS + SOFT SUBTITLES =====

// Torrent cache (5-10 minutes)
const torrentCache = new Map();
const TORRENT_CACHE_TTL = 600000; // 10 minutes
const MAX_TORRENT_CACHE_SIZE = 200;

// Subtitle cache (24 hours)
const subtitleCache = new Map();
const SUBTITLE_CACHE_TTL = 86400000; // 24 hours
const MAX_SUBTITLE_CACHE_SIZE = 500;

// Known RAW release groups (no subtitles)
const RAW_GROUPS = [
  'DBD-Raws', 'Reinforce', 'Ohys-Raws', 'Snow-Raws', 
  'LowPower-Raws', 'U3-Web', 'Moozzi2', 'VCB-Studio',
  'ASC', 'Cleo', 'LoliHouse', 'Rasetsu', 'Koi-Raws', 'shincaps'
];

// Anime trackers for better torrent resolution (from Torrentio)
const ANIME_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://public.popcorn-tracker.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'http://anidex.moe:6969/announce'
];

/**
 * Build magnet link with trackers for better resolution
 */
function buildMagnetWithTrackers(infoHash, title = '') {
  const trackerParams = ANIME_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  const nameParam = title ? `&dn=${encodeURIComponent(title)}` : '';
  return `magnet:?xt=urn:btih:${infoHash}${nameParam}${trackerParams}`;
}

// Quality keywords - also detect resolution format like 1920x1080
const QUALITY_PATTERNS = {
  '4K': /4K|2160p|UHD|3840x2160/i,
  '1080p': /1080p|1920x1080|1440x1080/i,
  '720p': /720p|1280x720/i,
  '480p': /480p|DVD|848x480|640x480/i
};

// Source type detection
const SOURCE_PATTERNS = {
  'BD': /BD|Blu-?ray|BDMV|Remux/i,
  'WEB-DL': /WEB-?DL|AMZN|CR|DSNP/i,
  'WEBRip': /WEB-?Rip|WEBRip/i,
  'TV': /HDTV|TV-?Rip|BS11|ANIMAX|AT-X/i
};

/**
 * Detect quality from torrent title
 */
function detectTorrentQuality(title) {
  for (const [quality, pattern] of Object.entries(QUALITY_PATTERNS)) {
    if (pattern.test(title)) return quality;
  }
  return 'Unknown';
}

/**
 * Detect source type from torrent title
 */
function detectSourceType(title) {
  for (const [source, pattern] of Object.entries(SOURCE_PATTERNS)) {
    if (pattern.test(title)) return source;
  }
  return 'Unknown';
}

/**
 * Check if release is RAW (no subtitles)
 */
function isRAWRelease(title) {
  // Check for RAW groups
  if (RAW_GROUPS.some(g => title.includes(g))) return true;
  // Check for explicit RAW tags
  if (/\bRAW\b|生肉/i.test(title)) return true;
  // Japanese-only indicators
  if (/\[JPN?\]|\bJapanese\s+Only\b/i.test(title)) return true;
  return false;
}

// ===== EPISODE MATCHING SYSTEM =====
// Robust episode extraction and validation for torrent titles
// Supports both absolute (E156) and seasonal (S01E05) formats

/**
 * Extract episode information from a torrent title
 * Returns: { episode: number|null, season: number|null, isBatch: boolean, batchRange: [start, end]|null }
 */
function extractEpisodeInfo(title) {
  const result = { episode: null, season: null, isBatch: false, batchRange: null };
  if (!title) return result;
  
  // Normalize title for matching
  const normalized = title.replace(/\s+/g, ' ');
  
  // BATCH/SEASON PACK DETECTION - check this first
  // Patterns like [01-12], (01~12), 01-12 Complete, Batch, etc.
  // NOTE: Be careful not to match "S2 - 05" or "86 - 03" patterns
  const batchPatterns = [
    /[\[\(](\d{1,3})\s*[-~]\s*(\d{1,3})[\]\)]/i,                              // [01-12], (01~12) - MUST have brackets
    /\b(\d{1,3})\s*[-~]\s*(\d{1,3})\s*(?:END|Complete|Batch|Fin)\b/i,         // 01-12 Complete, 01~24 Batch - requires keyword
    /\b(?:Complete|Batch|全话|Season\s*Pack)\b/i,                              // Explicit batch keywords
    /\b(?:Vol(?:ume)?\.?\s*\d+\s*[-~]\s*\d+|BD\s*Box)\b/i,                    // Volume releases, BD Box
  ];
  
  for (const pattern of batchPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      result.isBatch = true;
      // Extract range if available
      if (match[1] && match[2]) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        if (start < end && end - start < 100) { // Sanity check
          result.batchRange = [start, end];
        }
      }
      break;
    }
  }
  
  // If it's a batch without a range, return early - we can't validate specific episodes
  if (result.isBatch) {
    return result;
  }
  
  // EPISODE EXTRACTION - from most specific to least specific
  
  // Pattern 1: S01E05 / S1E5 format (Western style)
  const sxeMatch = normalized.match(/\bS0?(\d{1,2})\s*E0?(\d{1,4})(?:v\d+)?(?!\d)/i);
  if (sxeMatch) {
    result.season = parseInt(sxeMatch[1], 10);
    result.episode = parseInt(sxeMatch[2], 10);
    return result;
  }
  
  // Pattern 2: Anime standard " - 05" or " - 05v2" (e.g., "[SubsPlease] Frieren - 05 (1080p).mkv")
  const dashEpMatch = normalized.match(/\s-\s0?(\d{1,4})(?:v\d+)?(?:\s|\(|\[|$)/);
  if (dashEpMatch) {
    result.episode = parseInt(dashEpMatch[1], 10);
    return result;
  }
  
  // Pattern 3: Episode 05 / Ep.05 / Ep 5
  const epWordMatch = normalized.match(/\bE(?:p(?:isode)?)?\.?\s*0?(\d{1,4})(?:v\d+)?(?!\d)/i);
  if (epWordMatch) {
    result.episode = parseInt(epWordMatch[1], 10);
    return result;
  }
  
  // Pattern 4: [05] or (05) - common in older fansub releases
  const bracketEpMatch = normalized.match(/[\[\(]0?(\d{1,3})(?:v\d+)?[\]\)]/);
  if (bracketEpMatch) {
    // Avoid matching resolution like [1080] or years like [2024]
    const num = parseInt(bracketEpMatch[1], 10);
    if (num < 1000 && num > 0) {
      result.episode = num;
      return result;
    }
  }
  
  // Pattern 5: "_05_" or ".05." (underscore/dot separated)
  const sepEpMatch = normalized.match(/[._]0?(\d{1,3})(?:v\d+)?[._]/);
  if (sepEpMatch) {
    const num = parseInt(sepEpMatch[1], 10);
    if (num < 500 && num > 0) { // Sanity check for episode numbers
      result.episode = num;
      return result;
    }
  }
  
  // Pattern 6: #05 or 第05話 (Japanese episode marker)
  const jpEpMatch = normalized.match(/(?:#|第)0?(\d{1,4})(?:話|回|v\d+)?/);
  if (jpEpMatch) {
    result.episode = parseInt(jpEpMatch[1], 10);
    return result;
  }
  
  return result;
}

/**
 * Check if a torrent matches the requested episode
 * @param {string} title - Torrent title
 * @param {number} requestedEpisode - Episode number user wants (can be absolute or seasonal)
 * @param {number} requestedSeason - Season number (1 = first season)
 * @returns {{ matches: boolean, reason: string, info: object }}
 */
function validateTorrentEpisode(title, requestedEpisode, requestedSeason = 1) {
  const info = extractEpisodeInfo(title);
  
  // Batch/season packs are valid - file selection happens at debrid resolution
  if (info.isBatch) {
    // If we have a range, validate the episode is within it
    if (info.batchRange) {
      const [start, end] = info.batchRange;
      if (requestedEpisode >= start && requestedEpisode <= end) {
        return { matches: true, reason: 'batch_contains_episode', info };
      } else {
        return { matches: false, reason: 'batch_episode_out_of_range', info };
      }
    }
    // Unknown range - allow it (we'll select file later)
    return { matches: true, reason: 'batch_unknown_range', info };
  }
  
  // If we couldn't extract episode info, reject (strict mode)
  if (info.episode === null) {
    return { matches: false, reason: 'no_episode_detected', info };
  }
  
  // Check for season match if torrent specifies a season
  if (info.season !== null && info.season !== requestedSeason) {
    return { matches: false, reason: 'season_mismatch', info };
  }
  
  // Direct episode match
  if (info.episode === requestedEpisode) {
    return { matches: true, reason: 'exact_match', info };
  }
  
  // No match
  return { matches: false, reason: 'episode_mismatch', info };
}

/**
 * Filter torrents to only include those matching the requested episode
 * @param {Array} torrents - Array of torrent objects with 'title' field
 * @param {number} episode - Requested episode number
 * @param {number} season - Requested season number
 * @returns {Array} Filtered torrents with match info
 */
function filterTorrentsByEpisode(torrents, episode, season = 1) {
  const filtered = [];
  
  for (const torrent of torrents) {
    const validation = validateTorrentEpisode(torrent.title, episode, season);
    
    if (validation.matches) {
      // Add match info to torrent for later use (e.g., batch file selection)
      filtered.push({
        ...torrent,
        _episodeInfo: validation.info,
        _matchReason: validation.reason
      });
    } else {
      console.log(`[Episode Filter] Rejected: "${torrent.title.substring(0, 60)}..." - ${validation.reason} (detected: E${validation.info.episode}${validation.info.season ? ' S' + validation.info.season : ''})`);
    }
  }
  
  return filtered;
}

/**
 * Extract info hash from magnet link
 */
function extractInfoHash(magnet) {
  const match = magnet.match(/urn:btih:([a-fA-F0-9]{40})/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Parse XML RSS to extract items (simple parser for Cloudflare Workers)
 */
function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    
    const getTag = (tag) => {
      const tagMatch = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return tagMatch ? tagMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    
    // Extract info hash from nyaa:infoHash tag
    const infoHashTag = getTag('nyaa:infoHash');
    
    // Also try to extract from link if it contains magnet
    let infoHashFromLink = '';
    const linkContent = getTag('link');
    if (linkContent) {
      const magnetMatch = linkContent.match(/urn:btih:([a-fA-F0-9]{40})/i);
      if (magnetMatch) infoHashFromLink = magnetMatch[1];
    }
    
    items.push({
      title: getTag('title'),
      link: linkContent,
      pubDate: getTag('pubDate'),
      size: getTag('nyaa:size') || getTag('size'),
      seeders: parseInt(getTag('nyaa:seeders') || '0'),
      leechers: parseInt(getTag('nyaa:leechers') || '0'),
      infoHash: infoHashTag || infoHashFromLink,
      category: getTag('nyaa:category') || getTag('category')
    });
  }
  
  return items;
}

/**
 * Scrape RAW anime torrents from Nyaa.si
 * @param {string} animeName - The anime name to search for
 * @param {number} episode - Optional specific episode number
 * @returns {Promise<Array>} Array of torrent objects
 */
async function scrapeNyaa(animeName, episode = null, season = 1) {
  const cacheKey = `nyaa:S${season}:${animeName}:${episode || 'all'}`;
  
  // Check cache
  const cached = torrentCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TORRENT_CACHE_TTL) {
    return cached.data;
  }
  
  // Clean up cache if too large
  if (torrentCache.size > MAX_TORRENT_CACHE_SIZE) {
    const entries = Array.from(torrentCache.entries());
    const toDelete = entries
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, Math.floor(MAX_TORRENT_CACHE_SIZE / 2));
    toDelete.forEach(([key]) => torrentCache.delete(key));
  }
  
  const torrents = [];
  
  try {
    // Build search queries for anime torrents
    const episodeQuery = episode ? `${episode}`.padStart(2, '0') : '';
    const paddedSeason = String(season).padStart(2, '0');
    const paddedEpisode = episode ? String(episode).padStart(2, '0') : '';
    
    // Clean up anime name for better search results
    // Remove special characters and curly quotes that might break search
    const cleanName = animeName
      .replace(/[:'!?""'']/g, '') // Remove punctuation including curly quotes
      .replace(/\s+/g, ' ')       // Normalize whitespace
      .trim();
    
    // Extract short name for better Nyaa matching
    // Nyaa titles often use Japanese names or shortened versions
    // E.g., "Frieren: Beyond Journey's End" -> "Frieren"
    const shortName = cleanName.split(/[:-]/)[0].replace(/^The\s+/i, '').trim();
    
    // Build search queries based on season
    // For season 1, use simpler queries; for season 2+, include season info
    let searchQueries;
    if (season > 1) {
      // Multi-season show - must include season identifier
      searchQueries = [
        `${shortName} S${paddedSeason}E${paddedEpisode}`.trim(),           // S02E03 format
        `${shortName} Season ${season} ${episodeQuery}`.trim(),            // "Season 2 03" format
        `${cleanName} S${paddedSeason}E${paddedEpisode}`.trim(),           // Full name S02E03
      ];
    } else {
      // Season 1 - simpler queries (most anime don't explicitly say S01)
      searchQueries = [
        `${shortName} ${episodeQuery}`.trim(),                              // Short name (e.g., "Frieren 02")
        `${cleanName} ${episodeQuery}`.trim(),                              // Full clean name
        `${shortName} S${paddedSeason}E${paddedEpisode}`.trim(),           // Also try S01E03 format
      ];
    }
    
    // Remove duplicates
    const uniqueQueries = [...new Set(searchQueries)].slice(0, 2);
    
    for (const query of uniqueQueries) {
      // Category 1_0 = ALL Anime (includes subbed, raw, everything)
      // f=0 = no filter, f=2 = trusted uploaders only
      const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=1_0&f=0`;
      
      console.log(`[Nyaa] Searching: ${url}`);
      
      const response = await fetch(url, {
        headers: buildBrowserHeaders(),
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      
      if (!response.ok) {
        console.error(`[Nyaa] Error: ${response.status}`);
        continue;
      }
      
      const xml = await response.text();
      const items = parseRSSItems(xml);
      
      // If we found results, no need to try other queries
      if (items.length > 0 && torrents.length === 0) {
        for (const item of items) {
          if (!item.title) continue;
          
          // Extract magnet link (nyaa puts it in the link or we construct it)
        let magnet = '';
        let infoHash = item.infoHash;
        
        if (item.link && item.link.includes('magnet:')) {
          magnet = item.link;
          infoHash = extractInfoHash(magnet);
        } else if (infoHash) {
          magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.title)}`;
        }
        
        if (!infoHash) continue;
        
        // Detect release info
        const quality = detectTorrentQuality(item.title);
        const source = detectSourceType(item.title);
        const isRaw = isRAWRelease(item.title);
        
        // Extract release group
        const groupMatch = item.title.match(/^\[([^\]]+)\]/);
        const releaseGroup = groupMatch ? groupMatch[1] : 'Unknown';
        
        torrents.push({
          title: item.title,
          infoHash: infoHash.toUpperCase(),
          magnet,
          quality,
          source,
          isRaw,
          releaseGroup,
          seeders: item.seeders,
          size: item.size,
          pubDate: item.pubDate,
          provider: 'Nyaa'
        });
        }
      }
      
      // If we found results, don't search other queries
      if (torrents.length > 0) break;
    }
    
    // Sort by seeders (most seeded first) then by quality
    const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'Unknown': 4 };
    torrents.sort((a, b) => {
      const qualityDiff = qualityOrder[a.quality] - qualityOrder[b.quality];
      if (qualityDiff !== 0) return qualityDiff;
      return b.seeders - a.seeders;
    });
    
    // EPISODE VALIDATION: Filter to only torrents matching requested episode
    let validatedTorrents = torrents;
    if (episode) {
      const beforeCount = torrents.length;
      validatedTorrents = filterTorrentsByEpisode(torrents, episode, season);
      console.log(`[Nyaa] Episode validation: ${validatedTorrents.length}/${beforeCount} torrents match E${episode} S${season}`);
    }
    
    // Cache validated results
    torrentCache.set(cacheKey, { data: validatedTorrents, timestamp: Date.now() });
    
    console.log(`[Nyaa] Found ${validatedTorrents.length} validated torrents for "${animeName}" E${episode || 'all'}`);
    return validatedTorrents;
    
  } catch (error) {
    console.error(`[Nyaa] Error scraping: ${error.message}`);
    return [];
  }
}

/**
 * Scrape torrents from AnimeTosho (aggregator)
 * @param {string} animeName - The anime name to search for
 * @param {number} episode - Optional specific episode number
 * @returns {Promise<Array>} Array of torrent objects
 */
async function scrapeAnimeTosho(animeName, episode = null, season = 1) {
  const cacheKey = `tosho:${animeName}:S${season}:${episode || 'all'}`;
  
  // Check cache
  const cached = torrentCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TORRENT_CACHE_TTL) {
    return cached.data;
  }
  
  const torrents = [];
  
  try {
    // Format episode/season numbers
    const paddedEpisode = episode ? String(episode).padStart(2, '0') : '';
    const paddedSeason = String(season).padStart(2, '0');
    
    // Build search queries based on season
    let searchQueries;
    if (season > 1) {
      // Multi-season show - must include season identifier
      searchQueries = [
        `${animeName} S${paddedSeason}E${paddedEpisode}`.trim(),      // S02E03 format
        `${animeName} Season ${season} ${paddedEpisode}`.trim(),       // "Season 2 03" format
      ];
    } else {
      // Season 1 - simpler queries
      searchQueries = [
        `${animeName} ${paddedEpisode}`.trim(),                        // Simple: "Anime 03"
        `${animeName} S${paddedSeason}E${paddedEpisode}`.trim(),      // Also try S01E03
      ];
    }
    
    // Remove duplicates and empty queries
    const uniqueQueries = [...new Set(searchQueries.filter(q => q.length > 0))];
    
    for (const query of uniqueQueries) {
      const url = `https://feed.animetosho.org/rss2?q=${encodeURIComponent(query)}&filter[0][t]=nyaa_class&filter[0][v]=trusted`;
    
      console.log(`[AnimeTosho] Searching: ${url}`);
    
      const response = await fetch(url, {
        headers: buildBrowserHeaders(),
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      
      if (!response.ok) {
        console.error(`[AnimeTosho] Error: ${response.status}`);
        continue; // Try next query instead of returning
      }
      
      const xml = await response.text();
      const items = parseRSSItems(xml);
      
      for (const item of items) {
        if (!item.title) continue;
        
        // AnimeTosho provides magnet in enclosure or link
        let magnet = '';
        let infoHash = '';
        
        // Try to find torrent hash in the link
        const hashMatch = item.link.match(/\/([a-f0-9]{40})/i);
        if (hashMatch) {
          infoHash = hashMatch[1].toUpperCase();
          magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.title)}`;
        }
        
        if (!infoHash) continue;
        
        // Skip if we already have this torrent (from another query)
        if (torrents.find(t => t.infoHash === infoHash)) continue;
        
        const quality = detectTorrentQuality(item.title);
        const source = detectSourceType(item.title);
        const isRaw = isRAWRelease(item.title);
        
        const groupMatch = item.title.match(/^\[([^\]]+)\]/);
        const releaseGroup = groupMatch ? groupMatch[1] : 'Unknown';
        
        torrents.push({
          title: item.title,
          infoHash,
          magnet,
          quality,
          source,
          isRaw,
          releaseGroup,
          seeders: item.seeders || 0,
          size: item.size,
          pubDate: item.pubDate,
          provider: 'AnimeTosho'
        });
      }
      
      // If we found results, don't need to try more queries
      if (torrents.length > 0) break;
    }
    
    // Sort by quality and seeders
    const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'Unknown': 4 };
    torrents.sort((a, b) => {
      const qualityDiff = qualityOrder[a.quality] - qualityOrder[b.quality];
      if (qualityDiff !== 0) return qualityDiff;
      return b.seeders - a.seeders;
    });
    
    // EPISODE VALIDATION: Filter to only torrents matching requested episode
    let validatedTorrents = torrents;
    if (episode) {
      const beforeCount = torrents.length;
      validatedTorrents = filterTorrentsByEpisode(torrents, episode, season);
      console.log(`[AnimeTosho] Episode validation: ${validatedTorrents.length}/${beforeCount} torrents match E${episode} S${season}`);
    }
    
    // Cache validated results
    torrentCache.set(cacheKey, { data: validatedTorrents, timestamp: Date.now() });
    
    console.log(`[AnimeTosho] Found ${validatedTorrents.length} validated torrents for "${animeName}" E${episode || 'all'}`);
    return validatedTorrents;
    
  } catch (error) {
    console.error(`[AnimeTosho] Error scraping: ${error.message}`);
    return [];
  }
}

/**
 * Scrape torrents from AnimeTosho using AniDB ID (most accurate method)
 * Uses JSON endpoint for structured data with AniDB episode IDs
 * @param {number} anidbId - The AniDB ID to search for
 * @param {number} episode - Optional specific episode number
 * @param {number} season - Season number for multi-season shows
 * @returns {Promise<Array>} Array of torrent objects
 */
async function scrapeAnimeToshoByAniDbId(anidbId, episode = null, season = 1) {
  if (!anidbId) {
    console.log('[AnimeTosho-AniDB] No AniDB ID provided');
    return [];
  }
  
  const cacheKey = `tosho-aid:${anidbId}:S${season}:${episode || 'all'}`;
  
  // Check cache
  const cached = torrentCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TORRENT_CACHE_TTL) {
    return cached.data;
  }
  
  const torrents = [];
  
  try {
    // Use JSON endpoint for structured data (includes anidb_eid for exact episode matching!)
    // The `aid` parameter filters to only torrents for this specific anime
    const url = `https://feed.animetosho.org/json?aid=${anidbId}`;
    
    console.log(`[AnimeTosho-AniDB] Fetching JSON for AniDB ID ${anidbId}`);
    
    const response = await fetch(url, {
      headers: buildBrowserHeaders(),
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    
    if (!response.ok) {
      console.error(`[AnimeTosho-AniDB] Error: ${response.status}`);
      return [];
    }
    
    const items = await response.json();
    
    if (!Array.isArray(items)) {
      console.error('[AnimeTosho-AniDB] Invalid JSON response');
      return [];
    }
    
    console.log(`[AnimeTosho-AniDB] Found ${items.length} raw items for AniDB ID ${anidbId}`);
    
    for (const item of items) {
      if (!item.title || !item.info_hash) continue;
      
      const infoHash = item.info_hash.toUpperCase();
      const magnet = item.magnet_uri || `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.title)}`;
      
      const quality = detectTorrentQuality(item.title);
      const source = detectSourceType(item.title);
      const isRaw = isRAWRelease(item.title);
      
      const groupMatch = item.title.match(/^\[([^\]]+)\]/);
      const releaseGroup = groupMatch ? groupMatch[1] : 'Unknown';
      
      // Format size from bytes
      let sizeStr = '';
      if (item.total_size) {
        const bytes = item.total_size;
        if (bytes >= 1073741824) sizeStr = `${(bytes / 1073741824).toFixed(2)} GB`;
        else if (bytes >= 1048576) sizeStr = `${(bytes / 1048576).toFixed(1)} MB`;
        else sizeStr = `${Math.round(bytes / 1024)} KB`;
      }
      
      torrents.push({
        title: item.title,
        infoHash,
        magnet,
        quality,
        source,
        isRaw,
        releaseGroup,
        seeders: item.seeders || 0,
        leechers: item.leechers || 0,
        size: sizeStr,
        totalSize: item.total_size || 0,
        pubDate: item.timestamp ? new Date(item.timestamp * 1000).toISOString() : null,
        provider: 'AnimeTosho-AniDB',
        // AniDB episode ID for exact matching (when available)
        anidbEpisodeId: item.anidb_eid || null,
        anidbFileId: item.anidb_fid || null,
        nyaaId: item.nyaa_id || null,
      });
    }
    
    // Sort by quality and seeders
    const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'Unknown': 4 };
    torrents.sort((a, b) => {
      const qualityDiff = qualityOrder[a.quality] - qualityOrder[b.quality];
      if (qualityDiff !== 0) return qualityDiff;
      return b.seeders - a.seeders;
    });
    
    // EPISODE VALIDATION: Filter to only torrents matching requested episode
    let validatedTorrents = torrents;
    if (episode) {
      const beforeCount = torrents.length;
      validatedTorrents = filterTorrentsByEpisode(torrents, episode, season);
      console.log(`[AnimeTosho-AniDB] Episode validation: ${validatedTorrents.length}/${beforeCount} torrents match E${episode} S${season}`);
    }
    
    // Cache validated results
    torrentCache.set(cacheKey, { data: validatedTorrents, timestamp: Date.now() });
    
    console.log(`[AnimeTosho-AniDB] Found ${validatedTorrents.length} validated torrents for AniDB ID ${anidbId} E${episode || 'all'}`);
    return validatedTorrents;
    
  } catch (error) {
    console.error(`[AnimeTosho-AniDB] Error scraping: ${error.message}`);
    return [];
  }
}

/**
 * Scrape Nyaa with synonym support for better matching
 * @param {Array<string>} synonyms - Alternative titles for the anime
 * @param {number} episode - Optional specific episode number
 * @param {number} season - Season number
 * @returns {Promise<Array>} Array of torrent objects
 */
async function scrapeNyaaWithSynonyms(synonyms, episode = null, season = 1) {
  if (!synonyms || synonyms.length === 0) {
    return [];
  }
  
  const allResults = [];
  const seenHashes = new Set();
  
  // Try each synonym until we find results (max 3 to avoid rate limiting)
  for (const synonym of synonyms.slice(0, 3)) {
    if (!synonym || synonym.length < 3) continue;
    
    try {
      const results = await scrapeNyaa(synonym, episode, season);
      
      for (const torrent of results) {
        if (!seenHashes.has(torrent.infoHash)) {
          seenHashes.add(torrent.infoHash);
          allResults.push(torrent);
        }
      }
      
      // If we found results, return them (synonyms are tried in priority order)
      if (allResults.length > 0) {
        console.log(`[Nyaa-Synonyms] Found ${allResults.length} torrents using synonym: "${synonym}"`);
        break;
      }
    } catch (error) {
      console.error(`[Nyaa-Synonyms] Error with "${synonym}": ${error.message}`);
    }
  }
  
  return allResults;
}

/**
 * Get all torrent results for an anime (from multiple sources)
 * Enhanced version that uses AniDB ID for accurate results when available
 * 
 * @param {Object|string} anime - Either anime object with IDs or just the name
 * @param {number} episode - Optional specific episode number
 * @param {number} season - Season number (default 1)
 * @returns {Promise<Array>} Combined and deduplicated torrent results
 * 
 * Search priority:
 * 1. AnimeTosho by AniDB ID (most accurate, 100% reliable when available)
 * 2. Title-based search on Nyaa and AnimeTosho
 * 3. Synonym-based search if primary title yields no results
 */
async function getTorrentStreams(anime, episode = null, season = 1) {
  // Handle both old string-based calls and new object-based calls
  const animeName = typeof anime === 'string' ? anime : 
    (anime.name || anime.title?.userPreferred || anime.title?.romaji || 'Unknown');
  const anidbId = typeof anime === 'object' ? (anime.anidb_id || anime.adb) : null;
  const synonyms = typeof anime === 'object' ? (anime.synonyms || []) : [];
  
  console.log(`[TorrentStreams] Searching for "${animeName}" E${episode || 'all'} S${season}${anidbId ? ` (AniDB: ${anidbId})` : ''}`);
  
  // Build parallel search tasks
  const searchTasks = [];
  
  // Priority 1: AniDB ID-based search (most accurate)
  if (anidbId) {
    searchTasks.push(scrapeAnimeToshoByAniDbId(anidbId, episode, season));
  }
  
  // Priority 2: Title-based search on both Nyaa and AnimeTosho
  searchTasks.push(scrapeNyaa(animeName, episode, season));
  searchTasks.push(scrapeAnimeTosho(animeName, episode, season));
  
  // Execute all searches in parallel
  const results = await Promise.all(searchTasks);
  
  // Flatten results based on search order
  let anidbResults = [];
  let nyaaResults = [];
  let toshoResults = [];
  
  if (anidbId) {
    anidbResults = results[0] || [];
    nyaaResults = results[1] || [];
    toshoResults = results[2] || [];
  } else {
    nyaaResults = results[0] || [];
    toshoResults = results[1] || [];
  }
  
  // Combine and deduplicate by info hash
  // Priority: AniDB results first (most accurate), then others
  const seen = new Set();
  const combined = [];
  
  // Add AniDB results first (highest priority)
  for (const torrent of anidbResults) {
    if (!seen.has(torrent.infoHash)) {
      seen.add(torrent.infoHash);
      combined.push(torrent);
    }
  }
  
  // Add title-based results
  for (const torrent of [...nyaaResults, ...toshoResults]) {
    if (!seen.has(torrent.infoHash)) {
      seen.add(torrent.infoHash);
      combined.push(torrent);
    }
  }
  
  // If no results and we have synonyms, try synonym search
  if (combined.length === 0 && synonyms.length > 0) {
    console.log(`[TorrentStreams] No results for primary title, trying ${synonyms.length} synonyms...`);
    const synonymResults = await scrapeNyaaWithSynonyms(synonyms, episode, season);
    
    for (const torrent of synonymResults) {
      if (!seen.has(torrent.infoHash)) {
        seen.add(torrent.infoHash);
        combined.push(torrent);
      }
    }
  }
  
  // Re-sort combined results
  const qualityOrder = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'Unknown': 4 };
  combined.sort((a, b) => {
    // RAW releases first
    if (a.isRaw !== b.isRaw) return a.isRaw ? -1 : 1;
    // Prefer AniDB results (more accurate)
    if (a.provider?.includes('AniDB') !== b.provider?.includes('AniDB')) {
      return a.provider?.includes('AniDB') ? -1 : 1;
    }
    const qualityDiff = qualityOrder[a.quality] - qualityOrder[b.quality];
    if (qualityDiff !== 0) return qualityDiff;
    return b.seeders - a.seeders;
  });
  
  console.log(`[TorrentStreams] Total: ${combined.length} torrents (AniDB: ${anidbResults.length}, Nyaa: ${nyaaResults.length}, Tosho: ${toshoResults.length})`);
  
  return combined;
}

// ===== DEBRID PROVIDER INTEGRATION =====

const DEBRID_PROVIDERS = {
  realdebrid: {
    key: 'realdebrid',
    name: 'Real-Debrid',
    shortName: 'RD',
    apiBaseUrl: 'https://api.real-debrid.com/rest/1.0'
  },
  alldebrid: {
    key: 'alldebrid',
    name: 'AllDebrid',
    shortName: 'AD',
    apiBaseUrl: 'https://api.alldebrid.com/v4'
  },
  premiumize: {
    key: 'premiumize',
    name: 'Premiumize',
    shortName: 'PM',
    apiBaseUrl: 'https://www.premiumize.me/api'
  },
  torbox: {
    key: 'torbox',
    name: 'TorBox',
    shortName: 'TB',
    apiBaseUrl: 'https://api.torbox.app/v1/api'
  },
  debridlink: {
    key: 'debridlink',
    name: 'Debrid-Link',
    shortName: 'DL',
    apiBaseUrl: 'https://debrid-link.com/api/v2'
  }
};

// Debrid resolution cache (1-4 hours)
const debridCache = new Map();
const DEBRID_CACHE_TTL = 3600000; // 1 hour
const MAX_DEBRID_CACHE_SIZE = 200;

/**
 * Check if a torrent is cached on Real-Debrid
 */
async function checkRealDebridCache(infoHash, apiKey) {
  try {
    const response = await fetch(
      `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${infoHash}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data[infoHash.toLowerCase()]?.rd?.[0] || null;
  } catch (error) {
    console.error(`[RD] Cache check error: ${error.message}`);
    return null;
  }
}

/**
 * Add magnet to Real-Debrid and get download link
 */
async function resolveRealDebrid(magnet, apiKey, fileIndex = 0, episode = null, season = 1) {
  try {
    // Step 1: Add magnet
    const addResponse = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `magnet=${encodeURIComponent(magnet)}`
    });
    
    if (!addResponse.ok) {
      throw new Error(`Failed to add magnet: ${addResponse.status}`);
    }
    
    const addData = await addResponse.json();
    const torrentId = addData.id;
    
    // Step 2: Get torrent info
    const infoResponse = await fetch(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    if (!infoResponse.ok) {
      throw new Error(`Failed to get torrent info: ${infoResponse.status}`);
    }
    
    const infoData = await infoResponse.json();
    
    // Step 3: Select files (if needed)
    if (infoData.status === 'waiting_files_selection') {
      const files = infoData.files || [];
      const videoFiles = files.filter(f => /\.(mkv|mp4|avi|webm|ts|m2ts)$/i.test(f.path));
      
      // Smart file selection for batch torrents using episode extraction
      let selectedFile = null;
      
      if (episode && videoFiles.length > 1) {
        console.log(`[RD Files] Looking for episode ${episode} in ${videoFiles.length} files...`);
        
        const candidates = [];
        
        for (const file of videoFiles) {
          // Skip obvious non-episode files
          if (/(NCOP|NCED|Preview|Special|SP[^a-z]|OVA|Menu|Trailer|PV|CM|Bonus)/i.test(file.path)) {
            continue;
          }
          
          // Extract episode info from filename (use path's filename part)
          const filename = file.path.split('/').pop();
          const info = extractEpisodeInfo(filename);
          
          if (info.episode === episode) {
            // Check season if specified in filename
            if (info.season !== null && info.season !== season) {
              continue;
            }
            candidates.push({ file, info });
            console.log(`[RD Files] Match: ${filename} (E${info.episode})`);
          }
        }
        
        // Select best candidate by file size
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.file.bytes - a.file.bytes);
          selectedFile = candidates[0].file;
          console.log(`[RD Files] Selected: ${selectedFile.path}`);
        }
      }
      
      // Fallback to specified index or largest video file
      if (!selectedFile) {
        const sortedBySize = [...videoFiles].sort((a, b) => b.bytes - a.bytes);
        selectedFile = videoFiles[fileIndex] || sortedBySize[0];
      }
      
      if (!selectedFile) {
        throw new Error('No video files found in torrent');
      }
      
      await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `files=${selectedFile.id}`
      });
      
      // Wait for processing
      await new Promise(r => setTimeout(r, 2000));
    }
    
    // Step 4: Get updated info with links
    const finalResponse = await fetch(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    const finalData = await finalResponse.json();
    
    if (finalData.links && finalData.links.length > 0) {
      // Step 5: Unrestrict the link
      const unrestrictResponse = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `link=${encodeURIComponent(finalData.links[0])}`
      });
      
      const unrestrictData = await unrestrictResponse.json();
      return unrestrictData.download || null;
    }
    
    return null;
  } catch (error) {
    console.error(`[RD] Resolve error: ${error.message}`);
    return null;
  }
}

/**
 * Check if torrents are cached on AllDebrid (batch check via magnet/upload)
 * AllDebrid returns ready=true if torrent is already cached
 * @param {string[]} infoHashes - Array of info hashes to check
 * @param {string} apiKey - AllDebrid API key
 * @returns {Promise<Map<string, boolean>>} - Map of infoHash -> cached status
 */
async function checkAllDebridCacheBatch(infoHashes, apiKey) {
  const results = new Map();
  
  try {
    // AllDebrid magnet/upload accepts multiple magnets and returns ready status
    const magnetsParam = infoHashes.map(h => `magnets[]=${h}`).join('&');
    const response = await fetch(
      `https://api.alldebrid.com/v4/magnet/upload`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: magnetsParam
      }
    );
    
    if (!response.ok) {
      console.error(`[AD] Cache check failed: ${response.status}`);
      infoHashes.forEach(h => results.set(h.toLowerCase(), null));
      return results;
    }
    
    const data = await response.json();
    
    // Check for API errors
    if (data.status === 'error') {
      console.error(`[AD] API error: ${data.error?.code} - ${data.error?.message}`);
      infoHashes.forEach(h => results.set(h.toLowerCase(), null));
      return results;
    }
    
    const magnets = data.data?.magnets || [];
    console.log(`[AD] Cache check returned ${magnets.length} results`);
    
    // Process results and delete non-cached magnets to not clutter user's account
    for (const magnet of magnets) {
      const hash = magnet.hash?.toLowerCase();
      if (hash) {
        results.set(hash, magnet.ready === true);
        
        // If not cached (ready=false), delete the magnet to clean up
        if (!magnet.ready && magnet.id) {
          // Fire and forget - don't await
          fetch(`https://api.alldebrid.com/v4/magnet/delete`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `id=${magnet.id}`
          }).catch(() => {});
        }
      }
    }
    
    // Mark any missing hashes as unknown
    infoHashes.forEach(h => {
      if (!results.has(h.toLowerCase())) {
        results.set(h.toLowerCase(), null);
      }
    });
    
    return results;
  } catch (error) {
    console.error(`[AD] Cache check error: ${error.message}`);
    infoHashes.forEach(h => results.set(h.toLowerCase(), null));
    return results;
  }
}

/**
 * Check if torrents are cached on Real-Debrid (batch check)
 * @param {string[]} infoHashes - Array of info hashes to check
 * @param {string} apiKey - Real-Debrid API key
 * @returns {Promise<Map<string, boolean>>} - Map of infoHash -> cached status
 */
async function checkRealDebridCacheBatch(infoHashes, apiKey) {
  const results = new Map();
  
  try {
    // Real-Debrid instant availability accepts multiple hashes separated by /
    const hashesPath = infoHashes.join('/');
    const response = await fetch(
      `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashesPath}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    if (!response.ok) {
      console.error(`[RD] Cache check failed: ${response.status}`);
      infoHashes.forEach(h => results.set(h.toLowerCase(), null));
      return results;
    }
    
    const data = await response.json();
    
    // Real-Debrid returns { "hash": { "rd": [...] } } for cached torrents
    for (const hash of infoHashes) {
      const lowerHash = hash.toLowerCase();
      const cached = data[lowerHash]?.rd && data[lowerHash].rd.length > 0;
      results.set(lowerHash, cached);
    }
    
    return results;
  } catch (error) {
    console.error(`[RD] Cache check error: ${error.message}`);
    infoHashes.forEach(h => results.set(h.toLowerCase(), null));
    return results;
  }
}

/**
 * Check cache status for multiple torrents on the configured debrid provider
 * @param {string[]} infoHashes - Array of info hashes
 * @param {string} provider - Debrid provider key
 * @param {string} apiKey - API key
 * @returns {Promise<Map<string, boolean|null>>} - Map of hash -> cached (true/false/null for unknown)
 */
async function checkDebridCacheBatch(infoHashes, provider, apiKey) {
  if (!infoHashes.length || !provider || !apiKey) {
    return new Map();
  }
  
  switch (provider) {
    case 'alldebrid':
      return checkAllDebridCacheBatch(infoHashes, apiKey);
    case 'realdebrid':
      return checkRealDebridCacheBatch(infoHashes, apiKey);
    // TODO: Add other providers
    default:
      // Unknown provider - return all as unknown
      const results = new Map();
      infoHashes.forEach(h => results.set(h.toLowerCase(), null));
      return results;
  }
}

/**
 * Add magnet to AllDebrid and get download link
 * IMPROVED: Fail fast for non-cached torrents, better magnet handling
 */
async function resolveAllDebrid(magnet, apiKey, fileIndex = 0, episode = null, season = 1) {
  try {
    console.log(`[AD Resolve] Starting resolution for magnet${episode ? ` (looking for S${season}E${episode})` : ''}`);
    
    // Step 1: Upload magnet (POST method)
    const uploadResponse = await fetch(
      `https://api.alldebrid.com/v4/magnet/upload`,
      { 
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `magnets[]=${encodeURIComponent(magnet)}`
      }
    );
    
    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload magnet: ${uploadResponse.status}`);
    }
    
    const uploadData = await uploadResponse.json();
    console.log(`[AD Resolve] Upload response: ${JSON.stringify(uploadData).substring(0, 200)}`);
    
    if (uploadData.status === 'error') {
      throw new Error(`AllDebrid error: ${uploadData.error?.message || 'Unknown'}`);
    }
    
    const magnetInfo = uploadData.data?.magnets?.[0];
    
    // Check for magnet-level errors
    if (magnetInfo?.error) {
      throw new Error(`AllDebrid magnet error: ${magnetInfo.error.message || magnetInfo.error.code || 'Unknown'}`);
    }
    
    const magnetId = magnetInfo?.id;
    
    if (!magnetId) {
      throw new Error('Failed to get magnet ID');
    }
    
    // If already ready (cached), get files directly - FAST PATH
    if (magnetInfo.ready === true) {
      console.log(`[AD Resolve] Magnet already cached, getting files`);
      return await getAllDebridFiles(magnetId, apiKey, fileIndex, episode, season);
    }
    
    // NOT CACHED - Let AllDebrid download it and poll for completion
    console.log(`[AD Resolve] Torrent NOT cached - starting download on AllDebrid`);
    
    // Step 2: Wait for processing using v4.1 endpoint (POST method)
    // Poll every 2 seconds for up to 60 seconds (30 attempts)
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds between checks
      attempts++;
      
      console.log(`[AD Resolve] Checking download status ${attempts}/${maxAttempts}`);
      
      const statusResponse = await fetch(
        `https://api.alldebrid.com/v4.1/magnet/status`,
        { 
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `id=${magnetId}`
        }
      );
      
      const statusData = await statusResponse.json();
      
      if (statusData.status === 'error') {
        console.error(`[AD Resolve] Status error: ${statusData.error?.message}`);
        continue; // Try again
      }
      
      // v4.1 returns magnets as object not array when querying single ID
      const magnetStatus = statusData.data?.magnets;
      const statusCode = magnetStatus?.statusCode;
      const status = magnetStatus?.status;
      
      console.log(`[AD Resolve] Status: ${status} (code: ${statusCode})`);
      
      // Status 4 = Ready
      if (statusCode === 4) {
        console.log(`[AD Resolve] Download complete! Getting files...`);
        return await getAllDebridFiles(magnetId, apiKey, fileIndex, episode, season);
      }
      
      // Status >= 5 = Error
      if (statusCode >= 5) {
        console.error(`[AD Resolve] Download failed with status: ${status}`);
        return { status: 'error', message: `Download failed: ${status}` };
      }
      
      // Status 0-3 = Still downloading, show progress
      if (magnetStatus?.downloaded && magnetStatus?.size) {
        const progress = Math.round((magnetStatus.downloaded / magnetStatus.size) * 100);
        console.log(`[AD Resolve] Downloading: ${progress}%`);
      }
    }
    
    // Timeout - torrent is still downloading but taking too long
    console.log(`[AD Resolve] Timeout waiting for download - still in progress on AllDebrid`);
    return { status: 'downloading', message: 'Download started on AllDebrid but taking a while. Check your AllDebrid account or try a cached ⚡ torrent.' };
  } catch (error) {
    console.error(`[AD Resolve] Error: ${error.message}`);
    return null;
  }
}

/**
 * Get files from AllDebrid magnet and unlock the video link
 * Implements smart file selection for batch torrents based on episode number
 */
async function getAllDebridFiles(magnetId, apiKey, fileIndex = 0, episode = null, season = 1) {
  try {
    // Get files using /magnet/files endpoint
    const filesResponse = await fetch(
      `https://api.alldebrid.com/v4/magnet/files`,
      { 
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `id[]=${magnetId}`
      }
    );
    
    const filesData = await filesResponse.json();
    console.log(`[AD Files] Response: ${JSON.stringify(filesData).substring(0, 500)}`);
    
    if (filesData.status === 'error') {
      throw new Error(`Files error: ${filesData.error?.message || 'Unknown'}`);
    }
    
    const magnetFiles = filesData.data?.magnets?.[0]?.files || [];
    
    // Flatten the file tree and find video files
    const videoFiles = [];
    function extractFiles(items) {
      for (const item of items) {
        if (item.e) {
          // It's a folder, recurse
          extractFiles(item.e);
        } else if (item.l && /\.(mkv|mp4|avi|webm|ts|m2ts)$/i.test(item.n)) {
          // It's a video file with a link
          videoFiles.push({ filename: item.n, size: item.s || 0, link: item.l });
        }
      }
    }
    extractFiles(magnetFiles);
    
    console.log(`[AD Files] Found ${videoFiles.length} video files`);
    
    if (videoFiles.length === 0) {
      throw new Error('No video files found in torrent');
    }
    
    // Smart file selection when episode is specified and there are multiple files
    let selectedFile = null;
    
    if (episode && videoFiles.length > 1) {
      console.log(`[AD Files] Looking for episode ${episode} in ${videoFiles.length} files...`);
      
      // Use the episode extraction system for accurate file matching
      const candidates = [];
      
      for (const file of videoFiles) {
        // Skip obvious non-episode files
        if (/(NCOP|NCED|Preview|Special|SP[^a-z]|OVA|Menu|Trailer|PV|CM|Bonus)/i.test(file.filename)) {
          console.log(`[AD Files] Skipping non-episode: ${file.filename}`);
          continue;
        }
        
        // Extract episode info from filename
        const info = extractEpisodeInfo(file.filename);
        
        if (info.episode === episode) {
          // Check season if specified in filename
          if (info.season !== null && info.season !== season) {
            console.log(`[AD Files] Season mismatch: ${file.filename} (S${info.season} != S${season})`);
            continue;
          }
          
          candidates.push({ file, info, exactMatch: true });
          console.log(`[AD Files] Exact match: ${file.filename} (E${info.episode})`);
        }
      }
      
      // Select best candidate (prefer exact matches, then by file size)
      if (candidates.length > 0) {
        // Sort by size descending (prefer larger files = higher quality)
        candidates.sort((a, b) => b.file.size - a.file.size);
        selectedFile = candidates[0].file;
        console.log(`[AD Files] Selected: ${selectedFile.filename}`);
      } else {
        // STRICT MODE: No fallback to position-based selection
        // This prevents wrong episode selection in batch torrents
        console.log(`[AD Files] WARNING: No file matched episode ${episode} - will use largest file`);
      }
    }
    
    // Fallback to specified index or largest file
    if (!selectedFile) {
      selectedFile = videoFiles[fileIndex] || videoFiles.sort((a, b) => b.size - a.size)[0];
    }
    
    console.log(`[AD Files] Selected: ${selectedFile.filename}`);
    
    // Unlock the link (POST method)
    const unlockResponse = await fetch(
      `https://api.alldebrid.com/v4/link/unlock`,
      { 
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `link=${encodeURIComponent(selectedFile.link)}`
      }
    );
    
    const unlockData = await unlockResponse.json();
    console.log(`[AD Unlock] Response: ${JSON.stringify(unlockData).substring(0, 300)}`);
    
    if (unlockData.status === 'error') {
      throw new Error(`Unlock error: ${unlockData.error?.message || 'Unknown'}`);
    }
    
    return unlockData.data?.link || null;
  } catch (error) {
    console.error(`[AD Files] Error: ${error.message}`);
    return null;
  }
}

/**
 * Resolve magnet to direct link using configured debrid provider
 */
async function resolveDebrid(magnet, infoHash, provider, apiKey, fileIndex = 0, episode = null, season = 1) {
  // Include episode in cache key for batch torrents
  const cacheKey = `debrid:${provider}:${infoHash}:${episode || 'all'}`;
  
  // Check cache (only cache successful URL strings, not status objects)
  const cached = debridCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DEBRID_CACHE_TTL && typeof cached.data === 'string') {
    return cached.data;
  }
  
  // Clean up cache if too large
  if (debridCache.size > MAX_DEBRID_CACHE_SIZE) {
    const entries = Array.from(debridCache.entries());
    const toDelete = entries
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, Math.floor(MAX_DEBRID_CACHE_SIZE / 2));
    toDelete.forEach(([key]) => debridCache.delete(key));
  }
  
  let result = null;
  
  switch (provider) {
    case 'realdebrid':
      result = await resolveRealDebrid(magnet, apiKey, fileIndex, episode, season);
      break;
    case 'alldebrid':
      result = await resolveAllDebrid(magnet, apiKey, fileIndex, episode, season);
      break;
    // Add more providers as needed
    default:
      console.error(`[Debrid] Unknown provider: ${provider}`);
  }
  
  // Only cache successful URL strings, not status objects
  if (result && typeof result === 'string') {
    debridCache.set(cacheKey, { data: result, timestamp: Date.now() });
  }
  
  return result;
}

/**
 * Build play URL for debrid resolution (click-time resolution)
 */
function buildDebridPlayUrl(baseUrl, infoHash, magnet, provider, apiKey, fileIndex = 0) {
  const params = new URLSearchParams({
    ih: infoHash,
    p: provider,
    idx: String(fileIndex)
  });
  
  // Don't include API key in URL - it will be pulled from user config
  return `${baseUrl}/debrid/play?${params.toString()}`;
}

// ===== SOFT SUBTITLE INTEGRATION =====

/**
 * Scrape subtitles from Kitsunekko (Japanese/English anime subs)
 * @param {string} animeName - The anime name to search for
 * @returns {Promise<Array>} Array of subtitle objects
 */
async function scrapeKitsunekko(animeName) {
  const cacheKey = `kitsunekko:${animeName}`;
  
  // Check cache
  const cached = subtitleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SUBTITLE_CACHE_TTL) {
    return cached.data;
  }
  
  // Clean up cache if too large
  if (subtitleCache.size > MAX_SUBTITLE_CACHE_SIZE) {
    const entries = Array.from(subtitleCache.entries());
    const toDelete = entries
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, Math.floor(MAX_SUBTITLE_CACHE_SIZE / 2));
    toDelete.forEach(([key]) => subtitleCache.delete(key));
  }
  
  const subtitles = [];
  
  try {
    // Kitsunekko directory listing
    const cleanName = animeName.replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    const url = `https://kitsunekko.net/dirlist.php?dir=subtitles%2Fjapanese%2F${encodeURIComponent(cleanName)}%2F`;
    
    console.log(`[Kitsunekko] Searching: ${url}`);
    
    const response = await fetch(url, {
      headers: buildBrowserHeaders(),
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    
    if (!response.ok) {
      // Try alternate path formats
      return [];
    }
    
    const html = await response.text();
    
    // Parse directory listing for subtitle files
    const fileRegex = /href="([^"]+\.(ass|srt|ssa|sub))"[^>]*>([^<]+)</gi;
    let match;
    
    while ((match = fileRegex.exec(html)) !== null) {
      const filename = match[3];
      const filePath = match[1];
      const ext = match[2].toLowerCase();
      
      // Detect episode from filename
      const epMatch = filename.match(/(?:ep?|episode|e)(\d+)/i) || filename.match(/(\d{2,3})/);
      const episode = epMatch ? parseInt(epMatch[1]) : null;
      
      // Detect language
      const isJapanese = /\[JP\]|\[JPN\]|japanese|日本語/i.test(filename);
      const lang = isJapanese ? 'jpn' : 'eng';
      
      subtitles.push({
        id: `kitsunekko-${lang}-${filename.replace(/\W/g, '')}`,
        url: `https://kitsunekko.net${filePath.startsWith('/') ? '' : '/'}${filePath}`,
        lang,
        episode,
        filename,
        format: ext,
        provider: 'Kitsunekko'
      });
    }
    
    // Cache results
    subtitleCache.set(cacheKey, { data: subtitles, timestamp: Date.now() });
    
    console.log(`[Kitsunekko] Found ${subtitles.length} subtitles for "${animeName}"`);
    return subtitles;
    
  } catch (error) {
    console.error(`[Kitsunekko] Error: ${error.message}`);
    return [];
  }
}

/**
 * Search subtitles from OpenSubtitles API
 * @param {string} imdbId - IMDB ID (tt1234567)
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @param {Array} languages - Array of language codes (e.g., ['en', 'ja'])
 * @returns {Promise<Array>} Array of subtitle objects
 */
async function searchOpenSubtitles(imdbId, season, episode, languages = ['en']) {
  const cacheKey = `opensubs:${imdbId}:${season}:${episode}:${languages.join(',')}`;
  
  // Check cache
  const cached = subtitleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SUBTITLE_CACHE_TTL) {
    return cached.data;
  }
  
  const subtitles = [];
  
  try {
    // OpenSubtitles requires API key - check if configured
    // For now, use public (limited) endpoint
    const url = `https://rest.opensubtitles.org/search/imdbid-${imdbId.replace('tt', '')}/season-${season}/episode-${episode}`;
    
    console.log(`[OpenSubtitles] Searching: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AnimeStream v1.0',
        ...buildBrowserHeaders()
      },
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    
    if (!response.ok) {
      console.error(`[OpenSubtitles] Error: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    
    // Filter by requested languages and format results
    for (const sub of data) {
      const langCode = sub.ISO639?.toLowerCase() || sub.SubLanguageID?.toLowerCase();
      
      if (languages.length === 0 || languages.includes(langCode) || languages.includes(sub.SubLanguageID)) {
        subtitles.push({
          id: `opensubs-${sub.IDSubtitleFile}`,
          url: sub.SubDownloadLink?.replace('.gz', ''),
          lang: langCode,
          episode: parseInt(sub.SeriesEpisode) || episode,
          filename: sub.SubFileName,
          format: sub.SubFormat || 'srt',
          provider: 'OpenSubtitles',
          rating: parseFloat(sub.SubRating) || 0
        });
      }
    }
    
    // Sort by rating
    subtitles.sort((a, b) => b.rating - a.rating);
    
    // Cache results
    subtitleCache.set(cacheKey, { data: subtitles, timestamp: Date.now() });
    
    console.log(`[OpenSubtitles] Found ${subtitles.length} subtitles`);
    return subtitles;
    
  } catch (error) {
    console.error(`[OpenSubtitles] Error: ${error.message}`);
    return [];
  }
}

/**
 * Get all subtitles for an anime episode from multiple sources
 */
async function getSubtitles(animeName, imdbId, season, episode, languages = ['en', 'ja']) {
  // Fetch from both sources in parallel
  const [kitsunekkoSubs, openSubs, subdlSubs] = await Promise.all([
    scrapeKitsunekko(animeName),
    imdbId ? searchOpenSubtitles(imdbId, season, episode, languages) : Promise.resolve([]),
    searchSubDL(animeName, season, episode, languages)
  ]);
  
  // Filter Kitsunekko subs by episode
  const episodeSubs = kitsunekkoSubs.filter(s => !s.episode || s.episode === episode);
  
  // Combine and deduplicate
  const combined = [...episodeSubs, ...openSubs, ...subdlSubs];
  
  // Sort: Japanese subs first (for RAW content), then by language preference
  const langOrder = { 'jpn': 0, 'ja': 0, 'eng': 1, 'en': 1 };
  combined.sort((a, b) => {
    const aOrder = langOrder[a.lang] ?? 99;
    const bOrder = langOrder[b.lang] ?? 99;
    return aOrder - bOrder;
  });
  
  return combined;
}

/**
 * Search subtitles from SubDL API (good anime coverage)
 * @param {string} animeName - Anime name to search
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @param {Array} languages - Array of language codes
 * @returns {Promise<Array>} Array of subtitle objects
 */
async function searchSubDL(animeName, season, episode, languages = ['en']) {
  const cacheKey = `subdl:${animeName}:${season}:${episode}`;
  
  // Check cache
  const cached = subtitleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SUBTITLE_CACHE_TTL) {
    return cached.data;
  }
  
  const subtitles = [];
  
  try {
    // SubDL search API
    const cleanName = animeName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const query = `${cleanName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    const url = `https://api.subdl.com/api/v1/subtitles?subs_per_page=30&type=tv&query=${encodeURIComponent(query)}`;
    
    console.log(`[SubDL] Searching: ${url}`);
    
    const response = await fetch(url, {
      headers: buildBrowserHeaders(),
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    
    if (!response.ok) {
      console.error(`[SubDL] Error: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    
    if (data.status && data.subtitles) {
      for (const sub of data.subtitles) {
        // SubDL uses 2-letter codes
        const langCode = sub.language?.toLowerCase() || 'en';
        const lang3 = langCode === 'ja' || langCode === 'japanese' ? 'jpn' : 
                      langCode === 'en' || langCode === 'english' ? 'eng' : langCode;
        
        subtitles.push({
          id: `subdl-${sub.id || Math.random().toString(36).substr(2, 9)}`,
          url: sub.url || `https://dl.subdl.com${sub.subtitlePage}`,
          lang: lang3,
          episode,
          filename: sub.releaseName || sub.name,
          format: 'srt',
          provider: 'SubDL'
        });
      }
    }
    
    // Cache results
    subtitleCache.set(cacheKey, { data: subtitles, timestamp: Date.now() });
    
    console.log(`[SubDL] Found ${subtitles.length} subtitles`);
    return subtitles;
    
  } catch (error) {
    console.error(`[SubDL] Error: ${error.message}`);
    return [];
  }
}

/**
 * Format subtitles for Stremio response
 */
function formatSubtitlesForStremio(subtitles) {
  return subtitles.map(sub => ({
    id: sub.id,
    url: sub.url,
    lang: sub.lang === 'jpn' || sub.lang === 'ja' ? 'jpn' : 
          sub.lang === 'eng' || sub.lang === 'en' ? 'eng' : sub.lang
  }));
}

// Handle stream requests (using direct API)
async function handleStream(catalog, type, id, config = {}, requestUrl = null) {
  // Decode URL-encoded ID first (Stremio sometimes sends %3A instead of :)
  const decodedId = decodeURIComponent(id);
  
  // Dynamically determine base URL from request (for local dev vs production)
  const workerBaseUrl = requestUrl 
    ? `${requestUrl.protocol}//${requestUrl.host}` 
    : 'https://animestream-addon.keypop3750.workers.dev';
  
  // Parse ID: tt1234567 or tt1234567:1:5 or mal-12345:1:5
  const parts = decodedId.split(':');
  const baseId = parts[0];
  const season = parts[1] ? parseInt(parts[1]) : 1;
  const episode = parts[2] ? parseInt(parts[2]) : 1;
  
  console.log(`Stream request: baseId=${baseId}, season=${season}, episode=${episode}`);
  
  // Find anime in catalog (supports tt*, mal-*, kitsu:* IDs)
  let anime = findAnimeById(catalog, baseId);
  let showId = null;
  let totalSeasonEpisodes = null; // Will be set after finding the show on AllAnime
  let availableEpisodes = null; // Actual released episodes, not planned
  
  // Early check before expensive AllAnime lookups - don't pass episode count yet
  const earlyCheck = shouldServeAllAnimeStream(anime, episode, season, catalog, null, null);
  if (!earlyCheck.allowed) {
    console.log(`Stream not served (early check): ${earlyCheck.reason} - ${anime?.name || baseId}`);
    return { 
      streams: [{
        name: 'AnimeStream',
        title: `⚠️ ${earlyCheck.message}`,
        externalUrl: 'https://stremio.com'
      }]
    };
  }
  
  // If not in catalog and it's an IMDB ID, try Cinemeta
  if (!anime && baseId.startsWith('tt')) {
    console.log(`Anime not in catalog, trying Cinemeta for ${baseId}`);
    anime = await fetchCinemetaMeta(baseId, type);
    
    // If Cinemeta fails, try to get MAL ID from Haglund and then use AniList
    if (!anime) {
      console.log(`Cinemeta failed, trying Haglund+AniList fallback for ${baseId}`);
      try {
        const idMappings = await getIdMappings(baseId, 'imdb');
        if (idMappings.mal) {
          console.log(`Found MAL ID ${idMappings.mal} via Haglund, fetching from AniList`);
          anime = await fetchAniListByMalId(idMappings.mal);
          if (anime) {
            console.log(`Found anime via AniList: ${anime.name}`);
          }
        }
      } catch (err) {
        console.log(`Haglund+AniList fallback failed: ${err.message}`);
      }
    }
    
    // Last resort: Search AllAnime directly by IMDB ID pattern
    // This catches anime not in any mapping database
    if (!anime) {
      console.log(`All metadata sources failed for ${baseId}, attempting direct AllAnime search`);
      // We'll handle this below by searching with a generic query
    }
  }
  
  // If still not found and it's a MAL ID, search AllAnime directly
  if (!anime && baseId.startsWith('mal-')) {
    console.log(`MAL ID detected, searching AllAnime directly for ${baseId}`);
    const malId = baseId.replace('mal-', '');
    
    // First try AniList to get the proper title
    const aniListInfo = await fetchAniListByMalId(malId);
    if (aniListInfo) {
      anime = aniListInfo;
      console.log(`Found anime via AniList: ${anime.name}`);
    }
    
    // Also try to get show details directly from AllAnime
    if (!anime) {
      try {
        const showDetails = await getAllAnimeShowDetails(malId);
        if (showDetails) {
          showId = malId; // We have the MAL ID which AllAnime uses
          anime = { name: showDetails.name || showDetails.englishName || 'Unknown', mal_id: malId };
          totalSeasonEpisodes = showDetails.episodeCount || null;
          
          // Parse available episodes (e.g., {"sub": [1,2,3], "dub": [1,2]})
          if (showDetails.availableEpisodesDetail) {
            const available = showDetails.availableEpisodesDetail.sub || showDetails.availableEpisodesDetail.dub || [];
            if (available.length > 0) {
              availableEpisodes = Math.max(...available.map(ep => typeof ep === 'string' ? parseInt(ep) : ep));
            }
          }
          
          console.log(`Found AllAnime show via MAL ID: ${anime.name} (${availableEpisodes || totalSeasonEpisodes} episodes available)`);
        }
      } catch (err) {
        console.log(`AllAnime lookup by MAL ID failed: ${err.message}`);
      }
    }
  }
  
  if (!anime) {
    console.log(`No anime found for ${baseId}`);
    return { streams: [] };
  }
  
  // Search AllAnime for matching show (if we don't already have showId)
  // For multi-season shows, we need to find the correct season entry
  // Pass baseId (IMDB ID) and MAL/AniList IDs for ID-based verification
  if (!showId) {
    // Extract MAL/AniList IDs from catalog for verification
    const catalogMalId = anime.mal_id ? parseInt(anime.mal_id) : null;
    const catalogAniListId = anime.anilist_id ? parseInt(anime.anilist_id) : null;
    
    showId = await findAllAnimeShowForSeason(anime.name, season, baseId, catalogMalId, catalogAniListId);
    
    // Get episode count for the found show
    if (showId) {
      try {
        const showDetails = await getAllAnimeShowDetails(showId);
        totalSeasonEpisodes = showDetails?.episodeCount || null;
        
        // Parse available episodes
        if (showDetails?.availableEpisodesDetail) {
          const available = showDetails.availableEpisodesDetail.sub || showDetails.availableEpisodesDetail.dub || [];
          if (available.length > 0) {
            availableEpisodes = Math.max(...available.map(ep => typeof ep === 'string' ? parseInt(ep) : ep));
          }
        }
        
        console.log(`Found show ${showId} with ${availableEpisodes || totalSeasonEpisodes} episodes`);
      } catch (err) {
        console.log(`Could not get episode count: ${err.message}`);
      }
    }
  }
  
  if (!showId) {
    return { streams: [] };
  }
  
  // Use available episodes count if we have it, otherwise fall back to total planned episodes
  const effectiveEpisodeCount = availableEpisodes || totalSeasonEpisodes;
  
  // Now do a final check with the episode count from AllAnime
  const finalCheck = shouldServeAllAnimeStream(anime, episode, season, catalog, null, effectiveEpisodeCount);
  if (!finalCheck.allowed) {
    console.log(`Stream not served (final check): ${finalCheck.reason} - ${anime?.name || baseId}`);
    return { 
      streams: [{
        name: 'AnimeStream',
        title: `⚠️ ${finalCheck.message}`,
        externalUrl: 'https://stremio.com'
      }]
    };
  }
  
  // Convert Stremio season:episode to absolute episode number for long-running shows
  // Cinemeta splits long anime into seasons but AllAnime uses absolute episode numbers
  const absoluteEpisode = convertToAbsoluteEpisode(baseId, season, episode);
  if (absoluteEpisode !== episode) {
    console.log(`Episode mapping: S${season}E${episode} → absolute E${absoluteEpisode} for ${anime?.name || baseId}`);
  }
  
  // Episode bounds validation - prevent requesting wrong episodes
  if (availableEpisodes && absoluteEpisode > availableEpisodes) {
    console.log(`Episode ${absoluteEpisode} exceeds available episodes (${availableEpisodes}) for ${anime?.name || baseId}`);
    return { 
      streams: [{
        name: 'AnimeStream',
        title: `⚠️ Episode ${absoluteEpisode} not available yet (${availableEpisodes} released)`,
        externalUrl: 'https://stremio.com'
      }]
    };
  }
  
  // Fetch streams directly from AllAnime API
  try {
    const streams = await getEpisodeSources(showId, absoluteEpisode);
    
    // Format streams for Stremio - use proxy for URLs requiring Referer header
    // NOTE: workerBaseUrl is now defined at the top of handleStream
    
    const formattedStreams = [];
    
    // Add AllAnime streams (hardsubbed)
    if (streams && streams.length > 0) {
      for (const stream of streams) {
        // Proxy URLs that require Referer header (fast4speed)
        let streamUrl = stream.url;
        if (stream.url.includes('fast4speed')) {
          streamUrl = `${workerBaseUrl}/proxy/${encodeURIComponent(stream.url)}`;
        }
        
        formattedStreams.push({
          name: `AnimeStream`,
          title: `[SUB] ${stream.type || 'SUB'} - ${stream.quality || 'HD'}`,
          url: streamUrl
        });
      }
    }
    
    // Fetch torrent streams for RAW content (only if user has debrid configured)
    // Torrents will be shown with debrid resolution URLs
    try {
      // Enrich anime object with AniDB ID, synonyms from id-mappings.json
      // This is critical for accurate torrent searching via AnimeTosho
      const enrichedAnime = await enrichAnimeWithMappings(anime, baseId);
      const animeName = enrichedAnime.name || enrichedAnime.title?.userPreferred || enrichedAnime.title?.romaji || 'Unknown';
      // Pass full anime object for ID-based torrent search (AniDB ID is most accurate)
      // The getTorrentStreams function handles both object and string inputs
      console.log(`[Stream] Enriched anime: anidb_id=${enrichedAnime.anidb_id}, mal_id=${enrichedAnime.mal_id}, synonyms=${enrichedAnime.synonyms?.length || 0}`);
      const torrents = await getTorrentStreams(enrichedAnime, absoluteEpisode, season);
      
      if (torrents.length > 0) {
        console.log(`[Stream] Found ${torrents.length} torrent streams for "${animeName}" E${absoluteEpisode}`);
        
        // Check if user has debrid configured
        const hasDebrid = config.debridProvider && config.debridApiKey;
        
        // Batch check cache status for all torrents (if debrid configured)
        let cacheStatus = new Map();
        if (hasDebrid) {
          const topTorrents = torrents.slice(0, 5);
          const hashes = topTorrents.map(t => t.infoHash).filter(Boolean);
          if (hashes.length > 0) {
            try {
              cacheStatus = await checkDebridCacheBatch(hashes, config.debridProvider, config.debridApiKey);
              const cachedCount = Array.from(cacheStatus.values()).filter(v => v === true).length;
              console.log(`[Stream] Cache check: ${cachedCount}/${hashes.length} torrents cached on ${config.debridProvider}`);
            } catch (cacheErr) {
              console.error(`[Stream] Cache check error: ${cacheErr.message}`);
            }
          }
        }
        
        // Add top 5 torrent streams with cache status labels
        for (const torrent of torrents.slice(0, 5)) {
          // Build clean title like Torrentio: "AnimeName - Quality\n👤 Seeders 💾 Size"
          const qualityLabel = torrent.quality !== 'Unknown' ? torrent.quality : '';
          const rawTag = torrent.isRaw ? ' [RAW]' : '';
          const codecTag = /hevc|x265|h\.?265/i.test(torrent.title) ? ' HEVC' : 
                          /x264|h\.?264/i.test(torrent.title) ? ' x264' : '';
          
          // Format seeders and size for subtitle line (like Torrentio)
          const seedersDisplay = torrent.seeders > 0 ? `👤 ${torrent.seeders}` : '';
          const sizeDisplay = torrent.size ? `💾 ${torrent.size}` : '';
          const groupDisplay = torrent.releaseGroup !== 'Unknown' ? `⚙️ ${torrent.releaseGroup}` : '';
          
          // Build metadata line (seeders, size, group)
          const metaParts = [seedersDisplay, sizeDisplay, groupDisplay].filter(Boolean);
          const metaLine = metaParts.length > 0 ? metaParts.join(' ') : '';
          
          if (hasDebrid) {
            // User has debrid configured - provide direct play URL
            const providerShort = DEBRID_PROVIDERS[config.debridProvider]?.shortName || 'DB';
            
            // Get cache status for this torrent (ensure lowercase comparison)
            const hashLower = torrent.infoHash?.toLowerCase();
            const isCached = cacheStatus.has(hashLower) ? cacheStatus.get(hashLower) : null;
            // ⚡ = cached (instant), ⏳ = not cached (will download), ❓ = unknown/error
            const cacheEmoji = isCached === true ? '⚡' : isCached === false ? '⏳' : '❓';
            
            // Build title: "AnimeName - 1080p HEVC [RAW]\n👤 32 💾 542.13 MB ⚙️ SubsPlease"
            const titleLine = `${animeName} - ${qualityLabel}${codecTag}${rawTag}`.trim().replace(/- $/, '').trim();
            const fullTitle = metaLine ? `${titleLine}\n${metaLine}` : titleLine;
            
            formattedStreams.push({
              name: `${cacheEmoji} ${providerShort}`,
              title: fullTitle,
              url: `${workerBaseUrl}/debrid/play?ih=${torrent.infoHash}&p=${config.debridProvider}&key=${encodeURIComponent(config.debridApiKey)}&ep=${absoluteEpisode}&s=${season}`,
              behaviorHints: {
                bingeGroup: `torrent-${showId}-${season}`
              }
            });
          } else {
            // No debrid configured - show as magnet/configure prompt
            const titleLine = `${animeName} - ${qualityLabel}${codecTag}${rawTag}`.trim().replace(/- $/, '').trim();
            const fullTitle = metaLine ? `${titleLine}\n${metaLine}\n⚠️ Requires Debrid` : `${titleLine}\n⚠️ Requires Debrid`;
            
            formattedStreams.push({
              name: `🧲 Torrent`,
              title: fullTitle,
              // Link to configure page to set up debrid
              externalUrl: `${workerBaseUrl}/configure`,
              behaviorHints: {
                notWebReady: true,
                bingeGroup: `torrent-${showId}-${season}`
              },
              infoHash: torrent.infoHash,
              sources: [`tracker:udp://tracker.opentrackr.org:1337/announce`]
            });
          }
        }
      }
    } catch (torrentErr) {
      console.error(`[Stream] Torrent fetch error: ${torrentErr.message}`);
      // Continue without torrents
    }
    
    if (formattedStreams.length === 0) {
      return { streams: [] };
    }
    
    return { streams: formattedStreams };
  } catch (e) {
    console.error('Stream fetch error:', e);
    return { streams: [] };
  }
}

// ===== MAIN HANDLER =====

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Get client IP for rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 
                     request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
                     'unknown';
    
    // Apply rate limiting (skip for static assets and health checks)
    if (!path.startsWith('/proxy/') && path !== '/health' && path !== '/') {
      const rateCheck = checkRateLimit(clientIP);
      if (!rateCheck.allowed) {
        return new Response(JSON.stringify({ 
          error: 'Too many requests', 
          message: 'Please slow down. Try again in a few seconds.',
          retryAfter: rateCheck.retryAfter 
        }), {
          status: 429,
          headers: {
            ...JSON_HEADERS,
            'Retry-After': String(rateCheck.retryAfter),
            'X-RateLimit-Remaining': '0'
          }
        });
      }
    }
    
    // ===== VIDEO PROXY =====
    // Proxy video streams to add required Referer header
    if (path.startsWith('/proxy/')) {
      const videoUrl = decodeURIComponent(path.replace('/proxy/', ''));
      
      try {
        // Handle range requests for video seeking
        const rangeHeader = request.headers.get('Range');
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://allanime.to/',
          'Origin': 'https://allanime.to'
        };
        
        if (rangeHeader) {
          headers['Range'] = rangeHeader;
        }
        
        const response = await fetch(videoUrl, { headers });
        
        // Return proxied video with CORS headers
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        newHeaders.set('Access-Control-Allow-Headers', 'Range');
        newHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
        
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Proxy error', message: error.message }), {
          status: 502,
          headers: JSON_HEADERS
        });
      }
    }
    
    // ===== DEBRID PLAY ENDPOINT (Click-time resolution) =====
    // Resolves magnet to direct HTTPS stream when user clicks play
    if (path === '/debrid/play') {
      const infoHash = url.searchParams.get('ih');
      const provider = url.searchParams.get('p');
      const apiKey = url.searchParams.get('key');
      const fileIndex = parseInt(url.searchParams.get('idx') || '0');
      const episode = url.searchParams.get('ep') ? parseInt(url.searchParams.get('ep')) : null;
      const season = url.searchParams.get('s') ? parseInt(url.searchParams.get('s')) : 1;
      
      if (!infoHash || !provider || !apiKey) {
        return jsonResponse({ 
          error: 'Missing parameters', 
          required: ['ih (infoHash)', 'p (provider)', 'key (apiKey)'] 
        }, { status: 400 });
      }
      
      console.log(`[Debrid Play] Resolving ${infoHash} via ${provider}${episode ? ` for S${season}E${episode}` : ''}`);
      
      try {
        // Build magnet from info hash WITH TRACKERS for better resolution
        const magnet = buildMagnetWithTrackers(infoHash);
        
        // Resolve via debrid provider - pass episode info for smart file selection
        const result = await resolveDebrid(magnet, infoHash, provider, apiKey, fileIndex, episode, season);
        
        // Handle "downloading" status - torrent not cached
        if (result && typeof result === 'object' && result.status === 'downloading') {
          console.log(`[Debrid Play] Torrent not cached - returning info message`);
          return jsonResponse({ 
            error: 'Torrent not cached',
            message: result.message || 'This torrent is not cached on the debrid service. Choose a ⚡ cached torrent for instant playback.',
            hint: 'Look for streams marked with ⚡ (instant) instead of ⏳ (download)'
          }, { status: 503 }); // 503 = Service Unavailable (temporary)
        }
        
        if (!result || typeof result !== 'string') {
          return jsonResponse({ 
            error: 'Failed to resolve torrent',
            message: 'Torrent may not be cached on debrid service. Try a ⚡ cached torrent.'
          }, { status: 500 });
        }
        
        console.log(`[Debrid Play] Resolved to: ${result.substring(0, 50)}...`);
        
        // Redirect to the direct stream URL
        return Response.redirect(result, 302);
        
      } catch (error) {
        console.error(`[Debrid Play] Error: ${error.message}`);
        return jsonResponse({ 
          error: 'Debrid resolution failed',
          message: error.message 
        }, { status: 500 });
      }
    }
    
    // ===== TORRENT SEARCH API =====
    // Search for torrents by anime name (for testing)
    if (path === '/api/torrents') {
      const animeName = url.searchParams.get('q');
      const episode = url.searchParams.get('ep') ? parseInt(url.searchParams.get('ep')) : null;
      
      if (!animeName) {
        return jsonResponse({ error: 'Missing query parameter: q' }, { status: 400 });
      }
      
      try {
        const torrents = await getTorrentStreams(animeName, episode);
        return jsonResponse({ 
          query: animeName,
          episode,
          count: torrents.length,
          torrents: torrents.slice(0, 20) // Limit to 20 results
        });
      } catch (error) {
        return jsonResponse({ error: error.message }, { status: 500 });
      }
    }
    
    // ===== SUBTITLES API =====
    // Get subtitles for an anime episode
    if (path === '/api/subtitles') {
      const animeName = url.searchParams.get('name');
      const imdbId = url.searchParams.get('imdb');
      const season = parseInt(url.searchParams.get('s') || '1');
      const episode = parseInt(url.searchParams.get('ep') || '1');
      const languages = (url.searchParams.get('lang') || 'en,ja').split(',');
      
      if (!animeName && !imdbId) {
        return jsonResponse({ error: 'Missing parameter: name or imdb' }, { status: 400 });
      }
      
      try {
        const subtitles = await getSubtitles(animeName || 'Unknown', imdbId, season, episode, languages);
        return jsonResponse({
          animeName,
          imdbId,
          season,
          episode,
          count: subtitles.length,
          subtitles: formatSubtitlesForStremio(subtitles)
        });
      } catch (error) {
        return jsonResponse({ error: error.message }, { status: 500 });
      }
    }
    
    // Configure page
    const configureMatch = path.match(/^(?:\/([^\/]+))?\/configure\/?$/);
    if (configureMatch) {
      return new Response(CONFIGURE_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
      });
    }
    
    // API stats endpoint for configure page
    if (path === '/api/stats') {
      try {
        const { catalog } = await fetchCatalogData();
        const totalSeries = catalog.filter(a => isSeriesType(a)).length;
        const totalMovies = catalog.filter(a => isMovieType(a)).length;
        // Stats cached for 1 hour
        return jsonResponse({
          totalAnime: catalog.length,
          totalSeries,
          totalMovies
        }, { maxAge: 3600 });
      } catch (error) {
        return jsonResponse({ totalAnime: 7000, totalSeries: 6500, totalMovies: 500 }, { maxAge: 3600 });
      }
    }
    
    // Health check (doesn't need data)
    if (path === '/health' || path === '/') {
      try {
        const { catalog } = await fetchCatalogData();
        // Health check cached for 5 minutes
        return jsonResponse({
          status: 'healthy',
          database: 'loaded',
          source: 'github',
          totalAnime: catalog.length,
          cacheAge: Math.floor((Date.now() - cacheTimestamp) / 1000) + 's'
        }, { maxAge: 300 });
      } catch (error) {
        return jsonResponse({
          status: 'error',
          message: error.message
        }, { status: 500 });
      }
    }
    
    // Fetch data for all other routes
    let catalog, filterOptions;
    try {
      const data = await fetchCatalogData();
      catalog = data.catalog;
      filterOptions = data.filterOptions;
    } catch (error) {
      return jsonResponse({ 
        error: 'Failed to load catalog data',
        message: error.message 
      }, { status: 503 });
    }
    
    // Parse routes
    const manifestMatch = path.match(/^(?:\/([^\/]+))?\/manifest\.json$/);
    if (manifestMatch) {
      const config = parseConfig(manifestMatch[1]);
      // Manifest cached for 24 hours - rarely changes
      return jsonResponse(getManifest(filterOptions, config.showCounts, catalog, config.hiddenCatalogs, config), { 
        maxAge: MANIFEST_CACHE_TTL, 
        staleWhileRevalidate: 3600 
      });
    }
    
    const catalogMatch = path.match(/^(?:\/([^\/]+))?\/catalog\/([^\/]+)\/([^\/]+)(?:\/(.+))?\.json$/);
    if (catalogMatch) {
      const [, configStr, type, id, extraStr] = catalogMatch;
      const config = parseConfig(configStr);
      
      // Parse extra parameters
      const extra = {};
      if (extraStr) {
        const parts = extraStr.split('&');
        for (const part of parts) {
          const [key, value] = part.split('=');
          if (key && value) {
            extra[key] = decodeURIComponent(value);
          }
        }
      }
      
      // Handle search catalogs
      if (id === 'anime-search' || id === 'anime-series-search' || id === 'anime-movies-search') {
        if (!extra.search) {
          return jsonResponse({ metas: [] }, { maxAge: 60 });
        }
        
        // Determine target type based on catalog id
        let targetType = null;
        if (id === 'anime-movies-search') targetType = 'movie';
        else if (id === 'anime-series-search') targetType = 'series';
        // anime-search searches all types
        
        const results = searchDatabase(catalog, extra.search, targetType);
        
        const skip = parseInt(extra.skip) || 0;
        const paginated = results.slice(skip, skip + PAGE_SIZE);
        const metas = paginated.map(formatAnimeMeta);
        
        // Search results cached for 10 minutes
        return jsonResponse({ metas }, { maxAge: CATALOG_HTTP_CACHE, staleWhileRevalidate: 300 });
      }
      
      // Handle regular catalogs
      if (type !== 'anime') {
        return jsonResponse({ metas: [] }, { maxAge: 60 });
      }
      
      let catalogResult;
      switch (id) {
        case 'anime-top-rated':
          catalogResult = handleTopRated(catalog, extra.genre, config);
          break;
        case 'anime-season-releases':
          catalogResult = handleSeasonReleases(catalog, extra.genre);
          break;
        case 'anime-airing':
          catalogResult = handleAiring(catalog, extra.genre, config);
          break;
        case 'anime-movies':
          catalogResult = handleMovies(catalog, extra.genre);
          break;
        default:
          return jsonResponse({ metas: [] }, { maxAge: 60 });
      }
      
      const skip = parseInt(extra.skip) || 0;
      const paginated = catalogResult.slice(skip, skip + PAGE_SIZE);
      const metas = paginated.map(formatAnimeMeta);
      
      // Add debug header for airing catalog
      const headers = {};
      if (id === 'anime-airing') {
        headers['X-Debug-Total-Result'] = catalogResult.length.toString();
        headers['X-Debug-Paginated'] = paginated.length.toString();
      }
      
      // Catalog results cached for 10 minutes - good balance for airing shows
      return jsonResponse({ metas }, { maxAge: CATALOG_HTTP_CACHE, staleWhileRevalidate: 300, extraHeaders: headers });
    }
    
    // Debug route for stream tracing
    const debugMatch = path.match(/^\/debug\/stream\/(.+)$/);
    if (debugMatch) {
      const id = debugMatch[1];
      const parts = id.split(':');
      const imdbId = parts[0];
      const type = parts.length === 3 ? 'series' : 'movie';
      const episode = parts[2] ? parseInt(parts[2]) : 1;
      
      const debugInfo = {
        id,
        imdbId,
        episode,
        catalogLoaded: !!catalog,
        catalogSize: catalog ? catalog.length : 0
      };
      
      // Find anime in catalog
      let anime = findAnimeByImdbId(catalog, imdbId);
      debugInfo.animeFound = !!anime;
      debugInfo.source = anime ? 'catalog' : null;
      
      // If not in catalog, try Cinemeta
      if (!anime) {
        debugInfo.tryingCinemeta = true;
        anime = await fetchCinemetaMeta(imdbId, type);
        if (anime) {
          debugInfo.animeFound = true;
          debugInfo.source = 'cinemeta';
        }
      }
      
      if (anime) {
        debugInfo.animeName = anime.name;
        debugInfo.animeId = anime.id;
      }
      
      if (anime) {
        // Search AllAnime directly
        try {
          const results = await searchAllAnime(anime.name, 10);
          debugInfo.searchResultCount = results.length;
          
          if (results.length > 0) {
            debugInfo.firstResult = {
              id: results[0].id,
              title: results[0].title,
              type: results[0].type
            };
            
            // Run matching algorithm
            const normalizedTitle = anime.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            debugInfo.normalizedTitle = normalizedTitle;
            
            const matchResults = results.map(show => {
              const showName = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              const similarity = stringSimilarity(normalizedTitle, showName);
              let score = 0;
              if (showName === normalizedTitle) score = 100;
              else if (showName.includes(normalizedTitle) || normalizedTitle.includes(showName)) score = 80;
              else score = similarity * 0.9;
              if (show.type === 'TV') score += 3;
              
              return {
                id: show.id,
                title: show.title,
                normalizedTitle: showName,
                similarity,
                score,
                isExactMatch: showName === normalizedTitle
              };
            });
            
            debugInfo.matchResults = matchResults;
            debugInfo.bestMatch = matchResults.reduce((best, curr) => curr.score > best.score ? curr : best, matchResults[0]);
            
            // Also test stream fetching
            if (debugInfo.bestMatch && debugInfo.bestMatch.score >= 60) {
              const streams = await getEpisodeSources(debugInfo.bestMatch.id, episode);
              debugInfo.streamsFound = streams.length;
              if (streams.length > 0) {
                debugInfo.firstStream = {
                  url: streams[0].url.substring(0, 100) + '...',
                  quality: streams[0].quality,
                  type: streams[0].type
                };
              }
            }
          }
        } catch (e) {
          debugInfo.searchError = e.message;
        }
      }
      
      return new Response(JSON.stringify(debugInfo, null, 2), { headers: JSON_HEADERS });
    }
    
    // Meta route: /meta/:type/:id.json or /{config}/meta/:type/:id.json
    const metaMatch = path.match(/^(?:\/([^\/]+))?\/meta\/([^\/]+)\/(.+)\.json$/);
    if (metaMatch) {
      const [, configStr, type, id] = metaMatch;
      try {
        const result = await handleMeta(catalog, type, id);
        // Meta cached for 1 hour - episode lists don't change often
        return jsonResponse(result, { maxAge: META_HTTP_CACHE, staleWhileRevalidate: 600 });
      } catch (error) {
        console.error('Meta handler error:', error.message);
        return jsonResponse({ meta: null }, { maxAge: 60 });
      }
    }
    
    // Stream route: /stream/:type/:id.json or /{config}/stream/:type/:id.json
    const streamMatch = path.match(/^(?:\/([^\/]+))?\/stream\/([^\/]+)\/(.+)\.json$/);
    if (streamMatch) {
      const [, configStr, type, id] = streamMatch;
      const config = parseConfig(configStr);
      try {
        // Pass URL object for dynamic base URL generation
        const result = await handleStream(catalog, type, id, config, url);
        // Streams cached for 2 minutes - sources can change
        return jsonResponse(result, { maxAge: STREAM_HTTP_CACHE, staleWhileRevalidate: 60 });
      } catch (error) {
        console.error('Stream handler error:', error.message);
        return jsonResponse({ streams: [] }, { maxAge: 60 });
      }
    }
    
    // ===== SUBTITLES HANDLER (SCROBBLING TRIGGER) =====
    // This handler is called when user opens an episode in Stremio
    // We use it to trigger scrobbling to AniList/MAL (marking episode as watched)
    // Based on mal-stremio-addon approach: https://github.com/SageTendo/mal-stremio-addon
    const subtitlesMatch = path.match(/^(?:\/([^\/]+))?\/subtitles\/([^\/]+)\/(.+)\.json$/);
    if (subtitlesMatch) {
      const [, configStr, type, id] = subtitlesMatch;
      const config = parseConfig(configStr);
      
      // Parse ID - format: tt1234567:season:episode for series, tt1234567 for movies
      const parts = id.split(':');
      const imdbId = parts[0];
      const season = parts.length >= 2 ? parseInt(parts[1]) : 1;
      const episode = parts.length >= 3 ? parseInt(parts[2]) : 1;
      const isMovie = type === 'movie' || parts.length === 1;
      
      // Get user tokens from KV if user ID is provided
      if (config.userId && imdbId.startsWith('tt')) {
        // Don't await - let scrobbling happen in background
        // This prevents slowing down subtitle loading
        (async () => {
          try {
            console.log(`[Scrobble] Triggering for ${imdbId} S${season}E${episode} (user: ${config.userId})`);
            
            // Get user tokens from KV
            const userTokens = await getUserTokens(config.userId, env);
            if (!userTokens) {
              console.log(`[Scrobble] No tokens found for user ${config.userId}`);
              return;
            }
            
            // Get ID mappings from Haglund API
            const mappings = await getIdMappingsFromImdb(imdbId, season);
            console.log(`[Scrobble] ID mappings:`, mappings);
            
            // Scrobble to AniList if token exists and AniList ID found
            if (userTokens.anilistToken && mappings.anilist) {
              try {
                console.log(`[Scrobble] Updating AniList ${mappings.anilist} episode ${episode}`);
                const result = await scrobbleToAnilist(mappings.anilist, episode, userTokens.anilistToken);
                console.log(`[Scrobble] AniList result:`, result);
              } catch (err) {
                console.error(`[Scrobble] AniList error:`, err.message);
              }
            }
            
            // Scrobble to MAL if token exists and MAL ID found
            if (userTokens.malToken && mappings.mal) {
              try {
                console.log(`[Scrobble] Updating MAL ${mappings.mal} episode ${episode}`);
                const result = await scrobbleToMal(mappings.mal, episode, userTokens.malToken, isMovie);
                console.log(`[Scrobble] MAL result:`, result);
              } catch (err) {
                console.error(`[Scrobble] MAL error:`, err.message);
              }
            }
            
            if (!mappings.anilist && !mappings.mal) {
              console.log(`[Scrobble] No AniList or MAL ID found for ${imdbId}`);
            }
          } catch (error) {
            console.error(`[Scrobble] Error:`, error.message);
          }
        })();
      }
      
      // Fetch actual subtitles from Kitsunekko and SubDL
      // NOTE: OpenSubtitles disabled - user has it as separate addon
      try {
        // Get anime name from catalog for Kitsunekko search
        const anime = findAnimeById(catalog, imdbId);
        const animeName = anime?.name || anime?.title?.userPreferred || '';
        
        // Fetch subtitles from Kitsunekko and SubDL in parallel
        const [kitsunekkoSubs, subdlSubs] = await Promise.all([
          animeName ? scrapeKitsunekko(animeName) : Promise.resolve([]),
          searchSubDL(animeName || imdbId, season, episode, config.subtitleLanguages || ['en'])
        ]);
        
        // Filter Kitsunekko subs by episode if available
        const filteredKitsunekko = kitsunekkoSubs.filter(sub => 
          !sub.episode || sub.episode === episode
        );
        
        // Combine and format for Stremio (Kitsunekko + SubDL)
        const allSubs = [...filteredKitsunekko, ...subdlSubs];
        
        // Deduplicate by URL
        const seenUrls = new Set();
        const uniqueSubs = allSubs.filter(sub => {
          if (seenUrls.has(sub.url)) return false;
          seenUrls.add(sub.url);
          return true;
        });
        
        const formattedSubs = uniqueSubs.map(sub => ({
          id: sub.id,
          url: sub.url,
          lang: sub.lang === 'jpn' ? 'jpn' : sub.lang === 'eng' ? 'eng' : sub.lang,
        }));
        
        console.log(`[Subtitles] Found ${formattedSubs.length} subtitles for ${imdbId} S${season}E${episode}`);
        
        return jsonResponse({ subtitles: formattedSubs }, { maxAge: 3600 }); // Cache for 1 hour
      } catch (subError) {
        console.error(`[Subtitles] Error fetching subtitles: ${subError.message}`);
        return jsonResponse({ subtitles: [] }, { maxAge: 60 });
      }
    }
    
    // ===== SCROBBLING API ROUTES =====
    
    // AniList OAuth callback - handles the redirect from AniList after authorization
    // GET /oauth/anilist?access_token=...&expires_in=...
    if (path === '/oauth/anilist') {
      // Return HTML page that extracts the hash fragment and saves the token
      const oauthHtml = `<!DOCTYPE html>
<html>
<head>
  <title>AniList Connected - AnimeStream</title>
  <style>
    body { font-family: system-ui; background: #0A0F1C; color: #EEF1F7; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #161737; border-radius: 16px; padding: 32px; text-align: center; max-width: 400px; }
    .success { color: #22c55e; font-size: 48px; }
    .error { color: #ef4444; font-size: 48px; }
    h1 { margin: 16px 0 8px; }
    p { color: #5F67AD; }
    .btn { display: inline-block; background: #3926A6; color: white; padding: 12px 24px; border-radius: 12px; text-decoration: none; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="success" id="icon">✓</div>
    <h1 id="title">Connecting...</h1>
    <p id="message">Please wait...</p>
  </div>
  <script>
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const expiresIn = params.get('expires_in');
    
    if (accessToken) {
      // Store token in localStorage
      localStorage.setItem('animestream_anilist_token', accessToken);
      localStorage.setItem('animestream_anilist_expires', Date.now() + (parseInt(expiresIn) * 1000));
      
      document.getElementById('title').textContent = 'AniList Connected!';
      document.getElementById('message').innerHTML = 'Your AniList account is now linked.<br>You can close this window.';
      
      // Notify parent window if opened as popup
      if (window.opener) {
        window.opener.postMessage({ type: 'anilist_auth', token: accessToken }, '*');
        setTimeout(() => window.close(), 2000);
      }
    } else {
      document.getElementById('icon').textContent = '✕';
      document.getElementById('icon').className = 'error';
      document.getElementById('title').textContent = 'Connection Failed';
      document.getElementById('message').textContent = 'Could not connect to AniList. Please try again.';
      
      // Notify parent window of failure
      if (window.opener) {
        window.opener.postMessage({ type: 'anilist_auth', error: 'No access token received' }, '*');
      }
    }
  </script>
</body>
</html>`;
      return new Response(oauthHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
      });
    }
    
    // Scrobble endpoint - POST /api/scrobble
    // Body: { imdbId, season, episode, anilistToken }
    if (path === '/api/scrobble' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { imdbId, season, episode, anilistToken } = body;
        
        if (!imdbId || !episode) {
          return jsonResponse({ error: 'Missing required fields: imdbId, episode' }, { status: 400 });
        }
        
        if (!anilistToken) {
          return jsonResponse({ error: 'No AniList token provided. Please connect your AniList account.' }, { status: 401 });
        }
        
        // Get ID mappings from Haglund API
        const mappings = await getIdMappingsFromImdb(imdbId, season || 1);
        
        if (!mappings.anilist) {
          return jsonResponse({ 
            error: 'Could not find AniList ID for this anime',
            imdbId,
            mappings
          }, { status: 404 });
        }
        
        // Scrobble to AniList
        const result = await scrobbleToAnilist(mappings.anilist, episode, anilistToken);
        
        return jsonResponse({
          success: true,
          service: 'anilist',
          anilistId: mappings.anilist,
          ...result
        });
      } catch (error) {
        console.error('Scrobble error:', error);
        return jsonResponse({ 
          error: 'Scrobble failed', 
          message: error.message 
        }, { status: 500 });
      }
    }
    
    // Get AniList user info - GET /api/anilist/user
    if (path === '/api/anilist/user') {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '');
      
      if (!token) {
        return jsonResponse({ error: 'No token provided' }, { status: 401 });
      }
      
      const user = await getAnilistCurrentUser(token);
      if (!user) {
        return jsonResponse({ error: 'Invalid or expired token' }, { status: 401 });
      }
      
      return jsonResponse({ user });
    }
    
    // MAL OAuth callback page - GET /mal/callback
    if (path === '/mal/callback' || path.startsWith('/mal/callback?')) {
      // Return a simple HTML page that will handle the OAuth code
      const html = `<!DOCTYPE html><html><head><title>MAL Auth</title></head><body>
        <script>
          // Pass the query params to the main configure page
          window.location.href = '/configure' + window.location.search + '&mal_callback=1';
        </script>
        <p>Redirecting...</p>
      </body></html>`;
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
      });
    }
    
    // MAL token exchange - POST /api/mal/token
    if (path === '/api/mal/token' && request.method === 'POST') {
      try {
        const { code, codeVerifier, redirectUri } = await request.json();
        
        const MAL_CLIENT_ID = 'e1c53f5d91d73133d628b7e2f56df992';
        const MAL_CLIENT_SECRET = '8a063b9c3a6f00e8a455ebe1f1b338a742f42e4e0f0b98f18f02e0ec207d4e09';
        
        const tokenResponse = await fetch('https://myanimelist.net/v1/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: MAL_CLIENT_ID,
            client_secret: MAL_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri
          }).toString()
        });
        
        const tokenData = await tokenResponse.json();
        
        if (tokenData.error) {
          return jsonResponse({ error: tokenData.error, message: tokenData.message || tokenData.hint }, { status: 400 });
        }
        
        return jsonResponse(tokenData);
      } catch (error) {
        return jsonResponse({ error: 'Token exchange failed', message: error.message }, { status: 500 });
      }
    }
    
    // Get MAL user info - GET /api/mal/user
    if (path === '/api/mal/user') {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace('Bearer ', '');
      
      if (!token) {
        return jsonResponse({ error: 'No token provided' }, { status: 401 });
      }
      
      try {
        const userResponse = await fetch('https://api.myanimelist.net/v2/users/@me', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        
        if (!userResponse.ok) {
          return jsonResponse({ error: 'Invalid or expired token' }, { status: 401 });
        }
        
        const userData = await userResponse.json();
        return jsonResponse({ user: { name: userData.name, id: userData.id } });
      } catch (error) {
        return jsonResponse({ error: 'Failed to fetch user', message: error.message }, { status: 500 });
      }
    }
    
    // Get ID mappings - GET /api/mappings/:imdbId
    const mappingsMatch = path.match(/^\/api\/mappings\/(tt\d+)(?::(\d+))?$/);
    if (mappingsMatch) {
      const [, imdbId, seasonStr] = mappingsMatch;
      const season = seasonStr ? parseInt(seasonStr) : null;
      
      const mappings = await getIdMappingsFromImdb(imdbId, season);
      return jsonResponse({ imdbId, season, mappings });
    }
    
    // ===== SCROBBLING DEBUG/TEST ENDPOINT =====
    // Test scrobbling without actually playing content
    // GET /api/debug/scrobble?uid=al_12345&imdb=tt13159924&season=1&episode=1
    if (path === '/api/debug/scrobble') {
      const userId = url.searchParams.get('uid');
      const imdbId = url.searchParams.get('imdb');
      const season = parseInt(url.searchParams.get('season') || '1');
      const episode = parseInt(url.searchParams.get('episode') || '1');
      const dryRun = url.searchParams.get('dry') !== '0'; // Default to dry run (no actual update)
      
      const debug = {
        userId,
        imdbId,
        season,
        episode,
        dryRun,
        steps: [],
        errors: []
      };
      
      // Step 1: Check user tokens in KV
      if (!userId) {
        debug.errors.push('Missing uid parameter');
        return jsonResponse(debug, { status: 400 });
      }
      
      const userTokens = await getUserTokens(userId, env);
      if (!userTokens) {
        debug.steps.push({ step: 'getUserTokens', status: 'FAIL', message: 'No tokens found in KV for this user ID' });
        debug.errors.push('User tokens not found. Make sure you connected AniList/MAL on configure page.');
        return jsonResponse(debug);
      }
      debug.steps.push({ step: 'getUserTokens', status: 'OK', hasAnilist: !!userTokens.anilistToken, hasMal: !!userTokens.malToken });
      
      // Step 2: Get ID mappings from Haglund API
      if (!imdbId || !imdbId.startsWith('tt')) {
        debug.errors.push('Missing or invalid imdb parameter (should be like tt13159924)');
        return jsonResponse(debug, { status: 400 });
      }
      
      const mappings = await getIdMappingsFromImdb(imdbId, season);
      debug.steps.push({ step: 'getIdMappings', status: 'OK', mappings });
      
      if (!mappings.anilist && !mappings.mal) {
        debug.errors.push('No AniList or MAL ID found for this IMDB. The anime may not be in the mapping database.');
        return jsonResponse(debug);
      }
      
      // Step 3: Test AniList scrobbling
      if (userTokens.anilistToken && mappings.anilist) {
        try {
          // Get current progress first
          const progress = await getAnilistProgress(mappings.anilist, userTokens.anilistToken);
          debug.steps.push({ 
            step: 'getAnilistProgress', 
            status: 'OK', 
            anilistId: mappings.anilist,
            currentProgress: progress?.mediaListEntry?.progress || 0,
            currentStatus: progress?.mediaListEntry?.status || 'NOT_ON_LIST',
            totalEpisodes: progress?.episodes || 'unknown'
          });
          
          if (!dryRun) {
            // Actually update
            const result = await scrobbleToAnilist(mappings.anilist, episode, userTokens.anilistToken);
            debug.steps.push({ step: 'scrobbleToAnilist', status: 'OK', result });
          } else {
            debug.steps.push({ step: 'scrobbleToAnilist', status: 'SKIPPED', reason: 'Dry run mode (add ?dry=0 to actually update)' });
          }
        } catch (err) {
          debug.steps.push({ step: 'anilistScrobble', status: 'FAIL', error: err.message });
          debug.errors.push(`AniList error: ${err.message}`);
        }
      } else if (!userTokens.anilistToken) {
        debug.steps.push({ step: 'anilistScrobble', status: 'SKIPPED', reason: 'No AniList token' });
      } else {
        debug.steps.push({ step: 'anilistScrobble', status: 'SKIPPED', reason: 'No AniList ID for this anime' });
      }
      
      // Step 4: Test MAL scrobbling
      if (userTokens.malToken && mappings.mal) {
        try {
          const malStatus = await getMalAnimeStatus(mappings.mal, userTokens.malToken);
          if (malStatus?.error === 'token_expired') {
            debug.steps.push({ step: 'getMalStatus', status: 'FAIL', error: 'MAL token expired' });
            debug.errors.push('MAL token expired. Please reconnect on configure page.');
          } else {
            debug.steps.push({ 
              step: 'getMalStatus', 
              status: 'OK', 
              malId: mappings.mal,
              currentProgress: malStatus?.my_list_status?.num_watched_episodes || 0,
              currentStatus: malStatus?.my_list_status?.status || 'not_on_list',
              totalEpisodes: malStatus?.num_episodes || 'unknown'
            });
            
            if (!dryRun) {
              const result = await scrobbleToMal(mappings.mal, episode, userTokens.malToken, false);
              debug.steps.push({ step: 'scrobbleToMal', status: 'OK', result });
            } else {
              debug.steps.push({ step: 'scrobbleToMal', status: 'SKIPPED', reason: 'Dry run mode' });
            }
          }
        } catch (err) {
          debug.steps.push({ step: 'malScrobble', status: 'FAIL', error: err.message });
          debug.errors.push(`MAL error: ${err.message}`);
        }
      } else if (!userTokens.malToken) {
        debug.steps.push({ step: 'malScrobble', status: 'SKIPPED', reason: 'No MAL token' });
      } else {
        debug.steps.push({ step: 'malScrobble', status: 'SKIPPED', reason: 'No MAL ID for this anime' });
      }
      
      debug.success = debug.errors.length === 0;
      debug.summary = debug.success 
        ? (dryRun ? 'All checks passed! Add ?dry=0 to actually update progress.' : 'Scrobbling completed successfully!')
        : 'Some errors occurred. Check the errors array.';
      
      return jsonResponse(debug);
    }
    
    // ===== USER TOKEN STORAGE API (for scrobbling) =====
    
    // Save user tokens - POST /api/user/:userId/tokens
    const saveTokensMatch = path.match(/^\/api\/user\/([^\/]+)\/tokens$/);
    if (saveTokensMatch && request.method === 'POST') {
      const userId = saveTokensMatch[1];
      
      // Validate user ID format (al_123 or mal_123)
      if (!/^(al|mal)_\d+$/.test(userId)) {
        return jsonResponse({ error: 'Invalid user ID format' }, { status: 400 });
      }
      
      try {
        const tokens = await request.json();
        const saved = await saveUserTokens(userId, tokens, env);
        
        if (saved) {
          return jsonResponse({ success: true, userId });
        } else {
          return jsonResponse({ error: 'Failed to save tokens (KV not configured)' }, { status: 500 });
        }
      } catch (error) {
        return jsonResponse({ error: 'Failed to save tokens', message: error.message }, { status: 500 });
      }
    }
    
    // Disconnect service - POST /api/user/:userId/disconnect
    const disconnectMatch = path.match(/^\/api\/user\/([^\/]+)\/disconnect$/);
    if (disconnectMatch && request.method === 'POST') {
      const userId = disconnectMatch[1];
      
      try {
        const body = await request.json();
        const service = body.service; // 'anilist' or 'mal'
        
        // Get existing tokens
        const tokens = await getUserTokens(userId, env);
        if (!tokens) {
          return jsonResponse({ success: true }); // Nothing to disconnect
        }
        
        // Remove the specified service tokens
        if (service === 'anilist') {
          delete tokens.anilistToken;
          delete tokens.anilistUserId;
          delete tokens.anilistUser;
        } else if (service === 'mal') {
          delete tokens.malToken;
          delete tokens.malUser;
        }
        
        // Save updated tokens
        await saveUserTokens(userId, tokens, env);
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: 'Failed to disconnect', message: error.message }, { status: 500 });
      }
    }
    
    // Debug catalog endpoint
    if (path === '/debug/catalog-info') {
      try {
        const { catalog } = await fetchCatalogData();
        const fridayAnime = catalog.filter(a => a.broadcastDay === 'Friday' && a.status === 'ONGOING');
        const malOnly = fridayAnime.filter(a => a.id && a.id.startsWith('mal-') && !a.imdb_id);
        
        return jsonResponse({
          totalCatalogSize: catalog.length,
          fridayOngoingCount: fridayAnime.length,
          cacheInfo: {
            timestamp: cacheTimestamp,
            age: Date.now() - cacheTimestamp,
            cacheBuster: CACHE_BUSTER
          },
          targetAnime: {
            'mal-59978': catalog.find(a => a.id === 'mal-59978'),
            'mal-53876': catalog.find(a => a.id === 'mal-53876'),
            'mal-62804': catalog.find(a => a.id === 'mal-62804')
          },
          malOnlyFridayAnime: malOnly.map(a => ({ id: a.id, name: a.name }))
        });
      } catch (error) {
        return jsonResponse({ error: error.message }, { status: 500 });
      }
    }
    
    // 404 for unknown routes
    return jsonResponse({ error: 'Not found' }, { status: 404 });
  }
};
