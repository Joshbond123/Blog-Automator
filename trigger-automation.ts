import dotenv from 'dotenv';
dotenv.config();

import { runBlogAutomation } from './automation';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://udbplvgyydwkcswyoxcq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function main() {
  let scheduleId = process.argv[2];

  if (!scheduleId) {
    // Find the active schedule automatically
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: schedules } = await supabase
      .from('schedules')
      .select('id, channel, is_enabled')
      .eq('channel', 'blog')
      .eq('is_enabled', true)
      .limit(1);

    if (!schedules || schedules.length === 0) {
      console.error('No active blog schedules found.');
      process.exit(1);
    }
    scheduleId = schedules[0].id;
    console.log(`Auto-selected active schedule: ${scheduleId}`);
  }

  console.log(`Triggering blog automation for schedule: ${scheduleId}`);
  console.log(`Start time: ${new Date().toISOString()}`);

  await runBlogAutomation(scheduleId);

  console.log(`\nAutomation completed at: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error('Trigger failed:', err);
  process.exit(1);
});
