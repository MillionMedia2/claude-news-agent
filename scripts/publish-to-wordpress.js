/**
 * Plantz News Agent - WordPress Publishing Script (v3)
 *
 * v3: Date-aware publishing. Only publishes articles where:
 *   - post_to_wordpress is checked
 *   - Publication Date <= today
 *   - featured_image is uploaded
 *   - Plantz URL is empty (not yet published)
 *   - written_article exists
 *
 * After publishing, sets pipeline_status to "published".
 *
 * Env vars (must match .env naming):
 *   AIRTABLE_API_KEY, WORDPRESS_USERNAME, WORDPRESS_APP_PASSWORD,
 *   DISCORD_WEBHOOK_NOTIFICATIONS
 */

import Airtable from 'airtable';

const CONFIG = {
  airtable: { baseId: 'appN9kmTgJbjel4J1', tableId: 'Articles' },
  wordpress: { baseUrl: 'https://plantz.io', apiPath: '/wp-json/wp/v2' }
};

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(CONFIG.airtable.baseId);

function getWPAuthHeader() {
  return `Basic ${Buffer.from(`${process.env.WORDPRESS_USERNAME}:${process.env.WORDPRESS_APP_PASSWORD}`).toString('base64')}`;
}

async function sendDiscordNotification(message, isError = false) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_NOTIFICATIONS;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: isError ? '❌ Publishing Error' : '🚀 Article Published!',
          description: message,
          color: isError ? 0xFF0000 : 0x58B09C,
          timestamp: new Date().toISOString()
        }]
      })
    });
  } catch (error) {
    console.error('Discord notification failed:', error);
  }
}

function markdownToHtml(markdown) {
  let html = markdown.replace(/^# .+\n+/, '');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/^---$/gm, '<hr />');
  html = html.split('\n\n').map(para => {
    para = para.trim();
    if (!para || para.startsWith('<h') || para.startsWith('<hr')) return para;
    return `<p>${para.replace(/\n/g, ' ')}</p>`;
  }).join('\n\n');
  return html;
}

async function getCategoryIds(categoryNames) {
  const authHeader = getWPAuthHeader();
  const response = await fetch(`${CONFIG.wordpress.baseUrl}${CONFIG.wordpress.apiPath}/categories?per_page=100`, { headers: { 'Authorization': authHeader } });
  const existing = await response.json();
  const ids = [];
  for (const name of categoryNames) {
    const found = existing.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (found) ids.push(found.id);
    else {
      const res = await fetch(`${CONFIG.wordpress.baseUrl}${CONFIG.wordpress.apiPath}/categories`, {
        method: 'POST', headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
      });
      const newCat = await res.json();
      if (newCat.id) ids.push(newCat.id);
    }
  }
  return ids;
}

async function getTagIds(tagString) {
  const authHeader = getWPAuthHeader();
  const tagNames = tagString.split(',').map(t => t.trim()).filter(t => t);
  const ids = [];
  for (const name of tagNames) {
    const res = await fetch(`${CONFIG.wordpress.baseUrl}${CONFIG.wordpress.apiPath}/tags?search=${encodeURIComponent(name)}`, { headers: { 'Authorization': authHeader } });
    const existing = await res.json();
    const found = existing.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (found) ids.push(found.id);
    else {
      const createRes = await fetch(`${CONFIG.wordpress.baseUrl}${CONFIG.wordpress.apiPath}/tags`, {
        method: 'POST', headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
      });
      const newTag = await createRes.json();
      if (newTag.id) ids.push(newTag.id);
    }
  }
  return ids;
}

async function uploadFeaturedImage(imageUrl, title) {
  const authHeader = getWPAuthHeader();
  const imageResponse = await fetch(imageUrl);
  const imageBuffer = Buffer.from(await (await imageResponse.blob()).arrayBuffer());
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  const res = await fetch(`${CONFIG.wordpress.baseUrl}${CONFIG.wordpress.apiPath}/media`, {
    method: 'POST',
    headers: { 'Authorization': authHeader, 'Content-Disposition': `attachment; filename="${slug}.jpg"`, 'Content-Type': 'image/jpeg' },
    body: imageBuffer
  });
  if (!res.ok) throw new Error(`Image upload failed: ${await res.text()}`);
  return (await res.json()).id;
}

async function createWordPressPost(article, mediaId, categoryIds, tagIds) {
  const authHeader = getWPAuthHeader();
  const postData = {
    title: article.title, content: markdownToHtml(article.written_article), excerpt: article.excerpt || '',
    status: 'publish', categories: categoryIds, tags: tagIds, ...(mediaId && { featured_media: mediaId })
  };
  const res = await fetch(`${CONFIG.wordpress.baseUrl}${CONFIG.wordpress.apiPath}/posts`, {
    method: 'POST', headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify(postData)
  });
  if (!res.ok) throw new Error(`Post creation failed: ${await res.text()}`);
  return res.json();
}

// v3: Date-aware query — only publish articles whose Publication Date is today or earlier
async function getArticlesToPublish() {
  return new Promise((resolve, reject) => {
    const records = [];
    airtable(CONFIG.airtable.tableId)
      .select({
        maxRecords: 20,
        filterByFormula: `AND(
          {post_to_wordpress} = TRUE(),
          IS_BEFORE({Publication Date}, DATEADD(TODAY(), 1, 'days')),
          {Plantz URL} = '',
          {written_article} != '',
          {featured_image} != ''
        )`
      })
      .eachPage((pageRecords, next) => { records.push(...pageRecords); next(); }, (err) => err ? reject(err) : resolve(records));
  });
}

async function main() {
  console.log('🚀 Plantz WordPress Publisher v3 starting...');
  console.log(`Timestamp: ${new Date().toISOString()}\n`);
  
  try {
    const articles = await getArticlesToPublish();
    console.log(`📋 Found ${articles.length} article(s) ready to publish\n`);
    if (articles.length === 0) {
      console.log('📭 No articles ready to publish today. Exiting.');
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const record of articles) {
      const title = record.get('article_title');
      console.log(`📝 Publishing: "${title}"`);
      try {
        let mediaId = null;
        const images = record.get('featured_image');
        if (images?.length > 0) {
          console.log('   📸 Uploading image...');
          mediaId = await uploadFeaturedImage(images[0].url, title);
        }
        const categoryIds = await getCategoryIds(record.get('categories') || []);
        const tagIds = await getTagIds(record.get('claude_tags') || '');
        const post = await createWordPressPost(
          { title, written_article: record.get('written_article'), excerpt: record.get('claude_post_extract') },
          mediaId, categoryIds, tagIds
        );
        
        // Update Airtable: save URL + set pipeline_status to published
        await new Promise((resolve, reject) => {
          airtable(CONFIG.airtable.tableId).update(record.id, {
            'Plantz URL': post.link,
            'pipeline_status': 'published'
          }, (err) => err ? reject(err) : resolve());
        });
        
        await sendDiscordNotification(`**${title}**\n\n🔗 ${post.link}`);
        successCount++;
        console.log(`   ✅ Published: ${post.link}\n`);
      } catch (error) {
        errorCount++;
        console.error(`   ❌ Error: ${error.message}`);
        await sendDiscordNotification(`**Error:** ${title}\n\`\`\`${error.message}\`\`\``, true);
      }
    }

    console.log('━'.repeat(50));
    console.log(`🎉 Done: ${successCount} published, ${errorCount} errors`);
  } catch (error) {
    console.error('Fatal error:', error);
    await sendDiscordNotification(`**Fatal error:**\n\`\`\`${error.message}\`\`\``, true);
    process.exit(1);
  }
}

main();
