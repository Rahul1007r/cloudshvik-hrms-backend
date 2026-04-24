const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const crypto   = require('crypto');
const { body, validationResult } = require('express-validator');
const router   = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl     = require('../controllers/documents.controller');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads/documents');
const COMPANY_DIR = path.join(UPLOAD_DIR, 'company');

// ── Multer setup ──────────────────────────────────────────
const ALLOWED_MIME = [
  'image/jpeg','image/png','image/webp','image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const makeStorage = (dest) => multer.diskStorage({
  destination: (req, file, cb) => cb(null, dest),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const hash = crypto.randomBytes(16).toString('hex');
    cb(null, `${Date.now()}_${hash}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
  else cb(new Error('File type not allowed. Use PDF, JPEG, PNG, or Word documents.'), false);
};

const upload        = multer({ storage: makeStorage(UPLOAD_DIR),  fileFilter, limits: { fileSize: 10*1024*1024 } });
const uploadCompany = multer({ storage: makeStorage(COMPANY_DIR), fileFilter, limits: { fileSize: 50*1024*1024 } });

// Error middleware for multer
const handleUploadError = (err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, message: 'File too large (max 10 MB)' });
  if (err?.message) return res.status(422).json({ success: false, message: err.message });
  next(err);
};

const auth    = [authenticate];
const hr      = [authenticate, authorizeRoles('Admin', 'HR')];

// Reference data
router.get('/categories',         auth, ctrl.getCategories);
router.get('/stats',              hr,   ctrl.getStats);
router.get('/all',                hr,   ctrl.getAllDocuments);
router.get('/expiring',           hr,   ctrl.getExpiring);

// Employee documents
router.get('/employee/:empId',    auth, ctrl.getEmployeeDocuments);
router.post('/employee/:empId/upload',
  auth,
  (req, res, next) => upload.single('document')(req, res, (err) => { if (err) return handleUploadError(err, req, res, next); next(); }),
  ctrl.uploadDocument
);
router.post('/:docId/verify',   hr,   ctrl.verifyDocument);
router.post('/:docId/reject',   hr,   [body('rejection_reason').notEmpty()], ctrl.rejectDocument);
router.get('/:docId/download',  auth, ctrl.downloadDocument);
router.delete('/:docId',        hr,   ctrl.deleteDocument);

// Company documents
router.get('/company',           auth, ctrl.getCompanyDocs);
router.post('/company/upload',
  hr,
  (req, res, next) => uploadCompany.single('document')(req, res, (err) => { if (err) return handleUploadError(err, req, res, next); next(); }),
  ctrl.uploadCompanyDoc
);
router.get('/company/:id/download', auth, ctrl.downloadCompanyDoc);

module.exports = router;