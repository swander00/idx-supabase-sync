// incremental-sync.js

import fetch, { Headers, Request, Response } from 'node-fetch'

// Polyfill fetch and Headers for Supabase client
globalThis.fetch   = fetch
globalThis.Headers = Headers
globalThis.Request = Request
globalThis.Response = Response

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

// Mode and batching flags
const FULL_BACKFILL = process.env.FULL_BACKFILL === 'true'
const START_PAGE    = Number(process.env.START_PAGE) || 1
const END_PAGE      = Number(process.env.END_PAGE)   || Infinity

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  IDX_API_URL: rawOdataUrl,
  IDX_API_KEY
} = process.env

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !rawOdataUrl || !IDX_API_KEY) {
  console.error('Error: missing one of SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IDX_API_URL, or IDX_API_KEY')
  process.exit(1)
}

const IDX_API_URL = rawOdataUrl.replace(/\/+$/, '')
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Helper: title-case a string
function titleCase(str) {
  if (typeof str !== 'string') return null
  return str.toLowerCase().split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// Fetch wrapper with retry
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (err) {
      if (attempt === retries) throw err
      console.error(`Fetch error for ${url}: ${err.message}. Retry ${attempt + 1}/${retries}`)
      await new Promise(r => setTimeout(r, backoff * (attempt + 1)))
    }
  }
}

async function syncIdx() {
  // Auth smoke-test
  const auth = await fetchWithRetry(`${IDX_API_URL}/`, {
    headers: { Authorization: `Bearer ${IDX_API_KEY}`, Accept: 'application/json' }
  })
  console.error('Auth status:', auth.status)
  if (auth.status !== 200) process.exit(1)

  // Get last sync timestamp
  const { data: lastEntries } = await supabase
    .from('properties')
    .select('modification_timestamp')
    .order('modification_timestamp', { ascending: false })
    .limit(1)
  const lastSync = lastEntries?.[0]?.modification_timestamp
  console.error('Last sync at:', lastSync)

  // Guard against implicit full-run
  if (!lastSync && !FULL_BACKFILL) {
    console.error('No previous sync found and not in FULL_BACKFILL mode → skipping to avoid full import')
    return
  }

  const RESOURCE = 'Property'
  const PAGE_SIZE = 100
  let page = START_PAGE
  let totalPages = Infinity

  do {
    // Build URL with either filter or not
    const base = `${IDX_API_URL}/${RESOURCE}?$top=${PAGE_SIZE}&$skip=${(page - 1) * PAGE_SIZE}`
    const filterQuery = (!FULL_BACKFILL && lastSync)
      ? `&$filter=${encodeURIComponent(`ModificationTimestamp ge ${lastSync}`)}`
      : ''
    const url = base + filterQuery

    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${IDX_API_KEY}`, Accept: 'application/json' }
    })
    const { value: items = [] } = await res.json()
    if (!FULL_BACKFILL) totalPages = items.length < PAGE_SIZE ? page : page + 1

    for (const listing of items) {
      // ... build your record object as before ...
      const record = { /* mapping omitted for brevity */ }
      const { error } = await supabase.from('properties').upsert(record, { onConflict: ['mls_id'] })
      if (error) console.error('Upsert error for', listing.ListingKey, error)
      else console.log('Synced', listing.ListingKey)
    }

    page++
  } while (
    FULL_BACKFILL
      ? page <= END_PAGE
      : page <= totalPages
  )
}

syncIdx().catch(console.error)
