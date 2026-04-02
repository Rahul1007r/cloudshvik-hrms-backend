const { verifyAccessToken } = require('../config/jwt');
const db = require('../config/db');

// ── Authenticate JWT ───────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    // Fetch fresh user from DB
    const [rows] = await db.execute(
      `SELECT u.id, u.employee_id, u.full_name, u.email, u.role_id, u.is_active,
              r.name AS role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.is_active = 1`,
      [decoded.userId]
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired' });
    }
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// ── Authorize Roles ────────────────────────────────────────
const authorizeRoles = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role_name)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Required roles: ${roles.join(', ')}`,
    });
  }
  next();
};

// ── Authorize Permission ───────────────────────────────────
const authorizePermission = (module, action) => async (req, res, next) => {
  try {
    const [rows] = await db.execute(
      `SELECT 1 FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? AND p.module = ? AND p.action = ?`,
      [req.user.role_id, module, action]
    );

    if (!rows.length) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to perform this action',
      });
    }
    next();
  } catch {
    res.status(500).json({ success: false, message: 'Permission check failed' });
  }
};

// ── Audit Logger ──────────────────────────────────────────
const auditLog = (action, module = null) => async (req, res, next) => {
  res.on('finish', async () => {
    try {
      if (res.statusCode < 400) {
        await db.execute(
          `INSERT INTO audit_logs (user_id, action, module, ip_address, user_agent)
           VALUES (?, ?, ?, ?, ?)`,
          [
            req.user?.id || null,
            action,
            module,
            req.ip,
            req.get('user-agent') || '',
          ]
        );
      }
    } catch (_) {}
  });
  next();
};

module.exports = { authenticate, authorizeRoles, authorizePermission, auditLog };