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

  const { name, dob, tob, place, lat, lon, tz } = req.body || {};
  if (!dob) return res.status(400).json({ error: 'Date of birth is required' });

  const [year, month, day] = dob.split('-').map(Number);
  const [hour = 12, min = 0] = (tob || '12:00').split(':').map(Number);

  // Prefer exact coordinates from the picked location (most accurate).
  // Only fall back to server-side geocoding, then to a default, if needed.
  let loc = null;
  if (lat != null && lon != null) {
    loc = { lat: Number(lat), lon: Number(lon), tzone: tz ? tzOffset(tz, year, month, day) : 0 };
  } else if (place) {
    loc = await geocode(place, year, month, day);
  }
  if (!loc) loc = { lat: 30.2672, lon: -97.7431, tzone: -6 }; // last-resort fallback

  const birthData = { day, month, year, hour, min, lat: loc.lat, lon: loc.lon, tzone: loc.tzone, lang: 'en' };

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

    // KundliAPI returns the astro fields either under .astrodata or at the
    // top level of data[0]; support both. Values come back in Devanagari.
    const d0 = json?.responseData?.data?.[0] || {};
    const a = d0.astrodata || d0;

    // Devanagari -> English lookups for the fields we display
    const SIGNS_HI = {
      'मेष':'Aries','वृषभ':'Taurus','वृष':'Taurus','मिथुन':'Gemini','कर्क':'Cancer',
      'सिंह':'Leo','कन्या':'Virgo','तुला':'Libra','वृश्चिक':'Scorpio','वृश्चिक्':'Scorpio',
      'धनु':'Sagittarius','मकर':'Capricorn','कुम्भ':'Aquarius','कुंभ':'Aquarius','मीन':'Pisces'
    };
    const NAK_HI = {
      'अश्विनी':'Ashwini','भरणी':'Bharani','कृत्तिका':'Krittika','रोहिणी':'Rohini',
      'मृगशिरा':'Mrigashira','मृगशीर्ष':'Mrigashira','आर्द्रा':'Ardra','पुनर्वसु':'Punarvasu',
      'पुष्य':'Pushya','आश्लेषा':'Ashlesha','मघा':'Magha','पूर्वाफाल्गुनी':'Purva Phalguni',
      'पूर्व फाल्गुनी':'Purva Phalguni','उत्तराफाल्गुनी':'Uttara Phalguni','उत्तर फाल्गुनी':'Uttara Phalguni',
      'हस्त':'Hasta','चित्रा':'Chitra','स्वाति':'Swati','स्वाती':'Swati','विशाखा':'Vishakha',
      'अनुराधा':'Anuradha','ज्येष्ठा':'Jyeshtha','मूल':'Mula','मूला':'Mula',
      'पूर्वाषाढ़ा':'Purva Ashadha','पूर्वाषाढा':'Purva Ashadha','उत्तराषाढ़ा':'Uttara Ashadha',
      'उत्तराषाढा':'Uttara Ashadha','श्रवण':'Shravana','धनिष्ठा':'Dhanishta','शतभिषा':'Shatabhisha',
      'पूर्वाभाद्रपदा':'Purva Bhadrapada','पूर्व भाद्रपद':'Purva Bhadrapada',
      'उत्तराभाद्रपदा':'Uttara Bhadrapada','उत्तर भाद्रपद':'Uttara Bhadrapada','रेवती':'Revati'
    };

    // read a field value whether it's a string or an object like {name:"..."}
    const val = (...vals) => {
      for (const v of vals) {
        if (v == null) continue;
        if (typeof v === 'object') { if (v.name) return v.name; continue; }
        return v;
      }
      return null;
    };
    const enSign = v => SIGNS_HI[(v||'').trim()] || v || '—';
    const enNak  = v => NAK_HI[(v||'').trim()] || v || '—';

    // Sidereal Sun sign isn't in basic astro data, so derive it from the birth
    // date (sidereal/Lahiri). Moon, nakshatra & ascendant come from the API.
    const SID = [["Sagittarius",1,14],["Capricorn",2,12],["Aquarius",3,14],["Pisces",4,13],
      ["Aries",5,14],["Taurus",6,14],["Gemini",7,16],["Cancer",8,16],["Leo",9,16],
      ["Virgo",10,17],["Libra",11,16],["Scorpio",12,15],["Sagittarius",12,31]];
    const siderealSun = (() => { for (const [n,mm,dd] of SID){ if(month<mm||(month===mm&&day<=dd)) return n; } return "Sagittarius"; })();

    const reading = {
      name: name || 'friend',
      vedicSun:  siderealSun,                                                  // sidereal Sun
      moon:      enSign(val(a.moonSign, a.sign, a.rashi)),                       // Moon / Rashi
      nak:       enNak(val(a.naksahtra, a.nakshatra, a.nakshatraName, a.star)),  // birth star (note API typo)
      ascendant: enSign(val(a.ascendant, a.lagna, a.asc)),                       // Lagna
      resolved: { place: place || null, lat: loc.lat, lon: loc.lon, tzone: loc.tzone },
      raw: a
    };
    return res.status(200).json(reading);

  } catch (err) {
    return res.status(500).json({ error: 'Request failed', detail: String(err) });
  }
}
