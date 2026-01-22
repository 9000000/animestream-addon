#!/usr/bin/env node
/**
 * Hentai Detection Script
 * 
 * Compares AnimeStream catalog against HentaiStream catalog to find:
 * 1. Exact or similar name matches
 * 2. NSFW genre indicators
 * 3. Suspicious content that should be removed
 * 
 * Output:
 * - List of anime IDs that should be blacklisted
 * - data/hentai-blacklist.json for runtime filtering
 */

const fs = require('fs');
const path = require('path');

// Paths
const ANIMESTREAM_CATALOG = path.join(__dirname, '..', 'data', 'catalog.json');
const HENTAISTREAM_CATALOG = path.join(__dirname, '..', '..', 'hentaistream-addon', 'data', 'catalog.json');
const OUTPUT_BLACKLIST = path.join(__dirname, '..', 'data', 'hentai-blacklist.json');
const OUTPUT_REPORT = path.join(__dirname, '..', 'data', 'hentai-detection-report.txt');

// WHITELIST: Popular mainstream anime that happen to share names with hentai or have misleading matches
// These will NEVER be flagged as hentai
const WHITELIST_TITLES = new Set([
  // Popular mainstream anime with name matches
  'high school of the dead',          // Zombie action anime
  'elfen lied',                       // Horror/psychological anime
  'prison school',                    // Ecchi comedy but NOT hentai
  'orange',                           // Romance drama
  'perfect blue',                     // Satoshi Kon psychological thriller
  'ninja scroll',                     // Classic action anime
  'wicked city',                      // Classic horror anime
  'golgo 13',                         // Classic action anime
  'mirage of blaze',                  // Supernatural anime
  'call me tonight',                  // Comedy OVA
  'to love ru',                       // Ecchi comedy but NOT hentai
  'darling in the franxx',            // Mecha anime
  'samurai girls',                    // Ecchi action but NOT hentai
  'garo the animation',               // Action anime
  'level e',                          // Sci-fi comedy
  'angel sanctuary',                  // Dark fantasy anime
  'room mate',                        // Slice of life
  'treasure island',                  // Classic adventure
  'fairy tail',                       // Shonen action
  'kill la kill',                     // Action anime
  'no game no life',                  // Isekai fantasy
  'food wars',                        // Cooking anime
  'seven deadly sins',                // Fantasy action
  'gurren lagann',                    // Mecha anime
  'bakemonogatari',                   // Supernatural mystery
  'monogatari',                       // Supernatural mystery
  'infinite stratos',                 // Mecha harem
  'a certain scientific railgun',     // Sci-fi action
  'highschool dxd',                   // Ecchi but NOT hentai (softcore)
  'high school dxd',                  // Ecchi but NOT hentai (softcore)
  'the familiar of zero',             // Isekai fantasy
  'haganai',                          // Comedy
  'shakugan no shana',                // Action fantasy
  'is this a zombie',                 // Comedy
  'the fruit of grisaia',             // Visual novel adaptation
  'sekirei',                          // Ecchi action
  'testament of sister new devil',    // Ecchi action
  'maken ki',                         // Ecchi action
  'rosario vampire',                  // Ecchi comedy
  'trinity seven',                    // Ecchi fantasy
  'strike the blood',                 // Action fantasy
  'date a live',                      // Sci-fi harem
  'nisekoi',                          // Romance comedy
  'shimoneta',                        // Ecchi comedy
  'keijo',                            // Sports ecchi
  'valkyrie drive mermaid',           // Ecchi action
  'masou gakuen hxh',                 // Ecchi mecha
  'freezing',                         // Ecchi action
  'ikki tousen',                      // Ecchi action
  'queens blade',                     // Ecchi action (borderline but NOT hentai)
  // FALSE POSITIVES from keywords
  'xxxholic',                         // CLAMP anime - xxx is part of name
  'gabriel dropout',                  // Comedy anime
  'welcome to the nhk',               // Drama anime
  'the hentai prince',                // Comedy - "hentai" means pervert here
  'hentai ouji',                      // Same as above
  'aria the scarlet ammo',            // Action anime
  'hacka doll',                       // Comedy anime
  'mysterious girlfriend x',          // Ecchi romance but NOT hentai
  'mysterious girlfriend',            // Ecchi romance but NOT hentai
  'nazo no kanojo x',                 // Same as above
  'crying freeman',                   // Classic action anime
  'immortality',                      // Different from hentai "Immorality"
  'kara the animation',               // Different from hentai
  // Yaoi/BL anime - NOT hentai, just romance
  'princess princess',                // Cross-dressing comedy
  'fake',                             // Yaoi police drama
  'kizuna',                           // Yaoi drama
  'earthian',                         // Yaoi drama
  'legend of duo',                    // Vampire anime
  'kimera',                           // Horror OVA
  'zetsuai',                          // Yaoi drama
  'bronze',                           // Yaoi drama (sequel to Zetsuai)
  'gravitation',                      // Yaoi music anime
  'junjou romantica',                 // Yaoi romance
  'sekai ichi hatsukoi',              // Yaoi romance
  'loveless',                         // Supernatural yaoi
  'no money',                         // Yaoi comedy
  'papa to kiss in the dark',         // Drama
  'boku wa imouto ni koi wo suru',    // Drama
  'ikoku irokoi romantan',            // Yaoi romance
  'angels feather',                   // Yaoi fantasy
  'mirage of blaze',                  // Supernatural yaoi
  // Classic OVAs that are NOT hentai
  'crying freeman',                   // Classic action
  'ninja scroll',                     // Classic action
  'sword for truth',                  // Samurai action
  'legend of lemnear',                // Fantasy action
  'hanappe bazooka',                  // Comedy
  'kekkou kamen',                     // Ecchi parody but NOT hentai
  // More classic anime that share names
  'chimera',                          // Horror OVA (1994)
  'issunboushi',                      // Classic folktale anime
  'cage',                             // Various anime with this name
  'strange love',                     // Various meanings
]);

