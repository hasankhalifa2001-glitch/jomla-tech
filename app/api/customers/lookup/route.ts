import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.tenantId) {
      return NextResponse.json({ message: "غير مصرح" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const phone = searchParams.get("phone")?.trim();

    if (!phone) {
      return NextResponse.json({ customer: null });
    }

    const db = getTenantDb(session.user.tenantId);

    // [FIX] tenantId injected automatically by the extension — no longer
    // written into `where` by hand, so this can never silently leak
    // another tenant's customer if the manual filter is ever forgotten or
    // edited incorrectly in the future.
    const customer = await db.customer.findFirst({
      where: {
        phone,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        shopName: true,
        isSystemGenerated: true,
      },
    });

    return NextResponse.json({ customer });
  } catch (error) {
    console.error("Customer lookup error:", error);
    return NextResponse.json(
      { message: "حدث خطأ أثناء البحث عن الزبون" },
      { status: 500 }
    );
  }
}