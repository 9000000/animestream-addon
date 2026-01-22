#!/usr/bin/env node
/**
 * AnimeStream Database Builder v6.1
 * 
 * BULLETPROOF anime catalog with reliable torrent searching:
 * - Multi-source ID mapping (Otaku-Mappings + Fribb + anime-offline-db)
 * - AniDB/MAL/AniList IDs for ID-based AnimeTosho lookups
 * - TVDB season/part info for multi-season episode offset handling
 * - Title synonyms (up to 10) for better torrent matching
 * - Media type differentiation (TV/OVA/Movie/Special)
 * - Validation & integrity checks
 * 
 * Data Sources:
 * - Kitsu API - Full anime catalog with genres
 * - Otaku-Mappings - Combined ID database (Fribb+anime-lists+Mdblist+arm)
 *   → Has thetvdb_season, thetvdb_part for multi-season shows!
 * - Fribb/anime-lists - Fallback ID mappings (IMDB/MAL/AniList/AniDB/TVDB)
 * - anime-offline-database - Title synonyms for torrent matching
 * - IMDB Datasets - Title-matching fallback for missing entries
 * - Cinemeta - Logos, backgrounds, cast enrichment
 * 
 * Output files:
 * - catalog.json / catalog-series.json / catalog-movies.json
 * - id-mappings.json - Fast ID lookup cache (IMDB→AniDB/MAL/AniList/TVDB season)
 * - filter-options.json
 * 
 * Usage:
 *   node scripts/build-database-v6.1.js          # Full build
 *   node scripts/build-database-v6.1.js --test   # Test mode (500 items)
 *   node scripts/build-database-v6.1.js --skip-imdb  # Skip IMDB matching
 *   node scripts/build-database-v6.1.js --skip-cinemeta  # Skip Cinemeta enrichment
 *   node scripts/build-database-v6.1.js --validate  # Run extra validation
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

// CLI flags
const TEST_MODE = process.argv.includes('--test');
const SKIP_IMDB_MATCHING = process.argv.includes('--skip-imdb');
const SKIP_CINEMETA = process.argv.includes('--skip-cinemeta');
const VERBOSE = process.argv.includes('--verbose');
const VALIDATE = process.argv.includes('--validate');
const TEST_LIMIT = 500;
const MAX_SYNONYMS = 10; // Increased from 5 for better torrent matching

// Configuration
const CONFIG = {
  outputDir: path.join(__dirname, '..', 'data'),
  imdbDir: path.join(__dirname, '..', 'data', 'imdb'),
  catalogFile: TEST_MODE ? 'catalog-test.json' : 'catalog.json',
  catalogSeriesFile: TEST_MODE ? 'catalog-series-test.json' : 'catalog-series.json',
  catalogMoviesFile: TEST_MODE ? 'catalog-movies-test.json' : 'catalog-movies.json',
  idMappingsFile: 'id-mappings.json',
  filterOptionsFile: 'filter-options.json',
  
  // Kitsu API
  kitsuBaseUrl: 'https://kitsu.io/api/edge',
  kitsuPageSize: 20,
  
  // Otaku-Mappings (pre-converted JSON) - Combined database with TVDB season info!
  otakuMappingsPath: path.join(__dirname, '..', 'data', 'otaku-mappings.json'),
  
  // Fribb mappings - fallback ID mappings (IMDB/MAL/AniList/AniDB/TVDB/Kitsu)
  fribbUrl: 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
  
  // anime-offline-database - has synonyms (from GitHub releases)
  animeOfflineDbUrl: 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json',
  
  // Cinemeta
  cinemataBase: 'https://v3-cinemeta.strem.io/meta',
  cinemataDelayMs: 50,
  cinemataBatchSize: 5,
  
  // Rate limiting
  requestDelay: 150,
  
  // IMDB matching settings
  minSimilarity: 0.85,
  yearTolerance: 2,
  minTitleLength: 3,
  relevantTypes: ['tvSeries', 'tvMiniSeries', 'movie', 'video', 'tvMovie', 'tvSpecial'],
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function progressBar(current, total, width = 30) {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${percent}% (${current}/${total})`;
}

// ============================================================
// TITLE NORMALIZATION & MATCHING
// ============================================================

function normalizeTitle(title) {
  if (!title) return '';
  
  return title
    .toLowerCase()
    .trim()
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[：・「」『』【】〈〉《》（）]/g, ' ')
    .replace(/[^\w\s\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf-]/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ou/g, 'o')
    .replace(/uu/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/ii/g, 'i')
    .replace(/ee/g, 'e')
    .replace(/\s+(the\s+)?(animation|animated|anime|ova|ona|movie|film|special|tv|series)s?$/gi, '')
    .replace(/\s+(season|part|cour|chapter|arc)\s*\d*$/gi, '')
    .replace(/\s+(1st|2nd|3rd|\d+th)\s+(season|part|cour)$/gi, '')
    .replace(/\s+[ivx]+$/gi, '')
    .replace(/\s*s\d+\s*/gi, ' ')
    .replace(/\s*ep\.?\s*\d+/gi, '')
    .replace(/\band\b/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/\ba\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, ' ')
    .trim();
}

function extractBaseTitle(title) {
  if (!title) return '';
  return title
    .replace(/:\s*(season|part|cour)\s*\d+/gi, '')
    .replace(/\s+(season|part|cour)\s*\d+/gi, '')
    .replace(/\s+\d+(st|nd|rd|th)\s+(season|part)/gi, '')
    .replace(/\s+[IVX]+$/gi, '')
    .replace(/\s+\d+$/g, '')
    .replace(/:\s*[^:]+$/g, '')
    .trim();
}

function generateTitleVariations(title, originalTitle) {
  const variations = new Set();
  
  if (title) {
    variations.add(normalizeTitle(title));
    variations.add(normalizeTitle(extractBaseTitle(title)));
  }
  
  if (originalTitle && originalTitle !== title) {
    variations.add(normalizeTitle(originalTitle));
    variations.add(normalizeTitle(extractBaseTitle(originalTitle)));
  }
  
  if (title) {
    const noThe = title.replace(/^the\s+/i, '');
    if (noThe !== title) variations.add(normalizeTitle(noThe));
  }
  
  return [...variations].filter(v => v.length >= CONFIG.minTitleLength);
}

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }
  
  return matrix[b.length][a.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  
  if (longer.length === 0) return 1;
  if (shorter.length < longer.length * 0.5) return 0;
  
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

// ============================================================
// HTTP HELPERS
// ============================================================

async function fetchWithRetry(url, options = {}, retries = 3) {
  const fetch = (await import('node-fetch')).default;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json', ...options.headers },
        timeout: options.timeout || 30000
      });
      
      if (response.status === 429) {
        console.log('\n   ⚠️  Rate limited, waiting 30s...');
        await sleep(30000);
        continue;
      }
      
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      return await response.json();
    } catch (err) {
      if (attempt === retries) {
        if (options.silent) return null;
        throw err;
      }
      await sleep(2000 * attempt);
    }
  }
  return null;
}