// NSFW genres that DEFINITELY indicate hentai content
// NOTE: "Ecchi" is NOT hentai - it's just fanservice in mainstream anime
const NSFW_GENRES = [
  'hentai',
  'erotica',
  'adult',
  'porn',
  'xxx',
  'borderline h',
  'explicit',
  'r-18',
  'r18',
  '18+',
  // Do NOT include 'ecchi' - that's fanservice, not hentai
  // Do NOT include 'nudity' - many non-hentai anime have nudity
];

// Strong NSFW keywords in titles/descriptions that indicate actual hentai
// Be VERY conservative - only use words that DEFINITELY mean hentai
const NSFW_KEYWORDS = [
  // Explicit hentai markers only
  'r-18',
  'r18',
  // Known hentai series titles (exact matches only)
  'bible black',
  'euphoria hentai',       // Be specific
  'discipline zero',
  'kuroinu kedakaki',
  'resort boin',
  'shoujo ramune',
  'itadaki seieki',
  'mankitsu happening',
  'rance 01',
  'eroge h mo game',
  'jk to orc heidan',
  'taimanin asagi',
  'aneki my sweet',
  'kanojo x kanojo x kanojo',
  'mesu kyoushi',
  'love 2 quad',
  'shikkoku no shaga',
  // Do NOT include: xxx (xxxHolic), hentai (Hentai Prince), dropout (Gabriel DropOut)
];

// Studios known for hentai
const NSFW_STUDIOS = [
  'pink pineapple',
  'milky',
  'queen bee',
  'nur',
  'studio fantasia',
  't-rex',
  'pixy',
  'suzuki mirano',
  'mary jane',
  'lune',
  'collaboration works',
  'bunnywalker',
  'animac',
  'bootleg',
  'discovery',
  'ms pictures',
  'seven',
  'selfish',
  'pashmina',
  'gold bear',
  'anik',
  'erozuki',
  'magin label',
];

