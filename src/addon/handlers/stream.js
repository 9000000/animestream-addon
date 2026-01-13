/**
 * Stream Handler for AnimeStream
 * 
 * Fetches streams from AllAnime scraper via Cloudflare Worker.
 * Uses anime title to search AllAnime, then fetches episode streams.
 */

const https = require('https');
const databaseLoader = require('../../utils/databaseLoader');
const logger = require('../../utils/logger');

// AllAnime scraper worker URL
const SCRAPER_URL = 'https://allanime-scraper.keypop3750.workers.dev';

// Simple in-memory cache for ID mappings (title -> AllAnime showId)
const mappingCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Make HTTPS request to scraper
 */
function fetchFromScraper(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SCRAPER_URL);
    
    const req = https.get(url.toString(), {
      headers: {
        'User-Agent': 'AnimeStream/1.0',
        'Accept': 'application/json'
      },
      timeout: 15000
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`));
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Simple Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  
  return dp[m][n];
}

/**
 * Calculate similarity percentage between two strings
 */
function stringSimilarity(str1, str2) {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 100;
  const distance = levenshteinDistance(str1, str2);
  return Math.round((1 - distance / maxLen) * 100);
}

/**
 * Search AllAnime for an anime by title
 * Returns the best matching showId
 */
async function findAllAnimeShow(title, year = null) {
  // Check cache first
  const cacheKey = `${title}:${year || ''}`;
  const cached = mappingCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.debug(`[CACHE] Found mapping for "${title}": ${cached.showId}`);
    return cached.showId;
  }
  
  try {
    // Search AllAnime
    const searchResult = await fetchFromScraper(`/?action=search&query=${encodeURIComponent(title)}&limit=10`);
    
    if (!searchResult.results || searchResult.results.length === 0) {
      logger.debug(`[SEARCH] No results for "${title}"`);
      return null;
    }
    
    // Find best match
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (const show of searchResult.results) {
      const showTitle = (show.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const nativeTitle = (show.nativeTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      
      // Calculate similarity score using fuzzy matching
      let score = 0;
      
      // Exact match is best
      if (showTitle === normalizedTitle || nativeTitle === normalizedTitle) {
        score = 100;
      }
      // Contains title
      else if (showTitle.includes(normalizedTitle) || normalizedTitle.includes(showTitle)) {
        score = 85;
      }
      // Fuzzy match using Levenshtein distance
      else {
        const similarity = Math.max(
          stringSimilarity(normalizedTitle, showTitle),
          stringSimilarity(normalizedTitle, nativeTitle)
        );
        score = similarity * 0.9; // Scale down slightly
      }
      
      // Prefer TV series over movies/specials for series content
      if (show.type === 'TV') score += 3;
      // Prefer Movie type for single-episode content
      if (show.type === 'Movie' && show.episodes === '1') score += 2;
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = show;
      }
    }
    
    // Lower threshold to 60% to accommodate typos
    if (bestMatch && bestScore >= 60) {
      // Cache the mapping
      mappingCache.set(cacheKey, {
        showId: bestMatch.id,
        title: bestMatch.title,
        timestamp: Date.now()
      });
      
      logger.info(`[MATCH] "${title}" -> "${bestMatch.title}" (${bestMatch.id}) score=${bestScore}`);
      return bestMatch.id;
    }
    
    logger.debug(`[SEARCH] No good match for "${title}" (best score: ${bestScore})`);
    return null;
    
  } catch (error) {
    logger.error(`[SEARCH] Error searching for "${title}":`, error.message);
    return null;
  }
}

/**
 * Parse Stremio ID to extract IMDB ID and episode info
 * Format: tt1234567 (movie) or tt1234567:1:5 (series S01E05)
 */
function parseStremioId(id) {
  const parts = id.split(':');
  return {
    imdbId: parts[0],
    season: parts[1] ? parseInt(parts[1]) : null,
    episode: parts[2] ? parseInt(parts[2]) : null
  };
}

/**
 * Get anime metadata from database by IMDB ID
 */
function getAnimeFromDb(imdbId) {
  const catalog = databaseLoader.getCatalog();
  if (!catalog) return null;
  
  return catalog.find(anime => anime.id === imdbId || anime.imdb_id === imdbId);
}

/**
 * Stream handler - main entry point
 * 
 * @param {Object} args - Stremio stream args
 * @param {string} args.type - 'movie' or 'series'  
 * @param {string} args.id - IMDB ID or IMDB:season:episode
 */
async function streamHandler(args) {
  const { type, id } = args;
  
  logger.info(`[STREAM] Request: ${type}/${id}`);
  
  // Parse the ID
  const { imdbId, season, episode } = parseStremioId(id);
  
  // Get anime info from database
  const anime = getAnimeFromDb(imdbId);
  if (!anime) {
    logger.warn(`[STREAM] Anime not found in database: ${imdbId}`);
    return { streams: [] };
  }
  
  logger.debug(`[STREAM] Found anime: ${anime.name}`);
  
  // Find corresponding AllAnime show
  const showId = await findAllAnimeShow(anime.name, anime.year);
  if (!showId) {
    logger.warn(`[STREAM] Could not find AllAnime match for: ${anime.name}`);
    return { streams: [] };
  }
  
  // Determine episode number
  let episodeNum = 1;
  if (type === 'series' && episode) {
    // For most anime, AllAnime uses absolute episode numbers
    // We might need season adjustment for long-running shows
    episodeNum = episode;
    
    // If season > 1, we might need to calculate absolute episode
    // This is complex and show-dependent, for now just use episode number
    if (season && season > 1) {
      // TODO: Handle multi-season anime better
      // For now, assume absolute numbering from season 1
      logger.debug(`[STREAM] Multi-season request: S${season}E${episode}`);
    }
  }
  
  try {
    // Fetch streams with extraction enabled
    const result = await fetchFromScraper(
      `/?action=streams&showId=${showId}&episode=${episodeNum}&extract=1`
    );
    
    if (!result.streams || result.streams.length === 0) {
      logger.warn(`[STREAM] No streams found for ${anime.name} E${episodeNum}`);
      return { streams: [] };
    }
    
    // Format streams for Stremio
    const streams = result.streams
      .filter(s => s.isDirect) // Only direct playable streams
      .map(stream => {
        const streamObj = {
          name: `AllAnime\n${stream.quality || 'HD'}`,
          title: `${stream.provider || 'Direct'} - ${stream.type || 'SUB'}\n${stream.quality || 'HD'}`,
          url: stream.url
        };
        
        // Add behavior hints for streams that need special headers
        if (stream.behaviorHints) {
          streamObj.behaviorHints = stream.behaviorHints;
        }
        
        return streamObj;
      });
    
    logger.info(`[STREAM] Found ${streams.length} direct streams for ${anime.name} E${episodeNum}`);
    
    return { streams };
    
  } catch (error) {
    logger.error(`[STREAM] Error fetching streams:`, error.message);
    return { streams: [] };
  }
}

module.exports = streamHandler;
