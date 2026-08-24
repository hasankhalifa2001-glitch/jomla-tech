import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      status: "accepted",
      message: "Offline sync endpoint placeholder — idempotent upsert in T2.",
    },
    { status: 202 },
  );
}
