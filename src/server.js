import express from 'express';
import { pool } from '../db.js';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { signToken, requireAuth, requireRole } from '../auth.js';
import { ensureAnonCookie, getClientIp, slugifyCode } from '../utils.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const PRACTITIONER_FEE = 60;
const AFFILIATE_COMMISSION = 25;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

async function getOrCreateVisitor(req, res) {
  const anonId = ensureAnonCookie(req, res);
  const existing = await query('SELECT id FROM visitors WHERE anon_cookie_id = $1 LIMIT 1', [anonId]);
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;

  if (existing.rows.length > 0) {
    const visitorId = existing.rows[0].id;
    await query(
      `UPDATE visitors
       SET last_seen_at = NOW(), ip_address = COALESCE($2, ip_address), user_agent = COALESCE($3, user_agent)
       WHERE id = $1`,
      [visitorId, ip, userAgent]
    );
    return visitorId;
  }

  const inserted = await query(
    `INSERT INTO visitors (anon_cookie_id, ip_address, user_agent)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [anonId, ip, userAgent]
  );
  return inserted.rows[0].id;
}

async function logEvent({ trackingLinkId, visitorId, eventName, eventValue = null, meta = {} }) {
  await query(
    `INSERT INTO tracking_events (tracking_link_id, visitor_id, event_name, event_value, meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [trackingLinkId, visitorId, eventName, eventValue, JSON.stringify(meta)]
  );
}

async function getProfile(user) {
  if (user.role === 'affiliate') {
    const result = await query(
      `SELECT a.id, a.referral_code, u.full_name, u.email, u.role
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE u.id = $1`,
      [user.id]
    );
    return result.rows[0];
  }
  if (user.role === 'practitioner') {
    const result = await query(
      `SELECT p.id, p.practice_name, p.specialty, p.location, u.full_name, u.email, u.role
       FROM practitioners p
       JOIN users u ON u.id = p.user_id
       WHERE u.id = $1`,
      [user.id]
    );
    return result.rows[0];
  }
  const result = await query(`SELECT id, full_name, email, role FROM users WHERE id = $1`, [user.id]);
  return result.rows[0];
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Doktor Near Me Affiliate API' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { full_name, email, password, phone, role, practice_name, specialty, location } = req.body;

    if (!['affiliate', 'practitioner'].includes(role)) {
      return res.status(400).json({ error: 'Only affiliate or practitioner self-registration is allowed' });
    }

    const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const userInsert = await query(
      `INSERT INTO users (full_name, email, password_hash, role, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, full_name, email, role`,
      [full_name, email, password_hash, role, phone || null]
    );

    const user = userInsert.rows[0];

    if (role === 'affiliate') {
      await query(
        `INSERT INTO affiliates (user_id, referral_code)
         VALUES ($1, $2)`,
        [user.id, slugifyCode('aff')]
      );
    }

    if (role === 'practitioner') {
      await query(
        `INSERT INTO practitioners (user_id, practice_name, specialty, location)
         VALUES ($1, $2, $3, $4)`,
        [user.id, practice_name, specialty || null, location || null]
      );
    }

    const token = signToken(user);
    const profile = await getProfile(user);
    return res.json({ token, user: profile });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken(user);
    const profile = await getProfile(user);
    return res.json({ token, user: profile });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  const profile = await getProfile(req.user);
  res.json({ user: profile });
});

