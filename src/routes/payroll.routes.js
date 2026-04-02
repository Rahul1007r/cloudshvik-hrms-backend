const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../../src/middleware/auth.middleware');
const ctrl = require('../../src/controllers/payroll.controller');

const auth     = [authenticate];
const adminHR  = [authenticate, authorizeRoles('Admin', 'HR')];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// Stats
router.get('/stats',                    adminHR, ctrl.getStats);

// Salary structures
router.get('/salary-structures',         adminHR, ctrl.getAllStructures);
router.get('/salary-structures/:empId',  adminHR, ctrl.getStructure);
router.post('/salary-structures',        adminHR,
  [body('employee_id').notEmpty(), body('basic_salary').isNumeric()],
  validate, ctrl.upsertStructure
);

// Payroll runs
router.get('/runs',   adminHR, ctrl.getPayrollRuns);
router.post('/runs',  adminHR,
  [body('month').isInt({ min:1, max:12 }), body('year').isInt({ min:2020 })],
  validate, ctrl.createPayrollRun
);

// Payslips
router.get('/payslips',      auth,    ctrl.getPayslips);
router.get('/payslips/:id',  auth,    ctrl.getPayslip);

module.exports = router;