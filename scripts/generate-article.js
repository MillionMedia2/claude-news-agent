/**
 * Plantz News Agent - Article Generation Script
 * 
 * This script:
 * 1. Checks Airtable for articles with a prompt but no written_article
 * 2. Queries Pinecone for evidence
 * 3. Calls Claude API to generate the article
 * 4. Updates Airtable with the generated content
 * 5. If post_to_wordpress is checked, publishes to WordPress
 */

import Anthropic from '@anthropic-ai/sdk';
import Airtable from 'airtable';
import { Pinecone } from '@pinecone-database/pinecone';

// Configuration
const CONFIG = {
  airtable: {
    baseId: 'appN9kmTgJbjel4J1',
    tableId: 'Articles'
  },
  pinecone: {
    indexName: 'plantz1',
    namespace: 'herb_monographs'
  },
  wordpress: {
    baseUrl: 'https://plantz.io',
    apiPath: '/wp-json/wp/v2'
  }
};

// Initialize clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(CONFIG.airtable.baseId);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

/**
 * Get articles from Airtable that have a prompt but no written article
 */
async function getPendingArticles() {
  return new Promise((resolve, reject) => {
    const records = [];
    airtable(CONFIG.airtable.tableId)
      .select({
        maxRecords: 1, // Process one at a time
        filterByFormula: `AND({prompt} != '', {written_article} = '')`
      })
      .eachPage(
        (pageRecords, next) => { records.push(...pageRecords); next(); },
        (err) => err ? reject(err) : resolve(records)
      );
  });
}

/**
 * Query Pinecone for evidence related to the article topic
 */
async function queryPinecone(searchText) {
  try {
    const index = pinecone.index(CONFIG.pinecone.indexName);
    
    // Create embedding using Pinecone's inference
    const response = await index.namespace(CONFIG.pinecone.namespace).query({
      topK: 10,
      includeMetadata: true,
      vector: await getEmbedding(searchText)
    });
    
    return response.matches.map(match => match.metadata?.text || '').join('\n\n');
  } catch (error) {
    console.error('Pinecone query error:', error);
    return '';
  }
}

/**
 * Get embedding for search text using Anthropic
 * Note: In production, use Pinecone's built-in inference or OpenAI embeddings
 */
async function getEmbedding(text) {
  // For now, we'll use Pinecone's query by text feature
  // This is a placeholder - Pinecone's inference API handles this
  const index = pinecone.index(CONFIG.pinecone.indexName);
  
  // Use Pinecone's inference to search by text directly
  const response = await fetch(`https://${CONFIG.pinecone.indexName}-aokppsg.svc.gcp-europe-west4-de1d.pinecone.io/query`, {
    method: 'POST',
    headers: {
      'Api-Key': process.env.PINECONE_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      namespace: CONFIG.pinecone.namespace,
      topK: 10,
      includeMetadata: true,
      inputs: { text: text }
    })
  });
  
  const data = await response.json();
  return data.matches?.map(m => m.metadata?.text || '').join('\n\n') || '';
}

/**
 * Search Pinecone using the inference API (text-based search)
 */
async function searchPinecone(searchText) {
  try {
    const response = await fetch(
      `https://plantz1-aokppsg.svc.gcp-europe-west4-de1d.pinecone.io/records/namespaces/${CONFIG.pinecone.namespace}/search`,
      {
        method: 'POST',
        headers: {
          'Api-Key': process.env.PINECONE_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: {
            topK: 10,
            inputs: { text: searchText }
          }
        })
      }
    );
    
    if (!response.ok) {
      throw new Error(`Pinecone search failed: ${response.status}`);
    }
    
    const data = await response.json();
    return data.result?.hits?.map(hit => hit.fields?.text || '').join('\n\n---\n\n') || '';
  } catch (error) {
    console.error('Pinecone search error:', error);
    return '';
  }
}

/**
 * Generate article using Claude API
 */
