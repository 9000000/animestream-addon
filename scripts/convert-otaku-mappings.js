#!/usr/bin/env node
/**
 * Convert Otaku-Mappings SQLite database to JSON
 * 
 * This script reads the anime_mappings.db SQLite file and converts it to
 * a JSON file that can be used by the build-database script.
 * 
 * Usage:
 *   node scripts/convert-otaku-mappings.js
 *   node scripts/convert-otaku-mappings.js --explore  # Show database structure
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const EXPLORE_MODE = process.argv.includes('--explore');
const DB_PATH = path.join(__dirname, '..', 'anime_mappings.db');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'otaku-mappings.json');

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function explore(db) {
  console.log('\n📊 Exploring Otaku-Mappings Database Structure\n');
  console.log('='.repeat(60));
  
  // Get all tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log(`\n📋 Tables: ${tables.map(t => t.name).join(', ')}\n`);
  
  for (const table of tables) {
    console.log(`\n📁 Table: ${table.name}`);
    console.log('-'.repeat(40));
    
    // Get column info
    const columns = db.prepare(`PRAGMA table_info(${table.name})`).all();
    console.log('Columns:');
    for (const col of columns) {
      console.log(`  - ${col.name} (${col.type}${col.pk ? ', PRIMARY KEY' : ''})`);
    }
    
    // Get row count
    const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
    console.log(`\nRow count: ${count.count.toLocaleString()}`);
    
    // Show sample data
    const sample = db.prepare(`SELECT * FROM ${table.name} LIMIT 3`).all();
    console.log('\nSample entries:');
    for (const row of sample) {
      console.log(JSON.stringify(row, null, 2));
    }
  }
  
  console.log('\n' + '='.repeat(60));
}

function convert(db) {
  console.log('\n🔄 Converting Otaku-Mappings to JSON\n');
  
  // Get the main table (should be 'mappings' or similar)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const mainTable = tables.find(t => t.name.includes('mapping') || t.name.includes('anime')) || tables[0];
  
  if (!mainTable) {
    console.error('❌ No tables found in database!');
    process.exit(1);
  }
  
  console.log(`📋 Reading from table: ${mainTable.name}`);
  
  // Get all rows
  const rows = db.prepare(`SELECT * FROM ${mainTable.name}`).all();
  console.log(`   Found ${rows.length.toLocaleString()} entries`);
  
  // Store entries as array (compact) with index maps pointing to array indices
  const entries = [];
  const indexes = {
    mal: {},      // MAL ID -> index
    imdb: {},     // IMDB ID -> index  
    anidb: {},    // AniDB ID -> index
    kitsu: {},    // Kitsu ID -> index
    anilist: {},  // AniList ID -> index
  };
  
  let withImdb = 0;
  let withAnidb = 0;
  let withTvdbSeason = 0;
  let withDub = 0;
  
  for (const row of rows) {
    // Create compact entry (only non-null fields, short keys)
    const entry = {};
    
    // IDs (short keys for compactness)
    if (row.mal_id) entry.mal = row.mal_id;
    if (row.mal_dub_id) entry.dub = row.mal_dub_id;
    if (row.anilist_id) entry.al = row.anilist_id;
    if (row.kitsu_id) entry.kitsu = row.kitsu_id;
    if (row.anidb_id) entry.adb = row.anidb_id;
    if (row.simkl_id) entry.simkl = row.simkl_id;
    if (row.thetvdb_id) entry.tvdb = row.thetvdb_id;
    if (row.themoviedb_id) entry.tmdb = row.themoviedb_id;
    if (row.imdb_id) entry.imdb = row.imdb_id;
    if (row.trakt_id) entry.trakt = row.trakt_id;
    
    // Metadata (only if present)
    if (row.mal_title) entry.title = row.mal_title;
    
    // Critical for multi-season episode mapping
    if (row.thetvdb_season != null) entry.tvdbS = row.thetvdb_season;
    if (row.thetvdb_part != null) entry.tvdbP = row.thetvdb_part;
    
    // Type info
    if (row.anime_media_type) entry.type = row.anime_media_type;
    if (row.anime_media_episodes) entry.eps = row.anime_media_episodes;
    if (row.status) entry.status = row.status;
    
    // Track stats
    if (entry.imdb) withImdb++;
    if (entry.adb) withAnidb++;
    if (entry.tvdbS != null) withTvdbSeason++;
    if (entry.dub) withDub++;
    
    const idx = entries.length;
    entries.push(entry);
    
    // Build indexes (ID -> array index)
    if (entry.mal) indexes.mal[entry.mal] = idx;
    if (entry.imdb) indexes.imdb[entry.imdb] = idx;
    if (entry.adb) indexes.anidb[entry.adb] = idx;
    if (entry.kitsu) indexes.kitsu[entry.kitsu] = idx;
    if (entry.al) indexes.anilist[entry.al] = idx;
  }
  
  // Final structure
  const mappings = {
    buildDate: new Date().toISOString(),
    source: 'Otaku-Mappings',
    stats: {
      total: rows.length,
      withImdb,
      withAnidb,
      withTvdbSeason,
      withDub,
    },
    entries,
    indexes,
  };
  
  // Write compact JSON (no pretty print for smaller size)
  const jsonContent = JSON.stringify(mappings);
  fs.writeFileSync(OUTPUT_PATH, jsonContent);
  
  console.log('\n📊 Conversion Statistics:');
  console.log(`   Total entries: ${rows.length.toLocaleString()}`);
  console.log(`   With IMDB ID: ${withImdb.toLocaleString()}`);
  console.log(`   With AniDB ID: ${withAnidb.toLocaleString()}`);
  console.log(`   With TVDB Season: ${withTvdbSeason.toLocaleString()}`);
  console.log(`   With Dub ID: ${withDub.toLocaleString()}`);
  console.log(`\n💾 Saved to: ${OUTPUT_PATH}`);
  console.log(`   File size: ${formatSize(jsonContent.length)}`);
  
  return mappings;
}

// Main
console.log('🗄️  Otaku-Mappings Converter');
console.log('='.repeat(40));

if (!fs.existsSync(DB_PATH)) {
  console.error(`❌ Database not found: ${DB_PATH}`);
  console.log('   Download from: https://github.com/Goldenfreddy0703/Otaku-Mappings');
  process.exit(1);
}

const stat = fs.statSync(DB_PATH);
console.log(`📁 Database: ${DB_PATH}`);
console.log(`   Size: ${formatSize(stat.size)}`);

const db = new Database(DB_PATH, { readonly: true });

try {
  if (EXPLORE_MODE) {
    explore(db);
  } else {
    convert(db);
  }
} finally {
  db.close();
}

console.log('\n✅ Done!\n');