// Normalize string for comparison
function normalize(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove special chars
    .replace(/\s+/g, ' ')    // Collapse whitespace
    .trim();
}

// Calculate Levenshtein distance (for fuzzy matching)
function levenshteinDistance(a, b) {
  const matrix = [];
  
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

// Calculate similarity percentage
function similarity(a, b) {
  const normA = normalize(a);
  const normB = normalize(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  
  const maxLen = Math.max(normA.length, normB.length);
  const distance = levenshteinDistance(normA, normB);
  return (maxLen - distance) / maxLen;
}

// Check if genres contain NSFW content
function hasNSFWGenres(genres) {
  if (!genres || !Array.isArray(genres)) return { found: false, matches: [] };
  
  const matches = [];
  for (const genre of genres) {
    const normalized = normalize(genre);
    for (const nsfw of NSFW_GENRES) {
      if (normalized.includes(nsfw) || nsfw.includes(normalized)) {
        matches.push(genre);
        break;
      }
    }
  }
  
  return { found: matches.length > 0, matches };
}

// Check if title/description contains NSFW keywords
function hasNSFWKeywords(text) {
  if (!text) return { found: false, matches: [] };
  
  const normalized = normalize(text);
  const matches = [];
  
  for (const keyword of NSFW_KEYWORDS) {
    if (normalized.includes(keyword)) {
      matches.push(keyword);
    }
  }
  
  return { found: matches.length > 0, matches };
}

// Check if studio is known for hentai
function isNSFWStudio(studio) {
  if (!studio) return false;
  const normalized = normalize(studio);
  return NSFW_STUDIOS.some(s => normalized.includes(s) || s.includes(normalized));
}

// Main detection function
async function detectHentai() {
  console.log('🔍 Hentai Detection Script');
  console.log('='.repeat(60));
  
  // Load catalogs
  console.log('\n📂 Loading catalogs...');
  
  let animeCatalog, hentaiCatalog;
  
  try {
    const animeData = JSON.parse(fs.readFileSync(ANIMESTREAM_CATALOG, 'utf8'));
    animeCatalog = animeData.catalog || animeData;
    console.log(`   ✅ AnimeStream: ${animeCatalog.length} entries`);
  } catch (err) {
    console.error(`   ❌ Failed to load AnimeStream catalog: ${err.message}`);
    process.exit(1);
  }
  
  try {
    const hentaiData = JSON.parse(fs.readFileSync(HENTAISTREAM_CATALOG, 'utf8'));
    hentaiCatalog = hentaiData.catalog || hentaiData;
    console.log(`   ✅ HentaiStream: ${hentaiCatalog.length} entries`);
  } catch (err) {
    console.error(`   ❌ Failed to load HentaiStream catalog: ${err.message}`);
    process.exit(1);
  }
  
  // Build hentai title index for fast lookup
  console.log('\n🔧 Building hentai title index...');
  const hentaiTitles = new Map();
  const hentaiNormalized = new Set();
  
  for (const h of hentaiCatalog) {
    const name = h.name || h.title;
    if (name) {
      const norm = normalize(name);
      hentaiTitles.set(norm, h);
      hentaiNormalized.add(norm);
    }
  }
  console.log(`   ✅ Indexed ${hentaiTitles.size} hentai titles`);
  
  // Scan anime catalog
  console.log('\n🔍 Scanning AnimeStream catalog...\n');
  
  const suspiciousEntries = [];
  const reasons = {
    exactMatch: [],
    similarMatch: [],
    nsfwGenres: [],
    nsfwKeywords: [],
    nsfwStudio: [],
  };
  
  for (const anime of animeCatalog) {
    const name = anime.name || anime.title;
    const imdbId = anime.imdb_id || anime.imdbId;
    const genres = anime.genres || [];
    const studio = anime.studio || '';
    const description = anime.description || anime.synopsis || '';
    
    const entry = {
      id: anime.id,
      imdb_id: imdbId,
      name: name,
      genres: genres,
      studio: studio,
      reasons: [],
      details: {},
    };
    
    // Skip whitelisted anime (known mainstream titles)
    const normName = normalize(name);
    const isWhitelisted = WHITELIST_TITLES.has(normName) || 
                          [...WHITELIST_TITLES].some(w => normName.includes(w) || w.includes(normName));
    if (isWhitelisted) {
      continue; // Skip this anime entirely
    }
    
    let isSuspicious = false;
    
    // 1. Check exact name match with hentai catalog
    if (hentaiNormalized.has(normName)) {
      entry.reasons.push('EXACT_MATCH');
      entry.details.matchedHentai = hentaiTitles.get(normName)?.name;
      reasons.exactMatch.push(entry);
      isSuspicious = true;
    }
    
    // 2. Check fuzzy name match (>85% similarity)
    if (!isSuspicious) {
      for (const hentaiName of hentaiNormalized) {
        const sim = similarity(normName, hentaiName);
        if (sim >= 0.85 && sim < 1) {
          entry.reasons.push('SIMILAR_MATCH');
          entry.details.matchedHentai = hentaiTitles.get(hentaiName)?.name;
          entry.details.similarity = (sim * 100).toFixed(1) + '%';
          reasons.similarMatch.push(entry);
          isSuspicious = true;
          break;
        }
      }
    }
    
    // 3. Check NSFW genres
    const genreCheck = hasNSFWGenres(genres);
    if (genreCheck.found) {
      entry.reasons.push('NSFW_GENRES');
      entry.details.nsfwGenres = genreCheck.matches;
      reasons.nsfwGenres.push(entry);
      isSuspicious = true;
    }
    
    // 4. Check NSFW keywords in title/description
    const titleKeywords = hasNSFWKeywords(name);
    const descKeywords = hasNSFWKeywords(description);
    if (titleKeywords.found || descKeywords.found) {
      entry.reasons.push('NSFW_KEYWORDS');
      entry.details.nsfwKeywords = [...new Set([...titleKeywords.matches, ...descKeywords.matches])];
      reasons.nsfwKeywords.push(entry);
      isSuspicious = true;
    }
    
    // 5. Check NSFW studio
    if (isNSFWStudio(studio)) {
      entry.reasons.push('NSFW_STUDIO');
      entry.details.studio = studio;
      reasons.nsfwStudio.push(entry);
      isSuspicious = true;
    }
    
    if (isSuspicious) {
      suspiciousEntries.push(entry);
    }
  }
  
  // Report results
  console.log('='.repeat(60));
  console.log('📊 DETECTION RESULTS');
  console.log('='.repeat(60));
  
  console.log(`\n🚨 Total suspicious entries: ${suspiciousEntries.length}\n`);
  console.log(`   Exact matches: ${reasons.exactMatch.length}`);
  console.log(`   Similar matches: ${reasons.similarMatch.length}`);
  console.log(`   NSFW genres: ${reasons.nsfwGenres.length}`);
  console.log(`   NSFW keywords: ${reasons.nsfwKeywords.length}`);
  console.log(`   NSFW studios: ${reasons.nsfwStudio.length}`);
  
  // Print detailed findings
  if (reasons.exactMatch.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('🔴 EXACT MATCHES (definitely hentai):');
    console.log('─'.repeat(60));
    for (const e of reasons.exactMatch.slice(0, 20)) {
      console.log(`   • "${e.name}" → matches hentai "${e.details.matchedHentai}"`);
    }
    if (reasons.exactMatch.length > 20) {
      console.log(`   ... and ${reasons.exactMatch.length - 20} more`);
    }
  }
  
  if (reasons.similarMatch.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('🟠 SIMILAR MATCHES (likely hentai):');
    console.log('─'.repeat(60));
    for (const e of reasons.similarMatch.slice(0, 20)) {
      console.log(`   • "${e.name}" ~ "${e.details.matchedHentai}" (${e.details.similarity})`);
    }
    if (reasons.similarMatch.length > 20) {
      console.log(`   ... and ${reasons.similarMatch.length - 20} more`);
    }
  }
  
  if (reasons.nsfwGenres.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('🟡 NSFW GENRES:');
    console.log('─'.repeat(60));
    for (const e of reasons.nsfwGenres.slice(0, 20)) {
      console.log(`   • "${e.name}" - genres: ${e.details.nsfwGenres.join(', ')}`);
    }
    if (reasons.nsfwGenres.length > 20) {
      console.log(`   ... and ${reasons.nsfwGenres.length - 20} more`);
    }
  }
  
  if (reasons.nsfwStudio.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('🟣 NSFW STUDIOS:');
    console.log('─'.repeat(60));
    for (const e of reasons.nsfwStudio.slice(0, 20)) {
      console.log(`   • "${e.name}" - studio: ${e.details.studio}`);
    }
    if (reasons.nsfwStudio.length > 20) {
      console.log(`   ... and ${reasons.nsfwStudio.length - 20} more`);
    }
  }
  
  // Generate blacklist file
  const blacklist = {
    generatedAt: new Date().toISOString(),
    totalEntries: suspiciousEntries.length,
    entries: suspiciousEntries.map(e => ({
      id: e.id,
      imdb_id: e.imdb_id,
      name: e.name,
      reasons: e.reasons,
    })),
    // Separate by IMDB ID for fast runtime filtering
    imdbIds: [...new Set(suspiciousEntries.filter(e => e.imdb_id).map(e => e.imdb_id))],
    // Names for name-based filtering
    names: [...new Set(suspiciousEntries.map(e => normalize(e.name)))],
  };
  
  // Save blacklist
  fs.writeFileSync(OUTPUT_BLACKLIST, JSON.stringify(blacklist, null, 2));
  console.log(`\n💾 Blacklist saved to: ${OUTPUT_BLACKLIST}`);
  
  // Generate detailed report
  let report = `Hentai Detection Report\n`;
  report += `Generated: ${new Date().toISOString()}\n`;
  report += `=`.repeat(60) + '\n\n';
  report += `AnimeStream catalog: ${animeCatalog.length} entries\n`;
  report += `HentaiStream catalog: ${hentaiCatalog.length} entries\n`;
  report += `Suspicious entries found: ${suspiciousEntries.length}\n\n`;
  
  for (const e of suspiciousEntries) {
    report += `─`.repeat(40) + '\n';
    report += `Name: ${e.name}\n`;
    report += `IMDB: ${e.imdb_id || 'N/A'}\n`;
    report += `Genres: ${e.genres.join(', ') || 'N/A'}\n`;
    report += `Studio: ${e.studio || 'N/A'}\n`;
    report += `Reasons: ${e.reasons.join(', ')}\n`;
    if (e.details.matchedHentai) report += `  → Matched: "${e.details.matchedHentai}"\n`;
    if (e.details.similarity) report += `  → Similarity: ${e.details.similarity}\n`;
    if (e.details.nsfwGenres) report += `  → NSFW Genres: ${e.details.nsfwGenres.join(', ')}\n`;
    if (e.details.nsfwKeywords) report += `  → NSFW Keywords: ${e.details.nsfwKeywords.join(', ')}\n`;
    report += '\n';
  }
  
  fs.writeFileSync(OUTPUT_REPORT, report);
  console.log(`📄 Detailed report saved to: ${OUTPUT_REPORT}`);
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ Detection complete!');
  console.log('='.repeat(60));
  
  return blacklist;
}

// Run if called directly
if (require.main === module) {
  detectHentai().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

module.exports = { detectHentai };
