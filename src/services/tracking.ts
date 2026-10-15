import crypto from 'crypto';

const SECRET_KEY = process.env.TRACKING_SECRET || 'veloce_luxury_emergency_tracking_key_2026';

export interface TrackingPayload {
  rideId: string;
  expiresAt: number;
}

export function generateTrackingToken(rideId: string, durationMs = 12 * 60 * 60 * 1000): string {
  const expiresAt = Date.now() + durationMs;
  const payloadStr = JSON.stringify({ rideId, expiresAt });
  const payloadBase64 = Buffer.from(payloadStr, 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(payloadBase64).digest('base64url');
  return `${payloadBase64}.${signature}`;
}

export function verifyTrackingToken(token: string): TrackingPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadBase64, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', SECRET_KEY).update(payloadBase64).digest('base64url');
    if (signature !== expectedSig) return null;

    const payloadJson = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as TrackingPayload;

    if (Date.now() > payload.expiresAt) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
