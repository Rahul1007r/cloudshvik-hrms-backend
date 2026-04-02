const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('../config/db');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../config/jwt');
const { sendPasswordResetOTP } = require('../config/mailer');

// ── Helper: generate 6-digit OTP ──────────────────────────
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// ── POST /api/auth/login ───────────────────────────────────
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Find user with role
    const [users] = await db.execute(
      `SELECT u.*, r.name AS role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.email = ? AND u.is_active = 1`,
      [email.toLowerCase().trim()]
    );

    if (!users.length) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const user = users[0];

    // 2. Verify password
    const bcrypt = require("bcryptjs");

const passwords = "Admin@123";
const hash = await bcrypt.hash(passwords, 10);

console.log("Password : "+hash);
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // 3. Fetch permissions
    const [permissions] = await db.execute(
      `SELECT p.module, p.action FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ?`,
      [user.role_id]
    );

    // 4. Generate tokens
    const payload = { userId: user.id, roleId: user.role_id, roleName: user.role_name };
    const accessToken  = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    // 5. Store refresh token
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.execute(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, refreshToken, expiresAt]
    );

    // 6. Update last login
    await db.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    // 7. Audit log
    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [user.id, 'LOGIN', 'auth', req.ip]
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        accessToken,
        refreshToken,
        user: {
          id:          user.id,
          employeeId:  user.employee_id,
          fullName:    user.full_name,
          email:       user.email,
          role:        user.role_name,
          avatarUrl:   user.avatar_url,
          permissions: permissions.map(p => `${p.module}:${p.action}`),
        },
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ── POST /api/auth/refresh ─────────────────────────────────
const refreshToken = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Refresh token required' });

    // Verify token
    const decoded = verifyRefreshToken(token);

    // Check in DB (not revoked)
    const [rows] = await db.execute(
      'SELECT * FROM refresh_tokens WHERE token = ? AND revoked = 0 AND expires_at > NOW()',
      [token]
    );
    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    // Issue new access token
    const newAccessToken = generateAccessToken({
      userId:   decoded.userId,
      roleId:   decoded.roleId,
      roleName: decoded.roleName,
    });

    res.json({ success: true, data: { accessToken: newAccessToken } });
  } catch {
    res.status(401).json({ success: false, message: 'Invalid refresh token' });
  }
};

// ── POST /api/auth/logout ──────────────────────────────────
const logout = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;
    if (token) {
      await db.execute('UPDATE refresh_tokens SET revoked = 1 WHERE token = ?', [token]);
    }
    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user?.id, 'LOGOUT', 'auth', req.ip]
    );
    res.json({ success: true, message: 'Logged out successfully' });
  } catch {
    res.status(500).json({ success: false, message: 'Logout failed' });
  }
};

// ── POST /api/auth/forgot-password ────────────────────────
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const [users] = await db.execute(
      'SELECT id, full_name, email FROM users WHERE email = ? AND is_active = 1',
      [email.toLowerCase().trim()]
    );

    // Always return success to prevent user enumeration
    if (!users.length) {
      return res.json({ success: true, message: 'If this email exists, an OTP has been sent.' });
    }

    const user = users[0];
    const otp   = generateOTP();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    // Invalidate old tokens
    await db.execute(
      'UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0',
      [user.id]
    );

    // Insert new token
    await db.execute(
      'INSERT INTO password_reset_tokens (user_id, token, otp, expires_at) VALUES (?, ?, ?, ?)',
      [user.id, token, otp, expiresAt]
    );

    // Send OTP email
    await sendPasswordResetOTP(user.email, user.full_name, otp);

    res.json({
      success: true,
      message: 'OTP sent to your email.',
      data: { resetToken: token }, // send token to client for next step
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
};

// ── POST /api/auth/verify-otp ─────────────────────────────
const verifyOTP = async (req, res) => {
  try {
    const { resetToken, otp } = req.body;

    const [rows] = await db.execute(
      `SELECT * FROM password_reset_tokens
       WHERE token = ? AND otp = ? AND used = 0 AND expires_at > NOW()`,
      [resetToken, otp]
    );

    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    res.json({ success: true, message: 'OTP verified. You may now reset your password.' });
  } catch {
    res.status(500).json({ success: false, message: 'OTP verification failed' });
  }
};

// ── POST /api/auth/reset-password ─────────────────────────
const resetPassword = async (req, res) => {
  try {
    const { resetToken, otp, newPassword } = req.body;

    const [rows] = await db.execute(
      `SELECT * FROM password_reset_tokens
       WHERE token = ? AND otp = ? AND used = 0 AND expires_at > NOW()`,
      [resetToken, otp]
    );

    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset request' });
    }

    const hash = await bcrypt.hash(newPassword, 12);

    await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, rows[0].user_id]);
    await db.execute('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [rows[0].id]);

    // Revoke all refresh tokens for security
    await db.execute('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [rows[0].user_id]);

    res.json({ success: true, message: 'Password reset successfully. Please log in.' });
  } catch {
    res.status(500).json({ success: false, message: 'Password reset failed' });
  }
};

// ── GET /api/auth/me ───────────────────────────────────────
const getMe = async (req, res) => {
  try {
    const [permissions] = await db.execute(
      `SELECT p.module, p.action FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ?`,
      [req.user.role_id]
    );

    res.json({
      success: true,
      data: {
        ...req.user,
        permissions: permissions.map(p => `${p.module}:${p.action}`),
      },
    });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch user' });
  }
};

module.exports = { login, refreshToken, logout, forgotPassword, verifyOTP, resetPassword, getMe };