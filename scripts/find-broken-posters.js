#!/usr/bin/env node

/**
 * Script to find anime with broken/missing/incomplete metadata in the currently airing catalog.
 * 
 * Usage: node scripts/find-broken-posters.js
 * 
 * This will check:
 * - Poster URLs (broken/404)
 * - Missing/short descriptions
 * - Missing runtime
 * - Missing rating
 * - Missing background/cover art
 * - Missing genres
 * - Missing episodes
 * - Missing cast
 */

const WORKER_URL = 'https://animestream-addon.keypop3750.workers.dev';
const CATALOG_ID = 'anime-airing';

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
  
  // Poster
  if (!anime.poster) {
    issues.push('missing_poster');
  }
  
  // Description
  if (!anime.description) {
    issues.push('missing_description');
  } else if (anime.description.length < 50) {
    issues.push('short_description');
  }
  
  // Runtime
  if (!anime.runtime) {
    issues.push('missing_runtime');
  }
  
  // Rating
  if (!anime.rating && !anime.imdbRating) {
    issues.push('missing_rating');
  }
  
  // Background/cover art
  if (!anime.background) {
    issues.push('missing_background');
  }
  
  // Genres
  if (!anime.genres || anime.genres.length === 0) {
    issues.push('missing_genres');
  }
  
  // Episodes
  if (!anime.videos || anime.videos.length === 0) {
    issues.push('missing_episodes');
  }
  
  // Cast
  if (!anime.cast || anime.cast.length === 0) {
    issues.push('missing_cast');
  }
  
  return issues;
}

