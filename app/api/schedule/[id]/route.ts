import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

/**
 * Cancel a scheduled campaign. Only campaigns still in 'scheduled' state
 * can be canceled — once the processor claims one it's already sending.
 */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  const userEmail = session?.user?.email;
  if (!userEmail) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await ctx.params;

  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .update({ status: "canceled" })
    .eq("id", id)
    .eq("user_email", userEmail)
    .eq("status", "scheduled")
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { error: "Campaign not found or already sending" },
      { status: 409 }
    );
  }

  return NextResponse.json({ canceled: true });
}
