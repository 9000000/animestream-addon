#!/usr/bin/env node

/**
 * Script to find anime with incomplete metadata and generate enrichment overrides.
 * 
 * Usage:
 *   node scripts/enrich-metadata.js                    # Analyze and generate override code
 *   node scripts/enrich-metadata.js --apply            # Apply overrides to worker.js
 *   node scripts/enrich-metadata.js --catalog=toprated # Use specific catalog
 *   node scripts/enrich-metadata.js --limit=20         # Check only first N anime
 *   node scripts/enrich-metadata.js --verbose          # Show detailed output
 * 
 * Data sources checked:
 * - Cinemeta (for IMDB IDs)
 * - Kitsu (anime database)
 * - MyAnimeList via Jikan API
 */

const fs = require('fs');
const path = require('path');

const WORKER_URL = 'https://animestream-addon.keypop3750.workers.dev';
const WORKER_FILE = path.join(__dirname, '..', 'cloudflare-worker', 'worker-github.js');

// Parse command line args
const args = process.argv.slice(2);
const APPLY_MODE = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const CATALOG_ARG = args.find(a => a.startsWith('--catalog='));
const LIMIT_ARG = args.find(a => a.startsWith('--limit='));
const CATALOG_ID = CATALOG_ARG ? CATALOG_ARG.split('=')[1] : 'anime-airing';
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1]) : null;

// Rate limiting for API calls
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, { ...options, timeout: 10000 });
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await delay(1000 * (i + 1));
    }
  }
}

