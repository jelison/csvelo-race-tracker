/**
 * CS Velo — BikeReg Confirmed Registrant Scraper v3
 * Clicks "EXPAND ALL" to reveal collapsed category sections before scraping.
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

    // ── Click "EXPAND ALL" to reveal all collapsed category sections ──────
    const expanded = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button, span'));
      const expandBtn = links.find(el => el.innerText && el.innerText.trim().toUpperCase() === 'EXPAND ALL');
      if (expandBtn) { expandBtn.click(); return true; }
      return false;
    });

    if (expanded) {
      console.log('  ✓ Clicked EXPAND ALL — waiting for sections to render...');
      await page.waitForTimeout(3000);
    } else {
      console.log('  ⚠️  EXPAND ALL button not found — trying to expand sections individually...');
      // Fallback: click every collapsed section toggle
      await page.evaluate(() => {
        document.querySelectorAll('a, button, span').forEach(el => {
          if (el.innerText && el.innerText.trim() === '+') el.click();
        });
      });
      await page.waitForTimeout(3000);
    }

    const result = await page.evaluate((cfg) => {
      const TEAM_MATCH_JS = cfg._teamMatchLower;

      function isCSVeloJS(str) {
        if (!str) return false;
        const v = str.toLowerCase().trim();
        return TEAM_MATCH_JS.some(t => v === t || v.includes(t));
      }

      // Event metadata
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

      const tables     = Array.from(document.querySelectorAll('table'));
      const debugTables = tables.map((t, i) => ({
        index: i,
        rows: t.querySelectorAll('tr').length,
        firstRowText: (t.querySelector('tr') || {}).innerText || '',
      }));

      const fieldMap = {};

      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length < 2) continue;

        const parsedRows = rows.map(row => ({
          cells: Array.from(row.querySelectorAll('th, td')).map(c => c.innerText.trim()),
          isHeader: row.querySelector('th') !== null,
        }));

        // Find column header row and field label
        let headerIdx  = -1;
        let fieldLabel = null;

        for (let i = 0; i < Math.min(4, parsedRows.length); i++) {
          const lower = parsedRows[i].cells.map(c => c.toLowerCase());
          if (lower.some(c => c.includes('name') || c.includes('first') || c.includes('last'))) {
            headerIdx = i;
            break;
          }
          const raw     = parsedRows[i].cells.join(' ');
          const cleaned = raw.replace(/\d+\s+entr(y|ies)/gi, '').replace(/\+/g, '').replace(/\s+/g, ' ').trim();
          if (cleaned.length > 2 && cleaned.length < 150) fieldLabel = cleaned;
        }

        let iFirst = null, iLast = null, iTeam = null, iTime = null;

        if (headerIdx >= 0) {
          const h = parsedRows[headerIdx].cells.map(c => c.toLowerCase());
          iFirst = h.findIndex(c => c.includes('first'));
          iLast  = h.findIndex(c => c.includes('last') || (c.includes('name') && !c.includes('first')));
          iTeam  = h.findIndex(c => c.includes('team') || c.includes('club'));
          iTime  = h.findIndex(c => c.includes('time') || c.includes('start'));
          if (iFirst < 0) iFirst = null;
          if (iLast  < 0) iLast  = null;
          if (iTeam  < 0) iTeam  = null;
          if (iTime  < 0) iTime  = null;
        }

        const dataRows = parsedRows.slice(headerIdx >= 0 ? headerIdx + 1 : 1);

        // Auto-detect team column if not found in headers
        if (iTeam === null) {
          outer: for (const row of dataRows) {
            for (let idx = 0; idx < row.cells.length; idx++) {
              if (isCSVeloJS(row.cells[idx])) { iTeam = idx; break outer; }
            }
          }
        }

        for (const row of dataRows) {
          if (row.cells.length === 0) continue;
          const teamVal = iTeam !== null ? (row.cells[iTeam] || '') : '';
          if (!isCSVeloJS(teamVal)) continue;

          let name = '';
          if (iFirst !== null && iLast !== null) {
            name = [row.cells[iFirst], row.cells[iLast]].filter(Boolean).join(' ');
          } else if (iLast !== null) {
            name = row.cells[iLast] || '';
          } else if (iFirst !== null) {
            name = row.cells[iFirst] || '';
          } else {
            name = row.cells.filter((c, i) => i !== iTeam && isNaN(c) && c.length > 1).join(' ');
          }

          const timeVal = iTime !== null ? (row.cells[iTime] || '') : '';
          const key     = fieldLabel || 'General';

          if (!fieldMap[key]) fieldMap[key] = { field: key, time: timeVal || null, riders: [] };
          if (name && !fieldMap[key].riders.includes(name)) fieldMap[key].riders.push(name);
          if (!fieldMap[key].time && timeVal) fieldMap[key].time = timeVal;
        }
      }

      const fields      = Object.values(fieldMap).map(f => ({ ...f, cs_velo_count: f.riders.length }));
      const totalCSVelo = fields.reduce((sum, f) => sum + f.cs_velo_count, 0);

      return {
        event_name: eventName, event_date: eventDate, event_location: eventLocation,
        bikereg_url: cfg.bikereg_url, confirmed_url: cfg.confirmed_url,
        total_cs_velo: totalCSVelo, fields, scraped_at: new Date().toISOString(),
        debug: { tableCount: tables.length, tables: debugTables },
      };

    }, { ...event, _teamMatchLower: TEAM_MATCH });

    console.log(`  Tables found: ${result.debug.tableCount}`);
    result.debug.tables.forEach(t => {
      console.log(`    Table ${t.index}: ${t.rows} rows | "${t.firstRowText.slice(0, 60).replace(/\n/g,' ')}"`);
    });
    console.log(`  ✓ ${result.total_cs_velo} CS Velo rider(s) in ${result.fields.length} field(s)`);
    if (result.fields.length) result.fields.forEach(f => console.log(`    - ${f.field}: ${f.riders.join(', ')}`));

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

    index.push({ slug, filename, event_name: data.event_name, event_date: data.event_date,
      event_location: data.event_location, bikereg_url: data.bikereg_url,
      total_cs_velo: data.total_cs_velo, scraped_at: data.scraped_at });
  }

  await browser.close();

  fs.writeFileSync(path.join(DATA_DIR, 'index.json'),
    JSON.stringify({ events: index, generated_at: new Date().toISOString() }, null, 2));
  console.log(`\n✓ index.json written with ${index.length} event(s)`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
