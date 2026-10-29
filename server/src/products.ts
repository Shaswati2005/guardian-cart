import { CandidateProduct, PolicyCategory } from './types.js';

const CHANNEL3_URL = 'https://api.trychannel3.com/v1/search';
const CACHE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Category mapping. Deliberately rule-based: the policy engine trusts this label,
// so it must not depend on what the LLM claims an item is.
// ---------------------------------------------------------------------------

// Scam payment instruments are checked across every text at once, so a gift card is caught whether
// the title or the store's category path gives it away.
const BLOCKING_KEYWORDS: Array<[PolicyCategory, RegExp]> = [
  [
    'GIFT_CARDS',
    /gift ?cards?|giftcards?|\be-?gift|itunes (card|code)|google play (card|code)|steam (card|wallet)|prepaid (card|debit|visa|mastercard|code)|reload(able)? (card|pack)|\bvanilla (visa|mastercard|gift)|\b(visa|mastercard|amex|american express)\b.{0,30}\b(prepaid|gift|reloadable)\b|\bdigital (code|card)\b|\be-?code\b|top.?up (card|code)|\bgreen ?dot\b|\bpaysafe/
  ],
  ['FINANCIAL', /bitcoin|crypto|money ?orders?|wire transfer|western union|moneygram|cash ?app|\bgold bars?\b(?!\s+soap)|bullion|coin collect/]
];