app.get('/t/impression/:slug', async (req, res) => {
  try {
    const visitorId = await getOrCreateVisitor(req, res);
    const link = await query('SELECT id FROM tracking_links WHERE slug = $1 AND active = true LIMIT 1', [req.params.slug]);
    if (!link.rows.length) return res.status(404).json({ error: 'Tracking link not found' });

    await logEvent({
      trackingLinkId: link.rows[0].id,
      visitorId,
      eventName: 'impression',
      meta: { referrer: req.headers.referer || null }
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to log impression' });
  }
});

app.get('/r/:slug', async (req, res) => {
  try {
    const visitorId = await getOrCreateVisitor(req, res);
    const result = await query(
      `SELECT id, affiliate_id, practitioner_id, destination_url
       FROM tracking_links WHERE slug = $1 AND active = true LIMIT 1`,
      [req.params.slug]
    );

    if (!result.rows.length) return res.status(404).send('Invalid link');
    const link = result.rows[0];

    await logEvent({
      trackingLinkId: link.id,
      visitorId,
      eventName: 'click',
      meta: { referrer: req.headers.referer || null, query: req.query }
    });

    const referral = await query(
      `INSERT INTO referrals (
        tracking_link_id, affiliate_id, practitioner_id, visitor_id, status,
        practitioner_fee_zar, affiliate_commission_zar
      )
      VALUES ($1, $2, $3, $4, 'clicked', $5, $6)
      RETURNING id`,
      [link.id, link.affiliate_id, link.practitioner_id, visitorId, PRACTITIONER_FEE, AFFILIATE_COMMISSION]
    );

    const redirectUrl = new URL(link.destination_url);
    redirectUrl.searchParams.set('referral_id', referral.rows[0].id);
    res.redirect(redirectUrl.toString());
  } catch (error) {
    console.error(error);
    res.status(500).send('Redirect failed');
  }
});

app.post('/api/public/lead', async (req, res) => {
  try {
    const { referral_id, patient_first_name, patient_last_name, patient_phone, patient_email, notes } = req.body;
    const referral = await query('SELECT * FROM referrals WHERE id = $1 LIMIT 1', [referral_id]);
    if (!referral.rows.length) return res.status(404).json({ error: 'Referral not found' });

    const updated = await query(
      `UPDATE referrals
       SET patient_first_name = $2,
           patient_last_name = $3,
           patient_phone = $4,
           patient_email = $5,
           notes = $6,
           status = 'lead_submitted',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [referral_id, patient_first_name, patient_last_name, patient_phone, patient_email, notes || null]
    );

    await logEvent({
      trackingLinkId: updated.rows[0].tracking_link_id,
      visitorId: updated.rows[0].visitor_id,
      eventName: 'lead_submitted',
      eventValue: referral_id,
      meta: { has_phone: Boolean(patient_phone), has_email: Boolean(patient_email) }
    });

    res.json({ success: true, referral: updated.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Lead capture failed' });
  }
});

app.post('/api/public/booking', async (req, res) => {
  try {
    const { referral_id, appointment_date } = req.body;
    const referral = await query('SELECT * FROM referrals WHERE id = $1 LIMIT 1', [referral_id]);
    if (!referral.rows.length) return res.status(404).json({ error: 'Referral not found' });

    const booking = await query(
      `INSERT INTO bookings (referral_id, appointment_date, booking_status)
       VALUES ($1, $2, 'booked')
       RETURNING *`,
      [referral_id, appointment_date]
    );

    const updated = await query(
      `UPDATE referrals
       SET status = 'booked', booked_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [referral_id]
    );

    await logEvent({
      trackingLinkId: updated.rows[0].tracking_link_id,
      visitorId: updated.rows[0].visitor_id,
      eventName: 'booked',
      eventValue: referral_id,
      meta: { appointment_date }
    });

    res.json({ success: true, booking: booking.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Booking failed' });
  }
});

app.get('/api/admin/summary', requireAuth, requireRole('admin'), async (_req, res) => {
  try {
    const funnel = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'clicked') AS clicked,
        COUNT(*) FILTER (WHERE status = 'lead_submitted') AS leads,
        COUNT(*) FILTER (WHERE status = 'booked') AS booked,
        COUNT(*) FILTER (WHERE status = 'arrived') AS arrived,
        COUNT(*) FILTER (WHERE status = 'consulted') AS consulted,
        COUNT(*) FILTER (WHERE status = 'treated') AS treated
      FROM referrals
    `);

    const finance = await query(`
      SELECT
        COALESCE((SELECT SUM(amount_zar) FROM invoices), 0) AS practitioner_revenue,
        COALESCE((SELECT SUM(amount_zar) FROM affiliate_payouts), 0) AS affiliate_commissions
    `);

    const counts = await query(`
      SELECT
        (SELECT COUNT(*) FROM affiliates) AS affiliates,
        (SELECT COUNT(*) FROM practitioners) AS practitioners,
        (SELECT COUNT(*) FROM tracking_links) AS tracking_links,
        (SELECT COUNT(*) FROM campaigns) AS campaigns
    `);

    res.json({
      funnel: funnel.rows[0],
      finance: finance.rows[0],
      counts: counts.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

app.get('/api/admin/users', requireAuth, requireRole('admin'), async (_req, res) => {
  const result = await query('SELECT id, full_name, email, role, phone, created_at FROM users ORDER BY created_at DESC');
  res.json(result.rows);
});

app.get('/api/admin/practitioners', requireAuth, requireRole('admin'), async (_req, res) => {
  const result = await query(`
    SELECT p.id, p.practice_name, p.specialty, p.location, p.active, u.full_name, u.email, p.created_at
    FROM practitioners p
    JOIN users u ON u.id = p.user_id
    ORDER BY p.created_at DESC
  `);
  res.json(result.rows);
});

app.get('/api/admin/affiliates', requireAuth, requireRole('admin'), async (_req, res) => {
  const result = await query(`
    SELECT a.id, a.referral_code, a.active, u.full_name, u.email, a.created_at
    FROM affiliates a
    JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC
  `);
  res.json(result.rows);
});

app.get('/api/admin/campaigns', requireAuth, requireRole('admin'), async (_req, res) => {
  const result = await query('SELECT * FROM campaigns ORDER BY created_at DESC');
  res.json(result.rows);
});

app.post('/api/admin/campaigns', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, channel, post_name, utm_source, utm_medium, utm_campaign } = req.body;
  const inserted = await query(
    `INSERT INTO campaigns (name, channel, post_name, utm_source, utm_medium, utm_campaign, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [name, channel || null, post_name || null, utm_source || null, utm_medium || null, utm_campaign || null, req.user.id]
  );
  res.json(inserted.rows[0]);
});

app.post('/api/admin/tracking-links', requireAuth, requireRole('admin'), async (req, res) => {
  const { affiliate_id, practitioner_id, campaign_id, destination_url } = req.body;
  const slug = slugifyCode('trk');
  const inserted = await query(
    `INSERT INTO tracking_links (affiliate_id, practitioner_id, campaign_id, slug, destination_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [affiliate_id, practitioner_id, campaign_id || null, slug, destination_url]
  );
  res.json({
    ...inserted.rows[0],
    public_tracking_url: `${process.env.APP_BASE_URL}/r/${slug}`,
    impression_pixel_url: `${process.env.APP_BASE_URL}/t/impression/${slug}`
  });
});

app.get('/api/admin/tracking-links', requireAuth, requireRole('admin'), async (_req, res) => {
  const result = await query(`
    SELECT tl.*, a.referral_code, p.practice_name, c.name AS campaign_name,
           CONCAT($1, '/r/', tl.slug) AS public_tracking_url,
           CONCAT($1, '/t/impression/', tl.slug) AS impression_pixel_url
    FROM tracking_links tl
    JOIN affiliates a ON a.id = tl.affiliate_id
    JOIN practitioners p ON p.id = tl.practitioner_id
    LEFT JOIN campaigns c ON c.id = tl.campaign_id
    ORDER BY tl.created_at DESC
  `, [process.env.APP_BASE_URL]);
  res.json(result.rows);
});

app.get('/api/admin/referrals', requireAuth, requireRole('admin'), async (_req, res) => {
  const result = await query(`
    SELECT r.*, a.referral_code, p.practice_name, tl.slug
    FROM referrals r
    JOIN affiliates a ON a.id = r.affiliate_id
    JOIN practitioners p ON p.id = r.practitioner_id
    JOIN tracking_links tl ON tl.id = r.tracking_link_id
    ORDER BY r.created_at DESC
  `);
  res.json(result.rows);
});

app.get('/api/affiliate/dashboard', requireAuth, requireRole('affiliate'), async (req, res) => {
  const affiliate = await query('SELECT id, referral_code FROM affiliates WHERE user_id = $1 LIMIT 1', [req.user.id]);
  const affiliateId = affiliate.rows[0].id;

  const stats = await query(`
    SELECT
      COUNT(*) AS total_referrals,
      COUNT(*) FILTER (WHERE status = 'lead_submitted') AS leads,
      COUNT(*) FILTER (WHERE status = 'booked') AS booked,
      COUNT(*) FILTER (WHERE status IN ('consulted','treated')) AS confirmed,
      COALESCE(SUM(CASE WHEN status IN ('consulted','treated') THEN affiliate_commission_zar ELSE 0 END), 0) AS earnings
    FROM referrals
    WHERE affiliate_id = $1
  `, [affiliateId]);

  const links = await query(`
    SELECT tl.*, p.practice_name, c.name AS campaign_name,
           CONCAT($1, '/r/', tl.slug) AS public_tracking_url,
           CONCAT($1, '/t/impression/', tl.slug) AS impression_pixel_url
    FROM tracking_links tl
    JOIN practitioners p ON p.id = tl.practitioner_id
    LEFT JOIN campaigns c ON c.id = tl.campaign_id
    WHERE tl.affiliate_id = $2
    ORDER BY tl.created_at DESC
  `, [process.env.APP_BASE_URL, affiliateId]);

  const referrals = await query(`
    SELECT r.*, p.practice_name
    FROM referrals r
    JOIN practitioners p ON p.id = r.practitioner_id
    WHERE r.affiliate_id = $1
    ORDER BY r.created_at DESC
  `, [affiliateId]);

  res.json({ profile: affiliate.rows[0], stats: stats.rows[0], links: links.rows, referrals: referrals.rows });
});

app.get('/api/practitioner/dashboard', requireAuth, requireRole('practitioner'), async (req, res) => {
  const practitioner = await query(
    'SELECT id, practice_name, specialty, location FROM practitioners WHERE user_id = $1 LIMIT 1',
    [req.user.id]
  );
  const practitionerId = practitioner.rows[0].id;

  const stats = await query(`
    SELECT
      COUNT(*) AS total_referrals,
      COUNT(*) FILTER (WHERE status = 'lead_submitted') AS leads,
      COUNT(*) FILTER (WHERE status = 'booked') AS booked,
      COUNT(*) FILTER (WHERE status IN ('consulted','treated')) AS confirmed,
      COALESCE(SUM(CASE WHEN status IN ('consulted','treated') THEN practitioner_fee_zar ELSE 0 END), 0) AS fees_due
    FROM referrals
    WHERE practitioner_id = $1
  `, [practitionerId]);

  const referrals = await query(`
    SELECT r.*, a.referral_code
    FROM referrals r
    JOIN affiliates a ON a.id = r.affiliate_id
    WHERE r.practitioner_id = $1
    ORDER BY r.created_at DESC
  `, [practitionerId]);

  const invoices = await query('SELECT * FROM invoices WHERE practitioner_id = $1 ORDER BY created_at DESC', [practitionerId]);
  res.json({ profile: practitioner.rows[0], stats: stats.rows[0], referrals: referrals.rows, invoices: invoices.rows });
});

app.post('/api/practitioner/confirm', requireAuth, requireRole('practitioner'), async (req, res) => {
  try {
    const { referral_id, stage } = req.body;
    const allowed = ['arrived', 'consulted', 'treated'];
    if (!allowed.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });

    const practitioner = await query('SELECT id FROM practitioners WHERE user_id = $1 LIMIT 1', [req.user.id]);
    const practitionerId = practitioner.rows[0].id;

    const referralResult = await query(
      'SELECT * FROM referrals WHERE id = $1 AND practitioner_id = $2 LIMIT 1',
      [referral_id, practitionerId]
    );
    if (!referralResult.rows.length) return res.status(404).json({ error: 'Referral not found' });

    const columnMap = { arrived: 'arrived_at', consulted: 'consulted_at', treated: 'treated_at' };
    const updated = await query(
      `UPDATE referrals
       SET status = $2,
           ${columnMap[stage]} = NOW(),
           practitioner_confirmed = true,
           practitioner_confirmed_by = $3,
           practitioner_confirmed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [referral_id, stage, req.user.id]
    );

    const row = updated.rows[0];

    await logEvent({
      trackingLinkId: row.tracking_link_id,
      visitorId: row.visitor_id,
      eventName: stage,
      eventValue: referral_id,
      meta: { practitioner_user_id: req.user.id }
    });

    if (stage === 'consulted' || stage === 'treated') {
      const invoice = await query('SELECT id FROM invoices WHERE referral_id = $1 LIMIT 1', [referral_id]);
      if (!invoice.rows.length) {
        await query(
          'INSERT INTO invoices (practitioner_id, referral_id, amount_zar, status) VALUES ($1, $2, $3, $4)',
          [row.practitioner_id, referral_id, row.practitioner_fee_zar, 'unpaid']
        );
      }

      const payout = await query('SELECT id FROM affiliate_payouts WHERE referral_id = $1 LIMIT 1', [referral_id]);
      if (!payout.rows.length) {
        await query(
          'INSERT INTO affiliate_payouts (affiliate_id, referral_id, amount_zar, status) VALUES ($1, $2, $3, $4)',
          [row.affiliate_id, referral_id, row.affiliate_commission_zar, 'pending']
        );
      }
    }

    res.json({ success: true, referral: row });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

app.get('/api/public/referral/:referralId', async (req, res) => {
  const result = await query('SELECT id, status, patient_first_name, patient_last_name FROM referrals WHERE id = $1', [req.params.referralId]);
  if (!result.rows.length) return res.status(404).json({ error: 'Referral not found' });
  res.json(result.rows[0]);
});
app.get("/test-db", async (req, res) => {
  try {
    const result = await query("SELECT * FROM referrals ORDER BY id DESC LIMIT 5");

    res.json({
      ok: true,
      count: result.rows.length,
      referrals: result.rows,
    });
  } catch (error) {
    console.error("TEST-DB ERROR:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});
app.post("/api/practitioners", async (req, res) => {
  try {
    const { name, specialty, location } = req.body;

    const result = await query(
      `INSERT INTO practitioners (name, specialty, location)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, specialty, location]
    );

    res.json({
      ok: true,
      practitioner: result.rows[0],
    });
  } catch (error) {
    console.error("CREATE PRACTITIONER ERROR:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});
app.post("/api/affiliates", async (req, res) => {
  try {
    const { user_id, referral_code, total_earnings = 0 } = req.body;

    const result = await query(
      `INSERT INTO affiliates (user_id, referral_code, total_earnings)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [user_id, referral_code, total_earnings]
    );

    res.json({
      ok: true,
      affiliate: result.rows[0],
    });
  } catch (error) {
    console.error("CREATE AFFILIATE ERROR:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});
app.post("/api/bookings", async (req, res) => {
  try {
    const { user_id, practitioner_id, appointment_date, status = "pending" } = req.body;

    const result = await query(
      `INSERT INTO bookings (user_id, practitioner_id, appointment_date, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user_id, practitioner_id, appointment_date, status]
    );

    res.json({
      ok: true,
      booking: result.rows[0],
    });
  } catch (error) {
    console.error("CREATE BOOKING ERROR:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});
app.post("/api/referrals", async (req, res) => {
  try {
    const {
      affiliate_id,
      user_id,
      booking_id,
      commission = 25,
      status = "pending",
    } = req.body;

    const result = await query(
      `INSERT INTO referrals (affiliate_id, user_id, booking_id, commission, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [affiliate_id, user_id, booking_id, commission, status]
    );

    res.json({
      ok: true,
      referral: result.rows[0],
    });
  } catch (error) {
    console.error("CREATE REFERRAL ERROR:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
});
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
