import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function signToken(userId: string, username: string) {
  return jwt.sign({ sub: userId, username }, JWT_SECRET, { expiresIn: '7d' });
}

export interface AuthedRequest extends Request {
  userId?: string;
  username?: string;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing token' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { sub: string; username: string };
    req.userId = payload.sub;
    req.username = payload.username;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

export function verifySocketToken(token: string): { userId: string; username: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; username: string };
    return { userId: payload.sub, username: payload.username };
  } catch {
    return null;
  }
}
