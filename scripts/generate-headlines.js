/**
 * Plantz News Agent - Headline Generation Script (v2.0)
 *
 * Runs every Monday at 6am UTC. Generates 10 article headlines
 * with full writing prompts and creates them in the Headline Queue
 * with status: "draft" for human review.
 *
 * v2.0 overhaul:
 *   - Topic pool now draws from MULTIPLE Pinecone namespaces:
 *       * plantz-products  — herbs/supplements WE SELL (primary source)
 *       * cannabis_faq     — 215 FAQs to expand into deep-dive articles
 *       * cannabis         — condition-based angles (can cannabis help X?)
 *       * herb_monographs  — supporting deep science, ONLY for herbs we sell
 *   - Expanded angle set including cannabis and hardware/device angles
 *   - Hard quota: at least 1 (ideally 2) women's health headlines per batch
 *   - Batch composition targets to avoid herb-only articles
 *   - plantz-products filtered by plantz_sells=true to kill off-catalogue articles
 *   - Hook added for The Women's Circle video-quote corpus (not yet ingested)
 *
 * v1.1 legacy: always generates 10 headlines unconditionally on Mondays.
 *
 * The script:
 * 1. Checks it's Monday (skips otherwise, unless --force)
 * 2. Samples topics from 4 Pinecone namespaces per composition rules
 * 3. Fetches recently published subjects to avoid repetition
 * 4. Calls Claude to generate 10 headlines with full article prompts
 * 5. Creates records in Headline Queue with status: "draft"
 * 6. Sends Discord notification
 *
 * Env vars (must match .env naming):
 *   ANTHROPIC_API_KEY, AIRTABLE_API_KEY, PINECONE_API_KEY,
 *   DISCORD_WEBHOOK_NOTIFICATIONS
 */

import Anthropic from '@anthropic-ai/sdk';
import Airtable from 'airtable';

// Configuration
const CONFIG = {
  airtable: {
    baseId: 'appN9kmTgJbjel4J1',
    headlineTable: 'tbl00YTHfrVnKQQai',
    articlesTable: 'tblUhbxC3LIKgORLa'
  },
  pinecone: {
    host: 'https://plantz1-aokppsg.svc.gcp-europe-west4-de1d.pinecone.io'
  },
  headlinesToGenerate: 10,
  // Target batch composition (guidance to Claude, not enforced post-hoc):
  //   2–3 product_deep_dive (herbs/supplements we sell)
  //   2   cannabis_condition
  //   1–2 faq_deep_dive (expand a cannabis FAQ)
  //   1–2 womens_health  (hard minimum = 1)
  //   1   buying_intent_device (vapes / hardware)
  //   1–2 research_roundup / mechanism_explainer / myth_busting / industry_story
  batchComposition: {
    product_deep_dive:    { min: 2, max: 3 },
    cannabis_condition:   { min: 2, max: 2 },
    faq_deep_dive:        { min: 1, max: 2 },
    womens_health:        { min: 1, max: 2 },
    buying_intent_device: { min: 1, max: 1 },
    flex:                 { min: 1, max: 2 } // research_roundup / mechanism_explainer / myth_busting / industry_story / seasonal
  }
};

const FORCE = process.argv.includes('--force');

// Initialize clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(CONFIG.airtable.baseId);

// ── Monday Check ───────────────────────────────────────────────────────────

function isMonday() {
  return new Date().getUTCDay() === 1;
}

// ── Discord ────────────────────────────────────────────────────────────────

async function sendDiscordNotification(message, isError = false) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_NOTIFICATIONS;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: isError ? '❌ Headline Generation Error' : '📋 New Headlines Ready for Review',
          description: message,
          color: isError ? 0xFF0000 : 0x58B09C,
          timestamp: new Date().toISOString()
        }]
      })
    });
  } catch (error) {
    console.error('Failed to send Discord notification:', error);
  }
}

// ── Airtable Queries ───────────────────────────────────────────────────────

