// Find correct AllAnime IDs for popular anime seasons
// Run with: node scripts/find-allanime-ids.js

const https = require('https');

const SHOWS_TO_FIND = [
  { name: 'Attack on Titan S1', imdb: 'tt2560140', searchTerms: ['Shingeki no Kyojin', 'Attack on Titan Season 1', 'Attack on Titan 1'] },
  { name: 'Demon Slayer', imdb: 'tt9335498', searchTerms: ['Kimetsu no Yaiba', 'Demon Slayer'] },
  { name: 'Jujutsu Kaisen', imdb: 'tt12343534', searchTerms: ['Jujutsu Kaisen'] },
];

async function searchAllAnime(searchQuery) {
  return new Promise((resolve, reject) => {
    const query = `
      query ($search: SearchInput!, $limit: Int) {
        shows(search: $search, limit: $limit, translationType: sub, countryOrigin: JP) {
          edges { _id name englishName episodeCount type malId aniListId status }
        }
      }
    `;
    
    const data = JSON.stringify({
      query,
      variables: {
        search: { query: searchQuery, allowAdult: false },
        limit: 15
      }
    });
    
    const options = {
      hostname: 'api.allanime.day',
      path: '/api',
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://allanime.to',
        'Referer': 'https://allanime.to/'
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.data?.shows?.edges) {
            resolve(json.data.shows.edges);
          } else {
            console.log('Unexpected response:', body.substring(0, 200));
            resolve([]);
          }
        } catch (e) {
          console.log('Parse error:', e.message);
          resolve([]);
        }
      });
    });
    
    req.on('error', (e) => {
      console.log('Request error:', e.message);
      resolve([]);
    });
    
    req.write(data);
    req.end();
  });
}

async function main() {
  for (const show of SHOWS_TO_FIND) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${show.name} (${show.imdb})`);
    console.log('='.repeat(60));
    
    for (const term of show.searchTerms) {
      console.log(`\n  Searching: "${term}"`);
      const results = await searchAllAnime(term);
      
      if (results.length === 0) {
        console.log('    No results');
        continue;
      }
      
      // Sort by episode count (descending) - original series usually have more episodes
      results.sort((a, b) => (b.episodeCount || 0) - (a.episodeCount || 0));
      
      // Show results
      results.slice(0, 8).forEach((r, i) => {
        const name = r.englishName || r.name;
        console.log(`    ${i+1}. ${r._id} - ${name}`);
        console.log(`       Episodes: ${r.episodeCount || '?'}, Type: ${r.type}, Status: ${r.status}, MAL: ${r.malId}`);
      });
      
      await new Promise(r => setTimeout(r, 500)); // Rate limit
    }
  }
  
  console.log('\n\nRECOMMENDED MAPPINGS:');
  console.log('=====================');
  console.log('Look for shows with the most episodes (original seasons) and status "Finished Airing"');
}

main().catch(console.error);
