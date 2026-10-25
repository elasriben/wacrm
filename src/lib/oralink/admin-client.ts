import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy service-role client for OraLink server-side helpers (consent guard,
// lead scores). Same shape as src/lib/flows/admin-client.ts. Callers that
// already hold a client should pass it instead; this is only the default.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
