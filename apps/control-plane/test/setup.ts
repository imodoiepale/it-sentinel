// Dummy values so modules that eagerly validate env at import time (src/env.ts)
// don't throw during unit tests that never actually touch the database.
process.env.SUPABASE_URL ??= "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key-not-real-00000000";
