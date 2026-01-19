const https = require('https');

const showId = process.argv[2] || 'XYfeCqq4yyGS2zxFx';

const query = `query { 
  show(_id: "${showId}") { 
    _id 
    name 
    englishName 
    malId 
    aniListId 
    availableEpisodesDetail 
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
      console.log(`\nShow info for ID ${showId}:\n`);
      if (!r.data?.show) {
        console.log('No results found');
        console.log('Raw response:', data.slice(0, 300));
        return;
      }
      const e = r.data.show;
      const subEps = e.availableEpisodesDetail?.sub?.length || 0;
      const dubEps = e.availableEpisodesDetail?.dub?.length || 0;
      console.log(`${e._id} | ${e.name} | MAL:${e.malId} | AL:${e.aniListId} | Sub:${subEps} Dub:${dubEps}`);
    } catch(err) {
      console.error('Parse error:', err.message, data.slice(0, 500));
    }
  });
});

req.on('error', e => console.error('Request error:', e.message));
req.write(body);
req.end();