// ============================================================
// OTAKU-MAPPINGS (Primary source - has TVDB season info!)
// ============================================================

function loadOtakuMappings() {
  console.log('📥 Loading Otaku-Mappings (primary ID source with TVDB season)...');
  
  if (!fs.existsSync(CONFIG.otakuMappingsPath)) {
    console.log('   ⚠️  Otaku-Mappings JSON not found. Run: node scripts/convert-otaku-mappings.js');
    return null;
  }
  
  try {
    const raw = fs.readFileSync(CONFIG.otakuMappingsPath, 'utf-8');
    const data = JSON.parse(raw);
    
    console.log(`   ✅ Loaded ${data.stats.total.toLocaleString()} entries`);
    console.log(`   📊 With IMDB: ${data.stats.withImdb}, AniDB: ${data.stats.withAnidb}, TVDB Season: ${data.stats.withTvdbSeason}`);
    console.log('');
    
    return data;
  } catch (err) {
    console.error(`   ❌ Failed to load Otaku-Mappings: ${err.message}`);
    return null;
  }
}

/**
 * Get mapping from Otaku-Mappings by various IDs
 * Returns entry with: mal, dub, al, kitsu, adb, tvdb, imdb, tvdbS, tvdbP, type, eps
 */
function getOtakuMapping(otakuData, idType, id) {
  if (!otakuData || !id) return null;
  
  const indexMap = {
    'mal': 'mal',
    'imdb': 'imdb',
    'anidb': 'anidb',
    'kitsu': 'kitsu',
    'anilist': 'anilist',
  };
  
  const indexKey = indexMap[idType];
  if (!indexKey) return null;
  
  const idx = otakuData.indexes[indexKey][id];
  if (idx === undefined) return null;
  
  return otakuData.entries[idx];
}

// ============================================================
// FRIBB MAPPINGS (Fallback - for entries not in Otaku-Mappings)
// ============================================================

async function loadFribbMappings() {
  console.log('📥 Loading Fribb/anime-lists mappings (fallback)...');
  
  try {
    const data = await fetchWithRetry(CONFIG.fribbUrl, { timeout: 60000 });
    if (!data) throw new Error('No data received');
    
    // Create comprehensive lookup maps
    const malToFull = new Map();      // MAL ID -> full entry
    const kitsuToFull = new Map();    // Kitsu ID -> full entry
    const anilistToFull = new Map();  // AniList ID -> full entry
    const imdbToFull = new Map();     // IMDB ID -> full entry
    
    for (const entry of data) {
      // Store full entry for comprehensive ID access
      const fullEntry = {
        mal_id: entry.mal_id || null,
        anilist_id: entry.anilist_id || null,
        anidb_id: entry.anidb_id || null,
        kitsu_id: entry.kitsu_id || null,
        imdb_id: entry.imdb_id || null,
        tvdb_id: entry.thetvdb_id || entry.tvdb_id || null,
        tmdb_id: entry.themoviedb_id || null,
      };
      
      if (entry.mal_id) malToFull.set(entry.mal_id, fullEntry);
      if (entry.kitsu_id) kitsuToFull.set(entry.kitsu_id, fullEntry);
      if (entry.anilist_id) anilistToFull.set(entry.anilist_id, fullEntry);
      if (entry.imdb_id) imdbToFull.set(entry.imdb_id, fullEntry);
    }
    
    console.log(`   ✅ Loaded ${data.length} mappings`);
    console.log(`   📊 MAL: ${malToFull.size}, Kitsu: ${kitsuToFull.size}, AniList: ${anilistToFull.size}, IMDB: ${imdbToFull.size}\n`);
    
    return { malToFull, kitsuToFull, anilistToFull, imdbToFull, rawData: data };
  } catch (err) {
    console.error(`   ❌ Failed to load Fribb mappings: ${err.message}\n`);
    return { malToFull: new Map(), kitsuToFull: new Map(), anilistToFull: new Map(), imdbToFull: new Map(), rawData: [] };
  }
}

// ============================================================
// ANIME-OFFLINE-DATABASE (Synonyms)
// ============================================================

async function loadAnimeOfflineDatabase() {
  console.log('📥 Loading anime-offline-database (synonyms)...');
  
  try {
    const data = await fetchWithRetry(CONFIG.animeOfflineDbUrl, { timeout: 120000 });
    if (!data || !data.data) throw new Error('No data received');
    
    // Create lookup by MAL ID (extracted from sources)
    const malToSynonyms = new Map();
    const kitsuToSynonyms = new Map();
    
    for (const entry of data.data) {
      const synonyms = [entry.title, ...(entry.synonyms || [])].filter(Boolean);
      
      // Extract IDs from sources
      for (const source of entry.sources || []) {
        const malMatch = source.match(/myanimelist\.net\/anime\/(\d+)/);
        if (malMatch) {
          const malId = parseInt(malMatch[1], 10);
          malToSynonyms.set(malId, synonyms);
        }
        
        const kitsuMatch = source.match(/kitsu\.(?:io|app)\/anime\/(\d+)/);
        if (kitsuMatch) {
          const kitsuId = parseInt(kitsuMatch[1], 10);
          kitsuToSynonyms.set(kitsuId, synonyms);
        }
      }
    }
    
    console.log(`   ✅ Loaded ${data.data.length} entries`);
    console.log(`   📊 MAL synonyms: ${malToSynonyms.size}, Kitsu synonyms: ${kitsuToSynonyms.size}\n`);
    
    return { malToSynonyms, kitsuToSynonyms };
  } catch (err) {
    console.error(`   ❌ Failed to load anime-offline-database: ${err.message}\n`);
    return { malToSynonyms: new Map(), kitsuToSynonyms: new Map() };
  }
}

// ============================================================
// CINEMETA ENRICHMENT
// ============================================================

async function fetchCinemeta(imdbId, type = 'series') {
  try {
    const url = `${CONFIG.cinemataBase}/${type}/${imdbId}.json`;
    const data = await fetchWithRetry(url, { silent: true, timeout: 10000 }, 2);
    
    if (!data || !data.meta) return null;
    
    const meta = data.meta;
    return {
      logo: meta.logo || null,
      background: meta.background || null,
      cast: meta.cast ? meta.cast.slice(0, 10) : [],
      cinemataGenres: meta.genres || [],
      cinemataDescription: meta.description || null,
      cinemataName: meta.name || null,
      releaseInfo: meta.releaseInfo || null
    };
  } catch (err) {
    return null;
  }
}

