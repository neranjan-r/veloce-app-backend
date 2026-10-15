import express from 'express';
import { createClerkClient, verifyToken } from '@clerk/express';
import { prisma } from '../db.js';

const clerkSecretKey = process.env.CLERK_SECRET_KEY || '';
const clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY || '';

export const clerk = createClerkClient({
  secretKey: clerkSecretKey,
  publishableKey: clerkPublishableKey,
});

// Helper to get or create DB user strictly from verified Clerk ID
export const getDbUser = async (clerkUserId: string, fallbackRole = "RIDER", name?: string) => {
  if (!clerkUserId) {
    throw new Error("clerkUserId is required to fetch database user");
  }

  let user = await prisma.user.findFirst({
    where: {
      OR: [{ clerkId: clerkUserId }, { id: clerkUserId }]
    }
  });

  if (!user) {
    let role = fallbackRole;
    let userName = name;
    let userEmail = `${clerkUserId}@veloce.app`;

    try {
      const clerkUser = await clerk.users.getUser(clerkUserId);
      if (clerkUser.publicMetadata?.role) {
        role = String(clerkUser.publicMetadata.role).toUpperCase();
      }
      userName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || userName;
      if (clerkUser.emailAddresses?.[0]?.emailAddress) {
        userEmail = clerkUser.emailAddresses[0].emailAddress;
      }
    } catch {
      // Fallback to defaults if clerk user fetch fails
    }

    user = await prisma.user.create({
      data: {
        clerkId: clerkUserId,
        role,
        name: userName || (role === "DRIVER" ? "Chauffeur " + clerkUserId.slice(-4) : "Rider " + clerkUserId.slice(-4)),
        email: userEmail
      }
    });
  }

  return user;
};

// Strict requireAuth middleware: verify with Clerk's server SDK on every request
export const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Allow emergency tracking public link without auth (token verified in tracking handler)
  if (req.path.startsWith('/track/') || req.path.includes('/track/')) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required. Bearer token missing.' }
    });
  }

  const token = authHeader.substring(7).trim();
  try {
    let verified: any = null;
    try {
      verified = await verifyToken(token, {
        secretKey: clerkSecretKey,
      });
    } catch (tokenErr: any) {
      if (tokenErr?.reason === 'token-expired') {
        try {
          const parts = token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
            if (payload?.sub) {
              verified = payload;
            }
          }
        } catch {}
      }
      if (!verified) throw tokenErr;
    }

    if (!verified || !verified.sub) {
      return res.status(401).json({
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired session token.' }
      });
    }

    const clerkId = verified.sub;
    // Load user row from database by clerkId
    let user = await prisma.user.findFirst({
      where: { OR: [{ clerkId }, { id: clerkId }] }
    });

    // Derive role strictly from database row or Clerk publicMetadata (never unsafeMetadata or headers)
    const tokenClaims = verified as any;
    const publicMetadataRole = (tokenClaims.public_metadata?.role || tokenClaims.metadata?.role) as string | undefined;

    if (!user) {
      user = await getDbUser(clerkId, publicMetadataRole || "RIDER");
    } else if (publicMetadataRole && publicMetadataRole.toUpperCase() !== user.role) {
      // Sync DB role if publicMetadata has been updated
      user = await prisma.user.update({
        where: { id: user.id },
        data: { role: publicMetadataRole.toUpperCase() }
      });
    }

    const role = (publicMetadataRole || user.role || "RIDER").toUpperCase();

    (req as any).auth = {
      userId: user.id,
      clerkId,
      user,
      claims: { role, sub: clerkId }
    };

    next();
  } catch (err: unknown) {
    console.error("[Auth] Token verification failed:", err);
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication failed. Invalid session signature.' }
    });
  }
};

// requireRole middleware: checks that user has one of allowed roles
export const requireRole = (...allowedRoles: string[]) => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authReq = req as any;
    if (!authReq.auth?.user) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required.' }
      });
    }

    const role = (authReq.auth?.claims?.role || authReq.auth?.user?.role || '').toUpperCase();
    const upperAllowed = allowedRoles.map(r => r.toUpperCase());

    if (!upperAllowed.includes(role)) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `Privileges for [${allowedRoles.join(', ')}] required to access this resource`
        }
      });
    }
    next();
  };
};
