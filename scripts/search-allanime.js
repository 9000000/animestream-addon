const https = require('https');

const searchTerm = process.argv[2] || 'Shingeki no Kyojin';

const query = `query { 
  shows(search: {query: "${searchTerm}"}, limit: 15, translationType: sub, countryOrigin: JP) { 
    edges { 
      _id 
      name 
      englishName 
      malId 
      aniListId 
      availableEpisodesDetail 
    } 
  } 
}`;

const body = JSON.stringify({ query });

const req = https.request('https://api.allanime.day/api', { 
  method: 'POST', 
  headers: { 
    'Content-Type': 'application/json', 
    'Referer': 'https://allanime.to' 
  }
}, (res) => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    try {
      const r = JSON.parse(data);
      console.log(`\nSearch results for "${searchTerm}":\n`);
      r.data.shows.edges.forEach(e => {
        const subEps = e.availableEpisodesDetail?.sub?.length || 0;
        const dubEps = e.availableEpisodesDetail?.dub?.length || 0;
        console.log(`${e._id} | ${e.name} | MAL:${e.malId} | AL:${e.aniListId} | Sub:${subEps} Dub:${dubEps}`);
      });
    } catch(err) {
      console.error('Parse error:', err.message, data.slice(0, 200));
    }
  });
});

req.on('error', e => console.error('Request error:', e.message));
req.write(body);
req.end();
