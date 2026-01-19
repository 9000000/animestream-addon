// Quick test script to see AllAnime search results
const https = require('https');

const searchTerms = [
  'Kimetsu no Yaiba',
  'Shingeki no Kyojin',
  'Attack on Titan'
];

async function searchAllAnime(searchQuery) {
  return new Promise((resolve, reject) => {
    const query = `
      query ($search: SearchInput!, $limit: Int) {
        shows(search: $search, limit: $limit, translationType: "sub", countryOrigin: "JP") {
          edges { _id name englishName episodeCount type malId }
        }
      }
    `;
    
    const data = JSON.stringify({
      query,
      variables: {
        search: { query: searchQuery, allowAdult: false },
        limit: 10
      }
    });
    
    const req = https.request({
      hostname: 'api.allanime.day',
      path: '/api',
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const results = JSON.parse(body).data.shows.edges;
          resolve(results);
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  for (const term of searchTerms) {
    console.log(`\n=== Search: "${term}" ===`);
    try {
      const results = await searchAllAnime(term);
      results.forEach((r, i) => {
        console.log(`  ${i+1}. ${r._id}: ${r.name} (eps: ${r.episodeCount}, type: ${r.type}, MAL: ${r.malId})`);
      });
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }
}

main();
