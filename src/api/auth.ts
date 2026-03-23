/**
 * Simple token-based auth middleware for the dashboard and API.
 *
 * When DASHBOARD_TOKEN is set in .env:
 * - Visitors must enter the token once, stored in a cookie (30 days)
 * - API requests can pass it via Authorization: Bearer <token> header
 * - WebSocket connections pass it as ?token= query param
 * - /api/health is always public (for monitoring)
 * - /auth and /auth/login are always public (login flow)
 *
 * When DASHBOARD_TOKEN is not set, everything is open (Tailscale-only security).
 */

import { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import crypto from "crypto";

const COOKIE_NAME = "feral_token";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Constant-time comparison to prevent timing attacks */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Extract token from cookie header (simple parsing, no cookie-parser dep) */
function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = header.split(";").find(c => c.trim().startsWith(`${name}=`));
  return match ? match.split("=")[1]?.trim() : undefined;
}

/**
 * Check if a request is authenticated.
 * Returns true if auth is disabled or the token matches.
 */
export function isAuthenticated(req: Request): boolean {
  if (!config.dashboard.authEnabled) return true;

  const expected = config.dashboard.token!;

  // Check Authorization header (for API clients)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (safeCompare(token, expected)) return true;
  }

  // Check cookie (for browser)
  const cookieToken = getCookie(req, COOKIE_NAME);
  if (cookieToken && safeCompare(cookieToken, expected)) return true;

  // Check query param (for simple links)
  const queryToken = req.query.token as string | undefined;
  if (queryToken && safeCompare(queryToken, expected)) return true;

  return false;
}

/**
 * Check if a WebSocket token query param is valid.
 */
export function isValidWsToken(token: string | null): boolean {
  if (!config.dashboard.authEnabled) return true;
  if (!token) return false;
  return safeCompare(token, config.dashboard.token!);
}

/**
 * Express middleware that protects routes behind token auth.
 * Always allows: /api/health, /auth, /auth/login, static assets
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.dashboard.authEnabled) {
    next();
    return;
  }

  // Public routes
  const path = req.path;
  if (
    path === "/api/health" ||
    path === "/auth" ||
    path === "/auth/login" ||
    path === "/auth/logout"
  ) {
    next();
    return;
  }

  if (isAuthenticated(req)) {
    next();
    return;
  }

  // API requests get a 401
  if (path.startsWith("/api/") || path.startsWith("/ws/")) {
    res.status(401).json({ error: "Unauthorized. Set Authorization: Bearer <token> header." });
    return;
  }

  // Browser requests get redirected to login
  res.redirect("/auth");
}

/**
 * Register auth routes (/auth, /auth/login, /auth/logout)
 */
export function registerAuthRoutes(app: any): void {
  // Login page
  app.get("/auth", (_req: Request, res: Response) => {
    if (!config.dashboard.authEnabled) {
      res.redirect("/");
      return;
    }
    res.send(loginPage());
  });

  // Handle login
  app.post("/auth/login", (req: Request, res: Response) => {
    if (!config.dashboard.authEnabled) {
      res.redirect("/");
      return;
    }

    const token = req.body?.token?.trim();
    if (!token || !safeCompare(token, config.dashboard.token!)) {
      res.send(loginPage("Invalid token. Try again."));
      return;
    }

    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE / 1000}`);
    res.redirect("/");
  });

  // Logout
  app.get("/auth/logout", (_req: Request, res: Response) => {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
    res.redirect("/auth");
  });
}

function loginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Feral — Login</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
    background: #0b0d14; color: #e4e7f0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: #161a25; border: 1px solid #2a3045; border-radius: 12px;
    padding: 40px; width: 100%; max-width: 380px; text-align: center;
  }
  .logo { font-size: 28px; font-weight: 700; color: #6c7cff; margin-bottom: 8px; }
  .logo span { color: #e4e7f0; font-weight: 400; }
  .subtitle { color: #7b82a0; font-size: 13px; margin-bottom: 28px; }
  .error { color: #f87171; font-size: 13px; margin-bottom: 16px; }
  input {
    width: 100%; padding: 10px 14px; border-radius: 8px; font-size: 14px;
    border: 1px solid #2a3045; background: #1c2130; color: #e4e7f0;
    outline: none; margin-bottom: 16px;
  }
  input:focus { border-color: #6c7cff; }
  button {
    width: 100%; padding: 10px; border-radius: 8px; font-size: 14px; font-weight: 600;
    border: none; background: #6c7cff; color: white; cursor: pointer;
  }
  button:hover { background: #5b6be6; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">feral<span> dashboard</span></div>
    <div class="subtitle">Enter your dashboard token to continue</div>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/auth/login">
      <input type="password" name="token" placeholder="Dashboard token" autofocus required>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}
