/**
 * Updated local test script for AllAnime Scraper
 * 
 * Run with: node test-local.js
 * 
 * This tests the scraper logic with proper XOR decryption
 */

const ALLANIME_API = 'https://api.allanime.day/api';
const ALLANIME_BASE = 'https://allanime.to';

// Build headers that mimic a real browser
function buildBrowserHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': ALLANIME_BASE,
    'Referer': ALLANIME_BASE,
  };
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

// Extract quality from source name
function detectQuality(sourceName, url) {
  const text = `${sourceName} ${url}`.toLowerCase();
  if (/2160p|4k|uhd/i.test(text)) return '4K';
  if (/1080p|fhd|fullhd/i.test(text)) return '1080p';
  if (/720p|hd/i.test(text)) return '720p';
  if (/480p|sd/i.test(text)) return '480p';
  return 'HD';
}

/**
 * Search for anime
 */
async function searchAnime(searchQuery, limit = 10) {
  console.log(`\n🔍 Searching for: "${searchQuery}"...\n`);

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
          episodeCount
          genres
        }
      }
    }
  `;

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
        countryOrigin: 'JP',
      },
    }),
  });

  if (!response.ok) {
    console.error(`❌ API Error: ${response.status}`);
    return [];
  }

  const data = await response.json();
  const shows = data?.data?.shows?.edges || [];

  console.log(`✅ Found ${shows.length} results:\n`);
  
  shows.forEach((show, i) => {
    console.log(`${i + 1}. ${show.englishName || show.name}`);
    console.log(`   ID: ${show._id}`);
    console.log(`   Type: ${show.type} | Episodes: ${show.episodeCount || '?'} | Score: ${show.score || 'N/A'}`);
    console.log('');
  });

  return shows;
}

/**
 * Get show info and available episodes
 */
async function getShowInfo(showId) {
  console.log(`\n📺 Getting info for show: ${showId}...\n`);

  const query = `
    query ($showId: String!) {
      show(_id: $showId) {
        _id
        name
        englishName
        nativeName
        thumbnail
        type
        score
        status
        episodeCount
        description
        genres
        availableEpisodesDetail
      }
    }
  `;

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
    console.error(`❌ API Error: ${response.status}`);
    return null;
  }

  const data = await response.json();
  const show = data?.data?.show;

  if (!show) {
    console.error('❌ Show not found');
    return null;
  }

  console.log(`✅ ${show.englishName || show.name}`);
  console.log(`   Type: ${show.type} | Score: ${show.score || 'N/A'}`);
  console.log(`   Status: ${show.status}`);
  console.log(`   Episodes: ${show.episodeCount || '?'}`);
  
  const subEps = show.availableEpisodesDetail?.sub || [];
  const dubEps = show.availableEpisodesDetail?.dub || [];
  console.log(`\n   Available SUB episodes: ${subEps.length > 10 ? subEps.slice(0, 10).join(', ') + '...' : subEps.join(', ') || 'None'}`);
  console.log(`   Available DUB episodes: ${dubEps.length > 10 ? dubEps.slice(0, 10).join(', ') + '...' : dubEps.join(', ') || 'None'}`);

  return show;
}

/**
 * Get episode streams with proper XOR decryption
 */
async function getEpisodeStreams(showId, episode) {
  console.log(`\n🎬 Getting streams for ${showId} Episode ${episode}...\n`);

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

  const allStreams = [];

  for (const translationType of ['sub', 'dub']) {
    console.log(`   Fetching ${translationType.toUpperCase()}...`);

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

      if (!response.ok) {
        console.log(`   ⚠️  ${translationType.toUpperCase()}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const episodeData = data?.data?.episode;

      if (!episodeData?.sourceUrls) {
        console.log(`   ⚠️  ${translationType.toUpperCase()}: No sources found`);
        continue;
      }

      console.log(`   ✅ ${translationType.toUpperCase()}: ${episodeData.sourceUrls.length} raw sources`);

      let validCount = 0;
      for (const source of episodeData.sourceUrls) {
        if (!source.sourceUrl) continue;

        const decodedUrl = decryptSourceUrl(source.sourceUrl);
        
        // Skip null (internal API) or non-URL results
        if (!decodedUrl) continue;
        if (!decodedUrl.startsWith('http')) continue;

        validCount++;
        allStreams.push({
          url: decodedUrl,
          quality: detectQuality(source.sourceName, decodedUrl),
          provider: source.sourceName || 'AllAnime',
          type: translationType.toUpperCase(),
          priority: source.priority || 0,
        });
      }
      
      console.log(`      → ${validCount} valid streams`);
    } catch (e) {
      console.log(`   ❌ ${translationType.toUpperCase()}: ${e.message}`);
    }
  }

  // Sort by priority
  allStreams.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  console.log(`\n📊 Total usable streams: ${allStreams.length}\n`);

  if (allStreams.length > 0) {
    console.log('Streams:');
    allStreams.forEach((stream, i) => {
      const urlPreview = stream.url.length > 70 
        ? stream.url.substring(0, 70) + '...' 
        : stream.url;
      console.log(`   ${i + 1}. [${stream.type}] ${stream.provider} - ${stream.quality} (priority: ${stream.priority})`);
      console.log(`      ${urlPreview}`);
    });
  }

  return allStreams;
}

/**
 * Main test runner
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           AllAnime Scraper - Local Test (v2)');
  console.log('           Using XOR decryption (key: 56)');
  console.log('═══════════════════════════════════════════════════════════');

  // Test 1: Search
  const searchResults = await searchAnime('solo leveling', 5);
  
  if (searchResults.length === 0) {
    console.log('❌ Search returned no results. API might be down or blocked.');
    return;
  }

  // Test 2: Get show info for first result
  const firstShow = searchResults[0];
  const showInfo = await getShowInfo(firstShow._id);

  if (!showInfo) {
    console.log('❌ Could not get show info.');
    return;
  }

  // Test 3: Get streams for episode 1
  const subEps = showInfo.availableEpisodesDetail?.sub || [];
  if (subEps.length === 0) {
    console.log('⚠️  No episodes available for this show.');
    return;
  }

  const firstEpisode = subEps[subEps.length - 1]; // Get first episode (arrays are reversed)
  const streams = await getEpisodeStreams(firstShow._id, firstEpisode);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                    Test Complete!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\nSummary:`);
  console.log(`  - Search: ✅ ${searchResults.length} results`);
  console.log(`  - Show Info: ✅ ${showInfo.englishName || showInfo.name}`);
  console.log(`  - Streams: ${streams.length > 0 ? '✅' : '⚠️ '} ${streams.length} usable streams found`);
  
  if (streams.length > 0) {
    console.log(`\n📋 Best stream for testing:`);
    console.log(`   Provider: ${streams[0].provider}`);
    console.log(`   Type: ${streams[0].type}`);
    console.log(`   Quality: ${streams[0].quality}`);
    console.log(`   URL: ${streams[0].url}`);
  }
}

main().catch(console.error);
