import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    provider: "next-auth",
    message: "Auth handler placeholder — configure in T2.",
  });
}

export async function POST() {
  return NextResponse.json(
    { error: "Auth not configured yet." },
    { status: 501 },
  );
}
