const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/payslipPdf.controller');

const auth    = [authenticate];
const adminHR = [authenticate, authorizeRoles('Admin', 'HR')];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// List payslips (own for employee, all for HR)
router.get('/list',           auth,    ctrl.listPayslips);

// Download single payslip PDF
router.get('/download/:id',   auth,    ctrl.downloadOne);

// Batch ZIP download (HR only)
router.post('/batch',
  adminHR,
  [body('month').isInt({ min:1, max:12 }), body('year').isInt({ min:2020 })],
  validate, ctrl.downloadBatch
);

// Send payslips by email (HR only)
router.post('/send-email',
  adminHR,
  [body('payslip_ids').isArray({ min:1 })],
  validate, ctrl.sendEmail
);

module.exports = router;