async function enrichWithCinemeta(animeList) {
  if (SKIP_CINEMETA) {
    console.log('\n⏭️  Skipping Cinemeta enrichment (--skip-cinemeta flag)\n');
    return { enriched: 0, logos: 0, backgrounds: 0, cast: 0 };
  }
  
  console.log('\n🎨 Enriching with Cinemeta data (logos, backgrounds, cast)...');
  
  let enriched = 0;
  let logos = 0;
  let backgrounds = 0;
  let castCount = 0;
  
  const total = animeList.length;
  
  for (let i = 0; i < animeList.length; i += CONFIG.cinemataBatchSize) {
    const batch = animeList.slice(i, Math.min(i + CONFIG.cinemataBatchSize, animeList.length));
    
    await Promise.all(batch.map(async (anime) => {
      if (!anime.imdb_id) return;
      
      const type = anime.subtype === 'movie' ? 'movie' : 'series';
      const cinemata = await fetchCinemeta(anime.imdb_id, type);
      
      if (cinemata) {
        enriched++;
        
        if (cinemata.logo) {
          anime.logo = cinemata.logo;
          logos++;
        }
        
        if (cinemata.background && !anime.background) {
          anime.background = cinemata.background;
          backgrounds++;
        }
        
        if (cinemata.cast && cinemata.cast.length > 0) {
          anime.cast = cinemata.cast;
          castCount++;
        }
        
        if (cinemata.cinemataGenres && cinemata.cinemataGenres.length > 0) {
          const existingGenres = new Set(anime.genres || []);
          for (const g of cinemata.cinemataGenres) {
            existingGenres.add(g);
          }
          anime.genres = [...existingGenres];
        }
        
        if (cinemata.cinemataName && anime.name) {
          const hasJapanese = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/.test(anime.name);
          if (hasJapanese) {
            anime.cinemataName = cinemata.cinemataName;
          }
        }
      }
    }));
    
    const processed = Math.min(i + CONFIG.cinemataBatchSize, total);
    process.stdout.write(`\r   ${progressBar(processed, total)} - Logos: ${logos}, Cast: ${castCount}`);
    
    await sleep(CONFIG.cinemataDelayMs);
  }
  
  console.log(`\n   ✅ Cinemeta enrichment complete:`);
  console.log(`      Enriched: ${enriched}/${total} (${Math.round(enriched/total*100)}%)`);
  console.log(`      Logos: ${logos}, Backgrounds: ${backgrounds}, Cast: ${castCount}\n`);
  
  return { enriched, logos, backgrounds, cast: castCount };
}

// ============================================================
// JIKAN BROADCAST DATA (fallback) + LIVECHART.ME (primary for schedules)
// ============================================================

const JIKAN_BASE_URL = 'https://api.jikan.moe/v4';
const JIKAN_RATE_LIMIT_MS = 100; // Jikan doesn't rate limit as much as MAL

// LiveChart GraphQL API for accurate schedules
const LIVECHART_API_URL = 'https://www.livechart.me/graphql';

/**
 * Fetch currently airing anime schedules from LiveChart.me
 * LiveChart has the most accurate broadcast schedules
 */
async function fetchLiveChartSchedules() {
  console.log('\n📺 Fetching schedules from LiveChart.me...');
  
  const fetch = (await import('node-fetch')).default;
  
  // GraphQL query for airing anime with schedules
  const query = `
    query {
      airingAnimes(filter: {status: AIRING}) {
        nodes {
          databaseId
          title
          malId
          anilistId
          broadcastSchedule {
            weekday
            time
          }
        }
      }
    }
  `;
  
  try {
    const response = await fetch(LIVECHART_API_URL, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ query }),
      timeout: 30000
    });
    
    if (!response.ok) {
      console.log(`   ⚠️  LiveChart returned ${response.status}, falling back to Jikan`);
      return null;
    }
    
    const data = await response.json();
    const animes = data?.data?.airingAnimes?.nodes || [];
    
    // Create lookup maps by MAL ID and AniList ID
    const scheduleByMalId = new Map();
    const scheduleByAnilistId = new Map();
    
    for (const anime of animes) {
      const schedule = anime.broadcastSchedule;
      if (schedule && schedule.weekday) {
        // Convert weekday index to name (0=Sunday, 1=Monday, etc.)
        const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const entry = {
          day: weekdays[schedule.weekday] || null,
          time: schedule.time || null
        };
        
        if (anime.malId) scheduleByMalId.set(anime.malId, entry);
        if (anime.anilistId) scheduleByAnilistId.set(anime.anilistId, entry);
      }
    }
    
    console.log(`   ✅ Loaded ${animes.length} airing anime schedules from LiveChart`);
    return { scheduleByMalId, scheduleByAnilistId };
    
  } catch (err) {
    console.log(`   ⚠️  LiveChart error: ${err.message}, falling back to Jikan`);
    return null;
  }
}

async function fetchJikanBroadcast(malId) {
  try {
    const url = `${JIKAN_BASE_URL}/anime/${malId}`;
    const data = await fetchWithRetry(url, { silent: true, timeout: 10000 }, 2);
    
    if (!data || !data.data) return null;
    
    const anime = data.data;
    return {
      broadcastDay: anime.broadcast?.day || null,
      broadcastTime: anime.broadcast?.time || null,
    };
  } catch (err) {
    return null;
  }
}

async function enrichWithJikanBroadcast(animeList) {
  console.log('\n📺 Enriching broadcast schedules (LiveChart + Jikan fallback)...');
  
  const ongoingAnime = animeList.filter(a => a.status === 'ONGOING');
  
  if (ongoingAnime.length === 0) {
    console.log('   No ongoing anime found, skipping.\n');
    return { total: 0, enriched: 0, fromLiveChart: 0, fromJikan: 0 };
  }
  
  console.log(`   Found ${ongoingAnime.length} ongoing anime to check...\n`);
  
  // Try LiveChart first (faster and more accurate)
  const liveChartData = await fetchLiveChartSchedules();
  
  let enriched = 0;
  let fromLiveChart = 0;
  let fromJikan = 0;
  
  for (let i = 0; i < ongoingAnime.length; i++) {
    const anime = ongoingAnime[i];
    let found = false;
    
    // Try LiveChart first (by MAL ID or AniList ID)
    if (liveChartData) {
      let schedule = null;
      if (anime.mal_id && liveChartData.scheduleByMalId.has(anime.mal_id)) {
        schedule = liveChartData.scheduleByMalId.get(anime.mal_id);
      } else if (anime.anilist_id && liveChartData.scheduleByAnilistId.has(anime.anilist_id)) {
        schedule = liveChartData.scheduleByAnilistId.get(anime.anilist_id);
      }
      
      if (schedule && schedule.day) {
        anime.broadcastDay = schedule.day;
        anime.broadcastTime = schedule.time;
        enriched++;
        fromLiveChart++;
        found = true;
      }
    }
    
    // Fallback to Jikan for remaining anime
    if (!found && anime.mal_id) {
      const broadcastData = await fetchJikanBroadcast(anime.mal_id);
      
      if (broadcastData && broadcastData.broadcastDay) {
        const day = broadcastData.broadcastDay.replace(/s$/i, '');
        anime.broadcastDay = day;
        anime.broadcastTime = broadcastData.broadcastTime;
        enriched++;
        fromJikan++;
      }
      
      await sleep(JIKAN_RATE_LIMIT_MS);
    }
    
    process.stdout.write(`\r   ${progressBar(i + 1, ongoingAnime.length)} - LiveChart: ${fromLiveChart}, Jikan: ${fromJikan}`);
  }
  
  console.log(`\n\n   ✅ Broadcast enrichment complete: ${enriched}/${ongoingAnime.length}`);
  console.log(`      From LiveChart: ${fromLiveChart} | From Jikan: ${fromJikan}\n`);
  
  return { total: ongoingAnime.length, enriched, fromLiveChart, fromJikan };
}