async function generateArticle(title, prompt, evidence) {
  const systemPrompt = `You are the Plantz News Agent, writing evidence-based wellness articles for Aisha - a 35-40 year old UK woman who is wellness-curious but skeptical of hype.

Tone: Calm, evidence-led, curious, warm. Never preachy or salesy.
Format: Markdown with ## headings (no # H1 - title is separate)
Length: ~1,000-1,200 words
UK Regulatory: No cure claims. Use "research suggests", "may support", "traditionally used for"

Structure:
- Opening hook (no heading)
- 4-6 H2 sections with evidence and mechanisms
- Practical "how to use" section
- Closing paragraph
- Disclaimer

Always ground claims in the evidence provided.`;

  const userPrompt = `Write an article titled: "${title}"

## Research Brief:
${prompt}

## Evidence from Knowledge Base:
${evidence}

Generate the complete article now.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt
  });

  return response.content[0].text;
}

/**
 * Generate supporting content (tags, excerpt, social posts, etc.)
 */
async function generateSupportingContent(article, title) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Based on this article titled "${title}":

${article}

Generate the following in JSON format:
{
  "claude_tags": "8-14 comma-separated lowercase tags",
  "claude_post_extract": "WordPress excerpt, max 160 characters",
  "Article Keywords": "single SEO keyphrase",
  "Social Media Post": "under 280 characters, conversational",
  "claude_long_social": "5-6 post thread, separated by newlines",
  "claude_avatar_script": "75-100 word video script teaser",
  "claude_image_prompt": "image prompt for 16:9 featured image, Kinfolk aesthetic",
  "categories": ["array of 1-3 from: Natural Remedies, Health, Research, Lifestyle"]
}

Return ONLY valid JSON, no markdown.`
    }],
    system: 'You are a content assistant. Return only valid JSON, no explanation.'
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch (e) {
    console.error('Failed to parse supporting content:', e);
    return {};
  }
}

/**
 * Update Airtable record with generated content
 */
async function updateAirtableRecord(recordId, article, supportingContent) {
  return new Promise((resolve, reject) => {
    airtable(CONFIG.airtable.tableId).update(recordId, {
      'written_article': article,
      'claude_tags': supportingContent.claude_tags || '',
      'claude_post_extract': supportingContent.claude_post_extract || '',
      'Article Keywords': supportingContent['Article Keywords'] || '',
      'Social Media Post': supportingContent['Social Media Post'] || '',
      'claude_long_social': supportingContent.claude_long_social || '',
      'claude_avatar_script': supportingContent.claude_avatar_script || '',
      'claude_image_prompt': supportingContent.claude_image_prompt || '',
      'categories': supportingContent.categories || ['Natural Remedies'],
      'article_source_name': 'Plantz News Agent (GitHub Actions)',
      'Publication Date': new Date().toISOString().split('T')[0]
    }, (err, record) => {
      if (err) reject(err);
      else resolve(record);
    });
  });
}

/**
 * Publish to WordPress if approved
 */
async function publishToWordPress(record) {
  const fields = record.fields;
  
  // Check if approved for publishing
  if (!fields.post_to_wordpress) {
    console.log('Article not approved for WordPress publishing yet');
    return null;
  }
  
  // Skip if already published
  if (fields['Plantz URL']) {
    console.log('Article already published:', fields['Plantz URL']);
    return fields['Plantz URL'];
  }
  
  const authHeader = `Basic ${Buffer.from(`${process.env.WORDPRESS_USER}:${process.env.WORDPRESS_APP_PASSWORD}`).toString('base64')}`;
  
  // Get category IDs
  const categoryIds = await getCategoryIds(fields.categories || ['Natural Remedies'], authHeader);
  
  // Get/create tag IDs
  const tagIds = await getTagIds(fields.claude_tags || '', authHeader);
  
  // Convert markdown to HTML (basic conversion)
  let content = fields.written_article || '';
  content = content.replace(/^# .+\n+/, ''); // Remove H1
  content = content.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  content = content.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  content = content.replace(/\*(.+?)\*/g, '<em>$1</em>');
  content = content.replace(/^---$/gm, '<hr />');
  content = content.split('\n\n').map(para => {
    para = para.trim();
    if (!para || para.startsWith('<h') || para.startsWith('<hr')) return para;
    return `<p>${para.replace(/\n/g, ' ')}</p>`;
  }).join('\n\n');
  
  // Create post
  const postResponse = await fetch(`${CONFIG.wordpress.baseUrl}${CONFIG.wordpress.apiPath}/posts`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: fields.article_title,
      content: content,
      excerpt: fields.claude_post_extract || '',
      status: 'publish',
      categories: categoryIds,
      tags: tagIds
    })
  });
  
  if (!postResponse.ok) {
    throw new Error(`WordPress publish failed: ${await postResponse.text()}`);
  }
  
  const post = await postResponse.json();
  
  // Update Airtable with URL
  await new Promise((resolve, reject) => {
    airtable(CONFIG.airtable.tableId).update(record.id, {
      'Plantz URL': post.link
    }, (err) => err ? reject(err) : resolve());
  });
  
  return post.link;
}

