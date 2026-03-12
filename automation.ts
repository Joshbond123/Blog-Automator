import axios from 'axios';
import FormData from 'form-data';
import { getSupabase } from './supabase-backend';
import dotenv from 'dotenv';

dotenv.config();

// --- Helpers ---

async function getSettings() {
  const supabase = getSupabase();
  const { data } = await supabase.from('settings').select('*').single();
  return data || {};
}

async function uploadToCatbox(fileBuffer: Buffer, fileName: string) {
  const settings = await getSettings();
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('userhash', settings.catbox_hash || '');
  form.append('fileToUpload', fileBuffer, fileName);

  const res = await axios.post('https://catbox.moe/user/api.php', form, {
    headers: form.getHeaders()
  });
  return res.data; // Returns the URL
}

// --- AI Generation ---

async function getRotatedKey(keysString: string) {
  const keys = (keysString || '').split(',').map(k => k.trim()).filter(k => k);
  if (keys.length === 0) return null;
  return keys[Math.floor(Math.random() * keys.length)];
}

async function generateText(prompt: string, niche: string) {
  const settings = await getSettings();
  const key = await getRotatedKey(settings.cloudflare_api_keys);
  if (!key) throw new Error('No Cloudflare API keys configured');

  const res = await axios.post(
    `https://api.cloudflare.com/client/v4/accounts/${settings.cloudflare_account_id}/ai/run/@cf/meta/llama-3-8b-instruct`,
    {
      messages: [
        { role: 'system', content: `You are a professional content creator for the ${niche} niche. Generate engaging, high-quality content.` },
        { role: 'user', content: prompt }
      ]
    },
    { headers: { Authorization: `Bearer ${key}` } }
  );
  return res.data.result.response;
}

async function generateImage(prompt: string) {
  const settings = await getSettings();
  const key = await getRotatedKey(settings.cloudflare_api_keys);
  if (!key) throw new Error('No Cloudflare API keys configured');

  const res = await axios.post(
    `https://api.cloudflare.com/client/v4/accounts/${settings.cloudflare_account_id}/ai/run/@cf/bytedance/stable-diffusion-xl-lightning`,
    { prompt },
    { headers: { Authorization: `Bearer ${key}` }, responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

async function generateVoiceover(text: string) {
  const settings = await getSettings();
  const key = await getRotatedKey(settings.elevenlabs_keys);
  if (!key) throw new Error('No ElevenLabs API keys configured');

  const res = await axios.post(
    'https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', // Default voice
    { text, model_id: 'eleven_monolingual_v1' },
    { headers: { 'xi-api-key': key }, responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

// --- Publishing ---

async function publishToBlogger(blogId: string, title: string, content: string) {
  const settings = await getSettings();
  const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: settings.blogger_client_id,
    client_secret: settings.blogger_client_secret,
    refresh_token: settings.blogger_refresh_token,
    grant_type: 'refresh_token'
  });
  const accessToken = tokenRes.data.access_token;

  const res = await axios.post(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts`,
    {
      kind: 'blogger#post',
      title,
      content
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.data;
}

async function publishToFacebook(pageId: string, accessToken: string, message: string, link?: string) {
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/feed`,
    {
      message,
      link,
      access_token: accessToken
    }
  );
  return res.data;
}

// --- Automation Logic ---

export async function runBlogAutomation(scheduleId: string) {
  const supabase = getSupabase();
  const { data: schedule } = await supabase.from('schedules').select('*, blogger_accounts(*)').eq('id', scheduleId).single();
  if (!schedule) return;

  const account = schedule.blogger_accounts;
  const niche = account.niche;

  try {
    // 1. Generate Topic
    const topic = await generateText(`Generate a viral blog post title for the ${niche} niche. Return only the title.`, niche);
    
    // 2. Generate Content
    const content = await generateText(`Write a detailed, engaging blog post about "${topic}" for the ${niche} niche. Use HTML formatting.`, niche);
    
    // 3. Generate Image
    const imageBuffer = await generateImage(`A high-quality, professional image related to: ${topic}. Cinematic style.`);
    const imageUrl = await uploadToCatbox(imageBuffer, 'blog-image.png');

    // 4. Publish to Blogger
    const bloggerPost = await publishToBlogger(account.blogger_id, topic, `<img src="${imageUrl}" style="width:100%" /><br/>${content}`);

    // 5. Publish to Facebook (Teaser)
    if (account.facebook_page_id) {
      const { data: fbPage } = await supabase.from('facebook_pages').select('*').eq('id', account.facebook_page_id).single();
      if (fbPage) {
        await publishToFacebook(
          fbPage.page_id, 
          fbPage.access_token, 
          `New Post: ${topic}\n\nRead more here: ${bloggerPost.url}`,
          bloggerPost.url
        );
      }
    }

    // 6. Record Post
    await supabase.from('posts').insert({
      title: topic,
      blog_name: account.name,
      niche: niche,
      platform: 'Both',
      status: 'published',
      url: bloggerPost.url,
      published_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Blog automation failed:', error);
    await supabase.from('posts').insert({
      title: 'Failed to generate post',
      blog_name: account.name,
      niche: niche,
      platform: 'Both',
      status: 'failed',
      published_at: new Date().toISOString()
    });
  }
}

// --- Video Generation ---


export async function runVideoAutomation(scheduleId: string) {
  const supabase = getSupabase();
  const { data: schedule } = await supabase.from('schedules').select('*, facebook_pages(*)').eq('id', scheduleId).single();
  if (!schedule) return;

  const fbPage = schedule.facebook_pages;
  const settings = await getSettings();

  // 1. Generate Topic & Script
  const niche = "Viral Entertainment"; // Default if not linked to blogger
  const topic = await generateText(`Generate a viral video topic for the ${niche} niche.`, niche);
  const script = await generateText(`Write a 30-second video script for the topic: "${topic}".`, niche);

  // 2. Generate Voiceover
  const voiceBuffer = await generateVoiceover(script);
  const voiceUrl = await uploadToCatbox(voiceBuffer, 'voiceover.mp3');

  // 3. Trigger GitHub Action for Remotion Rendering
  if (settings.github_pat) {
    await axios.post(
      'https://api.github.com/repos/YOUR_USER/YOUR_REMOTION_REPO/dispatches',
      {
        event_type: 'render_video',
        client_payload: {
          topic,
          script,
          voiceUrl,
          catboxHash: settings.catbox_hash,
          fbPageId: fbPage.page_id,
          fbAccessToken: fbPage.access_token
        }
      },
      {
        headers: {
          Authorization: `token ${settings.github_pat}`,
          Accept: 'application/vnd.github.v3+json'
        }
      }
    );
  }

  // Record Job
  await supabase.from('video_jobs').insert({
    schedule_id: scheduleId,
    status: 'rendering',
    created_at: new Date().toISOString()
  });
}

