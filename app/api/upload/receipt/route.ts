import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      status: "accepted",
      message: "Receipt upload handler placeholder — S3/R2 integration in T2.",
    },
    { status: 202 },
  );
}
