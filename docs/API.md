# Veloce API Specification

This document details all REST API endpoints available on the Veloce Mobility backend (`apps/api`), including HTTP methods, authentication requirements, path parameters, request bodies, and JSON responses.

All responses follow the standard envelope format:
- **Success**: `{ "data": ... }`
- **Error**: `{ "error": { "code": "STRING", "message": "STRING" } }`

---

## 1. System & Health

### `GET /health`
- **Auth**: None (Public)
- **Description**: Verifies service status and live database connectivity.
- **Response**:
```json
{
  "data": {
    "status": "healthy",
    "database": "connected",
    "timestamp": "2026-10-12T03:00:00.000Z"
  }
}
```

---

## 2. Authentication & Identity

### `GET /api/me`
- **Auth**: Required (`Bearer <Clerk_Session_Token>`)
- **Description**: Returns the current authenticated user's profile and database role.
- **Response**:
```json
{
  "data": {
    "id": "cmv41234567890",
    "clerkId": "user_3KZ3YkSdinJeWIvmG3j9GJXySod",
    "role": "RIDER",
    "name": "Bruce Wayne",
    "email": "bruce@waynecorp.com",
    "phone": "+919876543210"
  }
}
```

---

## 3. Geocoding & Routing

### `GET /api/geocode/search`
- **Auth**: Required
- **Rate Limit**: 60 requests / minute
- **Query Params**: `q` (search string)
- **Response**:
```json
{
  "data": [
    {
      "display_name": "Connaught Place, New Delhi, Delhi, India",
      "lat": 28.6315,
      "lon": 77.2167
    }
  ]
}
```

### `GET /api/geocode/reverse`
- **Auth**: Required
- **Rate Limit**: 60 requests / minute
- **Query Params**: `lat`, `lng`
- **Response**:
```json
{
  "data": "Connaught Place, New Delhi, Delhi, India"
}
```

---

## 4. Rides & Journeys

### `POST /api/rides/estimate`
- **Auth**: Required
- **Request Body**:
```json
{
  "pickup": { "lat": 28.6315, "lng": 77.2167, "address": "Connaught Place" },
  "drop": { "lat": 28.5355, "lng": 77.3910, "address": "Noida Sector 62" },
  "stops": [
    { "lat": 28.5700, "lng": 77.3200, "address": "Intermediate Stop 1" }
  ],
  "promoCode": "SAVE10"
}
```
- **Response**:
```json
{
  "data": {
    "distanceMeters": 18500,
    "durationSeconds": 2100,
    "baseFarePaise": 55000,
    "fareEstimatePaise": 49500,
    "discountPaise": 5500,
    "promoApplied": "SAVE10",
    "options": [
      { "tier": "Veloce X", "farePaise": 49500 },
      { "tier": "Veloce Black", "farePaise": 74250 },
      { "tier": "Veloce Grand", "farePaise": 99000 }
    ]
  }
}
```

### `POST /api/rides`
- **Auth**: Required (RIDER or ADMIN)
- **Request Body**:
```json
{
  "pickupLat": 28.6315,
  "pickupLng": 77.2167,
  "pickupAddress": "Connaught Place",
  "dropLat": 28.5355,
  "dropLng": 77.3910,
  "dropAddress": "Sector 62",
  "vehicleType": "Veloce X",
  "promoCode": "SAVE10",
  "stops": []
}
```
- **Response**:
```json
{
  "data": {
    "id": "cmv4avgrm0003b0wagiwn9j9n",
    "status": "REQUESTED",
    "vehicleType": "Veloce X",
    "fareEstimatePaise": 49500
  }
}
```

### `GET /api/rides/:id`
- **Auth**: Required (Ride Owner, Assigned Driver, or Admin)
- **Response**:
```json
{
  "data": {
    "id": "cmv4avgrm0003b0wagiwn9j9n",
    "status": "ACCEPTED",
    "fareFinalPaise": 49500,
    "driver": {
      "name": "Alfred Pennyworth",
      "phone": "+919988776655",
      "vehicleModel": "Mercedes E-Class",
      "plateNumber": "DL 01 AB 1234",
      "avgRating": 4.95
    }
  }
}
```

### `POST /api/rides/:id/pay`
- **Auth**: Required (Ride Rider only)
- **Rate Limit**: 30 requests / minute
- **Request Body**:
```json
{
  "paymentMethodId": "pm_card_visa"
}
```
- **Response**:
```json
{
  "data": {
    "success": true,
    "payment": {
      "id": "pay_12345",
      "amountPaise": 49500,
      "status": "PENDING"
    },
    "clientSecret": "pi_123_secret_456"
  }
}
```

### `POST /api/rides/:id/sos`
- **Auth**: Required (Ride Participant)
- **Request Body**: `{ "lat": 28.6315, "lng": 77.2167 }`
- **Response**: Returns created `SosEvent` and signed emergency tracking link.

### `GET /api/rides/track/:token`
- **Auth**: Signed Token (Exempt from Clerk session)
- **Description**: Decodes HMAC-SHA256 tracking token and returns live GPS telemetry and journey details.

---

## 5. Chauffeur & Driver Operations

### `POST /api/driver/online`
- **Auth**: Required (DRIVER role)
- **Request Body**: `{ "lat": 28.6315, "lng": 77.2167, "vehicleType": "Veloce X" }`

### `POST /api/driver/offline`
- **Auth**: Required (DRIVER role)

### `POST /api/driver/rides/:id/accept`
- **Auth**: Required (DRIVER role)
- **Description**: Atomically claims ride dispatch with race-condition locking.

### `POST /api/driver/rides/:id/status`
- **Auth**: Required (Assigned Driver)
- **Request Body**: `{ "status": "ARRIVED" | "IN_PROGRESS" | "COMPLETED" }`

### `GET /api/driver/earnings`
- **Auth**: Required (DRIVER role)
- **Description**: Returns driver's internal ledger breakdown (80% revenue split).

---

## 6. Admin Management

### `GET /api/admin/stats`
- **Auth**: Required (`ADMIN` role strictly enforced)
- **Response**:
```json
{
  "data": {
    "totalRides": 42,
    "activeRides": 3,
    "totalDrivers": 12,
    "onlineDrivers": 5,
    "grossPaise": 1850000,
    "platformFeePaise": 370000,
    "activeSosCount": 0
  }
}
```

---

## 7. Webhook Ingestion

### `POST /webhooks/stripe`
- **Auth**: Signature Verified (`stripe-signature` header via `STRIPE_WEBHOOK_SECRET`)
- **Body**: Raw JSON Buffer
- **Events**: `payment_intent.succeeded`, `payment_intent.payment_failed`

### `POST /webhooks/clerk`
- **Auth**: Svix Verified (`svix-id`, `svix-timestamp`, `svix-signature` via `CLERK_WEBHOOK_SECRET`)
- **Events**: `user.created`, `user.updated`
