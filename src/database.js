const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');

let client;

function db() {
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error('Database is not configured');
  }
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'public' }
    });
  }
  return client;
}

function unwrap(result, operation) {
  if (result.error) {
    const error = new Error(`${operation}: ${result.error.message}`);
    error.code = result.error.code;
    error.details = result.error.details;
    throw error;
  }
  return result.data;
}

module.exports = { db, unwrap };
