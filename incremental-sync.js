import fetch, { Headers, Request, Response } from 'node-fetch'

// Polyfill browser globals for Supabase’s fetch-based client
globalThis.fetch   = fetch
globalThis.Headers = Headers
globalThis.Request = Request
globalThis.Response = Response

// incremental-sync.js

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  IDX_API_URL: rawOdataUrl,
  IDX_API_KEY
} = process.env

if (
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !rawOdataUrl ||
  !IDX_API_KEY
) {
  console.error(
    'Error: one of SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IDX_API_URL or IDX_API_KEY is missing'
  )
  process.exit(1)
}

// Helper to Title-Case a string
function titleCase(str) {
  if (typeof str !== 'string') return null
  return str
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// Fetch wrapper with retries and exponential backoff
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

const IDX_API_URL = rawOdataUrl.replace(/\/+$/, '')
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function syncIdx() {
  // 1) Auth smoke-test
  const authTest = await fetchWithRetry(`${IDX_API_URL}/`, {
    headers: { Authorization: `Bearer ${IDX_API_KEY}`, Accept: 'application/json' }
  })
  console.error('Auth test status:', authTest.status)
  if (authTest.status !== 200) process.exit(1)

  // 2) Determine last sync timestamp from Supabase
  const { data: lastEntries } = await supabase
    .from('properties')
    .select('modification_timestamp')
    .order('modification_timestamp', { ascending: false })
    .limit(1)
  const lastSync = lastEntries?.[0]?.modification_timestamp
  console.error('Last sync at:', lastSync)

  // helper to build arrays of title-cased values
  const buildArray = field => {
    if (Array.isArray(field)) return field.filter(Boolean).map(f => titleCase(f))
    if (typeof field === 'string') return field
      .split(',')
      .map(s => s.trim())
      .map(s => titleCase(s))
      .filter(Boolean)
    return []
  }

  // 3) Fetch & upsert paged "Property" records incrementally
  const RESOURCE = 'Property'
  const PAGE_SIZE = 100
  let page = 1, totalPages = 1

  do {
    // build OData filter for incremental fetch
    const filters = []
    if (lastSync) filters.push(`ModificationTimestamp ge ${lastSync}`)
    const filterQuery = filters.length
      ? `&$filter=${encodeURIComponent(filters.join(' and '))}`
      : ''

    const url =
      `${IDX_API_URL}/${RESOURCE}?$top=${PAGE_SIZE}` +
      `&$skip=${(page - 1) * PAGE_SIZE}` +
      filterQuery

    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${IDX_API_KEY}`, Accept: 'application/json' }
    })
    const { value: items = [] } = await res.json()
    totalPages = items.length < PAGE_SIZE ? page : page + 1

    for (const listing of items) {
      // fetch media for this listing
      let image_urls = []
      try {
        const mediaUrl =
          `${IDX_API_URL}/Media?$select=MediaURL&$filter=` +
          encodeURIComponent(`ResourceName eq 'Property' and ResourceRecordKey eq '${listing.ListingKey}'`)
        const mediaRes = await fetchWithRetry(mediaUrl, {
          headers: { Authorization: `Bearer ${IDX_API_KEY}`, Accept: 'application/json' }
        })
        const { value: mediaItems = [] } = await mediaRes.json()
        image_urls = mediaItems.map(m => m.MediaURL)
      } catch (err) {
        console.error('Media fetch error for', listing.ListingKey, err.message)
      }

      // build feature arrays
      const property_features   = buildArray(listing.PropertyFeatures)
      if (listing.InteriorFeatures) property_features.unshift(titleCase(listing.InteriorFeatures))
      if (listing.FireplaceYN === 'Y') property_features.push('Fireplace')
      if (listing.PoolFeatures) property_features.push(titleCase(listing.PoolFeatures))

      const condo_amenities      = buildArray(listing.AssociationAmenities)
      const condo_fee_inclusions = buildArray(listing.AssociationFeeIncludes)
      const waterfront_features  = buildArray(listing.WaterfrontFeatures)
      const extras               = buildArray(listing.PublicRemarksExtras)
      const exterior_features    = buildArray(listing.ExteriorFeatures)

      // upsert record with retry
      let upsertError
      for (let attempt = 0; attempt < 3; attempt++) {
        const { error } = await supabase
          .from('properties')
          .upsert({
            mls_id:                        listing.ListingKey,
            mls_status:                    listing.MlsStatus,
            property_class:                titleCase(listing.PropertyType),
            transaction_type:              titleCase(listing.TransactionType),
            standard_status:               titleCase(listing.StandardStatus),
            air_conditioner:               listing.Cooling,
            acres:                         listing.LotSizeRangeAcres,
            age:                           listing.ApproximateAge,
            basement_kitchen:              listing.KitchensBelowGrade,
            basement_status:               listing.Basement,
            bedrooms:                      listing.BedroomsAboveGrade,
            bedrooms_basement:             listing.BedroomsBelowGrade,
            city:                          titleCase(listing.City),
            community:                     titleCase(listing.CityRegion),
            contract_status:               listing.ContractStatus,
            description:                   titleCase(listing.PublicRemarks),
            drive_parking:                 listing.ParkingSpaces,
            garage_parking_spaces:         listing.GarageParkingSpaces,
            heat_source:                   listing.HeatSource,
            heat_type:                     listing.HeatType,
            kitchen:                       listing.KitchensAboveGrade,
            list_price:                    listing.ListPrice,
            listing_end_date:              listing.ExpirationDate,
            lot_depth:                     listing.LotDepth,
            lot_frontage:                  listing.LotWidth,
            lot_size_units:                listing.LotSizeUnits,
            media_change_timestamp:        listing.MediaChangeTimestamp,
            photos_change_timestamp:       listing.PhotosChangeTimestamp,
            modification_timestamp:        listing.ModificationTimestamp,
            system_modification_timestamp: listing.SystemModificationTimestamp,
            posession:                     titleCase(listing.PossessionDetails ?? listing.PossessionType),
            postal_code:                   listing.PostalCode,
            potl:                          listing.ParcelOfTiedLand,
            property_sub_type:             titleCase(listing.PropertySubType ?? listing.ArchitecturalStyle),
            property_features,
            property_tax:                  listing.TaxAnnualAmount,
            province:                      titleCase(listing.StateOrProvince),
            region:                        titleCase(listing.CountyOrParish),
            sewer:                         listing.Sewer,
            square_footage:                listing.LivingAreaRange,
            street_name:                   titleCase(listing.StreetName),
            street_number:                 listing.StreetNumber,
            street_suffix:                 titleCase(listing.StreetSuffix),
            tax_year:                      listing.TaxYear,
            total_bathrooms:               listing.BathroomsTotalInteger,
            total_parking:                 listing.ParkingTotal,
            unparsed_address:              titleCase(listing.UnparsedAddress),
            water_source:                  listing.WaterSource,
            virtual_tour_branded:          listing.VirtualTourURLBranded,
            virtual_tour_unbranded:        listing.VirtualTourURLUnbranded,
            waterfront_yn:                 listing.WaterfrontYN === 'Y',
            waterfront_features,
            extras,
            pets_allowed_yn:               listing.PetsAllowed === 'Y',
            room_height_yn:                listing.RoomHeight === 'Y',
            den_family_room_yn:            listing.DenFamilyroomYN === 'Y',
            room_type:                     titleCase(listing.RoomType),
            additional_monthly_fee:        listing.AdditionalMonthlyFee,
            locker:                        titleCase(listing.Locker),
            exterior_features,
            condo_amenities,
            condo_balcony:                 titleCase(listing.BalconyType),
            condo_fee_inclusions,
            condo_garage_type:             titleCase(listing.GarageType),
            condo_laundry:                 titleCase(listing.LaundryFeatures),
            condo_locker:                  titleCase(listing.Locker),
            condo_maintenance_fee:         listing.AssociationFee,
            apartment_number:              listing.PropertyType === 'Residential Condo' ? listing.ApartmentNumber : null,
            lease_includes:                titleCase(listing.RentIncludes),
            lease_furnished:               listing.Furnished,
            portion_for_lease:             listing.ContractStatus === 'Lease' ? listing.UnitNumber : null,
            image_urls
          }, { onConflict: ['mls_id'] })
        if (!error) {
          upsertError = null
          break
        }
        upsertError = error
        console.error(`Upsert error (attempt ${attempt+1}):`, error)
      }
      if (upsertError) console.error('Final upsert error for', listing.ListingKey, upsertError)
      else console.log('Synced', listing.ListingKey)
    }

    page++
  } while (page <= totalPages)
}

syncIdx().catch(console.error)
