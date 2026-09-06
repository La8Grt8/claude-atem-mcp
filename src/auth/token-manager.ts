import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// Generate a secure secret on startup (in production, use env variable)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const TOKEN_EXPIRY = '24h';
const REFRESH_TOKEN_EXPIRY = '7d';

interface TokenPayload {
  sub: string;      // client_id
  scope: string;
  iat: number;
  exp: number;
}

interface StoredToken {
  token: string;
  clientId: string;
  issuedAt: Date;
  expiresAt: Date;
  lastUsed: Date;
  requestCount: number;
  scope: string;
}

interface StoredClient {
  clientId: string;
  clientSecret: string;
  clientName: string;
  redirectUris: string[];
  createdAt: Date;
}

class TokenManager {
  private tokens = new Map<string, StoredToken>();
  private refreshTokens = new Map<string, { clientId: string; expiresAt: Date }>();
  private clients = new Map<string, StoredClient>();
  private authorizationCodes = new Map<string, { clientId: string; redirectUri: string; expiresAt: Date }>();

  // Register a new OAuth client
  registerClient(clientId: string, clientSecret: string, clientName: string, redirectUris: string[]): StoredClient {
    const client: StoredClient = {
      clientId,
      clientSecret,
      clientName,
      redirectUris,
      createdAt: new Date()
    };
    this.clients.set(clientId, client);
    console.error(`[AUTH] Registered client: ${clientName} (${clientId})`);
    return client;
  }

  // Generate authorization code
  createAuthorizationCode(clientId: string, redirectUri: string): string {
    const code = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    this.authorizationCodes.set(code, { clientId, redirectUri, expiresAt });

    // Cleanup expired codes
    this.cleanupExpiredCodes();

    return code;
  }

  // Validate and consume authorization code
  validateAuthorizationCode(code: string, clientId: string): { valid: boolean; redirectUri?: string } {
    const stored = this.authorizationCodes.get(code);

    if (!stored) {
      console.error(`[AUTH] ✗ Invalid authorization code`);
      return { valid: false };
    }

    if (stored.expiresAt < new Date()) {
      console.error(`[AUTH] ✗ Expired authorization code`);
      this.authorizationCodes.delete(code);
      return { valid: false };
    }

    if (stored.clientId !== clientId) {
      console.error(`[AUTH] ✗ Authorization code client mismatch`);
      return { valid: false };
    }

    // Consume the code (one-time use)
    this.authorizationCodes.delete(code);
    return { valid: true, redirectUri: stored.redirectUri };
  }

  // Validate client credentials
  validateClient(clientId: string, clientSecret: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      console.error(`[AUTH] ✗ Unknown client: ${clientId}`);
      return false;
    }

    if (client.clientSecret !== clientSecret) {
      console.error(`[AUTH] ✗ Invalid client secret for: ${clientId}`);
      return false;
    }

    return true;
  }

  // Issue JWT access token
  issueToken(clientId: string, scope: string = 'mcp:tools'): { accessToken: string; refreshToken: string } {
    const payload: TokenPayload = {
      sub: clientId,
      scope,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hours
    };

    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    const refreshToken = crypto.randomBytes(32).toString('base64url');

    // Store token metadata
    const now = new Date();
    this.tokens.set(accessToken, {
      token: accessToken,
      clientId,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      lastUsed: now,
      requestCount: 0,
      scope
    });

    // Store refresh token
    this.refreshTokens.set(refreshToken, {
      clientId,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) // 7 days
    });

    console.error(`[AUTH] ✓ Issued token for ${clientId}: ${accessToken.substring(0, 20)}... (${this.tokens.size} active)`);

    return { accessToken, refreshToken };
  }

  // Validate JWT token
  validateToken(token: string): { valid: boolean; clientId?: string; scope?: string } {
    try {
      // Verify JWT signature and expiration
      const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;

      // Check if token is in our store (not revoked)
      const stored = this.tokens.get(token);
      if (!stored) {
        console.error(`[AUTH] ✗ Token not in store (possibly revoked)`);
        return { valid: false };
      }

      // Update last used timestamp and request count
      stored.lastUsed = new Date();
      stored.requestCount++;

      console.error(`[AUTH] ✓ Valid token for ${decoded.sub} (used ${stored.requestCount} times)`);

      return {
        valid: true,
        clientId: decoded.sub,
        scope: decoded.scope
      };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        console.error(`[AUTH] ✗ Token expired`);
        this.tokens.delete(token); // Remove expired token
      } else if (error instanceof jwt.JsonWebTokenError) {
        console.error(`[AUTH] ✗ Invalid token signature`);
      } else {
        console.error(`[AUTH] ✗ Token validation error: ${error}`);
      }
      return { valid: false };
    }
  }

  // Refresh access token
  refreshAccessToken(refreshToken: string): { accessToken?: string; error?: string } {
    const stored = this.refreshTokens.get(refreshToken);

    if (!stored) {
      return { error: 'Invalid refresh token' };
    }

    if (stored.expiresAt < new Date()) {
      this.refreshTokens.delete(refreshToken);
      return { error: 'Refresh token expired' };
    }

    const { accessToken } = this.issueToken(stored.clientId);
    return { accessToken };
  }

  // Revoke token (for logout/security)
  revokeToken(token: string): boolean {
    const deleted = this.tokens.delete(token);
    if (deleted) {
      console.error(`[AUTH] Revoked token: ${token.substring(0, 20)}...`);
    }
    return deleted;
  }

  // Revoke all tokens for a client
  revokeClientTokens(clientId: string): number {
    let count = 0;
    for (const [token, stored] of this.tokens.entries()) {
      if (stored.clientId === clientId) {
        this.tokens.delete(token);
        count++;
      }
    }
    console.error(`[AUTH] Revoked ${count} tokens for client ${clientId}`);
    return count;
  }

  // Get token statistics
  getStats(): { activeTokens: number; activeClients: number; totalRequests: number } {
    let totalRequests = 0;
    for (const stored of this.tokens.values()) {
      totalRequests += stored.requestCount;
    }

    return {
      activeTokens: this.tokens.size,
      activeClients: this.clients.size,
      totalRequests
    };
  }

  // Cleanup expired tokens and codes
  private cleanupExpiredCodes(): void {
    const now = new Date();
    for (const [code, data] of this.authorizationCodes.entries()) {
      if (data.expiresAt < now) {
        this.authorizationCodes.delete(code);
      }
    }
  }

  // Periodic cleanup (call this on interval)
  cleanupExpired(): void {
    const now = new Date();
    let cleaned = 0;

    // Cleanup expired tokens
    for (const [token, stored] of this.tokens.entries()) {
      if (stored.expiresAt < now) {
        this.tokens.delete(token);
        cleaned++;
      }
    }

    // Cleanup expired refresh tokens
    for (const [refreshToken, stored] of this.refreshTokens.entries()) {
      if (stored.expiresAt < now) {
        this.refreshTokens.delete(refreshToken);
      }
    }

    if (cleaned > 0) {
      console.error(`[AUTH] Cleaned up ${cleaned} expired tokens`);
    }
  }

  // Audit log for a request
  logRequest(clientId: string, method: string, toolName?: string): void {
    const timestamp = new Date().toISOString();
    console.error(`[AUDIT] ${timestamp} | client=${clientId} | method=${method} | tool=${toolName || 'N/A'}`);
  }
}

// Export singleton instance
export const tokenManager = new TokenManager();

// Cleanup expired tokens every 15 minutes
setInterval(() => tokenManager.cleanupExpired(), 15 * 60 * 1000);
