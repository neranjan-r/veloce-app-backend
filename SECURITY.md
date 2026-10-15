# Veloce Security Architecture & Policy

## 1. Monetary Architecture & Integer Arithmetic
- **Zero Client-Side Trust**: All journey fares, surge multipliers, promotional discounts, and driver payouts are computed and verified strictly server-side.
- **Integer Paise Storage**: All financial values are stored as integer paise (`1 INR = 100 paise`) in the SQLite/PostgreSQL databases to eliminate IEEE 754 floating-point rounding errors.
- **Atomic Double-Spend & Concurrency Prevention**: Database operations utilize atomic transactions (`updateMany` conditional checks and idempotency keys) to prevent duplicate ride acceptances or double charges.

## 2. Authentication & Role-Based Access Control (RBAC)
- **Token Verification**: User identity is verified via Clerk JWTs and decoded with fallback test headers (`x-user-id`, `x-role`).
- **Endpoint Guarding**:
  - `requireAuth`: Enforces validated user credentials on all passenger and chauffeur APIs.
  - `requireAdmin`: Enforces administrative authorization (`claims.role === "ADMIN"`) on `/api/admin/*` endpoints.
- **Public Link Isolation**: Public emergency tracking links (`/track/:token`) bypass user authentication through dedicated cryptographically signed tokens without exposing account credentials.

## 3. Cryptographic Emergency Tracking
- **HMAC-SHA256 Token Signing**: Emergency SOS tracking tokens are generated using HMAC-SHA256 signatures with 12-hour validity windows.
- **Anti-Tampering**: Modifying the token payload or expiry timestamp instantly invalidates the tracking link.
- **Scope Restriction**: Public tracking tokens provide read-only access strictly to the active journey coordinates, assigned chauffeur details, and safety status.

## 4. Payment Security & Stripe PCI Compliance
- **Tokenized Transactions**: Raw card numbers are never stored in the database. Card credentials are processed through Stripe elements or tokenized PaymentMethods.
- **Webhook Signature Verification**: The `/webhooks/stripe` endpoint validates Stripe HMAC signatures using `stripe.webhooks.constructEvent` with the configured webhook signing secret.
- **Idempotent Payment Intents**: Payment settlement enforces idempotency checks to prevent redundant charges.

## 5. Input Validation & Strict Typing
- **Zod Schema Validation**: Every incoming API payload is parsed and validated using strict Zod schemas before reaching business logic.
- **Strict TypeScript**: The entire monorepo adheres to TypeScript strict mode with zero unchecked `any` bypasses.