async function getRecentSubjects(limit = 40) {
  return new Promise((resolve, reject) => {
    const subjects = [];
    airtable(CONFIG.airtable.articlesTable)
      .select({
        maxRecords: limit,
        fields: ['subject', 'article_title', 'angle'],
        sort: [{ field: 'Created', direction: 'desc' }]
      })
      .eachPage(
        (records, next) => {
          records.forEach(r => {
            const subj = r.get('subject');
            if (subj) subjects.push({
              subject: subj,
              title: r.get('article_title') || '',
              angle: r.get('angle') || ''
            });
          });
          next();
        },
        (err) => err ? reject(err) : resolve(subjects)
      );
  });
}

async function getRecentHeadlineSubjects(limit = 40) {
  return new Promise((resolve, reject) => {
    const subjects = [];
    airtable(CONFIG.airtable.headlineTable)
      .select({
        maxRecords: limit,
        fields: ['subject', 'headline'],
        sort: [{ field: 'Last Modified', direction: 'desc' }]
      })
      .eachPage(
        (records, next) => {
          records.forEach(r => {
            const subj = r.get('subject');
            if (subj) subjects.push(subj);
          });
          next();
        },
        (err) => err ? reject(err) : resolve(subjects)
      );
  });
}

// ── Pinecone: Sample the Topic Pool ────────────────────────────────────────

