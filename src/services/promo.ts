import { prisma } from '../db.js';

export interface PromoValidationResult {
  valid: boolean;
  code: string;
  percentOff?: number | null;
  flatOffPaise?: number | null;
  discountPaise: number;
  discountedFarePaise: number;
  message?: string;
}

export async function seedDefaultPromos() {
  const promos = [
    { code: 'SAVE10', percentOff: 10, flatOffPaise: null, maxUses: 500, active: true },
    { code: 'FIRST50', percentOff: null, flatOffPaise: 5000, maxUses: 500, active: true },
    { code: 'WELCOME20', percentOff: 20, flatOffPaise: null, maxUses: 500, active: true }
  ];

  for (const p of promos) {
    await prisma.promoCode.upsert({
      where: { code: p.code },
      update: {
        percentOff: p.percentOff,
        flatOffPaise: p.flatOffPaise,
        active: p.active,
        maxUses: p.maxUses
      },
      create: p
    });
  }
}

export async function validatePromoCode(rawCode: string, fareEstimatePaise: number): Promise<PromoValidationResult> {
  const code = rawCode.trim().toUpperCase();
  const promo = await prisma.promoCode.findUnique({
    where: { code }
  });

  if (!promo || !promo.active) {
    return {
      valid: false,
      code,
      discountPaise: 0,
      discountedFarePaise: fareEstimatePaise,
      message: 'Invalid or inactive promotional code'
    };
  }

  if (promo.expiresAt && new Date() > promo.expiresAt) {
    return {
      valid: false,
      code,
      discountPaise: 0,
      discountedFarePaise: fareEstimatePaise,
      message: 'Promotional code has expired'
    };
  }

  if (promo.usedCount >= promo.maxUses) {
    return {
      valid: false,
      code,
      discountPaise: 0,
      discountedFarePaise: fareEstimatePaise,
      message: 'Promotional code has reached maximum redemption limit'
    };
  }

  let discountPaise = 0;
  if (promo.percentOff) {
    discountPaise = Math.round((fareEstimatePaise * promo.percentOff) / 100);
  } else if (promo.flatOffPaise) {
    discountPaise = promo.flatOffPaise;
  }

  // Discount cannot exceed initial fare
  discountPaise = Math.min(fareEstimatePaise, Math.max(0, discountPaise));
  const discountedFarePaise = Math.max(0, fareEstimatePaise - discountPaise);

  return {
    valid: true,
    code: promo.code,
    percentOff: promo.percentOff,
    flatOffPaise: promo.flatOffPaise,
    discountPaise,
    discountedFarePaise,
    message: `Promo code ${promo.code} applied successfully`
  };
}
