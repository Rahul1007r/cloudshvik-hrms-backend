const express = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const {
  login, refreshToken, logout,
  forgotPassword, verifyOTP, resetPassword, getMe,
} = require('../../src/controllers/auth.controller');
const { authenticate, auditLog } = require('../../src/middleware/auth.middleware');

// ── Rate Limiters ─────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});

const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hr
  max: 5,
  message: { success: false, message: 'Too many OTP requests. Try again in 1 hour.' },
});

// ── Validation Helper ─────────────────────────────────────
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  next();
};

// ── Public Routes ─────────────────────────────────────────

// Login
router.post('/login',
  loginLimiter,
  [
    body('email').isEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password required'),
  ],
  validate,
  login
);

// Refresh access token
router.post('/refresh',
  [body('refreshToken').notEmpty().withMessage('Refresh token required')],
  validate,
  refreshToken
);

// Forgot password (send OTP)
router.post('/forgot-password',
  otpLimiter,
  [body('email').isEmail().withMessage('Valid email required')],
  validate,
  forgotPassword
);

// Verify OTP
router.post('/verify-otp',
  [
    body('resetToken').notEmpty(),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  ],
  validate,
  verifyOTP
);

// Reset password
router.post('/reset-password',
  [
    body('resetToken').notEmpty(),
    body('otp').isLength({ min: 6, max: 6 }),
    body('newPassword')
      .isLength({ min: 8 })
      .matches(/^(?=.*[A-Z])(?=.*[0-9])/)
      .withMessage('Password must be 8+ chars with uppercase and number'),
  ],
  validate,
  resetPassword
);

// ── Protected Routes ──────────────────────────────────────

// Get current user
router.get('/me', authenticate, getMe);

// Logout
router.post('/logout', authenticate, auditLog('LOGOUT', 'auth'), logout);

module.exports = router;