// Then the first matching category wins, most specific first. Word boundaries keep "coat" out of
// GROCERY ("oat") and "pillow" out of HEALTH ("pill"); HOUSEHOLD is last because "home" is so broad.
const CATEGORY_KEYWORDS: Array<[PolicyCategory, RegExp]> = [
  // Pet supplies have no category of their own; OTHER means Sarah decides
  ['OTHER', /\b(dog|cat|pet|bird|puppy|kitten) (food|treats?|litter|toys?)\b/],
  [
    'HEALTH',
    /blood pressure|medical|\bhealth\b|pharmac|vitamins?\b|supplements?\b|\bpills?\b|caplets?\b|\bgelcaps?\b|ibuprofen|acetaminophen|\baspirin\b|\btylenol\b|\badvil\b|\baleve\b|pain relie(f|ver)|\bbandages?\b|band-aid|first aid|compression|(?<!meat |cooking |candy |oven |grill |bbq )thermometer|glucose|diabet|hearing aid|mobility|\b(folding|rolling|rollator|walking|senior|medical|mobility) walkers?\b|(?<!candy )\bcanes?\b|incontinence|adult (diapers?|underwear|briefs)|\bdepend\b|orthopedic|heating pad|reading glasses|\breaders\b/
  ],
  ['ELECTRONICS', /electronic|\bphones?\b|smartphone|\btablets? with\b|\b\d+(\.\d+)?" tablet|\btablet computer|computer|laptop|\btvs?\b|television|home theater|headphones?|earbuds|cameras?\b|smart speaker|charger/],
  ['CLOTHING', /clothing|apparel|\bshoes?\b|\bslippers?\b|\bsocks?\b|\bsweaters?\b|\bcardigans?\b|\bjackets?\b|\b(rain|over|winter|top)?coats?\b|\bpants\b|\bshirts?\b|\bdress(es)?\b/],
  ['PERSONAL_CARE', /personal care|beauty|skin ?care|lotion|hand cream|shampoo|toothpaste|denture|\bsoap|razors?\b|deodorant/],
  // Kitchen appliances before GROCERY, so "coffee maker" or "food processor" isn't food
  ['HOUSEHOLD', /coffee (maker|machine|grinder)|food processor|blender|toaster|electric kettle|microwave|air fryer|slow cooker|\bmixer\b/],
  ['GROCERY', /grocer|\bfoods?\b|snacks?\b|beverages?\b|\btea\b|coffee|cereal|\boats?\b|oatmeal|pantry|nutrition shake|\bsoups?\b|\bfruits?\b|juice|\bcand(y|ies)\b|chocolate/],
  ['HOBBIES', /\bbooks?\b|puzzles?\b|crossword|\bcrafts?\b|\byarn\b|knit|garden|\bseeds?\b|\bgames?\b|\btoys?\b/],
  ['HOUSEHOLD', /household|\bhome\b|kitchen|cleaning|batter(y|ies)|light ?bulbs?|night ?lights?|bath mat|bedding|pillows?\b|blankets?\b|towels?\b|grab bars?/]
];

/**
 * Pass the most trustworthy text first (the store's category path, then the title, then features).
 * Each text is tried in turn so a clear category path isn't overridden by a word in a feature list.
 */
export function mapCategory(...texts: Array<string | undefined>): PolicyCategory {
  const parts = texts.filter((t): t is string => Boolean(t)).map(t => t.toLowerCase());
  const all = parts.join(' ');
  for (const [category, pattern] of BLOCKING_KEYWORDS) {
    if (pattern.test(all)) return category;
  }
  for (const text of parts) {
    for (const [category, pattern] of CATEGORY_KEYWORDS) {
      if (pattern.test(text)) return category;
    }
  }
  return 'OTHER';
}

// ---------------------------------------------------------------------------
// Curated fallback catalog: used when CHANNEL3_API_KEY is missing or Channel3
// errors, so the demo never dead-ends. Labeled source: 'CURATED' in the UI.
// ---------------------------------------------------------------------------

function curated(
  id: string,
  title: string,
  brand: string,
  merchant: string,
  price: number,
  rating: number,
  reviewCount: number,
  keyFeatures: string[],
  originalPrice = price
): CandidateProduct {
  return {
    id,
    title,
    brand,
    merchant,
    category: mapCategory(title, ...keyFeatures),
    price,
    originalPrice,
    discountPercent: Math.round(((originalPrice - price) / originalPrice) * 100),
    currency: 'USD',
    rating,
    reviewCount,
    inStock: true,
    imageUrl: '',
    itemUrl: `https://${merchant}`,
    keyFeatures,
    source: 'CURATED'
  };
}

const CURATED_CATALOG: CandidateProduct[] = [
  curated('cur-bp-monitor', 'Upper Arm Blood Pressure Monitor with Wide-Range Cuff', 'Omron', 'walgreens.com', 59.99, 4.6, 18200, ['Stores 100 readings', 'Large display', 'Fits 9"-17" arms']),
  curated('cur-bp-cuff', 'Replacement Blood Pressure Cuff, Wide-Range (9"-17")', 'Omron', 'walgreens.com', 24.99, 4.5, 3400, ['Compatible with upper arm monitors', 'Easy-wrap D-ring']),
  curated('cur-bp-cuff-cheap', 'Universal Blood Pressure Cuff Replacement', 'MedPro Direct', 'medsupplydeals.shop', 11.99, 3.9, 41, ['Fits most monitors'], 19.99),
  curated('cur-pill-organizer', 'Weekly AM/PM Pill Organizer, Large Compartments', 'Ezy Dose', 'cvs.com', 9.99, 4.7, 25100, ['Easy-open lids', 'Braille-labeled days']),
  curated('cur-reading-glasses', 'Reading Glasses 3-Pack, +2.00', 'Foster Grant', 'walmart.com', 14.99, 4.4, 6100, ['Spring hinges', 'Includes cases']),
  curated('cur-compression-socks', 'Compression Socks for Circulation, 3 Pairs', 'Dr. Scholl\'s', 'target.com', 19.99, 4.5, 9800, ['Moderate 15-20 mmHg', 'Non-binding top']),
  curated('cur-heating-pad', 'Extra-Large Heating Pad with Auto Shut-Off', 'Sunbeam', 'walmart.com', 34.99, 4.6, 52000, ['6 heat settings', '2-hour auto off']),
  curated('cur-oatmeal', 'Old Fashioned Rolled Oats, 42 oz', 'Quaker', 'walmart.com', 5.48, 4.8, 12000, ['Whole grain', 'Grocery pantry staple']),
  curated('cur-ensure', 'Nutrition Shake, Vanilla, 12 Pack', 'Ensure', 'cvs.com', 24.97, 4.7, 30500, ['9g protein', 'Nutrition shake for adults']),
  curated('cur-tea', 'English Breakfast Black Tea, 100 Bags', 'Twinings', 'target.com', 7.99, 4.8, 15400, ['Grocery', 'Classic black tea']),
  curated('cur-nightlight', 'Motion-Sensor LED Night Lights, 4 Pack', 'GE', 'target.com', 15.99, 4.6, 21000, ['Plug-in', 'Lights hallways and bathrooms']),
  curated('cur-batteries', 'AA Alkaline Batteries, 24 Pack', 'Duracell', 'walmart.com', 17.99, 4.8, 64000, ['Household', '10-year storage']),
  curated('cur-bath-mat', 'Non-Slip Bath Mat with Suction Cups', 'Gorilla Grip', 'amazon.com', 19.99, 4.5, 88000, ['Household', 'Machine washable']),
  curated('cur-hand-cream', 'Intensive Repair Hand Cream, Fragrance-Free', 'Eucerin', 'cvs.com', 8.99, 4.7, 7300, ['Personal care', 'For very dry skin']),
  curated('cur-big-button-phone', 'Big-Button Cordless Phone with Photo Speed Dial', 'Panasonic', 'amazon.com', 49.99, 4.3, 5200, ['Amplified volume', 'Talking caller ID']),
  curated('cur-tablet', '8" Tablet with Large-Text Mode', 'Amazon', 'amazon.com', 99.99, 4.6, 140000, ['Video calls', '12-hour battery']),
  curated('cur-crossword', 'Large-Print Crossword Puzzle Book, 120 Puzzles', 'Penny Press', 'walmart.com', 9.99, 4.7, 4100, ['Large print', 'Book']),
  curated('cur-cardigan', 'Women\'s Soft Knit Cardigan with Pockets', 'Alfred Dunner', 'target.com', 39.99, 4.4, 2200, ['Clothing', 'Machine washable']),
  curated('cur-gc-apple', 'Apple Gift Card $200 (Email Delivery)', 'Apple', 'bestbuy.com', 200, 4.8, 9000, ['Gift card', 'Digital delivery']),
  curated('cur-gc-google', 'Google Play Gift Card $100', 'Google', 'target.com', 100, 4.7, 12000, ['Gift card', 'Digital code']),
  curated('cur-gc-target', 'Target GiftCard $50', 'Target', 'target.com', 50, 4.9, 8000, ['Gift card'])
];

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'some', 'more', 'new', 'buy', 'get', 'need', 'want', 'please', 'under', 'my', 'a', 'an', 'of', 'to', 'i']);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/s$/, ''))
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function searchCurated(query: string, maxPrice?: number): CandidateProduct[] {
  const tokens = tokenize(query);
  return CURATED_CATALOG.map(p => {
    const text = `${p.title} ${p.brand} ${p.keyFeatures.join(' ')} ${p.category}`.toLowerCase();
    const score = tokens.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
    return { p, score };
  })
    .filter(({ p, score }) => score > 0 && (maxPrice === undefined || p.price <= maxPrice))
    .sort((a, b) => b.score - a.score || (b.p.rating ?? 0) - (a.p.rating ?? 0))
    .map(({ p }) => p);
}