// ============================================================
// KITSU API
// ============================================================

async function kitsuRequest(endpoint, retries = 3) {
  const url = endpoint.startsWith('http') ? endpoint : `${CONFIG.kitsuBaseUrl}${endpoint}`;
  return fetchWithRetry(url, { headers: { 'Accept': 'application/vnd.api+json' } }, retries);
}

async function fetchAllKitsuAnime() {
  console.log('\n📥 Fetching anime from Kitsu API (with genres)...');
  console.log('   Total available: ~21,859 anime\n');
  
  const allAnime = [];
  const genreMap = new Map();
  let offset = 0;
  let totalCount = null;
  
  while (true) {
    try {
      const data = await kitsuRequest(
        `/anime?page[limit]=${CONFIG.kitsuPageSize}&page[offset]=${offset}&sort=-userCount&include=genres`
      );
      
      if (!data) break;
      
      if (totalCount === null) {
        totalCount = TEST_MODE ? Math.min(data.meta.count, TEST_LIMIT) : data.meta.count;
      }
      
      if (data.included) {
        for (const item of data.included) {
          if (item.type === 'genres') {
            genreMap.set(item.id, item.attributes.name);
          }
        }
      }
      
      for (const anime of data.data) {
        const genreIds = anime.relationships?.genres?.data?.map(g => g.id) || [];
        anime._genres = genreIds.map(id => genreMap.get(id)).filter(Boolean);
        allAnime.push(anime);
      }
      
      const progress = Math.min(allAnime.length, totalCount);
      process.stdout.write(`\r   ${progressBar(progress, totalCount)} - ${allAnime.length} fetched`);
      
      if (!data.links.next || allAnime.length >= totalCount) break;
      
      offset += CONFIG.kitsuPageSize;
      await sleep(CONFIG.requestDelay);
      
    } catch (err) {
      console.log(`\n   ⚠️  Error at offset ${offset}: ${err.message}, retrying...`);
      await sleep(5000);
    }
  }
  
  console.log(`\n   ✅ Fetched ${allAnime.length} anime from Kitsu\n`);
  return allAnime;
}

async function fetchKitsuMappings(kitsuId) {
  try {
    const data = await kitsuRequest(`/anime/${kitsuId}/mappings`);
    if (!data) return {};
    
    const mappings = {};
    
    for (const mapping of data.data) {
      const site = mapping.attributes.externalSite;
      const id = mapping.attributes.externalId;
      
      if (site === 'myanimelist/anime') mappings.mal_id = parseInt(id, 10);
      if (site === 'thetvdb' || site === 'thetvdb/series') mappings.tvdb_id = parseInt(id, 10);
      if (site === 'anilist/anime') mappings.anilist_id = parseInt(id, 10);
      if (site === 'anidb') mappings.anidb_id = parseInt(id, 10);
    }
    
    return mappings;
  } catch (err) {
    return {};
  }
}

// ============================================================
// IMDB DATASET LOADING & MATCHING
// ============================================================

async function loadImdbBasics(filePath) {
  console.log('\n📖 Loading IMDB basics (filtering to animation)...');
  
  const imdbData = new Map();
  let lineCount = 0;
  let animationCount = 0;
  
  const gunzip = zlib.createGunzip();
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream.pipe(gunzip),
    crlfDelay: Infinity
  });
  
  let headers = null;
  
  for await (const line of rl) {
    lineCount++;
    
    if (lineCount === 1) {
      headers = line.split('\t');
      continue;
    }
    
    if (lineCount % 500000 === 0) {
      process.stdout.write(`\r   Processed ${(lineCount / 1000000).toFixed(1)}M lines, found ${animationCount} animation titles`);
    }
    
    const values = line.split('\t');
    const row = {};
    headers.forEach((h, i) => row[h] = values[i]);
    
    const genres = row.genres || '';
    const titleType = row.titleType || '';
    const isAdult = row.isAdult === '1';
    
    if (!CONFIG.relevantTypes.includes(titleType)) continue;
    if (!genres.toLowerCase().includes('animation')) continue;
    if (isAdult) continue;
    
    imdbData.set(row.tconst, {
      id: row.tconst,
      title: row.primaryTitle,
      originalTitle: row.originalTitle !== '\\N' ? row.originalTitle : null,
      year: row.startYear !== '\\N' ? parseInt(row.startYear) : null,
      type: titleType,
      genres: genres.split(','),
    });
    
    animationCount++;
  }
  
  console.log(`\n   ✅ Loaded ${animationCount} animation titles`);
  return imdbData;
}

async function loadImdbAkas(filePath, relevantIds) {
  console.log('\n📖 Loading IMDB alternative titles...');
  
  const akasMap = new Map();
  let lineCount = 0;
  
  const gunzip = zlib.createGunzip();
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream.pipe(gunzip),
    crlfDelay: Infinity
  });
  
  let headers = null;
  
  for await (const line of rl) {
    lineCount++;
    
    if (lineCount === 1) {
      headers = line.split('\t');
      continue;
    }
    
    if (lineCount % 1000000 === 0) {
      process.stdout.write(`\r   Processed ${(lineCount / 1000000).toFixed(1)}M lines`);
    }
    
    const values = line.split('\t');
    const titleId = values[0];
    
    if (!relevantIds.has(titleId)) continue;
    
    const title = values[2];
    
    if (title && title !== '\\N') {
      if (!akasMap.has(titleId)) {
        akasMap.set(titleId, new Set());
      }
      akasMap.get(titleId).add(title);
    }
  }
  
  console.log(`\n   ✅ Loaded alternative titles for ${akasMap.size} entries`);
  return akasMap;
}

