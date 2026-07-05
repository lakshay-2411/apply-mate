import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { supabaseAdmin, RESUME_BUCKET } from "@/lib/supabase";

export const runtime = "nodejs";

/**
 * Uploads a resume/CV to Supabase Storage and returns its storage path.
 * The bucket is created on first use if it doesn't exist yet.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File exceeds 10MB" }, { status: 400 });
  }

  // Ensure the bucket exists (idempotent — ignore "already exists" errors).
  const { error: bucketErr } = await supabaseAdmin.storage.createBucket(
    RESUME_BUCKET,
    { public: false }
  );
  if (bucketErr && !/exist/i.test(bucketErr.message)) {
    return NextResponse.json({ error: bucketErr.message }, { status: 500 });
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `${session.user.email}/${Date.now()}_${safeName}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  const { error } = await supabaseAdmin.storage
    .from(RESUME_BUCKET)
    .upload(path, bytes, { contentType: file.type, upsert: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    path,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
  });
}