async function checkPosterUrl(url) {
  if (!url) return { status: 'missing', error: 'No poster URL' };
  
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (response.ok) {
      return { status: 'ok', code: response.status };
    } else {
      return { status: 'broken', code: response.status };
    }
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

function analyzeMetadata(anime) {
  const issues = [];
  const missing = {};
  
  // Poster
  if (!anime.poster) {
    issues.push('missing_poster');
    missing.poster = true;
  }
  
  // Description
  if (!anime.description) {
    issues.push('missing_description');
    missing.description = true;
  } else if (anime.description.length < 50) {
    issues.push('short_description');
    missing.description = true;
  }
  
  // Runtime
  if (!anime.runtime) {
    issues.push('missing_runtime');
    missing.runtime = true;
  }
  
  // Rating
  if (!anime.rating && !anime.imdbRating) {
    issues.push('missing_rating');
    missing.rating = true;
  }
  
  // Background/cover art
  if (!anime.background) {
    issues.push('missing_background');
    missing.background = true;
  }
  
  // Genres
  if (!anime.genres || anime.genres.length === 0) {
    issues.push('missing_genres');
    missing.genres = true;
  }
  
  // Cast
  if (!anime.cast || anime.cast.length === 0) {
    issues.push('missing_cast');
    missing.cast = true;
  }
  
  return { issues, missing };
}

// ========== Data Source Fetchers ==========

async function fetchCinemeta(imdbId) {
  try {
    const response = await fetchWithRetry(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.meta || null;
  } catch (e) {
    if (VERBOSE) console.log(`  Cinemeta error: ${e.message}`);
    return null;
  }
}

async function fetchKitsu(animeName) {
  try {
    const searchName = animeName.replace(/\s*\(TV\)$/i, '').replace(/\s*Season\s*\d+$/i, '').trim();
    const response = await fetchWithRetry(
      `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchName)}&include=genres,categories`
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (data.data && data.data.length > 0) {
      const attrs = data.data[0].attributes;
      // Extract genres from included
      let genres = [];
      if (data.included) {
        genres = data.included
          .filter(inc => inc.type === 'genres' || inc.type === 'categories')
          .map(inc => inc.attributes.name || inc.attributes.title)
          .filter(Boolean);
      }
      return { ...attrs, extractedGenres: genres };
    }
    return null;
  } catch (e) {
    if (VERBOSE) console.log(`  Kitsu error: ${e.message}`);
    return null;
  }
}

async function fetchMAL(animeName) {
  try {
    // Search for anime on MAL via Jikan API
    const searchName = animeName.replace(/\s*\(TV\)$/i, '').replace(/\s*Season\s*\d+$/i, '').trim();
    const response = await fetchWithRetry(
      `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(searchName)}&limit=3`
    );
    if (!response.ok) return null;
    const data = await response.json();
    
    if (data.data && data.data.length > 0) {
      // Find best match by title similarity
      const normalizedSearch = searchName.toLowerCase().replace(/[^a-z0-9]/g, '');
      let bestMatch = data.data[0];
      let bestScore = 0;
      
      for (const anime of data.data) {
        const titles = [
          anime.title,
          anime.title_english,
          anime.title_japanese,
          ...(anime.title_synonyms || [])
        ].filter(Boolean);
        
        for (const title of titles) {
          const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (normalizedTitle === normalizedSearch) {
            bestMatch = anime;
            bestScore = 100;
            break;
          }
          // Simple similarity check
          if (normalizedTitle.includes(normalizedSearch) || normalizedSearch.includes(normalizedTitle)) {
            const score = Math.min(normalizedSearch.length, normalizedTitle.length) / 
                         Math.max(normalizedSearch.length, normalizedTitle.length) * 80;
            if (score > bestScore) {
              bestMatch = anime;
              bestScore = score;
            }
          }
        }
        if (bestScore === 100) break;
      }
      
      return {
        mal_id: bestMatch.mal_id,
        title: bestMatch.title,
        title_english: bestMatch.title_english,
        synopsis: bestMatch.synopsis,
        score: bestMatch.score,
        episodes: bestMatch.episodes,
        duration: bestMatch.duration,
        rating: bestMatch.rating,
        genres: bestMatch.genres?.map(g => g.name) || [],
        themes: bestMatch.themes?.map(t => t.name) || [],
        demographics: bestMatch.demographics?.map(d => d.name) || [],
        poster: bestMatch.images?.jpg?.large_image_url,
        background: bestMatch.images?.jpg?.large_image_url, // MAL uses same image
        status: bestMatch.status,
        aired: bestMatch.aired,
        matchScore: bestScore
      };
    }
    return null;
  } catch (e) {
    if (VERBOSE) console.log(`  MAL/Jikan error: ${e.message}`);
    return null;
  }
}

async function fetchMALCharacters(malId) {
  try {
    await delay(400); // Rate limit for Jikan (3 requests/sec)
    const response = await fetchWithRetry(`https://api.jikan.moe/v4/anime/${malId}/characters`);
    if (!response.ok) return [];
    const data = await response.json();
    
    if (data.data && data.data.length > 0) {
      // Get voice actors for main characters
      const cast = [];
      for (const char of data.data.slice(0, 10)) {
        if (char.role === 'Main' || char.role === 'Supporting') {
          const jaVA = char.voice_actors?.find(va => va.language === 'Japanese');
          if (jaVA) {
            cast.push(jaVA.person.name);
          }
        }
        if (cast.length >= 5) break;
      }
      return cast;
    }
    return [];
  } catch (e) {
    if (VERBOSE) console.log(`  MAL characters error: ${e.message}`);
    return [];
  }
}

// ========== Enrichment Logic ==========

async function enrichAnime(anime, missing) {
  const enrichment = {
    poster: null,
    metadata: {}
  };
  
  const id = anime.id;
  const name = anime.name;
  
  if (VERBOSE) console.log(`\n  Enriching ${name}...`);
  
  // Fetch from all sources in parallel (except MAL which needs rate limiting)
  const [cinemeta, kitsu] = await Promise.all([
    anime.id.startsWith('tt') ? fetchCinemeta(anime.id) : Promise.resolve(null),
    fetchKitsu(name)
  ]);
  
  // MAL needs rate limiting
  await delay(400);
  const mal = await fetchMAL(name);
  
  // Get MAL cast if we need it and found a match
  let malCast = [];
  if (missing.cast && mal?.mal_id) {
    malCast = await fetchMALCharacters(mal.mal_id);
  }
  
  if (VERBOSE) {
    console.log(`    Cinemeta: ${cinemeta ? 'found' : 'not found'}`);
    console.log(`    Kitsu: ${kitsu ? 'found' : 'not found'}`);
    console.log(`    MAL: ${mal ? `found (${mal.title}, score=${mal.matchScore})` : 'not found'}`);
  }
  
  // Priority: Kitsu poster > MAL poster (for poster overrides - Kitsu is higher quality)
  if (missing.poster) {
    if (kitsu?.posterImage?.large) {
      const check = await checkPosterUrl(kitsu.posterImage.large);
      if (check.status === 'ok') {
        enrichment.poster = kitsu.posterImage.large;
      }
    }
    if (!enrichment.poster && mal?.poster) {
      const check = await checkPosterUrl(mal.poster);
      if (check.status === 'ok') {
        enrichment.poster = mal.poster;
      }
    }
  }
  
  // Runtime: MAL > Kitsu
  if (missing.runtime) {
    if (mal?.duration) {
      // Parse "24 min per ep" -> "24 min"
      const match = mal.duration.match(/(\d+)\s*min/i);
      if (match) {
        enrichment.metadata.runtime = `${match[1]} min`;
      }
    } else if (kitsu?.episodeLength) {
      enrichment.metadata.runtime = `${kitsu.episodeLength} min`;
    }
  }
  
  // Rating: MAL > Cinemeta
  if (missing.rating) {
    if (mal?.score) {
      enrichment.metadata.rating = mal.score;
    } else if (cinemeta?.imdbRating) {
      enrichment.metadata.rating = parseFloat(cinemeta.imdbRating);
    }
  }
  
  // Genres: MAL (combines genres + themes) > Kitsu > Cinemeta
  if (missing.genres) {
    if (mal?.genres?.length > 0) {
      // Combine genres and themes from MAL
      const allGenres = [...new Set([...(mal.genres || []), ...(mal.themes || [])])];
      enrichment.metadata.genres = allGenres.slice(0, 8);
    } else if (kitsu?.extractedGenres?.length > 0) {
      enrichment.metadata.genres = kitsu.extractedGenres.slice(0, 8);
    } else if (cinemeta?.genres?.length > 0) {
      enrichment.metadata.genres = cinemeta.genres;
    }
  }
  
  // Background: Kitsu cover > MAL image > Cinemeta
  if (missing.background) {
    if (kitsu?.coverImage?.large) {
      enrichment.metadata.background = kitsu.coverImage.large;
    } else if (mal?.background) {
      enrichment.metadata.background = mal.background;
    } else if (cinemeta?.background) {
      enrichment.metadata.background = cinemeta.background;
    }
  }
  
  // Description: MAL > Cinemeta > Kitsu
  if (missing.description) {
    if (mal?.synopsis && mal.synopsis.length > 50) {
      // Clean up MAL synopsis
      let desc = mal.synopsis
        .replace(/\[Written by MAL Rewrite\]/g, '')
        .replace(/\(Source:.*?\)/g, '')
        .trim();
      enrichment.metadata.description = desc;
    } else if (cinemeta?.description && cinemeta.description.length > 50) {
      enrichment.metadata.description = cinemeta.description;
    } else if (kitsu?.description && kitsu.description.length > 50) {
      enrichment.metadata.description = kitsu.description;
    }
  }
  
  // Cast: MAL voice actors
  if (missing.cast && malCast.length > 0) {
    enrichment.metadata.cast = malCast;
  }
  
  return enrichment;
}

// ========== Code Generation ==========

function generatePosterOverrideCode(overrides) {
  if (Object.keys(overrides).length === 0) return '';
  
  let code = '// Generated poster overrides\n';
  for (const [id, url] of Object.entries(overrides)) {
    code += `  '${id}': '${url}',\n`;
  }
  return code;
}

function generateMetadataOverrideCode(overrides) {
  if (Object.keys(overrides).length === 0) return '';
  
  let code = '// Generated metadata overrides\n';
  for (const [id, meta] of Object.entries(overrides)) {
    if (Object.keys(meta).length === 0) continue;
    
    code += `  '${id}': {\n`;
    for (const [key, value] of Object.entries(meta)) {
      if (Array.isArray(value)) {
        code += `    ${key}: ${JSON.stringify(value)},\n`;
      } else if (typeof value === 'string') {
        // Escape quotes in strings
        const escaped = value.replace(/'/g, "\\'").replace(/\n/g, '\\n');
        code += `    ${key}: '${escaped}',\n`;
      } else {
        code += `    ${key}: ${value},\n`;
      }
    }
    code += `  },\n`;
  }
  return code;
}

// ========== Main ==========

async function main() {
  console.log('🔍 Anime Metadata Enrichment Script\n');
  console.log(`Catalog: ${CATALOG_ID}`);
  console.log(`Mode: ${APPLY_MODE ? 'APPLY (will modify worker.js)' : 'ANALYZE ONLY'}`);
  if (LIMIT) console.log(`Limit: ${LIMIT} anime`);
  console.log('');
  
  // Fetch the catalog
  const catalogUrl = `${WORKER_URL}/catalog/anime/${CATALOG_ID}.json`;
  console.log(`Fetching: ${catalogUrl}\n`);
  
  const response = await fetch(catalogUrl);
  const data = await response.json();
  
  if (!data.metas || data.metas.length === 0) {
    console.log('No anime found in catalog.');
    return;
  }
  
  let animeList = data.metas;
  if (LIMIT) {
    animeList = animeList.slice(0, LIMIT);
  }
  
  console.log(`Analyzing ${animeList.length} anime...\n`);
  
  // Analyze all anime for issues
  const incompleteAnime = [];
  
  for (const anime of animeList) {
    const { issues, missing } = analyzeMetadata(anime);
    
    // Check poster URL if it exists
    if (anime.poster) {
      const posterStatus = await checkPosterUrl(anime.poster);
      if (posterStatus.status !== 'ok') {
        if (!issues.includes('missing_poster')) {
          issues.push('broken_poster');
        }
        missing.poster = true;
      }
    }
    
    if (issues.length > 0) {
      incompleteAnime.push({ anime, issues, missing });
    }
  }
  
  console.log(`Found ${incompleteAnime.length} anime with incomplete metadata.\n`);
  
  if (incompleteAnime.length === 0) {
    console.log('✅ All anime have complete metadata!\n');
    return;
  }
  
  // Sort by number of issues
  incompleteAnime.sort((a, b) => b.issues.length - a.issues.length);
  
  // Enrich each anime
  console.log('Fetching enrichment data from Cinemeta, Kitsu, and MyAnimeList...\n');
  console.log('(This may take a while due to rate limiting)\n');
  
  const posterOverrides = {};
  const metadataOverrides = {};
  let enriched = 0;
  
  for (const { anime, issues, missing } of incompleteAnime) {
    process.stdout.write(`\rProcessing ${enriched + 1}/${incompleteAnime.length}: ${anime.name.substring(0, 40)}...`);
    
    const enrichment = await enrichAnime(anime, missing);
    
    if (enrichment.poster) {
      posterOverrides[anime.id] = enrichment.poster;
    }
    
    if (Object.keys(enrichment.metadata).length > 0) {
      metadataOverrides[anime.id] = enrichment.metadata;
    }
    
    enriched++;
    
    // Rate limiting between anime
    await delay(500);
  }
  
  console.log('\n\n');
  
  // Report results
  console.log('='.repeat(80));
  console.log('ENRICHMENT RESULTS');
  console.log('='.repeat(80));
  
  const posterCount = Object.keys(posterOverrides).length;
  const metaCount = Object.keys(metadataOverrides).length;
  
  console.log(`\n✅ Found enrichment data for:`);
  console.log(`   - ${posterCount} poster overrides`);
  console.log(`   - ${metaCount} metadata overrides\n`);
  
  // Show what we found
  if (posterCount > 0) {
    console.log('\n📸 POSTER OVERRIDES:\n');
    for (const [id, url] of Object.entries(posterOverrides)) {
      const anime = incompleteAnime.find(a => a.anime.id === id)?.anime;
      console.log(`  ${anime?.name || id}`);
      console.log(`    ${url}\n`);
    }
  }
  
  if (metaCount > 0) {
    console.log('\n📝 METADATA OVERRIDES:\n');
    for (const [id, meta] of Object.entries(metadataOverrides)) {
      const anime = incompleteAnime.find(a => a.anime.id === id)?.anime;
      console.log(`  ${anime?.name || id} (${id}):`);
      for (const [key, value] of Object.entries(meta)) {
        if (Array.isArray(value)) {
          console.log(`    ${key}: [${value.join(', ')}]`);
        } else if (typeof value === 'string' && value.length > 60) {
          console.log(`    ${key}: ${value.substring(0, 60)}...`);
        } else {
          console.log(`    ${key}: ${value}`);
        }
      }
      console.log('');
    }
  }
  
  // Generate code
  console.log('\n' + '='.repeat(80));
  console.log('GENERATED CODE');
  console.log('='.repeat(80));
  
  if (posterCount > 0) {
    console.log('\n// Add to POSTER_OVERRIDES in worker-github.js:\n');
    console.log(generatePosterOverrideCode(posterOverrides));
  }
  
  if (metaCount > 0) {
    console.log('\n// Add to METADATA_OVERRIDES in worker-github.js:\n');
    console.log(generateMetadataOverrideCode(metadataOverrides));
  }
  
  // Apply mode
  if (APPLY_MODE && (posterCount > 0 || metaCount > 0)) {
    console.log('\n' + '='.repeat(80));
    console.log('APPLYING CHANGES');
    console.log('='.repeat(80));
    
    try {
      let workerCode = fs.readFileSync(WORKER_FILE, 'utf-8');
      let changes = 0;
      
      // Find and update POSTER_OVERRIDES
      if (posterCount > 0) {
        const posterRegex = /(const POSTER_OVERRIDES\s*=\s*\{)([\s\S]*?)(\};)/;
        const posterMatch = workerCode.match(posterRegex);
        
        if (posterMatch) {
          let existingPosters = posterMatch[2];
          let newPosters = '';
          
          for (const [id, url] of Object.entries(posterOverrides)) {
            // Check if this ID already exists
            if (!existingPosters.includes(`'${id}'`)) {
              newPosters += `  '${id}': '${url}', // Auto-generated\n`;
              changes++;
            }
          }
          
          if (newPosters) {
            // Ensure existing content ends with a comma before adding new entries
            let trimmedPosters = existingPosters.trimEnd();
            // Check if it ends with a URL string or closing quote without a comma
            if (trimmedPosters.match(/'[^']+'\s*$/) && !trimmedPosters.endsWith(',')) {
              trimmedPosters += ',';
            }
            // Add new posters
            const updatedPosters = trimmedPosters + '\n' + newPosters;
            workerCode = workerCode.replace(posterRegex, `$1${updatedPosters}$3`);
            console.log(`\n✅ Added ${changes} new poster overrides`);
          }
        }
      }
      
      // Find and update METADATA_OVERRIDES
      if (metaCount > 0) {
        const metaRegex = /(const METADATA_OVERRIDES\s*=\s*\{)([\s\S]*?)(\n\};)/;
        const metaMatch = workerCode.match(metaRegex);
        
        if (metaMatch) {
          let existingMeta = metaMatch[2];
          let newMeta = '';
          let metaChanges = 0;
          
          for (const [id, meta] of Object.entries(metadataOverrides)) {
            // Check if this ID already exists
            if (!existingMeta.includes(`'${id}'`)) {
              newMeta += `  '${id}': { // Auto-generated\n`;
              for (const [key, value] of Object.entries(meta)) {
                if (Array.isArray(value)) {
                  newMeta += `    ${key}: ${JSON.stringify(value)},\n`;
                } else if (typeof value === 'string') {
                  const escaped = value.replace(/'/g, "\\'").replace(/\n/g, '\\n');
                  newMeta += `    ${key}: '${escaped}',\n`;
                } else {
                  newMeta += `    ${key}: ${value},\n`;
                }
              }
              newMeta += `  },\n`;
              metaChanges++;
            }
          }
          
          if (newMeta) {
            // Ensure existing content ends with a comma before adding new entries
            let trimmedExisting = existingMeta.trimEnd();
            // Check if it ends with a closing brace without a comma (need to add comma)
            if (trimmedExisting.match(/\}[\s\n]*$/)) {
              // Find the last closing brace and add a comma after it
              trimmedExisting = trimmedExisting.replace(/(\})(\s*)$/, '$1,');
            }
            // Add new metadata
            const updatedMeta = trimmedExisting + '\n' + newMeta;
            workerCode = workerCode.replace(metaRegex, `$1${updatedMeta}$3`);
            console.log(`✅ Added ${metaChanges} new metadata overrides`);
            changes += metaChanges;
          }
        }
      }
      
      if (changes > 0) {
        fs.writeFileSync(WORKER_FILE, workerCode);
        console.log(`\n✅ Saved changes to ${WORKER_FILE}`);
        console.log('\n⚠️  Remember to deploy: cd cloudflare-worker && npx wrangler deploy');
      } else {
        console.log('\nNo new overrides to add (all already exist in worker.js)');
      }
      
    } catch (error) {
      console.error(`\n❌ Error applying changes: ${error.message}`);
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`\nTotal anime analyzed: ${animeList.length}`);
  console.log(`Anime with incomplete metadata: ${incompleteAnime.length}`);
  console.log(`Poster overrides found: ${posterCount}`);
  console.log(`Metadata overrides found: ${metaCount}`);
  
  // List anime that couldn't be enriched
  const notEnriched = incompleteAnime.filter(a => 
    !posterOverrides[a.anime.id] && !metadataOverrides[a.anime.id]
  );
  
  if (notEnriched.length > 0) {
    console.log(`\n⚠️  ${notEnriched.length} anime could not be enriched (no data found):`);
    for (const { anime, issues } of notEnriched.slice(0, 10)) {
      console.log(`   - ${anime.name}: ${issues.join(', ')}`);
    }
    if (notEnriched.length > 10) {
      console.log(`   ... and ${notEnriched.length - 10} more`);
    }
  }
  
  console.log('');
}

main().catch(console.error);
