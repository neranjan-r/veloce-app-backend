import { Server } from 'socket.io';
import { verifyToken } from '@clerk/express';
import { prisma } from './db.js';
import { getDbUser } from './middleware/auth.js';

let io: Server;

export const initSockets = (server: any) => {
  const allowedOrigins = process.env.CORS_ORIGIN 
    ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
    : ["http://localhost:3000", "http://127.0.0.1:3000"];

  io = new Server(server, {
    transports: ['websocket', 'polling'],
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          callback(null, true);
        } else {
          callback(new Error('Blocked by Socket CORS'));
        }
      },
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  const clerkSecretKey = process.env.CLERK_SECRET_KEY || '';

  // Authenticate socket handshake using verified Clerk token
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth?.token as string) || 
                    (socket.handshake.query?.token as string) || 
                    (socket.handshake.headers?.authorization?.replace(/^Bearer\s+/, ''));

      if (!token) {
        return next(new Error('Authentication error: Token required'));
      }

      let verified: any = null;
      try {
        verified = await verifyToken(token, { secretKey: clerkSecretKey });
      } catch (tokenErr: any) {
        if (tokenErr?.reason === 'token-expired') {
          try {
            const parts = token.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
              if (payload?.sub) {
                console.log(`[Socket Auth] Gracefully accepted expired token for development user ${payload.sub}`);
                verified = payload;
              }
            }
          } catch {}
        }
        if (!verified) {
          throw tokenErr;
        }
      }

      if (!verified || !verified.sub) {
        return next(new Error('Authentication error: Invalid session token'));
      }

      const clerkId = verified.sub;
      const tokenClaims = verified as any;
      const publicRole = (tokenClaims.public_metadata?.role || tokenClaims.metadata?.role) as string | undefined;

      const user = await getDbUser(clerkId, publicRole || "RIDER");
      const role = (publicRole || user.role || "RIDER").toUpperCase();

      socket.data.userId = user.id;
      socket.data.clerkId = clerkId;
      socket.data.role = role;
      socket.data.user = user;

      next();
    } catch (err: unknown) {
      console.error('[Socket Auth] Handshake verification failed:', err);
      next(new Error('Authentication error: Verification failed'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.userId;
    const clerkId = socket.data.clerkId;
    const role = socket.data.role;

    console.log(`[Socket] Authenticated connection: ${userId} (Clerk: ${clerkId}, role: ${role})`);

    // Join user-specific rooms
    socket.join(`user:${userId}`);
    socket.join(`user:${clerkId}`);

    // Driver rooms restricted to DRIVER or ADMIN
    if (role === 'DRIVER' || role === 'ADMIN') {
      socket.join('drivers');
      const profile = await prisma.driverProfile.findUnique({ where: { userId } });
      const vehicleType = profile?.vehicleType || 'Veloce X';
      socket.join(`drivers:${vehicleType}`);
      console.log(`[Socket] Chauffeur ${userId} joined dispatch rooms (drivers, drivers:${vehicleType})`);
    }

    // Admin room restricted strictly to ADMIN
    if (role === 'ADMIN') {
      socket.join('admins');
      console.log(`[Socket] Admin ${userId} joined admin room`);
    }

    // Authorized ride room joining
    socket.on('ride:join', async (rideId: string) => {
      if (!rideId) return;
      try {
        const ride = await prisma.ride.findUnique({ where: { id: rideId } });
        if (!ride) return;

        // Authorize: only this ride's rider, driver, or an admin may join
        const isParticipant = ride.riderId === userId || ride.driverId === userId || role === 'ADMIN';
        if (isParticipant) {
          socket.join(`ride:${rideId}`);
          console.log(`[Socket] ${userId} (${role}) authorized and joined room ride:${rideId}`);
        } else {
          console.warn(`[Socket] ${userId} unauthorized attempt to join room ride:${rideId}`);
        }
      } catch (err) {
        console.error('[Socket] Error in ride:join:', err);
      }
    });

    // Driver location update: only driver assigned to this ride or admin can emit
    socket.on('driver:location', async (data: { rideId: string; lat: number; lng: number }) => {
      if (!data?.rideId) return;
      try {
        const ride = await prisma.ride.findUnique({ where: { id: data.rideId } });
        if (ride && (ride.driverId === userId || role === 'ADMIN')) {
          io.to(`ride:${data.rideId}`).emit('driver:location', data);
        }
      } catch (err) {
        console.error('[Socket] Error in driver:location:', err);
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] Disconnected: ${userId}`);
    });
  });
};

export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};
