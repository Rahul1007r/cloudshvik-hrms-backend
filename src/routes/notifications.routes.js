const express = require('express');
const multer  = require('multer');
const path    = require('path');
const crypto  = require('crypto');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/notifications.controller');

const UPLOAD_DIR = process.env.ANN_UPLOAD_DIR || path.join(__dirname, '../../uploads/announcements');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const hash = crypto.randomBytes(10).toString('hex');
    cb(null, `${Date.now()}_${hash}${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf','.doc','.docx','.jpg','.jpeg','.png','.xlsx','.pptx'].includes(
      path.extname(file.originalname).toLowerCase()
    );
    cb(ok ? null : new Error('File type not allowed'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const hr   = [authenticate, authorizeRoles('Admin','HR')];
const mgr  = [authenticate, authorizeRoles('Admin','HR','Manager')];
const auth = [authenticate];

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success:false, errors:errs.array() });
  next();
};

// ── Stats ──────────────────────────────────────────────────
router.get('/stats',                          auth, ctrl.getStats);

// ── Notifications ──────────────────────────────────────────
router.get('/inbox',                          auth, ctrl.getNotifications);
router.patch('/inbox/read-all',               auth, ctrl.markAllRead);
router.patch('/inbox/:id/read',               auth, ctrl.markRead);
router.delete('/inbox/:id',                   auth, ctrl.deleteNotification);
router.post('/broadcast',                     hr,
  [body('title').notEmpty()],
  validate, ctrl.broadcastNotification
);

// ── Announcements (admin) ──────────────────────────────────
router.get('/announcements/stats',            mgr,  ctrl.getAnnouncementStats);
router.get('/announcements',                  mgr,  ctrl.getAllAnnouncements);
router.post('/announcements',
  hr,
  (req, res, next) => upload.single('attachment')(req, res, err => {
    if (err) return res.status(422).json({ success:false, message:err.message });
    next();
  }),
  [body('title').notEmpty().trim(), body('body').notEmpty()],
  validate, ctrl.createAnnouncement
);
router.put('/announcements/:id',              hr,   ctrl.updateAnnouncement);
router.delete('/announcements/:id',           hr,   ctrl.deleteAnnouncement);
router.patch('/announcements/:id/pin',        hr,   ctrl.togglePin);

// ── Announcement feed (all employees) ─────────────────────
router.get('/announcements/feed',             auth, ctrl.getAnnouncementFeed);
router.get('/announcements/:id',              auth, ctrl.getAnnouncement);

// ── Preferences ────────────────────────────────────────────
router.get('/preferences',                    auth, ctrl.getPreferences);
router.put('/preferences',                    auth, ctrl.savePreferences);

module.exports = router;