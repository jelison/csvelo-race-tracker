/**
 * CS Velo — BikeReg Confirmed Registrant Scraper v7
 *
 * Key changes:
 *  - Event name always comes from events-config.json (cfg.name) — never scraped
 *  - Event date uses cfg.date from config as primary source, falls back to page scrape
 *  - Events more than 1 day past are excluded from index.json automatically
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

function parseEventDate(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+/i, '').trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

function isEventCurrent(dateStr) {
  const eventDate = parseEventDate(dateStr);
  if (!eventDate) return false; // no date = exclude (can't tell, assume stale)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 1);
  cutoff.setHours(0, 0, 0, 0);
  return eventDate >= cutoff;
}

async function scrapeEvent(browser, event) {
  console.log(`\n→ Scraping: ${event.name}`);
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    await page.goto(event.confirmed_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Wait for page content to render, up to 10 seconds
    await page.waitForFunction(() => {
      const all = Array.from(document.querySelectorAll('a, span, button'));
      return all.some(el => el.innerText && el.innerText.trim().toUpperCase().includes('EXPAND'));
    }, { timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(2000);
    
    // Try multiple strategies to EXPAND ALL collapsed sections
    const expanded = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a, button, span, div'));
      
      // Strategy 1: exact "EXPAND ALL" text
      let btn = all.find(el => el.innerText && el.innerText.trim().toUpperCase() === 'EXPAND ALL');
      if (btn) { btn.click(); return 'exact match'; }
    
      // Strategy 2: partial match containing "expand"
      btn = all.find(el => el.innerText && el.innerText.trim().toUpperCase().includes('EXPAND'));
      if (btn) { btn.click(); return 'partial match'; }
    
      // Strategy 3: click every "+" element on the page
      const plusBtns = all.filter(el => el.innerText && el.innerText.trim() === '+');
      if (plusBtns.length > 0) {
        plusBtns.forEach(el => el.click());
        return `clicked ${plusBtns.length} plus buttons`;
      }
    
      return false;
    });
    
    console.log(expanded ? `  ✓ Expanded sections: ${expanded}` : '  ⚠️  Could not expand sections');
    if (!expanded) {
      const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500));
      const isBlocked = pageText.toLowerCase().includes('security verification') || 
                        pageText.toLowerCase().includes('not a bot') ||
                        pageText.toLowerCase().includes('checking your browser');
      if (isBlocked) {
        console.log(`  🔒 Cloudflare bot protection detected — marking as blocked`);
        return {
          event_name:       event.name,
          event_date:       event.date || null,
          event_location:   null,
          bikereg_url:      event.bikereg_url,
          confirmed_url:    event.confirmed_url,
          total_cs_velo:    0,
          fields:           [],
          cloudflare_blocked: true,
          scraped_at:       new Date().toISOString(),
        };
      }
    }

    console.log(expanded ? '  ✓ Clicked EXPAND ALL' : '  ⚠️  EXPAND ALL not found');
    await page.waitForTimeout(5000);

    const result = await page.evaluate((cfg) => {
      const TEAM_MATCH_JS = cfg._teamMatchLower;

    function isCSVelo(str) {
      if (!str) return false;
      const v = str.toLowerCase().trim();
      const match = TEAM_MATCH_JS.some(t => v === t || v.includes(t));
      if (v.length > 0) console.log(`    TEAM CELL: "${v}" → ${match ? 'MATCH' : 'no match'}`);
      return match;
    }

      // ── Event name: always use config, never scrape ─────────────────────
      const eventName = cfg.name;

      // ── Date: use config date if provided, otherwise scrape ─────────────
      let eventDate = cfg.date || null;

      if (!eventDate) {
        const fullText  = document.body.innerText;
        const dateMatch = fullText.match(
          /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/
        ) || fullText.match(
          /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/
        );
        eventDate = dateMatch ? dateMatch[0] : null;
      }

      // ── Location: scrape from page text near the date ───────────────────
      let eventLocation = null;
      const fullText = document.body.innerText;

      if (eventDate) {
        const dateIdx  = fullText.indexOf(eventDate.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+/i, ''));
        const textNear = fullText.slice(Math.max(0, dateIdx - 50), dateIdx + 200);
        const locMatch = textNear.match(/([A-Za-z\s]+),\s+([A-Z]{2})\b/);
        if (locMatch) eventLocation = locMatch[0].trim();
      }

      // ── Parse all tables ────────────────────────────────────────────────
      const tables = Array.from(document.querySelectorAll('table'));

      const classified = tables.map(table => {
        const rows        = Array.from(table.querySelectorAll('tr'));
        if (rows.length === 0) return { type: 'empty' };

        const firstRowText = rows[0].innerText.trim();
        const allCellText  = Array.from(rows[0].querySelectorAll('th, td'))
          .map(c => c.innerText.trim().toLowerCase());

        const isDataHeader =
          allCellText.some(t => t.includes('first') || t.includes('last') || t.includes('name')) &&
          allCellText.some(t => t.includes('team') || t.includes('club'));

        if (isDataHeader) {
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
            fieldMap[currentLabel] = { field: currentLabel, time: null, riders: [] };
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
      };

    }, { ...event, _teamMatchLower: TEAM_MATCH });

    console.log(`  ✓ ${result.total_cs_velo} CS Velo rider(s) across ${result.fields.length} field(s):`);
    result.fields.forEach(f => console.log(`    - ${f.field}: ${f.riders.join(', ')}`));
    console.log(`  Date: ${result.event_date} | Location: ${result.event_location}`);

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

    if (isEventCurrent(data.event_date)) {
      index.push({
        slug, filename,
        event_name:     data.event_name,
        event_date:     data.event_date,
        event_location: data.event_location,
        bikereg_url:    data.bikereg_url,
        total_cs_velo:  data.total_cs_velo,
        scraped_at:     data.scraped_at,
      });
      console.log(`  ✓ Added to index`);
    } else {
      console.log(`  ⏭  Skipped — event date has passed (${data.event_date})`);
    }
  }

  await browser.close();

  // Sort by date ascending
  index.sort((a, b) => {
    const da = parseEventDate(a.event_date);
    const db = parseEventDate(b.event_date);
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  });

  fs.writeFileSync(path.join(DATA_DIR, 'index.json'),
    JSON.stringify({ events: index, generated_at: new Date().toISOString() }, null, 2));
  console.log(`\n✓ index.json written with ${index.length} active event(s)`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
