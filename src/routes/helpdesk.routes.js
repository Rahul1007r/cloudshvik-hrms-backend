const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const path    = require('path');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/helpdesk.controller');

const UPLOAD_DIR = process.env.TICKET_UPLOAD_DIR || path.join(__dirname, '../../uploads/tickets');

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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg','.jpeg','.png','.gif','.pdf','.doc','.docx','.xls','.xlsx','.txt','.zip'];
    const ok = allowed.includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('File type not allowed'), ok);
  },
});

const hr   = [authenticate, authorizeRoles('Admin','HR')];
const mgr  = [authenticate, authorizeRoles('Admin','HR','Manager')];
const auth = [authenticate];

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success: false, errors: errs.array() });
  next();
};

const withUpload = (handler) => (req, res, next) =>
  upload.array('attachments', 5)(req, res, (err) => {
    if (err) return res.status(422).json({ success: false, message: err.message });
    handler(req, res, next);
  });

// Reference data
router.get('/categories',                    auth, ctrl.getCategories);
router.get('/agents',                        hr,   ctrl.getAgents);

// Stats
router.get('/stats',                         auth, ctrl.getStats);

// Ticket CRUD
router.get('/tickets',                       auth, ctrl.getTickets);
router.get('/tickets/:id',                   auth, ctrl.getTicket);

router.post('/tickets',
  auth,
  withUpload((req, res, next) => next()),
  [body('subject').notEmpty().trim(), body('description').notEmpty().trim(), body('category_id').notEmpty()],
  validate, ctrl.createTicket
);

// Ticket actions
router.post('/tickets/:id/reply',
  auth,
  withUpload((req, res, next) => next()),
  [body('message').notEmpty().trim()],
  validate, ctrl.addReply
);

router.patch('/tickets/:id/status',          auth,
  [body('status').notEmpty()],
  validate, ctrl.updateStatus
);
router.patch('/tickets/:id/assign',          mgr,
  [body('assigned_to').notEmpty()],
  validate, ctrl.assignTicket
);
router.patch('/tickets/:id/priority',        mgr,   ctrl.updatePriority);
router.post('/tickets/:id/rate',             auth,  ctrl.rateTicket);

// Attachment download
router.get('/attachments/:attId/download',   auth, ctrl.downloadAttachment);

module.exports = router;