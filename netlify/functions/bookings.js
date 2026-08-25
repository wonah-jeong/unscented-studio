// Netlify Function: GET /.netlify/functions/bookings
//
// Reads the "예약" (booking) table directly from Airtable's REST API — this is a
// separate, lightweight table that unscented-clone.html's admin panel keeps in sync
// on every add/edit/delete, independent of whether a customer/payment record exists
// for that booking. It only ever contains public-safe data: masked name, last-4
// phone digits, party size, memo, store, date, start/end time. No business, contact,
// or payment info lives here.
//
// Requires one environment variable, set in the Netlify site's dashboard:
//   AIRTABLE_TOKEN — a read-only Airtable Personal Access Token scoped to just this
//                    base (or at minimum this table).

const BASE_ID = 'appqaKTXKBotjTh1f';
const TABLE_ID = 'tblWqZsUETGKNjuSX';
const F = {
  store: 'fldR3zSX3esQL5pMu',
  date: 'fld0CwAcWCEz88x97',
  start: 'fldXqLCyVwzpSQ8BJ',
  end: 'fldqR7BGIvD8soGOT',
  name: 'fld4BtLHAfFOUbFrS',
  phone4: 'fldqnLZBMwfKmi8U1',
  party: 'fldHA5JKS7ro9qHnL',
  note: 'fldNrOzFfgvI2RdC7'
};

function fieldVal(v) {
  return v && typeof v === 'object' && 'name' in v ? v.name : v;
}

async function fetchAllRecords(token) {
  var records = [];
  var offset;
  do {
    var url = 'https://api.airtable.com/v0/' + BASE_ID + '/' + TABLE_ID +
      '?pageSize=100&fields[]=' + Object.values(F).join('&fields[]=') +
      (offset ? '&offset=' + offset : '');
    var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      var body = await res.text().catch(function () { return ''; });
      throw new Error('Airtable ' + res.status + ': ' + body.slice(0, 300));
    }
    var json = await res.json();
    records = records.concat(json.records || []);
    offset = json.offset;
  } while (offset);
  return records;
}

export default async (req) => {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'not_configured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }

  try {
    const records = await fetchAllRecords(token);
    const out = { first: {}, second: {} };
    for (const rec of records) {
      const f = rec.fields || {};
      const storeName = fieldVal(f[F.store]);
      const storeKey = storeName === '1호점' ? 'first' : storeName === '2호점' ? 'second' : null;
      const iso = f[F.date];
      if (!storeKey || !iso) continue;
      if (!out[storeKey][iso]) out[storeKey][iso] = [];
      out[storeKey][iso].push({
        start: f[F.start] || '',
        end: f[F.end] || '',
        name: f[F.name] || '',
        phone4: f[F.phone4] || '',
        party: f[F.party] || '',
        note: f[F.note] || ''
      });
    }
    for (const storeKey of ['first', 'second']) {
      for (const iso of Object.keys(out[storeKey])) {
        out[storeKey][iso].sort((a, b) => (a.start < b.start ? -1 : 1));
      }
    }
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=30'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'fetch_failed', message: String(err && err.message || err) }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }
};
