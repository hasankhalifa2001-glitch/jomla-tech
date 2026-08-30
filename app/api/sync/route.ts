import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);

    if (body?.invoice) {
      const { customerId, debtAmountUSD, tenantId } = body.invoice;

      if (customerId && Number(debtAmountUSD) > 0) {
        const customer = await prisma.customer.findFirst({
          where: { id: customerId, tenantId },
          select: { isSystemGenerated: true },
        });

        if (customer?.isSystemGenerated) {
          return NextResponse.json(
            {
              error:
                "لا يمكن تسجيل دين على الزبون النقدي العام (الزبون الافتراضي). يرجى تحديد زبون حقيقي وتسجيل اسمه ورقم هاتفه.",
            },
            { status: 400 }
          );
        }
      }
    }

    return NextResponse.json(
      {
        status: "accepted",
        message: "Offline sync endpoint placeholder — idempotent upsert in T2.",
      },
      { status: 202 }
    );
  } catch (err) {
    console.error("Sync API Error:", err);
    return NextResponse.json(
      { error: "حدث خطأ غير متوقع أثناء معالجة المزامنة." },
      { status: 500 }
    );
  }
}
