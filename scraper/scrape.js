/**
 * CS Velo — BikeReg Confirmed Registrant Scraper v4
 *
 * BikeReg's confirmed page uses alternating table pairs:
 *   Table N   = category label row  ("6 entries - Masters Men 40+")
 *   Table N+1 = rider data rows     (FIRST | LAST | CITY | ST | TEAM | DATE)
 *
 * We click EXPAND ALL, then walk tables in pairs to associate each
 * data table with its category label from the preceding table.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'events-config.json');
const DATA_DIR    = path.join(__dirname, '..', 'data');

const config     = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const TEAM_MATCH = config.team_names.map(n => n.toLowerCase().trim());

function eventSlug(event) {
  const m = event.confirmed_url.match(/\/Confirmed\/(\d+)/i);
  return m ? m[1] : event.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function scrapeEvent(browser, event) {
  console.log(`\n→ Scraping: ${event.name}`);
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    await page.goto(event.confirmed_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    // Click EXPAND ALL to reveal all collapsed category sections
    const expanded = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a, button, span'));
      const btn = all.find(el => el.innerText && el.innerText.trim().toUpperCase() === 'EXPAND ALL');
      if (btn) { btn.click(); return true; }
      return false;
    });

    console.log(expanded ? '  ✓ Clicked EXPAND ALL' : '  ⚠️  EXPAND ALL not found');
    await page.waitForTimeout(3000);

    const result = await page.evaluate((cfg) => {
      const TEAM_MATCH_JS = cfg._teamMatchLower;

      function isCSVelo(str) {
        if (!str) return false;
        const v = str.toLowerCase().trim();
        return TEAM_MATCH_JS.some(t => v === t || v.includes(t));
      }

      // ── Event metadata ──────────────────────────────────────────────────
      const getText = (...sels) => {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.innerText.trim()) return el.innerText.trim();
        }
        return null;
      };

      const eventName     = getText('h1', '.event-name') || document.title.trim() || cfg.name;
      const eventDate     = getText('[class*="date"]', 'time') || null;
      const eventLocation = getText('[class*="location"]', '[class*="venue"]') || null;

      // ── Parse all tables ────────────────────────────────────────────────
      const tables = Array.from(document.querySelectorAll('table'));

      // Classify each table as either a LABEL table or a DATA table
      const classified = tables.map(table => {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length === 0) return { type: 'empty' };

        const firstRowText = rows[0].innerText.trim();
        const allCellText  = Array.from(rows[0].querySelectorAll('th, td'))
          .map(c => c.innerText.trim().toLowerCase());

        // A DATA table: first row has column headers (FIRST, LAST, TEAM, etc.)
        const isDataHeader =
          allCellText.some(t => t.includes('first') || t.includes('last') || t.includes('name')) &&
          allCellText.some(t => t.includes('team') || t.includes('club'));

        if (isDataHeader) {
          // Parse column indices
          const iFirst = allCellText.findIndex(t => t.includes('first'));
          const iLast  = allCellText.findIndex(t => t.includes('last') || (t.includes('name') && !t.includes('first')));
          const iTeam  = allCellText.findIndex(t => t.includes('team') || t.includes('club'));
          const iTime  = allCellText.findIndex(t => t.includes('time') || t.includes('start'));

          const riders = [];
          for (const row of rows.slice(1)) {
            const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
            if (cells.length === 0) continue;

            const teamVal = iTeam >= 0 ? (cells[iTeam] || '') : '';
            if (!isCSVelo(teamVal)) continue;

            let name = '';
            if (iFirst >= 0 && iLast >= 0) {
              name = [cells[iFirst], cells[iLast]].filter(Boolean).join(' ');
            } else if (iLast >= 0) {
              name = cells[iLast] || '';
            } else if (iFirst >= 0) {
              name = cells[iFirst] || '';
            }

            const timeVal = iTime >= 0 ? (cells[iTime] || '') : '';
            if (name) riders.push({ name: name.trim(), time: timeVal });
          }

          return { type: 'data', riders };
        }

        // A LABEL table: single row with category name + entry count
        const cleaned = firstRowText
          .replace(/\d+\s+entr(y|ies)/gi, '')
          .replace(/[-+]/g, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (cleaned.length > 1 && cleaned.length < 150 && rows.length <= 2) {
          return { type: 'label', label: cleaned };
        }

        return { type: 'unknown' };
      });

      // ── Associate label tables with their following data tables ─────────
      const fieldMap = {};
      let currentLabel = 'General';

      for (const t of classified) {
        if (t.type === 'label') {
          currentLabel = t.label;
        } else if (t.type === 'data' && t.riders.length > 0) {
          if (!fieldMap[currentLabel]) {
            fieldMap[currentLabel] = {
              field: currentLabel,
              time:  t.riders[0].time || null,
              riders: [],
            };
          }
          for (const r of t.riders) {
            if (!fieldMap[currentLabel].riders.includes(r.name)) {
              fieldMap[currentLabel].riders.push(r.name);
            }
            if (!fieldMap[currentLabel].time && r.time) {
              fieldMap[currentLabel].time = r.time;
            }
          }
        }
      }

      const fields      = Object.values(fieldMap).map(f => ({ ...f, cs_velo_count: f.riders.length }));
      const totalCSVelo = fields.reduce((sum, f) => sum + f.cs_velo_count, 0);

      return {
        event_name:     eventName,
        event_date:     eventDate,
        event_location: eventLocation,
        bikereg_url:    cfg.bikereg_url,
        confirmed_url:  cfg.confirmed_url,
        total_cs_velo:  totalCSVelo,
        fields,
        scraped_at:     new Date().toISOString(),
        debug: { tableCount: tables.length, classified: classified.map(t => ({ type: t.type, label: t.label, riderCount: t.riders ? t.riders.length : undefined })) },
      };

    }, { ...event, _teamMatchLower: TEAM_MATCH });

    console.log(`  Tables: ${result.debug.tableCount} total`);
    console.log(`  ✓ ${result.total_cs_velo} CS Velo rider(s) across ${result.fields.length} field(s):`);
    result.fields.forEach(f => console.log(`    - ${f.field}: ${f.riders.join(', ')}`));

    return result;

  } catch (err) {
    console.error(`  ✗ Error: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('CS Velo scraper starting...');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const index   = [];

  for (const event of config.events) {
    const data = await scrapeEvent(browser, event);
    if (!data) continue;

    const slug     = eventSlug(event);
    const filename = `${slug}.json`;
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
    console.log(`  → Wrote data/${filename}`);

    index.push({
      slug, filename,
      event_name:     data.event_name,
      event_date:     data.event_date,
      event_location: data.event_location,
      bikereg_url:    data.bikereg_url,
      total_cs_velo:  data.total_cs_velo,
      scraped_at:     data.scraped_at,
    });
  }

  await browser.close();

  fs.writeFileSync(path.join(DATA_DIR, 'index.json'),
    JSON.stringify({ events: index, generated_at: new Date().toISOString() }, null, 2));
  console.log(`\n✓ index.json written with ${index.length} event(s)`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