async function getCategoryIds(categoryNames, authHeader) {
  const response = await fetch(`${CONFIG.wordpress.baseUrl}${CONFIG.wordpress.apiPath}/categories?per_page=100`, {
    headers: { 'Authorization': authHeader }
  });
  const existing = await response.json();
  
  return categoryNames.map(name => {
    const found = existing.find(c => c.name.toLowerCase() === name.toLowerCase());
    return found?.id;
  }).filter(Boolean);
}

async function getTagIds(tagString, authHeader) {
  if (!tagString) return [];
  
  const tagNames = tagString.split(',').map(t => t.trim()).filter(t => t);
  const ids = [];
  
  for (const name of tagNames) {
    const searchRes = await fetch(
      `${CONFIG.wordpress.baseUrl}${CONFIG.wordpress.apiPath}/tags?search=${encodeURIComponent(name)}`,
      { headers: { 'Authorization': authHeader } }
    );
    const existing = await searchRes.json();
    const found = existing.find(t => t.name.toLowerCase() === name.toLowerCase());
    
    if (found) {
      ids.push(found.id);
    } else {
      const createRes = await fetch(`${CONFIG.wordpress.baseUrl}${CONFIG.wordpress.apiPath}/tags`, {
        method: 'POST',
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const newTag = await createRes.json();
      if (newTag.id) ids.push(newTag.id);
    }
  }
  
  return ids;
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Plantz News Agent starting...\n');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  
  try {
    // Check for pending articles
    const pendingArticles = await getPendingArticles();
    
    if (pendingArticles.length === 0) {
      console.log('\n📭 No pending articles in queue. Exiting.');
      return;
    }
    
    const record = pendingArticles[0];
    const title = record.get('article_title');
    const prompt = record.get('prompt');
    
    console.log(`\n📝 Processing: "${title}"`);
    
    // Extract search terms from title and prompt
    const searchTerms = `${title} ${prompt}`.substring(0, 500);
    
    // Query Pinecone for evidence
    console.log('\n🔍 Querying Pinecone for evidence...');
    const evidence = await searchPinecone(searchTerms);
    console.log(`   Found ${evidence.length} characters of evidence`);
    
    // Generate article
    console.log('\n✍️  Generating article with Claude...');
    const article = await generateArticle(title, prompt, evidence);
    console.log(`   Generated ${article.length} characters`);
    
    // Generate supporting content
    console.log('\n📦 Generating supporting content...');
    const supportingContent = await generateSupportingContent(article, title);
    
    // Update Airtable
    console.log('\n💾 Updating Airtable record...');
    await updateAirtableRecord(record.id, article, supportingContent);
    console.log('   ✅ Airtable updated');
    
    // Check if we should publish
    const updatedRecord = await new Promise((resolve, reject) => {
      airtable(CONFIG.airtable.tableId).find(record.id, (err, rec) => {
        if (err) reject(err);
        else resolve(rec);
      });
    });
    
    if (updatedRecord.get('post_to_wordpress')) {
      console.log('\n🌐 Publishing to WordPress...');
      const url = await publishToWordPress(updatedRecord);
      if (url) {
        console.log(`   ✅ Published: ${url}`);
      }
    } else {
      console.log('\n⏸️  Waiting for human approval (post_to_wordpress not checked)');
    }
    
    console.log('\n🎉 Done!');
    
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

main();