function buildSearchIndex(imdbData, akasMap) {
  console.log('\n🔧 Building IMDB search index...');
  
  const index = new Map();
  
  for (const [imdbId, entry] of imdbData) {
    const normalized = normalizeTitle(entry.title);
    if (normalized.length >= CONFIG.minTitleLength) {
      if (!index.has(normalized)) index.set(normalized, []);
      index.get(normalized).push(entry);
    }
    
    if (entry.originalTitle) {
      const normOriginal = normalizeTitle(entry.originalTitle);
      if (normOriginal.length >= CONFIG.minTitleLength && normOriginal !== normalized) {
        if (!index.has(normOriginal)) index.set(normOriginal, []);
        index.get(normOriginal).push(entry);
      }
    }
    
    const akas = akasMap.get(imdbId);
    if (akas) {
      for (const aka of akas) {
        const normAka = normalizeTitle(aka);
        if (normAka.length >= CONFIG.minTitleLength) {
          if (!index.has(normAka)) index.set(normAka, []);
          if (!index.get(normAka).some(e => e.id === imdbId)) {
            index.get(normAka).push(entry);
          }
        }
      }
    }
  }
  
  console.log(`   ✅ Indexed ${index.size} unique title variations`);
  return index;
}

function findImdbMatch(name, year, searchIndex) {
  const variations = generateTitleVariations(name, null);
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const variation of variations) {
    if (searchIndex.has(variation)) {
      const candidates = searchIndex.get(variation);
      
      for (const candidate of candidates) {
        if (year && candidate.year) {
          const yearDiff = Math.abs(year - candidate.year);
          if (yearDiff > CONFIG.yearTolerance) continue;
        }
        
        return { imdbId: candidate.id, score: 1.0, reason: 'exact' };
      }
    }
  }
  
  for (const [indexTitle, candidates] of searchIndex) {
    for (const variation of variations) {
      const simScore = similarity(variation, indexTitle);
      
      if (simScore >= CONFIG.minSimilarity && simScore > bestScore) {
        for (const candidate of candidates) {
          if (year && candidate.year) {
            const yearDiff = Math.abs(year - candidate.year);
            if (yearDiff > CONFIG.yearTolerance) continue;
          }
          
          let typeBonus = 0;
          if (candidate.type === 'tvSeries' || candidate.type === 'tvMiniSeries') {
            typeBonus = 0.02;
          }
          
          const adjustedScore = simScore + typeBonus;
          if (adjustedScore > bestScore) {
            bestMatch = candidate;
            bestScore = adjustedScore;
          }
        }
      }
    }
  }
  
  if (bestMatch && bestScore >= CONFIG.minSimilarity) {
    return { imdbId: bestMatch.id, score: bestScore, reason: 'fuzzy' };
  }
  
  return null;
}

// ============================================================
// SEASON GROUPING
// ============================================================

function extractCleanTitle(title) {
  if (!title) return '';
  
  return title
    .replace(/:\s*(?:Season|Part|Cour)\s*\d+/gi, '')
    .replace(/:\s*The\s+Final\s+Season/gi, '')
    .replace(/:\s*Final\s+Season/gi, '')
    .replace(/\s+(?:Season|Part|Cour)\s*\d+/gi, '')
    .replace(/\s+\d+(?:st|nd|rd|th)\s+Season/gi, '')
    .replace(/\s+[IVX]+$/gi, '')
    .replace(/\s+\d+$/gi, '')
    .trim();
}

function groupByImdbId(animeList) {
  console.log('\n🔗 Grouping seasons by IMDB ID...');
  
  const groups = new Map();
  
  for (const anime of animeList) {
    const imdbId = anime.imdb_id;
    if (!imdbId) continue;
    
    if (!groups.has(imdbId)) {
      groups.set(imdbId, []);
    }
    groups.get(imdbId).push(anime);
  }
  
  const result = [];
  let mergedCount = 0;
  
  for (const [imdbId, entries] of groups) {
    if (entries.length === 1) {
      const entry = entries[0];
      entry.name = extractCleanTitle(entry.name) || entry.name;
      result.push(entry);
    } else {
      mergedCount += entries.length - 1;
      
      entries.sort((a, b) => {
        if (a.year && b.year && a.year !== b.year) {
          return a.year - b.year;
        }
        return (b.popularity || 0) - (a.popularity || 0);
      });
      
      const primary = entries[0];
      primary.name = extractCleanTitle(primary.name) || primary.name;
      
      const allGenres = new Set(primary.genres || []);
      for (const entry of entries) {
        if (entry.genres) {
          entry.genres.forEach(g => allGenres.add(g));
        }
      }
      primary.genres = [...allGenres];
      
      const ratings = entries.map(e => e.rating).filter(r => r != null);
      if (ratings.length > 0) {
        primary.rating = Math.max(...ratings);
      }
      
      primary.popularity = entries.reduce((sum, e) => sum + (e.popularity || 0), 0);
      primary._mergedSeasons = entries.length;
      
      // Merge IDs from all entries (take first non-null)
      for (const entry of entries) {
        if (!primary.mal_id && entry.mal_id) primary.mal_id = entry.mal_id;
        if (!primary.anilist_id && entry.anilist_id) primary.anilist_id = entry.anilist_id;
        if (!primary.anidb_id && entry.anidb_id) primary.anidb_id = entry.anidb_id;
        if (!primary.synonyms && entry.synonyms) primary.synonyms = entry.synonyms;
      }
      
      result.push(primary);
    }
  }
  
  console.log(`   ✅ Grouped ${animeList.length} → ${result.length} entries (merged ${mergedCount} seasons)\n`);
  return result;
}

// ============================================================
// CONVERT TO STREMIO FORMAT (Enhanced for v6)
// ============================================================

