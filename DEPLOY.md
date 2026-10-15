# Veloce Deployment Guide

This guide details the click-by-click, step-by-step production deployment order for the Veloce Luxury Mobility platform across Supabase, Clerk, Stripe, Resend, Render, and Vercel.

---

## 1. Supabase (Managed PostgreSQL Database)

1. **Create Account & Organization**:
   - Go to [database.new](https://database.new) and log in or register.
   - Click **New Project** and name it `veloce-production`.
   - Set a strong database password and select the region closest to your users (e.g. `ap-south-1` for Mumbai).
2. **Retrieve Connection Strings**:
   - In your project settings, navigate to **Project Settings** > **Database**.
   - Under **Connection Strings**, select the **Transaction Connection Pooler** (port 6543) and copy the URI. This is your `DATABASE_URL`.
   - Select the **Direct Connection** (port 5432) and copy the URI. This is your `DIRECT_URL`.
3. **SSL Mode**:
   - Ensure `?sslmode=require` is appended to both connection strings.

---

## 2. Clerk (Authentication & Role Identity)

1. **Create Clerk Application**:
   - Go to [dashboard.clerk.com](https://dashboard.clerk.com) and click **Create Application**.
   - Name it `Veloce Mobility`. Enable Email/Password and Google OAuth sign-in options.
2. **Retrieve Production API Keys**:
   - In the sidebar, select **API Keys**.
   - Copy **Publishable Key** (`pk_live_...` or `pk_test_...` for staging).
   - Copy **Secret Key** (`sk_live_...` or `sk_test_...`).
3. **Configure Allowed Origins & Redirects**:
   - Go to **Configure** > **Paths**:
     - Sign-in path: `/sign-in`
     - Sign-up path: `/sign-up`
     - Home/After sign-in redirect: `/`
   - Go to **Configure** > **Domains** / **Allowed Origins**:
     - Add your Vercel deployment domain (e.g., `https://veloce.vercel.app`) and Render API domain.
4. **Configure Public Metadata Roles**:
   - Veloce derives user authorization server-side from `publicMetadata.role` (`RIDER`, `DRIVER`, or `ADMIN`).
   - For administrators, set `{"role": "ADMIN"}` in Clerk's user profile dashboard under **Public Metadata**.

---

## 3. Stripe (Payments & Webhook Processing)

1. **Activate Test/Live Mode**:
   - Go to [dashboard.stripe.com](https://dashboard.stripe.com).
   - Keep Test Mode toggled on for staging (`sk_test_...`) or toggle to Live Mode for production.
2. **Copy Secret Key**:
   - Navigate to **Developers** > **API Keys**.
   - Copy your **Secret Key** (`sk_test_...` or `sk_live_...`). This is `STRIPE_SECRET_KEY`.
3. **Configure Live Webhook Endpoint**:
   - Navigate to **Developers** > **Webhooks** and click **Add an endpoint**.
   - **Endpoint URL**: `https://<YOUR_RENDER_API_DOMAIN>/webhooks/stripe`
   - **Listen to events**:
     - `payment_intent.succeeded`
     - `payment_intent.payment_failed`
   - Click **Add endpoint**.
   - Under the created webhook page, click **Reveal signing secret** (`whsec_...`). This is `STRIPE_WEBHOOK_SECRET`.

---

## 4. Resend (Transactional PDF Receipts)

1. **Create API Key**:
   - Go to [resend.com/api-keys](https://resend.com/api-keys) and create a key with full sending access.
   - Copy the key (`re_...`). This is `RESEND_API_KEY`.
2. **Verify Domain**:
   - Go to **Domains** and add your custom sending domain (e.g., `veloce.app`).
   - Add the generated DKIM and SPF records in your DNS provider.
   - Set `RESEND_FROM="receipts@veloce.app"` (or `onboarding@resend.dev` for test sandboxes).

---

## 5. Render (API & WebSockets Deployment)

1. **New Web Service**:
   - Go to [dashboard.render.com](https://dashboard.render.com) > **New** > **Web Service**.
   - Connect your GitHub repository.
2. **Service Configuration**:
   - **Root Directory**: `.`
   - **Runtime**: `Node`
   - **Build Command**:
     ```bash
     pnpm install --frozen-lockfile && pnpm --filter api exec prisma generate && pnpm --filter api exec prisma migrate deploy
     ```
   - **Start Command**:
     ```bash
     pnpm --filter api run start
     ```
   - **Health Check Path**: `/health`
3. **Environment Variables**:
   - `PORT`: `10000`
   - `DATABASE_URL`: `<Supabase Transaction Pooler Connection String>`
   - `DIRECT_URL`: `<Supabase Direct Connection String>`
   - `CLERK_SECRET_KEY`: `<Clerk Secret Key>`
   - `CLERK_PUBLISHABLE_KEY`: `<Clerk Publishable Key>`
   - `CORS_ORIGIN`: `https://<YOUR_VERCEL_APP_DOMAIN>`
   - `STRIPE_SECRET_KEY`: `<Stripe Secret Key>`
   - `STRIPE_WEBHOOK_SECRET`: `<Stripe Webhook Signing Secret>`
   - `RESEND_API_KEY`: `<Resend API Key>`
   - `RESEND_FROM`: `receipts@veloce.app`
   - `TRACKING_SECRET`: `<Random 32-character Hex String>`

---

## 6. Vercel (Next.js Web Client Deployment)

1. **Import Project**:
   - Go to [vercel.com/new](https://vercel.com/new) and select the repository.
   - **Root Directory**: `frontend`
   - **Framework Preset**: `Next.js`
2. **Environment Variables**:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`: `<Clerk Publishable Key>`
   - `CLERK_SECRET_KEY`: `<Clerk Secret Key>`
   - `NEXT_PUBLIC_API_URL`: `https://<YOUR_RENDER_API_DOMAIN>`
   - `NEXT_PUBLIC_CLERK_SIGN_IN_URL`: `/sign-in`
   - `NEXT_PUBLIC_CLERK_SIGN_UP_URL`: `/sign-up`
   - `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`: `/`
   - `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL`: `/`
3. **Deploy**:
   - Click **Deploy**. Vercel will build and assign your production domain.

---

## 7. Database Seed & Smoke Testing

1. **Run Database Migrations & Initial Seed**:
   From your local terminal connected to production Supabase:
   ```bash
   pnpm --filter api exec prisma migrate deploy
   ```
2. **Execute Smoke Tests**:
   - Check `/health`: Verify `HTTP 200` with `{ "data": { "status": "healthy", "database": "connected" } }`.
   - Register a Rider account on Vercel frontend.
   - Register a Driver account, complete vehicle profile, and toggle online.
   - Request a ride with promo code `SAVE10`.
   - Accept the dispatch on the chauffeur dashboard.
   - Advance ride through `Arrived`, `In Progress`, and `Complete`.
   - Confirm payment triggers `payment_intent.succeeded` and receipt email delivery.