async function fetchCinemetaMeta(imdbId) {
  try {
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.meta || null;
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('🔍 Scanning currently airing catalog for incomplete metadata...\n');
  
  // Fetch the catalog
  const catalogUrl = `${WORKER_URL}/catalog/anime/${CATALOG_ID}.json`;
  console.log(`Fetching: ${catalogUrl}\n`);
  
  const response = await fetch(catalogUrl);
  const data = await response.json();
  
  if (!data.metas || data.metas.length === 0) {
    console.log('No anime found in catalog.');
    return;
  }
  
  console.log(`Found ${data.metas.length} anime in currently airing catalog.\n`);
  console.log('Analyzing metadata (this may take a moment)...\n');
  
  const incompleteAnime = [];
  let checked = 0;
  
  // Check metadata in parallel batches of 10
  const batchSize = 10;
  for (let i = 0; i < data.metas.length; i += batchSize) {
    const batch = data.metas.slice(i, i + batchSize);
    
    const results = await Promise.all(batch.map(async (anime) => {
      const issues = analyzeMetadata(anime);
      
      // Check poster URL if it exists
      let posterStatus = null;
      if (anime.poster) {
        posterStatus = await checkPosterUrl(anime.poster);
        if (posterStatus.status !== 'ok') {
          if (!issues.includes('missing_poster')) {
            issues.push('broken_poster');
          }
        }
      }
      
      return { anime, issues, posterStatus };
    }));
    
    for (const { anime, issues, posterStatus } of results) {
      checked++;
      
      if (issues.length > 0) {
        incompleteAnime.push({ anime, issues, posterStatus });
      }
    }
    
    // Progress indicator
    process.stdout.write(`\rChecked ${checked}/${data.metas.length}...`);
  }
  
  console.log('\n');
  
  // Sort by number of issues (most problematic first)
  incompleteAnime.sort((a, b) => b.issues.length - a.issues.length);
  
  // Report results
  console.log('='.repeat(80));
  console.log('RESULTS');
  console.log('='.repeat(80));
  
  if (incompleteAnime.length === 0) {
    console.log('\n✅ All anime have complete metadata!\n');
    return;
  }
  
  console.log(`\n⚠️  Found ${incompleteAnime.length} anime with incomplete metadata:\n`);
  
  // Group by issue severity
  const critical = incompleteAnime.filter(a => a.issues.includes('broken_poster') || a.issues.includes('missing_poster'));
  const moderate = incompleteAnime.filter(a => a.issues.length >= 4 && !critical.includes(a));
  const minor = incompleteAnime.filter(a => !critical.includes(a) && !moderate.includes(a));
  
  if (critical.length > 0) {
    console.log(`\n🔴 CRITICAL - Broken/Missing Posters (${critical.length}):\n`);
    for (const { anime, issues } of critical) {
      console.log(`  ${anime.name} (${anime.id})`);
      console.log(`    Issues: ${issues.join(', ')}`);
      console.log('');
    }
  }
  
  if (moderate.length > 0) {
    console.log(`\n🟡 MODERATE - Multiple Missing Fields (${moderate.length}):\n`);
    for (const { anime, issues } of moderate) {
      console.log(`  ${anime.name} (${anime.id})`);
      console.log(`    Issues: ${issues.join(', ')}`);
      console.log('');
    }
  }
  
  if (minor.length > 0) {
    console.log(`\n🟢 MINOR - Few Missing Fields (${minor.length}):\n`);
    for (const { anime, issues } of minor) {
      console.log(`  ${anime.name} (${anime.id})`);
      console.log(`    Issues: ${issues.join(', ')}`);
      console.log('');
    }
  }
  
  // Fetch enrichment data for top 10 most problematic
  console.log('='.repeat(80));
  console.log('ENRICHMENT SUGGESTIONS (Top 10 Most Problematic):');
  console.log('='.repeat(80));
  console.log('\nFetching enrichment data from Cinemeta and Kitsu...\n');
  
  const top10 = incompleteAnime.slice(0, 10);
  
  for (const { anime, issues } of top10) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`${anime.name} (${anime.id})`);
    console.log(`Issues: ${issues.join(', ')}`);
    console.log('-'.repeat(80));
    
    // Fetch Cinemeta
    let cinemeta = null;
    if (anime.id.startsWith('tt')) {
      cinemeta = await fetchCinemetaMeta(anime.id);
    }
    
    // Fetch Kitsu
    let kitsu = null;
    try {
      const searchName = anime.name.replace(/\s*\(TV\)$/i, '').trim();
      const kitsuRes = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchName)}&include=genres,categories`);
      const kitsuData = await kitsuRes.json();
      if (kitsuData.data && kitsuData.data.length > 0) {
        kitsu = kitsuData.data[0].attributes;
      }
    } catch (e) {}
    
    // Show current values vs available enrichment
    console.log('\nCURRENT DATA:');
    console.log(`  Poster: ${anime.poster ? anime.poster.substring(0, 60) + '...' : 'MISSING'}`);
    console.log(`  Description: ${anime.description ? (anime.description.substring(0, 80) + '...') : 'MISSING'}`);
    console.log(`  Runtime: ${anime.runtime || 'MISSING'}`);
    console.log(`  Rating: ${anime.rating || anime.imdbRating || 'MISSING'}`);
    console.log(`  Background: ${anime.background ? 'YES' : 'MISSING'}`);
    console.log(`  Genres: ${anime.genres?.length || 0} genres`);
    console.log(`  Episodes: ${anime.videos?.length || 0} episodes`);
    console.log(`  Cast: ${anime.cast?.length || 0} members`);
    
    console.log('\nAVAILABLE FROM CINEMETA:');
    if (cinemeta) {
      console.log(`  Poster: ${cinemeta.poster ? 'YES' : 'NO'}`);
      console.log(`  Description: ${cinemeta.description ? (cinemeta.description.substring(0, 80) + '...') : 'NO'}`);
      console.log(`  Runtime: ${cinemeta.runtime || 'NO'}`);
      console.log(`  Rating: ${cinemeta.imdbRating || 'NO'}`);
      console.log(`  Background: ${cinemeta.background ? 'YES' : 'NO'}`);
      console.log(`  Genres: ${cinemeta.genres?.length || 0} genres`);
      console.log(`  Episodes: ${cinemeta.videos?.length || 0} episodes`);
      console.log(`  Cast: ${cinemeta.cast?.length || 0} members`);
      console.log(`  Director: ${cinemeta.director?.join(', ') || 'NO'}`);
    } else {
      console.log('  Not available (not found on Cinemeta)');
    }
    
    console.log('\nAVAILABLE FROM KITSU:');
    if (kitsu) {
      console.log(`  Poster: ${kitsu.posterImage?.large || 'NO'}`);
      console.log(`  Description: ${kitsu.description ? (kitsu.description.substring(0, 80).replace(/\n/g, ' ') + '...') : 'NO'}`);
      console.log(`  Average Rating: ${kitsu.averageRating || 'NO'}`);
      console.log(`  Cover Image: ${kitsu.coverImage?.large || 'NO'}`);
      console.log(`  Episode Count: ${kitsu.episodeCount || 'NO'}`);
      console.log(`  Episode Length: ${kitsu.episodeLength ? kitsu.episodeLength + ' min' : 'NO'}`);
      console.log(`  Status: ${kitsu.status || 'NO'}`);
      console.log(`  Age Rating: ${kitsu.ageRating || 'NO'}`);
    } else {
      console.log('  Not found on Kitsu');
    }
    
    // Generate code suggestions
    if (issues.includes('broken_poster') || issues.includes('missing_poster')) {
      if (kitsu?.posterImage?.large) {
        const posterCheck = await checkPosterUrl(kitsu.posterImage.large);
        if (posterCheck.status === 'ok') {
          console.log('\n✅ POSTER OVERRIDE:');
          console.log(`  '${anime.id}': '${kitsu.posterImage.large}',`);
        }
      }
    }
  }
  
  console.log('\n');
  console.log('='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total anime checked: ${data.metas.length}`);
  console.log(`Anime with issues: ${incompleteAnime.length}`);
  console.log(`  - Critical (broken/missing poster): ${critical.length}`);
  console.log(`  - Moderate (4+ issues): ${moderate.length}`);
  console.log(`  - Minor (<4 issues): ${minor.length}`);
  console.log('');
}

main().catch(console.error);
