const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const deptCtrl  = require('../controllers/departments.controller');
const desigCtrl = require('../controllers/designations.controller');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

const adminHR  = [authenticate, authorizeRoles('Admin', 'HR')];
const anyAuth  = [authenticate];

// ── Departments ────────────────────────────────────────────
router.get('/departments/stats',  anyAuth, deptCtrl.getStats);
router.get('/departments',        anyAuth, deptCtrl.getAll);
router.get('/departments/:id',    anyAuth, deptCtrl.getById);

router.post('/departments',
  adminHR,
  [body('name').notEmpty().trim().withMessage('Department name is required')],
  validate, deptCtrl.create
);
router.put('/departments/:id',
  adminHR,
  [body('name').notEmpty().trim().withMessage('Department name is required')],
  validate, deptCtrl.update
);
router.delete('/departments/:id', adminHR, deptCtrl.remove);

// ── Designations ───────────────────────────────────────────
router.get('/designations',       anyAuth, desigCtrl.getAll);
router.get('/designations/:id',   anyAuth, desigCtrl.getById);

router.post('/designations',
  adminHR,
  [
    body('name').notEmpty().trim().withMessage('Designation name is required'),
    body('department_id').notEmpty().withMessage('Department is required'),
    body('level').notEmpty().withMessage('Level is required'),
  ],
  validate, desigCtrl.create
);
router.put('/designations/:id',
  adminHR,
  [body('name').notEmpty().trim(), body('department_id').notEmpty(), body('level').notEmpty()],
  validate, desigCtrl.update
);
router.delete('/designations/:id', adminHR, desigCtrl.remove);

module.exports = router;