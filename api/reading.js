// api/reading.js  —  Vercel serverless function for KundliAPI
// Runs on the server, so your X-Api-Key is never exposed to the browser.
// Endpoint/auth/response-shape below match KundliAPI's official docs.

const BASE = 'https://kundliapi.com/api';

// turn an IANA timezone (e.g. "Asia/Kolkata") into a numeric offset
// like 5.5 or -6, for the given birth date (handles +HH:MM zones).
function tzOffset(zone, y, mo, d) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    const parts = fmt.formatToParts(new Date(Date.UTC(y, mo - 1, d, 12)));
    const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT+0';
    const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) + (parseInt(m[3] || '0', 10) / 60));
  } catch (e) { return 0; }
}

// free, no-key geocoder: city name -> {lat, lon, tzone}
async function geocode(place, y, mo, d) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`;
    const r = await fetch(url);
    const j = await r.json();
    const hit = j && j.results && j.results[0];
    if (!hit) return null;
    return {
      lat: hit.latitude,
      lon: hit.longitude,
      tzone: tzOffset(hit.timezone, y, mo, d)
    };
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const KEY = process.env.KUNDLI_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Server missing KUNDLI_API_KEY env variable' });

  const { name, dob, tob, place } = req.body || {};
  if (!dob) return res.status(400).json({ error: 'Date of birth is required' });

  const [year, month, day] = dob.split('-').map(Number);
  const [hour = 12, min = 0] = (tob || '12:00').split(':').map(Number);

  // resolve birth location -> coordinates + timezone
  let loc = place ? await geocode(place, year, month, day) : null;
  if (!loc) loc = { lat: 30.2672, lon: -97.7431, tzone: -6 }; // fallback: Austin, TX

  const birthData = { day, month, year, hour, min, lat: loc.lat, lon: loc.lon, tzone: loc.tzone };

  try {
    const apiRes = await fetch(`${BASE}/astro/get_astro_data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
      body: JSON.stringify(birthData)
    });

    const json = await apiRes.json();

    if (!apiRes.ok) {
      // surface the real reason (401 = bad key, 403 = domain/IP not whitelisted, 429 = limit)
      return res.status(apiRes.status).json({
        error: `KundliAPI returned ${apiRes.status}`,
        hint: apiRes.status === 403 ? 'Add your Vercel domain/IP to the KundliAPI dashboard whitelist'
            : apiRes.status === 401 ? 'API key invalid or missing'
            : apiRes.status === 429 ? 'Daily credit limit reached'
            : 'See detail',
        detail: json
      });
    }

    const a = json?.responseData?.data?.[0]?.astrodata || {};

    // map KundliAPI fields -> the shape the page expects
    const reading = {
      name: name || 'friend',
      vedicSun: a.sunSign || '—',   // sidereal (Vedic) Sun sign
      moon:     a.sign || a.moonSign || '—', // Moon sign / Rashi
      nak:      a.nakshatra || '—', // birth star
      ascendant: a.ascendant || '', // Lagna
      resolved: { lat: loc.lat, lon: loc.lon, tzone: loc.tzone },
      raw: a
    };
    return res.status(200).json(reading);

  } catch (err) {
    return res.status(500).json({ error: 'Request failed', detail: String(err) });
  }
}
