const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/leaveBalance.controller');

const hr      = [authenticate, authorizeRoles('Admin', 'HR')];
const allAuth = [authenticate];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// Overview & stats
router.get('/stats',                    hr,      ctrl.getStats);
router.get('/overview',                 hr,      ctrl.getOverview);
router.get('/adjustment-log',           hr,      ctrl.getAdjustmentLog);

// Per-employee detail (employees can view own balance)
router.get('/employee/:empId',          allAuth, ctrl.getEmployeeBalance);

// HR actions
router.post('/adjust',
  hr,
  [
    body('employee_id').notEmpty(),
    body('leave_type_id').notEmpty(),
    body('adjustment_type').isIn(['Add','Deduct','Reset','Correction','Allocate']),
    body('days').isNumeric().withMessage('Days must be a number'),
  ],
  validate, ctrl.adjustBalance
);

router.post('/bulk-allocate',
  hr,
  [body('year').isInt({ min: 2020, max: 2099 })],
  validate, ctrl.bulkAllocate
);

router.post('/carry-forward',
  hr,
  [
    body('from_year').isInt({ min: 2020 }),
    body('to_year').isInt({ min: 2020 }),
  ],
  validate, ctrl.carryForward
);

module.exports = router;