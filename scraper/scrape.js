/**
 * CS Velo — BikeReg Confirmed Registrant Scraper
 *
 * Reads events-config.json, scrapes each BikeReg Confirmed page using a
 * headless browser (to bypass 403 blocks on direct fetches), filters for
 * CS Velo riders, and writes one JSON file per event into /data/.
 * Also writes /data/index.json listing all available event files.
 *
 * Run: node scraper/scrape.js
 * Requires: npm install playwright
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'events-config.json');
const DATA_DIR    = path.join(__dirname, '..', 'data');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Normalised team names for case-insensitive matching
const TEAM_MATCH = config.team_names.map(n => n.toLowerCase().trim());

function isCSVelo(teamCell) {
  if (!teamCell) return false;
  const val = teamCell.toLowerCase().trim();
  return TEAM_MATCH.some(t => val === t || val.includes(t));
}

/** Derive a safe filename slug from the confirmed URL, e.g. "74430" */
function eventSlug(event) {
  const m = event.confirmed_url.match(/\/Confirmed\/(\d+)/i);
  return m ? m[1] : event.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function scrapeEvent(browser, event) {
  console.log(`\n→ Scraping: ${event.name}`);
  console.log(`  Confirmed URL: ${event.confirmed_url}`);

  const page = await browser.newPage();

  // Mimic a real browser to avoid bot detection
  await page.setExtraHTTPHeaders({
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    await page.goto(event.confirmed_url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    // Give any JS-rendered content time to settle
    await page.waitForTimeout(2000);

    const result = await page.evaluate((eventConfig) => {
      // ── 1. Event metadata ────────────────────────────────────────────────

      const getText = (...selectors) => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
        }
        return null;
      };

      const eventName =
        getText('h1', '.event-name', '[class*="eventName"]', '[class*="event-title"]') ||
        document.title.replace(/confirmed.*/i, '').trim() ||
        eventConfig.name;

      const eventDate =
        getText(
          '[class*="event-date"]', '[class*="eventDate"]',
          '.date', '[itemprop="startDate"]',
          'time'
        ) || null;

      const eventLocation =
        getText(
          '[class*="event-location"]', '[class*="eventLocation"]',
          '[class*="venue"]', '.location', '[itemprop="location"]'
        ) || null;

      // ── 2. Find the registrant table ────────────────────────────────────

      const tables = Array.from(document.querySelectorAll('table'));
      if (!tables.length) {
        return { error: 'No tables found on page', html_sample: document.body.innerText.slice(0, 500) };
      }

      // Pick the table most likely to be the registrant list
      // (largest number of rows, or one whose headers mention "name"/"team")
      let targetTable = tables[0];
      let bestScore   = -1;

      for (const tbl of tables) {
        const headers = Array.from(tbl.querySelectorAll('th, thead td'))
          .map(th => th.innerText.toLowerCase());
        const hasName = headers.some(h => h.includes('name'));
        const hasTeam = headers.some(h => h.includes('team'));
        const rowCount = tbl.querySelectorAll('tbody tr').length;
        const score = (hasName ? 10 : 0) + (hasTeam ? 10 : 0) + rowCount;
        if (score > bestScore) { bestScore = score; targetTable = tbl; }
      }

      // ── 3. Parse headers ────────────────────────────────────────────────

      const headerEls = Array.from(targetTable.querySelectorAll('th, thead td'));
      const headers   = headerEls.map(h => h.innerText.toLowerCase().trim());

      // Column index helpers — BikeReg labels vary slightly across events
      const colIdx = (keywords) => {
        const idx = headers.findIndex(h => keywords.some(k => h.includes(k)));
        return idx >= 0 ? idx : null;
      };

      const iName     = colIdx(['last name', 'name', 'first']);
      const iFirst    = colIdx(['first name', 'first']);
      const iTeam     = colIdx(['team', 'club']);
      const iCategory = colIdx(['category', 'field', 'class', 'division', 'wave', 'group']);
      const iTime     = colIdx(['start time', 'time', 'wave time']);
      const iCity     = colIdx(['city']);
      const iState    = colIdx(['state']);

      if (iTeam === null) {
        return { error: 'Could not find Team column', headers };
      }

      // ── 4. Parse rows ───────────────────────────────────────────────────

      const rows = Array.from(targetTable.querySelectorAll('tbody tr'));

      const allRegistrants = rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        const cell  = (i) => (i !== null && cells[i] ? cells[i].innerText.trim() : '');

        let fullName = cell(iName);
        if (iFirst !== null && iFirst !== iName) {
          fullName = [cell(iFirst), cell(iName)].filter(Boolean).join(' ');
        }

        return {
          name:     fullName || '(unknown)',
          team:     cell(iTeam),
          category: cell(iCategory),
          time:     cell(iTime),
        };
      }).filter(r => r.name && r.name !== '(unknown)');

      // ── 5. Filter to CS Velo ────────────────────────────────────────────

      const TEAM_MATCH_JS = eventConfig._teamMatchLower;

      const csVeloRows = allRegistrants.filter(r => {
        const t = r.team.toLowerCase().trim();
        return TEAM_MATCH_JS.some(tm => t === tm || t.includes(tm));
      });

      // ── 6. Group by field/category ──────────────────────────────────────

      const fieldMap = {};
      for (const rider of csVeloRows) {
        const key = rider.category || 'General';
        if (!fieldMap[key]) {
          fieldMap[key] = { field: key, time: rider.time || null, riders: [] };
        }
        fieldMap[key].riders.push(rider.name);
        // Prefer the first non-empty time we find for this field
        if (!fieldMap[key].time && rider.time) fieldMap[key].time = rider.time;
      }

      const fields = Object.values(fieldMap).map(f => ({
        ...f,
        cs_velo_count: f.riders.length,
      }));

      return {
        event_name:     eventName,
        event_date:     eventDate,
        event_location: eventLocation,
        bikereg_url:    eventConfig.bikereg_url,
        confirmed_url:  eventConfig.confirmed_url,
        total_cs_velo:  csVeloRows.length,
        fields,
        scraped_at:     new Date().toISOString(),
        debug: {
          total_registrants: allRegistrants.length,
          headers,
        },
      };
    }, { ...event, _teamMatchLower: TEAM_MATCH });

    if (result.error) {
      console.warn(`  ⚠️  ${result.error}`);
      console.warn('  Headers found:', result.headers || '(none)');
      console.warn('  HTML sample:', result.html_sample || '');
      return null;
    }

    console.log(`  ✓ Found ${result.total_cs_velo} CS Velo rider(s) across ${result.fields.length} field(s)`);
    return result;

  } catch (err) {
    console.error(`  ✗ Error scraping ${event.name}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('CS Velo scraper starting...');
  console.log(`Events to scrape: ${config.events.length}`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  const index   = [];   // will be written to data/index.json
  const written = [];

  for (const event of config.events) {
    const data = await scrapeEvent(browser, event);
    if (!data) {
      console.warn(`  Skipping ${event.name} due to scrape error.`);
      continue;
    }

    const slug     = eventSlug(event);
    const filename = `${slug}.json`;
    const outPath  = path.join(DATA_DIR, filename);

    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`  → Wrote data/${filename}`);

    index.push({
      slug,
      filename,
      event_name:     data.event_name,
      event_date:     data.event_date,
      event_location: data.event_location,
      bikereg_url:    data.bikereg_url,
      total_cs_velo:  data.total_cs_velo,
      scraped_at:     data.scraped_at,
    });

    written.push(filename);
  }

  await browser.close();

  // Write the index file — Wix reads this first to know which files to fetch
  const indexPath = path.join(DATA_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify({ events: index, generated_at: new Date().toISOString() }, null, 2));
  console.log(`\n✓ Wrote data/index.json (${index.length} event(s))`);
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
