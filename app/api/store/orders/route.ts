import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      status: "accepted",
      message: "Public B2B order endpoint placeholder — rate limiting in T2.",
    },
    { status: 202 },
  );
}