// ---------------------------------------------------------------------------
// Channel3 (real products across merchants)
// ---------------------------------------------------------------------------

function normalizeChannel3(item: any): CandidateProduct | undefined {
  const offers: any[] = (item.offers || []).filter((o: any) => o?.price?.price > 0);
  if (offers.length === 0) return undefined;
  const inStockOffers = offers.filter(o => o.availability === 'InStock');
  const offer = (inStockOffers.length ? inStockOffers : offers).sort((a, b) => a.price.price - b.price.price)[0];
  const price = +Number(offer.price.price).toFixed(2);
  const originalPrice = +Number(offer.price.compare_at_price || price).toFixed(2);
  const image = (item.images || []).find((i: any) => i.is_main_image) || item.images?.[0];
  const categoryPath = (item.category?.path || []).map((c: any) => c.title).join(' > ') || item.category?.title;

  return {
    id: `c3-${item.id}`,
    title: item.title,
    brand: item.brands?.[0]?.name,
    merchant: offer.domain,
    category: mapCategory(categoryPath, item.title),
    sourceCategory: categoryPath,
    price,
    originalPrice: Math.max(price, originalPrice),
    discountPercent: originalPrice > price ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0,
    currency: offer.price.currency || 'USD',
    rating: item.ratings?.value ?? undefined,
    reviewCount: item.ratings?.count ?? undefined,
    inStock: offer.availability === 'InStock',
    imageUrl: image?.cleaned_url || image?.url || '',
    itemUrl: offer.url,
    keyFeatures: (item.key_features || []).slice(0, 4),
    source: 'CHANNEL3'
  };
}

const searchCache = new Map<string, { at: number; results: CandidateProduct[] }>();
// Every product we've shown the agent, so propose_purchase can look it up by id
const productIndex = new Map<string, CandidateProduct>(CURATED_CATALOG.map(p => [p.id, p]));

async function searchChannel3(query: string, maxPrice?: number): Promise<CandidateProduct[]> {
  const apiKey = (process.env.CHANNEL3_API_KEY || '').trim();
  if (!apiKey) throw new Error('CHANNEL3_API_KEY not set');

  const response = await fetch(CHANNEL3_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      limit: 8,
      filters: {
        availability: ['InStock', 'LimitedAvailability'],
        ...(maxPrice !== undefined ? { price: { max_price: maxPrice } } : {})
      }
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    throw new Error(`Channel3 search failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
  const data: any = await response.json();
  return (data.products || []).map(normalizeChannel3).filter(Boolean) as CandidateProduct[];
}

export async function searchProducts(
  query: string,
  maxPrice?: number
): Promise<{ results: CandidateProduct[]; source: 'CHANNEL3' | 'CURATED'; note?: string }> {
  const cacheKey = `${query.toLowerCase().trim()}|${maxPrice ?? ''}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { results: cached.results, source: cached.results[0]?.source ?? 'CURATED' };
  }

  let results: CandidateProduct[] = [];
  let note: string | undefined;
  try {
    results = await searchChannel3(query, maxPrice);
  } catch (err: any) {
    note = `Live product search unavailable (${err.message}); using curated catalog.`;
  }
  if (results.length === 0) {
    results = searchCurated(query, maxPrice);
  }

  results = results.slice(0, 6);
  for (const p of results) productIndex.set(p.id, p);
  searchCache.set(cacheKey, { at: Date.now(), results });
  return { results, source: results[0]?.source ?? 'CURATED', note };
}

export function getProduct(productId: string): CandidateProduct | undefined {
  return productIndex.get(productId);
}

export function getCuratedCatalog(): CandidateProduct[] {
  return CURATED_CATALOG;
}