function convertToStremioMeta(kitsuAnime, fribbEntry, malId, synonyms) {
  const attrs = kitsuAnime.attributes;
  
  const titles = attrs.titles || {};
  const name = titles.en || titles.en_jp || attrs.canonicalTitle || 'Unknown';
  
  const poster = attrs.posterImage?.large || attrs.posterImage?.medium || null;
  const background = attrs.coverImage?.large || attrs.coverImage?.original || null;
  const rating = attrs.averageRating ? parseFloat(attrs.averageRating) / 10 : null;
  const year = attrs.startDate ? parseInt(attrs.startDate.split('-')[0], 10) : null;
  
  let season = null;
  if (attrs.startDate) {
    const month = parseInt(attrs.startDate.split('-')[1], 10);
    if (month >= 1 && month <= 3) season = 'winter';
    else if (month >= 4 && month <= 6) season = 'spring';
    else if (month >= 7 && month <= 9) season = 'summer';
    else if (month >= 10 && month <= 12) season = 'fall';
  }
  
  let status = attrs.status;
  if (status === 'finished') status = 'FINISHED';
  else if (status === 'current') status = 'ONGOING';
  else if (status === 'upcoming') status = 'UPCOMING';
  
  // Get all IDs from Fribb entry
  const imdbId = fribbEntry?.imdb_id || null;
  const anilistId = fribbEntry?.anilist_id || null;
  const anidbId = fribbEntry?.anidb_id || null;
  
  return {
    id: imdbId,
    imdb_id: imdbId,
    kitsu_id: parseInt(kitsuAnime.id, 10),
    mal_id: malId,
    anilist_id: anilistId,     // NEW in v6
    anidb_id: anidbId,         // NEW in v6 - Critical for AnimeTosho
    type: 'series',
    name: name,
    slug: attrs.slug,
    description: attrs.synopsis || attrs.description || '',
    year: year,
    season: season,
    status: status,
    rating: rating,
    poster: poster,
    background: background,
    logo: null,
    cast: [],
    genres: kitsuAnime._genres || [],
    episodeCount: attrs.episodeCount || null,
    runtime: attrs.episodeLength ? `${attrs.episodeLength} min` : null,
    ageRating: attrs.ageRating,
    subtype: attrs.subtype,
    popularity: attrs.userCount || 0,
    synonyms: synonyms || [],   // NEW in v6 - For torrent title matching
  };
}

// ============================================================
// BUILD ID MAPPINGS CACHE
// ============================================================

function buildIdMappingsCache(animeList, otakuData) {
  console.log('🗂️  Building ID mappings cache (with TVDB season info)...');
  
  const mappings = {};
  let withAnidb = 0;
  let withMal = 0;
  let withAnilist = 0;
  let withSynonyms = 0;
  let withTvdbSeason = 0;
  let withType = 0;
  
  for (const anime of animeList) {
    if (!anime.imdb_id) continue;
    
    const entry = {
      name: anime.name,
    };
    
    if (anime.mal_id) {
      entry.mal = anime.mal_id;
      withMal++;
      
      // Get TVDB season info from Otaku-Mappings
      if (otakuData) {
        const otakuEntry = getOtakuMapping(otakuData, 'mal', anime.mal_id);
        if (otakuEntry) {
          // TVDB season (critical for multi-season episode offset!)
          if (otakuEntry.tvdbS != null) {
            entry.tvdbS = otakuEntry.tvdbS;
            withTvdbSeason++;
          }
          if (otakuEntry.tvdbP != null) {
            entry.tvdbP = otakuEntry.tvdbP;
          }
          // Media type (TV, OVA, Movie, Special)
          if (otakuEntry.type) {
            entry.type = otakuEntry.type;
            withType++;
          }
          // Episode range
          if (otakuEntry.eps) {
            entry.eps = otakuEntry.eps;
          }
        }
      }
    }
    if (anime.anilist_id) {
      entry.al = anime.anilist_id;
      withAnilist++;
    }
    if (anime.anidb_id) {
      entry.adb = anime.anidb_id;
      withAnidb++;
    }
    if (anime.kitsu_id) {
      entry.kitsu = anime.kitsu_id;
    }
    if (anime.synonyms && anime.synonyms.length > 0) {
      // Store up to MAX_SYNONYMS (10) for better torrent matching
      entry.syn = anime.synonyms.slice(0, MAX_SYNONYMS);
      withSynonyms++;
    }
    
    mappings[anime.imdb_id] = entry;
  }
  
  console.log(`   ✅ Created mappings for ${Object.keys(mappings).length} anime`);
  console.log(`      With AniDB: ${withAnidb} (for AnimeTosho ID search)`);
  console.log(`      With MAL: ${withMal}`);
  console.log(`      With AniList: ${withAnilist}`);
  console.log(`      With TVDB Season: ${withTvdbSeason} (for multi-season offset)`);
  console.log(`      With Media Type: ${withType}`);
  console.log(`      With synonyms: ${withSynonyms}\n`);
  
  return mappings;
}

// ============================================================
// MAIN BUILD FUNCTION
// ============================================================

