import { v4 as uuidv4 } from 'uuid';

export function slugifyCode(prefix = 'dnm') {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
}

export function ensureAnonCookie(req, res) {
  let anonId = req.cookies.dnm_anon_id;
  if (!anonId) {
    anonId = uuidv4();
    res.cookie('dnm_anon_id', anonId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 180
    });
  }
  return anonId;
}
