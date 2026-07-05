import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client using the service-role key.
 * NEVER import this into a client component — the service-role key
 * bypasses Row Level Security and must stay on the server.
 *
 * The client is created lazily on first use so that importing this module
 * (e.g. during `next build`) doesn't require env vars to be present.
 */
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is missing. " +
        "Copy .env.local.example to .env.local and fill it in."
    );
  }
  _client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop: string | symbol) {
    const client = getClient();
    const value = Reflect.get(client, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export const RESUME_BUCKET = "resumes";

/** Store (or update) a user's Gmail refresh token after they sign in. */
export async function saveRefreshToken(
  email: string,
  name: string | null,
  refreshToken: string
) {
  const { error } = await supabaseAdmin.from("gmail_accounts").upsert(
    {
      email,
      name,
      refresh_token: refreshToken,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "email" }
  );
  if (error) console.error("[supabase] saveRefreshToken failed:", error.message);
}

/** Fetch the stored refresh token for a signed-in user. */
export async function getRefreshToken(email: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("gmail_accounts")
    .select("refresh_token")
    .eq("email", email)
    .maybeSingle();
  if (error) {
    console.error("[supabase] getRefreshToken failed:", error.message);
    return null;
  }
  return data?.refresh_token ?? null;
}