async function buildDatabase() {
  const startTime = Date.now();
  
  console.log('\\n============================================================');
  console.log('       AnimeStream Database Builder v6.1');
  console.log('       (Otaku-Mappings + Enhanced IDs + TVDB Season Info)');
  console.log('============================================================');
  console.log(`Mode: ${TEST_MODE ? 'TEST (limited)' : 'FULL'}`);
  console.log(`IMDB Matching: ${SKIP_IMDB_MATCHING ? 'DISABLED' : 'ENABLED'}`);
  console.log(`Cinemeta Enrichment: ${SKIP_CINEMETA ? 'DISABLED' : 'ENABLED'}`);
  console.log(`Validation: ${VALIDATE ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Output: ${CONFIG.outputDir}\\n`);
  
  // Step 1: Load Otaku-Mappings (primary source with TVDB season!)
  const otakuData = loadOtakuMappings();
  
  // Step 2: Load Fribb mappings (fallback)
  const fribbData = await loadFribbMappings();
  const { malToFull, kitsuToFull } = fribbData;
  
  // Step 3: Load anime-offline-database (synonyms)
  const { malToSynonyms, kitsuToSynonyms } = await loadAnimeOfflineDatabase();
  
  // Step 4: Load IMDB data if not skipping
  let searchIndex = null;
  if (!SKIP_IMDB_MATCHING) {
    const basicsPath = path.join(CONFIG.imdbDir, 'title.basics.tsv.gz');
    const akasPath = path.join(CONFIG.imdbDir, 'title.akas.tsv.gz');
    
    if (fs.existsSync(basicsPath) && fs.existsSync(akasPath)) {
      const imdbData = await loadImdbBasics(basicsPath);
      const akasMap = await loadImdbAkas(akasPath, imdbData);
      searchIndex = buildSearchIndex(imdbData, akasMap);
    } else {
      console.log('\\n⚠️  IMDB datasets not found. Run with --skip-imdb or download first.');
      console.log('   Run: node scripts/enrich-imdb-mappings.js --download\\n');
    }
  }
  
  // Step 5: Fetch all anime from Kitsu
  const kitsuAnime = await fetchAllKitsuAnime();
  
  // Step 6: Process anime with multi-source ID mapping
  console.log('🔄 Processing anime with multi-source ID mapping...');
  console.log('   Priority: Otaku-Mappings → Fribb → IMDB title match\\n');
  
  const processedAnime = [];
  let fromOtaku = 0;
  let fromFribb = 0;
  let fromImdbMatch = 0;
  let noMatch = 0;
  let withAnidb = 0;
  let withSynonyms = 0;
  let withTvdbSeason = 0;
  
  const batchSize = 10;
  for (let i = 0; i < kitsuAnime.length; i += batchSize) {
    const batch = kitsuAnime.slice(i, i + batchSize);
    
    await Promise.all(batch.map(async (anime) => {
      const kitsuId = parseInt(anime.id, 10);
      const attrs = anime.attributes;
      const titles = attrs.titles || {};
      const name = titles.en || titles.en_jp || attrs.canonicalTitle || 'Unknown';
      const year = attrs.startDate ? parseInt(attrs.startDate.split('-')[0], 10) : null;
      
      // Multi-source ID resolution
      let malId = null;
      let imdbId = null;
      let anidbId = null;
      let tvdbSeason = null;
      let tvdbPart = null;
      let mediaType = null;
      let matchSource = null;
      let fribbEntry = null;
      
      // Priority 1: Try Otaku-Mappings by Kitsu ID
      let otakuEntry = otakuData ? getOtakuMapping(otakuData, 'kitsu', kitsuId) : null;
      
      // Priority 2: Try Fribb by Kitsu ID
      if (!otakuEntry) {
        fribbEntry = kitsuToFull.get(kitsuId);
        
        // If not found by Kitsu, get MAL ID from Kitsu API and try again
        if (!fribbEntry) {
          const mappings = await fetchKitsuMappings(kitsuId);
          malId = mappings.mal_id;
          
          if (malId) {
            // Try Otaku-Mappings by MAL ID
            otakuEntry = otakuData ? getOtakuMapping(otakuData, 'mal', malId) : null;
            
            // Fallback to Fribb by MAL ID
            if (!otakuEntry && malToFull.has(malId)) {
              fribbEntry = malToFull.get(malId);
            }
          }
        }
      }
      
      // Extract IDs from whichever source we found
      if (otakuEntry) {
        malId = otakuEntry.mal || malId;
        imdbId = otakuEntry.imdb || null;
        anidbId = otakuEntry.adb || null;
        tvdbSeason = otakuEntry.tvdbS != null ? otakuEntry.tvdbS : null;
        tvdbPart = otakuEntry.tvdbP != null ? otakuEntry.tvdbP : null;
        mediaType = otakuEntry.type || null;
        matchSource = 'otaku';
        fromOtaku++;
      } else if (fribbEntry) {
        malId = fribbEntry.mal_id || malId;
        imdbId = fribbEntry.imdb_id || null;
        anidbId = fribbEntry.anidb_id || null;
        matchSource = 'fribb';
        fromFribb++;
      }
      
      // Priority 3: IMDB title matching as last resort
      if (!imdbId && searchIndex) {
        const match = findImdbMatch(name, year, searchIndex);
        if (match) {
          imdbId = match.imdbId;
          matchSource = `imdb_${match.reason}`;
          fromImdbMatch++;
        }
      }
      
      // Get synonyms from anime-offline-database
      let synonyms = null;
      if (malId && malToSynonyms.has(malId)) {
        synonyms = malToSynonyms.get(malId);
      } else if (kitsuToSynonyms.has(kitsuId)) {
        synonyms = kitsuToSynonyms.get(kitsuId);
      }
      
      // Track stats and create entry if we have IMDB
      if (imdbId) {
        if (anidbId) withAnidb++;
        if (synonyms && synonyms.length > 0) withSynonyms++;
        if (tvdbSeason != null) withTvdbSeason++;
        
        // Create enriched Fribb-like entry for convertToStremioMeta
        const enrichedEntry = {
          imdb_id: imdbId,
          mal_id: malId,
          anidb_id: anidbId,
          anilist_id: otakuEntry?.al || fribbEntry?.anilist_id || null,
          tvdb_season: tvdbSeason,
          tvdb_part: tvdbPart,
          media_type: mediaType,
        };
        
        const meta = convertToStremioMeta(anime, enrichedEntry, malId, synonyms);
        meta._matchSource = matchSource;
        processedAnime.push(meta);
      } else {
        noMatch++;
      }
    }));
    
    const processed = Math.min(i + batchSize, kitsuAnime.length);
    process.stdout.write(`\\r   ${progressBar(processed, kitsuAnime.length)} - Otaku: ${fromOtaku}, Fribb: ${fromFribb}, IMDB: ${fromImdbMatch}`);
    
    await sleep(CONFIG.requestDelay);
  }
  
  console.log(`\\n\\n   📊 Multi-Source Mapping Results:`);
  console.log(`      From Otaku-Mappings: ${fromOtaku} (primary)`);
  console.log(`      From Fribb: ${fromFribb} (fallback)`);
  console.log(`      From IMDB title match: ${fromImdbMatch} (last resort)`);
  console.log(`      No IMDB found: ${noMatch}`);
  console.log(`   📊 Enhanced ID Coverage:`);
  console.log(`      With AniDB ID: ${withAnidb} (for AnimeTosho)`);
  console.log(`      With TVDB Season: ${withTvdbSeason} (for multi-season offset)`);
  console.log(`      With synonyms: ${withSynonyms}\\n`);
  
  // Step 7: Group by IMDB ID
  const groupedAnime = groupByImdbId(processedAnime);
  
  // Step 8: Sort by popularity
  groupedAnime.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  
  // Step 9: Cinemeta enrichment
  const cinemataStats = await enrichWithCinemeta(groupedAnime);
  
  // Step 10: Jikan broadcast enrichment
  const jikanStats = await enrichWithJikanBroadcast(groupedAnime);
  
  // Step 11: Separate movies from series
  console.log('🎬 Separating movies from series...');
  const series = groupedAnime.filter(a => a.subtype !== 'movie');
  const movies = groupedAnime.filter(a => a.subtype === 'movie');
  console.log(`   ✅ Series: ${series.length}, Movies: ${movies.length}\\n`);
  
  // Step 12: Build ID mappings cache (with Otaku-Mappings TVDB season info)
  const idMappings = buildIdMappingsCache(groupedAnime, otakuData);
  
  // Step 13: Build filter options
  console.log('📋 Building filter options...');
  const genreCounts = new Map();
  const yearCounts = new Map();
  const statusCounts = new Map();
  const seasonCounts = new Map();
  const weekdayCounts = new Map();
  
  for (const anime of series) {
    if (anime.genres && anime.genres.length > 0) {
      for (const genre of anime.genres) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    }
    if (anime.year) {
      yearCounts.set(anime.year, (yearCounts.get(anime.year) || 0) + 1);
    }
    if (anime.status) {
      statusCounts.set(anime.status, (statusCounts.get(anime.status) || 0) + 1);
    }
    if (anime.year && anime.season) {
      const seasonName = anime.season.charAt(0).toUpperCase() + anime.season.slice(1).toLowerCase();
      const seasonKey = `${anime.year} - ${seasonName}`;
      seasonCounts.set(seasonKey, (seasonCounts.get(seasonKey) || 0) + 1);
    }
    if (anime.status === 'ONGOING' && anime.broadcastDay) {
      const day = anime.broadcastDay.charAt(0).toUpperCase() + anime.broadcastDay.slice(1).toLowerCase();
      weekdayCounts.set(day, (weekdayCounts.get(day) || 0) + 1);
    }
  }
  
  // Movie-specific stats
  const currentYear = new Date().getFullYear();
  const upcomingMovies = movies.filter(a => a.status !== 'FINISHED');
  const newReleaseMovies = movies.filter(a => a.year >= currentYear - 1 && a.status === 'FINISHED');
  
  const movieGenreCounts = new Map();
  for (const movie of movies) {
    if (movie.genres && movie.genres.length > 0) {
      for (const genre of movie.genres) {
        movieGenreCounts.set(genre, (movieGenreCounts.get(genre) || 0) + 1);
      }
    }
  }
  
  const filterOptions = {
    genres: {
      withCounts: [...genreCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} (${count})`),
      list: [...genreCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }))
    },
    seasons: {
      withCounts: [...seasonCounts.entries()]
        .sort((a, b) => {
          const [aYear, aSeason] = a[0].split(' - ');
          const [bYear, bSeason] = b[0].split(' - ');
          if (aYear !== bYear) return parseInt(bYear) - parseInt(aYear);
          const seasonOrder = { Winter: 0, Spring: 1, Summer: 2, Fall: 3 };
          return seasonOrder[bSeason] - seasonOrder[aSeason];
        })
        .map(([name, count]) => `${name} (${count})`),
      list: [...seasonCounts.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([name, count]) => ({ name, count }))
    },
    weekdays: {
      withCounts: [...weekdayCounts.entries()]
        .sort((a, b) => {
          const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
          return dayOrder.indexOf(a[0]) - dayOrder.indexOf(b[0]);
        })
        .map(([name, count]) => `${name} (${count})`),
      list: [...weekdayCounts.entries()]
        .map(([name, count]) => ({ name, count }))
    },
    years: [...yearCounts.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, count]) => ({ name: year.toString(), count })),
    statuses: [...statusCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    movieSpecialFilters: {
      upcoming: upcomingMovies.length,
      newReleases: newReleaseMovies.length
    },
    movieGenres: {
      withCounts: [...movieGenreCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} (${count})`),
      list: [...movieGenreCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }))
    }
  };
  
  console.log(`   ✅ ${filterOptions.genres.list.length} genres, ${filterOptions.seasons.list.length} seasons\n`);
  
  // Step 13: Write output files
  console.log('💾 Writing output files...');
  
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  // Main catalog (all anime)
  const catalog = {
    buildDate: new Date().toISOString(),
    version: '6.0',
    source: 'kitsu+otaku-mappings+fribb+imdb+cinemeta+anime-offline-db',
    stats: {
      totalAnime: groupedAnime.length,
      series: series.length,
      movies: movies.length,
      fromOtaku: fromOtaku,
      fromFribb: fromFribb,
      fromImdbMatch: fromImdbMatch,
      noMatch: noMatch,
      withAnidb: withAnidb,
      withTvdbSeason: withTvdbSeason,
      withSynonyms: withSynonyms,
      cinemeta: cinemataStats,
    },
    catalog: groupedAnime
  };
  
  const jsonPath = path.join(CONFIG.outputDir, CONFIG.catalogFile);
  const jsonContent = JSON.stringify(catalog, null, 2);
  fs.writeFileSync(jsonPath, jsonContent);
  console.log(`   📄 ${CONFIG.catalogFile}: ${formatSize(jsonContent.length)}`);
  
  // Series-only catalog
  const seriesCatalog = {
    buildDate: catalog.buildDate,
    version: '6.1',
    totalCount: series.length,
    catalog: series
  };
  const seriesPath = path.join(CONFIG.outputDir, CONFIG.catalogSeriesFile);
  fs.writeFileSync(seriesPath, JSON.stringify(seriesCatalog, null, 2));
  console.log(`   📄 ${CONFIG.catalogSeriesFile}: ${formatSize(fs.statSync(seriesPath).size)}`);
  
  // Movies-only catalog
  const moviesCatalog = {
    buildDate: catalog.buildDate,
    version: '6.1',
    totalCount: movies.length,
    catalog: movies
  };
  const moviesPath = path.join(CONFIG.outputDir, CONFIG.catalogMoviesFile);
  fs.writeFileSync(moviesPath, JSON.stringify(moviesCatalog, null, 2));
  console.log(`   📄 ${CONFIG.catalogMoviesFile}: ${formatSize(fs.statSync(moviesPath).size)}`);
  
  // ID mappings cache (for runtime torrent lookups - now with TVDB season info!)
  const mappingsPath = path.join(CONFIG.outputDir, CONFIG.idMappingsFile);
  const mappingsContent = JSON.stringify(idMappings);
  fs.writeFileSync(mappingsPath, mappingsContent);
  console.log(`   📄 ${CONFIG.idMappingsFile}: ${formatSize(mappingsContent.length)}`);
  
  // Filter options
  const filterPath = path.join(CONFIG.outputDir, CONFIG.filterOptionsFile);
  fs.writeFileSync(filterPath, JSON.stringify(filterOptions, null, 2));
  console.log(`   📋 ${CONFIG.filterOptionsFile}: ${formatSize(fs.statSync(filterPath).size)}`);
  
  // Summary
  const duration = Date.now() - startTime;
  console.log('\\n============================================================');
  console.log(`✅ Database build v6.1 complete in ${formatDuration(duration)}`);
  console.log('============================================================');
  console.log(`   Total anime: ${groupedAnime.length}`);
  console.log(`   Series: ${series.length}`);
  console.log(`   Movies: ${movies.length}`);
  console.log('------------------------------------------------------------');
  console.log(`   📊 ID Source Breakdown:`);
  console.log(`      From Otaku-Mappings: ${fromOtaku} (primary)`);
  console.log(`      From Fribb: ${fromFribb} (fallback)`);
  console.log(`      From IMDB title match: ${fromImdbMatch}`);
  console.log('------------------------------------------------------------');
  console.log(`   📊 Torrent Search Coverage:`);
  console.log(`      With AniDB (AnimeTosho ID): ${withAnidb}`);
  console.log(`      With TVDB Season (multi-season offset): ${withTvdbSeason}`);
  console.log(`      With synonyms (title matching): ${withSynonyms}`);
  console.log('------------------------------------------------------------');
  console.log(`   🎨 Cinemeta enrichment:`);
  console.log(`      Logos: ${cinemataStats.logos}`);
  console.log(`      Backgrounds: ${cinemataStats.backgrounds}`);
  console.log(`      Cast info: ${cinemataStats.cast}`);
  console.log('============================================================\\n');
}

// Run
buildDatabase().catch(err => {
  console.error('\n❌ Build failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
