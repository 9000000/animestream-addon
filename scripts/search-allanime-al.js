const https = require('https');

const aniListId = parseInt(process.argv[2]) || 16498;

const query = `query { 
  shows(search: {aniListId: "${aniListId}"}, limit: 5, translationType: sub, countryOrigin: JP) { 
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
      console.log(`\nSearch results for AniList ID ${aniListId}:\n`);
      if (!r.data?.shows?.edges?.length) {
        console.log('No results found');
        console.log('Raw response:', data.slice(0, 300));
        return;
      }
      r.data.shows.edges.forEach(e => {
        const subEps = e.availableEpisodesDetail?.sub?.length || 0;
        const dubEps = e.availableEpisodesDetail?.dub?.length || 0;
        console.log(`${e._id} | ${e.name} | MAL:${e.malId} | AL:${e.aniListId} | Sub:${subEps} Dub:${dubEps}`);
      });
    } catch(err) {
      console.error('Parse error:', err.message, data.slice(0, 500));
    }
  });
});

req.on('error', e => console.error('Request error:', e.message));
req.write(body);
req.end();
