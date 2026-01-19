const fetch = require('node-fetch');

async function searchAllAnime(query) {
  const graphqlQuery = `
    query {
      shows(search: {query: "${query}"}, limit: 10) {
        edges {
          _id
          name
          englishName
          availableEpisodes
          status
        }
      }
    }
  `;
  
  try {
    const response = await fetch('https://api.allanime.day/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://allanime.to'
      },
      body: JSON.stringify({ query: graphqlQuery })
    });
    
    const data = await response.json();
    console.log('Search results for:', query);
    console.log(JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Search for Dark Moon variants
async function main() {
  await searchAllAnime('Dark Moon Blood Altar');
  console.log('\n---\n');
  await searchAllAnime('DARK MOON');
  console.log('\n---\n');
  await searchAllAnime('Blood Altar ENHYPEN');
}

main();