async function queryPinecone(namespace, text, topK = 5, filter = null) {
  try {
    const body = { query: { topK, inputs: { text } } };
    if (filter) body.query.filter = filter;

    const response = await fetch(
      `${CONFIG.pinecone.host}/records/namespaces/${namespace}/search`,
      {
        method: 'POST',
        headers: {
          'Api-Key': process.env.PINECONE_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      console.error(`   ⚠️ Pinecone ${namespace} query failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.result?.hits || [];
  } catch (error) {
    console.error(`   ⚠️ Pinecone ${namespace} error:`, error.message);
    return [];
  }
}

/**
 * Build a rich topic pool by sampling each namespace with varied seed queries.
 * Returns an object with discrete buckets — each bucket becomes input for a
 * specific angle category in the headline prompt.
 */
async function buildTopicPool() {
  const pool = {
    productsWeSell: [],       // herbs/supplements from plantz-products (herbal_products)
    devicesWeSell: [],        // vaporisers / hardware from plantz-products
    cannabisFaqs: [],         // questions from cannabis_faq
    cannabisConditions: [],   // condition-related cannabis content
    herbSupportingScience: [] // deep research snippets for herbs we sell
  };

  console.log('\n🔍 Sampling topic pool from Pinecone...');

  // ── 1. Herbs/supplements we sell ──────────────────────────────────────────
  // These queries prime the 'plantz-products' namespace to surface a variety
  // of the 56+ product lines Neil has uploaded.
  const productSeeds = [
    'adaptogen stress supplement',
    'immune support mushroom',
    'sleep magnesium herbal tea',
    'womens hormone balance supplement',
    'gut health digestive bitter',
    'joint pain inflammation herbal',
    'energy B vitamin tonic',
    'liver detox milk thistle',
    'skin collagen silica herbal',
    'mood anxiety calm herb'
  ];

  const productSeenIds = new Set();
  for (const seed of productSeeds) {
    const hits = await queryPinecone('plantz-products', seed, 4);
    for (const hit of hits) {
      const f = hit.fields || {};
      if (f.plantz_sells !== 'true') continue;
      if (f.taxonomy_node === 'vaporisers') continue; // handled separately
      const canonicalId = f.docCanonicalId;
      if (!canonicalId || productSeenIds.has(canonicalId)) continue;
      productSeenIds.add(canonicalId);
      pool.productsWeSell.push({
        name: f.substance_common_name || f.title || 'Unknown',
        brand: f.product_brand || '',
        subcategory: f.product_subcategory || '',
        healthGoals: Array.isArray(f.health_goal) ? f.health_goal : [],
        keywords: Array.isArray(f.keywords) ? f.keywords.slice(0, 4) : [],
        evidenceGrade: f.evidence_grade || 'N/A',
        substance: f.substance || '',
        sku: f.sku || ''
      });
    }
  }
  console.log(`   plantz-products (herbs): ${pool.productsWeSell.length} unique products`);

  // ── 2. Hardware / vape devices we sell ────────────────────────────────────
  const deviceSeeds = [
    'dry herb vaporiser flower',
    'portable vape pen battery',
    'desktop vaporiser session',
    'grinder rolling accessory',
    'vape cartridge 510 thread'
  ];

  const deviceSeenIds = new Set();
  for (const seed of deviceSeeds) {
    const hits = await queryPinecone('plantz-products', seed, 4);
    for (const hit of hits) {
      const f = hit.fields || {};
      if (f.plantz_sells !== 'true') continue;
      if (f.taxonomy_node !== 'vaporisers' && f.product_category !== 'Vaporiser') continue;
      const canonicalId = f.docCanonicalId;
      if (!canonicalId || deviceSeenIds.has(canonicalId)) continue;
      deviceSeenIds.add(canonicalId);
      pool.devicesWeSell.push({
        name: f.title || 'Unknown device',
        brand: f.product_brand || '',
        subcategory: f.product_subcategory || '',
        taxonomy: f.taxonomy_path || '',
        keywords: Array.isArray(f.keywords) ? f.keywords.slice(0, 4) : []
      });
    }
  }
  console.log(`   plantz-products (devices): ${pool.devicesWeSell.length} unique devices`);

  // ── 3. Cannabis FAQs — each is a potential article ────────────────────────
  const faqSeeds = [
    'medical cannabis prescription eligibility UK',
    'cannabis side effects safety',
    'cannabis strains terpenes',
    'cannabis driving workplace legal',
    'cannabis cost private prescription',
    'cannabis dosing titration patient',
    'cannabis oil flower vaporiser administration'
  ];

  const faqSeenIds = new Set();
  for (const seed of faqSeeds) {
    const hits = await queryPinecone('cannabis_faq', seed, 4);
    for (const hit of hits) {
      const f = hit.fields || {};
      if (faqSeenIds.has(hit._id)) continue;
      faqSeenIds.add(hit._id);
      pool.cannabisFaqs.push({
        question: f.question || '',
        summary: f.answer_summary || '',
        category: f.category || '',
        tags: Array.isArray(f.tags) ? f.tags : [],
        audience: f.audience || 'patient'
      });
    }
  }
  console.log(`   cannabis_faq: ${pool.cannabisFaqs.length} unique FAQs`);

  // ── 4. Cannabis + conditions ──────────────────────────────────────────────
  const conditionSeeds = [
    'cannabis endometriosis period pain',
    'cannabis chronic pain fibromyalgia',
    'cannabis anxiety PTSD mental health',
    'cannabis sleep insomnia',
    'cannabis multiple sclerosis MS',
    'cannabis menopause hormonal',
    'cannabis migraine headache',
    'cannabis IBS inflammatory bowel',
    'cannabis cancer palliative',
    'cannabis ADHD focus'
  ];

  const conditionSeen = new Set();
  for (const seed of conditionSeeds) {
    const hits = await queryPinecone('cannabis', seed, 3);
    for (const hit of hits) {
      const text = hit.fields?.text || '';
      if (text.length < 40) continue;
      const key = text.substring(0, 80);
      if (conditionSeen.has(key)) continue;
      conditionSeen.add(key);
      pool.cannabisConditions.push({
        snippet: text.substring(0, 300),
        seed
      });
      if (pool.cannabisConditions.length >= 25) break;
    }
    if (pool.cannabisConditions.length >= 25) break;
  }
  console.log(`   cannabis: ${pool.cannabisConditions.length} condition snippets`);

  // ── 5. Supporting science for herbs we sell ───────────────────────────────
  // Only query monographs for products we actually stock — this is the key
  // fix that stops articles about herbs we don't sell.
  const topProducts = pool.productsWeSell.slice(0, 8);
  for (const product of topProducts) {
    const seed = `${product.name} mechanism clinical evidence`;
    const hits = await queryPinecone('herb_monographs', seed, 2);
    for (const hit of hits) {
      const text = hit.fields?.text || '';
      if (text.length < 60) continue;
      pool.herbSupportingScience.push({
        product: product.name,
        snippet: text.substring(0, 250)
      });
    }
  }
  console.log(`   herb_monographs (targeted): ${pool.herbSupportingScience.length} snippets`);

  return pool;
}

// ── Claude: Generate Headlines ─────────────────────────────────────────────

function formatPoolForPrompt(pool) {
  const products = pool.productsWeSell.map((p, i) =>
    `${i + 1}. ${p.name}${p.brand ? ` (${p.brand})` : ''} — ${p.subcategory}; goals: ${p.healthGoals.join(', ') || 'n/a'}; evidence: ${p.evidenceGrade}`
  ).join('\n');

  const devices = pool.devicesWeSell.map((d, i) =>
    `${i + 1}. ${d.name}${d.brand ? ` (${d.brand})` : ''} — ${d.subcategory}`
  ).join('\n');

  const faqs = pool.cannabisFaqs.slice(0, 20).map((f, i) =>
    `${i + 1}. [${f.category}] ${f.question}${f.summary ? ` — ${f.summary.substring(0, 150)}` : ''}`
  ).join('\n');

  const conditions = [...new Set(pool.cannabisConditions.map(c => c.seed))].join(', ');

  const support = pool.herbSupportingScience.slice(0, 6).map((s, i) =>
    `${i + 1}. [${s.product}] ${s.snippet.substring(0, 180)}`
  ).join('\n');

  return { products, devices, faqs, conditions, support };
}

async function generateHeadlines(recentSubjects, pool) {
  const recentList = recentSubjects.slice(0, 20).map(s =>
    `- ${s.subject} (${s.angle})`
  ).join('\n');
  const recentSubjectNames = [...new Set(recentSubjects.map(s => s.subject))].slice(0, 30).join(', ');

  const formatted = formatPoolForPrompt(pool);
  const comp = CONFIG.batchComposition;

  const systemPrompt = `You are the Plantz editorial planner. You generate weekly article headlines and writing briefs for Plantz.io — a UK-based natural health platform covering herbal medicine, supplements, and medical cannabis.

AUDIENCE MIX (each headline targets ONE persona):
• AISHA — UK woman 28–40, wellness-curious, evidence-minded. Primary audience for herbs, supplements, women's health content.
• CHLOE — 32, anxious newcomer to medical cannabis. Target for FAQ-based and accessible cannabis condition content.
• DAVID — 45, expert cannabis patient. Target for device buying-intent, deep cannabis science, strain/terpene content.
• DR CARTER — clinician. Occasional target for clinically framed cannabis condition pieces.

HARD CONTENT RULES:
1. Only write about herbs and supplements we ACTUALLY SELL. The approved product list below is the only valid pool for "product_deep_dive" angles. Do not invent or substitute herbs not on the list.
2. UK regulatory compliant phrasing in every article_prompt. Use "research suggests", "may support", "traditionally used for". Never "cures", "treats", "prevents".
3. Women's health is a company priority. You MUST produce at least 1 (ideally 2) headlines in the womens_health angle per batch, covering period pain, endometriosis, PMS, perimenopause, menopause, fertility, or PCOS.
4. Hardware/device articles are BUYING-INTENT: comparisons, how-to guides, "which vape for X", "how to use Y", beginner's guide, troubleshooting. Not lifestyle.
5. Cannabis FAQ expansions should take a single FAQ and deep-dive it into a 1,000-word article with nuance, sources, and practical guidance.
6. Cannabis condition articles follow the pattern "Can Cannabis Help with {Condition}?" or variants — grounded in the endocannabinoid system and cited research.

You must return ONLY valid JSON — no markdown, no explanation, no preamble.`;

  const userPrompt = `Generate exactly 10 article headlines for this week's content batch.

══════════════════════════════════════════════════════════════════
RECENTLY COVERED — DO NOT REPEAT THESE SUBJECTS OR ANGLES
══════════════════════════════════════════════════════════════════
${recentList || '(none yet)'}

Subjects to avoid: ${recentSubjectNames || 'none'}

══════════════════════════════════════════════════════════════════
APPROVED TOPIC POOL — YOU MUST DRAW FROM HERE
══════════════════════════════════════════════════════════════════

## HERBS & SUPPLEMENTS WE SELL (for product_deep_dive angles)
${formatted.products || '(none sampled)'}

## DEVICES / HARDWARE WE SELL (for buying_intent_device angles)
${formatted.devices || '(none sampled)'}

## CANNABIS FAQs (for faq_deep_dive angles — expand any one of these into an article)
${formatted.faqs || '(none sampled)'}

## CANNABIS + CONDITION AREAS (for cannabis_condition angles)
Available condition themes: ${formatted.conditions || 'general pain, anxiety, sleep'}

## SUPPORTING SCIENCE NOTES (for reference when writing product deep-dives)
${formatted.support || '(none)'}

══════════════════════════════════════════════════════════════════
REQUIRED BATCH COMPOSITION (must hit each minimum)
══════════════════════════════════════════════════════════════════
• product_deep_dive:    ${comp.product_deep_dive.min}–${comp.product_deep_dive.max}  (herbs/supplements from the list above)
• cannabis_condition:   ${comp.cannabis_condition.min}–${comp.cannabis_condition.max}  (cannabis for a specific condition)
• faq_deep_dive:        ${comp.faq_deep_dive.min}–${comp.faq_deep_dive.max}  (expand one cannabis FAQ)
• womens_health:        ${comp.womens_health.min}–${comp.womens_health.max}  (HARD MINIMUM — cannabis OR herbal angle)
• buying_intent_device: ${comp.buying_intent_device.min}–${comp.buying_intent_device.max}  (vape/device how-to or comparison)
• flex slot(s):         ${comp.flex.min}–${comp.flex.max}  (one of: research_roundup, mechanism_explainer, myth_busting, industry_story, seasonal)

Total MUST equal exactly 10.

══════════════════════════════════════════════════════════════════
OUTPUT FORMAT
══════════════════════════════════════════════════════════════════
Return a JSON array of exactly 10 objects. Each object:

{
  "headline": "The full article title, SEO-optimised, compelling for the target persona",
  "subject": "Single topic name (e.g. Ashwagandha, Endometriosis and Cannabis, PAX Mini 2 vs G Pen Dash, Medical Cannabis Eligibility)",
  "angle": "product_deep_dive | cannabis_condition | faq_deep_dive | womens_health | buying_intent_device | research_roundup | mechanism_explainer | myth_busting | industry_story | seasonal",
  "persona": "aisha | chloe | david | dr_carter",
  "seo_keyword": "Primary search term to target",
  "pinecone_namespaces": ["array of namespaces to query for evidence: one or more of plantz-products, herb_monographs, cannabis_faq, cannabis, cannabis_products, natural_remedies"],
  "pinecone_queries": ["3–4 specific search strings to run in those namespaces"],
  "article_prompt": "Full writing brief — see template below",
  "target_word_count": 1000,
  "priority_order": 1
}

### article_prompt template (adapt per angle):

TOPIC: [Subject] — [what the article is about in one sentence]
ANGLE: [angle] — [what structure this implies]
PERSONA: [persona] — [tone implications]
PRIMARY SEO KEYWORD: [keyword]

KEY POINTS TO COVER:
- [6–8 specific points, angle-appropriate]

ANGLE-SPECIFIC REQUIREMENTS:
[One of the following blocks based on angle]

  IF product_deep_dive:
    - Lead with the mechanism, not the claim
    - Cite 2–3 specific studies where possible (name the compound, the effect, the trial type)
    - Include a "what to look for" section (standardisation, dose, format)
    - End with a natural mention of the product we stock (brand + format), NOT a hard sell
    - UK compliance: "research suggests", "may support", "traditionally used for"

  IF cannabis_condition:
    - Open with a brief scene/stat about the condition's prevalence or under-treatment
    - Explain the endocannabinoid system's role in this condition (1 section)
    - Summarise the evidence — what studies exist, what they show, what's missing
    - Cover cannabinoid profiles most studied for this condition (THC:CBD ratios, terpenes)
    - Address common patient concerns (side effects, interactions, daytime use)
    - Route to Doctors Assist / Strain Selector where natural
    - UK legal framing throughout: private prescription only, Schedule 2

  IF faq_deep_dive:
    - Quote the original FAQ question in section 1
    - Give the short answer up front (TL;DR, 2–3 sentences)
    - Then go 800 words deeper: history, nuance, exceptions, edge cases
    - Link to adjacent FAQs (suggest 2–3 related topics)
    - End with a "next steps" section — what the reader should do

  IF womens_health:
    - Frame the condition with empathy and without infantilising
    - Cite UK-specific prevalence data where possible
    - Evidence for BOTH herbal/supplement AND cannabis approaches where relevant
    - Include the hook "[WOMENS_CIRCLE_QUOTE_PLACEHOLDER: search Plantz Women's Circle video transcripts for a quote on {condition}]" — this will be filled in manually or by a later retrieval step once the corpus is ingested
    - Clear note on when to see a GP / specialist
    - Avoid medicalising every cycle symptom — respect the reader's agency

  IF buying_intent_device:
    - Structure as a clear buyer's guide OR head-to-head comparison OR step-by-step how-to
    - Include a comparison table where relevant (use markdown)
    - Cover: temperature range, battery life, chamber size, best use case, price point, who it's for, who it's NOT for
    - Technical but accessible — David-friendly without losing Chloe
    - Always in the context of LEGAL, PRESCRIBED medical cannabis flower
    - End with a "should you buy it" verdict, not a generic CTA

  IF research_roundup / mechanism_explainer / myth_busting / industry_story / seasonal:
    - Standard evidence-led structure, angle-appropriate
    - Industry_story angles should cover UK natural health / cannabis industry news — new legislation, company news, research publications, market developments

EVIDENCE TO QUERY (fills pinecone_namespaces + pinecone_queries above):
- Specify the 1–3 most relevant namespaces from: plantz-products, herb_monographs, cannabis_faq, cannabis, cannabis_products, natural_remedies
- Provide 3–4 concrete search queries to run in those namespaces

══════════════════════════════════════════════════════════════════
FINAL REQUIREMENTS
══════════════════════════════════════════════════════════════════
- All 10 headlines must have DIFFERENT subjects
- Batch composition quotas above are MANDATORY
- priority_order from 1 (most important) to 10
- Each seo_keyword should be a realistic search query people actually type
- product_deep_dive and buying_intent_device headlines MUST reference products/devices from the approved lists above — no made-up herbs or hardware`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt
  });

  let jsonStr = response.content[0].text;
  if (jsonStr.includes('```json')) jsonStr = jsonStr.split('```json')[1].split('```')[0];
  else if (jsonStr.includes('```')) jsonStr = jsonStr.split('```')[1].split('```')[0];

  return JSON.parse(jsonStr.trim());
}

// ── Airtable: Create Headlines ─────────────────────────────────────────────

async function createHeadlines(headlines) {
  const batchId = `batch-${new Date().toISOString().split('T')[0]}`;
  const created = [];

  for (let i = 0; i < headlines.length; i += 10) {
    const batch = headlines.slice(i, i + 10);
    const records = batch.map(h => ({
      fields: {
        headline: h.headline,
        subject: h.subject,
        angle: h.angle,
        seo_keyword: h.seo_keyword,
        article_prompt: h.article_prompt,
        target_word_count: h.target_word_count || 1000,
        priority_order: h.priority_order || 1,
        batch_id: batchId,
        status: 'draft'
      }
    }));

    const response = await new Promise((resolve, reject) => {
      airtable(CONFIG.airtable.headlineTable).create(
        records.map(r => r),
        { typecast: true },
        (err, records) => err ? reject(err) : resolve(records)
      );
    });

    created.push(...response);
  }

  return created;
}

// ── Quality Check ──────────────────────────────────────────────────────────

function validateBatchComposition(headlines) {
  const counts = {};
  for (const h of headlines) {
    counts[h.angle] = (counts[h.angle] || 0) + 1;
  }

  const womensCount = counts.womens_health || 0;
  const issues = [];

  if (womensCount < CONFIG.batchComposition.womens_health.min) {
    issues.push(`⚠️ Only ${womensCount} womens_health headline(s) — minimum is ${CONFIG.batchComposition.womens_health.min}`);
  }

  const subjects = headlines.map(h => h.subject);
  const uniqueSubjects = new Set(subjects);
  if (uniqueSubjects.size < subjects.length) {
    issues.push(`⚠️ Duplicate subjects detected: ${subjects.length - uniqueSubjects.size} duplicate(s)`);
  }

  return { counts, issues };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('📋 Plantz Headline Generator v2.0');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Day: ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getUTCDay()]}`);

  // Monday check
  if (!isMonday() && !FORCE) {
    console.log('Not Monday — skipping headline generation.');
    console.log('Use --force to override.');
    return;
  }

  if (FORCE && !isMonday()) {
    console.log('⚠️ Force mode — running despite not being Monday');
  }

  try {
    // Get recent subjects to avoid repetition
    console.log('\n📚 Fetching recent subjects...');
    const recentArticleSubjects = await getRecentSubjects();
    const recentHeadlineSubjects = await getRecentHeadlineSubjects();
    console.log(`   ${recentArticleSubjects.length} recent articles, ${recentHeadlineSubjects.length} recent headlines`);

    // Build the topic pool from multiple namespaces
    const pool = await buildTopicPool();

    if (pool.productsWeSell.length === 0) {
      throw new Error('Topic pool returned zero products — cannot generate batch. Check Pinecone connectivity.');
    }

    // Generate headlines with Claude
    console.log('\n✍️ Generating 10 headlines with Claude...');
    const headlines = await generateHeadlines(recentArticleSubjects, pool);

    if (!Array.isArray(headlines) || headlines.length === 0) {
      throw new Error('Claude returned invalid or empty headlines array');
    }

    console.log(`   Generated ${headlines.length} headlines:`);
    headlines.forEach((h, i) => {
      console.log(`   ${i + 1}. [${h.angle}/${h.persona || '?'}] ${h.headline}`);
      console.log(`      Subject: ${h.subject}`);
    });

    // Validate batch composition
    const validation = validateBatchComposition(headlines);
    console.log('\n📊 Batch composition:');
    for (const [angle, count] of Object.entries(validation.counts)) {
      console.log(`   ${angle}: ${count}`);
    }
    if (validation.issues.length > 0) {
      console.log('\n⚠️ Validation issues (not fatal, but review):');
      validation.issues.forEach(i => console.log(`   ${i}`));
    }

    // Create in Airtable
    console.log('\n💾 Creating headline records in Airtable...');
    const created = await createHeadlines(headlines);
    console.log(`   ✅ Created ${created.length} headline records`);

    // Discord notification
    const headlineList = headlines.map((h, i) =>
      `${i + 1}. **${h.headline}**\n   _${h.subject} · ${h.angle} · ${h.persona || 'aisha'}_`
    ).join('\n');

    const compositionSummary = Object.entries(validation.counts)
      .map(([a, c]) => `${a}: ${c}`)
      .join(' · ');

    const issuesText = validation.issues.length > 0
      ? `\n\n⚠️ ${validation.issues.join(' | ')}`
      : '';

    await sendDiscordNotification(
      `**${created.length} new headlines generated for this week:**\n\n${headlineList}\n\n_Composition: ${compositionSummary}_${issuesText}\n\n_Review in Airtable → Headline Queue, then set status to "approved" for the ones you want written._`
    );

    console.log('\n' + '━'.repeat(50));
    console.log(`🎉 Done! ${created.length} headlines ready for review.`);

  } catch (error) {
    console.error('Fatal error:', error);
    await sendDiscordNotification(
      `**Headline generation failed:**\n\`\`\`${error.message}\`\`\``,
      true
    );
    process.exit(1);
  }
}

main();
